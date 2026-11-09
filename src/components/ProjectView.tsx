import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { open, confirm } from "@tauri-apps/plugin-dialog";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { api, formatGrams, formatLongDuration } from "../api";
import { printingCounts } from "../printers";
import { activeParts, describeScan, partStatus, projectProgress, queuedCounts, filamentLeft, projectStats, timeLeft, type Store } from "../store";
import { findRevisions } from "../revisions";
import { enabledSlicers, mainSlicer, sendToSlicer } from "../slicers";
import { dragFiles, dragImage } from "../dragOut";
import { SLICER_NAMES, type JobItem, type Part, type PartStatus, type Project, type SlicerId } from "../types";
import { PartCard } from "./PartCard";
import { FolderPanel } from "./FolderPanel";
import { FolderButton, folderOf } from "./FolderButton";
import { PartDetail } from "./PartDetail";
import { RemoveFolderDialog } from "./RemoveFolderDialog";
import { JobsView } from "./JobsView";
import { locateFolder, useMissingFolders } from "./SyncSettings";
import { DownloadStatus } from "./DriveThruView";
import type { DriveThru } from "../driveThru";
import type { PartProgress } from "../printers";

interface Props {
  store: Store;
  project: Project;
  driveThru: DriveThru;
  /** What printers are making right now, by job id. */
  running: Map<string, JobItem[]>;
  /** How far along each part's print is. */
  partProgress: Map<string, PartProgress>;
  notify: (msg: string, kind?: "info" | "error") => void;
  /** Ask the view to open a part (from global search or a printer card). */
  focusRequest?: { partId: string; n: number } | null;
  /** Re-open the "did it work?" prompt for a job the printer finished. */
  onReview: (jobId: string) => void;
}

type Filter = "all" | PartStatus | "updated";
const MODEL_FILTERS = [{ name: "3D models", extensions: ["stl", "3mf", "obj", "STL", "3MF", "OBJ"] }];

const TIPS = {
  addFolder: "Add every model in a folder to this project. ZIPs inside are unpacked, and sub-folders become groups",
  addZip: "Unpack a ZIP next to where it's saved and add its models to this project. To start a new project from one, use + New project",
};

const sendTip = (id: SlicerId) => `Open the selected parts in ${SLICER_NAMES[id]} and add them to a queued print job`;

/** The folder every group sits inside, if there is one. */
function commonFolder(groups: string[]) {
  const [first = [], ...rest] = groups.map((g) => g.split("/"));
  let shared = first.length;
  for (const segments of rest) {
    let i = 0;
    while (i < shared && segments[i] === first[i]) i++;
    shared = i;
  }
  return first.slice(0, shared).join("/");
}

/** A group's path without the folder all of them share, which only adds length to every row. */
function groupLabel(group: string, shared: string) {
  if (!shared) return group;
  return group === shared ? group.slice(group.lastIndexOf("/") + 1) : group.slice(shared.length + 1);
}

/** How long the part panel and folders take to close; covers `detail-close` and `group-close` in App.css. */
const CLOSE_MS = 180;
/** How long the part panel takes to slide open; matches `detail-open` in App.css. */
const PANEL_OPEN_MS = 220;

/** Keeps the last value for a moment after it clears, so what shows it can animate away. */
function useLingering(id: string | null) {
  const [last, setLast] = useState(id);
  useEffect(() => {
    if (id) return setLast(id);
    const timer = window.setTimeout(() => setLast(null), CLOSE_MS);
    return () => window.clearTimeout(timer);
  }, [id]);
  return id ?? last;
}

/** A folder's parts. They're only mounted while open, and animate when toggled but not on first showing. */
function GroupBody({ open, children }: { open: boolean; children: ReactNode }) {
  const [wasOpen, setWasOpen] = useState(open);
  const [moving, setMoving] = useState(false);
  const [closing, setClosing] = useState(false);
  if (wasOpen !== open) {
    setWasOpen(open);
    setMoving(true);
    setClosing(!open);
  }
  useEffect(() => {
    if (!closing) return;
    const timer = window.setTimeout(() => setClosing(false), CLOSE_MS);
    return () => window.clearTimeout(timer);
  }, [closing]);
  if (!open && !closing) return null;
  return (
    <div
      className={`group-body${moving ? " moving" : ""}${open ? "" : " closing"}`}
      onAnimationEnd={(e) => open && e.target === e.currentTarget && setMoving(false)}
    >
      <div>{children}</div>
    </div>
  );
}

