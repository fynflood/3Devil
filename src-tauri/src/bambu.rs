//! Bambu Studio's print preset. It has no command line option for this: a new
//! window starts on the preset named in its settings file, so that one value
//! is changed just before opening one. The file also holds printer access
//! codes, so nothing else in it is touched and none of it leaves this module.

use serde_json::Value;
use std::collections::BTreeSet;
use std::fs;
use std::path::PathBuf;

const CONF: &str = "BambuStudio.conf";

/// Where the Bambu Studio started by `command` keeps its settings.
fn config_dir(command: &[String]) -> Option<PathBuf> {
    if let Some(i) = command.iter().position(|a| a == "--datadir") {
        return Some(PathBuf::from(command.get(i + 1)?));
    }
    let run = command.iter().position(|a| a == "run").filter(|_| command[0].ends_with("flatpak"));
    let base = match run {
        Some(i) => {
            let app = command[i + 1..].iter().find(|a| !a.starts_with('-'))?;
            dirs::home_dir()?.join(".var/app").join(app).join("config")
        }
        None => dirs::config_dir()?,
    };
    Some(base.join("BambuStudio"))
}

/// The closing quote of the string opening at `start`.
fn string_end(text: &[u8], start: usize) -> Option<usize> {
    let mut i = start + 1;
    while i < text.len() {
        match text[i] {
            b'\\' => i += 2,
            b'"' => return Some(i),
            _ => i += 1,
        }
    }
    None
}

/// The byte range of the quoted value of `process` directly inside `presets`.
fn process_value(text: &str) -> Option<(usize, usize)> {
    let bytes = text.as_bytes();
    let mut path: Vec<Option<&str>> = Vec::new();
    let mut key: Option<&str> = None;
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'{' => path.push(key.take()),
            b'[' => path.push(None),
            b'}' | b']' => {
                path.pop();
            }
            b',' => key = None,
            b'"' => {
                let end = string_end(bytes, i)?;
                let next = text[end + 1..].trim_start();
                if next.starts_with(':') {
                    key = Some(&text[i + 1..end]);
                } else {
                    if key == Some("process") && path.len() == 2 && path[1] == Some("presets") {
                        return Some((i, end + 1));
                    }
                    key = None;
                }
                i = end;
            }
            _ => {}
        }
        i += 1;
    }
    None
}

/// The settings with just the preset changed, or None if that can't be done safely.
fn with_process(text: &str, name: &str) -> Option<String> {
    let (start, end) = process_value(text)?;
    let value = serde_json::to_string(name).ok()?;
    let edited = format!("{}{value}{}", &text[..start], &text[end..]);
    let parsed: Value = serde_json::from_str(&edited).ok()?;
    (parsed["presets"]["process"].as_str() == Some(name)).then_some(edited)
}

/// A person's own print presets, by name. Their files are per account.
fn user_presets(dir: &std::path::Path) -> Vec<String> {
    let mut names = BTreeSet::new();
    let Ok(accounts) = fs::read_dir(dir.join("user")) else { return Vec::new() };
    for account in accounts.flatten() {
        let Ok(files) = fs::read_dir(account.path().join("process")) else { continue };
        for path in files.flatten().map(|f| f.path()) {
            if path.extension().is_none_or(|e| e != "json") {
                continue;
            }
            let named = fs::read(&path).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok());
            let name = named.and_then(|v| v["name"].as_str().map(String::from));
            if let Some(name) = name.or_else(|| Some(path.file_stem()?.to_string_lossy().to_string())) {
                names.insert(name);
            }
        }
    }
    names.into_iter().collect()
}

#[tauri::command]
pub fn bambu_presets(command: Vec<String>) -> Vec<String> {
    config_dir(&command).map(|d| user_presets(&d)).unwrap_or_default()
}

