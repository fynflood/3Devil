import { invoke } from "@tauri-apps/api/core";
import type { MmfAccount, MmfLibrary, MmfModel, DriveThruFile, DriveThruLibrary, ModelFile, SlicerId } from "./types";

export interface FoundPrinter {
  ip: string;
  serial: string;
  model: string;
}

export interface PathMapping {
  /** The folder as the shared projects file names it. */
  from: string;
  /** Where it is on this computer. */
  to: string;
}

export interface DataLocation {
  /** The shared folder projects are kept in, or null for this computer only. */
  sharedDir: string | null;
  file: string;
  pathMap: PathMapping[];
}

export interface TrashPlan {
  files: number;
  bytes: number;
  /** ZIPs elsewhere in the project that unpack into the folder. */
  zips: string[];
  /** Why the folder can't be moved, if it can't. */
  blocked: string | null;
}

export const api = {
  loadState: () => invoke<string>("load_state"),
  /** Returns the file's new stamp (see `stateStamp`). */
  saveState: (json: string) => invoke<string>("save_state", { json }),
  /** Changes whenever the projects file does; "" if it's missing. */
  stateStamp: () => invoke<string>("state_stamp"),
  dataLocation: () => invoke<DataLocation>("data_location"),
  inspectSharedFolder: (dir: string) =>
    invoke<{ projects: number; modified: number } | null>("inspect_shared_folder", { dir }),
  setSharedFolder: (dir: string | null, useExisting: boolean) =>
    invoke<void>("set_shared_folder", { dir, useExisting }),
  addPathMapping: (missing: string, found: string) => invoke<PathMapping>("add_path_mapping", { missing, found }),
  removePathMapping: (from: string) => invoke<void>("remove_path_mapping", { from }),
  scanModels: (dir: string) => invoke<ModelFile[]>("scan_models", { dir }),
  mmfSession: () => invoke<MmfAccount | null>("mmf_session"),
  /** Opens MyMiniFactory's sign-in page and waits for it. */
  mmfSignIn: () => invoke<MmfAccount>("mmf_sign_in"),
  mmfCancelSignIn: () => invoke<void>("mmf_cancel_sign_in"),
  mmfSignOut: () => invoke<void>("mmf_sign_out"),
  mmfLibrary: () => invoke<MmfLibrary>("mmf_library"),
  mmfLookup: (link: string) => invoke<MmfModel>("mmf_lookup", { link }),
  mmfDownload: (objectId: number, destDir: string) =>
    invoke<{ downloaded: string[]; skipped: string[] }>("mmf_download", { objectId, destDir }),
  /** What moving `path` to the Trash would involve; `roots` are the project's folders. */
  folderTrashPlan: (path: string, roots: string[]) => invoke<TrashPlan>("folder_trash_plan", { path, roots }),
  trashFolder: (path: string, roots: string[]) => invoke<void>("trash_folder", { path, roots }),
  /** Print presets someone has saved in a slicer. */
  slicerPresets: (id: "bambu" | "prusa", command: string[]) => invoke<string[]>(`${id}_presets`, { command }),
  /** Makes this the preset the next new window of a slicer starts on. */
  setSlicerPreset: (id: "bambu" | "prusa", command: string[], name: string) => invoke<void>(`set_${id}_preset`, { command, name }),
  /** OrcaSlicer's "only one instance" preference; null if it can't be read. */
  orcaSingleInstance: (command: string[]) => invoke<boolean | null>("orca_single_instance", { command }),
  setOrcaSingleInstance: (command: string[], on: boolean) => invoke<void>("set_orca_single_instance", { command, on }),
  readFileBytes: (path: string) => invoke<ArrayBuffer>("read_file_bytes", { path }),
  /** The model, with large STLs simplified to `resolution` grid cells on their longest side. */
  readModelPreview: (path: string, resolution: number) =>
    invoke<ArrayBuffer>("read_model_preview", { path, resolution }),
  missingFiles: (paths: string[]) => invoke<string[]>("missing_files", { paths }),
  extractZip: (zipPath: string) => invoke<string>("extract_zip", { zipPath }),
  extractArchives: (dir: string) =>
    invoke<{ extracted: string[]; failed: string[]; changed: string[]; removed: string[] }>("extract_archives", { dir }),
  detectSlicers: () =>
    invoke<Record<SlicerId, string[] | null>>("detect_slicers"),
  openInSlicer: (command: string[], files: string[], singleInstance: boolean) =>
    invoke<void>("open_in_slicer", { command, files, singleInstance }),
  openFolder: (path: string) => invoke<void>("open_folder", { path }),
  printerProbe: (ip: string) => invoke<FoundPrinter>("printer_probe", { ip }),
  printerScan: () => invoke<FoundPrinter[]>("printer_scan"),
  printerConnect: (p: { id: string; ip: string; serial: string; accessCode: string }) =>
    invoke<void>("printer_connect", p),
  printerDisconnect: (id: string) => invoke<void>("printer_disconnect", { id }),
  prusaProbe: (host: string, username: string, password: string) =>
    invoke<FoundPrinter>("prusa_probe", { host, username, password }),
  prusaConnect: (p: { id: string; host: string; username: string; password: string }) =>
    invoke<void>("prusa_connect", p),
  klipperProbe: (host: string, apiKey: string) => invoke<FoundPrinter>("klipper_probe", { host, apiKey }),
  klipperScan: () => invoke<FoundPrinter[]>("klipper_scan"),
  klipperConnect: (p: { id: string; host: string; apiKey: string }) => invoke<void>("klipper_connect", p),
  cameraStart: (p: { id: string; kind: string; host: string; accessCode: string; rtsp: boolean }) =>
    invoke<CameraView>("camera_start", p),
  cameraFrame: (id: string) => invoke<ArrayBuffer>("camera_frame", { id }),
  cameraStop: (id: string) => invoke<void>("camera_stop", { id }),
  drivethruLibrary: (key: string) => invoke<DriveThruLibrary>("drivethru_library", { key }),
  drivethruCachedLibrary: (key: string) => invoke<DriveThruLibrary | null>("drivethru_cached_library", { key }),
  drivethruProductDir: (libraryPath: string, publisher: string, name: string) =>
    invoke<string>("drivethru_product_dir", { libraryPath, publisher, name }),
  drivethruDownload: (p: {
    key: string;
    orderProductId: number;
    files: DriveThruFile[];
    destDir: string;
    remoteModifiedMs: number | null;
  }) => invoke<{ downloaded: string[]; skipped: string[]; changed: string[] }>("drivethru_download", p),
};

