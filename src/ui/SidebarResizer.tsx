/**
 * The handle between the chart and the watchlist sidebar: drag it to make the sidebar
 * wider or narrower, like TradingView's right panel. The width is a per-browser
 * preference, so it lives in localStorage, not in the server-side workspace.
 *
 * The watchlist shows its extra columns (change, volume, day range) only when it is
 * wider than its container-query breakpoint (watchlist.css), so a wider sidebar is how
 * the user gets them back.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import { useI18n } from '../i18n';

export const SIDEBAR_DEFAULT_PX = 300;
export const SIDEBAR_MIN_PX = 240;
export const SIDEBAR_MAX_PX = 720;
/** The chart keeps at least this much width, whatever the sidebar asks for. */
export const MIN_CHART_PX = 360;
export const SIDEBAR_WIDTH_KEY = 'rhinoview:sidebar-width';
/** One arrow key press moves the handle this far. */
export const KEY_STEP_PX = 16;

/** The slice of `Storage` we use, so tests can hand in a throwing or in-memory stand-in. */
export interface WidthStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** `px` limited to what fits: never under the minimum, never so wide the chart vanishes. */
export function clampSidebarWidth(px: number, viewportWidth: number): number {
  const max = Math.max(SIDEBAR_MIN_PX, Math.min(SIDEBAR_MAX_PX, viewportWidth - MIN_CHART_PX));
  return Math.round(Math.min(max, Math.max(SIDEBAR_MIN_PX, px)));
}

/**
 * `window.localStorage` itself can throw on access (SecurityError with blocked site
 * data), so even resolving it happens inside the try/catch of every caller.
 */
function defaultStorage(): WidthStorage {
  return globalThis.localStorage;
}

/** The stored width, or the default when nothing usable is stored. */
export function readSidebarWidth(storage: () => WidthStorage = defaultStorage): number {
  try {
    const raw = storage().getItem(SIDEBAR_WIDTH_KEY);
    const px = raw === null ? NaN : Number(raw);
    return Number.isFinite(px) ? px : SIDEBAR_DEFAULT_PX;
  } catch {
    return SIDEBAR_DEFAULT_PX;
  }
}

function writeSidebarWidth(px: number, storage: () => WidthStorage): void {
  try {
    storage().setItem(SIDEBAR_WIDTH_KEY, String(px));
  } catch {
    // Private mode or blocked site data: the width still applies until the page reloads.
  }
}

const viewportWidth = () => window.innerWidth;

/**
 * The sidebar width in px, kept inside the limits when the window resizes.
 * `setWidth(px, { persist: false })` is for the live drag; the width is stored once, on release.
 */
export function useSidebarWidth(storage: () => WidthStorage = defaultStorage) {
  const [width, setRaw] = useState(() => clampSidebarWidth(readSidebarWidth(storage), viewportWidth()));

  const setWidth = useCallback(
    (px: number, { persist = true }: { persist?: boolean } = {}) => {
      const next = clampSidebarWidth(px, viewportWidth());
      setRaw(next);
      if (persist) writeSidebarWidth(next, storage);
    },
    [storage],
  );

  useEffect(() => {
    // Only the shown width shrinks; the stored preference stays for a wider window.
    const onResize = () => setRaw((w) => clampSidebarWidth(Math.max(w, readSidebarWidth(storage)), viewportWidth()));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [storage]);

  return [width, setWidth] as const;
}

export interface SidebarResizerProps {
  width: number;
  onResize: (px: number, opts?: { persist?: boolean }) => void;
  /** The id of the sidebar element this handle sizes. */
  controls: string;
}

export function SidebarResizer({ width, onResize, controls }: SidebarResizerProps) {
  const drag = useRef<{ pointerId: number; startX: number; startWidth: number; last: number } | null>(null);
  const [active, setActive] = useState(false);
  const { t } = useI18n();

  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    e.preventDefault(); // no text selection while dragging
    try {
      // Moves keep arriving here when the pointer leaves the thin handle.
      e.currentTarget.setPointerCapture?.(e.pointerId);
    } catch {
      // No such active pointer (a synthetic event). The drag still works while over the handle.
    }
    drag.current = { pointerId: e.pointerId, startX: e.clientX, startWidth: width, last: width };
    setActive(true);
  }

  function onPointerMove(e: PointerEvent<HTMLDivElement>) {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointerId) return;
    // The sidebar is on the right: moving the handle left makes it wider.
    d.last = d.startWidth + (d.startX - e.clientX);
    onResize(d.last, { persist: false });
  }

  function onPointerEnd(e: PointerEvent<HTMLDivElement>) {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointerId) return;
    drag.current = null;
    setActive(false);
    onResize(d.last);
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const next =
      e.key === 'ArrowLeft' ? width + KEY_STEP_PX
      : e.key === 'ArrowRight' ? width - KEY_STEP_PX
      : e.key === 'Home' ? SIDEBAR_MIN_PX
      : e.key === 'End' ? SIDEBAR_MAX_PX
      : e.key === 'Enter' ? SIDEBAR_DEFAULT_PX
      : null;
    if (next === null) return;
    e.preventDefault();
    onResize(next);
  }

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label={t('sidebar.resize')}
      aria-controls={controls}
      aria-valuenow={width}
      aria-valuemin={SIDEBAR_MIN_PX}
      aria-valuemax={SIDEBAR_MAX_PX}
      title={t('sidebar.resizeTitle')}
      className={`sidebar-resizer${active ? ' active' : ''}`}
      data-testid="sidebar-resizer"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onDoubleClick={() => onResize(SIDEBAR_DEFAULT_PX)}
      onKeyDown={onKeyDown}
    />
  );
}
