import { useCallback, useMemo, useRef, useState } from "react";
import { open, confirm } from "@tauri-apps/plugin-dialog";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { api } from "../api";
import { describeScan, partStatus, projectProgress, queuedCounts, type Store } from "../store";
import { sendToSlicer } from "../slicers";
import { SLICER_NAMES, type Part, type PartStatus, type Project, type SlicerId } from "../types";
import { PartCard } from "./PartCard";
import { PartDetail } from "./PartDetail";
import { JobsView } from "./JobsView";

interface Props {
  store: Store;
  project: Project;
  notify: (msg: string, kind?: "info" | "error") => void;
}

type Filter = "all" | PartStatus;
const MODEL_FILTERS = [{ name: "3D models", extensions: ["stl", "3mf", "obj", "STL", "3MF", "OBJ"] }];

export function ProjectView({ store, project, notify }: Props) {
  const { actions, state } = store;
  const [tab, setTab] = useState<"parts" | "jobs">("parts");
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [focusId, setFocusId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [bulkQty, setBulkQty] = useState("1");
  const lastToggled = useRef<string | null>(null);

  const queued = useMemo(() => queuedCounts(project), [project]);
  const progress = projectProgress(project);
  const pct = progress.required ? Math.round((progress.printed / progress.required) * 100) : 0;

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return project.parts.filter((p) => {
      if (filter !== "all" && partStatus(p, queued.get(p.id) ?? 0) !== filter) return false;
      return !q || p.name.toLowerCase().includes(q) || p.group.toLowerCase().includes(q);
    });
  }, [project.parts, filter, query, queued]);

  const groups = useMemo(() => {
    const m = new Map<string, Part[]>();
    for (const p of visible) {
      const list = m.get(p.group) ?? [];
      list.push(p);
      m.set(p.group, list);
    }
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }));
  }, [visible]);

  const ordered = useMemo(() => groups.flatMap(([, parts]) => parts), [groups]);

  const counts = useMemo(() => {
    const c = { all: project.parts.length, todo: 0, queued: 0, done: 0 };
    for (const p of project.parts) c[partStatus(p, queued.get(p.id) ?? 0)]++;
    return c;
  }, [project.parts, queued]);

  const toggle = useCallback((id: string, range: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      const anchor = lastToggled.current;
      if (range && anchor) {
        const a = ordered.findIndex((p) => p.id === anchor);
        const b = ordered.findIndex((p) => p.id === id);
        if (a >= 0 && b >= 0) {
          const [lo, hi] = a < b ? [a, b] : [b, a];
          for (let i = lo; i <= hi; i++) next.add(ordered[i].id);
          return next;
        }
      }
      if (next.has(id)) next.delete(id);
      else next.add(id);
      lastToggled.current = id;
      return next;
    });
  }, [ordered]);

  const adjust = useCallback((id: string, delta: number) => {
    actions.updateParts(project.id, [id], (p) => {
      p.printed = Math.max(0, p.printed + delta);
    });
  }, [actions, project.id]);

  const send = useCallback(async (ids: string[], slicer: SlicerId, recordJob: boolean) => {
    try {
      const job = await sendToSlicer(store, project, ids, slicer, recordJob);
      notify(job ? `Opened in ${SLICER_NAMES[slicer]} and queued as “${job.name}”.` : `Opened in ${SLICER_NAMES[slicer]}.`);
      if (recordJob) setSelected(new Set());
    } catch (e) {
      notify(String(e), "error");
    }
  }, [store, project, notify]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      notify(String(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const addFolder = () => run(async () => {
    const dir = await open({ directory: true, title: "Add a folder of models" });
    if (typeof dir !== "string") return;
    const r = await actions.addFolder(project.id, dir);
    notify(describeScan(r), r.failed.length ? "error" : "info");
  });

  const addZip = () => run(async () => {
    const zip = await open({ title: "Import a ZIP download", filters: [{ name: "ZIP archive", extensions: ["zip", "ZIP"] }] });
    if (typeof zip !== "string") return;
    const dir = await api.extractZip(zip);
    const r = await actions.addFolder(project.id, dir);
    notify(`Extracted to ${dir}: ${describeScan(r)}`, r.failed.length ? "error" : "info");
  });

  const addFiles = () => run(async () => {
    const files = await open({ multiple: true, title: "Add model files", filters: MODEL_FILTERS });
    if (!files?.length) return;
    await actions.addFiles(project.id, files);
  });

  const rescan = () => run(async () => {
    const r = await actions.rescan(project.id);
    notify(`Rescan: ${describeScan(r)}`, r.failed.length ? "error" : "info");
  });

  const sel = [...selected].filter((id) => project.parts.some((p) => p.id === id));
  const focus = project.parts.find((p) => p.id === focusId) ?? null;
  const defaultSlicer = state!.settings.defaultSlicer;
  const otherSlicer: SlicerId = defaultSlicer === "bambu" ? "prusa" : "bambu";

  return (
    <div className="project">
      <header className="project-head">
        <div className="project-title">
          <input
            className="title-input big"
            value={project.name}
            onChange={(e) => actions.updateProject(project.id, { name: e.target.value })}
          />
          <input
            className="desc-input"
            placeholder="Description"
            value={project.description}
            onChange={(e) => actions.updateProject(project.id, { description: e.target.value })}
          />
        </div>
        <div className="progress-block">
          <div className="progress-numbers">
            <strong>{pct}%</strong>
            <span className="muted">
              {progress.printed}/{progress.required} prints · {progress.partsDone}/{progress.parts} parts complete
            </span>
          </div>
          <div className="progress"><div style={{ width: `${pct}%` }} /></div>
        </div>
      </header>

      <div className="toolbar">
        <div className="tabs">
          <button className={tab === "parts" ? "active" : ""} onClick={() => setTab("parts")}>Parts</button>
          <button className={tab === "jobs" ? "active" : ""} onClick={() => setTab("jobs")}>
            Print jobs{project.jobs.some((j) => j.status === "queued") ? ` (${project.jobs.filter((j) => j.status === "queued").length})` : ""}
          </button>
        </div>
        <div className="spacer" />
        {busy && <span className="muted small">Working… (large ZIPs take a moment)</span>}
        <button onClick={addFolder} disabled={busy}>Add folder</button>
        <button onClick={addZip} disabled={busy}>Import ZIP</button>
        <button onClick={addFiles} disabled={busy}>Add files</button>
        <button onClick={rescan} disabled={busy || !project.folders.length} title="Pick up new files and flag missing ones">Rescan</button>
        {project.folders.length > 0 && (
          <button onClick={() => revealItemInDir(project.folders[0])} title={project.folders.join("\n")}>Open folder</button>
        )}
        <input
          className="source-input"
          placeholder="Source URL (e.g. DriveThruRPG product)"
          value={project.sourceUrl}
          onChange={(e) => actions.updateProject(project.id, { sourceUrl: e.target.value })}
        />
        {/^https?:\/\//.test(project.sourceUrl) && <button onClick={() => openUrl(project.sourceUrl)}>↗</button>}
      </div>

      <div className="project-main">
        <div className="project-content">
          {tab === "jobs" ? (
            <JobsView store={store} project={project} onSend={send} onFocusPart={(id) => { setFocusId(id); }} />
          ) : project.parts.length === 0 ? (
            <div className="empty">
              <h3>No parts yet</h3>
              <p>Add a folder of STL/3MF/OBJ files (any ZIPs inside are unpacked automatically), or import a ZIP you downloaded from DriveThruRPG, MyMiniFactory, Printables, etc. Sub-folders become groups. Names like <code>wall_x4.stl</code> set the copy count automatically.</p>
              <div className="btn-row center">
                <button className="primary" onClick={addFolder}>Add folder</button>
                <button onClick={addZip}>Import ZIP</button>
              </div>
            </div>
          ) : (
            <>
              <div className="filters">
                {(["all", "todo", "queued", "done"] as Filter[]).map((f) => (
                  <button key={f} className={`chip${filter === f ? " active" : ""}`} onClick={() => setFilter(f)}>
                    {{ all: "All", todo: "To print", queued: "Queued", done: "Done" }[f]} <span className="muted">{counts[f]}</span>
                  </button>
                ))}
                <input className="search" placeholder="Search parts…" value={query} onChange={(e) => setQuery(e.target.value)} />
                <button className="link" onClick={() => setSelected(new Set(visible.map((p) => p.id)))}>Select all</button>
              </div>

              {groups.map(([group, parts]) => {
                const done = parts.filter((p) => p.printed >= p.required).length;
                const isCollapsed = collapsed.has(group);
                return (
                  <section key={group} className="group">
                    <div className="group-head">
                      <button
                        className="group-toggle"
                        onClick={() => setCollapsed((s) => {
                          const n = new Set(s);
                          if (n.has(group)) n.delete(group);
                          else n.add(group);
                          return n;
                        })}
                      >
                        <span className="caret">{isCollapsed ? "▸" : "▾"}</span> {group}
                      </button>
                      <span className="muted">{done}/{parts.length} done</span>
                      <div className="progress thin"><div style={{ width: `${(done / parts.length) * 100}%` }} /></div>
                      <button
                        className="link"
                        onClick={() => setSelected((s) => new Set([...s, ...parts.filter((p) => p.printed < p.required).map((p) => p.id)]))}
                      >
                        Select unprinted
                      </button>
                    </div>
                    {!isCollapsed && (
                      <div className="grid">
                        {parts.map((p) => (
                          <PartCard
                            key={p.id}
                            part={p}
                            status={partStatus(p, queued.get(p.id) ?? 0)}
                            queued={queued.get(p.id) ?? 0}
                            selected={selected.has(p.id)}
                            focused={focusId === p.id}
                            onToggle={toggle}
                            onFocus={setFocusId}
                            onAdjust={adjust}
                          />
                        ))}
                      </div>
                    )}
                  </section>
                );
              })}
              {groups.length === 0 && <div className="empty"><p>No parts match.</p></div>}
            </>
          )}
        </div>

        {focus && (
          <PartDetail
            key={focus.id}
            store={store}
            project={project}
            part={focus}
            queued={queued.get(focus.id) ?? 0}
            onSend={send}
            onClose={() => setFocusId(null)}
          />
        )}
      </div>

      {sel.length > 0 && tab === "parts" && (
        <div className="selection-bar">
          <strong>{sel.length} selected</strong>
          <button className="primary" onClick={() => send(sel, defaultSlicer, true)}>Send to {SLICER_NAMES[defaultSlicer]}</button>
          <button onClick={() => send(sel, otherSlicer, true)}>Send to {SLICER_NAMES[otherSlicer]}</button>
          <button
            onClick={() => {
              const job = actions.createJob(project.id, sel, null);
              if (job) notify(`Queued “${job.name}”.`);
              setSelected(new Set());
            }}
            title="Track a print job without opening a slicer"
          >
            Queue job
          </button>
          <button onClick={() => actions.updateParts(project.id, sel, (p) => { p.printed = p.required; })}>Mark printed</button>
          <span className="qty-set">
            <input type="number" min={1} value={bulkQty} onChange={(e) => setBulkQty(e.target.value)} title="Copies needed" />
            <button
              onClick={() => {
                const n = parseInt(bulkQty, 10);
                if (n > 0) actions.updateParts(project.id, sel, (p) => { p.required = n; });
              }}
            >
              Set needed
            </button>
          </span>
          <button
            className="danger"
            onClick={async () => {
              if (await confirm(`Remove ${sel.length} part(s) from this project? Files on disk are not touched.`, { title: "Remove parts", kind: "warning" })) {
                actions.removeParts(project.id, sel);
                setSelected(new Set());
              }
            }}
          >
            Remove
          </button>
          <div className="spacer" />
          <button className="link" onClick={() => setSelected(new Set())}>Clear</button>
        </div>
      )}
    </div>
  );
}
