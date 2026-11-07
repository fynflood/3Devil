import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "./api";
import { enabledSlicers, mainSlicer } from "./slicers";
import type { Store } from "./store";
import type { Job, JobItem, Part, PrinterConfig, PrinterReport, PrinterStatus, Project, Settings, SlicerId } from "./types";

export const ACTIVE_STATES = new Set(["PREPARE", "SLICING", "RUNNING", "PAUSE", "ATTENTION"]);

export const STATE_LABELS: Record<string, string> = {
  IDLE: "Idle",
  PREPARE: "Preparing",
  SLICING: "Slicing",
  RUNNING: "Printing",
  PAUSE: "Paused",
  FINISH: "Finished",
  FAILED: "Failed",
  // Prusa only.
  ATTENTION: "Needs attention",
  BUSY: "Busy",
  ERROR: "Error",
};

/** Filament types OrcaSlicer may name a print after, with variants like `PLA-CF`. */
const FILAMENT = "(?:pla|petg|pet|abs|asa|tpu|pa|pc|pp|pps|pva|hips|bvoh|pctg)(?:[-+][a-z0-9]+)*";
const ORCA_SUFFIX = new RegExp(`_${FILAMENT}_(?=\\d)(?:\\d+d)?(?:\\d+h)?(?:\\d+m)?(?:\\d+s)?$`);

/**
 * Comparable form of a print or part name. Drops the file extension and the
 * settings slicers add by default, as in `Wall_A_0.4n_0.2mm_PLA_MK4S_1h2m.bgcode`
 * (PrusaSlicer) or `Wall_A_PLA_1h2m.gcode` (OrcaSlicer).
 */
export const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/\.(gcode\.3mf|3mf|stl|obj|bgcode|gcode|ctb|goo)$/, "")
    .replace(/_\d+(\.\d+)?n_\d+(\.\d+)?mm_.*$/, "")
    .replace(ORCA_SUFFIX, "")
    .replace(/[^a-z0-9]+/g, "");

/**
 * Tests names against a print's. Bambu Studio names a plate after everything on
 * it, one entry per copy, as in `Clip.stl + Clip.stl + Wall.stl`, and the printer
 * cuts the result to 100 characters ending in `...`. An entry cut short could be
 * the start of anything, so it only counts if it's the whole name.
 */
export function printNameTest(subtask: string) {
  const pieces = subtask.split(" + ");
  const cut = pieces[pieces.length - 1].endsWith("...") ? pieces.pop()! : "";
  const keys = new Set([subtask, ...pieces].map(norm));
  const start = pieces.length ? "" : norm(cut.slice(0, -3).replace(/\.[a-z0-9]{0,8}$/i, ""));
  return (name: string) => {
    const key = norm(name);
    return !!key && (keys.has(key) || (!!start && key.startsWith(start)));
  };
}

/** Identifies one run of a print, so a reprint of the same file counts separately. */
const runKey = (r: PrinterReport) => r.job_id ?? r.gcode_start_time;

export interface PrintMatch {
  project: Project;
  part: Part;
  job?: Job;
}

/** The job already tracking this printer's current print, if any. */
export function linkedJob(projects: Project[], printerId: string, report: PrinterReport) {
  for (const project of projects) {
    for (const job of project.jobs) {
      const link = job.printer;
      if (link?.printerId === printerId && link.subtask === report.subtask_name) {
        if (link.runId && report.job_id && link.runId !== report.job_id) continue;
        if (job.status === "queued" || !ACTIVE_STATES.has(report.gcode_state ?? "")) return { project, job };
      }
    }
  }
  return null;
}

/**
 * The lines of a job a print is making. A job can hold more than one print's
 * worth of parts, so a print named after parts is just those parts; only a
 * print named after the job itself is taken to be all of it.
 */
export function itemsInPrint(project: Project, job: Job, subtask: string): JobItem[] {
  const matches = printNameTest(subtask);
  const named = job.items.filter((it) => matches(project.parts.find((p) => p.id === it.partId)?.name ?? ""));
  return named.length ? named : job.items;
}

/** What connected printers are making right now, by job id. */
export function runningJobs(projects: Project[], statuses: Record<string, PrinterStatus>) {
  const running = new Map<string, JobItem[]>();
  for (const { id, connected, print } of Object.values(statuses)) {
    if (!connected || !ACTIVE_STATES.has(print.gcode_state ?? "")) continue;
    const linked = linkedJob(projects, id, print);
    if (linked) running.set(linked.job.id, itemsInPrint(linked.project, linked.job, print.subtask_name ?? ""));
  }
  return running;
}

export interface PartProgress {
  percent: number;
  minutesLeft?: number;
}

