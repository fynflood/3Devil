//! OrcaSlicer's "Allow only one OrcaSlicer instance" preference. With it on, a
//! second launch hands its files to the window that's already open. Orca has no
//! command line switch for this, so the setting is changed where Orca keeps it.

use std::fs;
use std::path::PathBuf;

const KEY: &str = "\"single_instance\"";

/// Where the OrcaSlicer started by `command` keeps its settings.
fn config_path(command: &[String]) -> Option<PathBuf> {
    if let Some(i) = command.iter().position(|a| a == "--datadir") {
        return Some(PathBuf::from(command.get(i + 1)?).join("OrcaSlicer.conf"));
    }
    let run = command.iter().position(|a| a == "run").filter(|_| command[0].ends_with("flatpak"));
    let base = match run {
        Some(i) => {
            let app = command[i + 1..].iter().find(|a| !a.starts_with('-'))?;
            dirs::home_dir()?.join(".var/app").join(app).join("config")
        }
        None => dirs::config_dir()?,
    };
    Some(base.join("OrcaSlicer").join("OrcaSlicer.conf"))
}

/// The byte range of the setting's value in the file.
fn value_range(text: &str) -> Option<(usize, usize)> {
    let key = text.find(KEY)? + KEY.len();
    let colon = key + text[key..].find(':')? + 1;
    let start = colon + text[colon..].find(|c: char| !c.is_whitespace())?;
    let end = start + text[start..].find(|c: char| c == ',' || c == '}' || c.is_whitespace())?;
    Some((start, end))
}

fn read_value(text: &str) -> Option<bool> {
    let (start, end) = value_range(text)?;
    Some(text[start..end].trim_matches('"') == "true")
}

/// The file with just this value changed, so nothing else of Orca's moves.
fn with_value(text: &str, on: bool) -> Option<String> {
    let (start, end) = value_range(text)?;
    let quote = if text[start..end].starts_with('"') { "\"" } else { "" };
    let edited = format!("{}{quote}{on}{quote}{}", &text[..start], &text[end..]);
    serde_json::from_str::<serde_json::Value>(&edited).ok()?;
    Some(edited)
}

/// The preference, or None if OrcaSlicer hasn't saved its settings yet.
#[tauri::command]
pub fn orca_single_instance(command: Vec<String>) -> Option<bool> {
    read_value(&fs::read_to_string(config_path(&command)?).ok()?)
}

#[tauri::command]
pub fn set_orca_single_instance(command: Vec<String>, on: bool) -> Result<(), String> {
    let path = config_path(&command).ok_or("Couldn't find OrcaSlicer's settings.")?;
    let text = fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    let edited = with_value(&text, on).ok_or("OrcaSlicer's settings aren't in a form 3Devil can change. Use its Preferences instead.")?;
    let scratch = path.with_extension("conf.3devil");
    fs::write(&scratch, edited).map_err(|e| e.to_string())?;
    fs::rename(&scratch, &path).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const CONF: &str = "{\n\t\"app\": {\n\t\t\"language\": \"en\",\n\t\t\"single_instance\": false,\n\t\t\"version\": \"2.4.2\"\n\t}\n}\n";
    fn cmd(args: &[&str]) -> Vec<String> {
        args.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn changes_only_the_one_value() {
        assert_eq!(read_value(CONF), Some(false));
        let on = with_value(CONF, true).unwrap();
        assert_eq!(on, CONF.replace("\"single_instance\": false", "\"single_instance\": true"));
        assert_eq!(read_value(&on), Some(true));
        assert_eq!(with_value(&on, false).unwrap(), CONF);
    }

    #[test]
    fn keeps_a_quoted_value_quoted() {
        let old = CONF.replace(": false", ": \"false\"");
        assert_eq!(read_value(&old), Some(false));
        assert!(with_value(&old, true).unwrap().contains("\"single_instance\": \"true\""));
    }

    #[test]
    fn leaves_files_it_does_not_understand() {
        assert_eq!(read_value("{}"), None);
        assert_eq!(with_value("{}", true), None);
        assert_eq!(with_value("\"single_instance\": false\n# not json", true), None);
    }

    #[test]
    fn finds_the_settings_for_each_kind_of_install() {
        let home = dirs::home_dir().unwrap();
        assert_eq!(
            config_path(&cmd(&["flatpak", "run", "--branch=stable", "com.orcaslicer.OrcaSlicer"])).unwrap(),
            home.join(".var/app/com.orcaslicer.OrcaSlicer/config/OrcaSlicer/OrcaSlicer.conf"),
        );
        assert_eq!(
            config_path(&cmd(&["orca-slicer", "--datadir", "/data/orca"])).unwrap(),
            PathBuf::from("/data/orca/OrcaSlicer.conf"),
        );
        assert_eq!(
            config_path(&cmd(&["orca-slicer"])).unwrap(),
            dirs::config_dir().unwrap().join("OrcaSlicer/OrcaSlicer.conf"),
        );
    }

    /// Set ORCA_DATADIR to a folder holding a copy of a real OrcaSlicer.conf.
    #[test]
    #[ignore]
    fn real_settings_file() {
        let dir = std::env::var("ORCA_DATADIR").unwrap();
        let command = cmd(&["orca-slicer", "--datadir", &dir]);
        let before = orca_single_instance(command.clone()).unwrap();
        set_orca_single_instance(command.clone(), !before).unwrap();
        assert_eq!(orca_single_instance(command.clone()), Some(!before));
        set_orca_single_instance(command.clone(), before).unwrap();
        assert_eq!(orca_single_instance(command), Some(before));
    }
}
