import { useEffect, useState, type ReactNode } from "react";
import { api, formatDuration, type CameraView } from "../api";
import { ACTIVE_STATES, chamberTemp, currentPart, statusPill } from "../printers";
import { PRINTER_KIND_NAMES, type AmsTray, type PrinterConfig, type PrinterReport, type PrinterStatus, type Project } from "../types";

interface Props {
  printer: PrinterConfig;
  status?: PrinterStatus;
  projects: Project[];
  onOpenPart: (projectId: string, partId: string) => void;
  /** Enable, edit and remove controls. */
  actions: ReactNode;
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
  const ready = !!status?.connected && !!status.print.gcode_state;
  const rtsp = /^rtsps?:/.test(status?.print.ipcam?.rtsp_url ?? "");
  const visible = usePageVisible();

  useEffect(() => {
    if (!shown || !ready || !visible || kind === "prusa") return;
    let live = true;
    let current = "";
    setError(null);
    (async () => {
      try {
        const opened = await api.cameraStart({ id: printer.id, kind, host: printer.ip, accessCode: printer.accessCode, serial: printer.serial, rtsp });
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
  }, [printer.id, kind, printer.ip, printer.accessCode, printer.serial, rtsp, ready, shown, visible, attempt]);

  if (kind === "prusa") return <div className="camera off"><p className="muted small">3Devil can't show a Prusa printer's camera.</p></div>;
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

/** One printer's camera, current print and readings. */
export function PrinterPanel({ printer, status, projects, onOpenPart, actions }: Props) {
  const r = status?.print ?? {};
  const state = r.gcode_state ?? "";
  const active = ACTIVE_STATES.has(state);
  const pill = statusPill(status);
  const { match } = status ? currentPart(projects, printer.id, r) : { match: null };
  const error = !printer.disabled && status?.error;
  const left = r.mc_remaining_time;
  const trays = spools(r);

  const printFacts: [string, string | null][] = active
    ? [
        ["Time left", left !== undefined ? formatDuration(left * 60) : null],
        ["Finishes about", left !== undefined ? finishTime(left) : null],
        ["Layer", r.total_layer_num ? `${r.layer_num ?? 0} / ${r.total_layer_num}` : null],
        ["Speed", speed(r)],
      ]
    : [];
  const readings: [string, string | null][] = [
    ["Nozzle", temp(r.nozzle_temper, r.nozzle_target_temper)],
    ["Bed", temp(r.bed_temper, r.bed_target_temper)],
    ["Chamber", temp(chamberTemp(r))],
    ["Vat", temp(r.vat_temper, r.vat_target_temper)],
    ["UV light", temp(r.uv_led_temper)],
    ["Part fan", fan(r.cooling_fan_speed)],
    ["Aux fan", fan(r.big_fan1_speed)],
    ["Chamber fan", fan(r.big_fan2_speed)],
    ["Hotend fan", fan(r.heatbreak_fan_speed)],
    ["Nozzle size", r.nozzle_diameter ? `${r.nozzle_diameter} mm` : null],
    ["Wi-Fi", r.wifi_signal ?? null],
  ];
  const facts = [...printFacts, ...readings].filter((f): f is [string, string] => !!f[1]);

  return (
    <section className={`printer-panel${printer.disabled ? " off" : ""}`}>
      <div className="printer-row">
        <div>
          <strong>{printer.name}</strong>
          <div className="muted small">{[PRINTER_KIND_NAMES[printer.kind ?? "bambu"], printer.model, printer.ip, printer.serial].filter(Boolean).join(" · ")}</div>
        </div>
        <div className="spacer" />
        <span className={`pill ${printer.disabled ? "" : pill.className}`}>{printer.disabled ? "Off" : pill.label}</span>
        {actions}
      </div>
      {error && <div className="small error-text">{error}</div>}

      {!printer.disabled && (
        <div className="printer-live">
          <Camera printer={printer} status={status} />
          <div className="printer-facts">
            {r.subtask_name && (active || state === "FINISH" || state === "FAILED") ? (
              <div className="printer-print">
                {match ? (
                  <button className="link printer-job" onClick={() => onOpenPart(match.project.id, match.part.id)}>
                    {match.part.name} <span className="muted">· {match.project.name}</span>
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
              <p className="muted small">{status?.connected ? "Nothing printing." : ""}</p>
            )}
            {facts.length > 0 && (
              <dl className="fact-grid">
                {facts.map(([label, value]) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
            )}
            {trays.length > 0 && (
              <div className="spools">
                {trays.map(({ tray, label, active: inUse }) => <Spool key={label} tray={tray} label={label} active={inUse} />)}
              </div>
            )}
            {!!r.hms?.length && (
              <p className="small error-text">The printer is reporting {r.hms.length === 1 ? "a problem" : `${r.hms.length} problems`}. Check its screen.</p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
