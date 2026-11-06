import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { documentDir, join } from "@tauri-apps/api/path";
import type { Store } from "../store";

/** Library App Key and download folder for the DriveThruRPG library. */
export function DriveThruSettingsSection({ store }: { store: Store }) {
  const saved = store.state!.settings.driveThru;
  const [key, setKey] = useState(saved?.apiKey ?? "");

  const saveKey = async () => {
    const libraryPath = saved?.libraryPath || (await join(await documentDir(), "DriveThruRPG"));
    store.actions.setDriveThru({ apiKey: key.trim(), libraryPath });
  };

  return (
    <section>
      <h3>DriveThruRPG</h3>
      <p className="muted small">
        Generate a <strong>Library App Key</strong> under “Library App Keys” in your{" "}
        <button className="link" onClick={() => openUrl("https://www.drivethrurpg.com/en/account/settings")}>account settings</button>{" "}
        and paste it here. Your purchases then appear in this library, where any product can become a project.
      </p>
      <label className="block">
        Library App Key
        <div className="btn-row">
          <input
            className="grow mono"
            type="password"
            autoComplete="off"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="Paste your key"
          />
          <button className="primary" disabled={key.trim() === (saved?.apiKey ?? "")} onClick={saveKey}>Save</button>
        </div>
      </label>
      <label className="block">
        Download folder
        <div className="btn-row">
          <input className="grow mono" readOnly value={saved?.libraryPath ?? ""} placeholder="Set when you save a key (Documents/DriveThruRPG)" />
          <button
            onClick={async () => {
              const dir = await open({ directory: true, title: "Folder for DriveThruRPG downloads" });
              if (typeof dir === "string") store.actions.setDriveThru({ libraryPath: dir });
            }}
          >
            Browse
          </button>
        </div>
      </label>
      <p className="muted small">
        Products download to <code>&lt;folder&gt;/&lt;publisher&gt;/&lt;product&gt;</code>; files already there and up to date are skipped.
        DriveThruRPG's library API is unofficial (the same one their app uses), so this may break if they change it.
      </p>
    </section>
  );
}
