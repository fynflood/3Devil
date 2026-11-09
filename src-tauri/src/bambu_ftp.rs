//! How much filament a Bambu print uses. The printer doesn't report it, but it
//! keeps a copy of each sliced `.gcode.3mf` on its storage, readable over FTPS
//! (implicit TLS on port 990, user `bblp`, the LAN access code). The weight is
//! in the file's `Metadata/slice_info.config`, near the end of the ZIP, so only
//! the end of the file is read: the whole thing can be tens of MB over a slow
//! link.

use crate::printer::tls_config;
use flate2::read::DeflateDecoder;
use rumqttc::tokio_rustls::{client::TlsStream, rustls::pki_types::ServerName, TlsConnector};
use serde::Serialize;
use std::io::Read;
use std::net::IpAddr;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio::time::timeout;

const PORT: u16 = 990;
const WAIT: Duration = Duration::from_secs(15);
/// How much of the end of the file to read first, enough for the ZIP's
/// directory and usually the slice info too.
const TAIL: u64 = 256 * 1024;
const SLICE_INFO: &str = "Metadata/slice_info.config";

type Result<T> = std::result::Result<T, String>;

struct Ftp {
    control: BufReader<TlsStream<TcpStream>>,
    ip: IpAddr,
    tls: TlsConnector,
}

impl Ftp {
    async fn connect(ip: IpAddr, access_code: &str) -> Result<Ftp> {
        // One connector for both connections, so the data connection resumes the
        // control connection's TLS session, which the printer insists on.
        let tls = TlsConnector::from(Arc::new(tls_config()));
        let tcp = timeout(WAIT, TcpStream::connect((ip, PORT)))
            .await
            .map_err(|_| "The printer's file storage didn't answer".to_string())?
            .map_err(|e| format!("Can't reach the printer's file storage: {e}"))?;
        let stream = tls.connect(ServerName::IpAddress(ip.into()), tcp).await.map_err(|e| format!("TLS: {e}"))?;
        let mut ftp = Ftp { control: BufReader::new(stream), ip, tls };
        ftp.expect(None, 220).await?;
        ftp.expect(Some("USER bblp"), 331).await?;
        ftp.expect(Some(&format!("PASS {access_code}")), 230).await?;
        ftp.expect(Some("TYPE I"), 200).await?;
        ftp.expect(Some("PBSZ 0"), 200).await?;
        ftp.expect(Some("PROT P"), 200).await?;
        Ok(ftp)
    }

    /// Sends a command (if any) and reads the reply's code and text.
    async fn command(&mut self, line: Option<&str>) -> Result<(u16, String)> {
        if let Some(line) = line {
            let stream = self.control.get_mut();
            stream.write_all(format!("{line}\r\n").as_bytes()).await.map_err(|e| e.to_string())?;
            stream.flush().await.map_err(|e| e.to_string())?;
        }
        let mut text = String::new();
        loop {
            let mut line = String::new();
            let n = timeout(WAIT, self.control.read_line(&mut line))
                .await
                .map_err(|_| "The printer's file storage stopped answering".to_string())?
                .map_err(|e| e.to_string())?;
            if n == 0 {
                return Err("The printer's file storage closed the connection".into());
            }
            text.push_str(&line);
            // A reply ends with a line that starts with its code and a space.
            let code = line.get(..3).and_then(|c| c.parse::<u16>().ok());
            if let Some(code) = code.filter(|_| line.as_bytes().get(3) == Some(&b' ')) {
                return Ok((code, text));
            }
        }
    }

    async fn expect(&mut self, line: Option<&str>, want: u16) -> Result<String> {
        let (code, text) = self.command(line).await?;
        if code == want {
            return Ok(text);
        }
        let verb = line.and_then(|l| l.split(' ').next()).unwrap_or("connect");
        // Never echo the password back.
        let verb = if verb == "PASS" { "login" } else { verb };
        Err(format!("The printer's file storage refused {verb}: {}", text.trim()))
    }

    async fn size(&mut self, path: &str) -> Result<Option<u64>> {
        let (code, text) = self.command(Some(&format!("SIZE {path}"))).await?;
        Ok((code == 213).then(|| text.get(4..)?.trim().parse().ok()).flatten())
    }

