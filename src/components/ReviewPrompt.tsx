import { useState } from "react";
import { formatDuration } from "../api";
import type { Store } from "../store";
import type { Job, Project } from "../types";

interface Props {
  store: Store;
  project: Project;
  job: Job;
  onLater: () => void;
  onOpenPart: (projectId: string, partId: string) => void;
}

/** Asks whether a print the printer reported as ended actually came out. */
export function ReviewPrompt({ store, project, job, onLater, onOpenPart }: Props) {
  const link = job.printer!;
  const finished = link.endState !== "FAILED";
  const [good, setGood] = useState<Record<string, number>>(() =>
    Object.fromEntries(job.items.map((it) => [it.partId, finished ? it.qty : 0])),
  );
  const resolve = (counts: Record<string, number>) => store.actions.resolveJob(project.id, job.id, counts);
  const all = Object.fromEntries(job.items.map((it) => [it.partId, it.qty]));
  const none = Object.fromEntries(job.items.map((it) => [it.partId, 0]));
  const edited = job.items.some((it) => good[it.partId] !== (finished ? it.qty : 0));

  return (
    <div className="modal-backdrop">
      <div className="modal review">
        <h2>{finished ? "Print finished — did it work?" : "Print stopped — anything usable?"}</h2>
        <p className="muted">
          {link.printerName} {finished ? "finished" : "reported a failed or cancelled print for"} <strong>{job.name}</strong>
          {" "}({project.name}){link.durationSec ? ` after ${formatDuration(link.durationSec)}` : ""}.
        </p>
        <div className="review-items">
          {job.items.map((it) => {
            const part = project.parts.find((p) => p.id === it.partId);
            return (
              <div key={it.partId} className="review-item">
                <button className="link" onClick={() => onOpenPart(project.id, it.partId)}>{part?.name ?? "Removed part"}</button>
                <div className="spacer" />
                <span className="muted small">good copies</span>
                <input
                  type="number"
                  min={0}
                  max={it.qty}
                  value={good[it.partId]}
                  onChange={(e) =>
                    setGood({ ...good, [it.partId]: Math.min(it.qty, Math.max(0, parseInt(e.target.value, 10) || 0)) })
                  }
                />
                <span className="muted small">of {it.qty}</span>
              </div>
            );
          })}
        </div>
        <div className="btn-row end">
          <button className="link muted-link" onClick={onLater}>Decide later</button>
          <div className="spacer" />
          {edited && <button onClick={() => resolve(good)}>Save these counts</button>}
          <button className="danger" onClick={() => resolve(none)}>It failed</button>
          <button className="primary" onClick={() => resolve(all)} autoFocus>Yes, all good</button>
        </div>
      </div>
    </div>
  );
}
