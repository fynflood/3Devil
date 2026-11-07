//! Live status from Elegoo printers that speak SDCP 3: resin printers like the
//! Saturn 4 and Mars 5, and the Centauri Carbon. Each printer runs a WebSocket
//! server on port 3030 and answers discovery broadcasts on UDP port 3000. Like
//! the Prusa and Klipper connections, reports are reshaped into the ones Bambu
//! printers send, so the rest of the app tracks every kind the same way.

use crate::printer::{emit_status, FoundPrinter, Printers};
use crate::prusa::{clean_host, now};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::time::Duration;
use tauri::{AppHandle, State};
use tokio::net::{TcpStream, UdpSocket};
use tokio::time::{interval, sleep, timeout, Instant};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

const WS_PORT: u16 = 3030;
const DISCOVERY_PORT: u16 = 3000;
const POLL: Duration = Duration::from_secs(3);
/// The printer can be slow to answer; give up on a connection that's silent this long.
const SILENT: Duration = Duration::from_secs(30);

const CMD_STATUS: u32 = 0;
const CMD_VIDEO: u32 = 386;

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// A printer's answer to a discovery broadcast.
#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct Hello {
    data: HelloData,
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "PascalCase")]
struct HelloData {
    name: String,
    machine_name: String,
    #[serde(rename = "MainboardIP")]
    mainboard_ip: String,
    #[serde(rename = "MainboardID")]
    mainboard_id: String,
    protocol_version: String,
}

impl HelloData {
    fn found(self, fallback_ip: IpAddr) -> Result<FoundPrinter, String> {
        if self.protocol_version.starts_with("V1") {
            return Err(format!(
                "{} uses Elegoo's older SDCP 1 protocol, which 3Devil doesn't support yet.",
                self.model()
            ));
        }
        let ip = if self.mainboard_ip.is_empty() { fallback_ip.to_string() } else { self.mainboard_ip.clone() };
        Ok(FoundPrinter { model: self.model(), ip, serial: self.mainboard_id })
    }

    fn model(&self) -> String {
        [&self.machine_name, &self.name]
            .into_iter()
            .map(|n| n.trim())
            .find(|n| !n.is_empty())
            .unwrap_or("Elegoo printer")
            .to_string()
    }
}

/// Asks for discovery answers at `to` and collects them until `wait` passes.
async fn discover(to: Vec<SocketAddr>, wait: Duration, first_only: bool) -> Vec<(IpAddr, HelloData)> {
    let Ok(socket) = UdpSocket::bind("0.0.0.0:0").await else { return vec![] };
    let _ = socket.set_broadcast(true);
    for addr in to {
        let _ = socket.send_to(b"M99999", addr).await;
    }
    let mut found = Vec::new();
    let mut buf = vec![0; 8192];
    let end = Instant::now() + wait;
    while let Ok(Ok((n, from))) = tokio::time::timeout_at(end, socket.recv_from(&mut buf)).await {
        if let Ok(hello) = serde_json::from_slice::<Hello>(&buf[..n]) {
            found.push((from.ip(), hello.data));
            if first_only {
                break;
            }
        }
    }
    found
}

/// One SDCP request.
fn request(mainboard: &str, cmd: u32, data: Value) -> Message {
    let body = json!({
        "Id": "",
        "Data": {
            "Cmd": cmd,
            "Data": data,
            "RequestID": format!("{:032x}", rand_id()),
            "MainboardID": mainboard,
            "TimeStamp": now(),
            "From": 0,
        },
        "Topic": format!("sdcp/request/{mainboard}"),
    });
    Message::Text(body.to_string().into())
}

/// Request ids only have to differ from each other.
fn rand_id() -> u128 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNT: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    nanos ^ (COUNT.fetch_add(1, Ordering::Relaxed) as u128) << 96
}

