import { Fragment, useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { RELEASES, unseenReleases, type Release } from "../changelog";

const SEEN_KEY = "3devil-seen-version";

function readSeen() {
  try {
    return localStorage.getItem(SEEN_KEY);
  } catch {
    return null;
  }
}

function writeSeen(version: string) {
  try {
    localStorage.setItem(SEEN_KEY, version);
  } catch {
    // Without storage this just shows again next time.
  }
}

/** Shows `**bold**` from a changelog line; anything else in it stays as written. */
function Line({ text }: { text: string }) {
  return (
    <>
      {text.split("**").map((piece, i) => (
        <Fragment key={i}>{i % 2 ? <strong>{piece}</strong> : piece}</Fragment>
      ))}
    </>
  );
}

/** A release's notes: bullet lines become a list, and anything else a paragraph. */
export function ReleaseNotes({ notes }: { notes: string }) {
  const lines = notes.split("\n").map((l) => l.trim()).filter(Boolean);
  const bullets = lines.filter((l) => l.startsWith("- ")).map((l) => l.slice(2));
  const rest = lines.filter((l) => !l.startsWith("- "));
  return (
    <>
      {rest.map((line, i) => <p key={i} className="small"><Line text={line} /></p>)}
      {bullets.length > 0 && (
        <ul className="release-notes">
          {bullets.map((line, i) => <li key={i}><Line text={line} /></li>)}
        </ul>
      )}
    </>
  );
}

/** Works out what to show once after an update, and shows the whole list on request. */
export function useWhatsNew(ready: boolean, hasProjects: boolean) {
  const [version, setVersion] = useState("");
  const [shown, setShown] = useState<Release[] | null>(null);

  useEffect(() => {
    if (!ready) return;
    getVersion().then((current) => {
      setVersion(current);
      const seen = readSeen();
      // Someone brand new has nothing to compare with.
      const unseen = seen === null && !hasProjects ? [] : unseenReleases(RELEASES, current, seen);
      if (unseen.length) setShown(unseen);
      else writeSeen(current);
    }).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  return {
    shown,
    showAll: () => setShown(RELEASES),
    dismiss: () => {
      if (version) writeSeen(version);
      setShown(null);
    },
  };
}

export function WhatsNew({ releases, onClose }: { releases: Release[]; onClose: () => void }) {
  return (
    <div className="modal-backdrop">
      <div className="modal whats-new">
        <h2>What's new in 3Devil</h2>
        <div className="whats-new-list">
          {releases.map((r) => (
            <section key={r.version}>
              <h3>{r.version}</h3>
              <ReleaseNotes notes={r.notes} />
            </section>
          ))}
        </div>
        <div className="btn-row end">
          <button className="primary" onClick={onClose}>Got it</button>
        </div>
      </div>
    </div>
  );
}
