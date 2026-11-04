import { useState } from "react";
import { api, type FoundPrinter } from "../api";
import { uid, type Store } from "../store";
import type { PrinterConfig, PrinterKind } from "../types";

interface Props {
  store: Store;
  notify: (msg: string, kind?: "info" | "error") => void;
}

const KIND_NAMES: Record<PrinterKind, string> = { bambu: "Bambu Lab", prusa: "Prusa" };

/** Add, edit and remove Bambu Lab and Prusa printers for live status. */
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

  const lookUp = async (d: PrinterConfig) => {
    setBusy(true);
    try {
      const p = d.kind === "prusa" ? await api.prusaProbe(d.ip, d.username ?? "", d.accessCode) : await api.printerProbe(d.ip);
      setDraft((cur) => cur && { ...cur, ip: p.ip, serial: p.serial, model: p.model, name: cur.name || p.model });
      if (d.kind === "prusa") notify(`Connected to ${p.model}.`);
    } catch (e) {
      notify(String(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const startNew = (kind: PrinterKind, p?: FoundPrinter) =>
    setDraft({
      id: uid(),
      kind,
      name: p?.model ?? "",
      ip: p?.ip ?? "",
      serial: p?.serial ?? "",
      model: p?.model ?? "",
      accessCode: "",
    });

  const prusa = draft?.kind === "prusa";
  /** Prusa logins are checked before saving; changing them means checking again. */
  const editLogin = (patch: Partial<PrinterConfig>) => setDraft((d) => d && { ...d, ...patch, ...(prusa ? { model: "" } : {}) });

  return (
    <section>
      <h3>Printers</h3>
      <p className="muted small">
        Bambu Lab and Prusa printers on your network report live progress here, and prints of parts in your projects are
        recorded automatically.
      </p>

      {printers.map((p) => (
        <div key={p.id} className="setting printer-row">
          <div>
            <strong>{p.name}</strong>
            <div className="muted small">{[p.model, p.ip, p.serial].filter(Boolean).join(" · ")}</div>
          </div>
          <div className="spacer" />
          <button onClick={() => setDraft({ ...p })}>Edit</button>
          <button className="danger" onClick={() => store.actions.removePrinter(p.id)}>Remove</button>
        </div>
      ))}

      {!draft && (
        <div className="btn-row">
          <button className="primary" onClick={scan} disabled={busy}>{busy ? "Scanning…" : "Find Bambu printers"}</button>
          <button onClick={() => startNew("bambu")}>Add Bambu by IP address</button>
          <button onClick={() => startNew("prusa")}>Add Prusa printer</button>
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
                <button disabled={added} onClick={() => startNew("bambu", f)}>{added ? "Added" : "Add"}</button>
              </div>
            );
          })}
        </div>
      )}

      {draft && (
        <div className="printer-form">
          <div className="muted small">{KIND_NAMES[draft.kind ?? "bambu"]} printer</div>
          {prusa ? (
            <p className="muted small">
              Turn on PrusaLink on the printer under <em>Settings → Network → PrusaLink</em>; the same screen shows the
              password. On an MK3S with Prusa Link on a Raspberry Pi, use the login you made when setting it up.
            </p>
          ) : (
            <p className="muted small">
              The access code is shown on the printer: <em>Settings → Network</em> (X1/P1) or <em>Settings → LAN</em> (A1).
            </p>
          )}
          <label className="block">
            Name
            <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder={prusa ? "MK4" : "X1 Carbon"} />
          </label>
          {prusa ? (
            <>
              <label className="block">
                IP address or host name
                <input className="mono" value={draft.ip} onChange={(e) => editLogin({ ip: e.target.value })} placeholder="192.168.1.60" />
              </label>
              <label className="block">
                User name (optional)
                <input className="mono" autoComplete="off" value={draft.username ?? ""} onChange={(e) => editLogin({ username: e.target.value.trim() })} placeholder="maker" />
                <div className="muted small">Only needed if you chose your own login on a Raspberry Pi.</div>
              </label>
              <label className="block">
                Password or API key
                <div className="btn-row">
                  <input
                    className="grow mono"
                    type="password"
                    autoComplete="off"
                    value={draft.accessCode}
                    onChange={(e) => editLogin({ accessCode: e.target.value.trim() })}
                  />
                  <button onClick={() => lookUp(draft)} disabled={busy || !draft.ip || !draft.accessCode}>
                    {busy ? "Testing…" : "Test connection"}
                  </button>
                </div>
              </label>
              <div className="muted small">
                {draft.model ? `${draft.model}${draft.serial ? ` · serial ${draft.serial}` : ""}` : "Click Test connection to check the login."}
              </div>
            </>
          ) : (
            <>
              <label className="block">
                IP address
                <div className="btn-row">
                  <input className="grow mono" value={draft.ip} onChange={(e) => setDraft({ ...draft, ip: e.target.value, serial: "" })} placeholder="192.168.1.50" />
                  <button onClick={() => lookUp(draft)} disabled={busy || !draft.ip}>Look up</button>
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
            </>
          )}
          <div className="btn-row end">
            <button onClick={() => setDraft(null)}>Cancel</button>
            <button
              className="primary"
              disabled={!draft.accessCode || !(prusa ? draft.model : draft.serial)}
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
      <p className="muted small">Access codes and passwords are stored in 3Devil's local data file on this computer.</p>
    </section>
  );
}
