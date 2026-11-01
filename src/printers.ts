import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "./api";
import type { Store } from "./store";
import type { Job, Part, PrinterConfig, PrinterReport, PrinterStatus, Project } from "./types";

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

/**
 * Comparable form of a print or part name. Drops the file extension and the
 * settings PrusaSlicer adds by default, as in `Wall_A_0.4n_0.2mm_PLA_MK4S_1h2m.bgcode`.
 */
export const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/\.(gcode\.3mf|3mf|stl|obj|bgcode|gcode)$/, "")
    .replace(/_\d+(\.\d+)?n_\d+(\.\d+)?mm_.*$/, "")
    .replace(/[^a-z0-9]+/g, "");

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
 * Finds the part a running print most likely corresponds to, by comparing
 * the printer's job name with part names and queued job names.
 */
export function matchPrint(projects: Project[], report: PrinterReport): PrintMatch | null {
  const key = norm(report.subtask_name ?? "");
  if (!key) return null;
  let fallback: PrintMatch | null = null;
  const byRecent = [...projects].sort((a, b) => b.updatedAt - a.updatedAt);
  for (const project of byRecent) {
    const hidden = new Set(project.hiddenGroups);
    for (const job of project.jobs) {
      if (job.status !== "queued" || job.printer) continue;
      const parts = job.items.map((it) => project.parts.find((p) => p.id === it.partId)).filter((p): p is Part => !!p);
      const hit = norm(job.name) === key ? parts[0] : parts.find((p) => norm(p.name) === key);
      if (hit) return { project, part: hit, job };
    }
    if (!fallback) {
      const part = project.parts.find((p) => norm(p.name) === key && !hidden.has(p.group));
      if (part) fallback = { project, part };
    }
  }
  return fallback;
}

/**
 * Keeps a live connection to each configured printer, ties running prints to
 * project jobs and records the result when a print ends.
 */
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
    const want = new Map(printers.filter((p) => p.accessCode).map((p) => [p.id, settingsKey(p)]));
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

  if (ACTIVE_STATES.has(state)) {
    if (linkedJob(projects, printer.id, r)) return;
    const m = matchPrint(projects, r);
    if (!m) return;
    const started = Number(r.gcode_start_time) > 0 ? Number(r.gcode_start_time) * 1000 : Date.now();
    const slicer = printer.kind === "prusa" ? "prusa" : "bambu";
    const job = m.job ?? actions.createJob(m.project.id, [m.part.id], slicer, r.subtask_name);
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
    notify(`${printer.name} is printing “${m.part.name}” (${m.project.name}) — tracking it as ${job.name}.`);
    return;
  }

  if (state === "FINISH" || state === "FAILED") {
    const linked = linkedJob(projects, printer.id, r);
    if (!linked || linked.job.status !== "queued" || linked.job.printer?.awaitingReview) return;
    const { project, job } = linked;
    const link = job.printer!;
    const sawEnd = !!prevState && ACTIVE_STATES.has(prevState);
    // On startup, only pick up a finished print if it's the same one we were tracking.
    const sameRun = link.runId ? link.runId === r.job_id : Number(r.gcode_start_time) * 1000 === link.startedAt;
    if (!sawEnd && !sameRun) return;
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