/** How far along the print making each part is, by part id. */
export function printProgress(projects: Project[], statuses: Record<string, PrinterStatus>) {
  const progress = new Map<string, PartProgress>();
  for (const { id, connected, print } of Object.values(statuses)) {
    if (!connected || !ACTIVE_STATES.has(print.gcode_state ?? "")) continue;
    const linked = linkedJob(projects, id, print);
    if (!linked) continue;
    for (const it of itemsInPrint(linked.project, linked.job, print.subtask_name ?? "")) {
      progress.set(it.partId, { percent: print.mc_percent ?? 0, minutesLeft: print.mc_remaining_time });
    }
  }
  return progress;
}

/** Copies of each part on a printer right now. */
export function printingCounts(project: Project, running: Map<string, JobItem[]>) {
  const m = new Map<string, number>();
  for (const job of project.jobs) {
    for (const it of running.get(job.id) ?? []) m.set(it.partId, (m.get(it.partId) ?? 0) + it.qty);
  }
  return m;
}

/**
 * Finds the part a running print most likely corresponds to, by comparing
 * the printer's job name with part names and queued job names.
 */
export function matchPrint(projects: Project[], report: PrinterReport): PrintMatch | null {
  const matches = printNameTest(report.subtask_name ?? "");
  let fallback: PrintMatch | null = null;
  const byRecent = [...projects].sort((a, b) => b.updatedAt - a.updatedAt);
  for (const project of byRecent) {
    const hidden = new Set(project.hiddenGroups);
    for (const job of project.jobs) {
      if (job.status !== "queued" || job.printer) continue;
      const parts = job.items.map((it) => project.parts.find((p) => p.id === it.partId)).filter((p): p is Part => !!p);
      const hit = matches(job.name) ? parts[0] : parts.find((p) => matches(p.name));
      if (hit) return { project, part: hit, job };
    }
    if (!fallback) {
      const part = project.parts.find((p) => matches(p.name) && !hidden.has(p.group));
      if (part) fallback = { project, part };
    }
  }
  return fallback;
}

/**
 * Keeps a live connection to each configured printer, ties running prints to
 * project jobs and records the result when a print ends.
 */
/** The job a printer's print belongs to, and the part it's making, if known. */
export function currentPart(projects: Project[], printerId: string, report: PrinterReport) {
  const linked = linkedJob(projects, printerId, report);
  if (linked) {
    const partId = itemsInPrint(linked.project, linked.job, report.subtask_name ?? "")[0]?.partId;
    const part = linked.project.parts.find((p) => p.id === partId);
    return { linked, match: part ? { project: linked.project, part } : null };
  }
  return { linked, match: ACTIVE_STATES.has(report.gcode_state ?? "") ? matchPrint(projects, report) : null };
}

/** X1 printers report this temperature in a different place from others. */
/** The slicer that likely made a print on an Elegoo printer: a resin slicer, unless it's G-code. */
function elegooSlicer(settings: Settings, file: string): SlicerId | null {
  const on = enabledSlicers(settings);
  if (/\.gcode$/i.test(file)) return mainSlicer(settings);
  return on.find((id) => id === "chitubox" || id === "lychee") ?? mainSlicer(settings);
}

export const chamberTemp = (r: PrinterReport) => r.chamber_temper || r.device?.ctc?.info?.temp;

/** How a printer's connection and state read as a status pill. */
export function statusPill(status?: PrinterStatus) {
  const state = status?.print.gcode_state ?? "";
  if (status?.error) return { label: "Offline", className: "pill-failed" };
  if (!status?.connected || !state) return { label: "Connecting…", className: "" };
  const className = ACTIVE_STATES.has(state) ? "pill-active" : state === "FAILED" ? "pill-failed" : state === "FINISH" ? "pill-done" : "";
  return { label: STATE_LABELS[state] ?? state, className };
}

