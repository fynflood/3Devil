//! Live status from Prusa printers through PrusaLink, the HTTP API built into
//! the MK4/MK3.9/XL/MINI/Core One firmware (and Prusa Link on a Raspberry Pi
//! for the MK3S). PrusaLink can't push updates, so this polls
//! `/api/v1/status` and reshapes it into the report Bambu printers send, so the
//! rest of the app tracks both kinds the same way.

use crate::printer::{emit_status, FoundPrinter, Printers};
use reqwest::{header, Client, Response, StatusCode};
use serde::Deserialize;
use serde_json::{json, Value};
use std::io::Read;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, State};

const POLL: Duration = Duration::from_secs(3);
/// A print file's notes for the printer sit well inside this much of its start.
const HEAD_LIMIT: usize = 256 * 1024;
const NOTES_TRIES: u8 = 3;

pub(crate) enum Failure {
    /// Wrong username/password; retrying soon won't help.
    Auth(String),
    Network(String),
}

impl Failure {
    pub(crate) fn message(self) -> String {
        match self {
            Failure::Auth(m) | Failure::Network(m) => m,
        }
    }
}

/// An authenticated connection to one printer's PrusaLink.
struct Link {
    http: Client,
    host: String,
    username: String,
    password: String,
    /// The printer's last Digest challenge, reused until its nonce goes stale.
    challenge: Option<digest_auth::WwwAuthenticateHeader>,
    /// Older firmware takes the password as an API key instead of Digest.
    api_key: bool,
}

impl Link {
    fn new(host: &str, username: &str, password: &str) -> Result<Self, String> {
        let http = Client::builder()
            .connect_timeout(Duration::from_secs(3))
            .timeout(Duration::from_secs(8))
            .build()
            .map_err(|e| e.to_string())?;
        Ok(Link {
            http,
            host: clean_host(host)?,
            username: if username.trim().is_empty() { "maker".into() } else { username.trim().into() },
            password: password.to_string(),
            challenge: None,
            api_key: false,
        })
    }

    /// GETs `path`, answering the printer's login challenge as needed.
    async fn get(&mut self, path: &str) -> Result<Response, Failure> {
        for _ in 0..2 {
            let mut req = self.http.get(format!("http://{}{path}", self.host));
            if self.api_key {
                req = req.header("X-Api-Key", &self.password);
            } else if let Some(challenge) = self.challenge.as_mut() {
                let ctx = digest_auth::AuthContext::new(self.username.as_str(), self.password.as_str(), path);
                let answer = challenge.respond(&ctx).map_err(|e| Failure::Auth(e.to_string()))?;
                req = req.header(header::AUTHORIZATION, answer.to_header_string());
            }
            let res = req
                .send()
                .await
                .map_err(|e| Failure::Network(format!("Can't reach PrusaLink at {}: {e}", self.host)))?;
            if res.status() != StatusCode::UNAUTHORIZED {
                return Ok(res);
            }
            // First request, or the nonce expired: take the new challenge and try once more.
            let digest = res
                .headers()
                .get(header::WWW_AUTHENTICATE)
                .and_then(|v| v.to_str().ok())
                .filter(|v| v.trim_start().to_ascii_lowercase().starts_with("digest"))
                .and_then(|v| digest_auth::parse(v).ok());
            match digest {
                Some(c) => self.challenge = Some(c),
                None => self.api_key = true,
            }
        }
        Err(Failure::Auth(
            "PrusaLink rejected the login. Check the username and password (or API key).".into(),
        ))
    }

    async fn get_json<T: serde::de::DeserializeOwned>(&mut self, path: &str) -> Result<Option<T>, Failure> {
        let res = self.get(path).await?;
        match res.status() {
            StatusCode::NO_CONTENT => Ok(None),
            StatusCode::NOT_FOUND => Err(Failure::Network(
                "This printer's PrusaLink is too old for 3Devil. Update the printer's firmware.".into(),
            )),
            s if !s.is_success() => Err(Failure::Network(format!("PrusaLink answered {s} for {path}"))),
            _ => res
                .json()
                .await
                .map(Some)
                .map_err(|e| Failure::Network(format!("Unexpected answer from PrusaLink: {e}"))),
        }
    }
}

