import { invoke } from "@tauri-apps/api/core";
import type { ModelFile } from "./types";

export const api = {
  loadState: () => invoke<string>("load_state"),
  saveState: (json: string) => invoke<void>("save_state", { json }),
  scanModels: (dir: string) => invoke<ModelFile[]>("scan_models", { dir }),
  readFileBytes: (path: string) => invoke<ArrayBuffer>("read_file_bytes", { path }),
  missingFiles: (paths: string[]) => invoke<string[]>("missing_files", { paths }),
  extractZip: (zipPath: string) => invoke<string>("extract_zip", { zipPath }),
  extractArchives: (dir: string) =>
    invoke<{ extracted: string[]; failed: string[] }>("extract_archives", { dir }),
  detectSlicers: () =>
    invoke<{ bambu: string[] | null; prusa: string[] | null }>("detect_slicers"),
  openInSlicer: (command: string[], files: string[]) =>
    invoke<void>("open_in_slicer", { command, files }),
};

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
