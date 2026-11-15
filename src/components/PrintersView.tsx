import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { api, type FoundPrinter } from "../api";
import { inSlicer, nextPrinter, upNext } from "../printers";
import { uid, type Store } from "../store";
import { NextOn } from "./NextOn";
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
  const { projects } = store.state!;
  const printers = store.state!.settings.printers ?? [];
  // Tiles show the printers that are on; the ones that are off sit in a list under them.
  const on = printers.filter((p) => !p.disabled);
  const off = printers.filter((p) => p.disabled);
  const [draft, setDraft] = useState<PrinterConfig | null>(null);
  const [found, setFound] = useState<Found[] | null>(null);
  const [busy, setBusy] = useState(false);
  // Moving a printer by its grip: which one, and where it would land.
  const [moving, setMoving] = useState<{ id: string; to: number } | null>(null);
  const slots = useRef(new Map<string, HTMLElement>());
  const form = useRef<HTMLDivElement>(null);

  const next = useMemo(() => upNext(projects, printers), [projects, printers]);
  // Sliced jobs that could be for more than one printer, until one is picked.
  const waiting = on.length
    ? projects.flatMap((project) => project.jobs.filter((j) => inSlicer(j) && !nextPrinter(j, printers)).map((job) => ({ project, job })))
    : [];

  const editing = printers.find((p) => p.id === draft?.id);
  useEffect(() => {
    if (draft?.id) form.current?.scrollIntoView({ block: "nearest" });
  }, [draft?.id]);

  // Dropping a printer next to where it is wouldn't move it, so no line shows.
  const from = moving ? on.findIndex((p) => p.id === moving.id) : -1;
  const shift = !!moving && moving.to !== from && moving.to !== from + 1;

  /** Where a printer dropped here would go: before the first tile on a later row, or whose middle is to the right. */
  const landing = (x: number, y: number) => {
    const i = on.findIndex((p) => {
      const box = slots.current.get(p.id)?.getBoundingClientRect();
      return box && (y < box.top || (y < box.bottom && x < box.left + box.width / 2));
    });
    return i < 0 ? on.length : i;
  };
  /** Moves a tile to sit before the one now at `to`; the saved order also holds the printers that are off. */
  const move = (id: string, to: number) =>
    store.actions.movePrinter(id, to < on.length ? printers.indexOf(on[to]) : printers.indexOf(on[on.length - 1]) + 1);
  const grip = (p: PrinterConfig, i: number) => (
    <button
      className="icon-btn grip"
      aria-label={`Move ${p.name}`}
      title="Drag to move, or use the arrow keys"
      onPointerDown={(e: PointerEvent) => {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        setMoving({ id: p.id, to: i });
      }}
      onPointerMove={(e: PointerEvent) => moving?.id === p.id && setMoving({ id: p.id, to: landing(e.clientX, e.clientY) })}
      onPointerUp={() => {
        if (moving?.id === p.id) move(p.id, moving.to);
        setMoving(null);
      }}
      onPointerCancel={() => setMoving(null)}
      onKeyDown={(e: KeyboardEvent) => {
        if (e.key === "Escape") setMoving(null);
        const step = e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : e.key === "ArrowDown" || e.key === "ArrowRight" ? 2 : 0;
        if (!step || moving) return;
        e.preventDefault();
        move(p.id, Math.min(on.length, Math.max(0, i + step)));
      }}
    >
      ⠿
    </button>
  );

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
      <div className="printers-head">
        <h2>Printers</h2>
        <div className="spacer" />
        <button onClick={scan} disabled={busy || !!draft} title="Scan your local networks for Bambu Lab, Klipper and Elegoo printers">{busy ? "Scanning…" : "Find on network"}</button>
        <button className="primary" disabled={!!draft} onClick={() => setDraft(newPrinter("bambu"))}>Add printer</button>
      </div>

      {!draft && found && found.length > 0 && (
        <div className="found-list">
          {found.map((f) => {
            const added = printers.some((p) => (f.serial ? p.serial === f.serial : p.ip === f.ip));
            return (
              <div key={f.serial || f.ip} className="printer-off">
                <strong>{f.model}</strong>
                <span className="muted small">{[PRINTER_KIND_NAMES[f.kind], f.ip, f.serial].filter(Boolean).join(" · ")}</span>
                <div className="spacer" />
                <button disabled={added} onClick={() => setDraft(newPrinter(f.kind, f))}>{added ? "Added" : "Add"}</button>
              </div>
            );
          })}
        </div>
      )}

      {draft && (
        <div className="printer-form" ref={form}>
          <strong>{editing ? `Edit ${editing.name}` : "Add a printer"}</strong>
          {editing ? (
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
              {kind === "prusa" && (
                <label className="block">
                  Camera (optional)
                  <input
                    className="mono"
                    value={draft.camera ?? ""}
                    onChange={(e) => setDraft({ ...draft, camera: e.target.value.trim() || undefined })}
                    placeholder="192.168.1.61"
                  />
                  <div className="muted small">
                    The Buddy3D camera's own IP address, shown in the Prusa app under the camera's details. Set its{" "}
                    <em>Local Stream Mode</em> to RTSP there. Another camera's full <code>rtsp://</code> address works too.
                  </div>
                </label>
              )}
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
          <div className="btn-row">
            {editing && (
              <>
                <button
                  title={editing.disabled ? "Connect to this printer and show it in the sidebar" : "Stop connecting to this printer and take it out of the sidebar"}
                  onClick={() => {
                    store.actions.savePrinter({ ...editing, disabled: editing.disabled ? undefined : true });
                    setDraft(null);
                  }}
                >
                  {editing.disabled ? "Turn on" : "Turn off"}
                </button>
                <button
                  className="danger"
                  title="Remove this printer from 3Devil"
                  onClick={() => {
                    store.actions.removePrinter(editing.id);
                    setDraft(null);
                  }}
                >
                  Remove
                </button>
              </>
            )}
            <div className="spacer" />
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
              {draft.disabled ? "Save" : <>Save &amp; connect</>}
            </button>
          </div>
          <p className="muted small">Access codes, passwords and API keys are stored in 3Devil's local data file on this computer.</p>
        </div>
      )}

      {!printers.length && !draft && <p className="muted">No printers yet. Add one, or look for them on your network.</p>}

      <div className="printer-grid">
        {on.map((p, i) => (
          <div
            key={p.id}
            ref={(el) => void (el ? slots.current.set(p.id, el) : slots.current.delete(p.id))}
            className={[
              "printer-slot",
              moving?.id === p.id && "moving",
              shift && moving!.to === i && "drop-before",
              shift && i === on.length - 1 && moving!.to === on.length && "drop-after",
            ].filter(Boolean).join(" ")}
          >
            <PrinterPanel
              printer={p}
              grip={on.length > 1 && grip(p, i)}
              status={statuses[p.id]}
              projects={projects}
              next={next.get(p.id) ?? []}
              onOpenPart={onOpenPart}
              onEdit={() => setDraft({ ...p })}
            />
          </div>
        ))}
      </div>

      {waiting.length > 0 && (
        <>
          <h3>Sliced and waiting</h3>
          {waiting.map(({ project, job }) => {
            const parts = job.items.flatMap((it) => project.parts.find((p) => p.id === it.partId) ?? []);
            return (
              <div key={job.id} className="printer-off">
                {parts.length ? (
                  <button className="link" onClick={() => onOpenPart(project.id, parts[0].id)}>{job.name}</button>
                ) : (
                  <strong>{job.name}</strong>
                )}
                <span className="muted small next-parts">
                  {parts.slice(0, 3).map((p) => p.name).join(", ")}{parts.length > 3 ? ` + ${parts.length - 3} more` : ""} · {project.name}
                </span>
                <div className="spacer" />
                <NextOn store={store} project={project} job={job} />
              </div>
            );
          })}
        </>
      )}

      {off.length > 0 && <h3>Switched off</h3>}
      {off.map((p) => (
        <div key={p.id} className="printer-off">
          <strong>{p.name}</strong>
          <span className="muted small">{[PRINTER_KIND_NAMES[p.kind ?? "bambu"], p.model].filter(Boolean).join(" · ")}</span>
          <div className="spacer" />
          <span className="pill">Off</span>
          <button title="Connect to this printer and show it in the sidebar" onClick={() => store.actions.savePrinter({ ...p, disabled: undefined })}>Turn on</button>
          <button onClick={() => setDraft({ ...p })}>Edit</button>
        </div>
      ))}
    </div>
  );
}
