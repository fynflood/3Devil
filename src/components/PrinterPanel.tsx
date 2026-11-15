import { useEffect, useState, type ReactNode } from "react";
import { api, formatDuration, type CameraView } from "../api";
import { ACTIVE_STATES, chamberTemp, currentPart, statusPill, type UpNext } from "../printers";
import { PRINTER_KIND_NAMES, type AmsTray, type PrinterConfig, type PrinterReport, type PrinterStatus, type Project } from "../types";

interface Props {
  printer: PrinterConfig;
  status?: PrinterStatus;
  projects: Project[];
  /** Jobs in a slicer waiting for this printer, the first one first. */
  next: UpNext[];
  onOpenPart: (projectId: string, partId: string) => void;
  onEdit: () => void;
  /** A handle for moving the printer, before its name. */
  grip?: ReactNode;
}

/** How often the page asks for a new camera picture. */
const FRAME_MS = 200;
const SPEEDS: Record<number, string> = { 1: "Silent", 2: "Standard", 3: "Sport", 4: "Ludicrous" };

const temp = (cur?: number | null, target?: number) =>
  cur === undefined || cur === null ? null : `${Math.round(cur)}°${target ? ` / ${Math.round(target)}°` : ""}`;

/** Bambu fan speeds run from 0 to 15. */
function fan(speed?: string) {
  const n = parseInt(speed ?? "", 10);
  return Number.isNaN(n) ? null : `${Math.round((n / 15) * 100)}%`;
}

function finishTime(minutes: number) {
  const at = new Date(Date.now() + minutes * 60000);
  const time = at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return at.toDateString() === new Date().toDateString() ? time : `${at.toLocaleDateString([], { weekday: "short" })} ${time}`;
}

function speed(r: PrinterReport) {
  const name = r.spd_lvl ? SPEEDS[r.spd_lvl] : undefined;
  const percent = r.spd_mag ? `${r.spd_mag}%` : undefined;
  return [name, percent].filter(Boolean).join(" · ") || null;
}

/** Spools the printer knows about; the one in use comes first. */
function spools(r: PrinterReport) {
  const trays: { tray: AmsTray; label: string; active: boolean }[] = [];
  const now = parseInt(r.ams?.tray_now ?? "", 10);
  for (const unit of r.ams?.ams ?? []) {
    for (const tray of unit.tray ?? []) {
      if (!tray.tray_type) continue;
      const index = parseInt(unit.id, 10) * 4 + parseInt(tray.id, 10);
      trays.push({ tray, label: `AMS ${parseInt(unit.id, 10) + 1}, slot ${parseInt(tray.id, 10) + 1}`, active: index === now });
    }
  }
  // Printers can't weigh an external spool, so its "remain" means nothing.
  if (r.vt_tray?.tray_type) trays.push({ tray: { ...r.vt_tray, remain: undefined }, label: "External spool", active: now === 254 });
  return trays.sort((a, b) => Number(b.active) - Number(a.active));
}

function Spool({ tray, label, active }: { tray: AmsTray; label: string; active: boolean }) {
  const remain = tray.remain !== undefined && tray.remain >= 0 ? ` · ${tray.remain}%` : "";
  return (
    <span className={`spool${active ? " active" : ""}`} title={label}>
      <span className="spool-swatch" style={{ background: `#${(tray.tray_color ?? "888888").slice(0, 6)}` }} />
      {tray.tray_type}{remain}
    </span>
  );
}

