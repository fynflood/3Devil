import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, basename } from "./api";
import type {
  AppState,
  Job,
  ModelFile,
  Part,
  PartStatus,
  Project,
  SlicerId,
} from "./types";

const EMPTY: AppState = {
  version: 1,
  projects: [],
  settings: { slicers: { bambu: null, prusa: null }, defaultSlicer: "bambu" },
};

export const uid = () => crypto.randomUUID();

/** Guesses a copy count from names like "wall_x4", "4x wall", "pillar (x2)" or "glass -print 4". */
export function quantityFromName(name: string): number {
  const m = /(?:^|[\s_\-(])x(\d{1,3})(?=$|[\s_\-)])/i.exec(name) ??
    /(?:^|[\s_\-(])(\d{1,3})x(?=$|[\s_\-)])/i.exec(name) ??
    /(?:^|[\s_\-(])print[\s_]*x?(\d{1,3})(?=$|[\s_\-)])/i.exec(name);
  const n = m ? parseInt(m[1], 10) : 1;
  return n > 0 ? n : 1;
}

export function queuedCounts(project: Project): Map<string, number> {
  const m = new Map<string, number>();
  for (const job of project.jobs) {
    if (job.status !== "queued") continue;
    for (const it of job.items) m.set(it.partId, (m.get(it.partId) ?? 0) + it.qty);
  }
  return m;
}

export function partStatus(part: Part, queued: number): PartStatus {
  if (part.printed >= part.required) return "done";
  return queued > 0 ? "queued" : "todo";
}

/** Parts in folders that are part of the build (not hidden). */
export function activeParts(project: Project): Part[] {
  if (!project.hiddenGroups?.length) return project.parts;
  const hidden = new Set(project.hiddenGroups);
  return project.parts.filter((p) => !hidden.has(p.group));
}

export function projectProgress(project: Project) {
  let required = 0;
  let printed = 0;
  let partsDone = 0;
  const parts = activeParts(project);
  for (const p of parts) {
    required += p.required;
    printed += Math.min(p.printed, p.required);
    if (p.printed >= p.required) partsDone++;
  }
  return { required, printed, partsDone, parts: parts.length };
}

function partsFromFiles(folder: string, files: ModelFile[], existing: Set<string>): Part[] {
  const root = basename(folder);
  const now = Date.now();
  return files
    .filter((f) => !existing.has(f.path))
    .map((f) => ({
      id: uid(),
      name: f.name,
      path: f.path,
      group: f.group ? `${root}/${f.group}` : root,
      size: f.size,
      required: quantityFromName(f.name),
      printed: 0,
      failed: 0,
      addedAt: now,
    }));
}

export interface ScanResult {
  added: number;
  missing: number;
  /** ZIPs unpacked during the scan. */
  extracted: string[];
  failed: string[];
}

/** One-line summary of a scan for a toast. */
export function describeScan(r: ScanResult): string {
  const parts = [`${r.added} new part${r.added === 1 ? "" : "s"}`];
  if (r.extracted.length) parts.push(`${r.extracted.length} ZIP${r.extracted.length === 1 ? "" : "s"} unpacked`);
  if (r.missing) parts.push(`${r.missing} missing`);
  if (r.failed.length) parts.push(`couldn't unpack: ${r.failed.map(basename).join(", ")}`);
  return parts.join(" · ");
}

export type Store = ReturnType<typeof useStore>;

