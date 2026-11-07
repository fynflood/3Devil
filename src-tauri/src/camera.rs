//! Live camera pictures for the Printers page. Every kind of camera ends up as
//! JPEGs in memory, and the page asks for the newest one while it's open, so
//! nothing runs for a printer nobody is looking at.
//!
//! X1 and newer Bambu printers stream H.264 over RTSP, which `ffmpeg` turns
//! into JPEGs (a video decoder is far too much to bundle for this). P1 and A1
//! printers send JPEGs over their own protocol on port 6000. Klipper cameras
//! are reached through the snapshot or MJPEG address Moonraker lists. Elegoo
//! printers are asked to turn their camera on, then streamed like the others:
//! resin printers over RTSP, the Centauri Carbon as MJPEG.

use crate::elegoo::video_url;
use crate::klipper::{webcam, Webcam};
use crate::printer::tls_config;
use reqwest::Client;
use rumqttc::tokio_rustls::rustls::pki_types::ServerName;
use rumqttc::tokio_rustls::TlsConnector;
use serde::Serialize;
use std::collections::HashMap;
use std::future::Future;
use std::net::IpAddr;
use std::path::Path;
use std::pin::Pin;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::async_runtime::JoinHandle;
use tauri::ipc::Response;
use tauri::State;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::time::{sleep, timeout, Instant};

/// How often to fetch a picture from a snapshot address.
const SNAPSHOT_EVERY: Duration = Duration::from_millis(300);
const READ_TIMEOUT: Duration = Duration::from_secs(10);
/// A camera nobody has asked for a picture this long is stopped. The page asks
/// several times a second while it shows one; this catches a page that went
/// away without saying so, like one that reloaded.
const UNWATCHED: Duration = Duration::from_secs(15);
/// `ffmpeg` needs a few hundred megabytes for a camera; past this it's stopped.
const FFMPEG_MAX_MB: u64 = 1024;
/// Far larger than any camera picture; anything bigger is a broken stream.
const MAX_JPEG: usize = 8 * 1024 * 1024;
const NO_LIVEVIEW: &str = "The printer didn't send a picture. Turn on LAN Mode Liveview in its network settings.";

#[derive(Default)]
struct Picture {
    jpeg: Option<Vec<u8>>,
    seen_one: bool,
    error: Option<String>,
    /// When the page last asked for a picture; `None` until it first does.
    asked: Option<Instant>,
}

type Shared = Arc<Mutex<Picture>>;

fn store(picture: &Shared, jpeg: Vec<u8>) {
    let mut p = picture.lock().unwrap();
    if !p.seen_one {
        println!("[camera] first picture, {} bytes", jpeg.len());
        p.seen_one = true;
    }
    p.jpeg = Some(jpeg);
    p.error = None;
}

struct Feed {
    picture: Shared,
    task: JoinHandle<()>,
}

/// Open cameras, by printer id.
#[derive(Default)]
pub struct Cameras(Mutex<HashMap<String, Feed>>);

/// How the page should turn the picture, for cameras mounted at an angle.
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct View {
    rotation: i32,
    flip_horizontal: bool,
    flip_vertical: bool,
}

/// Pulls whole JPEGs out of a stream of bytes.
#[derive(Default)]
struct JpegSplitter(Vec<u8>);

