import { api } from "../api";
import type { Part } from "../types";

function parentDir(path: string, levels: number): string {
  const parts = path.split(/(?=[\\/])/);
  return parts.slice(0, Math.max(1, parts.length - levels)).join("");
}

/**
 * The folder on disk behind a group path like "Castle Set/Walls". Groups
 * mirror sub-folders one-to-one, so this walks up from any file below it.
 * Returns null when the group has no single folder (e.g. "Loose files").
 */
export function folderOf(parts: Part[], group: string): string | null {
  const depth = group.split("/").length;
  const dirs = new Set(
    parts
      .filter((p) => p.group === group || p.group.startsWith(`${group}/`))
      .map((p) => parentDir(p.path, 1 + p.group.split("/").length - depth)),
  );
  return dirs.size === 1 ? [...dirs][0] : null;
}

/** Small folder icon that opens `path` in the system file browser. */
export function FolderButton({ path, notify }: { path: string | null; notify: (msg: string, kind?: "info" | "error") => void }) {
  if (!path) return null;
  return (
    <button
      className="icon-btn folder-btn"
      title={`Open in file browser\n${path}`}
      aria-label="Open in file browser"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        api.openFolder(path).catch((err) => notify(String(err), "error"));
      }}
    >
      <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
        <path
          d="M1.75 3.5A1.25 1.25 0 0 1 3 2.25h3.1l1.5 1.5H13A1.25 1.25 0 0 1 14.25 5v7.5A1.25 1.25 0 0 1 13 13.75H3a1.25 1.25 0 0 1-1.25-1.25z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}
