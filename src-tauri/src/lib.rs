use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::{AppHandle, Manager};

mod preview;
mod printer;

const MODEL_EXTS: &[&str] = &["stl", "3mf", "obj"];

fn state_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("state.json"))
}

/// Returns the saved app state as a JSON string, or `null` on first run.
#[tauri::command]
fn load_state(app: AppHandle) -> Result<String, String> {
    let path = state_path(&app)?;
    match fs::read_to_string(&path) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok("null".into()),
        Err(e) => Err(e.to_string()),
    }
}

/// Writes state atomically (temp file + rename) and keeps one backup.
#[tauri::command]
fn save_state(app: AppHandle, json: String) -> Result<(), String> {
    let path = state_path(&app)?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, json.as_bytes()).map_err(|e| e.to_string())?;
    // State includes printer access codes; keep it readable by this user only.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600));
    }
    if path.exists() {
        let _ = fs::copy(&path, path.with_extension("json.bak"));
    }
    fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelFile {
    path: String,
    name: String,
    /// Directory relative to the scan root, using `/` separators ("" for the root).
    group: String,
    size: u64,
}

fn walk(root: &Path, dir: &Path, out: &mut Vec<ModelFile>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let fname = entry.file_name().to_string_lossy().to_string();
        if fname.starts_with('.') || fname == "__MACOSX" {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        if meta.is_dir() {
            walk(root, &path, out);
            continue;
        }
        let ext = path
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        if !MODEL_EXTS.contains(&ext.as_str()) {
            continue;
        }
        let group = path
            .parent()
            .and_then(|p| p.strip_prefix(root).ok())
            .map(|p| {
                p.components()
                    .map(|c| c.as_os_str().to_string_lossy().to_string())
                    .collect::<Vec<_>>()
                    .join("/")
            })
            .unwrap_or_default();
        out.push(ModelFile {
            path: path.to_string_lossy().to_string(),
            name: path
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or(fname),
            group,
            size: meta.len(),
        });
    }
}

/// Recursively finds printable model files (STL/3MF/OBJ) under `dir`.
#[tauri::command]
async fn scan_models(dir: String) -> Result<Vec<ModelFile>, String> {
    let root = PathBuf::from(&dir);
    if !root.is_dir() {
        return Err(format!("Not a folder: {dir}"));
    }
    let mut out = Vec::new();
    walk(&root, &root, &mut out);
    out.sort_by(|a, b| a.group.cmp(&b.group).then(a.name.cmp(&b.name)));
    Ok(out)
}

/// Returns the raw bytes of a file as an ArrayBuffer on the JS side.
#[tauri::command]
fn read_file_bytes(path: String) -> Result<tauri::ipc::Response, String> {
    fs::read(&path)
        .map(tauri::ipc::Response::new)
        .map_err(|e| format!("{path}: {e}"))
}

/// A model file for display: large binary STLs come back simplified to a
/// grid of `resolution` cells along their longest side.
#[tauri::command]
async fn read_model_preview(path: String, resolution: u32) -> Result<tauri::ipc::Response, String> {
    preview::preview_bytes(&path, resolution)
        .map(tauri::ipc::Response::new)
        .map_err(|e| format!("{path}: {e}"))
}

/// Which of the given paths no longer exist on disk.
#[tauri::command]
fn missing_files(paths: Vec<String>) -> Vec<String> {
    paths.into_iter().filter(|p| !Path::new(p).exists()).collect()
}

