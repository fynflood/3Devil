import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { confirm } from "@tauri-apps/plugin-dialog";
import { projectProgress, useStore } from "./store";
import { usePrinters } from "./printers";
import { ProjectView } from "./components/ProjectView";
import { SettingsView } from "./components/SettingsView";
import { NewProjectDialog } from "./components/NewProjectDialog";
import { PrinterCard } from "./components/PrinterCard";
import { ReviewPrompt } from "./components/ReviewPrompt";
import type { Part, Project } from "./types";
import "./App.css";

type Toast = { msg: string; kind: "info" | "error" };
export type FocusRequest = { partId: string; n: number };

const MAX_RESULTS = 60;

export default function App() {
  const store = useStore();
  const { state, error, actions } = store;
  const [view, setView] = useState<string | "settings" | null>(null);
  const [creating, setCreating] = useState(false);
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

  useEffect(() => {
    if (error) notify(error, "error");
  }, [error, notify]);

  useEffect(() => {
    if (state && view === null && state.projects.length) setView(state.projects[0].id);
  }, [state, view]);

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

  if (!state) return <div className="loading">{error ?? "Loading…"}</div>;

  const review = state.projects
    .flatMap((project) => project.jobs.map((job) => ({ project, job })))
    .find(({ job }) => job.status === "queued" && job.printer?.awaitingReview && !deferred.has(job.id));

  const project = state.projects.find((p) => p.id === view) ?? null;
  const printers = state.settings.printers ?? [];

  return (
    <div className="app">
      <nav className="sidebar">
        <div className="brand">3Devil</div>
        <button className="primary wide" onClick={() => setCreating(true)}>+ New project</button>
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
            state.projects.map((p) => {
              const pr = projectProgress(p);
              const pct = pr.required ? Math.round((pr.printed / pr.required) * 100) : 0;
              return (
                <div
                  key={p.id}
                  className={`project-item${view === p.id ? " active" : ""}`}
                  onClick={() => { setView(p.id); setFocusRequest(null); }}
                >
                  <div className="project-item-row">
                    <span className="project-item-name">{p.name}</span>
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
        <button className={`wide${view === "settings" ? " active" : ""}`} onClick={() => setView("settings")}>Settings</button>
      </nav>

      <main className="main">
        {view === "settings" ? (
          <SettingsView store={store} notify={notify} />
        ) : project ? (
          <ProjectView
            key={project.id}
            store={store}
            project={project}
            notify={notify}
            focusRequest={focusRequest}
            onReview={(jobId) => setDeferred((d) => new Set([...d].filter((id) => id !== jobId)))}
          />
        ) : (
          <div className="empty welcome">
            <h1>3Devil</h1>
            <p>Track big multi-part print builds: every STL, how many you need, what's printed and what's on the plate.</p>
            <button className="primary" onClick={() => setCreating(true)}>Create your first project</button>
          </div>
        )}
      </main>

      {creating && (
        <NewProjectDialog
          store={store}
          notify={notify}
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
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
      {toast && <div className={`toast ${toast.kind}`} onClick={() => setToast(null)}>{toast.msg}</div>}
    </div>
  );
}
