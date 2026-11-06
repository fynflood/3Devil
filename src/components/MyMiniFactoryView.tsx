import { useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api } from "../api";
import type { MyMiniFactory } from "../myMiniFactory";
import type { Store } from "../store";
import type { MmfModel } from "../types";
import { DownloadStatus } from "./DriveThruView";

interface Props {
  store: Store;
  mmf: MyMiniFactory;
  onOpenProject: (id: string) => void;
  onImportZip: () => void;
}

const LIKES = "likes";

function ModelRow({ model, mmf, onOpenProject }: { model: MmfModel; mmf: MyMiniFactory; onOpenProject: Props["onOpenProject"] }) {
  const project = mmf.linked.get(model.id);
  const isBusy = mmf.busy === model.id;
  const details = [model.designer, model.price ?? "Free"].filter(Boolean).join(" · ");
  const create = async () => {
    const id = await mmf.create(model);
    if (id) onOpenProject(id);
  };
  return (
    <div className="drivethru-row">
      <div className="drivethru-info">
        <button className="link drivethru-name" onClick={() => openUrl(model.url)} title="Open the store page">{model.name}</button>
        <span className="muted small">
          {details}
          {model.bought && <span className="pill pill-done model-owned">Owned</span>}
        </span>
        {isBusy && <DownloadStatus progress={mmf.progress} />}
      </div>
      {project ? (
        <button onClick={() => onOpenProject(project.id)}>Open project</button>
      ) : model.price && model.bought === false ? (
        <button onClick={() => openUrl(model.url)} title="You don't own this one yet">View on store</button>
      ) : (
        <button className="primary" onClick={create} disabled={mmf.busy !== null} title="Download this model and make a project from it">
          {isBusy ? "Downloading…" : "Create project"}
        </button>
      )}
    </div>
  );
}

/** Models from MyMiniFactory, once signed in: likes, collections and anything pasted in. */
export function MyMiniFactoryView({ store, mmf, onOpenProject, onImportZip }: Props) {
  const { account, library, loading, refresh } = mmf;
  const [list, setList] = useState(LIKES);
  const [query, setQuery] = useState("");
  const [link, setLink] = useState("");
  const [connecting, setConnecting] = useState(false);
  const folder = store.state!.settings.myMiniFactory?.libraryPath ?? "";

  useEffect(() => {
    if (account && !library && !loading && !mmf.error) refresh();
  }, [account, library, loading, mmf.error, refresh]);

  const collection = library?.collections.find((c) => c.name === list);
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const models = collection?.models ?? library?.likes ?? [];
    return models.filter((m) => !q || m.name.toLowerCase().includes(q) || (m.designer ?? "").toLowerCase().includes(q));
  }, [collection, library, query]);

  if (!account) {
    return (
      <div className="empty">
        <h3>Connect MyMiniFactory</h3>
        <p>Sign in to see the models you've liked or collected, and download the ones you own into projects.</p>
        <div className="btn-row center">
          {mmf.signingIn ? (
            <>
              <span className="muted">Waiting for you to sign in, in your browser…</span>
              <button onClick={() => api.mmfCancelSignIn()}>Cancel</button>
            </>
          ) : (
            <button className="primary" onClick={mmf.signIn} title="Opens MyMiniFactory's own sign-in page in your browser">Sign in with MyMiniFactory</button>
          )}
        </div>
        <p className="muted small">
          You sign in on MyMiniFactory's page, so 3Devil never sees your password. That page has no Google option: if you
          use Google there, set a password on your MyMiniFactory account first.
        </p>
        <button className="link" onClick={onImportZip}>Or import a ZIP you've downloaded</button>
      </div>
    );
  }

  const addLink = async () => {
    if (link.trim() && (await mmf.addLink(link))) setLink("");
  };

  return (
    <div className="drivethru">
      <header className="drivethru-head">
        <div className="filters" role="radiogroup" aria-label="MyMiniFactory list">
          {[LIKES, ...(library?.collections.map((c) => c.name) ?? [])].map((name) => (
            <button key={name} role="radio" aria-checked={list === name} className={`chip${list === name ? " active" : ""}`} onClick={() => setList(name)}>
              {name === LIKES ? "Likes" : name}
            </button>
          ))}
        </div>
        <div className="spacer" />
        <input className="search" placeholder="Search this list…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <button onClick={refresh} disabled={loading} title="Reload your likes and collections">{loading ? "Loading…" : "Refresh"}</button>
        <button className={connecting ? "active" : ""} onClick={() => setConnecting((v) => !v)} title="Your MyMiniFactory account and download folder">Connection</button>
      </header>
      {connecting && (
        <div className="settings library-settings">
          <section>
            <h3>MyMiniFactory</h3>
            <div className="btn-row">
              <span>Signed in as <strong>{account.username}</strong> until {new Date(account.expiresAt * 1000).toLocaleDateString()}</span>
              <button onClick={mmf.signOut}>Sign out</button>
            </div>
            <label className="block">
              Download folder
              <div className="btn-row">
                <input className="grow mono" readOnly value={folder} placeholder="Documents/MyMiniFactory" />
                <button
                  onClick={async () => {
                    const dir = await open({ directory: true, title: "Folder for MyMiniFactory downloads" });
                    if (typeof dir === "string") store.actions.setMyMiniFactory({ libraryPath: dir });
                  }}
                >
                  Browse
                </button>
              </div>
            </label>
          </section>
        </div>
      )}
      <div className="drivethru-list">
        <div className="btn-row">
          <input
            className="grow"
            placeholder="Paste a MyMiniFactory model link"
            value={link}
            onChange={(e) => setLink(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addLink()}
          />
          <button onClick={addLink} disabled={!link.trim()} title="Look up this model, including ones you haven't liked">Add</button>
        </div>
        {mmf.pasted.map((m) => <ModelRow key={`link-${m.id}`} model={m} mmf={mmf} onOpenProject={onOpenProject} />)}
        {mmf.error && <p className="error-text small">{mmf.error}</p>}
        {loading && !library && <p className="muted">Loading your models…</p>}
        {visible.map((m) => <ModelRow key={m.id} model={m} mmf={mmf} onOpenProject={onOpenProject} />)}
        {library && !visible.length && <p className="muted small">{query ? "Nothing matches." : "Nothing here yet."}</p>}
        <p className="muted small">
          MyMiniFactory doesn't offer a list of your purchases, so only models you've liked or collected appear here. Paste a
          link to add any other model you own.
        </p>
      </div>
    </div>
  );
}
