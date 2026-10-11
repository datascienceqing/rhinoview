import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Bar, ConfluenceParams, IndicatorConfig } from '@shared/types';
import { DEFAULT_PARAMS } from '../../indicators/types';
import { KEY_SAVE_DELAY_MS, LatchHandles, ROW_HEIGHT_PX, formatLatchDate, latchBarIndex } from './LatchHandle';
import type { LatchChart } from './LatchHandle';

const T0 = 1_780_000_000;
const DAY = 86_400;
const bars: Bar[] = Array.from({ length: 100 }, (_, i) => ({
  time: T0 + i * DAY,
  open: 100,
  high: 101,
  low: 99,
  close: 100,
  volume: 100,
  vwap: null,
  transactions: null,
}));
const timeOf = (i: number) => (bars[i] as Bar).time;

/** 10 px per bar from the left edge of the visible range; the plot is 600 px wide. */
function fakeChart(range = { from: 0, to: 59 }) {
  const listeners = new Set<() => void>();
  const view = { range };
  const chart = {
    barX: (i: number) => 10 * (i - view.range.from),
    barAt: (x: number) => Math.round(x / 10 + view.range.from),
    visibleRange: () => view.range,
    plotWidth: () => 600,
    pricePaneHeight: () => 400,
    scrollToBar: vi.fn(),
    subscribeView: vi.fn((l: () => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    }),
  } satisfies LatchChart;
  const scroll = (next: { from: number; to: number }) => {
    view.range = next;
    act(() => listeners.forEach((l) => l()));
  };
  return { chart, listeners, scroll };
}

const conf = (over: Partial<ConfluenceParams> = {}, config: Partial<IndicatorConfig> = {}): IndicatorConfig => ({
  id: 'c1',
  kind: 'confluence',
  params: { ...DEFAULT_PARAMS.confluence, latch: 'on', latchTime: timeOf(30), ...over },
  color: '#00bcd4',
  visible: true,
  ...config,
});

function setup(indicators: IndicatorConfig[], chart: LatchChart = fakeChart().chart) {
  const onChange = vi.fn<(id: string, params: ConfluenceParams) => void>();
  const view = render(<LatchHandles chart={chart} bars={bars} indicators={indicators} intraday={false} onChange={onChange} />);
  return { onChange, view };
}
const tab = () => document.querySelector('.latch-tab') as HTMLButtonElement;
const handle = () => document.querySelector('.latch-handle') as HTMLElement;
const date = (i: number) => formatLatchDate(timeOf(i), false);

// jsdom has no PointerEvent: a MouseEvent with a pointerId is what the handle reads.
function pointer(type: 'pointerdown' | 'pointermove' | 'pointerup', init: { pointerId: number; clientX: number; button?: number }): boolean {
  const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: init.clientX, button: init.button ?? 0 });
  Object.defineProperty(e, 'pointerId', { value: init.pointerId });
  return fireEvent(tab(), e);
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('latch helpers', () => {
  it('finds the first bar at or after the latch time', () => {
    expect(latchBarIndex(bars, timeOf(30))).toBe(30);
    expect(latchBarIndex(bars, timeOf(30) - 1)).toBe(30);
    expect(latchBarIndex(bars, timeOf(30) + 1)).toBe(31);
    expect(latchBarIndex(bars, T0 - DAY)).toBe(0);
    expect(latchBarIndex(bars, timeOf(99) + 1)).toBe(100);
  });

  it('formats a daily date in UTC, and an intraday date with the time', () => {
    const t = Date.UTC(2026, 2, 12, 15, 30) / 1000;
    expect(formatLatchDate(t, false)).toBe('Mar 12');
    expect(formatLatchDate(t, true)).toMatch(/^Mar 12, \d\d:\d\d$|^Mar 12 \d\d:\d\d$/);
  });
});

