//! Where the app state lives: this computer's app data folder, or a folder
//! the user picks (one that Syncthing, Dropbox or a NAS keeps in step) so
//! several computers share the same projects.
//!
//! What only makes sense on one computer stays in `local.json` in the app
//! data folder: which shared folder to use, this computer's slicer commands,
//! and where model folders from another computer are found here. Paths are
//! swapped on the way in and out, so the shared file keeps each folder under
//! the path it was first added with and the frontend only ever sees local paths.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;
use tauri::{AppHandle, Manager};

const LOCAL_FILE: &str = "local.json";
const STATE_FILE: &str = "state.json";
/// Name of the projects file inside a shared folder.
const SHARED_FILE: &str = "3devil-projects.json";

/// Serializes file access between the commands below.
static LOCK: Mutex<()> = Mutex::new(());

const SEPS: [char; 2] = ['/', '\\'];

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PathMapping {
    /// The folder as the shared file names it.
    from: String,
    /// Where that folder is on this computer.
    to: String,
}

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Local {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    shared_dir: Option<String>,
    #[serde(default)]
    path_map: Vec<PathMapping>,
    /// This computer's slicer commands, kept out of the shared file's.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    slicers: Option<Value>,
}

fn app_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn read_local(dir: &Path) -> Local {
    fs::read_to_string(dir.join(LOCAL_FILE))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// Writes `bytes` via a temp file and rename, so a reader (or a sync tool)
/// never sees half a file. Keeps the previous version as `.bak`.
fn write_atomic(path: &Path, bytes: &[u8], backup: bool) -> Result<(), String> {
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("state");
    let tmp = path.with_file_name(format!(".{name}.tmp"));
    fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    // State includes printer access codes; keep it readable by this user only.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600));
    }
    if backup && path.exists() {
        let _ = fs::copy(path, path.with_extension("json.bak"));
    }
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

fn write_local(dir: &Path, local: &Local) -> Result<(), String> {
    let json = serde_json::to_vec_pretty(local).map_err(|e| e.to_string())?;
    write_atomic(&dir.join(LOCAL_FILE), &json, false)
}

fn state_file(dir: &Path, local: &Local) -> PathBuf {
    match &local.shared_dir {
        Some(shared) => Path::new(shared).join(SHARED_FILE),
        None => dir.join(STATE_FILE),
    }
}

/// `path` with the folder `from` swapped for `to`, if `path` is that folder or inside it.
fn swap_prefix(path: &str, from: &str, to: &str) -> Option<String> {
    let rest = path.strip_prefix(from.trim_end_matches(SEPS))?;
    if !rest.is_empty() && !rest.starts_with(SEPS) {
        return None;
    }
    let rest = rest.trim_start_matches(SEPS);
    if rest.is_empty() {
        return Some(to.to_string());
    }
    // Write the rest of the path with the separators the other side uses.
    let sep = if to.contains('\\') && !to.contains('/') { "\\" } else { "/" };
    Some(format!("{}{sep}{}", to.trim_end_matches(SEPS), rest.replace(SEPS, sep)))
}

/// Calls `f` on every file or folder path in the state.
fn each_path(state: &mut Value, mut f: impl FnMut(&mut String)) {
    if let Some(projects) = state.get_mut("projects").and_then(Value::as_array_mut) {
        for project in projects {
            if let Some(folders) = project.get_mut("folders").and_then(Value::as_array_mut) {
                for folder in folders {
                    if let Value::String(s) = folder {
                        f(s);
                    }
                }
            }
            if let Some(parts) = project.get_mut("parts").and_then(Value::as_array_mut) {
                for part in parts {
                    if let Some(Value::String(s)) = part.get_mut("path") {
                        f(s);
                    }
                }
            }
        }
    }
    if let Some(Value::String(s)) = state.pointer_mut("/settings/driveThru/libraryPath") {
        f(s);
    }
}

/// Shared paths → this computer's. A path that exists here as it is stays as it is.
fn map_in(state: &mut Value, map: &[PathMapping], exists: impl Fn(&str) -> bool) {
    each_path(state, |p| {
        if exists(p) {
            return;
        }
        if let Some(local) = map.iter().find_map(|m| swap_prefix(p, &m.from, &m.to)) {
            *p = local;
        }
    });
}

/// This computer's paths → the shared file's.
fn map_out(state: &mut Value, map: &[PathMapping]) {
    each_path(state, |p| {
        if let Some(shared) = map.iter().find_map(|m| swap_prefix(p, &m.to, &m.from)) {
            *p = shared;
        }
    });
}

/// The state as this computer should see it, or "null" if there's none yet.
fn read_state(dir: &Path, local: &Local) -> Result<String, String> {
    let path = state_file(dir, local);
    let json = match fs::read_to_string(&path) {
        Ok(s) => s,
        // Starting empty would let the next save replace the real file once the
        // folder is back (or finishes syncing), so refuse instead.
        Err(_) if local.shared_dir.is_some() => {
            return Err(format!(
                "Can't open the shared projects file {}. Check that the folder is available.",
                path.display()
            ));
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok("null".into()),
        Err(e) => return Err(e.to_string()),
    };
    if local.shared_dir.is_none() && local.path_map.is_empty() {
        return Ok(json);
    }
    let mut state: Value = serde_json::from_str(&json).map_err(|e| format!("The projects file is damaged: {e}"))?;
    map_in(&mut state, &local.path_map, |p| Path::new(p).exists());
    if local.shared_dir.is_some()
        && let Some(settings) = state.get_mut("settings").and_then(Value::as_object_mut)
    {
        // Until this computer has its own, find the slicers again rather than
        // using another computer's commands.
        let slicers = local.slicers.clone().unwrap_or_else(|| json!({ "bambu": null, "prusa": null, "orca": null }));
        settings.insert("slicers".into(), slicers);
    }
    Ok(state.to_string())
}

fn write_state(dir: &Path, local: &mut Local, json: &str) -> Result<(), String> {
    let path = state_file(dir, local);
    if local.shared_dir.is_none() && local.path_map.is_empty() {
        return write_atomic(&path, json.as_bytes(), true);
    }
    let mut state: Value = serde_json::from_str(json).map_err(|e| e.to_string())?;
    if local.shared_dir.is_some() {
        let slicers = state.pointer("/settings/slicers").cloned();
        if slicers.is_some() && slicers != local.slicers {
            local.slicers = slicers;
            write_local(dir, local)?;
        }
    }
    map_out(&mut state, &local.path_map);
    write_atomic(&path, state.to_string().as_bytes(), true)
}

/// Changes whenever the projects file does, including when another computer
/// writes it through a sync tool.
fn stamp(path: &Path) -> String {
    match fs::metadata(path) {
        Ok(m) => {
            let modified = m.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_nanos()).unwrap_or(0);
            format!("{modified}:{}", m.len())
        }
        Err(_) => String::new(),
    }
}

/// Returns the saved app state as a JSON string, or `null` on first run.
#[tauri::command]
pub fn load_state(app: AppHandle) -> Result<String, String> {
    let _guard = LOCK.lock().unwrap();
    let dir = app_dir(&app)?;
    read_state(&dir, &read_local(&dir))
}

/// Writes the state and returns the file's new stamp.
#[tauri::command]
pub fn save_state(app: AppHandle, json: String) -> Result<String, String> {
    let _guard = LOCK.lock().unwrap();
    let dir = app_dir(&app)?;
    let mut local = read_local(&dir);
    write_state(&dir, &mut local, &json)?;
    Ok(stamp(&state_file(&dir, &local)))
}

#[tauri::command]
pub fn state_stamp(app: AppHandle) -> Result<String, String> {
    let dir = app_dir(&app)?;
    Ok(stamp(&state_file(&dir, &read_local(&dir))))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataLocation {
    shared_dir: Option<String>,
    /// The projects file in use.
    file: String,
    path_map: Vec<PathMapping>,
}

#[tauri::command]
pub fn data_location(app: AppHandle) -> Result<DataLocation, String> {
    let dir = app_dir(&app)?;
    let local = read_local(&dir);
    Ok(DataLocation {
        file: state_file(&dir, &local).to_string_lossy().into_owned(),
        shared_dir: local.shared_dir,
        path_map: local.path_map,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedInfo {
    projects: usize,
    /// Milliseconds since the epoch.
    modified: u64,
}

/// What a folder already holds, if another computer shares projects there.
#[tauri::command]
pub fn inspect_shared_folder(dir: String) -> Result<Option<SharedInfo>, String> {
    let path = Path::new(&dir).join(SHARED_FILE);
    let Ok(json) = fs::read_to_string(&path) else { return Ok(None) };
    let state: Value = serde_json::from_str(&json).map_err(|e| format!("{SHARED_FILE} in that folder is damaged: {e}"))?;
    let modified = fs::metadata(&path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Ok(Some(SharedInfo { projects: state["projects"].as_array().map_or(0, Vec::len), modified }))
}

/// Switches where projects are kept: a shared folder, or (`None`) this
/// computer again. With `use_existing`, the projects already in that folder are
/// used; otherwise this computer's current projects are copied there.
#[tauri::command]
pub fn set_shared_folder(app: AppHandle, dir: Option<String>, use_existing: bool) -> Result<(), String> {
    let _guard = LOCK.lock().unwrap();
    let app_dir = app_dir(&app)?;
    let old = read_local(&app_dir);
    if let Some(d) = &dir
        && !Path::new(d).is_dir()
    {
        return Err(format!("Not a folder: {d}"));
    }
    let current = match read_state(&app_dir, &old) {
        Ok(json) => Some(json),
        // Leaving a shared folder that's unavailable: go back to what this computer had.
        Err(_) if dir.is_none() => None,
        Err(e) => return Err(e),
    };
    let mut new = Local { shared_dir: dir, ..old };
    if let Some(json) = current
        && !(use_existing && new.shared_dir.is_some())
    {
        // Even with no projects yet, create the file so the folder counts as shared.
        write_state(&app_dir, &mut new, &json)?;
    }
    write_local(&app_dir, &new)
}

/// The folder on this computer that matches `missing` (a folder named in the
/// shared file): the paths minus the folder names they end with in common, so
/// one mapping also finds other folders under the same parent.
fn suggest_mapping(missing: &str, found: &str) -> Option<PathMapping> {
    let (mut from, mut to) = (missing.trim_end_matches(SEPS), found.trim_end_matches(SEPS));
    while let (Some(i), Some(j)) = (from.rfind(SEPS), to.rfind(SEPS)) {
        if from[i + 1..] != to[j + 1..] || (i == 0 && j == 0) {
            break;
        }
        // Keep a root's own separator ("/", "C:\") so it stays a valid path.
        let keep = |s: &str, k: usize| if k == 0 || s[..k].ends_with(':') { k + 1 } else { k };
        from = &from[..keep(from, i)];
        to = &to[..keep(to, j)];
        if from.ends_with(SEPS) || to.ends_with(SEPS) {
            break;
        }
    }
    (from != to).then(|| PathMapping { from: from.to_string(), to: to.to_string() })
}

/// Records that `missing` (from another computer) is `found` here, and
/// returns the mapping used. Newer mappings are tried first.
#[tauri::command]
pub fn add_path_mapping(app: AppHandle, missing: String, found: String) -> Result<PathMapping, String> {
    let _guard = LOCK.lock().unwrap();
    let dir = app_dir(&app)?;
    let mut local = read_local(&dir);
    let mapping = suggest_mapping(&missing, &found).ok_or("That's the same folder.")?;
    local.path_map.retain(|m| m.from != mapping.from);
    local.path_map.insert(0, mapping.clone());
    write_local(&dir, &local)?;
    Ok(mapping)
}

#[tauri::command]
pub fn remove_path_mapping(app: AppHandle, from: String) -> Result<(), String> {
    let _guard = LOCK.lock().unwrap();
    let dir = app_dir(&app)?;
    let mut local = read_local(&dir);
    local.path_map.retain(|m| m.from != from);
    write_local(&dir, &local)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn map(from: &str, to: &str) -> PathMapping {
        PathMapping { from: from.into(), to: to.into() }
    }

    #[test]
    fn swaps_only_whole_folders() {
        assert_eq!(swap_prefix("/home/fyn/Models/a.stl", "/home/fyn", "/mnt/nas").as_deref(), Some("/mnt/nas/Models/a.stl"));
        assert_eq!(swap_prefix("/home/fyn", "/home/fyn/", "/mnt/nas").as_deref(), Some("/mnt/nas"));
        assert_eq!(swap_prefix("/home/fynn/a.stl", "/home/fyn", "/mnt/nas"), None);
        assert_eq!(swap_prefix("/Models/a.stl", "/", "/mnt/").as_deref(), Some("/mnt/Models/a.stl"));
    }

    #[test]
    fn swaps_separators_between_systems() {
        assert_eq!(
            swap_prefix("/home/fyn/Models/Castle/wall.stl", "/home/fyn", r"D:\").as_deref(),
            Some(r"D:\Models\Castle\wall.stl")
        );
        assert_eq!(
            swap_prefix(r"D:\Models\Castle\wall.stl", r"D:\", "/home/fyn").as_deref(),
            Some("/home/fyn/Models/Castle/wall.stl")
        );
    }

    #[test]
    fn suggests_the_shortest_matching_parents() {
        assert_eq!(suggest_mapping("/home/fyn/Models/Castle", "/mnt/nas/Models/Castle/"), Some(map("/home/fyn", "/mnt/nas")));
        assert_eq!(suggest_mapping("/home/fyn/Models/Castle", r"D:\Models\Castle"), Some(map("/home/fyn", r"D:\")));
        assert_eq!(suggest_mapping("/home/a/Castle", "/srv/Castle Walls"), Some(map("/home/a/Castle", "/srv/Castle Walls")));
        assert_eq!(suggest_mapping("/Models/Castle", "/mnt/Models/Castle"), Some(map("/", "/mnt")));
        assert_eq!(suggest_mapping("/a/b", "/a/b"), None);
    }

    #[test]
    fn round_trips_and_leaves_local_paths_alone() {
        let shared = json!({
            "projects": [{
                "folders": ["/home/fyn/Models/Castle", "/opt/here"],
                "parts": [{"path": "/home/fyn/Models/Castle/wall.stl"}, {"path": "/opt/here/door.stl"}]
            }],
            "settings": {"driveThru": {"libraryPath": "/home/fyn/Models/DTRPG"}}
        });
        let m = vec![map("/home/fyn", "/mnt/nas")];
        let mut s = shared.clone();
        map_in(&mut s, &m, |p| p.starts_with("/opt/here"));
        assert_eq!(s["projects"][0]["folders"], json!(["/mnt/nas/Models/Castle", "/opt/here"]));
        assert_eq!(s["projects"][0]["parts"][0]["path"], "/mnt/nas/Models/Castle/wall.stl");
        assert_eq!(s["settings"]["driveThru"]["libraryPath"], "/mnt/nas/Models/DTRPG");
        // A part added on this computer goes out under the shared name too.
        s["projects"][0]["parts"].as_array_mut().unwrap().push(json!({"path": "/mnt/nas/Models/Castle/tower.stl"}));
        map_out(&mut s, &m);
        assert_eq!(s["projects"][0]["folders"], shared["projects"][0]["folders"]);
        assert_eq!(s["projects"][0]["parts"][2]["path"], "/home/fyn/Models/Castle/tower.stl");
    }

    fn tmpdir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("3devil-storage-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn shared_file_keeps_each_computers_slicers() {
        let app = tmpdir("app");
        let shared = tmpdir("shared");
        let mut local = Local { shared_dir: Some(shared.to_string_lossy().into()), ..Default::default() };
        let mine = json!({"projects": [], "settings": {"slicers": {"bambu": ["flatpak", "run", "x"], "prusa": null}}});
        write_state(&app, &mut local, &mine.to_string()).unwrap();
        assert_eq!(local.slicers, Some(json!({"bambu": ["flatpak", "run", "x"], "prusa": null})));
        // Another computer joining the folder starts with its slicers unset.
        let other = Local { shared_dir: local.shared_dir.clone(), ..Default::default() };
        let seen: Value = serde_json::from_str(&read_state(&tmpdir("other"), &other).unwrap()).unwrap();
        assert_eq!(seen["settings"]["slicers"], json!({"bambu": null, "prusa": null, "orca": null}));
        let back: Value = serde_json::from_str(&read_state(&app, &read_local(&app)).unwrap()).unwrap();
        assert_eq!(back["settings"]["slicers"]["bambu"][0], "flatpak");
        assert!(!stamp(&shared.join(SHARED_FILE)).is_empty());
    }

    #[test]
    fn missing_shared_file_is_an_error_not_an_empty_start() {
        let local = Local { shared_dir: Some(tmpdir("gone").join("nope").to_string_lossy().into()), ..Default::default() };
        assert!(read_state(&tmpdir("app2"), &local).unwrap_err().contains("Can't open the shared projects file"));
        assert_eq!(read_state(&tmpdir("app3"), &Local::default()).unwrap(), "null");
    }
}
