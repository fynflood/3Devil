use serde::Serialize;
use std::ffi::OsString;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::SystemTime;

mod drivethru;
mod folders;
mod orca;
mod preview;
mod printer;
mod camera;
mod klipper;
mod prusa;
mod storage;

const MODEL_EXTS: &[&str] = &["stl", "3mf", "obj"];
/// Left in an unpacked folder; its timestamp says when the archive was unpacked.
const UNPACKED_MARKER: &str = ".3devil-unpacked";

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
pub(crate) fn archive_target(zip_path: &Path, archive: &mut zip::ZipArchive<fs::File>) -> Option<(PathBuf, PathBuf)> {
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

fn modified(path: &Path) -> Option<SystemTime> {
    fs::metadata(path).ok()?.modified().ok()
}

fn newest_file(dir: &Path) -> Option<SystemTime> {
    fs::read_dir(dir)
        .ok()?
        .flatten()
        .filter_map(|e| if e.path().is_dir() { newest_file(&e.path()) } else { modified(&e.path()) })
        .max()
}

/// When `dir` was last unpacked. Folders from before the marker existed go by
/// their newest file, as unpacking doesn't keep the archive's timestamps.
fn unpacked_at(dir: &Path) -> Option<SystemTime> {
    modified(&dir.join(UNPACKED_MARKER)).or_else(|| newest_file(dir))
}

pub(crate) fn same_contents(a: &Path, b: &Path) -> std::io::Result<bool> {
    if fs::metadata(a)?.len() != fs::metadata(b)?.len() {
        return Ok(false);
    }
    let (mut a, mut b) = (fs::File::open(a)?, fs::File::open(b)?);
    let (mut buf_a, mut buf_b) = (vec![0; 1 << 16], vec![0; 1 << 16]);
    loop {
        let n = a.read(&mut buf_a)?;
        if n == 0 {
            return Ok(true);
        }
        b.read_exact(&mut buf_b[..n])?;
        if buf_a[..n] != buf_b[..n] {
            return Ok(false);
        }
    }
}

/// Notes the files in `current` that a newly unpacked archive no longer has.
fn note_removed(unpacked: &Path, current: &Path, report: &mut ExtractReport) {
    let Ok(entries) = fs::read_dir(current) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name();
        if name.to_string_lossy().starts_with('.') {
            continue;
        }
        let (fresh, ours) = (unpacked.join(&name), entry.path());
        if ours.is_dir() {
            note_removed(&fresh, &ours, report);
        } else if !fresh.exists() {
            report.removed.push(ours.to_string_lossy().to_string());
        }
    }
}

/// Moves a newly unpacked archive over the previous one, noting which files
/// really differ: a re-zipped pack usually changes only a few. Files the
/// archive no longer has are left in place.
fn apply_update(unpacked: &Path, current: &Path, report: &mut ExtractReport) -> std::io::Result<()> {
    fs::create_dir_all(current)?;
    for entry in fs::read_dir(unpacked)?.flatten() {
        let (fresh, ours) = (entry.path(), current.join(entry.file_name()));
        if fresh.is_dir() {
            apply_update(&fresh, &ours, report)?;
        } else if !ours.exists() || entry.file_name() == UNPACKED_MARKER {
            fs::rename(&fresh, &ours)?;
        } else if !same_contents(&fresh, &ours)? {
            fs::rename(&fresh, &ours)?;
            report.changed.push(ours.to_string_lossy().to_string());
        }
    }
    Ok(())
}