/// Where an archive unpacks to: its single top-level folder placed next to
/// the archive, or otherwise a folder named after the archive.
fn archive_target(zip_path: &Path, archive: &mut zip::ZipArchive<fs::File>) -> Option<(PathBuf, PathBuf)> {
    let parent = zip_path.parent()?.to_path_buf();
    let mut top: Option<std::ffi::OsString> = None;
    let mut single = true;
    let mut has_nested = false;
    for i in 0..archive.len() {
        let Ok(entry) = archive.by_index_raw(i) else { continue };
        let Some(name) = entry.enclosed_name() else { continue };
        let mut comps = name.components();
        let Some(first) = comps.next() else { continue };
        if first.as_os_str() == "__MACOSX" {
            continue;
        }
        has_nested |= comps.next().is_some() || entry.is_dir();
        match &top {
            None => top = Some(first.as_os_str().to_owned()),
            Some(t) if t != first.as_os_str() => single = false,
            _ => {}
        }
    }
    match top {
        Some(t) if single && has_nested => Some((parent.clone(), parent.join(t))),
        _ => {
            let stem = zip_path.file_stem()?.to_string_lossy().to_string();
            Some((parent.join(&stem), parent.join(stem)))
        }
    }
}

/// Extracts one archive next to itself unless its output already exists.
/// Returns the folder that now holds its contents, or None if skipped.
fn extract_beside(zip_path: &Path) -> Result<Option<PathBuf>, String> {
    let file = fs::File::open(zip_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    let (dest, result) = archive_target(zip_path, &mut archive).ok_or("Invalid archive path")?;
    if result.exists() {
        return Ok(None);
    }
    // Extract into a scratch folder first so an interrupted extraction is
    // never mistaken for a finished one on the next scan.
    let parent = zip_path.parent().ok_or("Invalid archive path")?;
    let tmp = parent.join(format!(
        ".3devil-extract-{}",
        zip_path.file_name().unwrap_or_default().to_string_lossy()
    ));
    let _ = fs::remove_dir_all(&tmp);
    fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
    // `extract` rejects entries that would escape the target folder.
    if let Err(e) = archive.extract(&tmp) {
        let _ = fs::remove_dir_all(&tmp);
        return Err(e.to_string());
    }
    let _ = fs::remove_dir_all(tmp.join("__MACOSX"));
    let moved = if dest == result {
        fs::rename(&tmp, &result)
    } else {
        let top = result.file_name().unwrap_or_default();
        fs::rename(tmp.join(top), &result).and_then(|_| fs::remove_dir_all(&tmp))
    };
    if let Err(e) = moved {
        let _ = fs::remove_dir_all(&tmp);
        return Err(e.to_string());
    }
    Ok(Some(result))
}

#[derive(Serialize, Default)]
struct ExtractReport {
    /// Archives that were unpacked.
    extracted: Vec<String>,
    /// Archives that could not be unpacked, with the reason.
    failed: Vec<String>,
}

fn extract_all(dir: &Path, report: &mut ExtractReport) {
    let mut zips = Vec::new();
    collect_zips(dir, &mut zips);
    for zip_path in zips {
        match extract_beside(&zip_path) {
            Ok(Some(out)) => {
                report.extracted.push(zip_path.to_string_lossy().to_string());
                // Archives often contain further archives.
                if out.is_dir() {
                    extract_all(&out, report);
                }
            }
            Ok(None) => {}
            Err(e) => report
                .failed
                .push(format!("{}: {e}", zip_path.to_string_lossy())),
        }
    }
}

/// Unpacks every ZIP under `dir` (recursively) that hasn't been unpacked yet.
/// The archives themselves are left in place.
#[tauri::command]
async fn extract_archives(dir: String) -> ExtractReport {
    let mut report = ExtractReport::default();
    extract_all(Path::new(&dir), &mut report);
    report
}

/// Extracts a single chosen ZIP (e.g. a DriveThruRPG or MyMiniFactory
/// download) into a sibling folder named after it, plus any ZIPs inside.
#[tauri::command]
async fn extract_zip(zip_path: String) -> Result<String, String> {
    let zip_path = PathBuf::from(zip_path);
    let stem = zip_path
        .file_stem()
        .ok_or("Invalid archive name")?
        .to_string_lossy()
        .to_string();
    let dest = zip_path.with_file_name(stem);
    if !dest.exists() {
        let file = fs::File::open(&zip_path).map_err(|e| e.to_string())?;
        let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
        fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
        archive.extract(&dest).map_err(|e| e.to_string())?;
    }
    extract_all(&dest, &mut ExtractReport::default());
    Ok(dest.to_string_lossy().to_string())
}

fn collect_zips(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let p = entry.path();
        let hidden = entry.file_name().to_string_lossy().starts_with('.');
        if p.is_dir() {
            if !hidden {
                collect_zips(&p, out);
            }
        } else if !hidden && p.extension().is_some_and(|e| e.eq_ignore_ascii_case("zip")) {
            out.push(p);
        }
    }
}