describe('LatchHandles', () => {
  it('shows a handle only for a visible confluence indicator with the latch on', () => {
    setup([conf({ latch: 'off' }), conf({}, { id: 'c2', visible: false }), { ...conf({}, { id: 's' }), kind: 'sma', params: { period: 20 } }]);
    expect(document.querySelector('.latch-handle')).toBeNull();
    cleanup();
    setup([conf()]);
    expect(screen.getByRole('button', { name: `Latch date ${date(30)}. Use the arrow keys to move it.` })).toBeInTheDocument();
  });

  it('sits at the latch bar, in the mode colour class, with a line down the price pane', () => {
    setup([conf({ mode: 'breakdown' })]);
    expect(handle().style.left).toBe('300px');
    expect(handle()).toHaveClass('latch-breakdown');
    expect(tab()).toHaveTextContent(date(30));
    expect((document.querySelector('.latch-line') as HTMLElement).style.height).toBe('400px');
  });

  it('follows the chart when it scrolls, and unsubscribes when it unmounts', () => {
    const fake = fakeChart();
    const { view } = setup([conf()], fake.chart);
    fake.scroll({ from: 10, to: 69 });
    expect(handle().style.left).toBe('200px');
    view.unmount();
    expect(fake.listeners.size).toBe(0);
  });

  it('does not subscribe while no handle shows', () => {
    const fake = fakeChart();
    setup([conf({ latch: 'off' })], fake.chart);
    expect(fake.chart.subscribeView).not.toHaveBeenCalled();
  });

  it('places a latch with no date at the centre of the view, and saves it once', () => {
    const { onChange, view } = setup([conf({ latchTime: 0 })]);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('c1', expect.objectContaining({ latch: 'on', latchTime: timeOf(30) }));
    view.rerender(<LatchHandles chart={fakeChart().chart} bars={bars} indicators={[conf({ latchTime: 0 })]} intraday={false} onChange={onChange} />);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  describe('drag', () => {
    it('snaps to bars, follows the pointer, and saves once on release', () => {
      const { onChange } = setup([conf()]);
      expect(pointer('pointerdown', { pointerId: 1, button: 0, clientX: 300 })).toBe(false); // default prevented
      pointer('pointermove', { pointerId: 1, clientX: 243 });
      expect(handle().style.left).toBe('240px');
      expect(tab()).toHaveTextContent(date(24));
      pointer('pointermove', { pointerId: 1, clientX: 151 });
      expect(onChange).not.toHaveBeenCalled();
      pointer('pointerup', { pointerId: 1, clientX: 151 });
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onChange).toHaveBeenCalledWith('c1', expect.objectContaining({ latchTime: timeOf(15) }));
    });

    it('stays inside the loaded bars', () => {
      const { onChange } = setup([conf()]);
      pointer('pointerdown', { pointerId: 1, button: 0, clientX: 300 });
      pointer('pointermove', { pointerId: 1, clientX: -500 });
      pointer('pointerup', { pointerId: 1, clientX: -500 });
      expect(onChange).toHaveBeenLastCalledWith('c1', expect.objectContaining({ latchTime: timeOf(0) }));
      pointer('pointerdown', { pointerId: 2, button: 0, clientX: 0 });
      pointer('pointermove', { pointerId: 2, clientX: 5000 });
      pointer('pointerup', { pointerId: 2, clientX: 5000 });
      expect(onChange).toHaveBeenLastCalledWith('c1', expect.objectContaining({ latchTime: timeOf(99) }));
    });

    it('does not save a release on the same bar, or a press with no move', () => {
      const { onChange } = setup([conf()]);
      pointer('pointerdown', { pointerId: 1, button: 0, clientX: 300 });
      pointer('pointermove', { pointerId: 1, clientX: 340 });
      pointer('pointermove', { pointerId: 1, clientX: 302 });
      pointer('pointerup', { pointerId: 1, clientX: 302 });
      pointer('pointerdown', { pointerId: 2, button: 0, clientX: 300 });
      pointer('pointerup', { pointerId: 2, clientX: 301 });
      expect(onChange).not.toHaveBeenCalled();
    });

    it('cancels on Escape: the tab goes back and nothing saves', () => {
      const { onChange } = setup([conf()]);
      pointer('pointerdown', { pointerId: 1, button: 0, clientX: 300 });
      pointer('pointermove', { pointerId: 1, clientX: 100 });
      expect(tab()).toHaveTextContent(date(10));
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(tab()).toHaveTextContent(date(30));
      pointer('pointerup', { pointerId: 1, clientX: 100 });
      expect(onChange).not.toHaveBeenCalled();
    });

    it('ignores a press with another mouse button', () => {
      setup([conf()]);
      expect(pointer('pointerdown', { pointerId: 1, button: 2, clientX: 300 })).toBe(true);
      pointer('pointermove', { pointerId: 1, clientX: 100 });
      expect(tab()).toHaveTextContent(date(30));
    });
  });

  describe('keyboard', () => {
    it('moves one bar per arrow key, 10 with Shift, and saves once after the last key', () => {
      vi.useFakeTimers();
      const { onChange } = setup([conf()]);
      fireEvent.keyDown(tab(), { key: 'ArrowRight' });
      fireEvent.keyDown(tab(), { key: 'ArrowRight' });
      fireEvent.keyDown(tab(), { key: 'ArrowLeft', shiftKey: true });
      expect(tab()).toHaveTextContent(date(22));
      act(() => vi.advanceTimersByTime(KEY_SAVE_DELAY_MS - 1));
      expect(onChange).not.toHaveBeenCalled();
      act(() => vi.advanceTimersByTime(1));
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onChange).toHaveBeenCalledWith('c1', expect.objectContaining({ latchTime: timeOf(22) }));
    });

    it('does not save when the keys end on the saved bar', () => {
      vi.useFakeTimers();
      const { onChange } = setup([conf()]);
      fireEvent.keyDown(tab(), { key: 'ArrowRight' });
      fireEvent.keyDown(tab(), { key: 'ArrowLeft' });
      act(() => vi.advanceTimersByTime(KEY_SAVE_DELAY_MS));
      expect(onChange).not.toHaveBeenCalled();
    });
  });

  describe('outside the view (decision D10)', () => {
    it('pins the tab to the left edge with an arrow, and a click scrolls to the latch bar', () => {
      const fake = fakeChart({ from: 40, to: 99 });
      setup([conf()], fake.chart);
      expect(handle()).toHaveClass('latch-pinned-left');
      expect(handle().style.left).toBe('0px');
      expect(tab()).toHaveTextContent(`◀ ${date(30)}`);
      expect(document.querySelector('.latch-line')).toBeNull();
      pointer('pointerdown', { pointerId: 1, button: 0, clientX: 5 });
      pointer('pointerup', { pointerId: 1, clientX: 5 });
      expect(fake.chart.scrollToBar).toHaveBeenCalledWith(30);
    });

    it('pins the tab to the right edge when the latch bar is right of the view', () => {
      setup([conf({ latchTime: timeOf(90) })]);
      expect(handle()).toHaveClass('latch-pinned-right');
      expect(handle().style.left).toBe('600px');
      expect(tab()).toHaveTextContent(`${date(90)} ▶`);
    });

    it('pins to the left for a date before the first bar, and to the right for a date after the last', () => {
      setup([conf({ latchTime: T0 - 5 * DAY })]);
      expect(handle()).toHaveClass('latch-pinned-left');
      expect(tab()).toHaveTextContent(`◀ ${formatLatchDate(T0 - 5 * DAY, false)}`);
      cleanup();
      setup([conf({ latchTime: timeOf(99) + 5 * DAY })], fakeChart({ from: 40, to: 99 }).chart);
      expect(handle()).toHaveClass('latch-pinned-right');
    });

    it('lets a drag start from a pinned tab', () => {
      const { onChange } = setup([conf()], fakeChart({ from: 40, to: 99 }).chart);
      pointer('pointerdown', { pointerId: 1, button: 0, clientX: 5 });
      pointer('pointermove', { pointerId: 1, clientX: 100 });
      pointer('pointerup', { pointerId: 1, clientX: 100 });
      expect(onChange).toHaveBeenCalledWith('c1', expect.objectContaining({ latchTime: timeOf(50) }));
    });
  });

  it('stacks two tabs that would overlap', () => {
    setup([conf(), conf({ latchTime: timeOf(33) }, { id: 'c2' }), conf({ latchTime: timeOf(55) }, { id: 'c3' })]);
    const tops = ['c1', 'c2', 'c3'].map((id) => (screen.getByTestId(`latch-${id}`) as HTMLElement).style.top);
    expect(tops).toEqual(['0px', `${ROW_HEIGHT_PX}px`, '0px']);
  });
});