/// Accepts an IP address or host name, with or without `http://`.
pub(crate) fn clean_host(host: &str) -> Result<String, String> {
    let h = host.trim();
    let h = h.strip_prefix("http://").or_else(|| h.strip_prefix("https://")).unwrap_or(h);
    let h = h.trim_end_matches('/');
    if h.is_empty() || h.contains(|c: char| c.is_whitespace() || c == '/') {
        return Err(format!("Not an address: {host}"));
    }
    Ok(h.to_string())
}

#[derive(Deserialize)]
struct Status {
    job: Option<StatusJob>,
    printer: StatusPrinter,
}

#[derive(Deserialize)]
struct StatusJob {
    id: Option<u64>,
    /// Percent.
    progress: Option<f64>,
    /// Seconds.
    time_remaining: Option<i64>,
    /// Seconds.
    time_printing: Option<i64>,
}

#[derive(Deserialize)]
struct StatusPrinter {
    state: String,
    temp_nozzle: Option<f64>,
    target_nozzle: Option<f64>,
    temp_bed: Option<f64>,
    target_bed: Option<f64>,
}

#[derive(Deserialize)]
struct JobInfo {
    file: Option<JobFile>,
}

#[derive(Deserialize)]
struct JobFile {
    name: String,
    display_name: Option<String>,
    /// The slicer's notes in the file, such as `"filament used [g]"`.
    #[serde(default)]
    meta: Value,
    #[serde(default)]
    refs: FileRefs,
}

#[derive(Deserialize, Default)]
struct FileRefs {
    /// Path the printer serves the file from.
    download: Option<String>,
}

/// Grams of filament from a file's metadata: a number, or text that may list
/// one figure per extruder, as in `"12.3, 0.0"`.
fn filament_grams(meta: &Value) -> Option<f64> {
    let used = &meta["filament used [g]"];
    let grams = match used {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.split(',').map(|x| x.trim().parse::<f64>().ok()).sum(),
        _ => None,
    };
    grams.filter(|g| *g > 0.0)
}

/// What a print file's own notes say about it.
#[derive(Debug, Default, PartialEq)]
struct FileNotes {
    /// One name per object on the plate, so copies repeat.
    objects: Vec<String>,
    grams: Option<f64>,
}

/// An object's name without what PrusaSlicer adds to tell copies apart, as in
/// `Wall.stl (Instance 2)` or `Wall.stl id:0 copy 1`.
fn object_name(label: &str) -> &str {
    let number = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    if let Some((name, n)) = label.rsplit_once(" (Instance ") {
        if n.strip_suffix(')').is_some_and(number) {
            return name;
        }
    }
    if let Some((rest, copy)) = label.rsplit_once(" copy ") {
        if let Some((name, id)) = rest.rsplit_once(" id:") {
            if number(copy) && number(id) {
                return name;
            }
        }
    }
    label
}

/// Reads PrusaSlicer's notes for the printer, lines of `key=value`.
fn file_notes(text: &str) -> FileNotes {
    let value = |key: &str| text.lines().find_map(|l| l.strip_prefix(key)?.strip_prefix('='));
    let objects = value("objects_info")
        .and_then(|v| serde_json::from_str::<Value>(v).ok())
        .and_then(|v| {
            let names = v["objects"].as_array()?.iter().filter_map(|o| o["name"].as_str());
            Some(names.map(|n| object_name(n).to_string()).collect())
        })
        .unwrap_or_default();
    let grams = value("filament used [g]").and_then(|v| filament_grams(&json!({ "filament used [g]": v })));
    FileNotes { objects, grams }
}

/// The printer's notes in the start of a binary G-code file.
#[derive(Debug, PartialEq)]
enum Head {
    /// They aren't all here yet.
    More,
    Notes(String),
    /// Not binary G-code, or it has none that can be read.
    Missing,
}

