import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Part } from "../types";
import { FolderButton, folderOf } from "./FolderButton";

interface Props {
  parts: Part[];
  hidden: Set<string>;
  onSetHidden: (groups: string[], hidden: boolean) => void;
  onRemove: (group: string) => void;
  onClose: () => void;
  notify: (msg: string, kind?: "info" | "error") => void;
}

interface Node {
  name: string;
  path: string;
  children: Node[];
  /** Every part group at or below this folder. */
  groups: string[];
  parts: number;
}

function buildTree(parts: Part[]): Node[] {
  const counts = new Map<string, number>();
  for (const p of parts) counts.set(p.group, (counts.get(p.group) ?? 0) + 1);

  const root: Node = { name: "", path: "", children: [], groups: [], parts: 0 };
  const index = new Map<string, Node>([["", root]]);
  for (const [group, n] of counts) {
    let parent = root;
    let path = "";
    for (const seg of group.split("/")) {
      path = path ? `${path}/${seg}` : seg;
      let node = index.get(path);
      if (!node) {
        node = { name: seg, path, children: [], groups: [], parts: 0 };
        index.set(path, node);
        parent.children.push(node);
      }
      node.groups.push(group);
      node.parts += n;
      parent = node;
    }
  }
  const sort = (nodes: Node[]) => {
    nodes.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    nodes.forEach((n) => sort(n.children));
  };
  sort(root.children);
  return root.children;
}

/** Tree of the project's folders with checkboxes to include or hide each one. */
export function FolderPanel({ parts, hidden, onSetHidden, onRemove, onClose, notify }: Props) {
  const [filter, setFilter] = useState("");
  const tree = useMemo(() => buildTree(parts), [parts]);
  const q = filter.trim().toLowerCase();
  const matches = (n: Node): boolean => n.path.toLowerCase().includes(q) || n.children.some(matches);
  const allGroups = useMemo(() => [...new Set(parts.map((p) => p.group))], [parts]);
  const panel = useRef<HTMLDivElement>(null);

  // The toolbar it opens from doesn't scroll, so the panel has to fit below it.
  useLayoutEffect(() => {
    const el = panel.current;
    if (el) el.style.maxHeight = `${window.innerHeight - el.getBoundingClientRect().top - 12}px`;
  }, []);

  const row = (node: Node, depth: number): React.ReactNode => {
    if (q && !matches(node)) return null;
    const hiddenCount = node.groups.filter((g) => hidden.has(g)).length;
    const shown = hiddenCount === 0;
    const mixed = hiddenCount > 0 && hiddenCount < node.groups.length;
    return (
      <div key={node.path}>
        <label className={`folder-row${shown || mixed ? "" : " is-hidden"}`} style={{ paddingLeft: 8 + depth * 16 }}>
          <input
            type="checkbox"
            checked={shown}
            ref={(el) => {
              if (el) el.indeterminate = mixed;
            }}
            onChange={() => onSetHidden(node.groups, shown || mixed)}
          />
          <span className="folder-name">{node.name}</span>
          <span className="muted small">{node.parts}</span>
          <FolderButton path={folderOf(parts, node.path)} notify={notify} />
          <button
            className="icon-btn folder-remove"
            title="Remove this folder from the project"
            aria-label={`Remove ${node.name} from the project`}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onRemove(node.path);
            }}
          >
            ✕
          </button>
        </label>
        {node.children.map((c) => row(c, depth + 1))}
      </div>
    );
  };

  return (
    <div className="folder-panel" ref={panel} onClick={(e) => e.stopPropagation()}>
      <div className="folder-panel-head">
        <strong>Folders in this build</strong>
        <div className="spacer" />
        <button className="link" onClick={() => onSetHidden(allGroups, false)}>Show all</button>
        <button className="link" onClick={() => onSetHidden(allGroups, true)}>Hide all</button>
        <button className="icon-btn" onClick={onClose} title="Close">✕</button>
      </div>
      <p className="muted small">Unticked folders are hidden and left out of progress totals, with nothing changed on disk. ✕ removes one from the project.</p>
      <input
        className="folder-filter"
        type="search"
        placeholder="Filter folders…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        autoFocus
      />
      <div className="folder-tree">{tree.map((n) => row(n, 0))}</div>
    </div>
  );
}
