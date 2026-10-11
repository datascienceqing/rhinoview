/**
 * Docked or floating position of the Alerts window (docs/ALERTS_PLAN.md, section 4.6).
 *
 * Docked (`pos` null) is the default. A pointer drag on the title bar floats the window; it
 * then moves inside the app window and cannot leave it. `dock()` docks it again. The
 * position is not stored: a minimized window opens docked again (the provider remounts it).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, RefObject } from 'react';

export interface Point {
  x: number;
  y: number;
}

/** Keep a box of `size` inside `bounds` (both in px, from the top left). */
export function clampToBounds(p: Point, size: { width: number; height: number }, bounds: { width: number; height: number }): Point {
  return {
    x: Math.min(Math.max(0, p.x), Math.max(0, bounds.width - size.width)),
    y: Math.min(Math.max(0, p.y), Math.max(0, bounds.height - size.height)),
  };
}

const viewport = () => ({ width: window.innerWidth, height: window.innerHeight });

export function useFloatingWindow(ref: RefObject<HTMLElement | null>) {
  const [pos, setPos] = useState<Point | null>(null);
  const drag = useRef<{ dx: number; dy: number; id: number } | null>(null);

  const sizeOf = () => {
    const r = ref.current?.getBoundingClientRect();
    return { width: r?.width ?? 0, height: r?.height ?? 0 };
  };

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      if (e.button !== 0 || (e.target as HTMLElement).closest('button, input, select')) return;
      const r = ref.current?.getBoundingClientRect();
      if (!r) return;
      drag.current = { dx: e.clientX - r.left, dy: e.clientY - r.top, id: e.pointerId };
      e.currentTarget.setPointerCapture?.(e.pointerId);
      e.preventDefault();
    },
    [ref],
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      const d = drag.current;
      if (!d || d.id !== e.pointerId) return;
      setPos(clampToBounds({ x: e.clientX - d.dx, y: e.clientY - d.dy }, sizeOf(), viewport()));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ref],
  );

  const onPointerUp = useCallback((e: ReactPointerEvent<HTMLElement>) => {
    if (drag.current?.id !== e.pointerId) return;
    drag.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  }, []);

  // A smaller app window must not leave a floating window outside it.
  useEffect(() => {
    if (pos === null) return;
    const onResize = () => setPos((p) => (p ? clampToBounds(p, sizeOf(), viewport()) : p));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pos === null]);

  return {
    pos,
    docked: pos === null,
    dock: () => setPos(null),
    /** Keyboard move, for users without a pointer. */
    moveBy(dx: number, dy: number) {
      const r = ref.current?.getBoundingClientRect();
      if (!r) return;
      setPos((p) => clampToBounds({ x: (p?.x ?? r.left) + dx, y: (p?.y ?? r.top) + dy }, sizeOf(), viewport()));
    },
    handleProps: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp },
  };
}