/// Finds the notes for the printer, which binary G-code keeps near its start,
/// ahead of the thumbnails and the G-code itself.
fn printer_notes(head: &[u8]) -> Head {
    const GCODE: u16 = 1;
    const PRINTER: u16 = 3;
    const THUMBNAIL: u16 = 5;
    let u16_at = |i: usize| u16::from_le_bytes([head[i], head[i + 1]]);
    let u32_at = |i: usize| u32::from_le_bytes([head[i], head[i + 1], head[i + 2], head[i + 3]]) as usize;
    if head.len() < 10 {
        return Head::More;
    }
    if &head[..4] != b"GCDE" {
        return Head::Missing;
    }
    let checksum = if u16_at(8) == 1 { 4 } else { 0 };
    let mut pos = 10;
    loop {
        if head.len() < pos + 12 {
            return Head::More;
        }
        let (kind, compression, size) = (u16_at(pos), u16_at(pos + 2), u32_at(pos + 4));
        // A compressed block gives its size in the file after its size once unpacked.
        let (stored, header) = if compression == 0 { (size, 8) } else { (u32_at(pos + 8), 12) };
        let start = pos + header + if kind == THUMBNAIL { 6 } else { 2 };
        let end = start + stored;
        if kind == GCODE || kind > THUMBNAIL {
            return Head::Missing;
        }
        if kind == PRINTER {
            let Some(body) = head.get(start..end) else { return Head::More };
            let mut text = String::new();
            let read = match compression {
                0 => std::str::from_utf8(body).map(|t| text.push_str(t)).is_ok(),
                1 => flate2::read::ZlibDecoder::new(body).read_to_string(&mut text).is_ok(),
                _ => false,
            };
            return if read { Head::Notes(text) } else { Head::Missing };
        }
        pos = end + checksum;
    }
}

/// Reads the notes in a print's file, taking only the start of it from the printer.
async fn read_notes(link: &mut Link, path: &str) -> Result<Option<FileNotes>, Failure> {
    let mut res = link.get(path).await?;
    if !res.status().is_success() {
        return Err(Failure::Network(format!("PrusaLink answered {} for {path}", res.status())));
    }
    let mut head = Vec::new();
    loop {
        match printer_notes(&head) {
            Head::Notes(text) => return Ok(Some(file_notes(&text))),
            Head::Missing => return Ok(None),
            Head::More if head.len() > HEAD_LIMIT => return Ok(None),
            Head::More => {}
        }
        let chunk = res.chunk().await.map_err(|e| Failure::Network(format!("Can't read {path} from the printer: {e}")))?;
        match chunk {
            Some(bytes) => head.extend_from_slice(&bytes),
            None => return Ok(None),
        }
    }
}

#[derive(Deserialize)]
struct Info {
    name: Option<String>,
    serial: Option<String>,
    hostname: Option<String>,
}

/// The print a printer is (or was last) running.
#[derive(Default)]
struct Run {
    id: u64,
    name: String,
    /// Unix seconds, worked out once from the printer's elapsed time.
    started: i64,
    /// Grams of filament, from the slicer's figures in the file.
    filament_g: Option<f64>,
    /// One name per object on the plate, from the file's notes.
    objects: Vec<String>,
    /// Where the printer serves the file, and the tries left to read its notes.
    unread: Option<(String, u8)>,
}

/// Bambu `gcode_state` for a PrusaLink printer state.
fn gcode_state(state: &str, has_job: bool) -> &'static str {
    match state {
        "PRINTING" => "RUNNING",
        "PAUSED" => "PAUSE",
        "FINISHED" => "FINISH",
        "STOPPED" => "FAILED",
        "ERROR" if has_job => "FAILED",
        "ERROR" => "ERROR",
        "ATTENTION" if has_job => "ATTENTION",
        "BUSY" if has_job => "PREPARE",
        "BUSY" => "BUSY",
        _ => "IDLE",
    }
}

