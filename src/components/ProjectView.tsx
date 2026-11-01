import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open, confirm } from "@tauri-apps/plugin-dialog";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { api } from "../api";
import { activeParts, describeScan, partStatus, projectProgress, queuedCounts, type Store } from "../store";
import { sendToSlicer } from "../slicers";
import { dragFiles, dragImage } from "../dragOut";
import { SLICER_NAMES, type Part, type PartStatus, type Project, type SlicerId } from "../types";
import { PartCard } from "./PartCard";
import { FolderPanel } from "./FolderPanel";
import { FolderButton, folderOf } from "./FolderButton";
import { PartDetail } from "./PartDetail";
import { JobsView } from "./JobsView";

interface Props {
  store: Store;
  project: Project;
  notify: (msg: string, kind?: "info" | "error") => void;
  /** Ask the view to open a part (from global search or a printer card). */
  focusRequest?: { partId: string; n: number } | null;
  /** Re-open the "did it work?" prompt for a job the printer finished. */
  onReview: (jobId: string) => void;
}

type Filter = "all" | PartStatus;
const MODEL_FILTERS = [{ name: "3D models", extensions: ["stl", "3mf", "obj", "STL", "3MF", "OBJ"] }];

export function ProjectView({ store, project, notify, focusRequest, onReview }: Props) {
  const { actions, state } = store;
  const [tab, setTab] = useState<"parts" | "jobs">("parts");
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [focusId, setFocusId] = useState<string | null>(null);
  const [showFolders, setShowFolders] = useState(false);
  const [busy, setBusy] = useState(false);
  const [bulkQty, setBulkQty] = useState("1");
  const lastToggled = useRef<string | null>(null);

  useEffect(() => {
    const part = focusRequest && project.parts.find((p) => p.id === focusRequest.partId);
    if (!part) return;
    setTab("parts");
    setFocusId(part.id);
    if (project.collapsedGroups?.includes(part.group)) actions.setGroupsCollapsed(project.id, [part.group], false);
    requestAnimationFrame(() =>
      document.querySelector(`[data-part-id="${part.id}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRequest?.n]);

  const queued = useMemo(() => queuedCounts(project), [project]);
  const progress = projectProgress(project);
  const pct = progress.required ? Math.round((progress.printed / progress.required) * 100) : 0;

  const hidden = useMemo(() => new Set(project.hiddenGroups), [project.hiddenGroups]);
  const collapsed = useMemo(() => new Set(project.collapsedGroups), [project.collapsedGroups]);
  const active = useMemo(() => activeParts(project), [project]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return active.filter((p) => {
      if (filter !== "all" && partStatus(p, queued.get(p.id) ?? 0) !== filter) return false;
      return !q || p.name.toLowerCase().includes(q) || p.group.toLowerCase().includes(q);
    });
  }, [active, filter, query, queued]);

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
    const c = { all: active.length, todo: 0, queued: 0, done: 0 };
    for (const p of active) c[partStatus(p, queued.get(p.id) ?? 0)]++;
    return c;
  }, [active, queued]);

  const hiddenFolders = useMemo(
    () => new Set(project.parts.filter((p) => hidden.has(p.group)).map((p) => p.group)).size,
    [project.parts, hidden],
  );
  const setCollapsed = (groupNames: string[], value: boolean) =>
    actions.setGroupsCollapsed(project.id, groupNames, value);

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

  /** Drags a part (or all ticked parts, if it's one of them) out to another app. */
  const dragOut = useCallback(async (id: string, thumb: HTMLImageElement | null) => {
    const ids = selected.has(id) ? [...selected] : [id];
    const parts = ids
      .map((pid) => project.parts.find((p) => p.id === pid))
      .filter((p): p is Part => !!p && !p.missing);
    if (!parts.length) return;
    try {
      if (!(await dragFiles(parts.map((p) => p.path), dragImage(thumb, parts.length)))) return;
      const r = actions.addDroppedParts(project.id, parts.map((p) => p.id));
      if (!r) return;
      const n = (k: number) => `${k} part${k === 1 ? "" : "s"}`;
      notify(
        r.added === r.total
          ? `Queued ${n(r.added)} as “${r.name}”. Further drops in the next 30 minutes join it.`
          : r.added
            ? `Added ${n(r.added)} to “${r.name}” (${n(r.total)} now).`
            : `Already in “${r.name}”.`,
      );
    } catch (e) {
      notify(String(e), "error");
    }
  }, [selected, project, actions, notify]);

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
            <JobsView store={store} project={project} onSend={send} onFocusPart={(id) => { setFocusId(id); }} onReview={onReview} />
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
              <div className="filters">
                <button onClick={() => setCollapsed(groups.map(([g]) => g), false)} disabled={!groups.some(([g]) => collapsed.has(g))}>
                  Expand all
                </button>
                <button onClick={() => setCollapsed(groups.map(([g]) => g), true)} disabled={groups.every(([g]) => collapsed.has(g))}>
                  Collapse all
                </button>
                <div className="folder-anchor">
                  <button className={showFolders ? "active" : ""} onClick={() => setShowFolders((v) => !v)}>
                    Folders{hiddenFolders ? ` · ${hiddenFolders} hidden` : ""} ▾
                  </button>
                  {showFolders && (
                    <FolderPanel
                      parts={project.parts}
                      hidden={hidden}
                      onSetHidden={(g, h) => actions.setGroupsHidden(project.id, g, h)}
                      onClose={() => setShowFolders(false)}
                      notify={notify}
                    />
                  )}
                </div>
              </div>

              {groups.map(([group, parts]) => {
                const done = parts.filter((p) => p.printed >= p.required).length;
                const isCollapsed = collapsed.has(group);
                return (
                  <section key={group} className="group">
                    <div className="group-head">
                      <button className="group-toggle" onClick={() => setCollapsed([group], !isCollapsed)}>
                        <span className="caret">{isCollapsed ? "▸" : "▾"}</span> {group}
                      </button>
                      <FolderButton path={folderOf(parts, group)} notify={notify} />
                      <span className="muted">{done}/{parts.length} done</span>
                      <div className="progress thin"><div style={{ width: `${(done / parts.length) * 100}%` }} /></div>
                      <button
                        className="link"
                        onClick={() => setSelected((s) => new Set([...s, ...parts.filter((p) => p.printed < p.required).map((p) => p.id)]))}
                      >
                        Select unprinted
                      </button>
                      <button
                        className="link muted-link"
                        title="Hide this folder and leave it out of progress (manage under Folders)"
                        onClick={() => {
                          actions.setGroupsHidden(project.id, [group], true);
                          setSelected((s) => new Set([...s].filter((id) => !parts.some((p) => p.id === id))));
                        }}
                      >
                        Hide
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
                            onDragOut={dragOut}
                          />
                        ))}
                      </div>
                    )}
                  </section>
                );
              })}
              {groups.length === 0 && (
                <div className="empty">
                  {active.length === 0 ? (
                    <p>
                      Every folder is hidden.{" "}
                      <button className="link" onClick={() => actions.setGroupsHidden(project.id, [...hidden], false)}>Show all</button>
                    </p>
                  ) : (
                    <p>No parts match.</p>
                  )}
                </div>
              )}
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
