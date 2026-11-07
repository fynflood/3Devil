// Dev-only stand-in for the Tauri backend so the UI can be worked on in a
// plain browser (`npm run dev`). State lives in localStorage; model files are
// read through Vite's /@fs/ route (folders must be in server.fs.allow).
// Folder scanning and native dialogs aren't available here.
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";

/** The first part in the saved state, so the simulated print matches something. */
function firstPartName(): string {
  try {
    return JSON.parse(localStorage.getItem("3devil-state") ?? "null")?.projects?.[0]?.parts?.[0]?.name ?? "test print";
  } catch {
    return "test print";
  }
}

/** A camera picture with a changing mark, so a moving feed can be told from a stuck one. */
async function mockCameraFrame(): Promise<ArrayBuffer> {
  const canvas = document.createElement("canvas");
  [canvas.width, canvas.height] = [640, 360];
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#223";
  ctx.fillRect(0, 0, 640, 360);
  ctx.fillStyle = "#e2683c";
  ctx.fillRect((Date.now() / 10) % 640, 160, 40, 40);
  const blob = await new Promise<Blob>((done) => canvas.toBlob((b) => done(b!), "image/jpeg"));
  return blob.arrayBuffer();
}

/** Simulates a printer running a job for about 40 seconds, then finishing. */
function simulatePrinter(id: string) {
  const start = Math.floor(Date.now() / 1000);
  const subtask = firstPartName();
  let tick = 0;
  const timer = setInterval(() => {
    tick++;
    const done = tick > 40;
    emit("printer-status", {
      id,
      connected: true,
      error: null,
      print: {
        gcode_state: done ? "FINISH" : "RUNNING",
        mc_percent: done ? 100 : Math.round(tick * 2.4),
        mc_remaining_time: done ? 0 : 200 - tick * 5,
        layer_num: tick * 4,
        total_layer_num: 160,
        subtask_name: subtask,
        gcode_start_time: String(start - 3600),
        nozzle_temper: 219.6,
        nozzle_target_temper: 220,
        bed_temper: 55,
        bed_target_temper: 55,
        chamber_temper: 31,
        spd_lvl: 2,
        spd_mag: 100,
        wifi_signal: "-52dBm",
        cooling_fan_speed: "15",
        big_fan1_speed: "11",
        big_fan2_speed: "8",
        heatbreak_fan_speed: "15",
        nozzle_diameter: "0.4",
        ipcam: { rtsp_url: "rtsps://192.168.1.50:322/streaming/live/1" },
        ams: { tray_now: "254", ams: [{ id: "0", tray: [{ id: "0", tray_type: "PETG", tray_color: "D02B2BFF", remain: 62 }, { id: "1" }] }] },
        vt_tray: { id: "255", tray_type: "PLA", tray_color: "161616FF", remain: 0 },
      },
    });
    if (done) clearInterval(timer);
  }, 1000);
}

/**
 * Simulates a Prusa printer over PrusaLink: a PrusaSlicer-named file, a short
 * filament-change stop, then finished. The password "mock" logs in.
 */
function simulateResin(id: string) {
  const start = Math.floor(Date.now() / 1000);
  const subtask = `${firstPartName().replace(/\.[a-z0-9]+$/i, "")}.ctb`;
  let tick = 0;
  const timer = setInterval(() => {
    tick++;
    const done = tick > 30;
    emit("printer-status", {
      id,
      connected: true,
      error: null,
      print: {
        gcode_state: done ? "FINISH" : "RUNNING",
        mc_percent: done ? 100 : Math.round(tick * 3.2),
        mc_remaining_time: done ? undefined : 95 - tick * 3,
        layer_num: tick * 40,
        total_layer_num: 1240,
        subtask_name: subtask,
        gcode_start_time: String(start),
        job_id: "f25273b12b094c5a",
        vat_temper: 29.4,
        vat_target_temper: 30,
        uv_led_temper: 34.2,
      },
    });
    if (done) clearInterval(timer);
  }, 1000);
}