async fn open(host: &str) -> Result<Socket, String> {
    let url = format!("ws://{host}:{WS_PORT}/websocket");
    match timeout(Duration::from_secs(5), tokio_tungstenite::connect_async(&url)).await {
        Ok(Ok((socket, _))) => Ok(socket),
        Ok(Err(e)) => Err(format!("Can't reach the printer at {host}: {e}")),
        Err(_) => Err(format!("Can't reach the printer at {host}: it didn't answer")),
    }
}

/// Reads messages until one passes `pick`, or `wait` runs out.
async fn wait_for<T>(socket: &mut Socket, wait: Duration, mut pick: impl FnMut(&Value) -> Option<T>) -> Result<T, String> {
    let end = Instant::now() + wait;
    loop {
        match tokio::time::timeout_at(end, socket.next()).await {
            Err(_) => return Err("The printer didn't answer in time.".into()),
            Ok(None) | Ok(Some(Err(_))) => return Err("The printer closed the connection.".into()),
            Ok(Some(Ok(Message::Text(text)))) => {
                if let Some(found) = serde_json::from_str::<Value>(&text).ok().as_ref().and_then(&mut pick) {
                    return Ok(found);
                }
            }
            Ok(Some(Ok(_))) => {}
        }
    }
}

/// The printer's status, in SDCP's own words. Fields one kind of printer
/// doesn't have are left out.
#[derive(Deserialize, Default)]
#[serde(default, rename_all = "PascalCase")]
struct Status {
    /// Usually a list of one, like `[1]`; some firmware sends a number.
    current_status: Value,
    print_info: PrintInfo,
    // Centauri Carbon.
    temp_of_nozzle: Option<f64>,
    temp_target_nozzle: Option<f64>,
    temp_of_hotbed: Option<f64>,
    temp_target_hotbed: Option<f64>,
    temp_of_box: Option<f64>,
    current_fan_speed: Option<Fans>,
    // Resin printers.
    temp_of_tank: Option<f64>,
    temp_target_tank: Option<f64>,
    heat_status: Option<i64>,
    #[serde(rename = "TempOfUVLED")]
    temp_of_uvled: Option<f64>,
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "PascalCase")]
struct PrintInfo {
    status: i64,
    current_layer: i64,
    total_layer: i64,
    /// Milliseconds on resin printers, seconds on the Centauri Carbon.
    current_ticks: f64,
    total_ticks: f64,
    filename: String,
    task_id: String,
    error_number: i64,
    /// Percent; only the Centauri Carbon sends it.
    progress: Option<f64>,
    print_speed_pct: Option<f64>,
}

/// Percent, 0 to 100.
#[derive(Deserialize, Default)]
#[serde(default, rename_all = "PascalCase")]
struct Fans {
    model_fan: Option<f64>,
    auxiliary_fan: Option<f64>,
    box_fan: Option<f64>,
}

impl Status {
    /// Resin printers have no nozzle.
    fn fdm(&self) -> bool {
        self.temp_of_nozzle.is_some()
    }

    fn machine_printing(&self) -> bool {
        match &self.current_status {
            Value::Array(list) => list.iter().any(|v| v.as_i64() == Some(1)),
            v => v.as_i64() == Some(1),
        }
    }

    fn seconds_per_tick(&self) -> f64 {
        if self.fdm() { 1.0 } else { 0.001 }
    }
}

/// Bambu `gcode_state` for the machine's and print's states. Resin printers
/// and the Centauri Carbon number their print states differently.
fn gcode_state(s: &Status) -> &'static str {
    let print = s.print_info.status;
    let printing = s.machine_printing();
    if s.print_info.error_number != 0 && print != 0 {
        return "FAILED";
    }
    match (s.fdm(), print) {
        (_, 5 | 6) | (true, 26) => "PAUSE",
        (_, 7 | 8) | (true, 14) => "FAILED",
        (_, 9) => "FINISH",
        _ if printing => "RUNNING",
        _ => "IDLE",
    }
}

/// The print a printer is (or was last) running.
struct Run {
    task: String,
    filename: String,
    /// Unix seconds.
    started: i64,
    /// The printer has reported how it ended.
    over: bool,
}

