import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { ModelViewer } from "../viewer/ModelViewer";
import { useEffect, useState } from "react";
import { formatBytes, formatDuration, parseDuration } from "../api";
import type { Store } from "../store";
import { SLICER_NAMES, type JobItem, type Part, type Project, type SlicerId } from "../types";

interface Props {
  store: Store;
  project: Project;
  part: Part;
  queued: number;
  /** Of the queued copies, how many are on a printer right now. */
  printing: number;
  /** What printers are making right now, by job id. */
  running: Map<string, JobItem[]>;
  /** The slicers to offer. */
  slicers: SlicerId[];
  /** Older parts this new part may replace, best match first. */
  replaceCandidates: Part[];
  /** What looks like a newer version of this part. */
  newerVersion?: Part;
  onOpenPart: (id: string) => void;
  onSend: (ids: string[], slicer: SlicerId, recordJob: boolean) => void;
  onClose: () => void;
}

export function PartDetail({ store, project, part, queued, printing, running, slicers, replaceCandidates, newerVersion, onOpenPart, onSend, onClose }: Props) {
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
        <RevisionNotes
          store={store}
          project={project}
          part={part}
          replaceCandidates={replaceCandidates}
          newerVersion={newerVersion}
          onOpenPart={onOpenPart}
        />
        {part.update && part.update !== "new" && !newerVersion && (
          <p className="update-note">
            <span>
              {part.update === "changed"
                ? `The publisher changed this file.${part.printed > 0 ? ` ${copies(part.printed)} the old version.` : ""}`
                : "The publisher's latest files no longer include this part. It may have been replaced by another; your copy is still in its folder."}
            </span>
            <button className="link" onClick={() => store.actions.markUpdatesSeen(project.id, [part.id])}>Mark as seen</button>
          </p>
        )}
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
        {printing > 0 ? (
          <p className="muted queued-note">
            {printing === 1 ? "Printing now" : `${printing} printing now`}{queued > printing ? `, ${queued - printing} more queued` : ""}.
          </p>
        ) : queued > 0 && (
          <p className="muted queued-note">
            {queued} in queued print jobs.
            <button className="link" onClick={() => store.actions.unqueueParts(project.id, [part.id])}>Remove from queue</button>
          </p>
        )}
        <PrintTime part={part} onChange={(printSeconds) => update({ printSeconds, printSecondsEstimated: undefined })} />
        <div className="btn-row">
          <button title="Set Printed to the number needed" onClick={() => update({ printed: part.required })} disabled={part.printed >= part.required}>Mark all printed</button>
          <button title="Set Printed back to 0" onClick={() => update({ printed: 0 })} disabled={part.printed === 0}>Reset</button>
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
          {slicers.map((id) => (
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
                <span className="muted">{running.get(j.id)?.some((it) => it.partId === part.id) ? "printing" : j.status}</span>
              </div>
            ))}
          </div>
        )}
        <button
          className="danger link"
          title="Take this part out of the project. The file stays on disk, and a Rescan adds it back if it's still in the folder"
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

const copies = (n: number) => (n === 1 ? "The copy you printed is" : `The ${n} copies you printed are`);

type RevisionProps = Pick<Props, "store" | "project" | "part" | "replaceCandidates" | "newerVersion" | "onOpenPart">;

/** Where a part stands against other versions of it, and the choices that leaves. */
function RevisionNotes({ store, project, part, replaceCandidates, newerVersion, onOpenPart }: RevisionProps) {
  const { actions } = store;
  const suggested = replaceCandidates[0];
  const [choice, setChoice] = useState("");
  useEffect(() => setChoice(suggested?.id ?? ""), [suggested?.id, part.id]);
  const named = (id?: string) => project.parts.find((p) => p.id === id);
  const replaced = named(part.replaces);
  const successor = named(part.replacedBy);

  if (successor) {
    return (
      <p className="update-note">
        <span>Replaced by {successor.name}, so it no longer counts in this build.</span>
        <button className="link" onClick={() => onOpenPart(successor.id)}>Show it</button>
      </p>
    );
  }
  if (replaced) {
    return (
      <p className="update-note">
        <span>
          Replaces {replaced.name}.
          {replaced.printed > 0 ? ` ${replaced.printed === 1 ? "The copy you printed of it isn't" : `The ${replaced.printed} copies you printed of it aren't`} counted here.` : ""}
        </span>
        <button className="link" onClick={() => actions.undoReplace(project.id, part.id)}>Undo</button>
      </p>
    );
  }
  if (newerVersion) {
    return (
      <div className="update-note column">
        <span>{newerVersion.name} looks like a newer version of this part.{part.printed > 0 ? ` ${copies(part.printed)} this older one.` : ""}</span>
        <div className="btn-row">
          <button className="primary" onClick={() => actions.replacePart(project.id, part.id, newerVersion.id)}>Use the newer version</button>
          <button onClick={() => onOpenPart(newerVersion.id)}>Show it</button>
          <button className="link" onClick={() => actions.setNotRevision(project.id, newerVersion.id)}>Not the same part</button>
        </div>
      </div>
    );
  }
  if (part.update !== "new") return null;

  const shortlist = new Set(replaceCandidates.map((p) => p.id));
  const others = project.parts
    .filter((p) => p.id !== part.id && !shortlist.has(p.id) && !p.replacedBy && p.update !== "new")
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  return (
    <div className="update-note column">
      <span>{suggested ? `This looks like a newer version of ${suggested.name}.` : "New in the publisher's latest files."}</span>
      <div className="replace-row">
        <select value={choice} aria-label="Part this one replaces" onChange={(e) => setChoice(e.target.value)}>
          <option value="">Replaces…</option>
          {[...replaceCandidates, ...others].map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <button disabled={!choice} className={suggested ? "primary" : ""} onClick={() => actions.replacePart(project.id, choice, part.id)}>Replace</button>
      </div>
      <div className="btn-row">
        {suggested && <button className="link" onClick={() => actions.setNotRevision(project.id, part.id)}>Not the same part</button>}
        <button className="link" onClick={() => actions.markUpdatesSeen(project.id, [part.id])}>Mark as seen</button>
      </div>
    </div>
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
