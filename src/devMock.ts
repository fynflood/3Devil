// Dev-only stand-in for the Tauri backend so the UI can be worked on in a
// plain browser (`npm run dev`). Serves the generated files in /samples.
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";

const SAMPLE_DIR = "/samples/Demo Castle";
const files = Object.keys(import.meta.glob("/samples/**/*.{stl,3mf,obj}"));

mockWindows("main");
mockIPC(async (cmd, args) => {
  const a = (args ?? {}) as Record<string, unknown>;
  switch (cmd) {
    case "load_state":
      return localStorage.getItem("3devil-state") ?? "null";
    case "save_state":
      localStorage.setItem("3devil-state", a.json as string);
      return null;
    case "scan_models": {
      const dir = (a.dir as string).replace(/\/$/, "");
      return files
        .filter((f) => f.startsWith(dir + "/"))
        .map((path) => {
          const rel = path.slice(dir.length + 1).split("/");
          const file = rel.pop()!;
          return { path, name: file.replace(/\.[^.]+$/, ""), group: rel.join("/"), size: 1000 };
        });
    }
    case "read_file_bytes":
      return (await fetch(encodeURI(a.path as string))).arrayBuffer();
    case "missing_files":
      return [];
    case "extract_archives":
      return { extracted: [], failed: [] };
    case "extract_zip":
      return SAMPLE_DIR;
    case "detect_slicers":
      return { bambu: ["bambu-studio"], prusa: ["prusa-slicer"] };
    case "open_in_slicer":
      console.info("[mock] open_in_slicer", a.command, a.files);
      return null;
    case "plugin:dialog|open":
      return SAMPLE_DIR;
    case "plugin:dialog|confirm":
    case "plugin:dialog|ask":
    case "plugin:dialog|message":
      return true;
    default:
      if (cmd.startsWith("plugin:opener|")) return null;
      throw new Error(`[mock] unhandled command ${cmd}`);
  }
});
