/**
 * CellContextMenu — the results grid's right-click menu.
 *
 * Purely presentational: the grid decides what the items are (copy the value,
 * drill into a lookup, open the record in Salesforce) and this owns placement
 * and dismissal. Placement clamps to the viewport so a right-click near the
 * bottom or right edge doesn't open a menu that runs off screen.
 *
 * Dismissal covers everything that would leave the menu pointing at the wrong
 * cell: Escape, a click anywhere outside, a window resize, and — because the
 * grid body scrolls under a fixed-position menu — any scroll.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";

export interface CellMenuItem {
  key: string;
  label: string;
  /** Muted text pinned to the right of the row — a record Id, a hint, … */
  hint?: string;
  title?: string;
  /** Draw a divider above this item. */
  separatorBefore?: boolean;
  onSelect: () => void;
}

/** Gap kept between the menu and the viewport edge when clamping. */
const EDGE_MARGIN = 6;

export function CellContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: CellMenuItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  // Start at the cursor, then correct once the rendered size is known. The
  // first paint is at the click point, so there's no visible jump for the
  // common (fits on screen) case.
  const [pos, setPos] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPos({
      left: Math.max(
        EDGE_MARGIN,
        Math.min(x, window.innerWidth - width - EDGE_MARGIN),
      ),
      top: Math.max(
        EDGE_MARGIN,
        Math.min(y, window.innerHeight - height - EDGE_MARGIN),
      ),
    });
  }, [x, y, items.length]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener("keydown", onKey);
    // Capture phase: the grid stops propagation on some of its own handlers.
    document.addEventListener("mousedown", onDown, true);
    window.addEventListener("scroll", onClose, true);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("scroll", onClose, true);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  if (items.length === 0) return null;

  return (
    <div
      ref={ref}
      role="menu"
      style={{ left: pos.left, top: pos.top }}
      className="fixed z-50 min-w-[11rem] max-w-[22rem] py-1 bg-zinc-900 border border-zinc-700 rounded shadow-xl text-xs"
      // A right-click on the menu itself shouldn't open a second one.
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item) => (
        <div key={item.key}>
          {item.separatorBefore && (
            <div className="my-1 border-t border-zinc-800" />
          )}
          <button
            role="menuitem"
            title={item.title}
            onClick={() => {
              onClose();
              item.onSelect();
            }}
            className="w-full flex items-center gap-3 px-3 py-1.5 text-left text-zinc-200 hover:bg-zinc-800"
          >
            <span className="truncate">{item.label}</span>
            {item.hint && (
              <span className="ml-auto shrink-0 font-mono text-[10px] text-zinc-500">
                {item.hint}
              </span>
            )}
          </button>
        </div>
      ))}
    </div>
  );
}