/// The status as a Bambu-style `print` report.
fn report(status: &Status, run: Option<&Run>) -> Value {
    let job = status.job.as_ref();
    let p = &status.printer;
    let state = gcode_state(&p.state, job.is_some());
    // Keep naming the last print while the printer shows how it ended.
    let run = run.filter(|_| job.is_some() || matches!(state, "FINISH" | "FAILED"));
    let mut r = json!({
        "gcode_state": state,
        "nozzle_temper": p.temp_nozzle,
        "nozzle_target_temper": p.target_nozzle,
        "bed_temper": p.temp_bed,
        "bed_target_temper": p.target_bed,
    });
    if let Some(run) = run {
        r["subtask_name"] = json!(run.name);
        r["gcode_start_time"] = json!(run.started.to_string());
        r["job_id"] = json!(run.id.to_string());
        if let Some(grams) = run.filament_g {
            r["filament_g"] = json!(grams);
        }
        if !run.objects.is_empty() {
            r["plate_objects"] = json!(run.objects);
        }
    }
    if let Some(job) = job {
        r["mc_percent"] = json!(job.progress.unwrap_or(0.0).round() as i64);
        if let Some(secs) = job.time_remaining.filter(|s| *s >= 0) {
            r["mc_remaining_time"] = json!((secs + 59) / 60);
        }
    }
    r
}

pub(crate) fn now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

async fn poll(link: &mut Link, run: &mut Option<Run>) -> Result<Value, Failure> {
    let status: Status = link
        .get_json("/api/v1/status")
        .await?
        .ok_or_else(|| Failure::Network("PrusaLink sent an empty status".into()))?;
    if let Some(job) = &status.job {
        let id = job.id.unwrap_or(0);
        if run.as_ref().map(|r| r.id) != Some(id) {
            let info: Option<JobInfo> = link.get_json("/api/v1/job").await?;
            let file = info.and_then(|i| i.file);
            let filament_g = file.as_ref().and_then(|f| filament_grams(&f.meta));
            let unread = file.as_ref().and_then(|f| f.refs.download.clone()).map(|path| (path, NOTES_TRIES));
            let name = file.map(|f| f.display_name.unwrap_or(f.name)).unwrap_or_default();
            let started = now() - job.time_printing.unwrap_or(0);
            *run = Some(Run { id, name, started, filament_g, objects: Vec::new(), unread });
        }
        // The file says what's on the plate, which its name and the printer don't.
        if let Some(run) = run.as_mut() {
            if let Some((path, tries)) = run.unread.take() {
                match read_notes(link, &path).await {
                    Ok(notes) => {
                        let notes = notes.unwrap_or_default();
                        println!("[prusa {}] {}: {} objects, {:?} g of filament", link.host, run.name, notes.objects.len(), notes.grams);
                        run.filament_g = run.filament_g.or(notes.grams);
                        run.objects = notes.objects;
                    }
                    Err(f) => {
                        println!("[prusa {}] can't read the print's file: {}", link.host, f.message());
                        run.unread = (tries > 1).then(|| (path, tries - 1));
                    }
                }
            }
        }
    }
    Ok(report(&status, run.as_ref()))
}

async fn run(app: AppHandle, id: String, host: String, username: String, password: String) {
    let mut link = match Link::new(&host, &username, &password) {
        Ok(l) => l,
        Err(e) => return emit_status(&app, &id, false, Some(e), &json!({})),
    };
    let mut current: Option<Run> = None;
    let mut last = json!({});
    let mut last_log = String::new();
    loop {
        let wait = match poll(&mut link, &mut current).await {
            Ok(report) => {
                let summary = format!(
                    "{} {}% {}",
                    report["gcode_state"].as_str().unwrap_or("?"),
                    report["mc_percent"],
                    report["subtask_name"].as_str().unwrap_or(""),
                );
                if summary != last_log {
                    println!("[prusa {host}] {summary}");
                    last_log = summary;
                }
                emit_status(&app, &id, true, None, &report);
                last = report;
                POLL
            }
            Err(f) => {
                let wait = if matches!(f, Failure::Auth(_)) { Duration::from_secs(30) } else { Duration::from_secs(5) };
                let msg = f.message();
                println!("[prusa {host}] {msg}");
                emit_status(&app, &id, false, Some(msg), &last);
                wait
            }
        };
        tokio::time::sleep(wait).await;
    }
}

