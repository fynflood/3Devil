import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { open } from "@tauri-apps/plugin-dialog";
import { api, joinCommand, splitCommand } from "../api";
import type { Store } from "../store";
import { SyncSettings } from "./SyncSettings";
import { enabledSlicers, mainSlicer } from "../slicers";
import { SLICER_IDS, SLICER_NAMES, type SlicerId, type Theme } from "../types";
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
        New versions download in the background; nothing installs until you say so.
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

/**
 * OrcaSlicer's own "Allow only one OrcaSlicer instance" preference. It has no
 * command line switch, so this reads and writes the setting where Orca keeps it.
 */
function OrcaWindowOption({ command, notify }: { command: string[] | null; notify: Props["notify"] }) {
  const [on, setOn] = useState<boolean | null>(null);
  const key = JSON.stringify(command);

  useEffect(() => {
    if (!command) return setOn(null);
    api.orcaSingleInstance(command).then(setOn).catch(() => setOn(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return (
    <>
      <label className="inline small slicer-option">
        <input
          type="checkbox"
          checked={!!on}
          disabled={on === null}
          onChange={(e) => {
            const next = e.target.checked;
            api.setOrcaSingleInstance(command!, next).then(() => setOn(next)).catch((err) => notify(String(err), "error"));
          }}
        />
        Add to the open OrcaSlicer window instead of opening a new one
      </label>
      <p className="muted small slicer-option">
        {on === null
          ? "Open OrcaSlicer once, then come back here to set this."
          : "This is OrcaSlicer's own setting, so close OrcaSlicer before changing it or it may change back."}
      </p>
    </>
  );
}

function SlicerRow({ store, id, notify }: Props & { id: SlicerId }) {
  const { settings } = store.state!;
  const saved = settings.slicers[id] ?? null;
  const [text, setText] = useState(joinCommand(saved));
  const on = enabledSlicers(settings).includes(id);

  const save = (cmd: string[] | null) => {
    store.actions.setSlicer(id, cmd);
    setText(joinCommand(cmd));
  };

  const detect = async () => {
    const found = (await api.detectSlicers())[id];
    if (found) {
      save(found);
      notify(`Found ${SLICER_NAMES[id]}.`);
    } else notify(`${SLICER_NAMES[id]} not found. Use Browse to pick it.`, "error");
  };

  return (
    <div className="slicer-row">
      <label className="inline">
        <input
          type="checkbox"
          checked={on}
          onChange={(e) => {
            const others = enabledSlicers(settings).filter((s) => s !== id);
            store.actions.setEnabledSlicers(e.target.checked ? [...others, id] : others);
            if (e.target.checked && !saved?.length) detect();
          }}
        />
        {SLICER_NAMES[id]}
      </label>
      {on && (
        <div className="btn-row">
          <input
            className="grow mono"
            placeholder="Not set: click Detect or Browse"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onBlur={() => save(splitCommand(text))}
          />
          <button onClick={detect} title={`Look for ${SLICER_NAMES[id]} on this computer`}>Detect</button>
          <button
            title={`Pick the ${SLICER_NAMES[id]} program yourself`}
            onClick={async () => {
              const p = await open({ title: `Locate ${SLICER_NAMES[id]}` });
              if (typeof p === "string") save([p]);
            }}
          >
            Browse
          </button>
        </div>
      )}
      {on && id === "prusa" && (
        <label className="inline small slicer-option">
          <input
            type="checkbox"
            checked={settings.reuseSlicerWindow ?? true}
            onChange={(e) => store.actions.setReuseSlicerWindow(e.target.checked)}
          />
          Add to the window 3Devil opened instead of opening a new one
        </label>
      )}
      {on && id === "orca" && <OrcaWindowOption command={saved} notify={notify} />}
    </div>
  );
}

const THEMES: [Theme, string][] = [
  ["system", "System"],
  ["light", "Light"],
  ["dark", "Dark"],
];

export type SettingsTab = "general" | "slicers" | "sync";

const TABS: [SettingsTab, string][] = [
  ["general", "General"],
  ["slicers", "Slicers"],
  ["sync", "Sync"],
];

export function SettingsView({ store, notify, updater, tab, onTab }: Props & { updater: Updater; tab: SettingsTab; onTab: (tab: SettingsTab) => void }) {
  const { settings } = store.state!;
  const slicers = enabledSlicers(settings);
  return (
    <div className="settings">
      <h2>Settings</h2>
      <div className="filters settings-tabs" role="tablist">
        {TABS.map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={`chip${tab === id ? " active" : ""}`} onClick={() => onTab(id)}>
            {label}
          </button>
        ))}
      </div>
      {tab === "general" && (
        <>
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
          <UpdateSettings store={store} updater={updater} />
        </>
      )}
      {tab === "slicers" && (
        <section>
          <h3>Slicers</h3>
          <p className="muted small">Only the slicers ticked here are offered around the app.</p>
          {SLICER_IDS.map((id) => (
            <SlicerRow key={id} id={id} store={store} notify={notify} />
          ))}
          <p className="muted small">
            Each one is a program followed by any fixed arguments; model files are added at the end. For a Flatpak, use{" "}
            <code>flatpak run</code> and its app id.
          </p>
          {slicers.length > 1 && (
            <label className="inline">
              Default slicer for “Send to”
              <select value={mainSlicer(settings) ?? ""} onChange={(e) => store.actions.setDefaultSlicer(e.target.value as SlicerId)}>
                {slicers.map((id) => (
                  <option key={id} value={id}>{SLICER_NAMES[id]}</option>
                ))}
              </select>
            </label>
          )}
        </section>
      )}
      {tab === "sync" && <SyncSettings store={store} notify={notify} />}
    </div>
  );
}