export function usePrinters(store: Store, notify: (msg: string, kind?: "info" | "error") => void) {
  const [statuses, setStatuses] = useState<Record<string, PrinterStatus>>({});
  const printers = store.state?.settings.printers ?? [];
  const connected = useRef(new Map<string, string>());
  const prev = useRef<Record<string, { state?: string; run?: string }>>({});

  useEffect(() => {
    const unlisten = listen<PrinterStatus>("printer-status", (e) =>
      setStatuses((s) => ({ ...s, [e.payload.id]: e.payload })),
    );
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  // Open, restart or close connections to match the configured printers.
  const settingsKey = (p: PrinterConfig) => JSON.stringify([p.kind, p.ip, p.serial, p.accessCode, p.username]);
  const configKey = JSON.stringify(printers.map((p) => [p.id, settingsKey(p)]));
  useEffect(() => {
    // Klipper's API key is optional, and Elegoo printers have no login.
    const on = printers.filter((p) => !p.disabled && (p.accessCode || p.kind === "klipper" || p.kind === "elegoo"));
    const want = new Map(on.map((p) => [p.id, settingsKey(p)]));
    for (const id of [...connected.current.keys()]) {
      if (!want.has(id)) {
        api.printerDisconnect(id).catch(() => undefined);
        connected.current.delete(id);
        setStatuses(({ [id]: _, ...rest }) => rest);
      }
    }
    for (const p of printers) {
      const key = want.get(p.id);
      if (key && connected.current.get(p.id) !== key) {
        connected.current.set(p.id, key);
        const connect =
          p.kind === "prusa"
            ? api.prusaConnect({ id: p.id, host: p.ip, username: p.username ?? "", password: p.accessCode })
            : p.kind === "klipper"
              ? api.klipperConnect({ id: p.id, host: p.ip, apiKey: p.accessCode })
              : p.kind === "elegoo"
                ? api.elegooConnect({ id: p.id, host: p.ip, mainboard: p.serial })
                : api.printerConnect({ id: p.id, ip: p.ip, serial: p.serial, accessCode: p.accessCode });
        connect.catch((e) => notify(String(e), "error"));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configKey]);

  useEffect(() => {
    const projects = store.state?.projects ?? [];
    for (const [id, st] of Object.entries(statuses)) {
      const r = st.print;
      if (!r.gcode_state) continue;
      const before = prev.current[id];
      if (before && before.state === r.gcode_state && before.run === runKey(r)) continue;
      prev.current[id] = { state: r.gcode_state, run: runKey(r) };
      const printer = printers.find((p) => p.id === id);
      if (printer) onChange(store, notify, printer, projects, before?.state, r);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statuses]);

  return statuses;
}

function onChange(
  store: Store,
  notify: (msg: string, kind?: "info" | "error") => void,
  printer: PrinterConfig,
  projects: Project[],
  prevState: string | undefined,
  r: PrinterReport,
) {
  const { actions } = store;
  const state = r.gcode_state ?? "";

  /** Leaves a job with just what this print makes, so the rest stays queued. */
  const narrow = (project: Project, job: Job) => {
    const items = itemsInPrint(project, job, r.subtask_name ?? "");
    if (items.length < job.items.length) actions.splitJob(project.id, job.id, items.map((it) => it.partId));
  };

  if (ACTIVE_STATES.has(state)) {
    const linked = linkedJob(projects, printer.id, r);
    if (linked) return narrow(linked.project, linked.job);
    const m = matchPrint(projects, r);
    if (!m) return;
    const started = Number(r.gcode_start_time) > 0 ? Number(r.gcode_start_time) * 1000 : Date.now();
    const slicer =
      printer.kind === "klipper" ? mainSlicer(store.state!.settings)
      : printer.kind === "elegoo" ? elegooSlicer(store.state!.settings, r.subtask_name ?? "")
      : (printer.kind ?? "bambu");
    const job = m.job ?? actions.createJob(m.project.id, [m.part.id], slicer, r.subtask_name?.split(" + ")[0]);
    if (!job) return;
    if (!m.job) {
      // A print started outside 3Devil: assume one copy; editable in Print jobs.
      actions.updateJob(m.project.id, job.id, (j) => {
        j.items.forEach((it) => (it.qty = 1));
      });
    }
    actions.updateJob(m.project.id, job.id, (j) => {
      j.printer = { printerId: printer.id, printerName: printer.name, subtask: r.subtask_name ?? "", startedAt: started, runId: r.job_id };
    });
    if (m.job) narrow(m.project, m.job);
    notify(`${printer.name} is printing “${m.part.name}” (${m.project.name}) — tracking it as ${job.name}.`);
    return;
  }

  if (state === "FINISH" || state === "FAILED") {
    const linked = linkedJob(projects, printer.id, r);
    if (!linked || linked.job.status !== "queued") return;
    const { project, job } = linked;
    const link = job.printer!;
    const sawEnd = !!prevState && ACTIVE_STATES.has(prevState);
    // On startup, only pick up a finished print if it's the same one we were tracking.
    const sameRun = link.runId ? link.runId === r.job_id : Number(r.gcode_start_time) * 1000 === link.startedAt;
    if (!sawEnd && !sameRun) return;
    narrow(project, job);
    if (link.awaitingReview) return;
    actions.updateJob(project.id, job.id, (j) => {
      j.printer!.endState = state;
      j.printer!.awaitingReview = true;
      if (sawEnd) j.printer!.durationSec = Math.max(0, Math.round((Date.now() - link.startedAt) / 1000));
    });
    notifyDesktop(
      state === "FINISH" ? `${printer.name} finished ${job.name}` : `${printer.name} stopped ${job.name}`,
      "Was the print successful? Open 3Devil to record it.",
    );
  }
}

let notifyAllowed: boolean | null = null;

/** Best-effort OS notification so a finished print is noticed while 3Devil is in the background. */
async function notifyDesktop(title: string, body: string) {
  try {
    const n = await import("@tauri-apps/plugin-notification");
    if (notifyAllowed === null) {
      notifyAllowed = (await n.isPermissionGranted()) || (await n.requestPermission()) === "granted";
    }
    if (notifyAllowed) n.sendNotification({ title, body });
  } catch {
    // Notifications are optional; the in-app prompt still appears.
  }
}
