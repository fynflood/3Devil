import { formatDuration } from "../api";
import type { Store } from "../store";
import { SLICER_NAMES, type Job, type Project, type SlicerId } from "../types";

interface Props {
  store: Store;
  project: Project;
  onSend: (ids: string[], slicer: SlicerId, recordJob: boolean) => void;
  onFocusPart: (id: string) => void;
  onReview: (jobId: string) => void;
}

const fmt = (t: number) => new Date(t).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

export function JobsView({ store, project, onSend, onFocusPart, onReview }: Props) {
  const { actions } = store;
  const queued = project.jobs.filter((j) => j.status === "queued");
  const finished = project.jobs.filter((j) => j.status !== "queued");

  if (!project.jobs.length) {
    return (
      <div className="empty">
        <h3>No print jobs yet</h3>
        <p>Select parts and send them to a slicer — each send is tracked as a job here. Mark it done when the plate comes off the printer and the counts update.</p>
      </div>
    );
  }

  const row = (job: Job) => {
    const copies = job.items.reduce((n, it) => n + it.qty, 0);
    return (
      <div key={job.id} className={`job job-${job.status}`}>
        <div className="job-head">
          <input
            className="title-input small"
            value={job.name}
            onChange={(e) => actions.updateJob(project.id, job.id, (j) => { j.name = e.target.value; })}
          />
          <span className="muted">
            {copies} {copies === 1 ? "copy" : "copies"} · {job.slicer ? SLICER_NAMES[job.slicer] : job.droppedAt ? "dragged to slicer" : "manual"} · {fmt(job.createdAt)}
            {job.finishedAt ? ` → ${fmt(job.finishedAt)}` : ""}
            {job.printer && ` · ${job.printer.printerName}${job.printer.durationSec ? ` · ${formatDuration(job.printer.durationSec)}` : job.status === "queued" ? " · printing" : ""}`}
          </span>
          <div className="spacer" />
          {job.status === "queued" ? (
            <>
              {job.printer?.awaitingReview && (
                <button className="pill pill-active" onClick={() => onReview(job.id)} title="The printer has stopped — record how it went">
                  Printer done — review
                </button>
              )}
              <button className="primary" title="Count every copy in this job as printed" onClick={() => actions.finishJob(project.id, job.id, "done")}>Printed ✓</button>
              <button title="Count every copy in this job as failed" onClick={() => actions.finishJob(project.id, job.id, "failed")}>Failed</button>
              {job.slicer && (
                <button title="Open these parts in the slicer again without adding a new job" onClick={() => onSend(job.items.map((i) => i.partId), job.slicer!, false)}>Reopen in slicer</button>
              )}
            </>
          ) : (
            <>
              <span className={`pill pill-${job.status}`}>
                {job.status === "failed"
                  ? "Failed"
                  : job.items.some((it) => it.good !== undefined && it.good < it.qty)
                    ? `Printed ${job.items.reduce((n, it) => n + (it.good ?? it.qty), 0)}/${copies}`
                    : "Printed"}
              </span>
              <button onClick={() => actions.reopenJob(project.id, job.id)} title="Undo and put back in the queue">Undo</button>
            </>
          )}
          <button className="icon-btn danger" title="Delete job" onClick={() => actions.deleteJob(project.id, job.id)}>✕</button>
        </div>
        <div className="job-items">
          {job.items.map((it) => {
            const part = project.parts.find((p) => p.id === it.partId);
            if (!part) return null;
            return (
              <span key={it.partId} className="job-item">
                <button className="link" onClick={() => onFocusPart(part.id)}>{part.name}</button>
                {job.status === "queued" ? (
                  <input
                    type="number"
                    min={1}
                    value={it.qty}
                    title="Copies in this job"
                    onChange={(e) =>
                      actions.updateJob(project.id, job.id, (j) => {
                        const item = j.items.find((x) => x.partId === it.partId);
                        if (item) item.qty = Math.max(1, parseInt(e.target.value, 10) || 1);
                      })
                    }
                  />
                ) : (
                  <span className="muted">×{it.qty}</span>
                )}
                {job.status === "queued" && (
                  <button
                    className="icon-btn job-item-remove"
                    title={job.items.length === 1 ? "Remove from the queue (deletes this job)" : "Remove from this job"}
                    aria-label={`Remove ${part.name} from this job`}
                    onClick={() => actions.removeJobItem(project.id, job.id, it.partId)}
                  >
                    ✕
                  </button>
                )}
              </span>
            );
          })}
        </div>
      </div>
    );
  };

  return (
    <div className="jobs">
      {queued.length > 0 && <h3>Queued ({queued.length})</h3>}
      {queued.map(row)}
      {finished.length > 0 && <h3>History</h3>}
      {finished.map(row)}
    </div>
  );
}