impl JpegSplitter {
    /// Adds `bytes` and returns the newest complete picture, if there is one.
    fn push(&mut self, bytes: &[u8]) -> Option<Vec<u8>> {
        self.0.extend_from_slice(bytes);
        let mut newest = None;
        loop {
            let Some(start) = find(&self.0, &[0xFF, 0xD8]) else {
                self.0.clear();
                break;
            };
            let Some(len) = find(&self.0[start..], &[0xFF, 0xD9]) else {
                self.0.drain(..start);
                break;
            };
            let end = start + len + 2;
            newest = Some(self.0[start..end].to_vec());
            self.0.drain(..end);
        }
        if self.0.len() > MAX_JPEG {
            self.0.clear();
        }
        newest
    }
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

/// `ffmpeg` on the PATH, or where package managers put it when an app started
/// from the desktop doesn't get their PATH.
fn ffmpeg_program() -> String {
    crate::which("ffmpeg")
        .or_else(|| {
            ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"]
                .into_iter()
                .find(|p| Path::new(p).exists())
                .map(String::from)
        })
        .unwrap_or_else(|| "ffmpeg".into())
}

fn ffmpeg_args(url: &str, transport: &str, skip_verify: bool) -> Vec<String> {
    let mut args: Vec<String> = ["-hide_banner", "-loglevel", "error", "-rtsp_transport", transport].map(String::from).into();
    if skip_verify {
        // Bambu's certificates come from its own private authority.
        args.extend(["-tls_verify", "0"].map(String::from));
    }
    args.extend(["-timeout", "8000000", "-i", url, "-an"].map(String::from));
    // At most four pictures a second, by dropping frames only. The `fps` filter
    // also repeats frames to fill gaps, and an X1 camera's clock jumps hours
    // ahead when a second viewer connects: it then made thousands of pictures
    // a second, which piled up in memory until the system killed 3Devil.
    let pace = "select=isnan(prev_selected_t)+gte(t-prev_selected_t\\,0.25),scale=1280:-2";
    args.extend(["-vf", pace, "-fps_mode", "passthrough"].map(String::from));
    args.extend(["-c:v", "mjpeg", "-q:v", "6", "-f", "image2pipe", "pipe:1"].map(String::from));
    args
}

/// Megabytes of memory a process is using, where the system says.
fn memory_mb(pid: u32) -> Option<u64> {
    let status = std::fs::read_to_string(format!("/proc/{pid}/status")).ok()?;
    let kb = status.lines().find_map(|l| l.strip_prefix("VmRSS:"))?.split_whitespace().next()?.parse::<u64>().ok()?;
    Some(kb / 1024)
}

/// A running `ffmpeg`, asked to quit when it's dropped rather than killed, so
/// it ends its RTSP session. Elegoo printers allow two viewers and keep a
/// session that was cut off open for minutes, locking everyone out.
struct Ffmpeg(Option<tokio::process::Child>);

impl Ffmpeg {
    async fn end(mut child: tokio::process::Child) {
        #[cfg(unix)]
        if let Some(pid) = child.id() {
            // SAFETY: the child hasn't been waited for, so the id is still its own.
            unsafe { libc::kill(pid as libc::pid_t, libc::SIGTERM) };
            if timeout(Duration::from_secs(3), child.wait()).await.is_ok() {
                return;
            }
        }
        let _ = child.kill().await;
    }
}

impl Drop for Ffmpeg {
    fn drop(&mut self) {
        if let Some(child) = self.0.take() {
            tauri::async_runtime::spawn(Ffmpeg::end(child));
        }
    }
}

/// Runs `ffmpeg` until the stream ends. True if it produced any pictures.
async fn ffmpeg_stream(url: &str, transport: &str, skip_verify: bool, picture: &Shared) -> Result<bool, String> {
    let mut command = tokio::process::Command::from(crate::external(&ffmpeg_program()));
    command
        .args(ffmpeg_args(url, transport, skip_verify))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // A last resort; stopping the camera drops `Ffmpeg`, which ends it first.
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let mut child = Ffmpeg(Some(command.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            "Live video from this printer needs ffmpeg. Install it, then try again.".to_string()
        } else {
            format!("Couldn't start ffmpeg: {e}")
        }
    })?));
    let process = child.0.as_mut().ok_or("ffmpeg gave no output")?;
    let mut stdout = process.stdout.take().ok_or("ffmpeg gave no output")?;
    let mut stderr = process.stderr.take().ok_or("ffmpeg gave no output")?;
    let mut splitter = JpegSplitter::default();
    let mut chunk = vec![0; 64 * 1024];
    let mut any = false;
    let pid = child.0.as_ref().and_then(|c| c.id());
    let mut checked = Instant::now();
    let mut too_big = None;
    loop {
        match timeout(READ_TIMEOUT, stdout.read(&mut chunk)).await {
            Ok(Ok(n)) if n > 0 => {
                if let Some(jpeg) = splitter.push(&chunk[..n]) {
                    any = true;
                    store(picture, jpeg);
                }
            }
            _ => break,
        }
        // A safety net in case a camera finds another way to flood it.
        if checked.elapsed() > Duration::from_secs(1) {
            checked = Instant::now();
            if let Some(mb) = pid.and_then(memory_mb).filter(|&mb| mb > FFMPEG_MAX_MB) {
                too_big = Some(mb);
                break;
            }
        }
    }
    if let Some(process) = child.0.take() {
        Ffmpeg::end(process).await;
    }
    let mut errors = String::new();
    let _ = stderr.read_to_string(&mut errors).await;
    if let Some(mb) = too_big {
        return Err(format!("ffmpeg was using {mb} MB showing this camera, so 3Devil stopped it. Try again."));
    }
    if any {
        return Ok(true);
    }
    Err(errors.lines().last().unwrap_or("The camera stream ended").to_string())
}