fn fan(percent: Option<f64>) -> Option<String> {
    percent.map(|p| ((p.clamp(0.0, 100.0) / 100.0 * 15.0).round() as i64).to_string())
}

/// The status as a Bambu-style `print` report.
fn report(s: &Status, state: &str, run: Option<&Run>) -> Value {
    let info = &s.print_info;
    let mut r = json!({ "gcode_state": state });
    let mut set = |key: &str, value: Option<Value>| {
        if let Some(v) = value {
            r[key] = v;
        }
    };
    set("nozzle_temper", s.temp_of_nozzle.map(Value::from));
    set("nozzle_target_temper", s.temp_target_nozzle.map(Value::from));
    set("bed_temper", s.temp_of_hotbed.map(Value::from));
    set("bed_target_temper", s.temp_target_hotbed.map(Value::from));
    set("chamber_temper", s.temp_of_box.map(Value::from));
    set("vat_temper", s.temp_of_tank.map(Value::from));
    // The target stays set while the printer is idle and not heating.
    let heating = s.heat_status == Some(1) && matches!(state, "RUNNING" | "PAUSE");
    set("vat_target_temper", s.temp_target_tank.filter(|_| heating).map(Value::from));
    set("uv_led_temper", s.temp_of_uvled.map(Value::from));
    if let Some(fans) = &s.current_fan_speed {
        set("cooling_fan_speed", fan(fans.model_fan).map(Value::from));
        set("big_fan1_speed", fan(fans.auxiliary_fan).map(Value::from));
        set("big_fan2_speed", fan(fans.box_fan).map(Value::from));
    }

    let active = matches!(state, "RUNNING" | "PAUSE");
    // Keep naming the last print while the printer shows how it ended.
    let run = run.filter(|run| (active && !run.over) || matches!(state, "FINISH" | "FAILED"));
    if let Some(run) = run {
        r["subtask_name"] = json!(run.filename);
        r["gcode_start_time"] = json!(run.started.to_string());
        if !run.task.is_empty() {
            r["job_id"] = json!(run.task);
        }
    }
    if active {
        let percent = info.progress.unwrap_or_else(|| {
            if info.total_layer > 0 { info.current_layer as f64 / info.total_layer as f64 * 100.0 } else { 0.0 }
        });
        r["mc_percent"] = json!(percent.clamp(0.0, 100.0).round() as i64);
        if info.total_ticks > info.current_ticks {
            let secs = (info.total_ticks - info.current_ticks) * s.seconds_per_tick();
            r["mc_remaining_time"] = json!((secs / 60.0).ceil() as i64);
        }
        if info.total_layer > 0 {
            r["layer_num"] = json!(info.current_layer);
            r["total_layer_num"] = json!(info.total_layer);
        }
        if let Some(speed) = info.print_speed_pct.filter(|_| s.fdm()) {
            r["spd_mag"] = json!(speed.round() as i64);
        }
    }
    r
}

/// Follows the print the status describes; returns the Bambu-style report.
fn track(s: &Status, run: &mut Option<Run>) -> Value {
    let state = gcode_state(s);
    let info = &s.print_info;
    let elapsed = (info.current_ticks * s.seconds_per_tick()) as i64;
    let same = |r: &Run| r.task == info.task_id && r.filename == info.filename;
    match state {
        "RUNNING" | "PAUSE" if !run.as_ref().is_some_and(|r| !r.over && same(r)) => {
            *run = Some(Run { task: info.task_id.clone(), filename: info.filename.clone(), started: now() - elapsed, over: false });
        }
        // It ended before 3Devil started; the task id ties it to a tracked print.
        "FINISH" | "FAILED" if !run.as_ref().is_some_and(same) && !info.filename.is_empty() => {
            *run = Some(Run { task: info.task_id.clone(), filename: info.filename.clone(), started: now() - elapsed, over: true });
        }
        _ => {}
    }
    let out = report(s, state, run.as_ref());
    if matches!(state, "FINISH" | "FAILED")
        && let Some(r) = run
    {
        r.over = true;
    }
    out
}