#[derive(Serialize)]
struct DetectedSlicers {
    bambu: Option<Vec<String>>,
    prusa: Option<Vec<String>>,
}

fn which(bin: &str) -> Option<String> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        for name in [bin.to_string(), format!("{bin}.exe")] {
            let candidate = dir.join(&name);
            if candidate.is_file() {
                return Some(candidate.to_string_lossy().to_string());
            }
        }
    }
    None
}

fn flatpak_app(id: &str) -> Option<Vec<String>> {
    let out = Command::new("flatpak").args(["info", id]).output().ok()?;
    out.status
        .success()
        .then(|| vec!["flatpak".into(), "run".into(), id.into()])
}

fn first_existing(paths: &[&str]) -> Option<Vec<String>> {
    paths
        .iter()
        .find(|p| Path::new(p).exists())
        .map(|p| vec![p.to_string()])
}

/// Best-effort lookup of Bambu Studio and PrusaSlicer on this machine.
#[tauri::command]
fn detect_slicers() -> DetectedSlicers {
    let bambu = if cfg!(target_os = "windows") {
        first_existing(&[
            r"C:\Program Files\Bambu Studio\bambu-studio.exe",
            r"C:\Program Files (x86)\Bambu Studio\bambu-studio.exe",
        ])
    } else if cfg!(target_os = "macos") {
        first_existing(&["/Applications/BambuStudio.app/Contents/MacOS/BambuStudio"])
    } else {
        which("bambu-studio")
            .map(|p| vec![p])
            .or_else(|| flatpak_app("com.bambulab.BambuStudio"))
    };
    let prusa = if cfg!(target_os = "windows") {
        first_existing(&[
            r"C:\Program Files\Prusa3D\PrusaSlicer\prusa-slicer.exe",
            r"C:\Program Files\PrusaSlicer\prusa-slicer.exe",
        ])
    } else if cfg!(target_os = "macos") {
        first_existing(&["/Applications/Original Prusa Drivers/PrusaSlicer.app/Contents/MacOS/PrusaSlicer"])
            .or_else(|| first_existing(&["/Applications/PrusaSlicer.app/Contents/MacOS/PrusaSlicer"]))
    } else {
        which("prusa-slicer")
            .or_else(|| which("PrusaSlicer"))
            .map(|p| vec![p])
            .or_else(|| flatpak_app("com.prusa3d.PrusaSlicer"))
    };
    DetectedSlicers { bambu, prusa }
}