async fn bambu_rtsp(host: &str, code: &str, picture: &Shared) -> Result<(), String> {
    let url = format!("rtsps://bblp:{code}@{host}:322/streaming/live/1");
    let hide = |e: String| e.replace(code, "…");
    let mut skip_verify = true;
    loop {
        match ffmpeg_stream(&url, "tcp", skip_verify, picture).await {
            // The stream dropped after working: pick it up again.
            Ok(_) => sleep(Duration::from_secs(2)).await,
            // Versions from before certificates were checked don't know the option.
            Err(e) if skip_verify && e.contains("tls_verify") => skip_verify = false,
            Err(e) => {
                println!("[camera] ffmpeg: {}", hide(e.clone()));
                return Err(if e.contains("ffmpeg") {
                    hide(e)
                } else {
                    format!("{NO_LIVEVIEW} ({})", hide(e))
                });
            }
        }
    }
}

/// The 80 bytes that open a camera connection on port 6000.
fn jpeg_login(code: &str) -> Vec<u8> {
    let mut login = Vec::with_capacity(80);
    for word in [0x40u32, 0x3000, 0, 0] {
        login.extend_from_slice(&word.to_le_bytes());
    }
    for field in ["bblp", code] {
        let mut padded = field.as_bytes().to_vec();
        padded.resize(32, 0);
        login.extend_from_slice(&padded);
    }
    login
}

/// Reads one framed picture: a 16-byte header starting with the size, then a JPEG.
async fn read_framed(stream: &mut (impl AsyncRead + Unpin)) -> Result<Vec<u8>, String> {
    let mut read = async |buf: &mut [u8]| match timeout(READ_TIMEOUT, stream.read_exact(buf)).await {
        Ok(Ok(_)) => Ok(()),
        _ => Err("The camera stopped sending pictures".to_string()),
    };
    let mut header = [0; 16];
    read(&mut header).await?;
    let size = u32::from_le_bytes([header[0], header[1], header[2], 0]) as usize;
    if size == 0 || size > MAX_JPEG {
        return Err(NO_LIVEVIEW.into());
    }
    let mut jpeg = vec![0; size];
    read(&mut jpeg).await?;
    if !jpeg.starts_with(&[0xFF, 0xD8]) {
        return Err(NO_LIVEVIEW.into());
    }
    Ok(jpeg)
}

async fn bambu_jpeg(host: &str, code: &str, picture: &Shared) -> Result<(), String> {
    let ip: IpAddr = host.parse().map_err(|_| format!("Not an IP address: {host}"))?;
    let tcp = timeout(Duration::from_secs(5), TcpStream::connect((ip, 6000)))
        .await
        .map_err(|_| format!("No camera answered at {host}"))?
        .map_err(|e| format!("No camera answered at {host}: {e}"))?;
    let connector = TlsConnector::from(Arc::new(tls_config()));
    let mut tls = connector
        .connect(ServerName::IpAddress(ip.into()), tcp)
        .await
        .map_err(|e| format!("Couldn't open the camera at {host}: {e}"))?;
    tls.write_all(&jpeg_login(code)).await.map_err(|e| e.to_string())?;
    loop {
        let jpeg = read_framed(&mut tls).await?;
        store(picture, jpeg);
    }
}