    /// Up to `max` bytes of a file, starting `from` bytes in.
    async fn read(&mut self, path: &str, from: u64, max: usize) -> Result<Vec<u8>> {
        let text = self.expect(Some("PASV"), 227).await?;
        let port = pasv_port(&text).ok_or("The printer's file storage gave no data port")?;
        if from > 0 {
            self.expect(Some(&format!("REST {from}")), 350).await?;
        }
        let tcp = timeout(WAIT, TcpStream::connect((self.ip, port)))
            .await
            .map_err(|_| "The printer's data connection didn't open".to_string())?
            .map_err(|e| e.to_string())?;
        let (code, text) = self.command(Some(&format!("RETR {path}"))).await?;
        if code != 150 && code != 125 {
            return Err(format!("The printer's file storage couldn't send {path}: {}", text.trim()));
        }
        let mut data = self
            .tls
            .connect(ServerName::IpAddress(self.ip.into()), tcp)
            .await
            .map_err(|e| format!("TLS on the data connection: {e}"))?;
        let mut out = Vec::new();
        let mut buf = vec![0u8; 64 * 1024];
        while out.len() < max {
            let n = timeout(WAIT, data.read(&mut buf))
                .await
                .map_err(|_| "The printer stopped sending the file".to_string())?
                // The printer may drop the connection without a TLS goodbye.
                .unwrap_or(0);
            if n == 0 {
                break;
            }
            out.extend_from_slice(&buf[..n]);
        }
        out.truncate(max);
        drop(data);
        // 226 when it all arrived, 426 or 451 when we stopped early.
        self.command(None).await?;
        Ok(out)
    }
}

impl Ftp {
    /// The names in a folder.
    async fn list(&mut self, dir: &str) -> Result<Vec<String>> {
        let text = self.expect(Some("PASV"), 227).await?;
        let port = pasv_port(&text).ok_or("The printer's file storage gave no data port")?;
        let tcp = timeout(WAIT, TcpStream::connect((self.ip, port)))
            .await
            .map_err(|_| "The printer's data connection didn't open".to_string())?
            .map_err(|e| e.to_string())?;
        let (code, text) = self.command(Some(&format!("NLST {dir}"))).await?;
        if code != 150 && code != 125 {
            // An empty or missing folder.
            return if code == 450 || code == 550 { Ok(Vec::new()) } else { Err(format!("Can't list {dir}: {}", text.trim())) };
        }
        let mut data = self
            .tls
            .connect(ServerName::IpAddress(self.ip.into()), tcp)
            .await
            .map_err(|e| format!("TLS on the data connection: {e}"))?;
        let mut out = Vec::new();
        timeout(WAIT, data.read_to_end(&mut out))
            .await
            .map_err(|_| "The printer stopped sending the list".to_string())?
            .ok();
        drop(data);
        self.command(None).await?;
        let names = String::from_utf8_lossy(&out);
        Ok(names.lines().map(|l| l.trim().rsplit('/').next().unwrap_or("").to_string()).filter(|n| !n.is_empty()).collect())
    }
}

fn pasv_port(reply: &str) -> Option<u16> {
    let inner = reply.split('(').nth(1)?.split(')').next()?;
    let n: Vec<u16> = inner.split(',').map(|x| x.trim().parse().ok()).collect::<Option<_>>()?;
    (n.len() == 6).then(|| n[4] * 256 + n[5])
}

fn u16_at(b: &[u8], at: usize) -> Option<u64> {
    Some(u16::from_le_bytes(b.get(at..at + 2)?.try_into().ok()?) as u64)
}

fn u32_at(b: &[u8], at: usize) -> Option<u64> {
    Some(u32::from_le_bytes(b.get(at..at + 4)?.try_into().ok()?) as u64)
}

/// Where the ZIP's central directory is, from its end record in `tail`.
fn directory(tail: &[u8]) -> Option<(u64, u64)> {
    let end = tail.windows(4).rposition(|w| w == b"PK\x05\x06")?;
    Some((u32_at(tail, end + 16)?, u32_at(tail, end + 12)?))
}

/// One file in the ZIP's central directory.
struct Entry {
    method: u64,
    compressed: u64,
    local_header: u64,
}

fn find_entry(dir: &[u8], name: &str) -> Option<Entry> {
    let mut at = 0;
    while dir.get(at..at + 4)? == b"PK\x01\x02" {
        let name_len = u16_at(dir, at + 28)? as usize;
        let skip = name_len + u16_at(dir, at + 30)? as usize + u16_at(dir, at + 32)? as usize;
        if dir.get(at + 46..at + 46 + name_len)? == name.as_bytes() {
            return Some(Entry { method: u16_at(dir, at + 10)?, compressed: u32_at(dir, at + 20)?, local_header: u32_at(dir, at + 42)? });
        }
        at += 46 + skip;
    }
    None
}

