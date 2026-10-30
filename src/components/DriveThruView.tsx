import { useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, extOf, formatBytes } from "../api";
import { describeScan, type Store } from "../store";
import type { DriveThruProduct, Project } from "../types";

interface Props {
  store: Store;
  notify: (msg: string, kind?: "info" | "error") => void;
  onOpenProject: (id: string) => void;
  onOpenSettings: () => void;
}

interface Progress {
  orderProductId: number;
  file: string;
  fileIndex: number;
  fileCount: number;
  received: number;
  total: number | null;
}

const PRINT_EXTS = new Set(["zip", "stl", "3mf", "obj", "7z", "rar"]);
const productUrl = (p: { productId: string }) => `https://www.drivethrurpg.com/en/product/${p.productId}`;
const time = (iso?: string | null) => (iso ? Date.parse(iso) || 0 : 0);

/** Library is cached for the session so switching views doesn't refetch it. */
let cache: { key: string; products: DriveThruProduct[] } | null = null;

export function DriveThruView({ store, notify, onOpenProject, onOpenSettings }: Props) {
  const settings = store.state!.settings.driveThru;
  const key = settings?.apiKey ?? "";
  const [products, setProducts] = useState<DriveThruProduct[] | null>(cache?.key === key ? cache.products : null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [printOnly, setPrintOnly] = useState(true);
  const [busy, setBusy] = useState<number | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await api.drivethruLibrary(key);
      cache = { key, products: list };
      setProducts(list);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (key && !products) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => {
    const un = listen<Progress>("drivethru-progress", (e) => setProgress(e.payload));
    return () => {
      un.then((f) => f());
    };
  }, []);

  const linked = useMemo(() => {
    const m = new Map<number, Project>();
    for (const p of store.state!.projects) if (p.driveThru) m.set(p.driveThru.orderProductId, p);
    return m;
  }, [store.state]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (products ?? [])
      .filter((p) => !printOnly || p.files.some((f) => PRINT_EXTS.has(extOf(f.filename))))
      .filter((p) => !q || p.name.toLowerCase().includes(q) || (p.publisher?.name ?? "").toLowerCase().includes(q))
      .sort((a, b) => time(b.fileLastModified) - time(a.fileLastModified));
  }, [products, query, printOnly]);

  /** Downloads (or refreshes) a product's files and returns the folder. */
  const download = async (p: DriveThruProduct) => {
    if (!settings?.libraryPath) throw new Error("Choose a download folder for DriveThruRPG in Settings first.");
    const dir = await api.drivethruProductDir(settings.libraryPath, p.publisher?.name ?? "", p.name);
    const r = await api.drivethruDownload({
      key,
      orderProductId: p.orderProductId,
      files: p.files,
      destDir: dir,
      remoteModifiedMs: time(p.fileLastModified) || null,
    });
    return { dir, ...r };
  };

  const run = async (p: DriveThruProduct, fn: () => Promise<void>) => {
    setBusy(p.orderProductId);
    setProgress(null);
    try {
      await fn();
    } catch (e) {
      notify(String(e), "error");
    } finally {
      setBusy(null);
      setProgress(null);
    }
  };

  const create = (p: DriveThruProduct) =>
    run(p, async () => {
      const { dir, downloaded, skipped } = await download(p);
      const id = store.actions.createProject({
        name: p.name,
        description: p.publisher?.name ?? "",
        sourceUrl: productUrl(p),
        driveThru: { productId: p.productId, orderProductId: p.orderProductId, fileLastModified: p.fileLastModified ?? undefined },
      });
      const scan = await store.actions.addFolder(id, dir);
      notify(`Downloaded ${downloaded.length} file(s)${skipped.length ? `, ${skipped.length} already up to date` : ""} · ${describeScan(scan)}`);
      onOpenProject(id);
    });

  const update = (p: DriveThruProduct, project: Project) =>
    run(p, async () => {
      const { downloaded } = await download(p);
      store.actions.updateProject(project.id, {
        driveThru: { productId: p.productId, orderProductId: p.orderProductId, fileLastModified: p.fileLastModified ?? undefined },
      });
      const scan = await store.actions.rescan(project.id);
      notify(`${p.name}: ${downloaded.length} updated file(s) · ${describeScan(scan)}`);
    });

  if (!key) {
    return (
      <div className="empty">
        <h3>Connect your DriveThruRPG library</h3>
        <p>
          Generate a <strong>Library App Key</strong> in your{" "}
          <button className="link" onClick={() => openUrl("https://www.drivethrurpg.com/en/account/settings")}>DriveThruRPG account settings</button>,
          then paste it into 3Devil's settings. Your purchases will be listed here, ready to turn into projects.
        </p>
        <button className="primary" onClick={onOpenSettings}>Open Settings</button>
      </div>
    );
  }

  return (
    <div className="drivethru">
      <header className="drivethru-head">
        <h2>DriveThruRPG library</h2>
        <div className="spacer" />
        <label className="inline small">
          <input type="checkbox" checked={printOnly} onChange={(e) => setPrintOnly(e.target.checked)} />
          Only products with 3D files or ZIPs
        </label>
        <input className="search" placeholder="Search library…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <button onClick={load} disabled={loading}>{loading ? "Loading…" : "Refresh"}</button>
      </header>
      {error && <div className="empty"><p className="error-text">{error}</p><button onClick={onOpenSettings}>Check settings</button></div>}
      {loading && !products && <div className="empty"><p>Loading your library…</p></div>}
      {products && (
        <div className="drivethru-list">
          <p className="muted small">{visible.length} of {products.length} products</p>
          {visible.map((p) => {
            const project = linked.get(p.orderProductId);
            const hasUpdate = !!project && time(p.fileLastModified) > time(project.driveThru?.fileLastModified);
            const isBusy = busy === p.orderProductId;
            const prog = isBusy && progress?.orderProductId === p.orderProductId ? progress : null;
            return (
              <div key={p.orderProductId} className="drivethru-row">
                <div className="drivethru-info">
                  <button className="link drivethru-name" onClick={() => openUrl(productUrl(p))} title="Open the store page">{p.name}</button>
                  <span className="muted small">
                    {p.publisher?.name ?? "Unknown publisher"} · {p.files.length} file{p.files.length === 1 ? "" : "s"}
                    {p.fileLastModified ? ` · updated ${new Date(p.fileLastModified).toLocaleDateString()}` : ""}
                  </span>
                  {prog && (
                    <>
                      <div className="progress thin"><div style={{ width: `${prog.total ? (prog.received / prog.total) * 100 : 0}%` }} /></div>
                      <span className="muted small">
                        {prog.file} ({prog.fileIndex + 1}/{prog.fileCount}) · {formatBytes(prog.received)}
                        {prog.total ? ` of ${formatBytes(prog.total)}` : ""}
                      </span>
                    </>
                  )}
                  {isBusy && !prog && <span className="muted small">Preparing download…</span>}
                </div>
                {project ? (
                  <>
                    {hasUpdate && <button onClick={() => update(p, project)} disabled={busy !== null}>Download update</button>}
                    <button onClick={() => onOpenProject(project.id)}>Open project</button>
                  </>
                ) : (
                  <button className="primary" onClick={() => create(p)} disabled={busy !== null}>
                    {isBusy ? "Downloading…" : "Create project"}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
