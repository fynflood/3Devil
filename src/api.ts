import { invoke } from "@tauri-apps/api/core";
import type { DriveThruLibrary, ModelFile } from "./types";

export interface FoundPrinter {
  ip: string;
  serial: string;
  model: string;
}

export const api = {
  loadState: () => invoke<string>("load_state"),
  saveState: (json: string) => invoke<void>("save_state", { json }),
  scanModels: (dir: string) => invoke<ModelFile[]>("scan_models", { dir }),
  readFileBytes: (path: string) => invoke<ArrayBuffer>("read_file_bytes", { path }),
  /** The model, with large STLs simplified to `resolution` grid cells on their longest side. */
  readModelPreview: (path: string, resolution: number) =>
    invoke<ArrayBuffer>("read_model_preview", { path, resolution }),
  missingFiles: (paths: string[]) => invoke<string[]>("missing_files", { paths }),
  extractZip: (zipPath: string) => invoke<string>("extract_zip", { zipPath }),
  extractArchives: (dir: string) =>
    invoke<{ extracted: string[]; failed: string[] }>("extract_archives", { dir }),
  detectSlicers: () =>
    invoke<{ bambu: string[] | null; prusa: string[] | null }>("detect_slicers"),
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
  drivethruLibrary: (key: string) => invoke<DriveThruLibrary>("drivethru_library", { key }),
  drivethruCachedLibrary: (key: string) => invoke<DriveThruLibrary | null>("drivethru_cached_library", { key }),
  drivethruProductDir: (libraryPath: string, publisher: string, name: string) =>
    invoke<string>("drivethru_product_dir", { libraryPath, publisher, name }),
  drivethruDownload: (p: {
    key: string;
    orderProductId: number;
    files: { index: number; filename: string }[];
    destDir: string;
    remoteModifiedMs: number | null;
  }) => invoke<{ downloaded: string[]; skipped: string[] }>("drivethru_download", p),
};

export function formatDuration(sec: number): string {
  const m = Math.round(sec / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, "0")}m`;
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