/// A file's contents, given the bytes from its local header on.
fn unpack(entry: &Entry, local: &[u8]) -> Option<String> {
    if local.get(..4)? != b"PK\x03\x04" {
        return None;
    }
    let start = 30 + u16_at(local, 26)? as usize + u16_at(local, 28)? as usize;
    let raw = local.get(start..start + entry.compressed as usize)?;
    let mut text = String::new();
    match entry.method {
        0 => text = String::from_utf8(raw.to_vec()).ok()?,
        8 => {
            DeflateDecoder::new(raw).take(16 * 1024 * 1024).read_to_string(&mut text).ok()?;
        }
        _ => return None,
    }
    Some(text)
}

fn attr<'a>(tag: &'a str, name: &str) -> Option<&'a str> {
    let key = format!(" {name}=\"");
    let start = tag.find(&key)? + key.len();
    Some(&tag[start..start + tag[start..].find('"')?])
}

/// One sliced plate, as `slice_info.config` describes it.
#[derive(Serialize, Debug, PartialEq)]
pub struct Plate {
    index: Option<u64>,
    /// Grams of filament.
    grams: Option<f64>,
    /// One name per object on the plate, so copies repeat.
    objects: Vec<String>,
}

fn unescape(text: &str) -> String {
    text.replace("&quot;", "\"").replace("&apos;", "'").replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&")
}

fn plates(slice_info: &str) -> Vec<Plate> {
    let metadata = |p: &str, key: &str| {
        p.split("<metadata").skip(1).find(|m| attr(m, "key") == Some(key)).and_then(|m| attr(m, "value")).map(str::to_owned)
    };
    slice_info
        .split("<plate>")
        .skip(1)
        .map(|p| p.split("</plate>").next().unwrap_or(p))
        .map(|p| {
            let weight = metadata(p, "weight").and_then(|w| w.parse::<f64>().ok());
            // Older slicers leave out the total; add up each filament's.
            let summed = || {
                let used: Vec<f64> = p.split("<filament ").skip(1).filter_map(|f| attr(f, "used_g")?.parse().ok()).collect();
                (!used.is_empty()).then(|| used.iter().sum())
            };
            Plate {
                index: metadata(p, "index").and_then(|i| i.parse().ok()),
                grams: weight.or_else(summed).filter(|g| *g > 0.0),
                objects: p.split("<object ").skip(1).filter_map(|o| attr(o, "name")).map(unescape).collect(),
            }
        })
        .collect()
}

/// Grams of filament for one plate of `slice_info.config`: the plate whose
/// index is `plate`, or the only one.
fn plate_weight(slice_info: &str, plate: Option<u64>) -> Option<f64> {
    let plates = plates(slice_info);
    let chosen = match plate {
        Some(n) if plates.len() > 1 => plates.iter().find(|p| p.index == Some(n))?,
        _ if plates.len() == 1 => &plates[0],
        _ => return None,
    };
    chosen.grams
}

/// The files on the printer that may be the sliced print `subtask`: the file
/// it's printing, if that's a 3MF, then the copies Bambu Studio sends.
fn candidates(gcode_file: &str, subtask: &str) -> Vec<String> {
    let mut paths = Vec::new();
    if gcode_file.ends_with(".3mf") {
        paths.push(if gcode_file.starts_with('/') { gcode_file.to_string() } else { format!("/{gcode_file}") });
    }
    if !subtask.is_empty() {
        let name = if subtask.ends_with(".3mf") { subtask.to_string() } else { format!("{subtask}.gcode.3mf") };
        paths.push(format!("/{name}"));
        paths.push(format!("/cache/{name}"));
    }
    paths.dedup();
    paths
}