/// The status inside a printer's status message, if `msg` is one.
fn status_of(msg: &Value) -> Option<Status> {
    serde_json::from_value(msg.get("Status")?.clone()).ok()
}

/// Learns the mainboard id the printer wants in every request.
async fn mainboard_id(host: &str, saved: &str) -> Result<String, String> {
    if !saved.is_empty() {
        return Ok(saved.to_string());
    }
    let ip: IpAddr = tokio::net::lookup_host((host, DISCOVERY_PORT))
        .await
        .ok()
        .and_then(|mut a| a.next())
        .map(|a| a.ip())
        .ok_or_else(|| format!("Can't find {host} on the network"))?;
    discover(vec![SocketAddr::new(ip, DISCOVERY_PORT)], Duration::from_secs(3), true)
        .await
        .into_iter()
        .next()
        .map(|(_, d)| d.mainboard_id)
        .ok_or_else(|| format!("No Elegoo printer answered at {host}"))
}

/// One connection, until it fails.
async fn session(app: &AppHandle, id: &str, host: &str, mainboard: &str, run: &mut Option<Run>, last: &mut Value) -> String {
    let mut socket = match open(host).await {
        Ok(s) => s,
        Err(e) => return e,
    };
    let mut tick = interval(POLL);
    let mut heard = Instant::now();
    let mut last_log = String::new();
    loop {
        tokio::select! {
            _ = tick.tick() => {
                if heard.elapsed() > SILENT {
                    return "The printer stopped answering.".into();
                }
                if let Err(e) = socket.send(request(mainboard, CMD_STATUS, json!({}))).await {
                    return format!("Lost the connection to the printer: {e}");
                }
            }
            msg = socket.next() => match msg {
                Some(Ok(Message::Text(text))) => {
                    heard = Instant::now();
                    let Some(status) = serde_json::from_str::<Value>(&text).ok().as_ref().and_then(status_of) else { continue };
                    let report = track(&status, run);
                    let summary = format!(
                        "{} {}% {}",
                        report["gcode_state"].as_str().unwrap_or("?"),
                        report["mc_percent"],
                        report["subtask_name"].as_str().unwrap_or(""),
                    );
                    if summary != last_log {
                        println!("[elegoo {host}] {summary}");
                        last_log = summary;
                    }
                    emit_status(app, id, true, None, &report);
                    *last = report;
                }
                Some(Ok(_)) => heard = Instant::now(),
                Some(Err(e)) => return format!("Lost the connection to the printer: {e}"),
                None => return "The printer closed the connection.".into(),
            },
        }
    }
}

async fn run(app: AppHandle, id: String, host: String, saved_mainboard: String) {
    let host = match clean_host(&host) {
        Ok(h) => h,
        Err(e) => return emit_status(&app, &id, false, Some(e), &json!({})),
    };
    let mut current: Option<Run> = None;
    let mut last = json!({});
    let mut mainboard = saved_mainboard;
    loop {
        let problem = match mainboard_id(&host, &mainboard).await {
            Ok(m) => {
                mainboard = m;
                session(&app, &id, &host, &mainboard, &mut current, &mut last).await
            }
            Err(e) => e,
        };
        println!("[elegoo {host}] {problem}");
        emit_status(&app, &id, false, Some(problem), &last);
        sleep(Duration::from_secs(5)).await;
    }
}

/// Asks the printer at `host` who it is, so the details can be checked before saving.
#[tauri::command]
pub async fn elegoo_probe(host: String) -> Result<FoundPrinter, String> {
    let host = clean_host(&host)?;
    let ip: IpAddr = tokio::net::lookup_host((host.as_str(), DISCOVERY_PORT))
        .await
        .ok()
        .and_then(|mut a| a.next())
        .map(|a| a.ip())
        .ok_or_else(|| format!("Can't find {host} on the network"))?;
    let (from, hello) = discover(vec![SocketAddr::new(ip, DISCOVERY_PORT)], Duration::from_secs(3), true)
        .await
        .into_iter()
        .next()
        .ok_or_else(|| format!("No Elegoo printer answered at {host}. Check it's on and connected to your network."))?;
    let mut found = hello.found(from)?;
    // Keep a host name the user typed; it survives the printer's address changing.
    if host.parse::<IpAddr>().is_err() {
        found.ip = host;
    }
    Ok(found)
}

