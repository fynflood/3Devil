import { formatDuration } from "../api";
import { ACTIVE_STATES, STATE_LABELS, linkedJob, matchPrint } from "../printers";
import type { PrinterConfig, PrinterStatus, Project } from "../types";

interface Props {
  printer: PrinterConfig;
  status?: PrinterStatus;
  projects: Project[];
  onOpenPart: (projectId: string, partId: string) => void;
  onReview: (jobId: string) => void;
}

const temp = (cur?: number, target?: number) =>
  cur === undefined ? "–" : `${Math.round(cur)}°${target ? `/${Math.round(target)}°` : ""}`;

/** Compact live status for one printer, shown in the sidebar. */
export function PrinterCard({ printer, status, projects, onOpenPart, onReview }: Props) {
  const r = status?.print ?? {};
  const state = r.gcode_state ?? "";
  const active = ACTIVE_STATES.has(state);
  const linked = status ? linkedJob(projects, printer.id, r) : null;
  const match = linked
    ? (() => {
        const partId = linked.job.items[0]?.partId;
        const part = linked.project.parts.find((p) => p.id === partId);
        return part ? { project: linked.project, part } : null;
      })()
    : active
      ? matchPrint(projects, r)
      : null;

  let pill = "Connecting…";
  let pillClass = "";
  if (status?.error) {
    pill = "Offline";
    pillClass = "pill-failed";
  } else if (status?.connected && state) {
    pill = STATE_LABELS[state] ?? state;
    pillClass = active ? "pill-active" : state === "FAILED" ? "pill-failed" : state === "FINISH" ? "pill-done" : "";
  }

  return (
    <div className="printer-card" title={`${printer.model} · ${printer.ip}`}>
      <div className="printer-head">
        <span className="printer-name">{printer.name}</span>
        <span className={`pill ${pillClass}`}>{pill}</span>
      </div>
      {status?.error && <div className="small error-text">{status.error}</div>}
      {!status?.error && r.subtask_name && (state === "FINISH" || state === "FAILED" || active) && (
        <>
          {match ? (
            <button className="link printer-job" onClick={() => onOpenPart(match.project.id, match.part.id)}>
              {match.part.name} <span className="muted">· {match.project.name}</span>
            </button>
          ) : (
            <div className="printer-job muted" title="No part in your projects has this name">{r.subtask_name}</div>
          )}
          {linked?.job.status === "queued" && linked.job.printer?.awaitingReview && (
            <button className="link small" onClick={() => onReview(linked.job.id)}>Did it work? Record result</button>
          )}
          {active && (
            <>
              <div className="progress thin"><div style={{ width: `${r.mc_percent ?? 0}%` }} /></div>
              <div className="small muted printer-stats">
                <span>{r.mc_percent ?? 0}%</span>
                {r.mc_remaining_time !== undefined && <span>{formatDuration(r.mc_remaining_time * 60)} left</span>}
                {r.total_layer_num ? <span>L {r.layer_num ?? 0}/{r.total_layer_num}</span> : null}
              </div>
            </>
          )}
        </>
      )}
      {status?.connected && (
        <div className="small muted printer-stats">
          <span title="Nozzle">🔥 {temp(r.nozzle_temper, r.nozzle_target_temper)}</span>
          <span title="Bed">▭ {temp(r.bed_temper, r.bed_target_temper)}</span>
          {r.chamber_temper ? <span title="Chamber">☐ {Math.round(r.chamber_temper)}°</span> : null}
        </div>
      )}
    </div>
  );
}
