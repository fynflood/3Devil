import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { confirm } from "@tauri-apps/plugin-dialog";
import { projectProgress, useStore } from "./store";
import { printProgress, runningJobs, usePrinters } from "./printers";
import { ProjectView } from "./components/ProjectView";
import { SettingsView, type SettingsTab } from "./components/SettingsView";
import { PrintersView } from "./components/PrintersView";
import { NewProjectDialog } from "./components/NewProjectDialog";
import { PrinterCard } from "./components/PrinterCard";
import { ReviewPrompt } from "./components/ReviewPrompt";
import { ModelLibrary } from "./components/ModelLibrary";
import { applyTheme, DEFAULT_THEME } from "./theme";
import { useUpdater } from "./updater";
import { useDriveThru } from "./driveThru";
import { useMyMiniFactory } from "./myMiniFactory";
import { UpdateCard } from "./components/UpdateCard";
import { UpdatePrompt } from "./components/UpdatePrompt";
import { useReorder } from "./useReorder";
import { api } from "./api";
import type { Store } from "./store";
import { SLICER_IDS, type Part, type Project } from "./types";
import "./App.css";

type Toast = { msg: string; kind: "info" | "error" };
export type FocusRequest = { partId: string; n: number };

const MAX_RESULTS = 60;

export default function App() {
  const store = useStore();
  const { state, error, actions } = store;
  const [view, setView] = useState<string | "settings" | "printers" | "library" | null>(null);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("general");
  const [creating, setCreating] = useState<"folder" | "zip" | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [search, setSearch] = useState("");
  const [focusRequest, setFocusRequest] = useState<FocusRequest | null>(null);
  /** Jobs whose review prompt was put off with "Decide later" this session. */
  const [deferred, setDeferred] = useState<Set<string>>(new Set());
  const toastTimer = useRef<number | undefined>(undefined);

  const notify = useCallback((msg: string, kind: Toast["kind"] = "info") => {
    setToast({ msg, kind });
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), kind === "error" ? 8000 : 5000);
  }, []);

  const statuses = usePrinters(store, notify);
  const running = useMemo(() => runningJobs(state?.projects ?? [], statuses), [state?.projects, statuses]);
  const partProgress = useMemo(() => printProgress(state?.projects ?? [], statuses), [state?.projects, statuses]);
  const driveThru = useDriveThru(store, notify);
  const mmf = useMyMiniFactory(store, notify);
  const projectIds = useMemo(() => state?.projects.map((p) => p.id) ?? [], [state?.projects]);
  const reorder = useReorder(projectIds, actions.moveProject);
  // Not in development, where an update would try to replace the dev build. The browser mock can opt in.
  const updatable = !import.meta.env.DEV || localStorage.getItem("3devil-mock-updates") !== null;
  const updater = useUpdater(updatable && !!state && (state.settings.autoUpdate ?? true));

  useEffect(() => {
    if (error) notify(error, "error");
  }, [error, notify]);

  useEffect(() => {
    if (store.externalChanges) notify("Updated with changes from another computer.");
  }, [store.externalChanges, notify]);

  const theme = state?.settings.theme ?? DEFAULT_THEME;
  useEffect(() => {
    if (state) applyTheme(theme);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme, !!state]);

  useEffect(() => {
    if (state && view === null && state.projects.length) setView(state.projects[0].id);
  }, [state, view]);

  // Offer the slicers that are installed, rather than every slicer there is.
  useEffect(() => {
    if (!state || state.settings.enabledSlicers) return;
    api
      .detectSlicers()
      .then((found) => {
        const ids = SLICER_IDS.filter((id) => found[id] || state.settings.slicers[id]?.length);
        if (ids.length) actions.setEnabledSlicers(ids);
      })
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!state]);

  const results = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q || !state) return null;
    const projects = state.projects.filter((p) => p.name.toLowerCase().includes(q));
    const parts: { project: Project; part: Part }[] = [];
    let total = 0;
    for (const project of state.projects) {
      for (const part of project.parts) {
        if (part.name.toLowerCase().includes(q) || part.group.toLowerCase().includes(q) || part.notes?.toLowerCase().includes(q)) {
          total++;
          if (parts.length < MAX_RESULTS) parts.push({ project, part });
        }
      }
    }
    return { projects, parts, total };
  }, [search, state]);

  const openPart = useCallback((projectId: string, partId: string) => {
    setView(projectId);
    setFocusRequest((f) => ({ partId, n: (f?.n ?? 0) + 1 }));
  }, []);

  if (!state) return <LoadProblem store={store} />;

  const review = state.projects
    .flatMap((project) => project.jobs.map((job) => ({ project, job })))
    .find(({ job }) => job.status === "queued" && job.printer?.awaitingReview && !deferred.has(job.id));

  const project = state.projects.find((p) => p.id === view) ?? null;
  const printers = (state.settings.printers ?? []).filter((p) => !p.disabled);

  return (
    <div className="app">
      <nav className="sidebar">
        <div className="brand">3Devil</div>
        <button className="primary wide" onClick={() => setCreating("folder")}>+ New project</button>
        <input
          className="sidebar-search"
          type="search"
          placeholder="Search all projects…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && setSearch("")}
        />
        <div className="project-list">
          {results ? (
            <>
              {results.projects.map((p) => (
                <div key={p.id} className="search-hit" onClick={() => { setView(p.id); setSearch(""); }}>
                  <span className="search-kind">Project</span>
                  <span className="search-name">{p.name}</span>
                </div>
              ))}
              {results.parts.map(({ project: p, part }) => (
                <div key={part.id} className="search-hit" onClick={() => openPart(p.id, part.id)}>
                  <span className="search-name">{part.name}</span>
                  <span className="muted small search-where">
                    {p.name} · {part.group}
                    <span className={part.printed >= part.required ? "count done" : "count"}> {part.printed}/{part.required}</span>
                  </span>
                </div>
              ))}
              {results.total > results.parts.length && (
                <div className="muted small">Showing {results.parts.length} of {results.total} parts — refine the search.</div>
              )}
              {!results.projects.length && !results.parts.length && <div className="muted small">No matches.</div>}
            </>
          ) : (
            state.projects.map((p, i) => {
              const pr = projectProgress(p);
              const pct = pr.required ? Math.round((pr.printed / pr.required) * 100) : 0;
              const { drag } = reorder;
              // A line where the project would land; none where it already is.
              const from = drag ? projectIds.indexOf(drag.id) : -1;
              const moves = !!drag && drag.gap !== from && drag.gap !== from + 1;
              const dropClass = !moves ? ""
                : drag.gap === i ? " drop-before"
                : drag.gap === projectIds.length && i === projectIds.length - 1 ? " drop-after"
                : "";
              return (
                <div
                  key={p.id}
                  data-reorder-id={p.id}
                  className={`project-item${view === p.id ? " active" : ""}${drag?.id === p.id ? " dragging" : ""}${dropClass}`}
                  title="Drag to reorder"
                  onPointerDown={(e) => reorder.onPointerDown(e, p.id)}
                  onClick={() => {
                    if (reorder.wasDrag()) return;
                    setView(p.id);
                    setFocusRequest(null);
                  }}
                >
                  <div className="project-item-row">
                    <span className="project-item-name">{p.name}</span>
                    {driveThru.updates.has(p.id) && <span className="pill pill-active" title="The publisher has updated these files">Update</span>}
                    <button
                      className="icon-btn danger hover-only"
                      title="Delete project"
                      onClick={async (e) => {
                        e.stopPropagation();
                        if (await confirm(`Delete “${p.name}”? Model files on disk are not touched.`, { title: "Delete project", kind: "warning" })) {
                          actions.deleteProject(p.id);
                          if (view === p.id) setView(null);
                        }
                      }}
                    >
                      ✕
                    </button>
                  </div>
                  <div className="progress thin"><div style={{ width: `${pct}%` }} /></div>
                  <span className="muted small">{pr.printed}/{pr.required} prints · {pct}%</span>
                </div>
              );
            })
          )}
        </div>
        {printers.length > 0 && (
          <div className="printer-list">
            {printers.map((p) => (
              <PrinterCard
                key={p.id}
                printer={p}
                status={statuses[p.id]}
                projects={state.projects}
                onOpenPart={openPart}
                onReview={(jobId) => setDeferred((d) => new Set([...d].filter((id) => id !== jobId)))}
              />
            ))}
          </div>
        )}
        <UpdateCard updater={updater} />
        <button className={`wide${view === "library" ? " active" : ""}`} onClick={() => setView("library")}>
          Model Library{driveThru.updates.size ? ` · ${driveThru.updates.size} update${driveThru.updates.size === 1 ? "" : "s"}` : ""}
        </button>
        <button className={`wide${view === "printers" ? " active" : ""}`} onClick={() => setView("printers")}>Printers</button>
        <button className={`wide${view === "settings" ? " active" : ""}`} onClick={() => setView("settings")}>Settings</button>
      </nav>

      <main className="main">
        {view === "settings" ? (
          <SettingsView store={store} notify={notify} updater={updater} tab={settingsTab} onTab={setSettingsTab} />
        ) : view === "printers" ? (
          <PrintersView store={store} statuses={statuses} onOpenPart={openPart} notify={notify} />
        ) : view === "library" ? (
          <ModelLibrary
            store={store}
            driveThru={driveThru}
            mmf={mmf}
            onOpenProject={(id) => { setView(id); setFocusRequest(null); }}
            onImportZip={() => setCreating("zip")}
          />
        ) : project ? (
          <ProjectView
            key={project.id}
            store={store}
            project={project}
            driveThru={driveThru}
            running={running}
            partProgress={partProgress}
            notify={notify}
            focusRequest={focusRequest}
            onReview={(jobId) => setDeferred((d) => new Set([...d].filter((id) => id !== jobId)))}
          />
        ) : (
          <div className="empty welcome">
            <h1>3Devil</h1>
            <p>Track big multi-part print builds: every STL, how many you need, what's printed and what's on the plate.</p>
            <button className="primary" onClick={() => setCreating("folder")}>Create your first project</button>
          </div>
        )}
      </main>

      {creating && (
        <NewProjectDialog
          store={store}
          notify={notify}
          initialSource={creating}
          onClose={() => setCreating(null)}
          onCreated={(id) => {
            setCreating(null);
            setView(id);
          }}
        />
      )}
      {review && (
        <ReviewPrompt
          key={review.job.id}
          store={store}
          project={review.project}
          job={review.job}
          onLater={() => setDeferred((d) => new Set(d).add(review.job.id))}
          onOpenPart={(projectId, partId) => {
            setDeferred((d) => new Set(d).add(review.job.id));
            openPart(projectId, partId);
          }}
        />
      )}
      {!review && !creating && <UpdatePrompt updater={updater} />}
      {toast && <div className={`toast ${toast.kind}`} onClick={() => setToast(null)}>{toast.msg}</div>}
    </div>
  );
}

/** Shown until projects load, with a way out if a shared folder can't be reached. */
function LoadProblem({ store }: { store: Store }) {
  const [shared, setShared] = useState<string | null>(null);
  useEffect(() => {
    if (store.error) api.dataLocation().then((l) => setShared(l.sharedDir)).catch(() => undefined);
  }, [store.error]);
  if (!store.error) return <div className="loading">Loading…</div>;
  return (
    <div className="loading">
      <p>{store.error}</p>
      <div className="btn-row center">
        <button className="primary" onClick={() => store.reload().catch((e) => store.setError(String(e)))}>Try again</button>
        {shared && (
          <button
            onClick={() =>
              api
                .setSharedFolder(null, false)
                .then(store.reload)
                .catch((e) => store.setError(String(e)))
            }
            title="Go back to the projects this computer had before sharing"
          >
            Use this computer's projects
          </button>
        )}
      </div>
    </div>
  );
}