/// Sends a discovery request across every local /24 network. It's broadcast,
/// and also sent to each address, as some printers ignore broadcasts.
#[tauri::command]
pub async fn elegoo_scan() -> Vec<FoundPrinter> {
    let mut to = vec![SocketAddr::new(IpAddr::V4(Ipv4Addr::BROADCAST), DISCOVERY_PORT)];
    for iface in if_addrs::get_if_addrs().unwrap_or_default() {
        if let if_addrs::IfAddr::V4(v4) = &iface.addr
            && !iface.is_loopback()
        {
            if let Some(broadcast) = v4.broadcast {
                to.push(SocketAddr::new(IpAddr::V4(broadcast), DISCOVERY_PORT));
            }
            let [a, b, c, _] = v4.ip.octets();
            to.extend((1..=254).map(|d| SocketAddr::new(IpAddr::V4(Ipv4Addr::new(a, b, c, d)), DISCOVERY_PORT)));
        }
    }
    let mut found: HashMap<String, FoundPrinter> = HashMap::new();
    for (from, hello) in discover(to, Duration::from_secs(2), false).await {
        if let Ok(p) = hello.found(from) {
            found.entry(p.serial.clone()).or_insert(p);
        }
    }
    found.into_values().collect()
}

/// Starts (or restarts) following one Elegoo printer. Updates arrive as
/// `printer-status` events, like the other kinds.
#[tauri::command]
pub fn elegoo_connect(app: AppHandle, printers: State<'_, Printers>, id: String, host: String, mainboard: String) {
    printers.start(id.clone(), run(app, id, host, mainboard));
}

