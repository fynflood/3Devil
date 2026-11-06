//! Live status from Prusa printers through PrusaLink, the HTTP API built into
//! the MK4/MK3.9/XL/MINI/Core One firmware (and Prusa Link on a Raspberry Pi
//! for the MK3S). PrusaLink can't push updates, so this polls
//! `/api/v1/status` and reshapes it into the report Bambu printers send, so the
//! rest of the app tracks both kinds the same way.

use crate::printer::{emit_status, FoundPrinter, Printers};
use reqwest::{header, Client, Response, StatusCode};
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, State};

const POLL: Duration = Duration::from_secs(3);

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
}

#[derive(Deserialize)]
struct Info {
    name: Option<String>,
    serial: Option<String>,
    hostname: Option<String>,
}

/// The print a printer is (or was last) running.
#[derive(Clone)]
struct Run {
    id: u64,
    name: String,
    /// Unix seconds, worked out once from the printer's elapsed time.
    started: i64,
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
            let name = info
                .and_then(|i| i.file)
                .map(|f| f.display_name.unwrap_or(f.name))
                .unwrap_or_default();
            *run = Some(Run { id, name, started: now() - job.time_printing.unwrap_or(0) });
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
        let run = Run { id: 7, name: "Wall_A_0.4n_0.2mm_PLA_MK4S_1h2m.bgcode".into(), started: 1000 };
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
    fn finished_print_keeps_its_name() {
        let run = Run { id: 7, name: "Wall_A.bgcode".into(), started: 1000 };
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