/// Makes `name` the preset the next new Bambu Studio window starts on.
#[tauri::command]
pub fn set_bambu_preset(command: Vec<String>, name: String) -> Result<(), String> {
    let path = config_dir(&command).ok_or("Couldn't find Bambu Studio's settings.")?.join(CONF);
    let text = fs::read_to_string(&path).map_err(|_| "Couldn't read Bambu Studio's settings. Open it once first.")?;
    let edited = with_process(&text, &name).ok_or("Bambu Studio's settings aren't in a form 3Devil can change.")?;
    let scratch = path.with_extension("conf.3devil");
    fs::write(&scratch, edited).map_err(|e| e.to_string())?;
    fs::rename(&scratch, &path).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const CONF_TEXT: &str = "{\n    \"access_code\": {\n        \"SERIAL\": \"12345678\"\n    },\n    \"app\": {\n        \"process\": \"not this one\",\n        \"version\": \"02.09\"\n    },\n    \"models\": [\n        {\n            \"process\": \"nor this\"\n        }\n    ],\n    \"presets\": {\n        \"filaments\": [\n            \"Bambu PLA, Basic\"\n        ],\n        \"machine\": \"X1 Carbon\",\n        \"process\": \".2 8% Cubic, Brim painted\"\n    },\n    \"recent\": {\n        \"process\": \"nor that\"\n    }\n}\n";

    fn cmd(args: &[&str]) -> Vec<String> {
        args.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn changes_only_the_preset() {
        let edited = with_process(CONF_TEXT, "Default").unwrap();
        assert_eq!(edited, CONF_TEXT.replace("\".2 8% Cubic, Brim painted\"", "\"Default\""));
        assert_eq!(with_process(&edited, ".2 8% Cubic, Brim painted").unwrap(), CONF_TEXT);
    }

    #[test]
    fn copes_with_awkward_names() {
        for name in ["a \"quoted\" one", "back\\slash", "commas, and } braces", "0.20mm Standard @BBL X1C - Copy", "日本語"] {
            let edited = with_process(CONF_TEXT, name).unwrap();
            let v: Value = serde_json::from_str(&edited).unwrap();
            assert_eq!(v["presets"]["process"], name);
            assert_eq!(v["access_code"]["SERIAL"], "12345678");
            assert_eq!(with_process(&edited, name).unwrap(), edited);
        }
    }

    #[test]
    fn leaves_what_it_does_not_understand() {
        assert_eq!(with_process("{}", "x"), None);
        assert_eq!(with_process("not json", "x"), None);
        assert_eq!(with_process("{\"presets\": {\"machine\": \"m\"}}", "x"), None);
        assert_eq!(with_process("{\"process\": \"top\"}", "x"), None);
        let footer = format!("{CONF_TEXT}# MD5 checksum 0123\n");
        assert_eq!(with_process(&footer, "x"), None);
    }

    #[test]
    fn lists_people_their_own_presets() {
        let dir = std::env::temp_dir().join(format!("threedevil-bambu-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let process = dir.join("user/123/process");
        fs::create_dir_all(&process).unwrap();
        fs::write(process.join("file name.json"), r#"{"name": "Inside name"}"#).unwrap();
        fs::write(process.join("No name.json"), "{}").unwrap();
        fs::write(process.join("Broken.json"), "not json").unwrap();
        fs::write(process.join("Skip.info"), "x").unwrap();
        assert_eq!(user_presets(&dir), vec!["Broken", "Inside name", "No name"]);
        assert!(user_presets(&dir.join("missing")).is_empty());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn writes_the_preset_for_the_next_window() {
        let dir = std::env::temp_dir().join(format!("threedevil-bambu-set-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(CONF), CONF_TEXT).unwrap();
        let command = cmd(&["bambu-studio", "--datadir", dir.to_str().unwrap()]);
        set_bambu_preset(command.clone(), "Default".into()).unwrap();
        assert!(fs::read_to_string(dir.join(CONF)).unwrap().contains("\"process\": \"Default\""));
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
        fs::remove_dir_all(&dir).unwrap();
        assert!(set_bambu_preset(command, "Default".into()).is_err());
    }

    /// Set BAMBU_CONF to a real settings file. It's only read, and the checks
    /// report pass or fail so a failure can't print what's in it.
    #[test]
    #[ignore]
    fn real_settings_file() {
        let text = fs::read_to_string(std::env::var("BAMBU_CONF").unwrap()).unwrap();
        let before: Value = serde_json::from_str(&text).unwrap();
        let current = before["presets"]["process"].as_str().unwrap().to_string();
        let edited = with_process(&text, "3Devil test name").expect("couldn't edit");
        let mut after: Value = serde_json::from_str(&edited).unwrap();
        assert!(after["presets"]["process"] == "3Devil test name");
        after["presets"]["process"] = Value::String(current.clone());
        assert!(after == before, "something other than the preset changed");
        assert!(with_process(&edited, &current).expect("couldn't restore") == text, "not restored exactly");
    }

    #[test]
    fn finds_the_settings_for_each_kind_of_install() {
        let home = dirs::home_dir().unwrap();
        assert_eq!(
            config_dir(&cmd(&["flatpak", "run", "com.bambulab.BambuStudio"])).unwrap(),
            home.join(".var/app/com.bambulab.BambuStudio/config/BambuStudio"),
        );
        assert_eq!(config_dir(&cmd(&["bambu-studio"])).unwrap(), dirs::config_dir().unwrap().join("BambuStudio"));
    }
}