/** False while the window is minimized or otherwise out of sight. */
function usePageVisible() {
  const [visible, setVisible] = useState(document.visibilityState === "visible");
  useEffect(() => {
    const update = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return visible;
}

/** The printer's live camera, while the panel is on screen and the window is in view. */
function Camera({ printer, status }: { printer: PrinterConfig; status?: PrinterStatus }) {
  const [shown, setShown] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<CameraView | null>(null);
  const kind = printer.kind ?? "bambu";
  // A Prusa camera is a device of its own, so it doesn't wait for the printer.
  const ready = kind === "prusa" ? !!printer.camera : !!status?.connected && !!status.print.gcode_state;
  const rtsp = /^rtsps?:/.test(status?.print.ipcam?.rtsp_url ?? "");
  const visible = usePageVisible();

  useEffect(() => {
    if (!shown || !ready || !visible) return;
    let live = true;
    let current = "";
    setError(null);
    (async () => {
      try {
        const host = kind === "prusa" ? printer.camera! : printer.ip;
        const opened = await api.cameraStart({ id: printer.id, kind, host, accessCode: printer.accessCode, serial: printer.serial, rtsp });
        if (!live) return;
        setView(opened);
        while (live) {
          const bytes = await api.cameraFrame(printer.id);
          if (live && bytes.byteLength) {
            const next = URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" }));
            setUrl(next);
            if (current) URL.revokeObjectURL(current);
            current = next;
          }
          await new Promise((done) => setTimeout(done, FRAME_MS));
        }
      } catch (e) {
        if (live) setError(String(e));
      }
    })();
    return () => {
      live = false;
      api.cameraStop(printer.id).catch(() => undefined);
      if (current) URL.revokeObjectURL(current);
      setUrl(null);
    };
  }, [printer.id, kind, printer.ip, printer.camera, printer.accessCode, printer.serial, rtsp, ready, shown, visible, attempt]);

  if (kind === "prusa" && !printer.camera) {
    return <div className="camera off"><p className="muted small">To see this printer's camera, add its address: Edit, then Camera.</p></div>;
  }
  if (!shown) return <div className="camera off"><button onClick={() => setShown(true)}>Show camera</button></div>;

  const turned = view && {
    transform: `rotate(${view.rotation}deg) scale(${view.flipHorizontal ? -1 : 1}, ${view.flipVertical ? -1 : 1})`,
  };
  return (
    <div className="camera">
      {error ? (
        <div className="camera-note small">
          <span className="error-text">{error}</span>
          <button onClick={() => setAttempt((n) => n + 1)}>Try again</button>
        </div>
      ) : url ? (
        <img src={url} alt={`Live view of ${printer.name}`} style={turned ?? undefined} />
      ) : (
        <div className="camera-note muted small">{ready ? "Opening camera…" : "Waiting for the printer…"}</div>
      )}
      <button className="camera-hide small" onClick={() => setShown(false)}>Hide</button>
    </div>
  );
}

/** The plate waiting in a slicer for this printer. */
function NextUp({ next, onOpenPart }: Pick<Props, "next" | "onOpenPart">) {
  const [{ project, job }] = next;
  const parts = job.items.flatMap((it) => project.parts.find((p) => p.id === it.partId) ?? []);
  if (!parts.length) return null;
  const names = parts.slice(0, 3).map((p) => p.name).join(", ");
  return (
    <div className="printer-next small" title="Sliced and waiting for this printer">
      <span className="next-label">Up next</span>
      <button className="link" onClick={() => onOpenPart(project.id, parts[0].id)}>{job.name}</button>
      <span className="muted next-parts">
        · {names}{parts.length > 3 ? ` + ${parts.length - 3} more` : ""} · {project.name}
      </span>
      {next.length > 1 && <span className="muted">+ {next.length - 1} more {next.length === 2 ? "job" : "jobs"}</span>}
    </div>
  );
}

/** One printer's camera, current print and readings. */
export function PrinterPanel({ printer, status, projects, next, onOpenPart, onEdit, grip }: Props) {
  const r = status?.print ?? {};
  const state = r.gcode_state ?? "";
  const active = ACTIVE_STATES.has(state);
  const pill = statusPill(status);
  const { linked, match } = status ? currentPart(projects, printer.id, r) : { linked: null, match: null };
  const others = linked ? linked.job.items.length - 1 : 0;
  const left = r.mc_remaining_time;
  const trays = spools(r);

  const has = (f: [string, string | null | undefined]): f is [string, string] => !!f[1];
  // The first four of these sit under the print; the rest fold away with the other readings.
  const main = ([
    ["Time left", active && left !== undefined ? formatDuration(left * 60) : null],
    ["Finishes about", active && left !== undefined ? finishTime(left) : null],
    ["Layer", active && r.total_layer_num ? `${r.layer_num ?? 0} / ${r.total_layer_num}` : null],
    ["Nozzle", temp(r.nozzle_temper, r.nozzle_target_temper)],
    ["Bed", temp(r.bed_temper, r.bed_target_temper)],
    ["Chamber", temp(chamberTemp(r))],
    ["Vat", temp(r.vat_temper, r.vat_target_temper)],
    ["UV light", temp(r.uv_led_temper)],
  ] as [string, string | null][]).filter(has);
  const more = [
    ...main.slice(4),
    ...([
      ["Speed", active ? speed(r) : null],
      ["Part fan", fan(r.cooling_fan_speed)],
      ["Aux fan", fan(r.big_fan1_speed)],
      ["Chamber fan", fan(r.big_fan2_speed)],
      ["Hotend fan", fan(r.heatbreak_fan_speed)],
      ["Nozzle size", r.nozzle_diameter ? `${r.nozzle_diameter} mm` : null],
      ["Wi-Fi", r.wifi_signal ?? null],
    ] as [string, string | null][]).filter(has),
  ];
  const facts = (list: [string, string][]) =>
    list.map(([label, value]) => (
      <div key={label}>
        <dt>{label}</dt>
        <dd>{value}</dd>
      </div>
    ));

  return (
    <section className="printer-panel">
      <div className="printer-row">
        {grip}
        <strong
          className="printer-name"
          title={[PRINTER_KIND_NAMES[printer.kind ?? "bambu"], printer.model, printer.ip, printer.serial].filter(Boolean).join(" · ")}
        >
          {printer.name}
        </strong>
        <span className={`pill ${pill.className}`}>{pill.label}</span>
        <button className="small" title="Change this printer's details, turn it off or remove it" onClick={onEdit}>Edit</button>
      </div>
      {status?.error && <div className="small error-text">{status.error}</div>}

      <Camera printer={printer} status={status} />
      <div className="printer-facts">
        {r.subtask_name && (active || state === "FINISH" || state === "FAILED") ? (
          <div className="printer-print">
            {match ? (
              <button className="link printer-job" onClick={() => onOpenPart(match.project.id, match.part.id)}>
                {match.part.name} <span className="muted">{others > 0 ? `+ ${others} more ` : ""}· {match.project.name}</span>
              </button>
            ) : (
              <div className="printer-job" title="No part in your projects has this name">{r.subtask_name}</div>
            )}
            {active && (
              <div className="printer-progress">
                <div className="progress"><div style={{ width: `${r.mc_percent ?? 0}%` }} /></div>
                <strong>{r.mc_percent ?? 0}%</strong>
              </div>
            )}
          </div>
        ) : (
          status?.connected && <p className="muted small">Nothing printing.</p>
        )}
        {main.length > 0 && <dl className="fact-grid key">{facts(main.slice(0, 4))}</dl>}
        {!!r.hms?.length && (
          <p className="small error-text">The printer is reporting {r.hms.length === 1 ? "a problem" : `${r.hms.length} problems`}. Check its screen.</p>
        )}
        {next.length > 0 && <NextUp next={next} onOpenPart={onOpenPart} />}
        {(more.length > 0 || trays.length > 0) && (
          <details className="printer-more">
            <summary className="muted small">{trays.length ? "More readings and filament" : "More readings"}</summary>
            {more.length > 0 && <dl className="fact-grid">{facts(more)}</dl>}
            {trays.length > 0 && (
              <div className="spools">
                {trays.map(({ tray, label, active: inUse }) => <Spool key={label} tray={tray} label={label} active={inUse} />)}
              </div>
            )}
          </details>
        )}
      </div>
    </section>
  );
}
