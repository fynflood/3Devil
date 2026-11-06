//! MyMiniFactory through its official API. Signing in happens in the browser,
//! on their own page; the token it gives back stays here on the Rust side and
//! is kept in a private file, apart from the projects, which can be shared.
//! The API can't list purchases, so what's offered is a person's likes and
//! collections, plus any model they paste a link to.

use crate::drivethru::{safe_name, Progress};
use futures_util::StreamExt;
use reqwest::{Client, StatusCode};
use serde::Serialize;
use serde_json::Value;
use std::collections::hash_map::RandomState;
use std::collections::HashSet;
use std::hash::{BuildHasher, Hasher};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_opener::OpenerExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Notify;

const API: &str = "https://www.myminifactory.com/api/v2";
const AUTHORIZE: &str = "https://auth.myminifactory.com/web/authorize";
const CLIENT_ID: &str = "threedevil";
/// Registered with MyMiniFactory, so it can't change on its own.
const PORT: u16 = 47823;
const SIGN_IN_WAIT: Duration = Duration::from_secs(5 * 60);
const SESSION_FILE: &str = "myminifactory-session.json";
const EXPIRED: &str = "Your MyMiniFactory sign-in has expired. Sign in again.";
const PER_PAGE: u64 = 100;
/// Models checked one by one for ownership in a single load.
const MAX_CHECKS: usize = 60;

/// The address MyMiniFactory sends the browser back to. The token comes after
/// the `#`, which browsers don't send, so this page passes it on.
const CALLBACK_PAGE: &str = r#"<!doctype html><meta charset="utf-8"><title>3Devil</title>
<body style="font-family:sans-serif;padding:40px"><p id="m">Finishing sign-in…</p><script>
const p = new URLSearchParams(location.hash.slice(1) + "&" + location.search.slice(1));
history.replaceState(null, "", "/callback");
fetch("/token", { method: "POST", body: JSON.stringify(Object.fromEntries(p)) })
  .then((r) => r.text()).then((t) => { document.getElementById("m").textContent = t; });
</script>"#;

#[derive(Default)]
pub struct MyMiniFactory {
    cancel: Notify,
}

#[derive(Serialize, serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Session {
    access_token: String,
    username: String,
    /// Seconds since 1970.
    expires_at: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    username: String,
    expires_at: u64,
}

impl From<&Session> for Account {
    fn from(s: &Session) -> Self {
        Self { username: s.username.clone(), expires_at: s.expires_at }
    }
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Model {
    id: i64,
    name: String,
    url: String,
    designer: Option<String>,
    /// As shown on the store, like `£3.99`. None for a free model.
    price: Option<String>,
    /// Whether this account owns it, when MyMiniFactory says.
    bought: Option<bool>,
}

#[derive(Serialize)]
pub struct Collection {
    name: String,
    models: Vec<Model>,
}

#[derive(Serialize)]
pub struct Library {
    likes: Vec<Model>,
    collections: Vec<Collection>,
}

#[derive(Serialize, Default)]
pub struct DownloadReport {
    downloaded: Vec<String>,
    skipped: Vec<String>,
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn session_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join(SESSION_FILE))
}

fn load_session(app: &AppHandle) -> Option<Session> {
    let path = session_path(app).ok()?;
    let session: Session = serde_json::from_slice(&std::fs::read(&path).ok()?).ok()?;
    if session.expires_at <= now() {
        let _ = std::fs::remove_file(&path);
        return None;
    }
    Some(session)
}

