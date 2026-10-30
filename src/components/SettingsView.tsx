import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api, joinCommand, splitCommand } from "../api";
import type { Store } from "../store";
import { PrinterSettings } from "./PrinterSettings";
import { DriveThruSettingsSection } from "./DriveThruSettings";
import { SLICER_NAMES, type SlicerId } from "../types";

interface Props {
  store: Store;
  notify: (msg: string, kind?: "info" | "error") => void;
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

export function SettingsView({ store, notify }: Props) {
  const { settings } = store.state!;
  return (
    <div className="settings">
      <h2>Settings</h2>
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
      </section>
      <PrinterSettings store={store} notify={notify} />
      <DriveThruSettingsSection store={store} />
    </div>
  );
}
