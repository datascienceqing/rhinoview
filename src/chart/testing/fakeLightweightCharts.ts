import { vi } from 'vitest';

/**
 * Stand-in for the `lightweight-charts` module under jsdom, which has no canvas.
 * Records what the app asked of the chart and lets tests fire the library's
 * events (crosshair moves, visible-range changes).
 */

type CrosshairHandler = (param: { time?: number; seriesData: Map<unknown, unknown> }) => void;
type RangeHandler = (range: { from: number; to: number } | null) => void;

export interface FakeSeries {
  definition: unknown;
  options: unknown;
  paneIndex: number | undefined;
  setData: ReturnType<typeof vi.fn>;
  removed: boolean;
}

export class FakeChart {
  removed = false;
  series: FakeSeries[] = [];
  crosshairHandlers = new Set<CrosshairHandler>();
  rangeHandlers = new Set<RangeHandler>();
  visibleRange: { from: number; to: number } | null = null;
  options: unknown;
  applyOptions = vi.fn();
  fitContentCalls = 0;

  constructor(
    public container: HTMLElement,
    options: unknown,
  ) {
    this.options = options;
  }

  private assertLive(): void {
    if (this.removed) throw new Error('Object is disposed');
  }

  addSeries = (definition: unknown, options?: unknown, paneIndex?: number): FakeSeries => {
    this.assertLive();
    const s: FakeSeries = { definition, options, paneIndex, setData: vi.fn(), removed: false };
    this.series.push(s);
    return s;
  };

  removeSeries = (s: FakeSeries): void => {
    this.assertLive();
    s.removed = true;
  };

  subscribeCrosshairMove = (h: CrosshairHandler): void => {
    this.assertLive();
    this.crosshairHandlers.add(h);
  };
  unsubscribeCrosshairMove = (h: CrosshairHandler): void => {
    this.assertLive();
    this.crosshairHandlers.delete(h);
  };

  timeScale = () => ({
    subscribeVisibleLogicalRangeChange: (h: RangeHandler) => {
      this.assertLive();
      this.rangeHandlers.add(h);
    },
    unsubscribeVisibleLogicalRangeChange: (h: RangeHandler) => {
      this.assertLive();
      this.rangeHandlers.delete(h);
    },
    getVisibleLogicalRange: () => {
      this.assertLive();
      return this.visibleRange;
    },
    setVisibleLogicalRange: (r: { from: number; to: number }) => {
      this.assertLive();
      this.visibleRange = r;
    },
    fitContent: () => {
      this.assertLive();
      this.fitContentCalls++;
    },
  });

  remove = (): void => {
    this.assertLive();
    this.removed = true;
  };

  // Test drivers -----------------------------------------------------------
  hover(time: number | undefined): void {
    for (const h of this.crosshairHandlers) h({ time, seriesData: new Map() });
  }
  scrollTo(range: { from: number; to: number } | null): void {
    for (const h of this.rangeHandlers) h(range);
  }
  get liveSeries(): FakeSeries[] {
    return this.series.filter((s) => !s.removed);
  }
}

/** Every chart created since the last `reset`, in creation order (StrictMode makes two per mount). */
export const charts: FakeChart[] = [];

export function resetFakeCharts(): void {
  charts.length = 0;
}

export function lastChart(): FakeChart {
  const c = charts[charts.length - 1];
  if (!c) throw new Error('No chart was created');
  return c;
}

/** The module shape the app imports. Series definitions are plain tags. */
export const fakeModule = {
  createChart: (container: HTMLElement, options: unknown) => {
    const c = new FakeChart(container, options);
    charts.push(c);
    return c;
  },
  CandlestickSeries: { tag: 'Candlestick' },
  LineSeries: { tag: 'Line' },
  AreaSeries: { tag: 'Area' },
  ColorType: { Solid: 'solid' },
  CrosshairMode: { Normal: 0 },
};
