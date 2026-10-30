# 3Devil

Cross-platform desktop app (Linux, Windows, macOS) for managing large multi-part 3D print builds — terrain sets, cosplay, big models split into dozens or hundreds of STLs. Track what each build needs, what's printed, and what's on the plate.

![3Devil showing a tavern build: parts grouped by folder with thumbnails and print counts, and a Bambu Lab printer's live progress in the sidebar](docs/screenshot.png)

## Features

- **Projects** — one per build. Add folders of models, import ZIP downloads (nested ZIPs unpacked), or add loose files. Sub-folders become groups.
- **Quantities** — each part has *needed / printed / failed* counts. Names like `wall_x4.stl` or `4x_barrel.stl` set the needed count automatically.
- **STL / 3MF / OBJ rendering** — cached thumbnails for every part, plus an orbitable 3D viewer with dimensions. Large STLs (hundreds of MB) are simplified in the backend for display; slicers always get the full file.
- **Slicer integration** — select parts and *Send to Bambu Studio* or *PrusaSlicer*; the files open in the slicer and are recorded as a queued **print job**. Mark the job *Printed* (counts go up) or *Failed*. Undo is supported.
- **Progress** — per project, per group and per part, with filters for *To print / Queued / Done*.
- **Folders** — expand/collapse all, and hide folders that aren't part of the build yet (hidden folders don't count toward progress).
- **Search** — across every project from the sidebar; click a result to jump to the part.
- **Bambu Lab printers** — *Settings → Printers → Find printers*, then enter the printer's LAN access code. The sidebar shows live state, progress, time left, layers and temperatures. A running print whose name matches a part is tracked as a print job automatically and marked printed (with the actual print time) when it finishes.
- **DriveThruRPG** — add a *Library App Key* (from your DriveThruRPG account settings) under *Settings*, then browse your purchases in *DriveThruRPG library* and turn any product into a project: its files are downloaded, unpacked and linked to the store page, and *Download update* appears when the publisher updates the files. This uses the same unofficial API as DriveThruRPG's library app (endpoints courtesy of [drpg](https://github.com/glujan/drpg)), so it may break if they change it. Downloaded ZIPs work too: *New project → From ZIP*.

Slicers are auto-detected (PATH, Flatpak, standard install locations) and can be overridden in **Settings**.

## Development

Requires Node 20+, Rust, and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS.

```bash
npm install
npm run tauri dev       # desktop app
npm run dev             # UI only, in a browser, with a mocked backend
npm run tauri build     # installers for the current OS
```

Rust tests: `cd src-tauri && cargo test`.

App data (projects, settings) is stored as `state.json` in the OS app-data directory (`~/.local/share/tech.ouija.threedevil` on Linux), with a `.bak` of the previous save.

## Layout

- `src-tauri/src/lib.rs` — backend commands: state persistence, folder scanning, ZIP extraction, slicer detection/launch.
- `src-tauri/src/preview.rs` — simplified copies of large STLs for thumbnails and the viewer.
- `src-tauri/src/drivethru.rs` — DriveThruRPG library listing and downloads.
- `src-tauri/src/printer.rs` — Bambu Lab printer discovery and live status over the printer's local MQTT (TLS, port 8883).
- `src/printers.ts` — printer connections, matching prints to parts, recording finished prints.
- `src/store.ts` — app state and all project/part/job actions.
- `src/viewer/` — three.js model loading, interactive viewer, thumbnail cache (IndexedDB).
- `src/components/` — UI.