/// Best-effort model name from the printer's host name, e.g. `prusa-mk4`.
fn model_from_hostname(hostname: &str) -> String {
    let h = hostname.to_ascii_lowercase();
    let model = h.strip_prefix("prusa-").or_else(|| h.strip_prefix("prusa")).unwrap_or("");
    let words: Vec<String> = model
        .split(['-', '_'])
        .filter(|w| !w.is_empty())
        .map(|w| {
            if w.len() <= 2 || w == "mini" || w.chars().any(|c| c.is_ascii_digit()) {
                w.to_ascii_uppercase()
            } else {
                let mut c = w.chars();
                c.next().map(|f| f.to_ascii_uppercase().to_string() + c.as_str()).unwrap_or_default()
            }
        })
        .collect();
    if words.is_empty() { "Prusa printer".into() } else { format!("Prusa {}", words.join(" ")) }
}

/// Logs in to the printer at `host` and reads its name and serial, so the
/// details can be checked before saving.
#[tauri::command]
pub async fn prusa_probe(host: String, username: String, password: String) -> Result<FoundPrinter, String> {
    let mut link = Link::new(&host, &username, &password)?;
    let info: Info = link
        .get_json("/api/v1/info")
        .await
        .map_err(|f| match f {
            Failure::Network(m) if m.starts_with("Can't reach") => format!("No PrusaLink answered at {}", link.host),
            f => f.message(),
        })?
        .ok_or("PrusaLink sent no printer info")?;
    let model = info
        .hostname
        .as_deref()
        .map(model_from_hostname)
        .filter(|m| m != "Prusa printer")
        .or(info.name.filter(|n| !n.trim().is_empty()))
        .unwrap_or_else(|| "Prusa printer".into());
    Ok(FoundPrinter { ip: link.host, serial: info.serial.unwrap_or_default(), model })
}