async fn klipper_camera(camera: Webcam, picture: &Shared) -> Result<(), String> {
    let http = Client::builder()
        .connect_timeout(Duration::from_secs(3))
        .timeout(if camera.snapshot.is_some() { READ_TIMEOUT } else { Duration::from_secs(24 * 3600) })
        .build()
        .map_err(|e| e.to_string())?;
    let problem = |e: reqwest::Error| format!("Can't reach the camera: {e}");

    if let Some(url) = &camera.snapshot {
        loop {
            let res = http.get(url).send().await.and_then(|r| r.error_for_status()).map_err(problem)?;
            let bytes = res.bytes().await.map_err(problem)?;
            if !bytes.starts_with(&[0xFF, 0xD8]) {
                return Err("The camera's snapshot address didn't return a picture.".into());
            }
            store(picture, bytes.to_vec());
            sleep(SNAPSHOT_EVERY).await;
        }
    }

    let url = camera.stream.ok_or("Moonraker lists no camera for this printer.")?;
    mjpeg(&http, &url, picture, "This camera uses a kind of stream 3Devil can't show. Set up a snapshot address for it.").await
}

/// Reads an MJPEG stream; `not_mjpeg` is the error for any other kind.
async fn mjpeg(http: &Client, url: &str, picture: &Shared, not_mjpeg: &str) -> Result<(), String> {
    let problem = |e: reqwest::Error| format!("Can't reach the camera: {e}");
    let mut res = http.get(url).send().await.and_then(|r| r.error_for_status()).map_err(problem)?;
    let kind = res.headers().get(reqwest::header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("");
    if !kind.contains("multipart") {
        return Err(not_mjpeg.into());
    }
    let mut splitter = JpegSplitter::default();
    while let Some(chunk) = res.chunk().await.map_err(problem)? {
        if let Some(jpeg) = splitter.push(&chunk) {
            store(picture, jpeg);
        }
    }
    Err("The camera stream ended".into())
}

async fn elegoo_camera(host: &str, mainboard: &str, picture: &Shared) -> Result<(), String> {
    let url = video_url(host, mainboard).await?;
    if url.starts_with("rtsp") {
        // These printers refuse RTSP over TCP.
        loop {
            match ffmpeg_stream(&url, "udp", false, picture).await {
                Ok(_) => sleep(Duration::from_secs(2)).await,
                Err(e) => {
                    println!("[camera] ffmpeg: {e}");
                    return Err(if e.contains("ffmpeg") { e } else { format!("The printer's camera didn't send a picture ({e})") });
                }
            }
        }
    }
    let http = Client::builder()
        .connect_timeout(Duration::from_secs(3))
        .build()
        .map_err(|e| e.to_string())?;
    mjpeg(&http, &url, picture, "This printer's camera uses a kind of stream 3Devil can't show.").await
}

/// Returns once the page has stopped asking for pictures.
async fn unwatched(picture: &Shared) {
    loop {
        sleep(Duration::from_secs(2)).await;
        if picture.lock().unwrap().asked.is_some_and(|at| at.elapsed() > UNWATCHED) {
            return;
        }
    }
}

/// Opens the camera of the printer `id`, replacing any feed it already has.
/// `rtsp` says a Bambu printer streams video instead of sending pictures.
/// `serial` is an Elegoo printer's mainboard id.
#[tauri::command]
pub async fn camera_start(
    cameras: State<'_, Cameras>,
    id: String,
    kind: String,
    host: String,
    access_code: String,
    serial: Option<String>,
    rtsp: bool,
) -> Result<View, String> {
    let picture = Shared::default();
    picture.lock().unwrap().asked = Some(Instant::now());
    let feed = picture.clone();
    let (view, stream): (View, Pin<Box<dyn Future<Output = Result<(), String>> + Send>>) = if kind == "elegoo" {
        let mainboard = serial.unwrap_or_default();
        (View::default(), Box::pin(async move { elegoo_camera(&host, &mainboard, &feed).await }))
    } else if kind == "klipper" {
        let camera = webcam(&host, &access_code).await?;
        let view = View { rotation: camera.rotation, flip_horizontal: camera.flip_horizontal, flip_vertical: camera.flip_vertical };
        (view, Box::pin(async move { klipper_camera(camera, &feed).await }))
    } else if rtsp {
        (View::default(), Box::pin(async move { bambu_rtsp(&host, &access_code, &feed).await }))
    } else {
        (View::default(), Box::pin(async move { bambu_jpeg(&host, &access_code, &feed).await }))
    };
    let feed = picture.clone();
    let task = tauri::async_runtime::spawn(async move {
        let result = tokio::select! {
            result = stream => result,
            _ = unwatched(&feed) => Err("The camera stopped because nothing was showing it.".into()),
        };
        if let Err(e) = result {
            println!("[camera] {e}");
            feed.lock().unwrap().error = Some(e);
        }
    });
    if let Some(old) = cameras.0.lock().unwrap().insert(id, Feed { picture, task }) {
        old.task.abort();
    }
    Ok(view)
}

/// The newest picture not fetched yet; empty if there isn't one.
#[tauri::command]
pub fn camera_frame(cameras: State<'_, Cameras>, id: String) -> Result<Response, String> {
    let map = cameras.0.lock().unwrap();
    let feed = map.get(&id).ok_or("The camera isn't open")?;
    let mut picture = feed.picture.lock().unwrap();
    picture.asked = Some(Instant::now());
    match (picture.jpeg.take(), &picture.error) {
        (Some(jpeg), _) => Ok(Response::new(jpeg)),
        (None, Some(error)) => Err(error.clone()),
        (None, None) => Ok(Response::new(Vec::new())),
    }
}

#[tauri::command]
pub fn camera_stop(cameras: State<'_, Cameras>, id: String) {
    if let Some(feed) = cameras.0.lock().unwrap().remove(&id) {
        feed.task.abort();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn jpeg(fill: u8) -> Vec<u8> {
        [&[0xFF, 0xD8][..], &[fill; 5], &[0xFF, 0xD9]].concat()
    }

    #[test]
    fn a_camera_nobody_asks_for_is_stopped() {
        tauri::async_runtime::block_on(async {
            let picture = Shared::default();
            assert!(timeout(Duration::from_secs(3), unwatched(&picture)).await.is_err(), "not asked yet");
            picture.lock().unwrap().asked = Some(Instant::now());
            assert!(timeout(Duration::from_secs(3), unwatched(&picture)).await.is_err(), "just asked");
            picture.lock().unwrap().asked = Instant::now().checked_sub(UNWATCHED + Duration::from_secs(1));
            assert!(timeout(Duration::from_secs(3), unwatched(&picture)).await.is_ok(), "long ago");
        });
    }

    #[test]
    fn splitter_finds_pictures_across_chunks() {
        let mut s = JpegSplitter::default();
        let a = jpeg(1);
        assert_eq!(s.push(&a[..4]), None);
        assert_eq!(s.push(&a[4..]), Some(a.clone()));
        let (b, c) = (jpeg(2), jpeg(3));
        // Two at once: the newest wins. Rubbish around them is dropped.
        assert_eq!(s.push(&[b"--boundary\r\n", &b[..], b"\r\n", &c[..], b"--"].concat()), Some(c));
        assert_eq!(s.push(&[0xFF]), None);
        assert_eq!(s.push(&jpeg(4)), Some(jpeg(4)));
    }

    #[test]
    fn login_is_80_bytes() {
        let login = jpeg_login("12345678");
        assert_eq!(login.len(), 80);
        assert_eq!(&login[..8], &[0x40, 0, 0, 0, 0, 0x30, 0, 0]);
        assert_eq!(&login[16..20], b"bblp");
        assert_eq!(&login[48..56], b"12345678");
    }

    #[test]
    fn framed_pictures_are_read_and_others_refused() {
        let frame = |body: &[u8]| [&(body.len() as u32).to_le_bytes()[..], &[0; 12], body].concat();
        tauri::async_runtime::block_on(async {
            let good = frame(&jpeg(7));
            assert_eq!(read_framed(&mut good.as_slice()).await.unwrap(), jpeg(7));
            // What an X1 Carbon answers on this port.
            let refused = frame(&[0xFF; 8]);
            assert!(read_framed(&mut refused.as_slice()).await.unwrap_err().contains("Liveview"));
        });
    }

    #[test]
    fn ffmpeg_only_writes_pictures_to_its_output() {
        let args = ffmpeg_args("rtsps://x", "tcp", true);
        assert_eq!(args.last().unwrap(), "pipe:1");
        assert!(args.windows(2).any(|w| w == ["-tls_verify", "0"]));
        assert!(!ffmpeg_args("rtsps://x", "tcp", false).contains(&"-tls_verify".to_string()));
        // Frames are only ever dropped, never repeated to fill a gap.
        let filters = &args[args.iter().position(|a| a == "-vf").unwrap() + 1];
        assert!(filters.starts_with("select=") && !filters.contains("fps="), "{filters}");
        assert!(args.windows(2).any(|w| w == ["-fps_mode", "passthrough"]));
    }

    #[test]
    fn reads_its_own_memory() {
        let mb = memory_mb(std::process::id()).unwrap();
        assert!(mb > 0 && mb < 4096, "{mb}");
        assert_eq!(memory_mb(u32::MAX), None);
    }

    /// Reads a real camera and saves a few pictures: `CAMERA_HOST=… CAMERA_CODE=…
    /// CAMERA_OUT=dir [CAMERA_KIND=klipper|bambu-jpeg|elegoo] [CAMERA_SECS=60] cargo test camera_live -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn camera_live() {
        let var = |k: &str| std::env::var(k).unwrap_or_default();
        let (host, code, out, kind) = (var("CAMERA_HOST"), var("CAMERA_CODE"), var("CAMERA_OUT"), var("CAMERA_KIND"));
        tauri::async_runtime::block_on(async {
            let picture = Shared::default();
            let feed = picture.clone();
            let task = tauri::async_runtime::spawn(async move {
                let result = match kind.as_str() {
                    "klipper" => match webcam(&host, &code).await {
                        Ok(camera) => klipper_camera(camera, &feed).await,
                        Err(e) => Err(e),
                    },
                    "bambu-jpeg" => bambu_jpeg(&host, &code, &feed).await,
                    "elegoo" => elegoo_camera(&host, &code, &feed).await,
                    _ => bambu_rtsp(&host, &code, &feed).await,
                };
                if let Err(e) = result {
                    feed.lock().unwrap().error = Some(e);
                }
            });
            let mut saved = 0;
            let secs: u64 = std::env::var("CAMERA_SECS").ok().and_then(|s| s.parse().ok()).unwrap_or(20);
            for _ in 0..secs * 4 {
                sleep(Duration::from_millis(250)).await;
                let mut p = picture.lock().unwrap();
                if let Some(error) = &p.error {
                    panic!("{error}");
                }
                if let Some(jpeg) = p.jpeg.take() {
                    saved += 1;
                    if saved <= 12 {
                        println!("picture {saved}: {} bytes", jpeg.len());
                        std::fs::write(format!("{out}/live-{saved}.jpg"), jpeg).unwrap();
                    }
                }
                if saved >= 12 && secs == 20 {
                    break;
                }
            }
            println!("{saved} pictures");
            task.abort();
            // Let `ffmpeg` end its session before the runtime goes.
            sleep(Duration::from_secs(4)).await;
            assert!(saved > 0, "no pictures");
        });
    }
}
