import { useState } from "react";
import { api, type FoundPrinter } from "../api";
import { uid, type Store } from "../store";
import type { PrinterConfig } from "../types";

interface Props {
  store: Store;
  notify: (msg: string, kind?: "info" | "error") => void;
}

/** Add, edit and remove Bambu Lab printers for live status. */
export function PrinterSettings({ store, notify }: Props) {
  const printers = store.state!.settings.printers ?? [];
  const [draft, setDraft] = useState<PrinterConfig | null>(null);
  const [found, setFound] = useState<FoundPrinter[] | null>(null);
  const [busy, setBusy] = useState(false);

  const scan = async () => {
    setBusy(true);
    try {
      const list = await api.printerScan();
      setFound(list);
      if (!list.length) notify("No Bambu Lab printers found on your local networks. Enter the IP address instead.", "error");
    } finally {
      setBusy(false);
    }
  };

  const lookUp = async (ip: string) => {
    setBusy(true);
    try {
      const p = await api.printerProbe(ip);
      setDraft((d) => d && { ...d, ip: p.ip, serial: p.serial, model: p.model, name: d.name || p.model });
    } catch (e) {
      notify(String(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const startNew = (p?: FoundPrinter) =>
    setDraft({ id: uid(), name: p?.model ?? "", ip: p?.ip ?? "", serial: p?.serial ?? "", model: p?.model ?? "", accessCode: "" });

  return (
    <section>
      <h3>Printers</h3>
      <p className="muted small">
        Bambu Lab printers on your network report live progress here, and prints of parts in your projects are recorded
        automatically. The access code is shown on the printer: <em>Settings → Network</em> (X1/P1) or <em>Settings → LAN</em> (A1).
      </p>

      {printers.map((p) => (
        <div key={p.id} className="setting printer-row">
          <div>
            <strong>{p.name}</strong>
            <div className="muted small">{p.model} · {p.ip} · {p.serial}</div>
          </div>
          <div className="spacer" />
          <button onClick={() => setDraft({ ...p })}>Edit</button>
          <button className="danger" onClick={() => store.actions.removePrinter(p.id)}>Remove</button>
        </div>
      ))}

      {!draft && (
        <div className="btn-row">
          <button className="primary" onClick={scan} disabled={busy}>{busy ? "Scanning…" : "Find printers"}</button>
          <button onClick={() => startNew()}>Add by IP address</button>
        </div>
      )}
      {!draft && found && found.length > 0 && (
        <div className="found-list">
          {found.map((f) => {
            const added = printers.some((p) => p.serial === f.serial);
            return (
              <div key={f.serial} className="setting printer-row">
                <div>
                  <strong>{f.model}</strong>
                  <div className="muted small">{f.ip} · {f.serial}</div>
                </div>
                <div className="spacer" />
                <button disabled={added} onClick={() => startNew(f)}>{added ? "Added" : "Add"}</button>
              </div>
            );
          })}
        </div>
      )}

      {draft && (
        <div className="printer-form">
          <label className="block">Name<input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="X1 Carbon" /></label>
          <label className="block">
            IP address
            <div className="btn-row">
              <input className="grow mono" value={draft.ip} onChange={(e) => setDraft({ ...draft, ip: e.target.value, serial: "" })} placeholder="192.168.1.50" />
              <button onClick={() => lookUp(draft.ip)} disabled={busy || !draft.ip}>Look up</button>
            </div>
          </label>
          <div className="muted small">{draft.serial ? `${draft.model} · serial ${draft.serial}` : "Click Look up to read the printer's serial number."}</div>
          <label className="block">
            Access code
            <input
              className="mono"
              type="password"
              autoComplete="off"
              value={draft.accessCode}
              onChange={(e) => setDraft({ ...draft, accessCode: e.target.value.trim() })}
              placeholder="8 characters from the printer's screen"
            />
          </label>
          <div className="btn-row end">
            <button onClick={() => setDraft(null)}>Cancel</button>
            <button
              className="primary"
              disabled={!draft.serial || !draft.accessCode}
              onClick={() => {
                store.actions.savePrinter({ ...draft, name: draft.name.trim() || draft.model });
                setDraft(null);
                setFound(null);
              }}
            >
              Save &amp; connect
            </button>
          </div>
        </div>
      )}
      <p className="muted small">The access code is stored in 3Devil's local data file on this computer.</p>
    </section>
  );
}
