import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { ModelViewer } from "../viewer/ModelViewer";
import { useEffect, useState } from "react";
import { formatBytes, formatDuration, parseDuration } from "../api";
import type { Store } from "../store";
import { SLICER_NAMES, type Part, type Project, type SlicerId } from "../types";

interface Props {
  store: Store;
  project: Project;
  part: Part;
  queued: number;
  onSend: (ids: string[], slicer: SlicerId, recordJob: boolean) => void;
  onClose: () => void;
}

export function PartDetail({ store, project, part, queued, onSend, onClose }: Props) {
  const update = (patch: Partial<Part>) => store.actions.updatePart(project.id, part.id, patch);
  const jobs = project.jobs.filter((j) => j.items.some((it) => it.partId === part.id));
  const num = (v: string) => Math.max(0, parseInt(v, 10) || 0);

  return (
    <aside className="detail">
      <div className="detail-head">
        <input className="title-input" value={part.name} onChange={(e) => update({ name: e.target.value })} />
        <button className="icon-btn" onClick={onClose} title="Close">✕</button>
      </div>
      {part.missing ? (
        <div className="viewer"><div className="viewer-overlay error">File not found:<br />{part.path}</div></div>
      ) : (
        <ModelViewer path={part.path} size={part.size} />
      )}

      <div className="detail-body">
        <div className="stat-row">
          <label>
            Needed
            <input type="number" min={1} value={part.required} onChange={(e) => update({ required: Math.max(1, num(e.target.value)) })} />
          </label>
          <label>
            Printed
            <input type="number" min={0} value={part.printed} onChange={(e) => update({ printed: num(e.target.value) })} />
          </label>
          <label>
            Failed
            <input type="number" min={0} value={part.failed} onChange={(e) => update({ failed: num(e.target.value) })} />
          </label>
        </div>
        {queued > 0 && (
          <p className="muted queued-note">
            {queued} in queued print jobs.
            <button className="link" onClick={() => store.actions.unqueueParts(project.id, [part.id])}>Remove from queue</button>
          </p>
        )}
        <PrintTime part={part} onChange={(printSeconds) => update({ printSeconds, printSecondsEstimated: undefined })} />
        <div className="btn-row">
          <button onClick={() => update({ printed: part.required })} disabled={part.printed >= part.required}>Mark all printed</button>
          <button onClick={() => update({ printed: 0 })} disabled={part.printed === 0}>Reset</button>
        </div>

        <div className="stat-row">
          <label>
            Material
            <input placeholder="PLA, PETG…" value={part.material ?? ""} onChange={(e) => update({ material: e.target.value })} />
          </label>
          <label>
            Colour
            <input placeholder="Grey" value={part.color ?? ""} onChange={(e) => update({ color: e.target.value })} />
          </label>
        </div>
        <label className="block">
          Notes
          <textarea rows={3} placeholder="Supports, orientation, infill…" value={part.notes ?? ""} onChange={(e) => update({ notes: e.target.value })} />
        </label>

        <div className="btn-row">
          {(Object.keys(SLICER_NAMES) as SlicerId[]).map((id) => (
            <button key={id} className="primary" disabled={part.missing} onClick={() => onSend([part.id], id, false)}>
              Open in {SLICER_NAMES[id]}
            </button>
          ))}
        </div>

        <div className="file-info">
          <span title={part.path}>{part.path}</span>
          <span>{part.size ? formatBytes(part.size) : ""}</span>
          <button className="link" onClick={() => revealItemInDir(part.path)}>Show in folder</button>
        </div>

        {jobs.length > 0 && (
          <div className="detail-jobs">
            <h4>Print jobs</h4>
            {jobs.map((j) => (
              <div key={j.id} className={`mini-job job-${j.status}`}>
                <span>{j.name}</span>
                <span>×{j.items.find((it) => it.partId === part.id)?.qty}</span>
                {j.printer?.durationSec ? <span className="muted">{formatDuration(j.printer.durationSec)}</span> : null}
                <span className="muted">{j.status}</span>
              </div>
            ))}
          </div>
        )}
        <button
          className="danger link"
          onClick={() => {
            store.actions.removeParts(project.id, [part.id]);
            onClose();
          }}
        >
          Remove from project
        </button>
      </div>
    </aside>
  );
}

/** Per-copy print time: recorded from tracked prints, or typed in from the slicer. */
function PrintTime({ part, onChange }: { part: Part; onChange: (secs: number | undefined) => void }) {
  const shown = part.printSeconds ? formatDuration(part.printSeconds) : "";
  const [text, setText] = useState(shown);
  useEffect(() => setText(shown), [shown]);
  const commit = () => {
    if (!text.trim()) return part.printSeconds && onChange(undefined);
    const secs = parseDuration(text);
    if (secs === null) setText(shown);
    else if (secs !== part.printSeconds) onChange(secs);
  };
  return (
    <label className="block print-time">
      Print time per copy
      <input
        value={text}
        placeholder="e.g. 1h 20m, from the slicer"
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      />
      <span className="muted small">
        {!part.printSeconds
          ? "Recorded automatically when a tracked print of this part finishes."
          : part.printSecondsEstimated
            ? "Estimated: its share of a plate printed with other parts."
            : "Used for the project's time left."}
      </span>
    </label>
  );
}