/// The `slice_info.config` of a sliced 3MF on the printer, if it has one.
async fn slice_info(ftp: &mut Ftp, path: &str) -> Result<Option<String>> {
    let Some(size) = ftp.size(path).await? else { return Ok(None) };
    let tail_start = size.saturating_sub(TAIL);
    let tail = ftp.read(path, tail_start, (size - tail_start) as usize).await?;
    let (dir_at, dir_len) = directory(&tail).ok_or("not a 3MF file")?;
    let dir = if dir_at >= tail_start {
        tail.get((dir_at - tail_start) as usize..).unwrap_or_default().to_vec()
    } else {
        ftp.read(path, dir_at, dir_len as usize).await?
    };
    let Some(entry) = find_entry(&dir, SLICE_INFO) else { return Ok(None) };
    let local = if entry.local_header >= tail_start {
        tail[(entry.local_header - tail_start) as usize..].to_vec()
    } else {
        // Room for the local header's name and extra fields.
        ftp.read(path, entry.local_header, entry.compressed as usize + 64 * 1024).await?
    };
    Ok(unpack(&entry, &local))
}

async fn weight_in(ftp: &mut Ftp, path: &str, plate: Option<u64>) -> Result<Option<f64>> {
    Ok(slice_info(ftp, path).await?.and_then(|info| plate_weight(&info, plate)))
}

/// Grams of filament the print uses, from the slicer's figures in its file.
pub(crate) async fn print_weight(ip: IpAddr, access_code: &str, gcode_file: &str, subtask: &str, plate: Option<u64>) -> Result<Option<f64>> {
    let mut ftp = Ftp::connect(ip, access_code).await?;
    for path in candidates(gcode_file, subtask) {
        if let Some(grams) = weight_in(&mut ftp, &path, plate).await? {
            let _ = ftp.command(Some("QUIT")).await;
            return Ok(Some(grams));
        }
    }
    let _ = ftp.command(Some("QUIT")).await;
    Ok(None)
}

/// The sliced files on a Bambu printer, newest copy first: those Bambu
/// Studio sent, then those it downloaded for cloud prints.
#[tauri::command]
pub async fn bambu_sliced_files(ip: String, access_code: String) -> Result<Vec<String>> {
    let ip: IpAddr = ip.parse().map_err(|_| format!("Not an IP address: {ip}"))?;
    let mut ftp = Ftp::connect(ip, &access_code).await?;
    let mut paths = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for dir in ["/", "/cache/"] {
        for name in ftp.list(dir).await? {
            if name.ends_with(".3mf") && seen.insert(name.clone()) {
                paths.push(format!("{dir}{name}"));
            }
        }
    }
    let _ = ftp.command(Some("QUIT")).await;
    Ok(paths)
}

#[derive(Serialize)]
pub struct SlicedFile {
    path: String,
    plates: Vec<Plate>,
}

