import { formatBytes } from "../api";
import type { Updater } from "../updater";

/** Sidebar notice while an update downloads, and the button to apply it. */
export function UpdateCard({ updater }: { updater: Updater }) {
  const { state } = updater;
  if (state.status === "downloading") {
    const pct = state.total ? Math.round((state.received / state.total) * 100) : null;
    return (
      <div className="update-card">
        <span className="small">Downloading 3Devil {state.version}…</span>
        <div className="progress thin"><div style={{ width: `${pct ?? 0}%` }} /></div>
        <span className="muted small">{pct !== null ? `${pct}%` : formatBytes(state.received)}</span>
      </div>
    );
  }
  if (state.status === "ready" || state.status === "installing") {
    return (
      <div className="update-card">
        <span className="small"><strong>3Devil {state.version}</strong> is ready to install.</span>
        <button className="primary" disabled={state.status === "installing"} onClick={updater.installAndRestart}>
          {state.status === "installing" ? "Installing…" : "Restart to update"}
        </button>
      </div>
    );
  }
  return null;
}
