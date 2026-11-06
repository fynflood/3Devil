//! Moving a project's folder to the system Trash.

use crate::{archive_target, collect_zips};
use serde::Serialize;
use std::fs;
use std::path::{Component, Path, PathBuf};

/// What moving a folder to the Trash would involve.
#[derive(Serialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TrashPlan {
    files: u64,
    bytes: u64,
    /// ZIPs elsewhere in the project that unpack into the folder. They go too,
    /// or the next rescan would unpack them again.
    zips: Vec<String>,
    /// Why the folder can't be moved, if it can't.
    blocked: Option<String>,
    #[serde(skip)]
    paths: Vec<PathBuf>,
}

impl TrashPlan {
    fn blocked(reason: &str) -> Self {
        Self { blocked: Some(reason.into()), ..Self::default() }
    }

    fn tally(&mut self, dir: &Path) {
        let Ok(entries) = fs::read_dir(dir) else { return };
        for entry in entries.flatten() {
            let Ok(meta) = fs::symlink_metadata(entry.path()) else { continue };
            if meta.is_dir() {
                self.tally(&entry.path());
            } else {
                self.files += 1;
                self.bytes += meta.len();
            }
        }
    }
}

/// Whether a folder is too broad to throw away: one of the places a person
/// keeps everything, somewhere that holds one, or anything near the top level.
fn too_broad(path: &Path) -> bool {
    let keep = [
        dirs::home_dir(),
        dirs::desktop_dir(),
        dirs::document_dir(),
        dirs::download_dir(),
        dirs::picture_dir(),
        dirs::video_dir(),
        dirs::audio_dir(),
        dirs::public_dir(),
        dirs::template_dir(),
        dirs::data_dir().map(|d| d.join("tech.ouija.threedevil")),
    ];
    let depth = path.components().filter(|c| matches!(c, Component::Normal(_))).count();
    depth < 2 || keep.into_iter().flatten().filter_map(|d| d.canonicalize().ok()).any(|d| d.starts_with(path))
}

/// ZIPs under `roots`, outside `path`, that unpack into `path`.
fn source_zips(path: &Path, roots: &[PathBuf]) -> Vec<PathBuf> {
    let mut zips = Vec::new();
    for root in roots {
        collect_zips(root, &mut zips);
    }
    zips.sort();
    zips.dedup();
    zips.retain(|zip| {
        let Ok(file) = fs::File::open(zip) else { return false };
        let Ok(mut archive) = zip::ZipArchive::new(file) else { return false };
        !zip.starts_with(path) && archive_target(zip, &mut archive).is_some_and(|(_, made)| made.starts_with(path))
    });
    zips
}

fn plan(path: &str, roots: &[String]) -> TrashPlan {
    let Ok(path) = Path::new(path).canonicalize() else {
        return TrashPlan::blocked("the folder isn't on this computer.");
    };
    let roots: Vec<_> = roots.iter().filter_map(|r| Path::new(r).canonicalize().ok()).collect();
    if !path.is_dir() {
        return TrashPlan::blocked("that isn't a folder.");
    }
    if !roots.iter().any(|r| path.starts_with(r)) {
        return TrashPlan::blocked("it isn't one of this project's folders.");
    }
    if too_broad(&path) {
        return TrashPlan::blocked("it's a main folder on this computer, not just this project's files.");
    }
    let mut plan = TrashPlan::default();
    plan.tally(&path);
    let zips = source_zips(&path, &roots);
    plan.zips = zips.iter().filter_map(|z| Some(z.file_name()?.to_string_lossy().to_string())).collect();
    plan.paths = zips;
    plan.paths.push(path);
    plan
}

#[tauri::command]
pub async fn folder_trash_plan(path: String, roots: Vec<String>) -> Result<TrashPlan, String> {
    tauri::async_runtime::spawn_blocking(move || plan(&path, &roots)).await.map_err(|e| e.to_string())
}