export function useStore() {
  const [state, setState] = useState<AppState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const saveTimer = useRef<number | undefined>(undefined);
  const latest = useRef<AppState | null>(null);

  useEffect(() => {
    api
      .loadState()
      .then((json) => {
        const parsed = JSON.parse(json) as AppState | null;
        const loaded = parsed
          ? { ...EMPTY, ...parsed, settings: { ...EMPTY.settings, ...parsed.settings } }
          : EMPTY;
        latest.current = loaded;
        setState(loaded);
      })
      .catch((e) => setError(String(e)));
  }, []);

  const flush = useCallback(() => {
    window.clearTimeout(saveTimer.current);
    saveTimer.current = undefined;
    if (latest.current) api.saveState(JSON.stringify(latest.current)).catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    window.addEventListener("beforeunload", flush);
    return () => window.removeEventListener("beforeunload", flush);
  }, [flush]);

  /**
   * Applies a mutation to a deep copy of the latest state and schedules a save.
   * Applied eagerly against `latest` so back-to-back calls compose and callers
   * can read the result synchronously.
   */
  const mutate = useCallback((fn: (draft: AppState) => void) => {
    if (!latest.current) return;
    const next = structuredClone(latest.current);
    fn(next);
    latest.current = next;
    setState(next);
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(flush, 400);
  }, [flush]);

  const withProject = useCallback(
    (projectId: string, fn: (p: Project, s: AppState) => void) =>
      mutate((s) => {
        const p = s.projects.find((x) => x.id === projectId);
        if (!p) return;
        fn(p, s);
        p.updatedAt = Date.now();
      }),
    [mutate],
  );

  const actions = useMemo(() => ({
    createProject(init: Pick<Project, "name" | "description" | "sourceUrl">): string {
      const id = uid();
      const now = Date.now();
      mutate((s) => {
        s.projects.unshift({ ...init, id, folders: [], parts: [], jobs: [], createdAt: now, updatedAt: now });
      });
      return id;
    },
    updateProject(id: string, patch: Partial<Pick<Project, "name" | "description" | "sourceUrl">>) {
      withProject(id, (p) => Object.assign(p, patch));
    },
    deleteProject(id: string) {
      mutate((s) => {
        s.projects = s.projects.filter((p) => p.id !== id);
      });
    },

    /**
     * Unpacks any new ZIPs in a folder, then adds model files not already in
     * the project.
     */
    async addFolder(projectId: string, folder: string): Promise<ScanResult> {
      const archives = await api.extractArchives(folder);
      const files = await api.scanModels(folder);
      const current = latest.current?.projects.find((p) => p.id === projectId);
      const parts = partsFromFiles(folder, files, new Set(current?.parts.map((x) => x.path)));
      withProject(projectId, (p) => {
        if (!p.folders.includes(folder)) p.folders.push(folder);
        const have = new Set(p.parts.map((x) => x.path));
        p.parts.push(...parts.filter((x) => !have.has(x.path)));
      });
      return { added: parts.length, missing: 0, ...archives };
    },

    async addFiles(projectId: string, paths: string[]) {
      withProject(projectId, (p) => {
        const have = new Set(p.parts.map((x) => x.path));
        for (const path of paths) {
          if (have.has(path)) continue;
          const name = basename(path).replace(/\.[^.]+$/, "");
          p.parts.push({
            id: uid(), name, path, group: "Loose files", size: 0,
            required: quantityFromName(name), printed: 0, failed: 0, addedAt: Date.now(),
          });
        }
      });
    },

    /** Re-scans every project folder for new files and flags parts whose file is gone. */
    async rescan(projectId: string): Promise<ScanResult> {
      const project = latest.current?.projects.find((p) => p.id === projectId);
      if (!project) return { added: 0, missing: 0, extracted: [], failed: [] };
      const extracted: string[] = [];
      const failed: string[] = [];
      const scans = await Promise.all(
        project.folders.map(async (f) => {
          const r = await api.extractArchives(f).catch(() => ({ extracted: [], failed: [] }));
          extracted.push(...r.extracted);
          failed.push(...r.failed);
          return [f, await api.scanModels(f).catch(() => [])] as const;
        }),
      );
      const missing = new Set(await api.missingFiles(project.parts.map((p) => p.path)));
      const have = new Set(project.parts.map((x) => x.path));
      const newParts: Part[] = [];
      for (const [folder, files] of scans) {
        const parts = partsFromFiles(folder, files, have);
        parts.forEach((x) => have.add(x.path));
        newParts.push(...parts);
      }
      withProject(projectId, (p) => {
        const existing = new Set(p.parts.map((x) => x.path));
        p.parts.push(...newParts.filter((x) => !existing.has(x.path)));
        for (const part of p.parts) part.missing = missing.has(part.path) || undefined;
      });
      return { added: newParts.length, missing: missing.size, extracted, failed };
    },

    setGroupsHidden(projectId: string, groups: string[], hidden: boolean) {
      withProject(projectId, (p) => {
        const set = new Set(p.hiddenGroups);
        groups.forEach((g) => (hidden ? set.add(g) : set.delete(g)));
        p.hiddenGroups = [...set];
      });
    },
    setGroupsCollapsed(projectId: string, groups: string[], collapsed: boolean) {
      withProject(projectId, (p) => {
        const set = new Set(p.collapsedGroups);
        groups.forEach((g) => (collapsed ? set.add(g) : set.delete(g)));
        p.collapsedGroups = [...set];
      });
    },

    updatePart(projectId: string, partId: string, patch: Partial<Part>) {
      withProject(projectId, (p) => {
        const part = p.parts.find((x) => x.id === partId);
        if (part) Object.assign(part, patch);
      });
    },
    updateParts(projectId: string, partIds: string[], fn: (part: Part) => void) {
      const ids = new Set(partIds);
      withProject(projectId, (p) => p.parts.filter((x) => ids.has(x.id)).forEach(fn));
    },
    removeParts(projectId: string, partIds: string[]) {
      const ids = new Set(partIds);
      withProject(projectId, (p) => {
        p.parts = p.parts.filter((x) => !ids.has(x.id));
        for (const job of p.jobs) job.items = job.items.filter((it) => !ids.has(it.partId));
        p.jobs = p.jobs.filter((j) => j.items.length > 0);
      });
    },

    /** Queues the outstanding copies of the given parts as one print job. */
    createJob(projectId: string, partIds: string[], slicer: SlicerId | null, name?: string): Job | null {
      const project = latest.current?.projects.find((p) => p.id === projectId);
      if (!project) return null;
      const queued = queuedCounts(project);
      const items = partIds
        .map((id) => project.parts.find((x) => x.id === id))
        .filter((x): x is Part => !!x)
        .map((part) => ({
          partId: part.id,
          qty: Math.max(1, part.required - part.printed - (queued.get(part.id) ?? 0)),
        }));
      if (!items.length) return null;
      const job: Job = {
        id: uid(),
        name: name ?? `Job ${project.jobs.length + 1}`,
        slicer,
        items,
        status: "queued",
        createdAt: Date.now(),
      };
      withProject(projectId, (p) => p.jobs.unshift(job));
      return job;
    },
    finishJob(projectId: string, jobId: string, status: "done" | "failed") {
      withProject(projectId, (p) => {
        const job = p.jobs.find((j) => j.id === jobId);
        if (!job || job.status !== "queued") return;
        job.status = status;
        job.finishedAt = Date.now();
        for (const it of job.items) {
          const part = p.parts.find((x) => x.id === it.partId);
          if (!part) continue;
          if (status === "done") part.printed += it.qty;
          else part.failed += it.qty;
        }
      });
    },
    /** Puts a finished job back in the queue, undoing its effect on counts. */
    reopenJob(projectId: string, jobId: string) {
      withProject(projectId, (p) => {
        const job = p.jobs.find((j) => j.id === jobId);
        if (!job || job.status === "queued") return;
        for (const it of job.items) {
          const part = p.parts.find((x) => x.id === it.partId);
          if (!part) continue;
          if (job.status === "done") part.printed = Math.max(0, part.printed - it.qty);
          else part.failed = Math.max(0, part.failed - it.qty);
        }
        job.status = "queued";
        job.finishedAt = undefined;
      });
    },
    updateJob(projectId: string, jobId: string, fn: (job: Job) => void) {
      withProject(projectId, (p) => {
        const job = p.jobs.find((j) => j.id === jobId);
        if (job) fn(job);
      });
    },
    deleteJob(projectId: string, jobId: string) {
      withProject(projectId, (p) => {
        p.jobs = p.jobs.filter((j) => j.id !== jobId);
      });
    },

    setSlicer(id: SlicerId, command: string[] | null) {
      mutate((s) => {
        s.settings.slicers[id] = command && command.length ? command : null;
      });
    },
    setDefaultSlicer(id: SlicerId) {
      mutate((s) => {
        s.settings.defaultSlicer = id;
      });
    },
  }), [mutate, withProject]);

  return { state, error, setError, actions };
}
