# 3Devil

Cross-platform desktop app (Linux, Windows, macOS) for managing large multi-part 3D print builds — terrain sets, cosplay, big models split into dozens or hundreds of STLs. Track what each build needs, what's printed, and what's on the plate.

## Features

- **Projects** — one per build. Add folders of models, import ZIP downloads (nested ZIPs unpacked), or add loose files. Sub-folders become groups.
- **Quantities** — each part has *needed / printed / failed* counts. Names like `wall_x4.stl` or `4x_barrel.stl` set the needed count automatically.
- **STL / 3MF / OBJ rendering** — cached thumbnails for every part, plus an orbitable 3D viewer with dimensions.
- **Slicer integration** — select parts and *Send to Bambu Studio* or *PrusaSlicer*; the files open in the slicer and are recorded as a queued **print job**. Mark the job *Printed* (counts go up) or *Failed*. Undo is supported.
- **Progress** — per project, per group and per part, with filters for *To print / Queued / Done*.
- **DriveThruRPG** — download a title's ZIP from your library and use *New project → From ZIP*. Store the product link as the project's source URL. (DriveThruRPG has no public library API, so there is no direct sync.)

Slicers are auto-detected (PATH, Flatpak, standard install locations) and can be overridden in **Settings**.

## Development

Requires Node 20+, Rust, and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS.

```bash
npm install
npm run tauri dev       # desktop app
npm run dev             # UI only, in a browser, with a mocked backend + sample models
npm run tauri build     # installers for the current OS
```

`python3 scripts/make_samples.py` regenerates the demo models in `samples/`. Rust tests: `cd src-tauri && cargo test`.

App data (projects, settings) is stored as `state.json` in the OS app-data directory (`~/.local/share/tech.ouija.threedevil` on Linux), with a `.bak` of the previous save.

## Layout

- `src-tauri/src/lib.rs` — backend commands: state persistence, folder scanning, ZIP extraction, slicer detection/launch.
- `src/store.ts` — app state and all project/part/job actions.
- `src/viewer/` — three.js model loading, interactive viewer, thumbnail cache (IndexedDB).
- `src/components/` — UI.
