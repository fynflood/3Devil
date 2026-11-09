import { api } from "./api";
import { norm, printNameTest } from "./printers";
import type { Store } from "./store";
import type { Part, PrinterConfig, Project, SlicedFile } from "./types";

/** The print name a sliced file on the printer was saved under. */
const subtaskOf = (path: string) => (path.split("/").pop() ?? path).replace(/(\.gcode)?\.3mf$/i, "");

type Fill = Parameters<Store["actions"]["fillFilament"]>;

/**
 * The project a plate was made for: one with a part for every object on it,
 * preferring one that tracked a print of this file, then the latest edited.
 * Returns the part each object name stands for.
 */
function projectFor(projects: Project[], objects: string[], subtask: string) {
  const names = [...new Set(objects.map(norm))];
  const options: { project: Project; parts: Map<string, Part> }[] = [];
  for (const project of projects) {
    const hidden = new Set(project.hiddenGroups);
    const parts = new Map<string, Part>();
    for (const name of names) {
      const candidates = project.parts.filter((p) => !p.missing && norm(p.name) === name);
      const part = candidates.find((p) => !hidden.has(p.group)) ?? candidates[0];
      if (part) parts.set(name, part);
    }
    if (parts.size === names.length) options.push({ project, parts });
  }
  const key = norm(subtask);
  return (
    options.find((o) => o.project.jobs.some((j) => j.printer && norm(j.printer.subtask) === key)) ??
    options.sort((a, b) => b.project.updatedAt - a.project.updatedAt)[0]
  );
}

/** Per-copy grams for each part on a plate, split by file size when it holds different parts. */
function perCopy(plate: SlicedFile["plates"][number], parts: Map<string, Part>) {
  const copies = new Map<Part, number>();
  for (const name of plate.objects) {
    const part = parts.get(norm(name))!;
    copies.set(part, (copies.get(part) ?? 0) + 1);
  }
  const grams = plate.grams!;
  const round = (g: number) => Math.max(0.1, Math.round(g * 10) / 10);
  if (copies.size === 1) {
    const [[part, n]] = [...copies];
    return [{ part, grams: round(grams / n), estimated: false }];
  }
  const weight = [...copies].reduce((t, [part, n]) => t + Math.max(1, part.size) * n, 0);
  return [...copies.keys()].map((part) => ({ part, grams: round((grams * Math.max(1, part.size)) / weight), estimated: true }));
}

/**
 * Fills in filament for parts that have none, from the sliced files a Bambu
 * printer still keeps: each plate's weight is shared among the copies on it.
 * Returns how many parts got a weight.
 */
export async function backfillFilament(store: Store, printer: PrinterConfig): Promise<number> {
  const projects = store.state?.projects ?? [];
  const wanted = projects.flatMap((p) => p.parts.filter((part) => !part.missing && !part.filamentGrams));
  if (!wanted.length) return 0;
  const files = await api.bambuSlicedFiles(printer.ip, printer.accessCode);
  const likely = files.filter((path) => {
    const test = printNameTest(subtaskOf(path));
    return wanted.some((part) => test(part.name));
  });
  if (!likely.length) return 0;
  const sliced = await api.bambuSlicedPlates(printer.ip, printer.accessCode, likely);

  const fills = new Map<string, { parts: Fill[1]; jobs: Fill[2] }>();
  const done = new Set<string>();
  for (const file of sliced) {
    // A project file with several plates can't say which one was printed.
    const plate = file.plates.length === 1 ? file.plates[0] : null;
    if (!plate?.grams || !plate.objects.length) continue;
    const subtask = subtaskOf(file.path);
    const match = projectFor(projects, plate.objects, subtask);
    if (!match) continue;
    const fill = fills.get(match.project.id) ?? { parts: [], jobs: [] };
    fills.set(match.project.id, fill);
    for (const { part, grams, estimated } of perCopy(plate, match.parts)) {
      if (part.filamentGrams || done.has(part.id)) continue;
      done.add(part.id);
      fill.parts.push({ partId: part.id, grams, estimated });
    }
    const key = norm(subtask);
    for (const job of match.project.jobs) {
      if (job.printer?.printerId === printer.id && !job.printer.filamentG && norm(job.printer.subtask) === key) {
        fill.jobs.push({ jobId: job.id, grams: plate.grams });
      }
    }
  }
  for (const [projectId, fill] of fills) {
    if (fill.parts.length || fill.jobs.length) store.actions.fillFilament(projectId, fill.parts, fill.jobs);
  }
  return done.size;
}