function simulatePrusa(id: string, password: string) {
  if (password !== "mock") {
    emit("printer-status", { id, connected: false, error: "PrusaLink rejected the login. Check the username and password (or API key).", print: {} });
    return;
  }
  const start = Math.floor(Date.now() / 1000);
  const subtask = `${firstPartName().replace(/\.[a-z0-9]+$/i, "")}_0.4n_0.2mm_PLA_MK4S_1h2m.bgcode`;
  let tick = 0;
  const timer = setInterval(() => {
    tick++;
    const done = tick > 30;
    emit("printer-status", {
      id,
      connected: true,
      error: null,
      print: {
        gcode_state: done ? "FINISH" : tick >= 10 && tick < 14 ? "ATTENTION" : "RUNNING",
        mc_percent: done ? 100 : Math.round(tick * 3.2),
        mc_remaining_time: done ? undefined : 62 - tick * 2,
        subtask_name: subtask,
        gcode_start_time: String(start),
        job_id: "42",
        nozzle_temper: 214.8,
        nozzle_target_temper: 215,
        bed_temper: 60.1,
        bed_target_temper: 60,
      },
    });
    if (done) clearInterval(timer);
  }, 1000);
}

const STAMP = "3devil-state-stamp";
const bumpStamp = () => {
  const next = String(Number(localStorage.getItem(STAMP) ?? "0") + 1);
  localStorage.setItem(STAMP, next);
  return next;
};

type MockLocal = { sharedDir: string | null; pathMap: { from: string; to: string }[] };
const mockLocal = (): MockLocal => ({ sharedDir: null, pathMap: [], ...JSON.parse(localStorage.getItem("3devil-mock-local") ?? "{}") });
const saveMockLocal = (l: MockLocal) => localStorage.setItem("3devil-mock-local", JSON.stringify(l));

/** Swaps mapped folder prefixes like the backend: "in" on load, "out" on save. */
function mapPaths(json: string, dir: "in" | "out"): string {
  const { pathMap } = mockLocal();
  if (!pathMap.length || json === "null") return json;
  const state = JSON.parse(json);
  const swap = (p: string) => {
    for (const m of pathMap) {
      const [a, b] = dir === "in" ? [m.from, m.to] : [m.to, m.from];
      if (p === a || p.startsWith(a + "/")) return b + p.slice(a.length);
    }
    return p;
  };
  for (const project of state.projects ?? []) {
    project.folders = (project.folders ?? []).map(swap);
    for (const part of project.parts ?? []) part.path = swap(part.path);
  }
  return JSON.stringify(state);
}

/** Simulates another computer editing the shared projects file. */
(window as unknown as { __mockOtherComputer: (fn: (s: { projects: { name: string }[] }) => void) => void }).__mockOtherComputer = (fn) => {
  const state = JSON.parse(localStorage.getItem("3devil-state") ?? "null");
  fn(state);
  localStorage.setItem("3devil-state", JSON.stringify(state));
  bumpStamp();
};

const MOCK_LIBRARY = [
  { productId: "500001", orderProductId: 1, name: "Modular Dungeon Tiles", publisher: { name: "Example Forge" }, fileLastModified: "2026-10-01T12:00:00+00:00", files: [{ index: 0, filename: "Dungeon_Tiles.zip" }, { index: 1, filename: "Build_Guide.pdf" }] },
  { productId: "500002", orderProductId: 2, name: "Coastal Watchtower", publisher: { name: "Example Forge" }, fileLastModified: "2026-09-12T12:00:00+00:00", files: [{ index: 0, filename: "Watchtower_STL.zip" }] },
  { productId: "500003", orderProductId: 3, name: "Adventure Module (PDF only)", publisher: { name: "Paper Press" }, fileLastModified: "2026-08-02T12:00:00+00:00", files: [{ index: 0, filename: "module.pdf" }] },
];

