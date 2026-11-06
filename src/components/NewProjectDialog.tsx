import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, basename } from "../api";
import { describeScan, type Store } from "../store";

interface Props {
  store: Store;
  initialSource: Source;
  onClose: () => void;
  onCreated: (id: string) => void;
  notify: (msg: string, kind?: "info" | "error") => void;
}

export type Source = "folder" | "zip" | "empty";

export function NewProjectDialog({ store, initialSource, onClose, onCreated, notify }: Props) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [source, setSource] = useState<Source>(initialSource);
  const [path, setPath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const pick = async () => {
    const p =
      source === "folder"
        ? await open({ directory: true, title: "Choose the model folder" })
        : await open({ title: "Choose a ZIP download", filters: [{ name: "ZIP archive", extensions: ["zip", "ZIP"] }] });
    if (typeof p === "string") {
      setPath(p);
      if (!name) setName(basename(p).replace(/\.zip$/i, "").replace(/[_-]+/g, " "));
    }
  };

  const create = async () => {
    setBusy(true);
    try {
      let folder = path;
      if (source === "zip" && path) folder = await api.extractZip(path);
      const id = store.actions.createProject({ name: name.trim() || "Untitled build", description, sourceUrl });
      if (source !== "empty" && folder) {
        const r = await store.actions.addFolder(id, folder);
        notify(`Created project: ${describeScan(r)}`, r.failed.length ? "error" : "info");
      }
      onCreated(id);
    } catch (e) {
      notify(String(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const needsPath = source !== "empty" && !path;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>New project</h2>
        <div className="segmented">
          {(["folder", "zip", "empty"] as Source[]).map((s) => (
            <button
              key={s}
              className={source === s ? "active" : ""}
              title={{ folder: "Use a folder of model files. ZIPs inside are unpacked", zip: "Unpack a ZIP download and use its models", empty: "Start with no parts and add them later" }[s]}
              onClick={() => { setSource(s); setPath(null); }}
            >
              {{ folder: "From folder", zip: "From ZIP", empty: "Empty" }[s]}
            </button>
          ))}
        </div>
        {source !== "empty" && (
          <div className="btn-row">
            <input className="grow mono" readOnly value={path ?? ""} placeholder={source === "zip" ? "No ZIP chosen" : "No folder chosen"} />
            <button onClick={pick}>Browse…</button>
          </div>
        )}
        {source === "folder" && (
          <p className="muted small">ZIPs in the folder are unpacked next to themselves; the originals are kept.</p>
        )}
        {source === "zip" && (
          <p className="muted small">
            The ZIP is extracted next to itself (nested ZIPs too). Works with downloads from your{" "}
            <button className="link" onClick={() => openUrl("https://www.drivethrurpg.com/en/library")}>DriveThruRPG library</button>,
            MyMiniFactory, Printables and similar.
          </p>
        )}
        <label className="block">Name<input value={name} onChange={(e) => setName(e.target.value)} placeholder="Dwarven Forge Castle" autoFocus /></label>
        <label className="block">Description<input value={description} onChange={(e) => setDescription(e.target.value)} /></label>
        <label className="block">Source URL<input value={sourceUrl} onChange={(e) => setSourceUrl(e.target.value)} placeholder="https://www.drivethrurpg.com/en/product/…" /></label>
        <div className="btn-row end">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={busy || needsPath} onClick={create}>{busy ? (source === "empty" ? "Creating…" : "Importing… (unpacking ZIPs)") : "Create"}</button>
        </div>
      </div>
    </div>
  );
}
