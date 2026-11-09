//! Live status from Klipper printers through Moonraker, the API server Fluidd
//! and Mainsail use. Like the Prusa connection this polls, here
//! `/printer/objects/query`, and reshapes the answer into the report Bambu
//! printers send, so the rest of the app tracks every kind the same way.

use crate::printer::{emit_status, scan_network, FoundPrinter, Printers};
use crate::prusa::{clean_host, now, Failure};
use reqwest::{Client, StatusCode};
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{json, Value};
use std::net::{IpAddr, SocketAddr};
use std::time::Duration;
use tauri::{AppHandle, State};
use tokio::net::TcpStream;
use tokio::time::timeout;

const POLL: Duration = Duration::from_secs(3);
/// Moonraker's own port. Mainsail and Fluidd also pass requests on from port 80.
const PORT: u16 = 7125;
const QUERY: &str = "/printer/objects/query?print_stats&display_status&virtual_sdcard&extruder&heater_bed&webhooks&gcode_move&fan";
/// Polls to wait for a new print to reach Moonraker's job history.
const HISTORY_WAIT: u8 = 3;

/// Moonraker wraps every HTTP answer in `{"result": ...}`.
#[derive(Deserialize)]
struct Answer<T> {
    result: T,
}

struct Link {
    http: Client,
    host: String,
    api_key: String,
}

impl Link {
    fn new(host: String, api_key: &str) -> Result<Self, String> {
        let http = Client::builder()
            .connect_timeout(Duration::from_secs(3))
            .timeout(Duration::from_secs(8))
            .build()
            .map_err(|e| e.to_string())?;
        Ok(Link { http, host, api_key: api_key.trim().to_string() })
    }

    /// GETs `path`; `None` means Moonraker answered with the `absent` status.
    async fn get<T: DeserializeOwned>(&self, path: &str, absent: StatusCode) -> Result<Option<T>, Failure> {
        let mut req = self.http.get(format!("http://{}{path}", self.host));
        if !self.api_key.is_empty() {
            req = req.header("X-Api-Key", &self.api_key);
        }
        let res = req
            .send()
            .await
            .map_err(|e| Failure::Network(format!("Can't reach Moonraker at {}: {e}", self.host)))?;
        match res.status() {
            s if s == absent => Ok(None),
            StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => {
                let problem = if self.api_key.is_empty() { "needs an API key" } else { "rejected that API key" };
                Err(Failure::Auth(format!("Moonraker {problem}. Find it in Fluidd or Mainsail's settings.")))
            }
            s if !s.is_success() => Err(Failure::Network(format!("Moonraker answered {s} for {path}"))),
            _ => res
                .json::<Answer<T>>()
                .await
                .map(|a| Some(a.result))
                .map_err(|e| Failure::Network(format!("Unexpected answer from Moonraker: {e}"))),
        }
    }

    /// Grams of filament the file uses, if the slicer said.
    async fn filament(&self, filename: &str) -> Result<Option<f64>, Failure> {
        let path = format!("/server/files/metadata?filename={}", encode(filename));
        let meta: Option<Metadata> = self.get(&path, StatusCode::NOT_FOUND).await?;
        Ok(meta.and_then(|m| m.filament_weight_total).filter(|g| *g > 0.0))
    }

    /// The newest print in Moonraker's job history, if it keeps one.
    async fn latest_job(&self) -> Result<Option<HistoryJob>, Failure> {
        let list: Option<History> = self.get("/server/history/list?limit=1&order=desc", StatusCode::NOT_FOUND).await?;
        Ok(list.and_then(|l| l.jobs.into_iter().next()))
    }

    /// `None` means Moonraker is up but Klipper isn't.
    async fn info(&self) -> Result<Option<Info>, Failure> {
        self.get("/printer/info", StatusCode::SERVICE_UNAVAILABLE).await
    }
}

