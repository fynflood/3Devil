export type SlicerId = "bambu" | "prusa" | "orca" | "chitubox" | "lychee";

export const SLICER_NAMES: Record<SlicerId, string> = {
  bambu: "Bambu Studio",
  prusa: "PrusaSlicer",
  orca: "OrcaSlicer",
  chitubox: "CHITUBOX",
  lychee: "Lychee Slicer",
};

export const SLICER_IDS = Object.keys(SLICER_NAMES) as SlicerId[];

/** What the last update of the publisher's files did to a part. */
export type PartUpdate = "changed" | "new" | "removed";

export const PART_UPDATE_LABELS: Record<PartUpdate, string> = {
  changed: "Updated",
  new: "New",
  removed: "Not in update",
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
  /** Printer time per copy: from the last tracked print, or entered by hand. */
  printSeconds?: number;
  /** `printSeconds` is this part's share of a multi-part plate, not its own print. */
  printSecondsEstimated?: boolean;
  /** Grams of filament per copy: from the slicer's figures for the last tracked print, or entered by hand. */
  filamentGrams?: number;
  /** `filamentGrams` is this part's share of a multi-part plate, not its own print. */
  filamentGramsEstimated?: boolean;
  /** Set until the user has seen what an update did to this part. */
  update?: PartUpdate;
  /** When the file last changed in an update; keeps previews current. */
  updatedAt?: number;
  /** The older part this one took over from. */
  replaces?: string;
  /** The newer part that took over from this one; it no longer counts in the build. */
  replacedBy?: string;
  /** The user said this new part isn't a newer version of anything. */
  notRevision?: boolean;
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
  /**
   * The job was made for a print started outside 3Devil, so it holds just what
   * that print makes, counted from the plate once its objects are known.
   */
  fromPrinter?: boolean;
  /** The printer's own id for the print (PrusaLink job id), when it has one. */
  runId?: string;
  durationSec?: number;
  /** Grams of filament for the whole print, from the slicer's figures in its file. */
  filamentG?: number;
  /** How the printer reported the end of the print. */
  endState?: "FINISH" | "FAILED";
  /** The printer has stopped and the user hasn't said yet whether it worked. */
  awaitingReview?: boolean;
}

export type PrinterKind = "bambu" | "prusa" | "klipper" | "elegoo";

export const PRINTER_KIND_NAMES: Record<PrinterKind, string> = {
  bambu: "Bambu Lab",
  prusa: "Prusa",
  klipper: "Klipper",
  elegoo: "Elegoo",
};

export interface PrinterConfig {
  id: string;
  /** Missing on printers saved before Prusa support: those are Bambu. */
  kind?: PrinterKind;
  name: string;
  /** IP address (Bambu), or IP address or host name (Prusa, Klipper, Elegoo). */
  ip: string;
  /** Empty for printers that don't report one. An Elegoo printer's mainboard id. */
  serial: string;
  model: string;
  /** Bambu LAN access code, PrusaLink password / API key, or Moonraker API key (optional). Unused for Elegoo. */
  accessCode: string;
  /** PrusaLink user name; "maker" on Prusa's own firmware. */
  username?: string;
  /** Turned off: no connection, and left out of the sidebar. */
  disabled?: boolean;
}

/**
 * Subset of a Bambu `print` status report that 3Devil uses. Prusa, Klipper and
 * Elegoo printers report the same fields, converted from their own APIs.
 */
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
  /** Resin vat, on Elegoo resin printers. */
  vat_temper?: number;
  vat_target_temper?: number;
  uv_led_temper?: number;
  print_error?: number;
  /** The printer's id for the print, on PrusaLink, Moonraker and Elegoo. */
  job_id?: string;
  /** Grams of filament the print uses, from the slicer's figures in its file. */
  filament_g?: number;
  /** One name per object on the plate being printed, so copies repeat (Bambu, from its file). */
  plate_objects?: string[];
  /** Speed profile, 1 (silent) to 4 (ludicrous). */
  spd_lvl?: number;
  /** Print speed as a percentage. */
  spd_mag?: number;
  wifi_signal?: string;
  /** Fan speeds, "0" to "15". */
  cooling_fan_speed?: string;
  big_fan1_speed?: string;
  big_fan2_speed?: string;
  heatbreak_fan_speed?: string;
  nozzle_diameter?: string;
  ipcam?: { rtsp_url?: string };
  ams?: { tray_now?: string; ams?: { id: string; tray?: AmsTray[] }[] };
  /** The spool outside the AMS. */
  vt_tray?: AmsTray;
  hms?: unknown[];
  /** Where X1 printers report the chamber temperature. */
  device?: { ctc?: { info?: { temp?: number } } };
}

export interface AmsTray {
  id: string;
  tray_type?: string;
  /** RRGGBBAA. */
  tray_color?: string;
  /** Percent left; negative when unknown. */
  remain?: number;
}

/** A sliced file on a Bambu printer, and what's on each of its plates. */
export interface SlicedFile {
  path: string;
  plates: { index: number | null; grams: number | null; objects: string[] }[];
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
  /** Folder groups taken out of the project, which a rescan leaves out. */
  removedGroups?: string[];
  /** Set when the project was created from a DriveThruRPG library product. */
  driveThru?: DriveThruLink;
  /** Set when the project was created from a MyMiniFactory model. */
  myMiniFactory?: { objectId: number };
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

export interface DriveThruFile {
  index: number;
  filename: string;
  checksums?: { checksum?: string | null; checksumDate?: string | null }[];
}

export interface DriveThruProduct {
  productId: string;
  orderProductId: number;
  name: string;
  publisher?: { name: string } | null;
  fileLastModified?: string | null;
  files: DriveThruFile[];
}

/** The library as last fetched; also saved on disk so it shows instantly. */
export interface DriveThruLibrary {
  fetchedAt: number;
  products: DriveThruProduct[];
}

export type Theme = "system" | "light" | "dark";

export interface MmfAccount {
  username: string;
  /** Seconds since 1970. */
  expiresAt: number;
}

export interface MmfModel {
  id: number;
  name: string;
  url: string;
  designer: string | null;
  /** As shown on the store, like `£3.99`; null for a free model. */
  price: string | null;
  /** Whether this account owns it, when MyMiniFactory says. */
  bought: boolean | null;
}

export interface MmfLibrary {
  likes: MmfModel[];
  collections: { name: string; models: MmfModel[] }[];
}

/** Where the Model Library is browsing. */
export type LibrarySource = "drivethru" | "myminifactory";

export interface Settings {
  slicers: Record<SlicerId, string[] | null>;
  defaultSlicer: SlicerId;
  /** Slicers offered around the app. Unset until the first look for installed ones. */
  enabledSlicers?: SlicerId[];
  librarySource?: LibrarySource;
  /** Where MyMiniFactory models download, as <folder>/<designer>/<model>. */
  myMiniFactory?: { libraryPath: string };
  /** Print preset for new Bambu Studio windows; unset leaves it to Bambu Studio. */
  bambuPreset?: string;
  /** Print preset for new PrusaSlicer windows; unset leaves it to PrusaSlicer. */
  prusaPreset?: string;
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

export type PartStatus = "todo" | "queued" | "printing" | "done";