/// Extracts one archive next to itself, unless it already has been and hasn't
/// been replaced by a newer copy since. A newer copy is merged into the folder
/// the old one made. Returns that folder, or None if skipped.
fn extract_beside(zip_path: &Path, report: &mut ExtractReport) -> Result<Option<PathBuf>, String> {
    let file = fs::File::open(zip_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    let (dest, result) = archive_target(zip_path, &mut archive).ok_or("Invalid archive path")?;
    let is_update = result.exists();
    if is_update && modified(zip_path) <= unpacked_at(&result) {
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
    let unpacked = if dest == result { tmp.clone() } else { tmp.join(result.file_name().unwrap_or_default()) };
    let moved = if is_update {
        // Unpack archives inside it too, so their files get compared as well.
        let mut nested = ExtractReport::default();
        extract_all(&unpacked, &mut nested);
        report.failed.extend(nested.failed);
        note_removed(&unpacked, &result, report);
        apply_update(&unpacked, &result, report)
    } else {
        fs::rename(&unpacked, &result)
    };
    let _ = fs::remove_dir_all(&tmp);
    moved.map_err(|e| e.to_string())?;
    let _ = fs::write(result.join(UNPACKED_MARKER), "");
    Ok(Some(result))
}

#[derive(Serialize, Default)]
struct ExtractReport {
    /// Archives that were unpacked.
    extracted: Vec<String>,
    /// Archives that could not be unpacked, with the reason.
    failed: Vec<String>,
    /// Files a newer copy of an archive replaced with different contents.
    changed: Vec<String>,
    /// Files a newer copy of an archive no longer has; still on disk.
    removed: Vec<String>,
}

fn extract_all(dir: &Path, report: &mut ExtractReport) {
    let mut zips = Vec::new();
    collect_zips(dir, &mut zips);
    for zip_path in zips {
        match extract_beside(&zip_path, report) {
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

/// Unpacks every ZIP under `dir` (recursively) that hasn't been unpacked yet,
/// or is newer than when it was. The archives themselves are left in place.
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

pub(crate) fn collect_zips(dir: &Path, out: &mut Vec<PathBuf>) {
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
    orca: Option<Vec<String>>,
}

pub(crate) fn which(bin: &str) -> Option<String> {
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

/// A command for a program installed on the system. Inside an AppImage, the
/// environment points at the libraries bundled with 3Devil (`LD_LIBRARY_PATH`,
/// GTK and GIO module paths, ...); system programs such as `flatpak` crash
/// loading those, so they get the environment without them.
pub(crate) fn external(program: &str) -> Command {
    let mut cmd = Command::new(program);
    if let Some(appdir) = std::env::var_os("APPDIR").filter(|d| !d.is_empty()) {
        for (key, value) in outside_appimage(Path::new(&appdir), std::env::vars_os()) {
            match value {
                Some(v) => cmd.env(key, v),
                None => cmd.env_remove(key),
            };
        }
    }
    cmd
}

/// Changes to `vars` that drop every entry under the AppImage mount `appdir`:
/// a new value, or `None` to unset a variable left with nothing.
fn outside_appimage(
    appdir: &Path,
    vars: impl Iterator<Item = (OsString, OsString)>,
) -> Vec<(OsString, Option<OsString>)> {
    let mut changes = Vec::new();
    for (key, value) in vars {
        if ["APPDIR", "APPIMAGE", "ARGV0"].iter().any(|k| key == *k) {
            changes.push((key, None));
            continue;
        }
        let paths: Vec<PathBuf> = std::env::split_paths(&value).collect();
        if !paths.iter().any(|p| p.starts_with(appdir)) {
            continue;
        }
        let kept: Vec<PathBuf> = paths
            .into_iter()
            .filter(|p| !p.as_os_str().is_empty() && !p.starts_with(appdir))
            .collect();
        let value = (!kept.is_empty()).then(|| std::env::join_paths(&kept).ok()).flatten();
        changes.push((key, value));
    }
    changes
}

fn flatpak_app(id: &str) -> Option<Vec<String>> {
    let out = external("flatpak").args(["info", id]).output().ok()?;
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

/// Best-effort lookup of the supported slicers on this machine.
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
            .or_else(|| which("bambustudio"))
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
    let orca = if cfg!(target_os = "windows") {
        first_existing(&[r"C:\Program Files\OrcaSlicer\orca-slicer.exe"])
    } else if cfg!(target_os = "macos") {
        first_existing(&["/Applications/OrcaSlicer.app/Contents/MacOS/OrcaSlicer"])
    } else {
        which("orca-slicer")
            .or_else(|| which("OrcaSlicer"))
            .map(|p| vec![p])
            .or_else(|| flatpak_app("com.orcaslicer.OrcaSlicer"))
    };
    DetectedSlicers { bambu, prusa, orca }
}

/// Launches a slicer with the given model files loaded. `command` is the
/// program followed by any fixed arguments (e.g. `flatpak run <id>`). With
/// `single_instance` (PrusaSlicer only), the files go to a window already
/// opened this way instead of starting another one.
#[tauri::command]
fn open_in_slicer(command: Vec<String>, files: Vec<String>, single_instance: bool) -> Result<(), String> {
    let (program, args) = command.split_first().ok_or("No slicer configured")?;
    let mut child = external(program)
        .args(args)
        .args(single_instance.then_some("--single-instance"))
        .args(&files)
        .spawn()
        .map_err(|e| format!("Could not start {program}: {e}"))?;
    // Reap the process when it exits so it doesn't linger as a zombie.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

/// Opens a folder in the system file browser. Only folders, so this can't be
/// used to launch a file.
#[tauri::command]
fn open_folder(path: String) -> Result<(), String> {
    if !Path::new(&path).is_dir() {
        return Err(format!("{path} isn't there any more"));
    }
    tauri_plugin_opener::open_path(&path, None::<&str>).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_drag::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(printer::Printers::default())
        .manage(camera::Cameras::default())
        .manage(drivethru::DriveThru::default())
        .invoke_handler(tauri::generate_handler![
            storage::load_state,
            storage::save_state,
            storage::state_stamp,
            storage::data_location,
            storage::inspect_shared_folder,
            storage::set_shared_folder,
            storage::add_path_mapping,
            storage::remove_path_mapping,
            scan_models,
            folders::folder_trash_plan,
            folders::trash_folder,
            orca::orca_single_instance,
            orca::set_orca_single_instance,
            read_file_bytes,
            read_model_preview,
            missing_files,
            extract_zip,
            extract_archives,
            detect_slicers,
            open_in_slicer,
            open_folder,
            printer::printer_probe,
            printer::printer_scan,
            printer::printer_connect,
            printer::printer_disconnect,
            prusa::prusa_probe,
            prusa::prusa_connect,
            klipper::klipper_probe,
            klipper::klipper_scan,
            klipper::klipper_connect,
            camera::camera_start,
            camera::camera_frame,
            camera::camera_stop,
            drivethru::drivethru_library,
            drivethru::drivethru_cached_library,
            drivethru::drivethru_product_dir,
            drivethru::drivethru_download
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

    /// Writes an archive dated `secs` from now, as a re-download would be.
    fn write_zip(path: &Path, secs: i64, files: &[(&str, &[u8])]) {
        fs::write(path, zip_bytes(files)).unwrap();
        let now = SystemTime::now();
        let shift = std::time::Duration::from_secs(secs.unsigned_abs());
        let at = if secs < 0 { now - shift } else { now + shift };
        fs::File::options().write(true).open(path).unwrap().set_modified(at).unwrap();
    }

    fn unpack(dir: &Path) -> ExtractReport {
        let mut report = ExtractReport::default();
        extract_all(dir, &mut report);
        report
    }

    #[test]
    fn newer_archive_is_merged_and_differences_reported() {
        let d = tmpdir("update");
        let zip = d.join("Ground_Pack.zip");
        let old: &[(&str, &[u8])] = &[("Ground/same.stl", b"same"), ("Ground/fixed.stl", b"aaaa"), ("Ground/dropped.stl", b"old")];
        write_zip(&zip, 0, old);
        assert_eq!(unpack(&d).extracted.len(), 1);

        // The fix keeps the file's size, as moving a wall keeps its triangle count.
        write_zip(&zip, 5, &[("Ground/same.stl", b"same"), ("Ground/fixed.stl", b"bbbb"), ("Ground/added.stl", b"new")]);
        let r = unpack(&d);
        let ground = d.join("Ground");
        assert_eq!(r.extracted.len(), 1);
        assert_eq!(r.changed, [ground.join("fixed.stl").to_string_lossy().to_string()]);
        assert_eq!(r.removed, [ground.join("dropped.stl").to_string_lossy().to_string()]);
        assert_eq!(fs::read(ground.join("fixed.stl")).unwrap(), b"bbbb");
        assert!(ground.join("added.stl").is_file());
        assert!(ground.join("dropped.stl").is_file(), "files the update dropped stay on disk");
        assert!(!d.join(".3devil-extract-Ground_Pack.zip").exists());
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn archive_is_only_merged_once() {
        let d = tmpdir("update-once");
        let zip = d.join("Ground_Pack.zip");
        write_zip(&zip, -5, &[("Ground/a.stl", b"a")]);
        unpack(&d);

        // A re-zip that changes nothing gives no file a new date to compare against.
        std::thread::sleep(std::time::Duration::from_millis(20));
        fs::write(&zip, zip_bytes(&[("Ground/a.stl", b"a")])).unwrap();
        let first = unpack(&d);
        assert_eq!(first.extracted.len(), 1);
        assert!(first.changed.is_empty() && first.removed.is_empty());
        assert!(unpack(&d).extracted.is_empty());
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn folders_unpacked_before_markers_stay_as_they_are() {
        let d = tmpdir("update-old");
        write_zip(&d.join("Ground_Pack.zip"), -60, &[("Ground/a.stl", b"zip copy")]);
        fs::create_dir_all(d.join("Ground")).unwrap();
        fs::write(d.join("Ground/a.stl"), b"on disk").unwrap();
        assert!(unpack(&d).extracted.is_empty());
        assert_eq!(fs::read(d.join("Ground/a.stl")).unwrap(), b"on disk");
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn updates_reach_files_in_nested_archives() {
        let d = tmpdir("update-nested");
        let zip = d.join("Castle_Pack.zip");
        let inner = zip_bytes(&[("tower.stl", b"aaaa")]);
        write_zip(&zip, 0, &[("Castle/wall.stl", b"wall"), ("Castle/Towers.zip", &inner)]);
        unpack(&d);
        assert!(d.join("Castle/Towers/tower.stl").is_file());

        let inner = zip_bytes(&[("tower.stl", b"bbbb")]);
        write_zip(&zip, 5, &[("Castle/wall.stl", b"wall"), ("Castle/Towers.zip", &inner)]);
        let r = unpack(&d);
        let tower = d.join("Castle/Towers/tower.stl");
        assert!(r.changed.contains(&tower.to_string_lossy().to_string()), "{:?}", r.changed);
        assert!(r.removed.is_empty(), "{:?}", r.removed);
        assert_eq!(fs::read(tower).unwrap(), b"bbbb");
        fs::remove_dir_all(&d).unwrap();
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

    #[test]
    fn external_programs_skip_appimage_libraries() {
        let os = |s: &str| OsString::from(s);
        let vars = [
            ("APPDIR", "/tmp/.mount_x"),
            ("LD_LIBRARY_PATH", "/tmp/.mount_x/usr/lib/:/tmp/.mount_x/lib:/usr/lib"),
            ("GIO_MODULE_DIR", "/tmp/.mount_x//usr/lib/gio/modules"),
            ("PATH", "/tmp/.mount_x/usr/bin/:/home/me/.local/bin:/usr/bin"),
            ("HOME", "/home/me"),
            ("GTK_THEME", "Adwaita:dark"),
        ];
        let changes = outside_appimage(Path::new("/tmp/.mount_x"), vars.iter().map(|(k, v)| (os(k), os(v))));
        assert_eq!(
            changes,
            vec![
                (os("APPDIR"), None),
                (os("LD_LIBRARY_PATH"), Some(os("/usr/lib"))),
                (os("GIO_MODULE_DIR"), None),
                (os("PATH"), Some(os("/home/me/.local/bin:/usr/bin"))),
            ]
        );
    }
}
