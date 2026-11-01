import { startDrag } from "@crabnebula/tauri-plugin-drag";

const ICON = 96;

/**
 * The Linux backend turns paths into file:// URIs without escaping them, so
 * paths with spaces wouldn't open in the slicer. Escape each segment first.
 */
const isLinux = navigator.userAgent.includes("Linux");
const forDrag = (path: string) => (isLinux ? path.split("/").map(encodeURIComponent).join("/") : path);

/** Drag image: the part's thumbnail (if loaded) with a count badge for several files. */
export function dragImage(thumb: HTMLImageElement | null, count: number): string {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = ICON;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#262932";
  ctx.beginPath();
  ctx.roundRect(0, 0, ICON, ICON, 10);
  ctx.fill();
  if (thumb?.complete && thumb.naturalWidth) ctx.drawImage(thumb, 4, 4, ICON - 8, ICON - 8);
  if (count > 1) {
    const label = String(count);
    ctx.font = "bold 15px sans-serif";
    const w = Math.max(24, ctx.measureText(label).width + 12);
    ctx.fillStyle = "#e2683c";
    ctx.beginPath();
    ctx.roundRect(ICON - w - 4, 4, w, 22, 11);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, ICON - 4 - w / 2, 15);
  }
  return canvas.toDataURL("image/png");
}

/**
 * Starts dragging files out of the app (e.g. onto a slicer window). Resolves
 * true when they were dropped somewhere, false when the drag was cancelled.
 */
export function dragFiles(paths: string[], icon: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    startDrag({ item: paths.map(forDrag), icon }, (e) => resolve(e.result === "Dropped")).catch(reject);
  });
}
