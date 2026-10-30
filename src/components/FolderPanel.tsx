import { useMemo, useState } from "react";
import type { Part } from "../types";

interface Props {
  parts: Part[];
  hidden: Set<string>;
  onSetHidden: (groups: string[], hidden: boolean) => void;
  onClose: () => void;
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
export function FolderPanel({ parts, hidden, onSetHidden, onClose }: Props) {
  const [filter, setFilter] = useState("");
  const tree = useMemo(() => buildTree(parts), [parts]);
  const q = filter.trim().toLowerCase();
  const matches = (n: Node): boolean => n.path.toLowerCase().includes(q) || n.children.some(matches);
  const allGroups = useMemo(() => [...new Set(parts.map((p) => p.group))], [parts]);

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
        </label>
        {node.children.map((c) => row(c, depth + 1))}
      </div>
    );
  };

  return (
    <div className="folder-panel" onClick={(e) => e.stopPropagation()}>
      <div className="folder-panel-head">
        <strong>Folders in this build</strong>
        <div className="spacer" />
        <button className="link" onClick={() => onSetHidden(allGroups, false)}>Show all</button>
        <button className="link" onClick={() => onSetHidden(allGroups, true)}>Hide all</button>
        <button className="icon-btn" onClick={onClose} title="Close">✕</button>
      </div>
      <p className="muted small">Unticked folders are hidden and left out of progress totals. Nothing on disk changes.</p>
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
