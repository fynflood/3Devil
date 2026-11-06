import { useCallback, useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { documentDir, join } from "@tauri-apps/api/path";
import { api } from "./api";
import type { DownloadProgress } from "./driveThru";
import { describeScan, type Store } from "./store";
import type { MmfAccount, MmfLibrary, MmfModel, Project } from "./types";

export type MyMiniFactory = ReturnType<typeof useMyMiniFactory>;

/** Signing in to MyMiniFactory, the models it can list, and turning them into projects. */
export function useMyMiniFactory(store: Store, notify: (msg: string, kind?: "info" | "error") => void) {
  const [account, setAccount] = useState<MmfAccount | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [library, setLibrary] = useState<MmfLibrary | null>(null);
  const [pasted, setPasted] = useState<MmfModel[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);

  useEffect(() => {
    api.mmfSession().then(setAccount).catch(() => undefined);
    const stop = listen<DownloadProgress>("mmf-progress", (e) => setProgress(e.payload));
    return () => {
      stop.then((off) => off());
    };
  }, []);

  /** Reports a failure, dropping the account if that's what it was. */
  const failed = useCallback((e: unknown) => {
    const message = String(e);
    if (message.includes("sign-in has expired")) {
      setAccount(null);
      setLibrary(null);
    }
    return message;
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setLibrary(await api.mmfLibrary());
    } catch (e) {
      setError(failed(e));
    } finally {
      setLoading(false);
    }
  }, [failed]);

  const signIn = async () => {
    setSigningIn(true);
    try {
      setAccount(await api.mmfSignIn());
    } catch (e) {
      if (!String(e).includes("cancelled")) notify(String(e), "error");
    } finally {
      setSigningIn(false);
    }
  };

  const signOut = async () => {
    try {
      await api.mmfSignOut();
      setAccount(null);
      setLibrary(null);
      setPasted([]);
    } catch (e) {
      notify(String(e), "error");
    }
  };

  /** Looks up a model from its store link and puts it at the top of the list. */
  const addLink = async (link: string) => {
    try {
      const model = await api.mmfLookup(link);
      setPasted((list) => [model, ...list.filter((m) => m.id !== model.id)]);
      return true;
    } catch (e) {
      notify(failed(e), "error");
      return false;
    }
  };

  const linked = useMemo(() => {
    const m = new Map<number, Project>();
    for (const p of store.state?.projects ?? []) if (p.myMiniFactory) m.set(p.myMiniFactory.objectId, p);
    return m;
  }, [store.state?.projects]);

  /** Downloads a model into a new project, and returns the project's id. */
  const create = async (model: MmfModel) => {
    setBusy(model.id);
    setProgress(null);
    try {
      const folder = store.state?.settings.myMiniFactory?.libraryPath || (await join(await documentDir(), "MyMiniFactory"));
      const dir = await api.drivethruProductDir(folder, model.designer ?? "", model.name);
      const { downloaded, skipped } = await api.mmfDownload(model.id, dir);
      const id = store.actions.createProject({
        name: model.name,
        description: model.designer ?? "",
        sourceUrl: model.url,
        myMiniFactory: { objectId: model.id },
      });
      const scan = await store.actions.addFolder(id, dir);
      notify(`Downloaded ${downloaded.length} file(s)${skipped.length ? `, ${skipped.length} already here` : ""} · ${describeScan(scan)}`);
      return id;
    } catch (e) {
      notify(failed(e), "error");
    } finally {
      setBusy(null);
      setProgress(null);
    }
  };

  return { account, signingIn, library, pasted, loading, error, busy, progress, linked, signIn, signOut, refresh, addLink, create };
}
