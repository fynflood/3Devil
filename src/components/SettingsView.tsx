import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { open } from "@tauri-apps/plugin-dialog";
import { api, joinCommand, splitCommand } from "../api";
import type { Store } from "../store";
import { PrinterSettings } from "./PrinterSettings";
import { DriveThruSettingsSection } from "./DriveThruSettings";
import { SyncSettings } from "./SyncSettings";
import { SLICER_NAMES, type SlicerId, type Theme } from "../types";
import type { Updater } from "../updater";
import { DEFAULT_THEME } from "../theme";

interface Props {
  store: Store;
  notify: (msg: string, kind?: "info" | "error") => void;
}

function UpdateSettings({ store, updater }: { store: Store; updater: Updater }) {
  const [version, setVersion] = useState("");
  useEffect(() => {
    getVersion().then(setVersion).catch(() => undefined);
  }, []);
  const { state } = updater;
  const status =
    state.status === "checking" ? "Checking…"
    : state.status === "current" ? "You have the latest version."
    : state.status === "downloading" ? `Downloading ${state.version}…`
    : state.status === "ready" ? `${state.version} is downloaded and ready to install.`
    : state.status === "installing" ? `Installing ${state.version}…`
    : state.status === "error" ? `Couldn't check for updates: ${state.message}`
    : "";
  return (
    <section>
      <h3>Updates</h3>
      <p className="small">3Devil {version}</p>
      <label className="inline">
        <input
          type="checkbox"
          checked={store.state!.settings.autoUpdate ?? true}
          onChange={(e) => store.actions.setAutoUpdate(e.target.checked)}
        />
        Check for updates automatically
      </label>
      <p className="muted small">
        New versions download in the background; nothing installs until you click <em>Restart to update</em>.
      </p>
      <div className="btn-row">
        <button onClick={updater.checkNow} disabled={state.status === "checking" || state.status === "downloading" || state.status === "installing"}>
          Check now
        </button>
        {state.status === "ready" && <button className="primary" onClick={updater.installAndRestart}>Restart to update</button>}
      </div>
      {status && <p className={`small ${state.status === "error" ? "error-text" : "muted"}`}>{status}</p>}
    </section>
  );
}

function SlicerRow({ store, id, notify }: Props & { id: SlicerId }) {
  const saved = store.state!.settings.slicers[id];
  const [text, setText] = useState(joinCommand(saved));

  const save = (cmd: string[] | null) => {
    store.actions.setSlicer(id, cmd);
    setText(joinCommand(cmd));
  };

  return (
    <div className="setting">
      <h4>{SLICER_NAMES[id]}</h4>
      <div className="btn-row">
        <input
          className="grow mono"
          placeholder="Not configured — click Detect or Browse"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => save(splitCommand(text))}
        />
        <button
          onClick={async () => {
            const found = (await api.detectSlicers())[id];
            if (found) {
              save(found);
              notify(`Found ${SLICER_NAMES[id]}.`);
            } else notify(`${SLICER_NAMES[id]} not found. Use Browse to pick it.`, "error");
          }}
        >
          Detect
        </button>
        <button
          onClick={async () => {
            const p = await open({ title: `Locate ${SLICER_NAMES[id]}` });
            if (typeof p === "string") save([p]);
          }}
        >
          Browse
        </button>
      </div>
      <p className="muted small">
        Program followed by any fixed arguments; model files are appended. Flatpak example:{" "}
        <code>flatpak run {id === "bambu" ? "com.bambulab.BambuStudio" : "com.prusa3d.PrusaSlicer"}</code>
      </p>
    </div>
  );
}

const THEMES: [Theme, string][] = [
  ["system", "System"],
  ["light", "Light"],
  ["dark", "Dark"],
];

export function SettingsView({ store, notify, updater }: Props & { updater: Updater }) {
  const { settings } = store.state!;
  return (
    <div className="settings">
      <h2>Settings</h2>
      <section>
        <h3>Appearance</h3>
        <div className="filters" role="radiogroup" aria-label="Theme">
          {THEMES.map(([id, label]) => (
            <button
              key={id}
              role="radio"
              aria-checked={(settings.theme ?? DEFAULT_THEME) === id}
              className={`chip${(settings.theme ?? DEFAULT_THEME) === id ? " active" : ""}`}
              onClick={() => store.actions.setTheme(id)}
            >
              {label}
            </button>
          ))}
        </div>
        <p className="muted small">System follows your computer's light or dark setting.</p>
      </section>
      <section>
        <h3>Slicers</h3>
        {(Object.keys(SLICER_NAMES) as SlicerId[]).map((id) => (
          <SlicerRow key={id} id={id} store={store} notify={notify} />
        ))}
        <label className="inline">
          Default slicer for “Send to”
          <select value={settings.defaultSlicer} onChange={(e) => store.actions.setDefaultSlicer(e.target.value as SlicerId)}>
            {(Object.keys(SLICER_NAMES) as SlicerId[]).map((id) => (
              <option key={id} value={id}>{SLICER_NAMES[id]}</option>
            ))}
          </select>
        </label>
        <label className="inline">
          <input
            type="checkbox"
            checked={settings.reuseSlicerWindow ?? true}
            onChange={(e) => store.actions.setReuseSlicerWindow(e.target.checked)}
          />
          Add files to the PrusaSlicer window that's already open
        </label>
        <p className="muted small">
          Each send goes into the same PrusaSlicer window instead of opening a new one. A window you opened yourself (not
          from 3Devil) may not pick them up; close it and the next send opens one that will. Bambu Studio can't do this, so
          to put several parts in one Bambu window, tick them all and send them together.
        </p>
      </section>
      <PrinterSettings store={store} notify={notify} />
      <DriveThruSettingsSection store={store} />
      <SyncSettings store={store} notify={notify} />
      <UpdateSettings store={store} updater={updater} />
    </div>
  );
}