/** Pretends to fetch the library a page at a time, then saves it like the backend does. */
async function mockLibrary(key: string) {
  if (!key.startsWith("mock")) throw new Error("DriveThruRPG rejected the Library App Key.");
  for (let page = 1; page <= 3; page++) {
    await new Promise((r) => setTimeout(r, 1000));
    await emit("drivethru-library-progress", page * 100);
  }
  const library = { keyHash: key, fetchedAt: Date.now(), products: MOCK_LIBRARY };
  localStorage.setItem("3devil-drivethru-library", JSON.stringify(library));
  return library;
}

/** Pretends to download each file over about a second. */
async function mockDownload(orderProductId: number, files: { filename: string }[]) {
  for (const [i, f] of files.entries()) {
    for (let step = 1; step <= 4; step++) {
      await new Promise((r) => setTimeout(r, 250));
      await emit("drivethru-progress", { orderProductId, file: f.filename, fileIndex: i, fileCount: files.length, received: step * 5e6, total: 2e7 });
    }
  }
  return { downloaded: files.map((f) => f.filename), skipped: [], changed: [] };
}

mockWindows("main");
mockIPC(async (cmd, args) => {
  const a = (args ?? {}) as Record<string, unknown>;
  switch (cmd) {
    case "load_state":
      // A shared folder whose name ends in "-offline" stands in for an unreachable one.
      if (mockLocal().sharedDir?.endsWith("-offline")) {
        throw `Can't open the shared projects file ${mockLocal().sharedDir}/3devil-projects.json. Check that the folder is available.`;
      }
      return mapPaths(localStorage.getItem("3devil-state") ?? "null", "in");
    case "save_state":
      localStorage.setItem("3devil-state", mapPaths(a.json as string, "out"));
      return bumpStamp();
    case "state_stamp":
      return localStorage.getItem(STAMP) ?? "0";
    case "data_location": {
      const l = mockLocal();
      return { sharedDir: l.sharedDir, file: `${l.sharedDir ?? "/home/user/.local/share/tech.ouija.threedevil"}/state.json`, pathMap: l.pathMap };
    }
    case "inspect_shared_folder":
      return String(a.dir).endsWith("-existing") ? { projects: 3, modified: Date.now() - 2 * 3600e3 } : null;
    case "set_shared_folder":
      saveMockLocal({ ...mockLocal(), sharedDir: (a.dir as string | null) ?? null });
      return null;
    case "add_path_mapping": {
      const from = String(a.missing).split("/");
      const to = String(a.found).split("/");
      while (from.length > 2 && to.length > 2 && from[from.length - 1] === to[to.length - 1]) {
        from.pop();
        to.pop();
      }
      const m = { from: from.join("/"), to: to.join("/") };
      const l = mockLocal();
      saveMockLocal({ ...l, pathMap: [m, ...l.pathMap.filter((x) => x.from !== m.from)] });
      return m;
    }
    case "remove_path_mapping": {
      const l = mockLocal();
      saveMockLocal({ ...l, pathMap: l.pathMap.filter((x) => x.from !== a.from) });
      return null;
    }
    case "scan_models":
      // Tests set window.__mockScan to the files a folder holds.
      if ((window as unknown as { __mockScan?: unknown }).__mockScan) return (window as unknown as { __mockScan: (dir: string) => unknown }).__mockScan(a.dir as string);
      console.info("[mock] folder scanning isn't available in the browser");
      return [];
    case "mmf_session":
      return (window as unknown as { __mockMmf?: unknown }).__mockMmf ?? null;
    case "mmf_sign_in":
      await new Promise((r) => setTimeout(r, 300));
      return ((window as unknown as { __mockMmf?: unknown }).__mockMmf = { username: "demo", expiresAt: Math.floor(Date.now() / 1000) + 604800 });
    case "mmf_cancel_sign_in":
      return null;
    case "mmf_sign_out":
      (window as unknown as { __mockMmf?: unknown }).__mockMmf = null;
      return null;
    case "mmf_library": {
      const model = (id: number, name: string, price: string | null, bought: boolean | null) => ({ id, name, url: `https://www.myminifactory.com/object/demo-${id}`, designer: "Demo Designer", price, bought });
      return {
        likes: [model(1, "Owned Goblin", "€3.99", true), model(2, "Unowned Dragon", "€5.99", false), model(3, "Free Barrel", null, null)],
        collections: [{ name: "Terrain", models: [model(4, "Stone Wall", "£6.00", true)] }],
      };
    }
    case "mmf_lookup": {
      const err = (window as unknown as { __mockMmfError?: string }).__mockMmfError;
      if (err) throw err;
      return { id: 9, name: "Pasted Model", url: String(a.link), designer: "Demo Designer", price: "€2.00", bought: true };
    }
    case "mmf_download": {
      const err = (window as unknown as { __mockMmfError?: string }).__mockMmfError;
      if (err) throw err;
      await new Promise((r) => setTimeout(r, 300));
      return { downloaded: ["a.stl"], skipped: [] };
    }
    case "folder_trash_plan":
      return { files: 12, bytes: 3.4e8, zips: [], blocked: null, ...(window as unknown as { __mockTrashPlan?: object }).__mockTrashPlan };
    case "trash_folder":
      if ((window as unknown as { __mockTrashError?: string }).__mockTrashError) throw (window as unknown as { __mockTrashError: string }).__mockTrashError;
      console.info("[mock] trash_folder", a.path);
      return null;
    case "bambu_presets":
    case "prusa_presets":
      return ["0.20mm Standard Copy", "Demo preset, with a comma"];
    case "set_bambu_preset":
    case "set_prusa_preset":
      console.info("[mock] set_preset", a.name);
      if ((window as unknown as { __mockPresetError?: string }).__mockPresetError) throw (window as unknown as { __mockPresetError: string }).__mockPresetError;
      return null;
    case "orca_single_instance":
      return (window as unknown as { __mockOrcaWindow?: boolean | null }).__mockOrcaWindow ?? false;
    case "set_orca_single_instance":
      (window as unknown as { __mockOrcaWindow?: boolean }).__mockOrcaWindow = a.on as boolean;
      return null;
    case "read_model_preview":
    case "read_file_bytes": {
      const path = a.path as string;
      const res = await fetch(encodeURI(`/@fs${path}`));
      if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
      return res.arrayBuffer();
    }
    case "missing_files":
      // Folders under /home/other stand in for another computer's paths.
      return (a.paths as string[]).filter((p) => p.startsWith("/home/other/"));
    case "extract_archives":
      return { extracted: [], failed: [], changed: [], removed: [], ...(window as unknown as { __mockArchiveChanges?: object }).__mockArchiveChanges };
    case "detect_slicers":
      return { bambu: ["bambu-studio"], prusa: null, orca: null, chitubox: null, lychee: ["flatpak", "run", "io.mango3d.LycheeSlicer"] };
    case "open_in_slicer":
      console.info("[mock] open_in_slicer", a.command, a.files, a.singleInstance);
      return null;
    case "plugin:drag|start_drag":
      // Pretend the files were dropped on another app a moment later.
      console.info("[mock] start_drag", a.item);
      setTimeout(() => (a.onEvent as { onmessage: (m: unknown) => void }).onmessage({ result: "Dropped", cursorPos: { x: 0, y: 0 } }), 300);
      return null;
    case "open_folder":
      console.info("[mock] open_folder", a.path);
      return null;
    case "printer_scan":
      return [{ ip: "192.168.1.50", serial: "00M00A000000001", model: "X1 Carbon" }];
    case "printer_probe":
      return { ip: a.ip, serial: "00M00A000000001", model: "X1 Carbon" };
    case "printer_connect":
      simulatePrinter(a.id as string);
      return null;
    case "printer_disconnect":
      return null;
    case "prusa_probe":
      if (a.password !== "mock") throw "PrusaLink rejected the login. Check the username and password (or API key).";
      return { ip: String(a.host).trim(), serial: "CZPX4224X017XK00042", model: "Prusa MK4S" };
    case "prusa_connect":
      simulatePrusa(a.id as string, a.password as string);
      return null;
    case "klipper_probe":
      if (a.apiKey === "wrong") throw "Moonraker rejected that API key. Find it in Fluidd or Mainsail's settings.";
      return { ip: String(a.host).includes(":") ? String(a.host).trim() : `${String(a.host).trim()}:7125`, serial: "", model: "voron" };
    case "klipper_scan":
      return [{ ip: "192.168.1.70:7125", serial: "", model: "voron" }];
    case "klipper_connect":
      simulatePrinter(a.id as string);
      return null;
    case "elegoo_probe":
      if (String(a.host).trim() !== "192.168.1.80") throw `No Elegoo printer answered at ${String(a.host).trim()}. Check it's on and connected to your network.`;
      return { ip: "192.168.1.80", serial: "b4f0a26396520100", model: "Saturn 4 Ultra 16K" };
    case "elegoo_scan":
      return [{ ip: "192.168.1.80", serial: "b4f0a26396520100", model: "Saturn 4 Ultra 16K" }];
    case "elegoo_connect":
      simulateResin(a.id as string);
      return null;
    case "camera_start":
      if ((window as unknown as { __mockCameraError?: string }).__mockCameraError) throw (window as unknown as { __mockCameraError: string }).__mockCameraError;
      return { rotation: 0, flipHorizontal: false, flipVertical: false };
    case "camera_frame":
      return mockCameraFrame();
    case "camera_stop":
      return null;
    case "drivethru_library":
      return mockLibrary(a.key as string);
    case "drivethru_cached_library": {
      const saved = JSON.parse(localStorage.getItem("3devil-drivethru-library") ?? "null");
      return saved?.keyHash === a.key ? saved : null;
    }
    case "drivethru_product_dir":
      return `${a.libraryPath}/${(a.publisher as string) || "Others"}/${a.name}`;
    case "drivethru_download":
      return mockDownload(a.orderProductId as number, a.files as { filename: string }[]);
    case "plugin:app|version":
      return localStorage.getItem("3devil-mock-version") ?? "0.1.1";
    case "plugin:updater|check":
      return { rid: 1, currentVersion: "0.1.1", version: "0.1.2", body: "- **First** change in this version\n- Second change", rawJson: {} };
    case "plugin:updater|download": {
      // Pretend to download 6 MB over about three seconds.
      const ch = a.onEvent as { onmessage: (m: unknown) => void };
      ch.onmessage({ event: "Started", data: { contentLength: 6e6 } });
      for (let i = 0; i < 6; i++) {
        await new Promise((r) => setTimeout(r, 500));
        ch.onmessage({ event: "Progress", data: { chunkLength: 1e6 } });
      }
      ch.onmessage({ event: "Finished" });
      return 2;
    }
    case "plugin:updater|install":
      if ((window as unknown as { __mockInstallError?: string }).__mockInstallError) throw (window as unknown as { __mockInstallError: string }).__mockInstallError;
      return null;
    case "plugin:process|restart":
      console.info("[mock] restart");
      return null;
    case "plugin:resources|close":
      return null;
    case "plugin:path|resolve_directory":
      return "/home/user/Documents";
    case "plugin:path|join":
      return (a.paths as string[]).join("/");
    case "plugin:dialog|open":
      // Tests set window.__mockPick to what the folder picker should return.
      return (window as unknown as { __mockPick?: string }).__mockPick ?? null;
    case "plugin:dialog|confirm":
    case "plugin:dialog|ask":
      return true;
    case "plugin:dialog|message": {
      // confirm() goes through here and expects the clicked button's label; always "click" OK.
      const b = a.buttons as string | { OkCancelCustom?: string[]; OkCustom?: string } | undefined;
      if (typeof b === "object") return b.OkCancelCustom?.[0] ?? b.OkCustom ?? "Ok";
      return b === "YesNo" || b === "YesNoCancel" ? "Yes" : "Ok";
    }
    default:
      if (cmd.startsWith("plugin:opener|")) return null;
      throw new Error(`[mock] unhandled command ${cmd}`);
  }
}, { shouldMockEvents: true });