/// Moves a folder to the Trash after checking it again, whatever was shown
/// earlier: nothing here deletes files for good.
#[tauri::command]
pub async fn trash_folder(path: String, roots: Vec<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let plan = plan(&path, &roots);
        if let Some(reason) = plan.blocked {
            return Err(format!("Can't move this to the Trash: {reason}"));
        }
        trash::delete_all(&plan.paths).map_err(|e| format!("Couldn't move this to the Trash, so nothing was removed: {e}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn tmpdir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("threedevil-trash-{name}-{}", std::process::id())).join("library");
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d.canonicalize().unwrap()
    }

    fn put(path: &Path, text: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    fn zip_of(path: &Path, entry: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut w = zip::ZipWriter::new(fs::File::create(path).unwrap());
        w.start_file(entry, zip::write::SimpleFileOptions::default()).unwrap();
        w.write_all(b"model").unwrap();
        w.finish().unwrap();
    }

    fn s(p: &Path) -> String {
        p.to_string_lossy().to_string()
    }

    #[test]
    fn counts_everything_in_the_folder() {
        let d = tmpdir("count");
        put(&d.join("Set/Walls/a.stl"), "12345");
        put(&d.join("Set/Walls/notes/readme.pdf"), "123");
        let p = plan(&s(&d.join("Set/Walls")), &[s(&d.join("Set"))]);
        assert_eq!(p.blocked, None);
        assert_eq!((p.files, p.bytes), (2, 8));
        assert_eq!(p.paths, vec![d.join("Set/Walls")]);
    }

    #[test]
    fn only_folders_inside_the_project() {
        let d = tmpdir("outside");
        put(&d.join("Set/a.stl"), "x");
        put(&d.join("Other/b.stl"), "x");
        assert!(plan(&s(&d.join("Other")), &[s(&d.join("Set"))]).blocked.is_some());
        assert!(plan(&s(&d.join("Set/../Other")), &[s(&d.join("Set"))]).blocked.is_some());
        assert!(plan(&s(&d.join("Set")), &[]).blocked.is_some());
        assert!(plan(&s(&d.join("Set")), &[s(&d.join("Set"))]).blocked.is_none());
    }

    #[test]
    fn missing_folders_and_files_are_refused() {
        let d = tmpdir("missing");
        put(&d.join("Set/a.stl"), "x");
        assert!(plan(&s(&d.join("Gone")), &[s(&d)]).blocked.is_some());
        assert!(plan(&s(&d.join("Set/a.stl")), &[s(&d)]).blocked.is_some());
    }

    #[cfg(unix)]
    #[test]
    fn a_link_cannot_lead_outside_the_project() {
        let d = tmpdir("link");
        put(&d.join("Set/a.stl"), "x");
        put(&d.join("Elsewhere/b.stl"), "x");
        std::os::unix::fs::symlink(d.join("Elsewhere"), d.join("Set/Walls")).unwrap();
        assert!(plan(&s(&d.join("Set/Walls")), &[s(&d.join("Set"))]).blocked.is_some());
    }

    #[test]
    fn main_folders_are_too_broad() {
        assert!(too_broad(Path::new("/")));
        assert!(too_broad(Path::new("/home")));
        assert!(too_broad(Path::new("/mnt")));
        let home = dirs::home_dir().unwrap().canonicalize().unwrap();
        assert!(too_broad(&home));
        assert!(too_broad(home.parent().unwrap()));
        if let Some(docs) = dirs::document_dir().and_then(|d| d.canonicalize().ok()) {
            assert!(too_broad(&docs));
            assert!(!too_broad(&docs.join("Dragon Workshop/Tavern")));
        }
        let plan = plan(&s(&home), &[s(&home)]);
        assert!(plan.blocked.is_some() && plan.paths.is_empty());
    }

    #[test]
    fn takes_the_zip_a_folder_came_from() {
        let d = tmpdir("zip");
        zip_of(&d.join("Set/Walls.zip"), "Walls/a.stl");
        zip_of(&d.join("Set/Doors.zip"), "Doors/b.stl");
        put(&d.join("Set/Walls/a.stl"), "x");
        put(&d.join("Set/Doors/b.stl"), "x");
        let p = plan(&s(&d.join("Set/Walls")), &[s(&d.join("Set"))]);
        assert_eq!(p.zips, vec!["Walls.zip"]);
        assert_eq!(p.paths, vec![d.join("Set/Walls.zip"), d.join("Set/Walls")]);
    }

    #[test]
    fn leaves_a_zip_that_also_made_the_rest_of_its_folder() {
        let d = tmpdir("parent");
        zip_of(&d.join("Set/Floor1.zip"), "Floor1/Walls/a.stl");
        put(&d.join("Set/Floor1/Walls/a.stl"), "x");
        put(&d.join("Set/Floor1/Doors/b.stl"), "x");
        assert!(plan(&s(&d.join("Set/Floor1/Walls")), &[s(&d.join("Set"))]).zips.is_empty());
    }

    #[test]
    fn a_zip_inside_the_folder_is_not_listed_twice() {
        let d = tmpdir("inside");
        zip_of(&d.join("Set/Walls/Walls.zip"), "Walls/a.stl");
        assert!(plan(&s(&d.join("Set/Walls")), &[s(&d.join("Set"))]).zips.is_empty());
    }

    /// Moves real files to the Trash. Set XDG_DATA_HOME to a scratch folder on
    /// the same disk as TMPDIR to keep them out of the real one.
    #[test]
    #[ignore]
    fn really_moves_to_the_trash() {
        let d = tmpdir("real");
        zip_of(&d.join("Set/Walls.zip"), "Walls/a.stl");
        put(&d.join("Set/Walls/a.stl"), "x");
        put(&d.join("Set/Doors/b.stl"), "x");
        let (path, roots) = (s(&d.join("Set/Walls")), vec![s(&d.join("Set"))]);
        tauri::async_runtime::block_on(trash_folder(path, roots)).unwrap();
        assert!(!d.join("Set/Walls").exists() && !d.join("Set/Walls.zip").exists());
        assert!(d.join("Set/Doors/b.stl").exists());
        let trash = PathBuf::from(std::env::var("XDG_DATA_HOME").unwrap()).join("Trash/files");
        assert!(trash.join("Walls/a.stl").exists() && trash.join("Walls.zip").exists());
    }
}