/// Writes the session readable by this user alone.
fn save_session(path: &Path, session: &Session) -> Result<(), String> {
    use std::io::Write;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let scratch = path.with_extension("json.part");
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let mut file = options.open(&scratch).map_err(|e| e.to_string())?;
    file.write_all(&serde_json::to_vec(session).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    drop(file);
    std::fs::rename(&scratch, path).map_err(|e| e.to_string())
}

fn client() -> Result<Client, String> {
    Client::builder()
        .timeout(Duration::from_secs(60 * 30))
        .connect_timeout(Duration::from_secs(20))
        .user_agent("3Devil")
        .build()
        .map_err(|e| e.to_string())
}

/// Hard to guess, which is all the sign-in's `state` needs.
fn random_state() -> String {
    let word = || RandomState::new().build_hasher().finish();
    format!("{:016x}{:016x}", word(), word() ^ now())
}

fn sign_in_url(state: &str) -> String {
    let redirect = format!("http://127.0.0.1:{PORT}/callback");
    let query: Vec<_> = [("client_id", CLIENT_ID), ("redirect_uri", &redirect), ("response_type", "token"), ("state", state)]
        .iter()
        .map(|(k, v)| format!("{k}={}", encode(v)))
        .collect();
    format!("{AUTHORIZE}?{}", query.join("&"))
}

fn encode(text: &str) -> String {
    text.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// The method, path and body of a whole HTTP request, or None if it's unfinished.
fn parse_request(data: &[u8]) -> Option<(String, String, Vec<u8>)> {
    let end = data.windows(4).position(|w| w == b"\r\n\r\n")?;
    let head = std::str::from_utf8(&data[..end]).ok()?;
    let mut lines = head.split("\r\n");
    let mut first = lines.next()?.split(' ');
    let (method, path) = (first.next()?.to_string(), first.next()?.to_string());
    let length = lines
        .filter_map(|l| l.split_once(':'))
        .find(|(k, _)| k.eq_ignore_ascii_case("content-length"))
        .and_then(|(_, v)| v.trim().parse::<usize>().ok())
        .unwrap_or(0);
    let body = data.get(end + 4..end + 4 + length)?.to_vec();
    Some((method, path, body))
}

async fn read_request(stream: &mut TcpStream) -> Option<(String, String, Vec<u8>)> {
    let mut data = Vec::new();
    let mut buf = [0; 4096];
    while data.len() < 64 * 1024 {
        if let Some(request) = parse_request(&data) {
            return Some(request);
        }
        let n = tokio::time::timeout(Duration::from_secs(5), stream.read(&mut buf)).await.ok()?.ok()?;
        if n == 0 {
            return None;
        }
        data.extend_from_slice(&buf[..n]);
    }
    None
}

async fn respond(stream: &mut TcpStream, status: &str, kind: &str, body: &str) {
    let head = format!("HTTP/1.1 {status}\r\nContent-Type: {kind}; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
    let _ = stream.write_all(head.as_bytes()).await;
    let _ = stream.write_all(body.as_bytes()).await;
    let _ = stream.shutdown().await;
}

/// What the callback page reported: a token, or why there isn't one. A wrong
/// `state` didn't come from this sign-in, so it's ignored.
fn read_callback(body: &[u8], state: &str) -> Option<Result<(String, u64), String>> {
    let v: Value = serde_json::from_slice(body).ok()?;
    if v["state"].as_str() != Some(state) {
        return None;
    }
    if let Some(token) = v["access_token"].as_str().filter(|t| !t.is_empty()) {
        let expires = v["expires_in"].as_str().and_then(|s| s.parse().ok()).unwrap_or(3600);
        return Some(Ok((token.to_string(), expires)));
    }
    let reason = v["error_description"].as_str().or(v["error"].as_str()).unwrap_or("MyMiniFactory didn't sign you in.");
    Some(Err(reason.to_string()))
}

/// Serves the callback page until the token arrives.
async fn wait_for_token(listener: TcpListener, state: &str) -> Result<(String, u64), String> {
    loop {
        let (mut stream, _) = listener.accept().await.map_err(|e| e.to_string())?;
        let Some((method, path, body)) = read_request(&mut stream).await else { continue };
        match (method.as_str(), path.split('?').next().unwrap_or("")) {
            ("GET", "/callback") => respond(&mut stream, "200 OK", "text/html", CALLBACK_PAGE).await,
            ("POST", "/token") => match read_callback(&body, state) {
                Some(Ok(token)) => {
                    respond(&mut stream, "200 OK", "text/plain", "Signed in. You can close this tab and go back to 3Devil.").await;
                    return Ok(token);
                }
                Some(Err(reason)) => {
                    respond(&mut stream, "400 Bad Request", "text/plain", "That didn't work. You can close this tab and go back to 3Devil.").await;
                    return Err(reason);
                }
                None => respond(&mut stream, "400 Bad Request", "text/plain", "That didn't match this sign-in. Try again from 3Devil.").await,
            },
            _ => respond(&mut stream, "404 Not Found", "text/plain", "Not found").await,
        }
    }
}

fn text(v: &Value, key: &str) -> Option<String> {
    v[key].as_str().map(str::trim).filter(|s| !s.is_empty()).map(String::from)
}

fn to_model(v: &Value) -> Option<Model> {
    let designer = &v["designer"];
    let price = text(&v["price"], "value").filter(|p| p.parse::<f64>().map_or(true, |n| n > 0.0));
    Some(Model {
        id: v["id"].as_i64()?,
        name: text(v, "name")?,
        url: text(v, "url").unwrap_or_default(),
        designer: text(designer, "name").or_else(|| text(designer, "username")),
        price: price.map(|p| format!("{}{p}", v["price"]["symbol"].as_str().unwrap_or(""))),
        bought: v["is_bought"].as_bool(),
    })
}

fn to_models(items: &Value) -> Vec<Model> {
    items.as_array().map(|a| a.iter().filter_map(to_model).collect()).unwrap_or_default()
}

/// Lists sometimes wrap their entries in `items`.
fn items(v: &Value) -> &Value {
    if v["items"].is_array() { &v["items"] } else { v }
}

/// The model's id in a store link like `/object/3d-print-zombie-tyrant-187611`, or a bare id.
fn object_id(link: &str) -> Option<i64> {
    let link = link.trim();
    if let Ok(id) = link.parse() {
        return Some(id);
    }
    let rest = link.strip_prefix("https://").or_else(|| link.strip_prefix("http://")).unwrap_or(link);
    let (host, path) = rest.split_once('/')?;
    if host != "myminifactory.com" && !host.ends_with(".myminifactory.com") {
        return None;
    }
    let path = path.split(['?', '#']).next()?.trim_end_matches('/');
    path.rsplit(['-', '/']).next()?.parse().ok()
}

/// A file's name on disk: never a path, and unique among the model's files.
fn file_name(given: &str, id: i64, used: &mut HashSet<String>) -> String {
    let name = safe_name(given.rsplit(['/', '\\']).next().unwrap_or(given));
    if used.insert(name.to_lowercase()) {
        return name;
    }
    let (stem, ext) = name.rsplit_once('.').unwrap_or((&name, ""));
    let unique = if ext.is_empty() { format!("{stem}-{id}") } else { format!("{stem}-{id}.{ext}") };
    used.insert(unique.to_lowercase());
    unique
}

fn file_size(v: &Value) -> Option<u64> {
    v.as_u64().or_else(|| v.as_str()?.parse().ok())
}

/// A model's files that came with download links, and their names on disk.
fn downloads(object: &Value) -> Vec<(String, String, Option<u64>)> {
    let mut used = HashSet::new();
    items(&object["files"])
        .as_array()
        .map(|files| {
            files
                .iter()
                .filter_map(|f| {
                    let url = text(f, "download_url")?;
                    let name = file_name(f["filename"].as_str().unwrap_or("file"), f["id"].as_i64().unwrap_or(0), &mut used);
                    Some((url, name, file_size(&f["size"])))
                })
                .collect()
        })
        .unwrap_or_default()
}

async fn get(app: &AppHandle, http: &Client, session: &Session, path: &str, query: &[(&str, String)]) -> Result<Value, String> {
    let resp = http
        .get(format!("{API}/{path}"))
        .query(query)
        .bearer_auth(&session.access_token)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("Can't reach MyMiniFactory: {}", e.without_url()))?;
    if resp.status() == StatusCode::UNAUTHORIZED {
        if let Ok(path) = session_path(app) {
            let _ = std::fs::remove_file(path);
        }
        return Err(EXPIRED.into());
    }
    if resp.status() == StatusCode::NOT_FOUND {
        return Err("MyMiniFactory doesn't have that model.".into());
    }
    if !resp.status().is_success() {
        return Err(format!("MyMiniFactory answered with an error (HTTP {}).", resp.status().as_u16()));
    }
    resp.json().await.map_err(|_| "MyMiniFactory sent something 3Devil couldn't read.".to_string())
}

fn signed_in(app: &AppHandle) -> Result<Session, String> {
    load_session(app).ok_or_else(|| EXPIRED.to_string())
}

/// Lists don't always say who owns what, so ask about the ones that don't.
async fn fill_ownership(app: &AppHandle, http: &Client, session: &Session, models: &mut [Model]) {
    let unknown = models.iter_mut().filter(|m| m.bought.is_none() && m.price.is_some());
    for model in unknown.take(MAX_CHECKS) {
        if let Ok(v) = get(app, http, session, &format!("objects/{}", model.id), &[]).await {
            model.bought = v["is_bought"].as_bool();
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
}

async fn all_pages(app: &AppHandle, http: &Client, session: &Session, path: &str) -> Result<Vec<Value>, String> {
    let mut all = Vec::new();
    for page in 1.. {
        let v = get(app, http, session, path, &[("per_page", PER_PAGE.to_string()), ("page", page.to_string())]).await?;
        let found = items(&v).as_array().cloned().unwrap_or_default();
        let total = v["total_count"].as_u64().unwrap_or(0) as usize;
        let empty = found.is_empty();
        all.extend(found);
        if empty || all.len() >= total {
            break;
        }
    }
    Ok(all)
}

#[tauri::command]
pub fn mmf_session(app: AppHandle) -> Option<Account> {
    load_session(&app).map(|s| Account::from(&s))
}

/// Opens MyMiniFactory's sign-in page in the browser and waits for it to come back.
#[tauri::command]
pub async fn mmf_sign_in(app: AppHandle, state: State<'_, MyMiniFactory>) -> Result<Account, String> {
    let listener = TcpListener::bind(("127.0.0.1", PORT))
        .await
        .map_err(|_| format!("3Devil needs port {PORT} on this computer to sign in, and something else is using it."))?;
    let nonce = random_state();
    app.opener().open_url(sign_in_url(&nonce), None::<&str>).map_err(|e| e.to_string())?;
    let (access_token, expires_in) = tokio::select! {
        token = wait_for_token(listener, &nonce) => token?,
        _ = state.cancel.notified() => return Err("Sign-in cancelled.".into()),
        _ = tokio::time::sleep(SIGN_IN_WAIT) => return Err("Sign-in timed out. Try again.".into()),
    };
    let http = client()?;
    let mut session = Session { access_token, username: String::new(), expires_at: now() + expires_in };
    let me = get(&app, &http, &session, "user", &[]).await?;
    session.username = text(&me, "username").ok_or("MyMiniFactory didn't say who you are.")?;
    save_session(&session_path(&app)?, &session)?;
    Ok(Account::from(&session))
}

#[tauri::command]
pub fn mmf_cancel_sign_in(state: State<'_, MyMiniFactory>) {
    state.cancel.notify_waiters();
}

#[tauri::command]
pub fn mmf_sign_out(app: AppHandle) -> Result<(), String> {
    match std::fs::remove_file(session_path(&app)?) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
    }
}

#[tauri::command]
pub async fn mmf_library(app: AppHandle) -> Result<Library, String> {
    let session = signed_in(&app)?;
    let http = client()?;
    let user = encode(&session.username);
    let liked = all_pages(&app, &http, &session, &format!("users/{user}/objects_liked")).await?;
    let mut likes: Vec<_> = liked.iter().filter_map(to_model).collect();
    fill_ownership(&app, &http, &session, &mut likes).await;
    let mut collections = Vec::new();
    for c in all_pages(&app, &http, &session, &format!("users/{user}/collections")).await? {
        let (Some(name), Some(slug)) = (text(&c, "name"), text(&c, "slug")) else { continue };
        let full = get(&app, &http, &session, &format!("users/{user}/collections/{}", encode(&slug)), &[]).await?;
        let mut models = to_models(items(&full["objects"]));
        fill_ownership(&app, &http, &session, &mut models).await;
        collections.push(Collection { name, models });
    }
    Ok(Library { likes, collections })
}

/// Finds a model from a store link.
#[tauri::command]
pub async fn mmf_lookup(app: AppHandle, link: String) -> Result<Model, String> {
    let id = object_id(&link).ok_or("That doesn't look like a MyMiniFactory model link.")?;
    let session = signed_in(&app)?;
    let v = get(&app, &client()?, &session, &format!("objects/{id}"), &[]).await?;
    to_model(&v).ok_or_else(|| "MyMiniFactory sent something 3Devil couldn't read.".to_string())
}

/// Downloads a model's files into `dest_dir`, skipping any already there at
/// the right size. Progress is reported through `mmf-progress` events.
#[tauri::command]
pub async fn mmf_download(app: AppHandle, object_id: i64, dest_dir: String) -> Result<DownloadReport, String> {
    let session = signed_in(&app)?;
    let http = client()?;
    let object = get(&app, &http, &session, &format!("objects/{object_id}"), &[]).await?;
    let files = downloads(&object);
    if files.is_empty() {
        return Err("MyMiniFactory didn't give download links for this model. If it's a paid model, it needs buying first.".into());
    }
    let dest = PathBuf::from(&dest_dir);
    tokio::fs::create_dir_all(&dest).await.map_err(|e| e.to_string())?;
    let mut report = DownloadReport::default();
    let count = files.len();
    for (i, (url, name, size)) in files.iter().enumerate() {
        let target = dest.join(name);
        if let (Ok(meta), Some(size)) = (std::fs::metadata(&target), size) {
            if meta.len() == *size {
                report.skipped.push(name.clone());
                continue;
            }
        }
        let fail = |e: reqwest::Error| format!("{name}: {}", e.without_url());
        let resp = http.get(url).bearer_auth(&session.access_token).send().await.map_err(fail)?;
        if !resp.status().is_success() {
            return Err(format!("{name}: download failed (HTTP {})", resp.status().as_u16()));
        }
        let total = resp.content_length();
        let part = dest.join(format!("{name}.part"));
        let mut file = tokio::fs::File::create(&part).await.map_err(|e| e.to_string())?;
        let mut stream = resp.bytes_stream();
        let (mut received, mut last_emit) = (0u64, 0u64);
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(fail)?;
            file.write_all(&chunk).await.map_err(|e| e.to_string())?;
            received += chunk.len() as u64;
            if received - last_emit > 512 * 1024 || Some(received) == total {
                last_emit = received;
                let _ = app.emit("mmf-progress", Progress { order_product_id: object_id, file: name, file_index: i, file_count: count, received, total });
            }
        }
        file.flush().await.map_err(|e| e.to_string())?;
        drop(file);
        tokio::fs::rename(&part, &target).await.map_err(|e| e.to_string())?;
        report.downloaded.push(name.clone());
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_a_request_only_when_it_is_whole() {
        let whole = b"POST /token HTTP/1.1\r\nHost: x\r\nContent-Length: 5\r\n\r\nhello";
        assert_eq!(parse_request(whole), Some(("POST".into(), "/token".into(), b"hello".to_vec())));
        assert_eq!(parse_request(&whole[..whole.len() - 1]), None);
        assert_eq!(parse_request(b"GET /callback HTTP/1.1\r\nHost"), None);
        assert_eq!(parse_request(b"GET /callback?a=1 HTTP/1.1\r\n\r\n").unwrap().1, "/callback?a=1");
    }

    #[test]
    fn only_this_sign_in_can_finish() {
        let ok = br#"{"state":"abc","access_token":"t","expires_in":"604800"}"#;
        assert_eq!(read_callback(ok, "abc"), Some(Ok(("t".to_string(), 604800))));
        assert_eq!(read_callback(ok, "other"), None);
        assert_eq!(read_callback(br#"{"access_token":"t"}"#, "abc"), None);
        assert_eq!(read_callback(b"not json", "abc"), None);
        let denied = br#"{"state":"abc","error":"access_denied"}"#;
        assert_eq!(read_callback(denied, "abc"), Some(Err("access_denied".to_string())));
    }

    #[test]
    fn asks_for_the_registered_redirect() {
        let url = sign_in_url("s1");
        assert!(url.contains("client_id=threedevil"));
        assert!(url.contains("redirect_uri=http%3A%2F%2F127.0.0.1%3A47823%2Fcallback"));
        assert!(url.contains("response_type=token") && url.ends_with("state=s1"));
    }

    #[test]
    fn states_differ() {
        assert_ne!(random_state(), random_state());
        assert_eq!(random_state().len(), 32);
    }

    #[test]
    fn finds_the_id_in_a_link() {
        assert_eq!(object_id("https://www.myminifactory.com/object/3d-print-zombie-tyrant-187611"), Some(187611));
        assert_eq!(object_id(" https://www.myminifactory.com/object/3d-print-zombie-tyrant-187611/?a=1#b "), Some(187611));
        assert_eq!(object_id("myminifactory.com/object/x-5"), Some(5));
        assert_eq!(object_id("187611"), Some(187611));
        assert_eq!(object_id("https://evil.example.com/object/x-5"), None);
        assert_eq!(object_id("https://myminifactory.com.evil.example/object/x-5"), None);
        assert_eq!(object_id("https://www.myminifactory.com/users/fynflood"), None);
        assert_eq!(object_id("nonsense"), None);
    }

    #[test]
    fn a_file_name_can_never_be_a_path() {
        let mut used = HashSet::new();
        for evil in ["../../../.bashrc", "/etc/passwd", r"..\..\windows\system32\x.dll", "a/b/c.stl", "..", ""] {
            let name = file_name(evil, 1, &mut used);
            assert!(!name.contains('/') && !name.contains('\\') && name != ".." && !name.is_empty(), "{evil} gave {name}");
            assert!(!Path::new(&name).is_absolute());
        }
    }

    #[test]
    fn same_named_files_stay_apart() {
        let mut used = HashSet::new();
        assert_eq!(file_name("base.stl", 1, &mut used), "base.stl");
        assert_eq!(file_name("sub/BASE.stl", 2, &mut used), "BASE-2.stl");
        assert_eq!(file_name("readme", 3, &mut used), "readme");
        assert_eq!(file_name("readme", 4, &mut used), "readme-4");
    }

    #[test]
    fn reads_models_as_the_api_sends_them() {
        let paid = json!({"id": 160635, "name": "Flesh Mound", "url": "https://www.myminifactory.com/object/x-160635",
            "designer": {"username": "ttm", "name": "Titan Minis"}, "is_bought": true, "price": {"currency": "EUR", "symbol": "€", "value": "3.99"}});
        let m = to_model(&paid).unwrap();
        assert_eq!((m.price.as_deref(), m.bought, m.designer.as_deref()), (Some("€3.99"), Some(true), Some("Titan Minis")));
        let free = json!({"id": 1, "name": "Free one", "url": "u", "price": null, "designer": {"username": "ttm"}});
        let m = to_model(&free).unwrap();
        assert_eq!((m.price, m.bought, m.designer.as_deref()), (None, None, Some("ttm")));
        assert_eq!(to_model(&json!({"id": 2, "name": "Zero", "price": {"symbol": "£", "value": "0.00"}})).unwrap().price, None);
        assert_eq!(to_model(&json!({"name": "No id"})), None);
    }

    #[test]
    fn takes_only_files_with_links() {
        let object = json!({"files": {"items": [
            {"id": 1, "filename": "a.stl", "size": "42", "download_url": "https://x/1"},
            {"id": 2, "filename": "b.stl", "size": 7},
            {"id": 3, "filename": "c.stl", "size": 9, "download_url": ""},
            {"id": 4, "filename": "d.zip", "size": 9, "download_url": "https://x/4"},
        ]}});
        let got = downloads(&object);
        assert_eq!(got, vec![("https://x/1".to_string(), "a.stl".to_string(), Some(42)), ("https://x/4".to_string(), "d.zip".to_string(), Some(9))]);
        assert!(downloads(&json!({"files": []})).is_empty());
        assert!(downloads(&json!({})).is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn the_session_is_private() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("threedevil-mmf-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join(SESSION_FILE);
        save_session(&path, &Session { access_token: "t".into(), username: "u".into(), expires_at: 9 }).unwrap();
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_session_never_reaches_the_page() {
        let account = Account::from(&Session { access_token: "secret".into(), username: "u".into(), expires_at: 9 });
        assert!(!serde_json::to_string(&account).unwrap().contains("secret"));
    }
}
