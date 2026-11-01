import { useCallback, useEffect, useRef, useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

/** How often to look for a new release while the app stays open. */
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
/** Wait a little after startup so the check doesn't compete with loading. */
const FIRST_CHECK_MS = 10 * 1000;

export type UpdateState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "current"; checkedAt: number }
  | { status: "downloading"; version: string; received: number; total: number | null }
  | { status: "ready"; version: string; notes?: string }
  | { status: "installing"; version: string }
  | { status: "error"; message: string };

export interface Updater {
  state: UpdateState;
  /** Looks for an update now; a found update downloads in the background. */
  checkNow: () => Promise<void>;
  /** Installs the downloaded update and restarts the app. */
  installAndRestart: () => Promise<void>;
}

/**
 * Checks GitHub releases for a newer version (when `auto` is on, at startup
 * and every few hours), downloads it in the background, and leaves the
 * restart to the user so it never interrupts their work.
 */
export function useUpdater(auto: boolean): Updater {
  const [state, setState] = useState<UpdateState>({ status: "idle" });
  const pending = useRef<Update | null>(null);
  const busy = useRef(false);

  const checkNow = useCallback(async () => {
    if (busy.current || pending.current) return;
    busy.current = true;
    setState({ status: "checking" });
    try {
      const update = await check();
      if (!update) {
        setState({ status: "current", checkedAt: Date.now() });
        return;
      }
      let received = 0;
      let total: number | null = null;
      setState({ status: "downloading", version: update.version, received, total });
      await update.download((e) => {
        if (e.event === "Started") total = e.data.contentLength ?? null;
        else if (e.event === "Progress") received += e.data.chunkLength;
        else return;
        setState({ status: "downloading", version: update.version, received, total });
      });
      pending.current = update;
      setState({ status: "ready", version: update.version, notes: update.body });
    } catch (e) {
      setState({ status: "error", message: String(e) });
    } finally {
      busy.current = false;
    }
  }, []);

  const installAndRestart = useCallback(async () => {
    const update = pending.current;
    if (!update) return;
    setState({ status: "installing", version: update.version });
    try {
      // On Windows the installer closes the app itself; elsewhere restart into the new version.
      await update.install();
      await relaunch();
    } catch (e) {
      setState({ status: "error", message: String(e) });
    }
  }, []);

  useEffect(() => {
    if (!auto) return;
    const first = window.setTimeout(checkNow, FIRST_CHECK_MS);
    const every = window.setInterval(checkNow, CHECK_EVERY_MS);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(every);
    };
  }, [auto, checkNow]);

  return { state, checkNow, installAndRestart };
}
