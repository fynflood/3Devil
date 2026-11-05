import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, basename } from "./api";
import { describeScan, type Store } from "./store";
import type { DriveThruLibrary, DriveThruLink, DriveThruProduct, Project } from "./types";

export interface DownloadProgress {
  orderProductId: number;
  file: string;
  fileIndex: number;
  fileCount: number;
  received: number;
  total: number | null;
}

export const productUrl = (p: { productId: string }) => `https://www.drivethrurpg.com/en/product/${p.productId}`;
export const fileTime = (iso?: string | null) => (iso ? Date.parse(iso) || 0 : 0);

const linkTo = (p: DriveThruProduct): DriveThruLink => ({
  productId: p.productId,
  orderProductId: p.orderProductId,
  fileLastModified: p.fileLastModified ?? undefined,
});

const nameKey = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "");

/** A project made by hand from this product's files, going by its link, name or folder. */
function looksLike(project: Project, p: DriveThruProduct): boolean {
  if (project.sourceUrl.includes(`/product/${p.productId}`)) return true;
  const key = nameKey(p.name);
  return nameKey(project.name) === key || project.folders.some((f) => nameKey(basename(f)) === key);
}

export type DriveThru = ReturnType<typeof useDriveThru>;

/** The DriveThruRPG library, checked once at launch, and what it means for each project. */
export function useDriveThru(store: Store, notify: (msg: string, kind?: "info" | "error") => void) {
  const settings = store.state?.settings.driveThru;
  const key = settings?.apiKey ?? "";
  const projects = store.state?.projects;
  const [library, setLibrary] = useState<DriveThruLibrary | null>(null);
  const [loading, setLoading] = useState(false);
  /** Products fetched so far by the refresh in progress. */
  const [loaded, setLoaded] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const checked = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    setLoaded(0);
    try {
      setLibrary(await api.drivethruLibrary(key));
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [key]);

  // Show the saved copy straight away, then refresh it once per session.
  useEffect(() => {
    if (!key || checked.current === key) return;
    checked.current = key;
    setLibrary(null);
    api.drivethruCachedLibrary(key).catch(() => null).then((saved) => {
      if (saved) setLibrary(saved);
      refresh();
    });
  }, [key, refresh]);

  useEffect(() => {
    const un = listen<DownloadProgress>("drivethru-progress", (e) => setProgress(e.payload));
    const unLib = listen<number>("drivethru-library-progress", (e) => setLoaded(e.payload));
    return () => {
      un.then((f) => f());
      unLib.then((f) => f());
    };
  }, []);

  const productsById = useMemo(() => new Map(library?.products.map((p) => [p.orderProductId, p])), [library]);

  /** Linked projects whose product has changed since it was last downloaded. */
  const updates = useMemo(() => {
    const m = new Map<string, DriveThruProduct>();
    for (const project of projects ?? []) {
      const p = project.driveThru && productsById.get(project.driveThru.orderProductId);
      if (p && fileTime(p.fileLastModified) > fileTime(project.driveThru?.fileLastModified)) m.set(project.id, p);
    }
    return m;
  }, [projects, productsById]);

  /** Projects with no link yet that look like one of the products. */
  const matches = useMemo(() => {
    const m = new Map<string, DriveThruProduct>();
    const taken = new Set(projects?.map((p) => p.driveThru?.orderProductId));
    const free = library?.products.filter((p) => !taken.has(p.orderProductId)) ?? [];
    for (const project of projects ?? []) {
      if (project.driveThru) continue;
      const p = free.find((x) => looksLike(project, x));
      if (p) m.set(project.id, p);
    }
    return m;
  }, [projects, library]);

  /** Downloads whatever differs from the store, and returns the folder. */
  const download = async (p: DriveThruProduct, into?: string) => {
    if (!into && !settings?.libraryPath) throw new Error("Choose a download folder for DriveThruRPG in Settings first.");
    const dir = into ?? (await api.drivethruProductDir(settings!.libraryPath, p.publisher?.name ?? "", p.name));
    const r = await api.drivethruDownload({
      key,
      orderProductId: p.orderProductId,
      files: p.files,
      destDir: dir,
      remoteModifiedMs: fileTime(p.fileLastModified) || null,
    });
    return { dir, ...r };
  };

  const run = async <T,>(p: DriveThruProduct, fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(p.orderProductId);
    setProgress(null);
    try {
      return await fn();
    } catch (e) {
      notify(String(e), "error");
    } finally {
      setBusy(null);
      setProgress(null);
    }
  };

  /** Downloads a product into a new project, and returns the project's id. */
  const create = (p: DriveThruProduct) =>
    run(p, async () => {
      const { dir, downloaded, skipped } = await download(p);
      const id = store.actions.createProject({
        name: p.name,
        description: p.publisher?.name ?? "",
        sourceUrl: productUrl(p),
        driveThru: linkTo(p),
      });
      const scan = await store.actions.addFolder(id, dir);
      notify(`Downloaded ${downloaded.length} file(s)${skipped.length ? `, ${skipped.length} already up to date` : ""} · ${describeScan(scan)}`);
      return id;
    });

  /**
   * Brings a project up to date, in its own folder, which may not be the
   * download folder. Its print counts are left alone.
   */
  const update = (p: DriveThruProduct, project: Project) =>
    run(p, async () => {
      const r = await download(p, project.folders[0]);
      store.actions.updateProject(project.id, { driveThru: linkTo(p) });
      const scan = project.folders.length
        ? await store.actions.rescan(project.id, r.changed)
        : await store.actions.addFolder(project.id, r.dir);
      notify(`${p.name}: ${describeScan(scan)}`, scan.failed.length ? "error" : "info");
    });

  /**
   * Ties a project made by hand to its product. Its files' age is unknown, so
   * no date is kept: the first update compares them with the store's.
   */
  const link = (p: DriveThruProduct, project: Project) =>
    store.actions.updateProject(project.id, {
      driveThru: { productId: p.productId, orderProductId: p.orderProductId },
      sourceUrl: project.sourceUrl || productUrl(p),
    });

  return { key, library, loading, loaded, error, busy, progress, updates, matches, refresh, create, update, link };
}
