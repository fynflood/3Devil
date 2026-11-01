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
      },
    });
    if (done) clearInterval(timer);
  }, 1000);
}

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
  return { downloaded: files.map((f) => f.filename), skipped: [] };
}

mockWindows("main");
mockIPC(async (cmd, args) => {
  const a = (args ?? {}) as Record<string, unknown>;
  switch (cmd) {
    case "load_state":
      return localStorage.getItem("3devil-state") ?? "null";
    case "save_state":
      localStorage.setItem("3devil-state", a.json as string);
      return null;
    case "scan_models":
      console.info("[mock] folder scanning isn't available in the browser");
      return [];
    case "read_model_preview":
    case "read_file_bytes": {
      const path = a.path as string;
      const res = await fetch(encodeURI(`/@fs${path}`));
      if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
      return res.arrayBuffer();
    }
    case "missing_files":
      return [];
    case "extract_archives":
      return { extracted: [], failed: [] };
    case "detect_slicers":
      return { bambu: ["bambu-studio"], prusa: ["prusa-slicer"] };
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
      return "0.1.1";
    case "plugin:updater|check":
      return { rid: 1, currentVersion: "0.1.1", version: "0.1.2", body: "Mock release", rawJson: {} };
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
      return null;
    case "plugin:dialog|confirm":
    case "plugin:dialog|ask":
    case "plugin:dialog|message":
      return true;
    default:
      if (cmd.startsWith("plugin:opener|")) return null;
      throw new Error(`[mock] unhandled command ${cmd}`);
  }
}, { shouldMockEvents: true });