export function ProjectView({ store, project, driveThru, running, partProgress, notify, focusRequest, onReview }: Props) {
  const { actions, state } = store;
  const [tab, setTab] = useState<"parts" | "jobs">("parts");
  const [removing, setRemoving] = useState<string | null>(null);
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
  const printing = useMemo(() => printingCounts(project, running), [project, running]);
  const statusOf = useCallback(
    (p: Part) => partStatus(p, queued.get(p.id) ?? 0, printing.get(p.id) ?? 0),
    [queued, printing],
  );
  const progress = projectProgress(project);
  const missingFolders = useMissingFolders(project.folders);
  const pct = progress.required ? Math.round((progress.printed / progress.required) * 100) : 0;

  const hidden = useMemo(() => new Set(project.hiddenGroups), [project.hiddenGroups]);
  const collapsed = useMemo(() => new Set(project.collapsedGroups), [project.collapsedGroups]);
  const active = useMemo(() => activeParts(project), [project]);

  const revisions = useMemo(() => findRevisions(project.parts), [project.parts]);
  /** Older parts with the new part that looks like their newer version. */
  const newerVersions = useMemo(() => {
    const m = new Map<string, Part>();
    for (const [id, [older]] of revisions) {
      const part = project.parts.find((p) => p.id === id);
      if (part && !m.has(older.id)) m.set(older.id, part);
    }
    return m;
  }, [revisions, project.parts]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return active.filter((p) => {
      if (filter === "updated" ? !p.update && !newerVersions.has(p.id) : filter !== "all" && statusOf(p) !== filter) return false;
      return !q || p.name.toLowerCase().includes(q) || p.group.toLowerCase().includes(q);
    });
  }, [active, filter, query, statusOf, newerVersions]);

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
  const sharedFolder = useMemo(() => commonFolder(project.parts.map((p) => p.group)), [project.parts]);
  const nameLength = Math.max(0, ...groups.map(([g]) => groupLabel(g, sharedFolder).length));

  const counts = useMemo(() => {
    const c = { all: active.length, todo: 0, queued: 0, printing: 0, done: 0, updated: 0 };
    for (const p of active) {
      c[statusOf(p)]++;
      if (p.update || newerVersions.has(p.id)) c.updated++;
    }
    return c;
  }, [active, statusOf, newerVersions]);

  useEffect(() => {
    if ((filter === "updated" || filter === "printing") && !counts[filter]) setFilter("all");
  }, [filter, counts]);

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

  const unqueue = useCallback((id: string) => actions.unqueueParts(project.id, [id]), [actions, project.id]);

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
    const dir = await open({ directory: true, title: `Add a folder of models to ${project.name}` });
    if (typeof dir !== "string") return;
    const r = await actions.addFolder(project.id, dir, true);
    notify(`${project.name}: ${describeScan(r)}`, r.failed.length ? "error" : "info");
  });

  const addZip = () => run(async () => {
    const zip = await open({ title: `Add a ZIP to ${project.name}`, filters: [{ name: "ZIP archive", extensions: ["zip", "ZIP"] }] });
    if (typeof zip !== "string") return;
    const dir = await api.extractZip(zip);
    const r = await actions.addFolder(project.id, dir, true);
    notify(`${project.name}: unpacked to ${dir}: ${describeScan(r)}`, r.failed.length ? "error" : "info");
  });

  const addFiles = () => run(async () => {
    const files = await open({ multiple: true, title: `Add model files to ${project.name}`, filters: MODEL_FILTERS });
    if (!files?.length) return;
    await actions.addFiles(project.id, files);
  });

  const rescan = () => run(async () => {
    const r = await actions.rescan(project.id);
    notify(`Rescan: ${describeScan(r)}`, r.failed.length ? "error" : "info");
  });

  const sel = [...selected].filter((id) => project.parts.some((p) => p.id === id));
  const panelId = useLingering(focusId);
  const panelOpen = focusId !== null;
  const [panelSettled, setPanelSettled] = useState(false);
  useEffect(() => {
    if (!panelOpen) return setPanelSettled(false);
    const timer = window.setTimeout(() => setPanelSettled(true), PANEL_OPEN_MS);
    return () => window.clearTimeout(timer);
  }, [panelOpen]);
  const focus = project.parts.find((p) => p.id === panelId) ?? null;
  const update = driveThru.updates.get(project.id);
  const match = driveThru.matches.get(project.id);
  const slicers = enabledSlicers(state!.settings);
  const defaultSlicer = mainSlicer(state!.settings);
  const sendButtons = slicers.filter((id) => id !== defaultSlicer);

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
          <LeftToPrint project={project} />
          <ProjectStats project={project} />
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
        <div className="add-to-project" role="group" aria-label="Add to this project">
          <span className="muted small">Add to this project:</span>
          <button onClick={addFolder} disabled={busy} title={TIPS.addFolder}>Folder</button>
          <button onClick={addZip} disabled={busy} title={TIPS.addZip}>ZIP</button>
          <button onClick={addFiles} disabled={busy} title="Add single model files to this project, listed under Loose files">Files</button>
        </div>
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

      {update && !missingFolders.length && (
        <div className="banner">
          <span>
            {update.publisher?.name ?? "The publisher"} changed these files on {new Date(update.fileLastModified ?? 0).toLocaleDateString()}.
            {driveThru.busy === update.orderProductId && <DownloadStatus progress={driveThru.progress} />}
          </span>
          <button className="primary" title="Download only the files the publisher changed" disabled={driveThru.busy !== null} onClick={() => driveThru.update(update, project)}>Download update</button>
        </div>
      )}
      {newerVersions.size > 0 && (
        <div className="banner">
          <span>
            {newerVersions.size === 1
              ? `${[...newerVersions.values()][0].name} looks like a newer version of ${project.parts.find((p) => p.id === [...newerVersions.keys()][0])?.name}.`
              : `${newerVersions.size} new parts look like newer versions of parts you already have.`}
          </span>
          <button
            onClick={() => {
              setFilter("updated");
              setTab("parts");
              if (newerVersions.size === 1) setFocusId([...newerVersions.values()][0].id);
            }}
          >
            Review
          </button>
        </div>
      )}
      {match && (
        <div className="banner">
          <span>This looks like “{match.name}” from your DriveThruRPG library. Link it to get updates here.</span>
          <button className="primary" title="Get publisher updates for this project" onClick={() => driveThru.link(match, project)}>Link</button>
        </div>
      )}
      {missingFolders.map((f) => (
        <div key={f} className="banner">
          <span>
            This project's folder isn't on this computer: <span className="mono">{f}</span>
          </span>
          <button onClick={() => locateFolder(store, f, notify)} title="Show 3Devil where this folder is on this computer">Locate…</button>
        </div>
      ))}

      <div className="project-main">
        <div className={`project-content${tab !== "jobs" && project.parts.length ? " with-toolbar" : ""}`}>
          {tab === "jobs" ? (
            <JobsView store={store} project={project} onSend={send} onFocusPart={(id) => { setFocusId(id); }} onReview={onReview} />
          ) : project.parts.length === 0 ? (
            <div className="empty">
              <h3>No parts yet</h3>
              <p>Add a folder of STL/3MF/OBJ files (any ZIPs inside are unpacked automatically), or import a ZIP you downloaded from DriveThruRPG, MyMiniFactory, Printables, etc. Sub-folders become groups. Names like <code>wall_x4.stl</code> set the copy count automatically.</p>
              <div className="btn-row center">
                <button className="primary" onClick={addFolder} title={TIPS.addFolder}>Add folder</button>
                <button onClick={addZip} title={TIPS.addZip}>Add ZIP</button>
              </div>
            </div>
          ) : (
            <>
              <div className="parts-toolbar">
                <div className="filters">
                  {(["all", "todo", ...(counts.printing ? ["printing"] : []), "queued", "done", ...(counts.updated ? ["updated"] : [])] as Filter[]).map((f) => (
                    <button key={f} className={`chip${filter === f ? " active" : ""}`} onClick={() => setFilter(f)}>
                      {{ all: "All", todo: "To print", printing: "Printing", queued: "Queued", done: "Done", updated: "Updated" }[f]} <span className="muted">{counts[f]}</span>
                    </button>
                  ))}
                  {filter === "updated" && (
                    <>
                      {newerVersions.size > 0 && (
                        <button
                          className="link"
                          title="Each new part takes over from the older part it looks like"
                          onClick={() => newerVersions.forEach((part, oldId) => actions.replacePart(project.id, oldId, part.id))}
                        >
                          Use all newer versions
                        </button>
                      )}
                      <button className="link" onClick={() => actions.markUpdatesSeen(project.id, active.map((p) => p.id))}>Mark all as seen</button>
                    </>
                  )}
                  <input className="search" placeholder="Search parts…" value={query} onChange={(e) => setQuery(e.target.value)} />
                  <button className="link" title="Select every part the filters are showing" onClick={() => setSelected(new Set(visible.map((p) => p.id)))}>Select all</button>
                </div>
                <div className="filters">
                  <button onClick={() => setCollapsed(groups.map(([g]) => g), false)} disabled={!groups.some(([g]) => collapsed.has(g))}>
                    Expand all
                  </button>
                  <button onClick={() => setCollapsed(groups.map(([g]) => g), true)} disabled={groups.every(([g]) => collapsed.has(g))}>
                    Collapse all
                  </button>
                  <div className="folder-anchor">
                    <button className={showFolders ? "active" : ""} title="Choose which folders count towards this project" onClick={() => setShowFolders((v) => !v)}>
                      Folders{hiddenFolders ? ` · ${hiddenFolders} hidden` : ""} ▾
                    </button>
                    {showFolders && (
                      <FolderPanel
                        parts={project.parts}
                        hidden={hidden}
                        onSetHidden={(g, h) => actions.setGroupsHidden(project.id, g, h)}
                        onRemove={setRemoving}
                        onClose={() => setShowFolders(false)}
                        notify={notify}
                      />
                    )}
                  </div>
                </div>

              </div>
              <div className="parts-list" style={{ "--group-name": `${nameLength}ch` } as CSSProperties}>
                {groups.map(([group, parts]) => {
                  const done = parts.filter((p) => p.printed >= p.required).length;
                  const isCollapsed = collapsed.has(group);
                  const name = groupLabel(group, sharedFolder);
                  const leaf = name.lastIndexOf("/") + 1;
                  return (
                    <section key={group} className={`group${isCollapsed ? " collapsed" : ""}`}>
                      <div className="group-head">
                        <button className="group-toggle" title={group} onClick={() => setCollapsed([group], !isCollapsed)}>
                          <span className={`caret${isCollapsed ? " shut" : ""}`}>▾</span>
                          <span className="group-path">{name.slice(0, leaf)}</span>
                          <span className="group-leaf">{name.slice(leaf)}</span>
                        </button>
                        <span className="group-folder"><FolderButton path={folderOf(parts, group)} notify={notify} /></span>
                        <span className="muted group-count">{done}/{parts.length} done</span>
                        <div className="progress thin"><div style={{ width: `${(done / parts.length) * 100}%` }} /></div>
                        <button
                          className="link"
                          title="Select every part in this folder that still needs printing"
                          onClick={() => setSelected((s) => new Set([...s, ...parts.filter((p) => p.printed < p.required).map((p) => p.id)]))}
                        >
                          Select unprinted
                        </button>
                        <span className="group-links">
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
                          <button
                            className="link muted-link"
                            title="Take this folder and its sub-folders out of the project, and choose whether to move the files to the Trash"
                            onClick={() => setRemoving(group)}
                          >
                            Remove
                          </button>
                        </span>
                      </div>
                      <GroupBody open={!isCollapsed}>
                        <div className="grid">
                          {parts.map((p) => (
                            <PartCard
                              key={p.id}
                              part={p}
                              status={statusOf(p)}
                              queued={queued.get(p.id) ?? 0}
                              printing={printing.get(p.id) ?? 0}
                              progress={partProgress.get(p.id)?.percent}
                              selected={selected.has(p.id)}
                              focused={focusId === p.id}
                              onToggle={toggle}
                              onFocus={setFocusId}
                              onAdjust={adjust}
                              onDragOut={dragOut}
                              onUnqueue={unqueue}
                              isRevision={revisions.has(p.id)}
                              hasNewerVersion={newerVersions.has(p.id)}
                            />
                          ))}
                        </div>
                      </GroupBody>
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
              </div>
            </>
          )}
        </div>

        {focus && (
          <div className={`detail-slide${focusId ? "" : " closing"}`}>
            <PartDetail
              key={focus.id}
              store={store}
              project={project}
              part={focus}
              queued={queued.get(focus.id) ?? 0}
              printing={printing.get(focus.id) ?? 0}
              progress={partProgress.get(focus.id)}
              showViewer={panelSettled}
              running={running}
              slicers={slicers}
              replaceCandidates={revisions.get(focus.id) ?? []}
              newerVersion={newerVersions.get(focus.id)}
              onOpenPart={setFocusId}
              onSend={send}
              onClose={() => setFocusId(null)}
            />
          </div>
        )}
      </div>

      {removing && (
        <RemoveFolderDialog
          project={project}
          projects={state!.projects}
          group={removing}
          onClose={() => setRemoving(null)}
          onRemoved={(trashed) => {
            actions.removeFolder(project.id, removing);
            setRemoving(null);
            const name = removing.slice(removing.lastIndexOf("/") + 1);
            notify(trashed ? `Removed “${name}” and moved it to the Trash.` : `Removed “${name}” from ${project.name}. Its files are still on disk.`);
          }}
        />
      )}

      {sel.length > 0 && tab === "parts" && (
        <div className="selection-bar">
          <strong>{sel.length} selected</strong>
          {defaultSlicer && <button className="primary" title={sendTip(defaultSlicer)} onClick={() => send(sel, defaultSlicer, true)}>Send to {SLICER_NAMES[defaultSlicer]}</button>}
          {sendButtons.map((id) => <button key={id} title={sendTip(id)} onClick={() => send(sel, id, true)}>Send to {SLICER_NAMES[id]}</button>)}
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
          {sel.some((id) => queued.has(id)) && (
            <button
              onClick={() => {
                actions.unqueueParts(project.id, sel);
                notify(`Removed ${sel.filter((id) => queued.has(id)).length} part(s) from the queue.`);
              }}
              title="Take the selected parts out of every queued print job"
            >
              Remove from queue
            </button>
          )}
          <button title="Count all the needed copies of the selected parts as printed" onClick={() => actions.updateParts(project.id, sel, (p) => { p.printed = p.required; })}>Mark printed</button>
          <span className="qty-set">
            <input type="number" min={1} value={bulkQty} onChange={(e) => setBulkQty(e.target.value)} title="Copies needed" />
            <button
              title="Set how many copies of each selected part you need"
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
            title="Take the selected parts out of the project. Their files stay on disk, and a Rescan adds them back if they're still in the folder"
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

/** Printer time and filament still needed, in one line. */
function LeftToPrint({ project }: { project: Project }) {
  const t = timeLeft(project);
  const f = filamentLeft(project);
  if (!t.remainingParts) return null;
  const time = t.known + t.guessed;
  const grams = f.known + f.guessed;
  const amounts = [time ? `${formatLongDuration(time)} of printing` : null, grams ? `${formatGrams(grams)} of filament` : null]
    .filter(Boolean)
    .join(" and ");
  return <div className="muted small time-left">{amounts ? `About ${amounts} left` : "No print times or filament weights yet"}</div>;
}

const shortDate = (ms: number) => new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });

/** Everything the project's prints add up to, shown while hovering its progress. */
function ProjectStats({ project }: { project: Project }) {
  const progress = projectProgress(project);
  const st = projectStats(project);
  const t = timeLeft(project);
  const f = filamentLeft(project);
  const plural = (n: number, what: string) => `${n} ${what}${n === 1 ? "" : "s"}`;
  /** How much of a figure left is measured and how much guessed. */
  const basis = (left: ReturnType<typeof timeLeft>, format: (n: number) => string, none: string) => {
    if (!left.missing) return "All from recorded parts";
    if (!left.guessable) return `Leaves out ${plural(left.missing, "part")} ${none}`;
    return left.known
      ? `${format(left.known)} recorded, ${format(left.guessed)} guessed for ${plural(left.missing, "part")} from file size`
      : `Guessed for ${plural(left.missing, "part")} from file size`;
  };
  const jobs = st.jobsDone + st.jobsFailed;
  const copiesLeft = progress.required - progress.printed;
  const partsLeft = progress.parts - progress.partsDone;
  const timeLeftTotal = t.known + t.guessed;
  const gramsLeft = f.known + f.guessed;
  const rows: Row[] = [
    ["Print jobs", jobs ? `${st.jobsDone} good, ${st.jobsFailed} failed (${Math.round((st.jobsDone / jobs) * 100)}% worked)` : null],
    ["Printer time", st.goodSec + st.failedSec ? `${formatLongDuration(st.goodSec + st.failedSec)}${st.failedSec ? `, ${formatLongDuration(st.failedSec)} of it on failed prints` : ""}` : null],
    ["Filament", st.grams ? `About ${formatGrams(st.grams)}${st.failedGrams >= 1 ? `, ${formatGrams(st.failedGrams)} of it on failed prints` : ""}` : null],
    ["Printing since", st.since ? `${shortDate(st.since)}, about ${formatLongDuration(st.perDay)} a day` : null],
  ];
  const leftRows: Row[] = [
    ["Copies", copiesLeft > 0 ? `${copiesLeft} of ${progress.required}, across ${plural(partsLeft, "part")}` : null],
    timeLeftTotal
      ? ["Printer time", `About ${formatLongDuration(timeLeftTotal)}`, basis(t, formatLongDuration, "with no time yet")]
      : ["Printer time", t.missing ? `No print times yet for ${plural(t.missing, "part")}` : null],
    gramsLeft
      ? ["Filament", `About ${formatGrams(gramsLeft)}, ${spools(gramsLeft)}`, basis(f, formatGrams, "with no weight yet")]
      : ["Filament", f.missing ? `No weights yet for ${plural(f.missing, "part")}` : null],
    [
      "Done around",
      st.finishAt ? shortDate(st.finishAt) : null,
      `At ${formatLongDuration(st.perDay)} of printing a day${st.overhead >= 0.05 ? `, plus ${Math.round(st.overhead * 100)}% for failures like so far` : ""}`,
    ],
  ];
  const section = (title: string, list: Row[]) => {
    const shown = list.filter((r) => !!r[1]);
    return shown.length ? (
      <>
        <h4>{title}</h4>
        <dl>
          {shown.map(([k, v, note]) => (
            <Fragment key={k}>
              <dt>{k}</dt>
              <dd>
                {v}
                {note && <span className="muted">{note}</span>}
              </dd>
            </Fragment>
          ))}
        </dl>
      </>
    ) : null;
  };
  return (
    <div className="stats-card" role="tooltip">
      {section("So far", rows)}
      {section("Left", leftRows)}
      <p className="muted">Times and weights come from tracked prints, or what you enter on a part.</p>
    </div>
  );
}

/** Filament as the 1 kg spools it takes: "7 spools of 1 kg". */
function spools(grams: number) {
  const n = Math.ceil(grams / 1000);
  return n === 1 ? "under a 1 kg spool" : `${n} spools of 1 kg`;
}

/** A line of the stats card: label, figure, and an optional note on how it was worked out. */
type Row = [string, string | null, string?];
