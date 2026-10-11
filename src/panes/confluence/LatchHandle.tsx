/**
 * The latch handle of the Confluence indicator (docs/CONFLUENCE_PLAN.md, section 6.3).
 *
 * A DOM element over the chart, not a canvas drawing, because it takes the pointer and the
 * keyboard. While the latch is on, a tab at the top of the price pane marks the latch bar,
 * with a dashed line down through the pane. The user drags the tab, or moves it with the
 * arrow keys, and the handle saves the new bar time as `latchTime` through the same path
 * as the settings editor.
 *
 * During a drag only the tab and the line move: the indicator recomputes once, after the
 * save. A latch bar outside the view pins the tab to the nearest edge with an arrow; a
 * click on it scrolls the chart to the latch bar.
 */
import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent, RefObject } from 'react';
import type { Bar, ConfluenceParams, IndicatorConfig } from '@shared/types';
import { t, useI18n } from '../../i18n';
import { INTL_LOCALE, getLocale } from '../../i18n/locale';

/** What the handle needs from the chart. `PriceChart` provides it. */
export interface LatchChart {
  barX(index: number): number | null;
  barAt(x: number): number | null;
  visibleRange(): { from: number; to: number } | null;
  plotWidth(): number;
  pricePaneHeight(): number;
  scrollToBar(index: number): void;
  subscribeView(listener: () => void): () => void;
}

export interface LatchHandlesProps {
  chart: LatchChart | null;
  bars: readonly Bar[];
  indicators: readonly IndicatorConfig[];
  intraday: boolean;
  onChange: (id: string, params: ConfluenceParams) => void;
}

/** A drag starts after the pointer moves this many px; less is a click. */
export const DRAG_THRESHOLD_PX = 3;
/** Keys within this many ms give one save. */
export const KEY_SAVE_DELAY_MS = 500;
/** Two tabs nearer than this in px stack: the later one moves down a row. */
export const TAB_SPACING_PX = 80;
export const ROW_HEIGHT_PX = 20;