/// Turns on the printer's camera and returns where it streams.
pub(crate) async fn video_url(host: &str, mainboard: &str) -> Result<String, String> {
    let host = clean_host(host)?;
    let mainboard = mainboard_id(&host, mainboard).await?;
    let mut socket = open(&host).await?;
    socket
        .send(request(&mainboard, CMD_VIDEO, json!({ "Enable": 1 })))
        .await
        .map_err(|e| e.to_string())?;
    let data = wait_for(&mut socket, Duration::from_secs(10), |msg| {
        let data = msg.get("Data")?;
        (data.get("Cmd")?.as_u64()? == CMD_VIDEO as u64).then(|| data.get("Data").cloned().unwrap_or_default())
    })
    .await?;
    let _ = socket.close(None).await;
    match data.get("Ack").and_then(Value::as_i64) {
        Some(0) => {}
        Some(1) => {
            return Err("The printer is already streaming to as many viewers as it allows. Close its camera elsewhere, or restart the printer, then try again.".into());
        }
        Some(2) => return Err("This printer has no camera.".into()),
        _ => return Err("The printer couldn't start its camera.".into()),
    }
    let url = data.get("VideoUrl").and_then(Value::as_str).unwrap_or("").trim().to_string();
    Ok(match url {
        u if u.is_empty() => format!("http://{host}:3031/video"),
        u if u.contains("://") => u,
        u => format!("http://{u}"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn status(v: Value) -> Status {
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn resin_print_reads_like_bambu() {
        let s = status(json!({
            "CurrentStatus": [1],
            "TempOfUVLED": 31.5,
            "HeatStatus": 1,
            "TempOfTank": 29.0,
            "TempTargetTank": 30.0,
            "PrintInfo": {
                "Status": 3, "CurrentLayer": 250, "TotalLayer": 1000,
                "CurrentTicks": 1_800_000, "TotalTicks": 7_200_000,
                "Filename": "Wall_A.ctb", "TaskId": "abc", "ErrorNumber": 0
            }
        }));
        assert_eq!(gcode_state(&s), "RUNNING");
        let mut run = None;
        let r = track(&s, &mut run);
        assert_eq!(r["subtask_name"], "Wall_A.ctb");
        assert_eq!(r["job_id"], "abc");
        assert_eq!(r["mc_percent"], 25);
        assert_eq!(r["mc_remaining_time"], 90);
        assert_eq!(r["layer_num"], 250);
        assert_eq!(r["vat_temper"], 29.0);
        assert_eq!(r["vat_target_temper"], 30.0);
        assert_eq!(r["uv_led_temper"], 31.5);
        assert!(r.get("nozzle_temper").is_none());
        assert!(r.get("spd_mag").is_none());
        let started: i64 = r["gcode_start_time"].as_str().unwrap().parse().unwrap();
        assert!((now() - 1800 - started).abs() <= 1);
    }

    #[test]
    fn idle_resin_printer_as_seen_on_a_saturn_4_ultra() {
        let s = status(json!({
            "CurrentStatus": [0], "PrintScreen": 0, "ReleaseFilm": 0, "TempOfUVLED": 11.95, "TimeLapseStatus": 1,
            "HeatStatus": 1, "TempOfTank": 11, "TempTargetTank": 30,
            "PrintInfo": {"Status": 0, "CurrentLayer": 0, "TotalLayer": 0, "CurrentTicks": 0, "TotalTicks": 0, "ErrorNumber": 0, "Filename": "", "TaskId": ""}
        }));
        let mut run = None;
        let r = track(&s, &mut run);
        assert_eq!(r["gcode_state"], "IDLE");
        assert!(r.get("vat_target_temper").is_none());
        assert!(r.get("subtask_name").is_none());
        assert!(run.is_none());
    }

    #[test]
    fn resin_states() {
        let with = |machine: i64, print: i64, error: i64| {
            gcode_state(&status(json!({"CurrentStatus": [machine], "PrintInfo": {"Status": print, "ErrorNumber": error}})))
        };
        assert_eq!(with(1, 1, 0), "RUNNING");
        assert_eq!(with(1, 4, 0), "RUNNING");
        assert_eq!(with(1, 6, 0), "PAUSE");
        assert_eq!(with(1, 7, 0), "FAILED");
        assert_eq!(with(0, 8, 0), "FAILED");
        assert_eq!(with(0, 9, 0), "FINISH");
        assert_eq!(with(1, 3, 2), "FAILED");
        assert_eq!(with(0, 0, 0), "IDLE");
        assert_eq!(gcode_state(&status(json!({"CurrentStatus": 1, "PrintInfo": {"Status": 3}}))), "RUNNING");
    }

    #[test]
    fn centauri_carbon_reads_like_bambu() {
        let s = status(json!({
            "CurrentStatus": [1],
            "TempOfNozzle": 219.6, "TempTargetNozzle": 220, "TempOfHotbed": 60, "TempTargetHotbed": 60, "TempOfBox": 31,
            "CurrentFanSpeed": {"ModelFan": 100, "AuxiliaryFan": 40, "BoxFan": 0},
            "PrintInfo": {"Status": 13, "CurrentLayer": 10, "TotalLayer": 200, "CurrentTicks": 600, "TotalTicks": 3600,
                          "Progress": 12, "PrintSpeedPct": 100, "Filename": "Wall_A.gcode", "TaskId": "t1"}
        }));
        let r = track(&s, &mut None);
        assert_eq!(r["gcode_state"], "RUNNING");
        assert_eq!(r["mc_percent"], 12);
        assert_eq!(r["mc_remaining_time"], 50);
        assert_eq!(r["nozzle_target_temper"], 220.0);
        assert_eq!(r["chamber_temper"], 31.0);
        assert_eq!(r["cooling_fan_speed"], "15");
        assert_eq!(r["big_fan1_speed"], "6");
        assert_eq!(r["spd_mag"], 100);
        assert_eq!(gcode_state(&status(json!({"TempOfNozzle": 20, "CurrentStatus": [1], "PrintInfo": {"Status": 14}}))), "FAILED");
        assert_eq!(gcode_state(&status(json!({"TempOfNozzle": 20, "CurrentStatus": [1], "PrintInfo": {"Status": 26}}))), "PAUSE");
        assert_eq!(gcode_state(&status(json!({"TempOfNozzle": 20, "CurrentStatus": [1], "PrintInfo": {"Status": 16}}))), "RUNNING");
    }

    #[test]
    fn finished_print_keeps_its_name_until_the_next() {
        let printing = status(json!({"CurrentStatus": [1], "PrintInfo": {"Status": 3, "Filename": "a.ctb", "TaskId": "1"}}));
        let done = status(json!({"CurrentStatus": [0], "PrintInfo": {"Status": 9, "Filename": "a.ctb", "TaskId": "1"}}));
        let mut run = None;
        track(&printing, &mut run);
        let started = run.as_ref().unwrap().started;
        let r = track(&done, &mut run);
        assert_eq!(r["subtask_name"], "a.ctb");
        assert_eq!(run.as_ref().unwrap().started, started);
        assert!(run.as_ref().unwrap().over);
        let next = status(json!({"CurrentStatus": [1], "PrintInfo": {"Status": 1, "Filename": "a.ctb", "TaskId": "2"}}));
        track(&next, &mut run);
        assert_eq!(run.as_ref().unwrap().task, "2");
        assert!(!run.as_ref().unwrap().over);
    }

    #[test]
    fn a_print_that_ended_before_3devil_started_is_named() {
        let done = status(json!({"CurrentStatus": [0], "PrintInfo": {"Status": 9, "Filename": "a.ctb", "TaskId": "7", "CurrentTicks": 60000}}));
        let mut run = None;
        let r = track(&done, &mut run);
        assert_eq!(r["subtask_name"], "a.ctb");
        assert_eq!(r["job_id"], "7");
    }

    #[test]
    fn discovery_answers() {
        let hello: Hello = serde_json::from_str(r#"{"Id":"f2","Data":{"Name":"Saturn 4 Ultra ","MachineName":"Saturn 4 Ultra 16K","BrandName":"ELEGOO","MainboardIP":"192.168.2.115","MainboardID":"b4f0","ProtocolVersion":"V3.0.0","FirmwareVersion":"V1.4.8"}}"#).unwrap();
        let p = hello.data.found("10.0.0.1".parse().unwrap()).unwrap();
        assert_eq!(p.model, "Saturn 4 Ultra 16K");
        assert_eq!(p.ip, "192.168.2.115");
        assert_eq!(p.serial, "b4f0");
        let old = HelloData { name: "Mars 4".into(), protocol_version: "V1.0.0".into(), ..Default::default() };
        assert!(old.found("10.0.0.1".parse().unwrap()).err().unwrap().contains("SDCP 1"));
    }

    #[test]
    fn requests_carry_the_mainboard() {
        let Message::Text(text) = request("b4f0", CMD_STATUS, json!({})) else { panic!() };
        let v: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(v["Topic"], "sdcp/request/b4f0");
        assert_eq!(v["Data"]["MainboardID"], "b4f0");
        assert_eq!(v["Data"]["Cmd"], 0);
        assert_eq!(v["Data"]["RequestID"].as_str().unwrap().len(), 32);
    }

    /// Talks to a real printer: `ELEGOO_HOST=… cargo test elegoo_live -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn elegoo_live() {
        let host = std::env::var("ELEGOO_HOST").unwrap();
        tauri::async_runtime::block_on(async {
            println!("scan: {:?}", elegoo_scan().await.iter().map(|p| format!("{} {} {}", p.model, p.ip, p.serial)).collect::<Vec<_>>());
            let found = elegoo_probe(host.clone()).await.unwrap();
            println!("probe: {} · {} · {}", found.model, found.ip, found.serial);
            let mut socket = open(&found.ip).await.unwrap();
            socket.send(request(&found.serial, CMD_STATUS, json!({}))).await.unwrap();
            let status = wait_for(&mut socket, Duration::from_secs(20), status_of).await.unwrap();
            println!("report: {}", track(&status, &mut None));
        });
    }
}