/// Launches a slicer with the given model files loaded. `command` is the
/// program followed by any fixed arguments (e.g. `flatpak run <id>`).
#[tauri::command]
fn open_in_slicer(command: Vec<String>, files: Vec<String>) -> Result<(), String> {
    let (program, args) = command.split_first().ok_or("No slicer configured")?;
    let mut child = Command::new(program)
        .args(args)
        .args(&files)
        .spawn()
        .map_err(|e| format!("Could not start {program}: {e}"))?;
    // Reap the process when it exits so it doesn't linger as a zombie.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(printer::Printers::default())
        .invoke_handler(tauri::generate_handler![
            load_state,
            save_state,
            scan_models,
            read_file_bytes,
            read_model_preview,
            missing_files,
            extract_zip,
            extract_archives,
            detect_slicers,
            open_in_slicer,
            printer::printer_probe,
            printer::printer_scan,
            printer::printer_connect,
            printer::printer_disconnect
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn tmpdir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("threedevil-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn zip_bytes(files: &[(&str, &[u8])]) -> Vec<u8> {
        let mut buf = std::io::Cursor::new(Vec::new());
        let mut w = zip::ZipWriter::new(&mut buf);
        for (name, data) in files {
            w.start_file(*name, zip::write::SimpleFileOptions::default()).unwrap();
            w.write_all(data).unwrap();
        }
        w.finish().unwrap();
        buf.into_inner()
    }

    #[test]
    fn scan_finds_models_with_groups_and_skips_hidden() {
        let d = tmpdir("scan");
        fs::create_dir_all(d.join("Walls/Big")).unwrap();
        fs::create_dir_all(d.join(".hidden")).unwrap();
        fs::write(d.join("root.STL"), b"x").unwrap();
        fs::write(d.join("Walls/Big/wall_x4.stl"), b"x").unwrap();
        fs::write(d.join("Walls/plate.3mf"), b"x").unwrap();
        fs::write(d.join("Walls/readme.pdf"), b"x").unwrap();
        fs::write(d.join(".hidden/secret.stl"), b"x").unwrap();

        let found = tauri::async_runtime::block_on(scan_models(d.to_string_lossy().into())).unwrap();
        let got: Vec<_> = found.iter().map(|f| (f.group.as_str(), f.name.as_str())).collect();
        assert_eq!(got, vec![("", "root"), ("Walls", "plate"), ("Walls/Big", "wall_x4")]);
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn extract_zip_unpacks_nested_archives() {
        let d = tmpdir("zip");
        let inner = zip_bytes(&[("tower.stl", b"solid")]);
        let outer = zip_bytes(&[("Castle/wall.stl", b"solid"), ("Castle/Towers.zip", &inner)]);
        let zip_path = d.join("Castle_Pack.zip");
        fs::write(&zip_path, outer).unwrap();

        let dest = tauri::async_runtime::block_on(extract_zip(zip_path.to_string_lossy().into())).unwrap();
        let dest = PathBuf::from(dest);
        assert_eq!(dest, d.join("Castle_Pack"));
        assert!(dest.join("Castle/wall.stl").is_file());
        assert!(dest.join("Castle/Towers/tower.stl").is_file());
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn extract_archives_unwraps_single_folder_and_skips_done() {
        let d = tmpdir("folder");
        // Single top-level folder: unpacked as `Ground/` beside the zip.
        let ground = zip_bytes(&[("Ground/Ground_1.stl", b"solid"), ("__MACOSX/._x", b"")]);
        fs::write(d.join("Sept_-_Ground.zip"), ground).unwrap();
        // Loose files: unpacked into a folder named after the zip.
        let loose = zip_bytes(&[("pin.stl", b"solid"), ("clip.stl", b"solid")]);
        fs::write(d.join("Clips.zip"), loose).unwrap();
        fs::write(d.join("broken.zip"), b"not a zip").unwrap();

        let run = || tauri::async_runtime::block_on(extract_archives(d.to_string_lossy().into()));
        let report = run();
        assert_eq!(report.extracted.len(), 2);
        assert_eq!(report.failed.len(), 1);
        assert!(d.join("Ground/Ground_1.stl").is_file());
        assert!(!d.join("__MACOSX").exists());
        assert!(d.join("Clips/pin.stl").is_file());
        assert!(d.join("Sept_-_Ground.zip").is_file(), "originals are kept");
        assert!(fs::read_dir(&d).unwrap().flatten().all(|e| !e.file_name().to_string_lossy().starts_with(".3devil")));

        // A second pass finds nothing new to do.
        assert!(run().extracted.is_empty());
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn missing_files_reports_only_absent_paths() {
        let d = tmpdir("missing");
        let present = d.join("a.stl");
        fs::write(&present, b"x").unwrap();
        let absent = d.join("b.stl").to_string_lossy().to_string();
        let out = missing_files(vec![present.to_string_lossy().into(), absent.clone()]);
        assert_eq!(out, vec![absent]);
        fs::remove_dir_all(d).unwrap();
    }
}