/// Percent-encodes a query value.
fn encode(value: &str) -> String {
    value
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// Adds Moonraker's port unless the address names its own.
fn with_port(host: &str) -> String {
    if host.contains(':') { host.to_string() } else { format!("{host}:{PORT}") }
}

#[derive(Deserialize)]
struct Query {
    status: Objects,
}

/// The Klipper objects 3Devil reads. Printers without one just leave it out.
#[derive(Deserialize, Default)]
#[serde(default)]
struct Objects {
    print_stats: PrintStats,
    display_status: Option<Progress>,
    virtual_sdcard: Option<Progress>,
    extruder: Option<Heater>,
    heater_bed: Option<Heater>,
    webhooks: Option<Webhooks>,
    gcode_move: Option<Motion>,
    fan: Option<Fan>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct PrintStats {
    /// Relative to the gcode folder, so it can include sub-folders.
    filename: String,
    state: String,
    /// Seconds, without pauses.
    print_duration: f64,
    /// Seconds, with pauses.
    total_duration: f64,
    /// Only filled in when the slicer sends `SET_PRINT_STATS_INFO`.
    info: Option<Layers>,
}

#[derive(Deserialize)]
struct Layers {
    current_layer: Option<i64>,
    total_layer: Option<i64>,
}

#[derive(Deserialize)]
struct Progress {
    /// 0 to 1.
    progress: Option<f64>,
}

#[derive(Deserialize)]
struct Heater {
    temperature: Option<f64>,
    target: Option<f64>,
}

#[derive(Deserialize)]
struct Motion {
    /// 1 is the slicer's speed.
    speed_factor: Option<f64>,
}

#[derive(Deserialize)]
struct Fan {
    /// 0 to 1.
    speed: Option<f64>,
}

#[derive(Deserialize)]
struct Webhooks {
    state: String,
}

#[derive(Deserialize)]
struct History {
    jobs: Vec<HistoryJob>,
}

#[derive(Deserialize)]
struct HistoryJob {
    job_id: String,
    filename: String,
    start_time: f64,
    status: String,
}

#[derive(Deserialize)]
struct Metadata {
    filament_weight_total: Option<f64>,
}

#[derive(Deserialize)]
struct WebcamList {
    webcams: Vec<WebcamEntry>,
}

#[derive(Deserialize)]
struct WebcamEntry {
    #[serde(default = "enabled_by_default")]
    enabled: bool,
    #[serde(default)]
    stream_url: String,
    #[serde(default)]
    snapshot_url: String,
    #[serde(default)]
    rotation: i32,
    #[serde(default)]
    flip_horizontal: bool,
    #[serde(default)]
    flip_vertical: bool,
}

fn enabled_by_default() -> bool {
    true
}

/// Where to get a printer's camera, and how it's mounted.
pub(crate) struct Webcam {
    pub(crate) snapshot: Option<String>,
    pub(crate) stream: Option<String>,
    pub(crate) rotation: i32,
    pub(crate) flip_horizontal: bool,
    pub(crate) flip_vertical: bool,
}

/// A camera address, which Moonraker may give relative to the printer. Those
/// are served by the web interface, not on Moonraker's own port.
fn camera_url(host: &str, url: &str) -> Option<String> {
    match url.trim() {
        "" => None,
        u if u.contains("://") => Some(u.to_string()),
        u => {
            let site = host.strip_suffix(&format!(":{PORT}")).unwrap_or(host);
            Some(format!("http://{site}/{}", u.trim_start_matches('/')))
        }
    }
}

/// The first camera Moonraker lists for the printer at `host`.
pub(crate) async fn webcam(host: &str, api_key: &str) -> Result<Webcam, String> {
    let host = with_port(&clean_host(host)?);
    let link = Link::new(host.clone(), api_key)?;
    let list: Option<WebcamList> = link
        .get("/server/webcams/list", StatusCode::NOT_FOUND)
        .await
        .map_err(Failure::message)?;
    let camera = list
        .and_then(|l| l.webcams.into_iter().find(|w| w.enabled))
        .ok_or("Moonraker lists no camera for this printer.")?;
    Ok(Webcam {
        snapshot: camera_url(&host, &camera.snapshot_url),
        stream: camera_url(&host, &camera.stream_url),
        rotation: camera.rotation,
        flip_horizontal: camera.flip_horizontal,
        flip_vertical: camera.flip_vertical,
    })
}

#[derive(Deserialize)]
struct Info {
    hostname: Option<String>,
}

/// The print a printer is (or was last) running.
#[derive(Clone, Default)]
struct Run {
    /// Moonraker's job id; `None` if it keeps no job history.
    id: Option<String>,
    filename: String,
    /// Unix seconds.
    started: i64,
    /// The printer has reported how it ended.
    over: bool,
    /// Grams of filament, from the slicer's figures in the file.
    filament_g: Option<f64>,
    /// The file's metadata has been read, whether or not it had a weight.
    weighed: bool,
}

/// Bambu `gcode_state` for Klipper's own state and its print's. `tracking`
/// says a print was underway, which a Klipper shutdown ends.
fn gcode_state(klippy: &str, print: &str, tracking: bool) -> &'static str {
    match (klippy, print) {
        ("shutdown" | "error", _) if tracking => "FAILED",
        ("shutdown" | "error", _) => "ERROR",
        ("startup", _) => "BUSY",
        (_, "printing") => "RUNNING",
        (_, "paused") => "PAUSE",
        (_, "complete") => "FINISH",
        (_, "cancelled" | "error") => "FAILED",
        _ => "IDLE",
    }
}

fn basename(filename: &str) -> &str {
    filename.rsplit('/').next().unwrap_or(filename)
}

/// The status as a Bambu-style `print` report.
fn report(objects: &Objects, state: &str, run: Option<&Run>) -> Value {
    let stats = &objects.print_stats;
    let heater = |h: &Option<Heater>| h.as_ref().map(|h| (h.temperature, h.target)).unwrap_or_default();
    let (nozzle, nozzle_target) = heater(&objects.extruder);
    let (bed, bed_target) = heater(&objects.heater_bed);
    let mut r = json!({
        "gcode_state": state,
        "nozzle_temper": nozzle,
        "nozzle_target_temper": nozzle_target,
        "bed_temper": bed,
        "bed_target_temper": bed_target,
    });
    let active = matches!(state, "RUNNING" | "PAUSE");
    // Keep naming the last print while the printer shows how it ended.
    let run = run.filter(|run| (active && !run.over) || matches!(state, "FINISH" | "FAILED"));
    if let Some(run) = run {
        r["subtask_name"] = json!(basename(&run.filename));
        r["gcode_start_time"] = json!(run.started.to_string());
        if let Some(id) = &run.id {
            r["job_id"] = json!(id);
        }
        if let Some(grams) = run.filament_g {
            r["filament_g"] = json!(grams);
        }
    }
    if active {
        let progress = [&objects.display_status, &objects.virtual_sdcard]
            .into_iter()
            .find_map(|p| p.as_ref()?.progress)
            .unwrap_or(0.0);
        r["mc_percent"] = json!((progress * 100.0).round() as i64);
        if progress > 0.01 && stats.print_duration > 0.0 {
            let secs = stats.print_duration * (1.0 - progress) / progress;
            r["mc_remaining_time"] = json!((secs / 60.0).ceil() as i64);
        }
        if let Some(layers) = &stats.info {
            r["layer_num"] = json!(layers.current_layer);
            r["total_layer_num"] = json!(layers.total_layer);
        }
    }
    if let Some(factor) = objects.gcode_move.as_ref().and_then(|m| m.speed_factor) {
        r["spd_mag"] = json!((factor * 100.0).round() as i64);
    }
    // Bambu reports fans in steps of 15.
    if let Some(speed) = objects.fan.as_ref().and_then(|f| f.speed) {
        r["cooling_fan_speed"] = json!(((speed * 15.0).round() as i64).to_string());
    }
    r
}

async fn poll(link: &Link, run: &mut Option<Run>, waited: &mut u8) -> Result<Value, Failure> {
    let query: Option<Query> = link.get(QUERY, StatusCode::SERVICE_UNAVAILABLE).await?;
    let klippy_up = query.is_some();
    let objects = query.map(|q| q.status).unwrap_or_default();
    let stats = &objects.print_stats;
    let klippy = match &objects.webhooks {
        Some(w) => w.state.as_str(),
        None if klippy_up => "ready",
        // Klipper itself has gone away, which also ends any print.
        None => "shutdown",
    };
    let tracking = run.as_ref().is_some_and(|r| !r.over);
    let state = gcode_state(klippy, &stats.state, tracking);

    match state {
        "RUNNING" | "PAUSE" if !run.as_ref().is_some_and(|r| !r.over && r.filename == stats.filename) => {
            // A new print: its history entry gives it an id that survives
            // restarts, once Moonraker has written it.
            *run = None;
            match link.latest_job().await? {
                Some(job) if job.status == "in_progress" && job.filename == stats.filename => {
                    *waited = 0;
                    *run = Some(Run { id: Some(job.job_id), filename: job.filename, started: job.start_time as i64, over: false, ..Default::default() });
                }
                Some(_) if *waited < HISTORY_WAIT => *waited += 1,
                _ => {
                    *waited = 0;
                    let started = now() - stats.total_duration as i64;
                    *run = Some(Run { id: None, filename: stats.filename.clone(), started, over: false, ..Default::default() });
                }
            }
        }
        "FINISH" | "FAILED" if run.is_none() => {
            // It ended before 3Devil started; the id ties it to a tracked print.
            let job = link.latest_job().await?.filter(|j| j.filename == stats.filename);
            let started = job.as_ref().map_or(now() - stats.total_duration as i64, |j| j.start_time as i64);
            *run = Some(Run { id: job.map(|j| j.job_id), filename: stats.filename.clone(), started, over: true, ..Default::default() });
        }
        _ => {}
    }
    if let Some(r) = run.as_mut().filter(|r| !r.weighed && !r.filename.is_empty()) {
        r.weighed = true;
        // A file that has since gone just has no weight.
        r.filament_g = link.filament(&r.filename).await.unwrap_or(None);
    }

    let out = report(&objects, state, run.as_ref());
    if matches!(state, "FINISH" | "FAILED")
        && let Some(r) = run
    {
        r.over = true;
    }
    Ok(out)
}

async fn run(app: AppHandle, id: String, host: String, api_key: String) {
    let link = match clean_host(&host).and_then(|h| Link::new(with_port(&h), &api_key)) {
        Ok(l) => l,
        Err(e) => return emit_status(&app, &id, false, Some(e), &json!({})),
    };
    let mut current: Option<Run> = None;
    let mut waited = 0;
    let mut last = json!({});
    let mut last_log = String::new();
    loop {
        let wait = match poll(&link, &mut current, &mut waited).await {
            Ok(report) => {
                let summary = format!(
                    "{} {}% {}",
                    report["gcode_state"].as_str().unwrap_or("?"),
                    report["mc_percent"],
                    report["subtask_name"].as_str().unwrap_or(""),
                );
                if summary != last_log {
                    println!("[klipper {host}] {summary}");
                    last_log = summary;
                }
                emit_status(&app, &id, true, None, &report);
                last = report;
                POLL
            }
            Err(f) => {
                let wait = if matches!(f, Failure::Auth(_)) { Duration::from_secs(30) } else { Duration::from_secs(5) };
                let msg = f.message();
                println!("[klipper {host}] {msg}");
                emit_status(&app, &id, false, Some(msg), &last);
                wait
            }
        };
        tokio::time::sleep(wait).await;
    }
}

/// Finds Moonraker at `host` and reads the machine's name, so the details can
/// be checked before saving. Without a port this tries Moonraker's own, then
/// port 80 in case only Mainsail or Fluidd is reachable.
#[tauri::command]
pub async fn klipper_probe(host: String, api_key: String) -> Result<FoundPrinter, String> {
    let host = clean_host(&host)?;
    let mut problem = format!("No Moonraker answered at {host}");
    for address in [with_port(&host), host.clone()] {
        let link = Link::new(address.clone(), &api_key)?;
        match link.info().await {
            Ok(Some(info)) => {
                let model = info.hostname.filter(|h| !h.trim().is_empty()).unwrap_or_else(|| "Klipper printer".into());
                return Ok(FoundPrinter { ip: address, serial: String::new(), model });
            }
            Ok(None) => problem = format!("Moonraker answered at {address}, but Klipper isn't running there."),
            Err(Failure::Auth(m)) => return Err(m),
            Err(Failure::Network(_)) => {}
        }
    }
    Err(problem)
}

/// Scans the local /24 networks for Moonraker. One that wants an API key still
/// counts: the key is asked for when the printer is added.
#[tauri::command]
pub async fn klipper_scan() -> Vec<FoundPrinter> {
    scan_network(|ip| async move {
        let addr = SocketAddr::new(IpAddr::V4(ip), PORT);
        if !matches!(timeout(Duration::from_millis(700), TcpStream::connect(addr)).await, Ok(Ok(_))) {
            return None;
        }
        let address = addr.to_string();
        let link = Link::new(address.clone(), "").ok()?;
        let model = match link.info().await {
            Ok(Some(Info { hostname: Some(h) })) if !h.trim().is_empty() => h,
            Ok(_) | Err(Failure::Auth(_)) => "Klipper printer".into(),
            Err(Failure::Network(_)) => return None,
        };
        Some(FoundPrinter { ip: address, serial: String::new(), model })
    })
    .await
}

/// Starts (or restarts) polling one Klipper printer. Updates arrive as
/// `printer-status` events, like the other kinds.
#[tauri::command]
pub fn klipper_connect(app: AppHandle, printers: State<'_, Printers>, id: String, host: String, api_key: String) {
    printers.start(id.clone(), run(app, id, host, api_key));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn objects(v: Value) -> Objects {
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn file_names_go_in_queries() {
        assert_eq!(encode("tavern/Wall A+1.gcode"), "tavern/Wall%20A%2B1.gcode");
        let meta: Metadata = serde_json::from_value(json!({"filament_weight_total": 12.3, "size": 1})).unwrap();
        assert_eq!(meta.filament_weight_total, Some(12.3));
    }

    #[test]
    fn printing_reads_like_bambu() {
        let o = objects(json!({
            "print_stats": {
                "filename": "tavern/Wall_A_PLA_1h2m.gcode",
                "state": "printing",
                "print_duration": 600.0,
                "total_duration": 660.0,
                "info": {"current_layer": 12, "total_layer": 96}
            },
            "display_status": {"progress": 0.25},
            "virtual_sdcard": {"progress": 0.9},
            "extruder": {"temperature": 214.8, "target": 215.0},
            "heater_bed": {"temperature": 60.1, "target": 60.0},
            "webhooks": {"state": "ready"}
        }));
        let run = Run { id: Some("00002A".into()), filename: o.print_stats.filename.clone(), started: 1000, filament_g: Some(42.5), ..Default::default() };
        let r = report(&o, "RUNNING", Some(&run));
        assert_eq!(r["subtask_name"], "Wall_A_PLA_1h2m.gcode");
        assert_eq!(r["filament_g"], 42.5);
        assert_eq!(r["job_id"], "00002A");
        assert_eq!(r["gcode_start_time"], "1000");
        assert_eq!(r["mc_percent"], 25);
        assert_eq!(r["mc_remaining_time"], 30);
        assert_eq!(r["layer_num"], 12);
        assert_eq!(r["total_layer_num"], 96);
        assert_eq!(r["nozzle_target_temper"], 215.0);
        assert_eq!(r["bed_temper"], 60.1);
    }

    #[test]
    fn progress_falls_back_and_extras_are_optional() {
        let o = objects(json!({
            "print_stats": {"filename": "a.gcode", "state": "printing", "print_duration": 0.0, "info": {"current_layer": null, "total_layer": null}},
            "virtual_sdcard": {"progress": 0.5}
        }));
        let r = report(&o, "RUNNING", None);
        assert_eq!(r["mc_percent"], 50);
        assert!(r.get("mc_remaining_time").is_none());
        assert!(r["total_layer_num"].is_null());
        assert!(r["bed_temper"].is_null());
        assert!(r.get("subtask_name").is_none());
    }

    #[test]
    fn finished_print_keeps_its_name() {
        let o = objects(json!({"print_stats": {"filename": "Wall_A.gcode", "state": "complete"}}));
        let run = Run { id: Some("7".into()), filename: "Wall_A.gcode".into(), started: 1000, over: true, ..Default::default() };
        assert_eq!(report(&o, "FINISH", Some(&run))["subtask_name"], "Wall_A.gcode");
        assert!(report(&o, "IDLE", Some(&run)).get("subtask_name").is_none());
        assert!(report(&o, "RUNNING", Some(&run)).get("subtask_name").is_none());
    }

    #[test]
    fn prints_without_a_history_have_no_id() {
        let run = Run { id: None, filename: "a.gcode".into(), started: 5, over: false, ..Default::default() };
        let r = report(&Objects::default(), "RUNNING", Some(&run));
        assert!(r.get("job_id").is_none());
        assert_eq!(r["gcode_start_time"], "5");
    }

    #[test]
    fn states() {
        assert_eq!(gcode_state("ready", "printing", false), "RUNNING");
        assert_eq!(gcode_state("ready", "paused", true), "PAUSE");
        assert_eq!(gcode_state("ready", "complete", false), "FINISH");
        assert_eq!(gcode_state("ready", "cancelled", true), "FAILED");
        assert_eq!(gcode_state("ready", "error", true), "FAILED");
        assert_eq!(gcode_state("ready", "standby", false), "IDLE");
        assert_eq!(gcode_state("startup", "", false), "BUSY");
        assert_eq!(gcode_state("shutdown", "printing", true), "FAILED");
        assert_eq!(gcode_state("shutdown", "", false), "ERROR");
    }

    #[test]
    fn addresses() {
        assert_eq!(with_port("voron.local"), "voron.local:7125");
        assert_eq!(with_port("192.168.1.9:7130"), "192.168.1.9:7130");
        assert_eq!(basename("sub/dir/a.gcode"), "a.gcode");
        assert_eq!(basename("a.gcode"), "a.gcode");
    }

    #[test]
    fn camera_addresses() {
        assert_eq!(camera_url("pi:7125", "/webcam/?action=snapshot").unwrap(), "http://pi/webcam/?action=snapshot");
        assert_eq!(camera_url("pi:4408", "webcam/x").unwrap(), "http://pi:4408/webcam/x");
        assert_eq!(camera_url("pi:7125", "http://cam:8080/snap").unwrap(), "http://cam:8080/snap");
        assert_eq!(camera_url("pi:7125", " "), None);
    }

    #[test]
    fn speed_and_fan_read_like_bambu() {
        let o = objects(json!({"gcode_move": {"speed_factor": 1.5}, "fan": {"speed": 0.6}}));
        let r = report(&o, "IDLE", None);
        assert_eq!(r["spd_mag"], 150);
        assert_eq!(r["cooling_fan_speed"], "9");
    }

    /// Talks to a real Moonraker: `MOONRAKER_HOST=… [MOONRAKER_KEY=…]
    /// cargo test moonraker_live -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn moonraker_live() {
        let var = |k: &str| std::env::var(k).unwrap_or_default();
        let (host, key) = (var("MOONRAKER_HOST"), var("MOONRAKER_KEY"));
        tauri::async_runtime::block_on(async {
            let found = klipper_probe(host.clone(), key.clone()).await.unwrap();
            println!("probe: {} · {}", found.model, found.ip);
            let link = Link::new(found.ip, &key).unwrap();
            let (mut current, mut waited) = (None, 0);
            let polls = var("MOONRAKER_POLLS").parse().unwrap_or(3);
            for _ in 0..polls {
                match poll(&link, &mut current, &mut waited).await {
                    Ok(r) => println!("report: {r}"),
                    Err(f) => panic!("{}", f.message()),
                }
                tokio::time::sleep(POLL).await;
            }
        });
    }
}
