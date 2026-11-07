import { useState } from "react";
import { api, type FoundPrinter } from "../api";
import { uid, type Store } from "../store";
import { PrinterPanel } from "./PrinterPanel";
import { PRINTER_KIND_NAMES, type PrinterConfig, type PrinterKind, type PrinterStatus } from "../types";

interface Props {
  store: Store;
  statuses: Record<string, PrinterStatus>;
  onOpenPart: (projectId: string, partId: string) => void;
  notify: (msg: string, kind?: "info" | "error") => void;
}

type Found = FoundPrinter & { kind: PrinterKind };

const KINDS = Object.keys(PRINTER_KIND_NAMES) as PrinterKind[];

const newPrinter = (kind: PrinterKind, p?: FoundPrinter): PrinterConfig => ({
  id: uid(),
  kind,
  name: p?.model ?? "",
  ip: p?.ip ?? "",
  serial: p?.serial ?? "",
  model: p?.model ?? "",
  accessCode: "",
});

/** Live status and camera for each printer, and adding, editing and removing them. */
export function PrintersView({ store, statuses, onOpenPart, notify }: Props) {
  const printers = store.state!.settings.printers ?? [];
  const [draft, setDraft] = useState<PrinterConfig | null>(null);
  const [found, setFound] = useState<Found[] | null>(null);
  const [busy, setBusy] = useState(false);

  const scan = async () => {
    setBusy(true);
    try {
      const [bambu, klipper, elegoo] = await Promise.all([api.printerScan(), api.klipperScan(), api.elegooScan()]);
      const list: Found[] = [
        ...bambu.map((p) => ({ ...p, kind: "bambu" as const })),
        ...klipper.map((p) => ({ ...p, kind: "klipper" as const })),
        ...elegoo.map((p) => ({ ...p, kind: "elegoo" as const })),
      ];
      setFound(list);
      if (!list.length) notify("No Bambu Lab, Klipper or Elegoo printers found on your local networks. Add one by its address instead.", "error");
    } finally {
      setBusy(false);
    }
  };

  const lookUp = async (d: PrinterConfig) => {
    setBusy(true);
    try {
      const p =
        d.kind === "prusa" ? await api.prusaProbe(d.ip, d.username ?? "", d.accessCode)
        : d.kind === "klipper" ? await api.klipperProbe(d.ip, d.accessCode)
        : d.kind === "elegoo" ? await api.elegooProbe(d.ip)
        : await api.printerProbe(d.ip);
      setDraft((cur) => cur && { ...cur, ip: p.ip, serial: p.serial, model: p.model, name: cur.name || p.model });
      if (d.kind === "prusa" || d.kind === "klipper") notify(`Connected to ${p.model}.`);
    } catch (e) {
      notify(String(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const kind = draft?.kind ?? "bambu";
  const needsTest = kind === "prusa" || kind === "klipper";
  /** These logins are checked before saving; changing them means checking again. */
  const editLogin = (patch: Partial<PrinterConfig>) => setDraft((d) => d && { ...d, ...patch, ...(needsTest ? { model: "" } : {}) });
  const canSave =
    !!draft &&
    (kind === "klipper" ? !!draft.model : kind === "elegoo" ? !!draft.serial : !!draft.accessCode && !!(kind === "prusa" ? draft.model : draft.serial));

  return (
    <div className="settings printers-view">
      <h2>Printers</h2>
      <p className="muted small">
        Printers on your network report live progress in the sidebar, and prints of parts in your projects are recorded
        automatically.
      </p>

      <div>
        {printers.map((p) => (
          <PrinterPanel
            key={p.id}
            printer={p}
            status={statuses[p.id]}
            projects={store.state!.projects}
            onOpenPart={onOpenPart}
            actions={
              <>
                <label className="inline small" title="A printer that's off isn't connected to or shown in the sidebar">
                  <input
                    type="checkbox"
                    checked={!p.disabled}
                    aria-label={`Connect to ${p.name}`}
                    onChange={(e) => store.actions.savePrinter({ ...p, disabled: !e.target.checked || undefined })}
                  />
                  Enabled
                </label>
                <button onClick={() => setDraft({ ...p })}>Edit</button>
                <button className="danger" title="Remove this printer from 3Devil" onClick={() => store.actions.removePrinter(p.id)}>Remove</button>
              </>
            }
          />
        ))}
        {!printers.length && !draft && <p>No printers yet.</p>}

        {!draft && (
          <div className="btn-row">
            <button className="primary" onClick={() => setDraft(newPrinter("bambu"))}>Add printer</button>
            <button onClick={scan} disabled={busy} title="Scan your local networks for Bambu Lab, Klipper and Elegoo printers">{busy ? "Scanning…" : "Find printers on my network"}</button>
          </div>
        )}
        {!draft && found && found.length > 0 && (
          <div className="found-list">
            {found.map((f) => {
              const added = printers.some((p) => (f.serial ? p.serial === f.serial : p.ip === f.ip));
              return (
                <div key={f.serial || f.ip} className="setting printer-row">
                  <div>
                    <strong>{f.model}</strong>
                    <div className="muted small">{[PRINTER_KIND_NAMES[f.kind], f.ip, f.serial].filter(Boolean).join(" · ")}</div>
                  </div>
                  <div className="spacer" />
                  <button disabled={added} onClick={() => setDraft(newPrinter(f.kind, f))}>{added ? "Added" : "Add"}</button>
                </div>
              );
            })}
          </div>
        )}

        {draft && (
          <div className="printer-form">
            {printers.some((p) => p.id === draft.id) ? (
              <div className="muted small">{PRINTER_KIND_NAMES[kind]} printer</div>
            ) : (
              <div className="filters" role="radiogroup" aria-label="Printer type">
                {KINDS.map((k) => (
                  <button
                    key={k}
                    role="radio"
                    aria-checked={kind === k}
                    className={`chip${kind === k ? " active" : ""}`}
                    onClick={() => setDraft({ ...newPrinter(k), id: draft.id, name: draft.name, ip: draft.ip })}
                  >
                    {PRINTER_KIND_NAMES[k]}
                  </button>
                ))}
              </div>
            )}
            {kind === "prusa" && (
              <p className="muted small">
                Turn on PrusaLink on the printer under <em>Settings → Network → PrusaLink</em>; the same screen shows the
                password. On an MK3S with Prusa Link on a Raspberry Pi, use the login you made when setting it up.
              </p>
            )}
            {kind === "klipper" && (
              <p className="muted small">
                Works with any printer running Moonraker, the service behind Fluidd and Mainsail. Use the address you open
                those at. Moonraker's port 7125 is assumed unless you add another, as in <code>192.168.1.70:7130</code>.
              </p>
            )}
            {kind === "elegoo" && (
              <p className="muted small">
                Works with Elegoo printers on your network, such as the Saturn 4, Mars 5 and Centauri Carbon. Some older
                models use an earlier version of Elegoo's protocol that 3Devil doesn't support yet; Look up says so.
              </p>
            )}
            {kind === "bambu" && (
              <p className="muted small">
                The access code is shown on the printer: <em>Settings → Network</em> (X1/P1) or <em>Settings → LAN</em> (A1).
              </p>
            )}
            <label className="block">
              Name
              <input
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder={{ bambu: "X1 Carbon", prusa: "MK4", klipper: "Voron", elegoo: "Saturn 4 Ultra" }[kind]}
              />
            </label>
            {needsTest ? (
              <>
                <label className="block">
                  IP address or host name
                  <input className="mono" value={draft.ip} onChange={(e) => editLogin({ ip: e.target.value })} placeholder={kind === "klipper" ? "192.168.1.70" : "192.168.1.60"} />
                </label>
                {kind === "prusa" && (
                  <label className="block">
                    User name (optional)
                    <input className="mono" autoComplete="off" value={draft.username ?? ""} onChange={(e) => editLogin({ username: e.target.value.trim() })} placeholder="maker" />
                    <div className="muted small">Only needed if you chose your own login on a Raspberry Pi.</div>
                  </label>
                )}
                <label className="block">
                  {kind === "klipper" ? "API key (optional)" : "Password or API key"}
                  <div className="btn-row">
                    <input
                      className="grow mono"
                      type="password"
                      autoComplete="off"
                      value={draft.accessCode}
                      onChange={(e) => editLogin({ accessCode: e.target.value.trim() })}
                    />
                    <button onClick={() => lookUp(draft)} disabled={busy || !draft.ip || (kind === "prusa" && !draft.accessCode)} title="Connect to the printer to check these details">
                      {busy ? "Testing…" : "Test connection"}
                    </button>
                  </div>
                  {kind === "klipper" && <div className="muted small">Only needed if Moonraker doesn't already trust this computer.</div>}
                </label>
                <div className="muted small">
                  {draft.model ? `${draft.model}${draft.serial ? ` · serial ${draft.serial}` : ""}` : "Click Test connection to check the printer."}
                </div>
              </>
            ) : (
              <>
                <label className="block">
                  {kind === "elegoo" ? "IP address or host name" : "IP address"}
                  <div className="btn-row">
                    <input className="grow mono" value={draft.ip} onChange={(e) => setDraft({ ...draft, ip: e.target.value, serial: "" })} placeholder="192.168.1.50" />
                    <button onClick={() => lookUp(draft)} disabled={busy || !draft.ip} title={`Ask the printer at this address for its ${kind === "elegoo" ? "model" : "serial number"}`}>
                      {busy ? "Looking up…" : "Look up"}
                    </button>
                  </div>
                </label>
                <div className="muted small">
                  {draft.serial
                    ? `${draft.model} · ${kind === "elegoo" ? "mainboard" : "serial"} ${draft.serial}`
                    : `Click Look up to ${kind === "elegoo" ? "find the printer" : "read the printer's serial number"}.`}
                </div>
                {kind === "bambu" && (
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
                )}
              </>
            )}
            <div className="btn-row end">
              <button onClick={() => setDraft(null)}>Cancel</button>
              <button
                className="primary"
                disabled={!canSave}
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
        <p className="muted small">Access codes, passwords and API keys are stored in 3Devil's local data file on this computer.</p>
      </div>
    </div>
  );
}