/// Starts (or restarts) polling one Prusa printer. Updates arrive as
/// `printer-status` events, like Bambu printers.
#[tauri::command]
pub fn prusa_connect(
    app: AppHandle,
    printers: State<'_, Printers>,
    id: String,
    host: String,
    username: String,
    password: String,
) {
    printers.start(id.clone(), run(app, id, host, username, password));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn status(v: Value) -> Status {
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn printing_reads_like_bambu() {
        let s = status(json!({
            "job": {"id": 7, "progress": 42.4, "time_remaining": 3600, "time_printing": 120},
            "printer": {"state": "PRINTING", "temp_nozzle": 214.8, "target_nozzle": 215.0, "temp_bed": 60.1, "target_bed": 60.0}
        }));
        let run = Run { id: 7, name: "Wall_A_0.4n_0.2mm_PLA_MK4S_1h2m.bgcode".into(), started: 1000, ..Default::default() };
        let r = report(&s, Some(&run));
        assert_eq!(r["gcode_state"], "RUNNING");
        assert_eq!(r["mc_percent"], 42);
        assert_eq!(r["mc_remaining_time"], 60);
        assert_eq!(r["subtask_name"], "Wall_A_0.4n_0.2mm_PLA_MK4S_1h2m.bgcode");
        assert_eq!(r["gcode_start_time"], "1000");
        assert_eq!(r["job_id"], "7");
        assert_eq!(r["bed_target_temper"], 60.0);
    }

    #[test]
    fn filament_from_file_metadata() {
        assert_eq!(filament_grams(&json!({"filament used [g]": 12.5})), Some(12.5));
        assert_eq!(filament_grams(&json!({"filament used [g]": "12.5, 2.5"})), Some(15.0));
        assert_eq!(filament_grams(&json!({"filament used [g]": "0"})), None);
        assert_eq!(filament_grams(&json!({})), None);
        assert_eq!(filament_grams(&Value::Null), None);
        let info: JobInfo = serde_json::from_value(json!({"file": {"name": "A.bgcode", "meta": {"filament used [g]": 3.1}}})).unwrap();
        let file = info.file.unwrap();
        assert_eq!(filament_grams(&file.meta), Some(3.1));
        let run = Run { id: 7, name: file.name, started: 1000, filament_g: filament_grams(&file.meta), ..Default::default() };
        let s = status(json!({"job": {"id": 7}, "printer": {"state": "PRINTING"}}));
        assert_eq!(report(&s, Some(&run))["filament_g"], 3.1);
    }

    /// A binary G-code block, with the checksum the file's header promises.
    fn block(kind: u16, compression: u16, body: &[u8], unpacked: usize) -> Vec<u8> {
        let mut b = Vec::new();
        b.extend(kind.to_le_bytes());
        b.extend(compression.to_le_bytes());
        b.extend((unpacked as u32).to_le_bytes());
        if compression != 0 {
            b.extend((body.len() as u32).to_le_bytes());
        }
        b.extend(if kind == 5 { &[0u8; 6][..] } else { &[0u8; 2][..] });
        b.extend(body);
        b.extend([0u8; 4]);
        b
    }

    const NOTES: &str = "printer_model=COREONEL\nobjects_info={\"objects\":[{\"name\":\"roof_2.stl\",\"polygon\":[[1.5,2.0],[3.0,4.0]]},{\"name\":\"roof_5.stl (Instance 1)\",\"polygon\":[]},{\"name\":\"roof_5.stl (Instance 2)\",\"polygon\":[]}]}\nfilament used [mm]=263379.43\nfilament used [g]=766.54\n";

    #[test]
    fn plate_from_file_notes() {
        let notes = file_notes(NOTES);
        assert_eq!(notes.objects, ["roof_2.stl", "roof_5.stl", "roof_5.stl"]);
        assert_eq!(notes.grams, Some(766.54));
        assert_eq!(file_notes("printer_model=MK4S\nobjects_info={\"objects\":[{\"name\":\"a \"b\"\"}]}\n"), FileNotes::default());
        assert_eq!(file_notes("filament used [g]=12.5, 2.5\n").grams, Some(15.0));

        let run = Run { id: 7, name: "roof_2.bgcode".into(), started: 1000, objects: notes.objects, ..Default::default() };
        let s = status(json!({"job": {"id": 7}, "printer": {"state": "PRINTING"}}));
        assert_eq!(report(&s, Some(&run))["plate_objects"], json!(["roof_2.stl", "roof_5.stl", "roof_5.stl"]));
        let bare = Run { id: 7, ..Default::default() };
        assert!(report(&s, Some(&bare)).get("plate_objects").is_none());
    }

    #[test]
    fn object_names() {
        assert_eq!(object_name("Wall.stl"), "Wall.stl");
        assert_eq!(object_name("Wall.stl (Instance 12)"), "Wall.stl");
        assert_eq!(object_name("Wall.stl id:0 copy 3"), "Wall.stl");
        assert_eq!(object_name("Wall (Instance two)"), "Wall (Instance two)");
        assert_eq!(object_name("my copy 2"), "my copy 2");
    }

    #[test]
    fn notes_in_binary_gcode() {
        let mut file = b"GCDE".to_vec();
        file.extend(1u32.to_le_bytes());
        file.extend(1u16.to_le_bytes());
        file.extend(block(0, 0, b"Producer=PrusaSlicer 2.9.6\n", 27));
        let before = file.len();
        file.extend(block(3, 0, NOTES.as_bytes(), NOTES.len()));
        let after = file.len();
        file.extend(block(5, 0, &[7u8; 500], 500));
        file.extend(block(1, 3, &[9u8; 300], 900));

        assert_eq!(printer_notes(&file), Head::Notes(NOTES.into()));
        // Every shorter read asks for more until the notes are whole.
        for n in [0, 9, 10, before, before + 11, before + 12, after - 5] {
            assert_eq!(printer_notes(&file[..n]), Head::More, "{n} bytes");
        }
        assert_eq!(printer_notes(&file[..after - 4]), Head::Notes(NOTES.into()));

        let mut packed = Vec::new();
        let mut z = flate2::read::ZlibEncoder::new(NOTES.as_bytes(), flate2::Compression::default());
        z.read_to_end(&mut packed).unwrap();
        let mut zipped = file[..before].to_vec();
        zipped.extend(block(3, 1, &packed, NOTES.len()));
        assert_eq!(printer_notes(&zipped), Head::Notes(NOTES.into()));

        // No notes ahead of the G-code, a kind of packing that isn't read, or another kind of file.
        let mut none = file[..before].to_vec();
        none.extend(block(1, 3, &[9u8; 300], 900));
        assert_eq!(printer_notes(&none), Head::Missing);
        let mut shrunk = file[..before].to_vec();
        shrunk.extend(block(3, 2, &[9u8; 300], 900));
        assert_eq!(printer_notes(&shrunk), Head::Missing);
        assert_eq!(printer_notes(b"; generated by PrusaSlicer 2.9.6\nG28\n"), Head::Missing);
    }

    #[test]
    fn finished_print_keeps_its_name() {
        let run = Run { id: 7, name: "Wall_A.bgcode".into(), started: 1000, ..Default::default() };
        let r = report(&status(json!({"printer": {"state": "FINISHED"}})), Some(&run));
        assert_eq!(r["gcode_state"], "FINISH");
        assert_eq!(r["subtask_name"], "Wall_A.bgcode");
        let r = report(&status(json!({"printer": {"state": "IDLE"}})), Some(&run));
        assert_eq!(r["gcode_state"], "IDLE");
        assert!(r.get("subtask_name").is_none());
    }

    #[test]
    fn states() {
        assert_eq!(gcode_state("STOPPED", true), "FAILED");
        assert_eq!(gcode_state("ATTENTION", true), "ATTENTION");
        assert_eq!(gcode_state("BUSY", false), "BUSY");
        assert_eq!(gcode_state("READY", false), "IDLE");
    }

    #[test]
    fn hosts() {
        assert_eq!(clean_host(" http://192.168.1.9/ ").unwrap(), "192.168.1.9");
        assert_eq!(clean_host("prusa-mk4.local").unwrap(), "prusa-mk4.local");
        assert!(clean_host("a b").is_err());
        assert!(clean_host("").is_err());
    }

    /// Talks to a real printer: `PRUSALINK_HOST=… PRUSALINK_PASSWORD=…
    /// [PRUSALINK_USER=…] cargo test prusalink_live -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn prusalink_live() {
        let var = |k: &str| std::env::var(k).unwrap_or_default();
        let (host, user, pw) = (var("PRUSALINK_HOST"), var("PRUSALINK_USER"), var("PRUSALINK_PASSWORD"));
        tauri::async_runtime::block_on(async {
            let found = prusa_probe(host.clone(), user.clone(), pw.clone()).await.unwrap();
            println!("probe: {} · {} · {}", found.model, found.ip, found.serial);
            let mut link = Link::new(&host, &user, &pw).unwrap();
            let mut current = None;
            for _ in 0..3 {
                match poll(&mut link, &mut current).await {
                    Ok(r) => println!("report: {r}"),
                    Err(f) => panic!("{}", f.message()),
                }
                tokio::time::sleep(POLL).await;
            }
        });
    }

    #[test]
    fn models() {
        assert_eq!(model_from_hostname("prusa-mk4"), "Prusa MK4");
        assert_eq!(model_from_hostname("prusa-core-one"), "Prusa Core One");
        assert_eq!(model_from_hostname("PrusaXL"), "Prusa XL");
        assert_eq!(model_from_hostname("garage"), "Prusa printer");
    }
}
