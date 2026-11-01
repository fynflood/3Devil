export type SlicerId = "bambu" | "prusa";

export const SLICER_NAMES: Record<SlicerId, string> = {
  bambu: "Bambu Studio",
  prusa: "PrusaSlicer",
};

export interface Part {
  id: string;
  name: string;
  path: string;
  /** Folder grouping inside the project, e.g. "Castle Set/Walls". */
  group: string;
  size: number;
  /** How many copies the build needs. */
  required: number;
  /** How many good copies have been printed. */
  printed: number;
  /** How many attempts failed (for reference only). */
  failed: number;
  material?: string;
  color?: string;
  notes?: string;
  missing?: boolean;
  /** Actual printer time per copy, from the last tracked print. */
  printSeconds?: number;
  addedAt: number;
}

export interface JobItem {
  partId: string;
  qty: number;
  /** Copies that came out good, once the job is finished. */
  good?: number;
}

export type JobStatus = "queued" | "done" | "failed";

/** A batch of parts sent to a slicer / printer together (usually one plate). */
export interface Job {
  id: string;
  name: string;
  slicer: SlicerId | null;
  items: JobItem[];
  status: JobStatus;
  createdAt: number;
  finishedAt?: number;
  /** Set when the job was seen running on a connected printer. */
  printer?: JobPrinterLink;
  /** Last time parts were dragged into a slicer for this job. */
  droppedAt?: number;
}

export interface JobPrinterLink {
  printerId: string;
  printerName: string;
  /** The printer's name for the running job (Bambu `subtask_name`). */
  subtask: string;
  startedAt: number;
  durationSec?: number;
  /** How the printer reported the end of the print. */
  endState?: "FINISH" | "FAILED";
  /** The printer has stopped and the user hasn't said yet whether it worked. */
  awaitingReview?: boolean;
}

export interface PrinterConfig {
  id: string;
  name: string;
  ip: string;
  serial: string;
  model: string;
  accessCode: string;
}

/** Subset of a Bambu `print` status report that 3Devil uses. */
export interface PrinterReport {
  gcode_state?: string;
  mc_percent?: number;
  mc_remaining_time?: number;
  layer_num?: number;
  total_layer_num?: number;
  subtask_name?: string;
  gcode_file?: string;
  gcode_start_time?: string;
  nozzle_temper?: number;
  nozzle_target_temper?: number;
  bed_temper?: number;
  bed_target_temper?: number;
  chamber_temper?: number;
  print_error?: number;
}

export interface PrinterStatus {
  id: string;
  connected: boolean;
  error: string | null;
  print: PrinterReport;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  /** Store page / library link, e.g. a DriveThruRPG product. */
  sourceUrl: string;
  folders: string[];
  parts: Part[];
  jobs: Job[];
  /** Folder groups left out of the build: not shown and not counted in progress. */
  hiddenGroups?: string[];
  /** Folder groups whose parts are folded away in the parts view. */
  collapsedGroups?: string[];
  /** Set when the project was created from a DriveThruRPG library product. */
  driveThru?: DriveThruLink;
  createdAt: number;
  updatedAt: number;
}

export interface DriveThruLink {
  productId: string;
  orderProductId: number;
  /** The product's file timestamp when it was last downloaded. */
  fileLastModified?: string;
}

export interface DriveThruSettings {
  /** Library App Key from the DriveThruRPG account settings. */
  apiKey: string;
  /** Where products are downloaded, as <folder>/<publisher>/<product>. */
  libraryPath: string;
}

export interface DriveThruProduct {
  productId: string;
  orderProductId: number;
  name: string;
  publisher?: { name: string } | null;
  fileLastModified?: string | null;
  files: { index: number; filename: string }[];
}

/** The library as last fetched; also saved on disk so it shows instantly. */
export interface DriveThruLibrary {
  fetchedAt: number;
  products: DriveThruProduct[];
}

export type Theme = "system" | "light" | "dark";

export interface Settings {
  slicers: Record<SlicerId, string[] | null>;
  defaultSlicer: SlicerId;
  /** Send files to an already-open slicer window (default on). */
  reuseSlicerWindow?: boolean;
  /** Colour theme; "system" (the default) follows the OS. */
  theme?: Theme;
  /** Check GitHub for new versions and download them in the background (default on). */
  autoUpdate?: boolean;
  printers?: PrinterConfig[];
  driveThru?: DriveThruSettings;
}

export interface AppState {
  version: 1;
  projects: Project[];
  settings: Settings;
}

export interface ModelFile {
  path: string;
  name: string;
  group: string;
  size: number;
}

export type PartStatus = "todo" | "queued" | "done";
