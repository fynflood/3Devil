import { api } from "./api";
import type { Store } from "./store";
import { SLICER_NAMES, type Project, type SlicerId } from "./types";

/** Returns the configured command for a slicer, auto-detecting (and saving) it if unset. */
export async function resolveSlicer(store: Store, id: SlicerId): Promise<string[]> {
  const configured = store.state?.settings.slicers[id];
  if (configured?.length) return configured;
  const found = (await api.detectSlicers())[id];
  if (!found) {
    throw new Error(`${SLICER_NAMES[id]} wasn't found. Set its location in Settings.`);
  }
  store.actions.setSlicer(id, found);
  return found;
}

/** Opens parts in a slicer and records them as a queued print job. */
export async function sendToSlicer(
  store: Store,
  project: Project,
  partIds: string[],
  id: SlicerId,
  recordJob = true,
) {
  const command = await resolveSlicer(store, id);
  const files = partIds
    .map((pid) => project.parts.find((p) => p.id === pid))
    .filter((p) => p && !p.missing)
    .map((p) => p!.path);
  if (!files.length) throw new Error("None of the selected files exist on disk.");
  // Only PrusaSlicer takes --single-instance on its command line; Bambu Studio
  // rejects it and quits, and reads the same option from its own preferences.
  const reuse = id === "prusa" && (store.state?.settings.reuseSlicerWindow ?? true);
  await api.openInSlicer(command, files, reuse);
  return recordJob ? store.actions.createJob(project.id, partIds, id) : null;
}
