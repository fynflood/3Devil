import { memo, useEffect, useRef, useState } from "react";
import { useThumbnail } from "../viewer/thumbnails";
import type { Part, PartStatus } from "../types";

interface Props {
  part: Part;
  status: PartStatus;
  queued: number;
  selected: boolean;
  focused: boolean;
  onToggle: (id: string, range: boolean) => void;
  onFocus: (id: string) => void;
  onAdjust: (id: string, delta: number) => void;
  /** Dragging the card out of the window, e.g. onto a slicer. */
  onDragOut: (id: string, thumb: HTMLImageElement | null) => void;
}

function useVisible<T extends Element>() {
  const ref = useRef<T>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || visible) return;
    const io = new IntersectionObserver(([e]) => e.isIntersecting && setVisible(true), { rootMargin: "300px" });
    io.observe(el);
    return () => io.disconnect();
  }, [visible]);
  return [ref, visible] as const;
}

export const PartCard = memo(function PartCard({
  part, status, queued, selected, focused, onToggle, onFocus, onAdjust, onDragOut,
}: Props) {
  const [ref, visible] = useVisible<HTMLDivElement>();
  const imgRef = useRef<HTMLImageElement>(null);
  const thumb = useThumbnail(part.path, part.size, visible && !part.missing);

  return (
    <div
      ref={ref}
      data-part-id={part.id}
      className={`part-card status-${status}${selected ? " selected" : ""}${focused ? " focused" : ""}${part.missing ? " missing" : ""}`}
      onClick={(e) => (e.ctrlKey || e.metaKey || e.shiftKey ? onToggle(part.id, e.shiftKey) : onFocus(part.id))}
      draggable={!part.missing}
      onDragStart={(e) => {
        // Hand the drag to the OS so the files can be dropped on another app.
        e.preventDefault();
        onDragOut(part.id, imgRef.current);
      }}
      title="Drag onto a slicer window to add it there"
    >
      <label className="part-check" onClick={(e) => e.stopPropagation()}>
        <input
          type="checkbox"
          checked={selected}
          onChange={() => undefined}
          onClick={(e) => onToggle(part.id, e.shiftKey)}
        />
      </label>
      <div className="part-thumb">
        {part.missing ? (
          <span className="thumb-note">File missing</span>
        ) : thumb ? (
          <img ref={imgRef} src={thumb} alt="" draggable={false} />
        ) : thumb === null ? (
          <span className="thumb-note">No preview</span>
        ) : (
          <span className="thumb-spinner" />
        )}
        {queued > 0 && status !== "done" && <span className="badge queued">{queued} queued</span>}
        {status === "done" && <span className="badge done">✓</span>}
      </div>
      <div className="part-name" title={part.name}>{part.name}</div>
      <div className="part-count" onClick={(e) => e.stopPropagation()}>
        <button className="icon-btn" onClick={() => onAdjust(part.id, -1)} disabled={part.printed <= 0} title="One fewer printed">−</button>
        <span className={part.printed >= part.required ? "count done" : "count"}>
          {part.printed} / {part.required}
        </span>
        <button className="icon-btn" onClick={() => onAdjust(part.id, 1)} title="One more printed">+</button>
      </div>
    </div>
  );
});
