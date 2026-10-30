//! DriveThruRPG library access via the (undocumented) API used by their
//! library app. Endpoints and flow follow the MIT-licensed `drpg` project:
//! https://github.com/glujan/drpg

use futures_util::StreamExt;
use reqwest::{Client, StatusCode};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, State};
use tokio::io::AsyncWriteExt;

const API: &str = "https://api.drivethrurpg.com/api/vBeta/";
const SITE_ID: &str = "10";

/// Access token for the current Library App Key, reused between calls.
#[derive(Default)]
pub struct DriveThru(Mutex<Option<(String, String)>>);

#[derive(Deserialize)]
struct TokenResponse {
    token: String,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Publisher {
    #[serde(default)]
    name: String,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DownloadItem {
    index: i64,
    filename: String,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Product {
    #[serde(deserialize_with = "string_or_number")]
    product_id: String,
    order_product_id: i64,
    name: String,
    #[serde(default)]
    publisher: Option<Publisher>,
    #[serde(default)]
    file_last_modified: Option<String>,
    #[serde(default)]
    files: Vec<DownloadItem>,
}

fn string_or_number<'de, D: serde::Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    Ok(match serde_json::Value::deserialize(d)? {
        serde_json::Value::String(s) => s,
        other => other.to_string(),
    })
}

#[derive(Deserialize)]
struct PrepareResponse {
    url: String,
    status: String,
}

fn client() -> Result<Client, String> {
    Client::builder()
        .timeout(Duration::from_secs(60 * 30))
        .connect_timeout(Duration::from_secs(20))
        .user_agent("Mozilla/5.0")
        .build()
        .map_err(|e| e.to_string())
}

async fn authenticate(http: &Client, key: &str) -> Result<String, String> {
    let resp = http
        .post(format!("{API}auth_key"))
        .query(&[("applicationKey", key)])
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("Can't reach DriveThruRPG: {e}"))?;
    // An invalid key currently gets a non-standard 496; treat any 4xx as rejection.
    if resp.status().is_client_error() {
        return Err("DriveThruRPG rejected the Library App Key. Generate a new one in your account settings.".into());
    }
    if !resp.status().is_success() {
        return Err(format!("DriveThruRPG sign-in failed (HTTP {})", resp.status()));
    }
    Ok(resp.json::<TokenResponse>().await.map_err(|e| e.to_string())?.token)
}

/// Returns a cached access token for `key`, signing in if needed.
async fn token(state: &DriveThru, http: &Client, key: &str, fresh: bool) -> Result<String, String> {
    if !fresh {
        if let Some((k, t)) = state.0.lock().unwrap().as_ref() {
            if k == key {
                return Ok(t.clone());
            }
        }
    }
    let t = authenticate(http, key).await?;
    *state.0.lock().unwrap() = Some((key.to_string(), t.clone()));
    Ok(t)
}

/// GET an API path as JSON, signing in again once if the token has expired.
async fn get_json<T: for<'de> Deserialize<'de>>(
    state: &DriveThru,
    http: &Client,
    key: &str,
    path: &str,
    query: &[(&str, String)],
) -> Result<T, String> {
    for attempt in 0..2 {
        let t = token(state, http, key, attempt > 0).await?;
        let resp = http
            .get(format!("{API}{path}"))
            .query(query)
            .header("Authorization", t)
            .header("Accept", "application/json")
            .send()
            .await
            .map_err(|e| format!("Can't reach DriveThruRPG: {e}"))?;
        if resp.status() == StatusCode::UNAUTHORIZED && attempt == 0 {
            continue;
        }
        if !resp.status().is_success() {
            return Err(format!("DriveThruRPG request failed (HTTP {})", resp.status()));
        }
        return resp.json::<T>().await.map_err(|e| format!("Unexpected reply from DriveThruRPG: {e}"));
    }
    unreachable!()
}

/// Lists every product in the user's (non-archived) library.
#[tauri::command]
pub async fn drivethru_library(state: State<'_, DriveThru>, key: String) -> Result<Vec<Product>, String> {
    let http = client()?;
    let mut all = Vec::new();
    for page in 1.. {
        let batch: Vec<Product> = get_json(
            &state,
            &http,
            &key,
            "order_products",
            &[
                ("getChecksum", "0".into()),
                ("getFilters", "0".into()),
                ("page", page.to_string()),
                ("pageSize", "100".into()),
                ("library", "1".into()),
                ("archived", "0".into()),
            ],
        )
        .await?;
        if batch.is_empty() {
            break;
        }
        all.extend(batch);
    }
    Ok(all)
}

/// Makes a name safe as a single path component on every OS.
pub fn safe_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if "<>:\"/\\|?*".contains(c) || c.is_control() { ' ' } else { c })
        .collect();
    let collapsed = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed = collapsed.trim_matches(|c| c == '.' || c == ' ');
    if trimmed.is_empty() { "Untitled".into() } else { trimmed.to_string() }
}

