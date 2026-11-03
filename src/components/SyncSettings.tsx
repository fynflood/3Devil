import { useEffect, useState } from "react";
import { confirm, open } from "@tauri-apps/plugin-dialog";
import { api, basename, type DataLocation } from "../api";
import type { Store } from "../store";

type Notify = (msg: string, kind?: "info" | "error") => void;

/** Which of `folders` aren't on this computer (re-checked when the list changes). */
export function useMissingFolders(folders: string[]): string[] {
  const [missing, setMissing] = useState<string[]>([]);
  const key = JSON.stringify(folders);
  useEffect(() => {
    let live = true;
    api.missingFiles(folders).then((m) => live && setMissing(m)).catch(() => undefined);
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return missing;
}

/**
 * Asks where a folder from another computer is on this one, and remembers it.
 * The mapping covers the parent folders the two paths differ in, so other
 * folders under the same parent are found too.
 */
export async function locateFolder(store: Store, missing: string, notify: Notify) {
  const found = await open({ directory: true, title: `Where is “${basename(missing)}” on this computer?` });
  if (typeof found !== "string") return;
  try {
    const m = await api.addPathMapping(missing, found);
    await store.reload();
    notify(`Folders under ${m.from} now open from ${m.to} on this computer.`);
  } catch (e) {
    notify(String(e), "error");
  }
}

/** Keep projects in a folder several computers share, and where model folders are on each. */
export function SyncSettings({ store, notify }: { store: Store; notify: Notify }) {
  const [loc, setLoc] = useState<DataLocation | null>(null);
  const [busy, setBusy] = useState(false);
  const projects = store.state!.projects;
  const missing = useMissingFolders(projects.flatMap((p) => p.folders));

  const refresh = () => api.dataLocation().then(setLoc).catch((e) => notify(String(e), "error"));
  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      notify(String(e), "error");
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const share = () =>
    run(async () => {
      const dir = await open({ directory: true, title: "Folder to keep 3Devil projects in" });
      if (typeof dir !== "string") return;
      const there = await api.inspectSharedFolder(dir);
      const useExisting = !!there;
      const ok = there
        ? await confirm(
            `That folder already has 3Devil projects (${there.projects} project${there.projects === 1 ? "" : "s"}, ` +
              `saved ${new Date(there.modified).toLocaleString()}). Use those on this computer?\n\n` +
              "This computer's current projects aren't copied there; they stay in its own data folder.",
            { title: "Use shared projects", kind: "info", okLabel: "Use shared projects" },
          )
        : await confirm(
            `Move this computer's projects to ${dir}?\n\nOther computers can then pick the same folder to share them.`,
            { title: "Share projects", kind: "info", okLabel: "Move projects" },
          );
      if (!ok) return;
      await store.saveNow();
      await api.setSharedFolder(dir, useExisting);
      await store.reload();
      notify(useExisting ? "Now using the shared projects." : `Projects moved to ${dir}.`);
    });

  const unshare = () =>
    run(async () => {
      const ok = await confirm(
        "Stop sharing? The shared projects are copied to this computer and kept here only; the shared folder is left as it is.",
        { title: "Stop sharing", kind: "warning", okLabel: "Stop sharing" },
      );
      if (!ok) return;
      await store.saveNow();
      await api.setSharedFolder(null, false);
      await store.reload();
      notify("Projects are now kept on this computer only.");
    });

  const owner = (folder: string) => projects.find((p) => p.folders.includes(folder))?.name;

  return (
    <section>
      <h3>Sync between computers</h3>
      {loc?.sharedDir ? (
        <>
          <p className="muted small">
            Projects are kept in <span className="mono">{loc.sharedDir}</span> and shared with other computers that use the
            same folder. Changes from another computer show up here within a few seconds of syncing. Use one computer at a
            time: edits made on two at once can overwrite each other.
          </p>
          <div className="btn-row">
            <button onClick={() => api.openFolder(loc.sharedDir!).catch((e) => notify(String(e), "error"))}>Open folder</button>
            <button onClick={unshare} disabled={busy}>Stop sharing</button>
          </div>
        </>
      ) : (
        <>
          <p className="muted small">
            Projects are saved on this computer only. To use them on another computer too, pick a folder both can reach:
            one that Syncthing, Dropbox, OneDrive or iCloud Drive keeps in step, or a network share. Slicer settings stay
            separate on each computer.
          </p>
          <div className="btn-row">
            <button onClick={share} disabled={busy || !loc}>Share using a folder…</button>
          </div>
        </>
      )}

      {(missing.length > 0 || (loc?.pathMap.length ?? 0) > 0) && (
        <>
          <h4>Model folders on this computer</h4>
          {missing.length > 0 && (
            <p className="muted small">
              These project folders aren't on this computer, so their parts can't be previewed or sent to a slicer. If
              they're somewhere else here (another drive, a different user folder), locate one and similar folders are
              found too.
            </p>
          )}
          {missing.map((f) => (
            <div key={f} className="setting printer-row">
              <div>
                <strong>{owner(f)}</strong>
                <div className="muted small mono">{f}</div>
              </div>
              <div className="spacer" />
              <button onClick={() => locateFolder(store, f, notify).then(refresh)}>Locate…</button>
            </div>
          ))}
          {loc?.pathMap.map((m) => (
            <div key={m.from} className="setting printer-row">
              <div className="muted small mono">
                {m.from} <span aria-label="opens from">→</span> {m.to}
              </div>
              <div className="spacer" />
              <button
                onClick={() =>
                  run(async () => {
                    await store.saveNow();
                    await api.removePathMapping(m.from);
                    await store.reload();
                  })
                }
              >
                Remove
              </button>
            </div>
          ))}
        </>
      )}
    </section>
  );
}