/** The latch bar: the first bar with `time >= latchTime`; `bars.length` when there is none. */
export function latchBarIndex(bars: readonly Bar[], latchTime: number): number {
  let lo = 0;
  let hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((bars[mid] as Bar).time < latchTime) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** "Mar 12" on daily bars (UTC), "Mar 12 10:30" on intraday bars (local time). */
export function formatLatchDate(time: number, intraday: boolean): string {
  const options: Intl.DateTimeFormatOptions = intraday
    ? { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }
    : { timeZone: 'UTC', month: 'short', day: 'numeric' };
  return new Intl.DateTimeFormat(INTL_LOCALE[getLocale()], options).format(new Date(time * 1000));
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const isActive = (c: IndicatorConfig) => c.kind === 'confluence' && c.visible && (c.params as ConfluenceParams).latch === 'on';

/** One handle for each visible Confluence indicator with the latch on. */
export function LatchHandles({ chart, bars, indicators, intraday, onChange }: LatchHandlesProps) {
  useI18n(); // re-render on a language change: the dates and the labels follow it
  const active = indicators.filter(isActive);
  const any = active.length > 0;
  const [, setView] = useState(0);
  const layer = useRef<HTMLDivElement>(null);
  const change = useRef(onChange);
  change.current = onChange;

  // Follow scrolls, zooms and resizes, only while a handle shows.
  useEffect(() => {
    if (!chart || !any) return;
    return chart.subscribeView(() => setView((v) => v + 1));
  }, [chart, any]);

  // First position: a latch with no date takes the bar at the centre of the view, and saves it at once.
  const placed = useRef(new Set<string>());
  useEffect(() => {
    if (!chart || bars.length === 0) return;
    for (const c of active) {
      const p = c.params as ConfluenceParams;
      if (p.latchTime !== 0 || placed.current.has(c.id)) continue;
      placed.current.add(c.id);
      const range = chart.visibleRange();
      const centre = range ? Math.round((range.from + range.to) / 2) : bars.length - 1;
      const bar = bars[clamp(centre, 0, bars.length - 1)] as Bar;
      change.current(c.id, { ...p, latchTime: bar.time });
    }
  });

  if (!chart || !any || bars.length === 0) return null;

  // Stack tabs that would overlap: by x, each one a row below a near neighbour.
  const xs = active.map((c) => chart.barX(clamp(latchBarIndex(bars, (c.params as ConfluenceParams).latchTime), 0, bars.length - 1)) ?? 0);
  const order = active.map((_, i) => i).sort((a, b) => (xs[a] as number) - (xs[b] as number));
  const rows = new Array<number>(active.length).fill(0);
  order.forEach((i, k) => {
    const prev = order[k - 1];
    if (prev !== undefined && Math.abs((xs[i] as number) - (xs[prev] as number)) < TAB_SPACING_PX) rows[i] = (rows[prev] as number) + 1;
  });

  return (
    <div className="latch-layer" ref={layer}>
      {active.map((c, i) => (
        <LatchHandle
          key={c.id}
          config={c}
          chart={chart}
          bars={bars}
          intraday={intraday}
          row={rows[i] ?? 0}
          layer={layer}
          onSave={(time) => change.current(c.id, { ...(c.params as ConfluenceParams), latchTime: time })}
        />
      ))}
    </div>
  );
}

interface LatchHandleProps {
  config: IndicatorConfig;
  chart: LatchChart;
  bars: readonly Bar[];
  intraday: boolean;
  row: number;
  layer: RefObject<HTMLDivElement | null>;
  onSave: (time: number) => void;
}

interface Drag {
  pointerId: number;
  startX: number;
  moved: boolean;
}

function LatchHandle({ config, chart, bars, intraday, row, layer, onSave }: LatchHandleProps) {
  const p = config.params as ConfluenceParams;
  const n = bars.length;
  const savedIndex = latchBarIndex(bars, p.latchTime);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [keyIndex, setKeyIndex] = useState<number | null>(null);
  const drag = useRef<Drag | null>(null);
  const keyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (keyTimer.current) clearTimeout(keyTimer.current);
    },
    [],
  );

  // Escape cancels a drag: the tab goes back to the saved date.
  useEffect(() => {
    if (dragIndex === null) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      drag.current = null;
      setDragIndex(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dragIndex]);

  const moving = dragIndex ?? keyIndex;
  // Before the first loaded bar, or after the last one, the date has no bar: the tab pins to that edge.
  const before = moving === null && n > 0 && p.latchTime < (bars[0] as Bar).time;
  const after = moving === null && savedIndex >= n;
  const index = clamp(moving ?? savedIndex, 0, n - 1);
  const time = moving === null ? p.latchTime : (bars[index] as Bar).time;
  const width = chart.plotWidth();
  const x = chart.barX(index);
  let pin: 'left' | 'right' | null = null;
  if (before) pin = 'left';
  else if (after) pin = 'right';
  else if (x === null) {
    const range = chart.visibleRange();
    pin = range && index < range.from ? 'left' : 'right';
  } else if (x < 0) pin = 'left';
  else if (x > width) pin = 'right';

  const date = formatLatchDate(time, intraday);
  const text = pin === 'left' ? `◀ ${date}` : pin === 'right' ? `${date} ▶` : date;
  const left = pin === 'left' ? 0 : pin === 'right' ? width : (x as number);
  const top = row * ROW_HEIGHT_PX;

  const barUnder = (clientX: number): number | null => {
    const rect = layer.current?.getBoundingClientRect();
    const bar = chart.barAt(clientX - (rect?.left ?? 0));
    return bar === null ? null : clamp(bar, 0, n - 1);
  };

  function onPointerDown(e: PointerEvent<HTMLButtonElement>) {
    if (e.button !== 0) return;
    // The chart must not pan: the press is ours.
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = { pointerId: e.pointerId, startX: e.clientX, moved: false };
    e.currentTarget.focus();
  }

  function onPointerMove(e: PointerEvent<HTMLButtonElement>) {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    if (!d.moved && Math.abs(e.clientX - d.startX) < DRAG_THRESHOLD_PX) return;
    d.moved = true;
    const bar = barUnder(e.clientX);
    if (bar !== null) setDragIndex(bar);
  }

  function onPointerUp(e: PointerEvent<HTMLButtonElement>) {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    drag.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    if (!d.moved) {
      // A click on a pinned tab brings the latch bar into view.
      if (pin) chart.scrollToBar(index);
      return;
    }
    const bar = dragIndex;
    setDragIndex(null);
    if (bar === null) return;
    const next = (bars[bar] as Bar).time;
    if (next !== p.latchTime) onSave(next);
  }

  function onPointerCancel() {
    drag.current = null;
    setDragIndex(null);
  }

  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const step = (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 10 : 1);
    const next = clamp((keyIndex ?? index) + step, 0, n - 1);
    setKeyIndex(next);
    if (keyTimer.current) clearTimeout(keyTimer.current);
    keyTimer.current = setTimeout(() => {
      keyTimer.current = null;
      setKeyIndex(null);
      const nextTime = (bars[next] as Bar).time;
      if (nextTime !== p.latchTime) onSave(nextTime);
    }, KEY_SAVE_DELAY_MS);
  }

  const lineHeight = Math.max(0, chart.pricePaneHeight() - top);
  return (
    <div
      className={`latch-handle latch-${p.mode}${pin ? ` latch-pinned-${pin}` : ''}${dragIndex !== null ? ' latch-dragging' : ''}`}
      style={{ left, top }}
      data-testid={`latch-${config.id}`}
    >
      <button
        type="button"
        className="latch-tab"
        aria-label={t('confluence.latchHandle', { date })}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onKeyDown={onKeyDown}
      >
        {text}
      </button>
      {!pin && <div className="latch-line" style={{ height: lineHeight }} aria-hidden="true" />}
    </div>
  );
}
