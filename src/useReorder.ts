import { useCallback, useRef, useState } from "react";

/** Pointer travel before a press turns into a drag rather than a click. */
const THRESHOLD = 5;

/**
 * Drag-to-reorder for a vertical list using pointer events, so it doesn't
 * depend on HTML drag-and-drop (which the webview's file-drop handling can
 * swallow). Items need `data-reorder-id`; `onMove` gets the item and the
 * index it should end up at.
 */
export function useReorder(ids: string[], onMove: (id: string, to: number) => void) {
  /** The item being dragged and the gap it would drop into (0..ids.length). */
  const [drag, setDrag] = useState<{ id: string; gap: number } | null>(null);
  const dragged = useRef(false);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLElement>, id: string) => {
      if (e.button !== 0 || (e.target as HTMLElement).closest("button, input")) return;
      const list = e.currentTarget.parentElement;
      const startY = e.clientY;
      let gap: number | null = null;
      dragged.current = false;

      const gapAt = (y: number) => {
        const items = [...(list?.querySelectorAll<HTMLElement>("[data-reorder-id]") ?? [])];
        const i = items.findIndex((el) => {
          const r = el.getBoundingClientRect();
          return y < r.top + r.height / 2;
        });
        return i < 0 ? items.length : i;
      };
      const move = (ev: PointerEvent) => {
        if (!dragged.current && Math.abs(ev.clientY - startY) < THRESHOLD) return;
        dragged.current = true;
        gap = gapAt(ev.clientY);
        setDrag({ id, gap });
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", up);
        setDrag(null);
        if (gap === null) return;
        const from = ids.indexOf(id);
        const to = gap > from ? gap - 1 : gap;
        if (to !== from) onMove(id, to);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", up);
    },
    [ids, onMove],
  );

  /** True right after a drag, so the click that follows it can be ignored. */
  const wasDrag = useCallback(() => {
    const d = dragged.current;
    dragged.current = false;
    return d;
  }, []);

  return { drag, onPointerDown, wasDrag };
}
