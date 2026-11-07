# 3Devil

Cross-platform desktop app (Linux, Windows, macOS) for managing large multi-part 3D print builds — terrain sets, cosplay, big models split into dozens or hundreds of STLs. Track what each build needs, what's printed, and what's on the plate.

![3Devil showing a modular keep build: parts grouped by folder with thumbnails and print counts, one part marked as printing, and the printer's live progress in the sidebar](docs/screenshot.png)

## Install

Download the latest installer for your system from the [Releases page](https://github.com/fynflood/3Devil/releases/latest).

The builds aren't code-signed yet, so Windows and macOS will warn the first time you open 3Devil. The steps below get past that once; after that it opens normally.

### Windows 10 / 11

1. Download `3Devil_<version>_x64-setup.exe` (or the `.msi` if you prefer).
2. Run it. If **Windows protected your PC** appears, click **More info → Run anyway**.
3. Start 3Devil from the Start menu.

3Devil uses Microsoft Edge WebView2, which is built into Windows 10 and 11; the installer adds it if it's missing.

### macOS 11 (Big Sur) or newer

1. Download the `.dmg` for your Mac: `aarch64` for Apple Silicon (M1 and later), `x64` for Intel.
2. Open it and drag **3Devil** into **Applications**.
3. Open 3Devil. macOS will say it can't verify the developer. Go to **System Settings → Privacy & Security**, scroll down and click **Open Anyway** next to the 3Devil message, then confirm.

   Or, in Terminal:

   ```bash
   xattr -dr com.apple.quarantine /Applications/3Devil.app
   ```

### Linux

Pick the package for your distribution. They need a 2024 or newer release (Ubuntu 24.04, Debian 13, Fedora 40 or later; any up-to-date Arch).

- **Debian, Ubuntu, Mint, Pop!_OS** — download the `.deb`, then:

  ```bash
  sudo apt install ./3Devil_*_amd64.deb
  ```

- **Fedora, RHEL, openSUSE** — download the `.rpm`, then:

  ```bash
  sudo dnf install ./3Devil-*.x86_64.rpm
  ```

- **Any distribution (including Arch)** — download the `.AppImage`, then:

  ```bash
  chmod +x 3Devil_*_amd64.AppImage
  ./3Devil_*_amd64.AppImage
  ```

  AppImages need FUSE 2 (`sudo pacman -S fuse2` on Arch, `sudo apt install libfuse2t64` on Ubuntu 24.04+).

### Updates

From version 0.1.2 on, 3Devil checks GitHub for new releases, downloads them in the background and, for one found when the app starts, shows what's in it and asks whether to install it now. Choose *Not now*, or let a later check find it, and **Restart to update** waits in the sidebar instead. Nothing installs until you click. After updating, 3Devil shows what's new once; **Settings → General → What's new** shows the full list any time. On Linux, `.deb` and `.rpm` installs ask for your password to install the update. Turn automatic checks off, or check by hand, under **Settings → General**. Versions before 0.1.2 have to be updated by downloading the new installer once.

### Where your data lives

Projects and settings are saved in `state.json` (plus a `.bak` of the previous save):

| OS | Folder |
| --- | --- |
| Windows | `%APPDATA%\tech.ouija.threedevil` |
| macOS | `~/Library/Application Support/tech.ouija.threedevil` |
| Linux | `~/.local/share/tech.ouija.threedevil` |

Uninstalling 3Devil leaves this folder in place. Your model files are never moved or deleted.

## Features

- **Projects** — one per build; drag them in the sidebar to reorder. *Add to this project* takes folders of models, ZIP downloads (nested ZIPs unpacked) or loose files; sub-folders become groups. Start a project from a ZIP with *+ New project*. *Remove* takes a folder out of a project, in its row or under *Folders*: Rescan leaves it out, and adding the folder again brings it back. Its files stay on disk unless you choose *Remove and move to Trash*, which moves the whole folder, plus any ZIP in the project it was unpacked from, to the system Trash. 3Devil won't do that for a folder another project uses, or for one outside the project's folders.
- **Quantities** — each part has *needed / printed / failed* counts. Names like `wall_x4.stl` or `4x_barrel.stl` set the needed count automatically.
- **STL / 3MF / OBJ rendering** — cached thumbnails for every part, plus an orbitable 3D viewer with dimensions. Large STLs (hundreds of MB) are simplified in the backend for display; slicers always get the full file.
- **Slicer integration** — select parts and send them to Bambu Studio, PrusaSlicer, OrcaSlicer, or CHITUBOX and Lychee Slicer for resin printers (*Settings → Slicers* picks which ones are offered); the files open in the slicer and are recorded as a queued **print job**. Tick several parts to send them to one slicer window together, or drag part cards (one, or all ticked ones) onto a slicer window that's already open to add them to its plate; drops within 30 minutes are recorded as one job. PrusaSlicer takes later sends into the window that's already open, and OrcaSlicer can too; both are options in *Settings → Slicers*. Lychee Slicer does this by itself. Bambu Studio opens a new window for each send. Mark the job *Printed* (counts go up) or *Failed*, or take parts out of it (✕ on a part's yellow *queued* badge or in the job, or *Remove from queue* for a selection). Undo is supported.
- **Progress** — per project, per group and per part, with filters for *To print / Printing / Queued / Done*. A part on a connected printer right now shows a *Printing* badge and live progress in place of *queued*: just the part a print is named after, or the whole job if the print is named after the job. The rest of the job stays queued as a job of its own, ready for its next print.
- **Print time left** — each project shows roughly how much printing is left. Times per copy come from tracked prints (a plate of several parts is split between them by file size) or can be typed in on a part from the slicer's estimate. Parts with no time yet are guessed from the timed ones by file size, once at least three have times.
- **Folders** — open any folder in your file browser from its folder icon, expand/collapse all, and hide folders that aren't part of the build yet (hidden folders don't count toward progress). To take a folder out for good, use *Remove*, described under Projects.
- **Search** — across every project from the sidebar; click a result to jump to the part.
- **Bambu Lab printers** — *Printers → Find printers on my network*, then enter the printer's LAN access code. The sidebar shows live state, progress, time left, layers and temperatures. A running print whose name matches a part is tracked as a print job automatically, including a plate of several objects (`Clip.stl + Clip.stl + …`); when it ends, 3Devil asks whether it worked (with good-copy counts per part) and records the result and print time.
- **Prusa printers** (MK4/MK4S, MK3.9, XL, MINI, Core One, or an MK3S with Prusa Link on a Raspberry Pi) — turn on PrusaLink on the printer (*Settings → Network → PrusaLink*), then *Printers → Add printer → Prusa* with its address and password (plus a user name, if you chose your own on a Raspberry Pi). They show and track prints the same way, minus layer counts (PrusaLink doesn't report them). Files named by PrusaSlicer's default pattern (`Wall_A_0.4n_0.2mm_PLA_MK4S_1h2m.bgcode`) are matched to the part `Wall_A`.
- **Klipper printers** — any printer running Moonraker (the service behind Fluidd and Mainsail): *Printers → Find printers on my network*, or *Add printer → Klipper* with its address. An API key is only needed if Moonraker doesn't already trust your computer. They show and track prints the same way; layer counts appear if the slicer sends `SET_PRINT_STATS_INFO`.
- **Elegoo printers** — resin printers such as the Saturn 4 and Mars 5, and the Centauri Carbon: *Printers → Find printers on my network*, or *Add printer → Elegoo* with its address. No login is needed. Resin prints (`.ctb`, `.goo`) are matched to parts by file name and tracked like the others, with layers, time left, and the vat and UV light temperatures. Some older Elegoo printers use an earlier version of Elegoo's protocol and aren't supported yet.
- **Printers page** — each printer's live camera, current print, time left and finish time, layer, temperatures, fans, speed and loaded filament. The camera only runs while the page is open. X1 and other Bambu printers that stream video need `ffmpeg` installed and *LAN Mode Liveview* turned on; P1 and A1 printers need LAN Mode Liveview. Klipper cameras are the first one Moonraker lists. Elegoo cameras need `ffmpeg` for resin printers, and Elegoo printers allow only two viewers at once, counting Elegoo's own app. Prusa printers don't show a camera. Untick *Enabled* to stop connecting to a printer and hide it from the sidebar.
- **Sync between computers** — *Settings → Sync → Share using a folder…* keeps projects in a folder that Syncthing, Dropbox, OneDrive, iCloud Drive or a network share keeps in step; pick the same folder on the other computer to use the same projects. Changes from the other computer show up within a few seconds of syncing; use one computer at a time, since edits made on two at once can overwrite each other. Slicer settings stay separate on each computer. If a project's folder is somewhere else on this computer (another drive or user folder), *Locate…* it once; other folders under the same parent are found too, and the shared file keeps the original paths. If the shared folder is unavailable at startup, 3Devil says so instead of starting empty.
- **Model Library** — browse where your models come from, one source at a time.
- **MyMiniFactory** — in *Model Library*, choose *MyMiniFactory* and sign in on its own page, which lasts about a week. Your liked models and collections are listed, marked *Owned* where you've bought them, and any model can be added by pasting its link. *Create project* downloads what you own, and free models, to *Documents/MyMiniFactory*. MyMiniFactory offers no list of purchases, so anything you own has to be liked, collected or pasted. Its sign-in page has no Google option, so if you use Google there, set a password on your account first.
- **DriveThruRPG** — in *Model Library*, choose *DriveThruRPG* and add a *Library App Key* (from your DriveThruRPG account settings). Then browse your purchases and turn any product into a project: its files are downloaded, unpacked and linked to the store page. The library is saved after the first load, so later it opens straight away and refreshes in the background. This uses the same unofficial API as DriveThruRPG's library app (endpoints courtesy of [drpg](https://github.com/glujan/drpg)), so it may break if they change it. Downloaded ZIPs work too: *New project → From ZIP*.
- **Publisher updates** — 3Devil checks your DriveThruRPG library each time it starts. When a publisher changes a linked product, the project shows *Update* in the sidebar and a *Download update* banner. A project you made from a folder offers to link itself when its name or folder matches a product. Only files that differ from the store are downloaded, into the project's own folder. Parts are then tagged **Updated**, **New** or **Not in update** (the *Updated* filter lists them), and an updated part you've already printed says your copies are the old version. A new part with a revision mark in its name or folder (`Corner_Stairs_Rev_11526`, `Roof_Revised`) is matched to the part it seems to replace: both get a tag, and one click, or *Use all newer versions*, lets the new part take over, with the old one leaving the build's progress. Nothing is replaced until you say so, and any new part can be pointed at an older one by hand. Print counts are never changed, and old files the update dropped stay on disk; updated files replace the old ones. Files updated some other way work too: put the new ZIP in the project folder over the old one and press *Rescan*.

Slicers are auto-detected (PATH, Flatpak, standard install locations), and the ones found are turned on the first time 3Devil starts. Change them in **Settings → Slicers**, where PrusaSlicer and OrcaSlicer can add files to a window that's already open. OrcaSlicer's option is its own *Allow only one OrcaSlicer instance* preference, so close OrcaSlicer before changing it. Bambu Studio and PrusaSlicer can start on a print preset you've saved in them, chosen in their rows; 3Devil sets it just before opening a new window, and a window that's already open keeps its preset. This doesn't work with PrusaSlicer on Windows yet. **Settings → General** switches between dark (the default) and light, or follows your system.

## Building from source

You need [Node.js](https://nodejs.org/) 20.19 or newer and [Rust](https://rustup.rs/) (stable), plus your OS's build tools:

- **Windows** — [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with the *Desktop development with C++* workload.
- **macOS** — Xcode command-line tools: `xcode-select --install`.
- **Debian / Ubuntu**

  ```bash
  sudo apt install build-essential curl wget file libssl-dev libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev
  ```

- **Fedora**

  ```bash
  sudo dnf install webkit2gtk4.1-devel openssl-devel curl wget file libappindicator-gtk3-devel librsvg2-devel libxdo-devel
  sudo dnf group install c-development
  ```

- **Arch**

  ```bash
  sudo pacman -S --needed base-devel webkit2gtk-4.1 curl wget file openssl appmenu-gtk-module libappindicator-gtk3 librsvg xdotool
  ```

Then:

```bash
git clone https://github.com/fynflood/3Devil.git
cd 3Devil
npm ci
npm run tauri build
```

Installers end up in `src-tauri/target/release/bundle/`.

### Development

```bash
npm run tauri dev       # desktop app with hot reload
npm run dev             # UI only, in a browser, with a mocked backend
cd src-tauri && cargo test
```

### Releases

Add a section for the version to `CHANGELOG.md` first: it becomes the release notes, and what the app shows after updating. Write it for the people using the app.

Pushing a version tag builds installers for every platform on GitHub Actions (`.github/workflows/release.yml`) and attaches them to a draft release to review and publish:

```bash
git tag v0.1.0
git push origin v0.1.0
```

The tag should match `version` in `src-tauri/tauri.conf.json`.

Update files are signed so installed copies only accept genuine updates. The workflow needs the signing key in the repository secrets `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`; the matching public key is in `tauri.conf.json` under `plugins.updater`. Each release's `latest.json` tells installed copies what's new.

## Layout

- `src-tauri/src/lib.rs` — backend commands: folder scanning, ZIP extraction, slicer detection/launch.
- `src-tauri/src/storage.rs` — saving projects, on this computer or in a shared folder, with per-computer folder mappings.
- `src-tauri/src/preview.rs` — simplified copies of large STLs for thumbnails and the viewer.
- `src-tauri/src/drivethru.rs` — DriveThruRPG library listing and downloads.
- `src-tauri/src/myminifactory.rs` — MyMiniFactory sign-in, listing and downloads through its official API.
- `src-tauri/src/printer.rs` — Bambu Lab printer discovery and live status over the printer's local MQTT (TLS, port 8883).
- `src-tauri/src/prusa.rs` — Prusa printer status over PrusaLink (HTTP, Digest login), converted to the same report Bambu printers send.
- `src-tauri/src/klipper.rs` — Klipper printer status over Moonraker (HTTP, optional API key), converted to the same report.
- `src-tauri/src/elegoo.rs` — Elegoo printer discovery (UDP port 3000) and status over SDCP 3 (WebSocket, port 3030), converted to the same report.
- `src-tauri/src/folders.rs` — moving a project's folder to the system Trash, with the checks that decide whether it may.
- `src-tauri/src/orca.rs` — OrcaSlicer's single-window preference, changed in its own settings file.
- `src-tauri/src/bambu.rs`, `src-tauri/src/prusaslicer.rs` — the print preset new windows of those slicers start on, changed in their own settings files.
- `src-tauri/src/camera.rs` — live camera pictures: Bambu RTSP through `ffmpeg`, Bambu's JPEG stream on port 6000, Klipper snapshot or MJPEG addresses, and Elegoo RTSP or MJPEG.
- `src/printers.ts` — printer connections, matching prints to parts, recording finished prints.
- `src/store.ts` — app state and all project/part/job actions.
- `src/viewer/` — three.js model loading, interactive viewer, thumbnail cache (IndexedDB).
- `src/components/` — UI.