export function formatDuration(sec: number): string {
  const m = Math.round(sec / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}

/** Coarse duration for long totals: "45m", "4h 30m", "41h", "3d 4h". */
export function formatLongDuration(sec: number): string {
  const h = sec / 3600;
  if (h < 10) return formatDuration(sec);
  if (h < 72) return `${Math.round(h)}h`;
  const d = Math.floor(h / 24);
  return `${d}d ${Math.round(h - d * 24)}h`;
}

/**
 * Reads a typed print time: "1h 20m", "1h20", "1:20", "1.5h", "80m" or a
 * plain number of minutes. Returns seconds, or null if it isn't a time.
 */
export function parseDuration(text: string): number | null {
  const s = text.trim().toLowerCase();
  let m = s.match(/^(\d+):(\d{1,2})$/);
  if (m) return (Number(m[1]) * 60 + Number(m[2])) * 60;
  m = s.match(/^(?:(\d+(?:\.\d+)?)\s*h)?\s*(?:(\d+(?:\.\d+)?)\s*m?)?$/);
  if (!m || (!m[1] && !m[2])) return null;
  const secs = (Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 60;
  return secs > 0 ? Math.round(secs) : null;
}

export function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

export function extOf(path: string): string {
  const m = /\.([^.\\/]+)$/.exec(path);
  return m ? m[1].toLowerCase() : "";
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Splits a command line into arguments, honouring single and double quotes. */
/** How to turn a camera's picture, for cameras mounted at an angle. */
export interface CameraView {
  rotation: number;
  flipHorizontal: boolean;
  flipVertical: boolean;
}

export function splitCommand(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  let has = false;
  for (const ch of line.trim()) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || cur) out.push(cur);
      cur = "";
      has = false;
    } else {
      cur += ch;
    }
  }
  if (has || cur) out.push(cur);
  return out;
}

export function joinCommand(args: string[] | null): string {
  return (args ?? []).map((a) => (/[\s"']/.test(a) ? `"${a}"` : a)).join(" ");
}
