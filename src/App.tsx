import { useCallback, useEffect, useRef, useState } from "react";
import { confirm } from "@tauri-apps/plugin-dialog";
import { projectProgress, useStore } from "./store";
import { ProjectView } from "./components/ProjectView";
import { SettingsView } from "./components/SettingsView";
import { NewProjectDialog } from "./components/NewProjectDialog";
import "./App.css";

type Toast = { msg: string; kind: "info" | "error" };

export default function App() {
  const store = useStore();
  const { state, error, actions } = store;
  const [view, setView] = useState<string | "settings" | null>(null);
  const [creating, setCreating] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);

  const notify = useCallback((msg: string, kind: Toast["kind"] = "info") => {
    setToast({ msg, kind });
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), kind === "error" ? 8000 : 4000);
  }, []);

  useEffect(() => {
    if (error) notify(error, "error");
  }, [error, notify]);

  useEffect(() => {
    if (state && view === null && state.projects.length) setView(state.projects[0].id);
  }, [state, view]);

  if (!state) return <div className="loading">{error ?? "Loading…"}</div>;

  const project = state.projects.find((p) => p.id === view) ?? null;

  return (
    <div className="app">
      <nav className="sidebar">
        <div className="brand">3Devil</div>
        <button className="primary wide" onClick={() => setCreating(true)}>+ New project</button>
        <div className="project-list">
          {state.projects.map((p) => {
            const pr = projectProgress(p);
            const pct = pr.required ? Math.round((pr.printed / pr.required) * 100) : 0;
            return (
              <div
                key={p.id}
                className={`project-item${view === p.id ? " active" : ""}`}
                onClick={() => setView(p.id)}
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
          })}
        </div>
        <button className={`wide${view === "settings" ? " active" : ""}`} onClick={() => setView("settings")}>Settings</button>
      </nav>

      <main className="main">
        {view === "settings" ? (
          <SettingsView store={store} notify={notify} />
        ) : project ? (
          <ProjectView key={project.id} store={store} project={project} notify={notify} />
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
      {toast && <div className={`toast ${toast.kind}`} onClick={() => setToast(null)}>{toast.msg}</div>}
    </div>
  );
}
