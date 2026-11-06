import { useEffect, useState } from "react";
import { api, basename, formatBytes, type TrashPlan } from "../api";
import { inFolder } from "../store";
import { folderOf } from "./FolderButton";
import type { Project } from "../types";

interface Props {
  project: Project;
  projects: Project[];
  group: string;
  onRemoved: (trashed: boolean) => void;
  onClose: () => void;
}

/** Takes a folder out of a project, with the choice of moving its files to the Trash too. */
export function RemoveFolderDialog({ project, projects, group, onRemoved, onClose }: Props) {
  const [plan, setPlan] = useState<TrashPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = group.slice(group.lastIndexOf("/") + 1);
  const parts = project.parts.filter((p) => inFolder(p.group, group));
  // Loose files can share a folder without being that folder.
  const found = folderOf(project.parts, group);
  const path = found && basename(found) === name ? found : null;
  const leaving = new Set(parts.map((p) => p.id));
  const inside = (file: string) => !!path && (file.startsWith(`${path}/`) || file.startsWith(`${path}\\`));
  const sharedWith = projects.filter((pr) => pr.parts.some((p) => inside(p.path) && !leaving.has(p.id))).map((pr) => pr.name);

  useEffect(() => {
    if (!path) return;
    let live = true;
    api.folderTrashPlan(path, project.folders)
      .then((p) => live && setPlan(p))
      .catch((e) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, [path, project.folders]);

  const noTrash =
    !path ? "these files aren't all in one folder."
    : sharedWith.length ? `${sharedWith.join(", ")} also uses files in this folder.`
    : plan?.blocked;

  const remove = async (trash: boolean) => {
    setBusy(true);
    setError(null);
    try {
      if (trash) await api.trashFolder(path!, project.folders);
      onRemoved(trash);
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop">
      <div className="modal">
        <h2>Remove “{name}”?</h2>
        <p>
          {parts.length} {parts.length === 1 ? "part" : "parts"} and any sub-folders leave {project.name}, with their print
          counts and jobs. A Rescan won't bring them back.
        </p>
        {path && <p className="mono remove-path">{path}</p>}
        {noTrash ? (
          <p className="muted small">Can't move this to the Trash: {noTrash}</p>
        ) : plan && (
          <p className="muted small">
            Moving it to the Trash takes the whole folder, including anything 3Devil doesn't list: {plan.files}{" "}
            {plan.files === 1 ? "file" : "files"}, {formatBytes(plan.bytes)}.
            {plan.zips.length > 0 && ` ${plan.zips.join(", ")} goes too, or a Rescan would unpack it again.`}
          </p>
        )}
        {error && <p className="small error-text">{error}</p>}
        <div className="btn-row end">
          <button onClick={onClose} disabled={busy}>Cancel</button>
          <button onClick={() => remove(false)} disabled={busy} title="Your files stay where they are">Remove from project</button>
          <button
            className="danger"
            onClick={() => remove(true)}
            disabled={busy || !plan || !!noTrash}
            title="Also move the folder to the Trash, where you can restore it"
          >
            {busy ? "Working…" : "Remove and move to Trash"}
          </button>
        </div>
      </div>
    </div>
  );
}
