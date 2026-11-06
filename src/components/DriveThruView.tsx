import { useMemo, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { extOf, formatBytes } from "../api";
import { fileTime, productUrl, type DownloadProgress, type DriveThru } from "../driveThru";
import { DriveThruSettingsSection } from "./DriveThruSettings";
import type { Store } from "../store";
import type { DriveThruProduct, Project } from "../types";

interface Props {
  store: Store;
  driveThru: DriveThru;
  onOpenProject: (id: string) => void;
}

const PRINT_EXTS = new Set(["zip", "stl", "3mf", "obj", "7z", "rar"]);

function ago(ms: number): string {
  const min = Math.round((Date.now() - ms) / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(ms).toLocaleDateString();
}

/** What a download in progress is up to. */
export function DownloadStatus({ progress }: { progress: DownloadProgress | null }) {
  if (!progress) return <span className="muted small">Checking files…</span>;
  return (
    <>
      <div className="progress thin"><div style={{ width: `${progress.total ? (progress.received / progress.total) * 100 : 0}%` }} /></div>
      <span className="muted small">
        {progress.file} ({progress.fileIndex + 1}/{progress.fileCount}) · {formatBytes(progress.received)}
        {progress.total ? ` of ${formatBytes(progress.total)}` : ""}
      </span>
    </>
  );
}

export function DriveThruView({ store, driveThru, onOpenProject }: Props) {
  const { key, library, loading, loaded, error, busy, progress, updates, matches, refresh } = driveThru;
  const products = library?.products ?? null;
  const [query, setQuery] = useState("");
  const [printOnly, setPrintOnly] = useState(true);
  const [updatesOnly, setUpdatesOnly] = useState(false);
  const [connecting, setConnecting] = useState(false);

  const linked = useMemo(() => {
    const m = new Map<number, Project>();
    for (const p of store.state!.projects) if (p.driveThru) m.set(p.driveThru.orderProductId, p);
    return m;
  }, [store.state]);

  /** Projects that look like each product but aren't linked to it yet. */
  const matched = useMemo(() => {
    const m = new Map<number, Project>();
    for (const p of store.state!.projects) {
      const product = matches.get(p.id);
      if (product) m.set(product.orderProductId, p);
    }
    return m;
  }, [store.state, matches]);

  const updatable = useMemo(() => new Set([...updates.values()].map((p) => p.orderProductId)), [updates]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (products ?? [])
      .filter((p) => !printOnly || p.files.some((f) => PRINT_EXTS.has(extOf(f.filename))))
      .filter((p) => !updatesOnly || !updatable.size || updatable.has(p.orderProductId))
      .filter((p) => !q || p.name.toLowerCase().includes(q) || (p.publisher?.name ?? "").toLowerCase().includes(q))
      .sort((a, b) => fileTime(b.fileLastModified) - fileTime(a.fileLastModified));
  }, [products, query, printOnly, updatesOnly, updatable]);

  const create = async (p: DriveThruProduct) => {
    const id = await driveThru.create(p);
    if (id) onOpenProject(id);
  };

  if (!key) {
    return <div className="settings library-settings"><DriveThruSettingsSection store={store} /></div>;
  }

  return (
    <div className="drivethru">
      <header className="drivethru-head">
        <div className="spacer" />
        {updatable.size > 0 && (
          <label className="inline small">
            <input type="checkbox" checked={updatesOnly} onChange={(e) => setUpdatesOnly(e.target.checked)} />
            Only updates ({updatable.size})
          </label>
        )}
        <label className="inline small">
          <input type="checkbox" checked={printOnly} onChange={(e) => setPrintOnly(e.target.checked)} />
          Only products with 3D files or ZIPs
        </label>
        <input className="search" placeholder="Search library…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <button onClick={refresh} disabled={loading} title="Reload your library from DriveThruRPG">{loading ? "Loading…" : "Refresh"}</button>
        <button className={connecting ? "active" : ""} onClick={() => setConnecting((v) => !v)} title="Your Library App Key and download folder">Connection</button>
      </header>
      {connecting && <div className="settings library-settings"><DriveThruSettingsSection store={store} /></div>}
      {error && !products && <div className="empty"><p className="error-text">{error}</p><button onClick={() => setConnecting(true)}>Check connection</button></div>}
      {loading && !products && (
        <div className="empty">
          <p>Loading your library…{loaded > 0 && ` ${loaded} products so far.`}</p>
          <p className="muted small">It's saved once loaded, so next time it opens straight away.</p>
        </div>
      )}
      {products && (
        <div className="drivethru-list">
          <p className="muted small">
            {visible.length} of {products.length} products ·{" "}
            {loading ? `refreshing…${loaded > 0 ? ` (${loaded} so far)` : ""}` : `updated ${ago(library!.fetchedAt)}`}
          </p>
          {error && <p className="error-text small">Couldn't refresh the library: {error}</p>}
          {visible.map((p) => {
            const project = linked.get(p.orderProductId);
            const match = matched.get(p.orderProductId);
            const isBusy = busy === p.orderProductId;
            return (
              <div key={p.orderProductId} className="drivethru-row">
                <div className="drivethru-info">
                  <button className="link drivethru-name" onClick={() => openUrl(productUrl(p))} title="Open the store page">{p.name}</button>
                  <span className="muted small">
                    {p.publisher?.name ?? "Unknown publisher"} · {p.files.length} file{p.files.length === 1 ? "" : "s"}
                    {p.fileLastModified ? ` · updated ${new Date(p.fileLastModified).toLocaleDateString()}` : ""}
                  </span>
                  {isBusy && <DownloadStatus progress={progress?.orderProductId === p.orderProductId ? progress : null} />}
                </div>
                {project ? (
                  <>
                    {updatable.has(p.orderProductId) && (
                      <button className="primary" title="Download only the files the publisher changed" onClick={() => driveThru.update(p, project)} disabled={busy !== null}>Download update</button>
                    )}
                    <button onClick={() => onOpenProject(project.id)}>Open project</button>
                  </>
                ) : (
                  <>
                    {match && (
                      <button className="primary" title={`Get updates for your project “${match.name}”`} onClick={() => driveThru.link(p, match)}>
                        Link to my project
                      </button>
                    )}
                    <button className={match ? "" : "primary"} title="Download this product and make a project from it" onClick={() => create(p)} disabled={busy !== null}>
                      {isBusy ? "Downloading…" : "Create project"}
                    </button>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
