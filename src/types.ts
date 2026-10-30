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
  addedAt: number;
}

export interface JobItem {
  partId: string;
  qty: number;
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
  createdAt: number;
  updatedAt: number;
}

export interface Settings {
  slicers: Record<SlicerId, string[] | null>;
  defaultSlicer: SlicerId;
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
