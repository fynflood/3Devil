import type { Updater } from "../updater";

/** Asks whether to install the update found when the app started. */
export function UpdatePrompt({ updater }: { updater: Updater }) {
  const { state, offered } = updater;
  if (!offered) return null;
  const installing = state.status === "installing";
  return (
    <div className="modal-backdrop">
      <div className="modal">
        <h2>3Devil {offered} is ready to install</h2>
        <p className="muted">Installing restarts 3Devil. If you'd rather wait, you can install it from the sidebar at any time.</p>
        {state.status === "error" && <p className="small error-text">Couldn't install it: {state.message}</p>}
        <div className="btn-row end">
          <button disabled={installing} onClick={updater.declineOffer}>Not now</button>
          <button className="primary" disabled={installing} onClick={updater.installAndRestart}>
            {installing ? "Installing…" : "Install now"}
          </button>
        </div>
      </div>
    </div>
  );
}