/// Folder a product downloads into: `<library>/<publisher>/<product>`.
#[tauri::command]
pub fn drivethru_product_dir(library_path: String, publisher: String, name: String) -> String {
    let publisher = if publisher.trim().is_empty() { "Others".to_string() } else { publisher };
    PathBuf::from(library_path)
        .join(safe_name(&publisher))
        .join(safe_name(&name))
        .to_string_lossy()
        .to_string()
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Progress<'a> {
    order_product_id: i64,
    file: &'a str,
    file_index: usize,
    file_count: usize,
    received: u64,
    total: Option<u64>,
}

#[derive(Serialize, Default)]
pub struct DownloadReport {
    downloaded: Vec<String>,
    skipped: Vec<String>,
}

fn up_to_date(path: &Path, remote_modified_ms: Option<i64>) -> bool {
    let Ok(meta) = std::fs::metadata(path) else { return false };
    let Some(remote) = remote_modified_ms else { return true };
    let local_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    local_ms >= remote
}

/// Downloads a product's files into `dest_dir`, skipping files already on
/// disk that are at least as new as the product's last update. Progress is
/// reported through `drivethru-progress` events.
#[tauri::command]
pub async fn drivethru_download(
    app: AppHandle,
    state: State<'_, DriveThru>,
    key: String,
    order_product_id: i64,
    files: Vec<DownloadItem>,
    dest_dir: String,
    remote_modified_ms: Option<i64>,
) -> Result<DownloadReport, String> {
    let http = client()?;
    let dest = PathBuf::from(&dest_dir);
    tokio::fs::create_dir_all(&dest).await.map_err(|e| e.to_string())?;
    let mut report = DownloadReport::default();
    let count = files.len();

    for (i, item) in files.iter().enumerate() {
        let name = safe_name(Path::new(&item.filename).file_name().map(|s| s.to_string_lossy()).as_deref().unwrap_or("file"));
        let target = dest.join(&name);
        if up_to_date(&target, remote_modified_ms) {
            report.skipped.push(name);
            continue;
        }

        // Ask the server to prepare a download link, polling while it works.
        let query = [("siteId", SITE_ID.to_string()), ("index", item.index.to_string()), ("getChecksums", "0".into())];
        let mut prep: PrepareResponse =
            get_json(&state, &http, &key, &format!("order_products/{order_product_id}/prepare"), &query).await?;
        let started = SystemTime::now();
        while prep.status.starts_with("Preparing") {
            if started.elapsed().unwrap_or_default() > Duration::from_secs(600) {
                return Err(format!("DriveThruRPG took too long to prepare {name}"));
            }
            tokio::time::sleep(Duration::from_secs(2)).await;
            prep = get_json(&state, &http, &key, &format!("order_products/{order_product_id}/check"), &query).await?;
        }

        let resp = http.get(&prep.url).send().await.map_err(|e| format!("{name}: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("{name}: download failed (HTTP {})", resp.status()));
        }
        let total = resp.content_length();
        let part = dest.join(format!("{name}.part"));
        let mut file = tokio::fs::File::create(&part).await.map_err(|e| e.to_string())?;
        let mut stream = resp.bytes_stream();
        let mut received = 0u64;
        let mut last_emit = 0u64;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| format!("{name}: {e}"))?;
            file.write_all(&chunk).await.map_err(|e| e.to_string())?;
            received += chunk.len() as u64;
            if received - last_emit > 512 * 1024 || Some(received) == total {
                last_emit = received;
                let _ = app.emit(
                    "drivethru-progress",
                    Progress { order_product_id, file: &name, file_index: i, file_count: count, received, total },
                );
            }
        }
        file.flush().await.map_err(|e| e.to_string())?;
        drop(file);
        tokio::fs::rename(&part, &target).await.map_err(|e| e.to_string())?;
        report.downloaded.push(name);
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_names() {
        assert_eq!(safe_name("Game Designers' Workshop (GDW)"), "Game Designers' Workshop (GDW)");
        assert_eq!(safe_name("Castle: Walls / Towers?"), "Castle Walls Towers");
        assert_eq!(safe_name("..."), "Untitled");
    }

    #[test]
    fn parses_product_with_numeric_id() {
        let p: Product = serde_json::from_str(
            r#"{"productId": 12345, "orderProductId": 9, "name": "Tavern", "publisher": {"name": "Dragon Workshop"},
                "fileLastModified": "2026-09-30T10:00:00+00:00", "files": [{"index": 0, "filename": "a.zip", "checksums": []}]}"#,
        )
        .unwrap();
        assert_eq!(p.product_id, "12345");
        assert_eq!(p.files[0].filename, "a.zip");
    }
}
