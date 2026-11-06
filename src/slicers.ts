import { api } from "./api";
import type { Store } from "./store";
import { SLICER_IDS, SLICER_NAMES, type Project, type Settings, type SlicerId } from "./types";

/** The slicers offered around the app. */
export function enabledSlicers(settings: Settings): SlicerId[] {
  const on = settings.enabledSlicers ?? ["bambu", "prusa"];
  return SLICER_IDS.filter((id) => on.includes(id));
}

/** The slicer "Send to" uses: the chosen one, unless it's been turned off. */
export function mainSlicer(settings: Settings): SlicerId | null {
  const on = enabledSlicers(settings);
  return on.includes(settings.defaultSlicer) ? settings.defaultSlicer : (on[0] ?? null);
}

/** The slicers 3Devil can choose a print preset for, and where each choice is saved. */
export const PRESET_SETTINGS = { bambu: "bambuPreset", prusa: "prusaPreset" } as const;

export const hasPresets = (id: SlicerId): id is keyof typeof PRESET_SETTINGS => id in PRESET_SETTINGS;

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
  // and OrcaSlicer reject it and quit, and read the same option from their own
  // preferences.
  const reuse = id === "prusa" && (store.state?.settings.reuseSlicerWindow ?? true);
  if (hasPresets(id)) {
    const preset = store.state?.settings[PRESET_SETTINGS[id]];
    if (preset) await api.setSlicerPreset(id, command, preset);
  }
  await api.openInSlicer(command, files, reuse);
  return recordJob ? store.actions.createJob(project.id, partIds, id) : null;
}