/// What's on each plate of the given sliced files, and the filament it uses.
/// Files that can't be read are left out.
#[tauri::command]
pub async fn bambu_sliced_plates(ip: String, access_code: String, paths: Vec<String>) -> Result<Vec<SlicedFile>> {
    let ip: IpAddr = ip.parse().map_err(|_| format!("Not an IP address: {ip}"))?;
    let mut ftp = Ftp::connect(ip, &access_code).await?;
    let mut out = Vec::new();
    for path in paths {
        match slice_info(&mut ftp, &path).await {
            Ok(Some(info)) => out.push(SlicedFile { plates: plates(&info), path }),
            Ok(None) => {}
            Err(e) => {
                println!("[printer {ip}] can't read {path}: {e}");
                // A failed transfer can leave the connection unusable.
                ftp = Ftp::connect(ip, &access_code).await?;
            }
        }
    }
    let _ = ftp.command(Some("QUIT")).await;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SLICE_INFO_ONE: &str = r##"<config>
  <plate>
    <metadata key="index" value="1"/>
    <metadata key="prediction" value="13831"/>
    <metadata key="weight" value="86.17"/>
    <object identify_id="1529" name="FL1 floor 1.stl" skipped="false" />
    <filament id="1" tray_info_idx="GFL05" type="PLA" color="#00AE42" used_m="29.37" used_g="86.17" />
  </plate>
</config>"##;

    #[test]
    fn reads_the_plate_weight() {
        assert_eq!(plate_weight(SLICE_INFO_ONE, Some(1)), Some(86.17));
        // A file sliced as one plate of a bigger project keeps that plate's index.
        assert_eq!(plate_weight(&SLICE_INFO_ONE.replace("value=\"1\"/>", "value=\"3\"/>"), Some(1)), Some(86.17));
        assert_eq!(plate_weight(&SLICE_INFO_ONE.replace("key=\"weight\" value=\"86.17\"", "key=\"weight\" value=\"\""), None), Some(86.17));
        let two = format!(
            "<config>{}{}</config>",
            "<plate><metadata key=\"index\" value=\"1\"/><metadata key=\"weight\" value=\"10\"/></plate>",
            "<plate><metadata key=\"index\" value=\"2\"/><filament id=\"1\" used_g=\"4.5\"/><filament id=\"2\" used_g=\"1.5\"/></plate>"
        );
        assert_eq!(plate_weight(&two, Some(1)), Some(10.0));
        assert_eq!(plate_weight(&two, Some(2)), Some(6.0));
        assert_eq!(plate_weight(&two, Some(3)), None);
        assert_eq!(plate_weight(&two, None), None);
    }

    #[test]
    fn lists_what_is_on_each_plate() {
        let info = r#"<config><plate><metadata key="index" value="2"/><metadata key="weight" value="23.53"/>
            <object identify_id="1" name="Clip &amp; Pin.stl" skipped="false" />
            <object identify_id="2" name="Clip &amp; Pin.stl" skipped="false" /></plate></config>"#;
        assert_eq!(
            plates(info),
            [Plate { index: Some(2), grams: Some(23.53), objects: vec!["Clip & Pin.stl".into(), "Clip & Pin.stl".into()] }]
        );
    }

    #[test]
    fn finds_the_file_for_a_print() {
        assert_eq!(
            candidates("/data/Metadata/plate_1.gcode", "FL1 wall 5.stl"),
            ["/FL1 wall 5.stl.gcode.3mf", "/cache/FL1 wall 5.stl.gcode.3mf"]
        );
        assert_eq!(candidates("Tower.3mf", "Tower.3mf"), ["/Tower.3mf", "/cache/Tower.3mf"]);
        assert_eq!(candidates("", ""), Vec::<String>::new());
    }

    #[test]
    fn reads_a_zip_from_its_end() {
        use std::io::Write;
        let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        let deflate = zip::write::SimpleFileOptions::default();
        zip.start_file("Metadata/plate_1.gcode", deflate).unwrap();
        zip.write_all(&vec![b'G'; 100_000]).unwrap();
        zip.start_file(SLICE_INFO, deflate).unwrap();
        zip.write_all(SLICE_INFO_ONE.as_bytes()).unwrap();
        let bytes = zip.finish().unwrap().into_inner();
        let (dir_at, dir_len) = directory(&bytes[bytes.len() - 200..]).unwrap();
        let dir = &bytes[dir_at as usize..(dir_at + dir_len) as usize];
        let entry = find_entry(dir, SLICE_INFO).unwrap();
        assert!(find_entry(dir, "nope").is_none());
        let text = unpack(&entry, &bytes[entry.local_header as usize..]).unwrap();
        assert_eq!(plate_weight(&text, Some(1)), Some(86.17));
    }

    #[test]
    fn data_port_from_pasv() {
        assert_eq!(pasv_port("227 Entering Passive Mode (192,168,2,64,195,80).\r\n"), Some(50000));
        assert_eq!(pasv_port("227 nope"), None);
    }

    /// Talks to a real printer: `BAMBU_IP=… BAMBU_CODE=… BAMBU_SUBTASK=… cargo test bambu_ftp_live -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn bambu_ftp_live() {
        let ip: IpAddr = std::env::var("BAMBU_IP").unwrap().parse().unwrap();
        let code = std::env::var("BAMBU_CODE").unwrap();
        let subtask = std::env::var("BAMBU_SUBTASK").unwrap();
        tauri::async_runtime::block_on(async {
            let started = std::time::Instant::now();
            let grams = print_weight(ip, &code, "/data/Metadata/plate_1.gcode", &subtask, Some(1)).await;
            println!("{subtask}: {grams:?} in {:?}", started.elapsed());
            let files = bambu_sliced_files(ip.to_string(), code.clone()).await.unwrap();
            println!("{} files, e.g. {:?}", files.len(), files.iter().take(3).collect::<Vec<_>>());
            let started = std::time::Instant::now();
            let some: Vec<String> = files.into_iter().filter(|f| f.contains("Clip") || f.contains("floor 2")).collect();
            for f in bambu_sliced_plates(ip.to_string(), code.clone(), some).await.unwrap() {
                let p = &f.plates[0];
                println!("{}: {:?} g, {} objects, first {:?}", f.path, p.grams, p.objects.len(), p.objects.first());
            }
            println!("in {:?}", started.elapsed());
        });
    }
}
