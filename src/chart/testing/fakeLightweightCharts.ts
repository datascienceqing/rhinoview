import { vi } from 'vitest';

/**
 * Stand-in for the `lightweight-charts` module under jsdom, which has no canvas.
 * Records what the app asked of the chart and lets tests fire the library's
 * events (crosshair moves, visible-range changes).
 */

type CrosshairHandler = (param: { time?: number; seriesData: Map<unknown, unknown> }) => void;
type RangeHandler = (range: { from: number; to: number } | null) => void;

export interface FakePriceLine {
  options: { price: number; color?: string };
  applyOptions: ReturnType<typeof vi.fn>;
}

/**
 * A pane, modelled on lightweight-charts v5.2.1's behaviour (verified in its source):
 * a pane that loses its last series is removed unless `preserveEmptyPane` is set, and
 * never when it is the only pane. `removePane` just drops the pane, orphaning its series.
 */
/** A pane's price scale. Like the library: auto-scaled until told otherwise. */
export class FakePriceScale {
  opts: { autoScale: boolean; scaleMargins?: { top: number; bottom: number } } = { autoScale: true };
  axisWidth = 60;
  applyOptions = vi.fn((o: { autoScale?: boolean; scaleMargins?: { top: number; bottom: number } }) => {
    this.opts = { ...this.opts, ...o };
  });
  options = (): FakePriceScale['opts'] => this.opts;
  width = (): number => this.axisWidth;
  /** The visible price range; tests set it. Like the library, setting it turns auto-scale off. */
  range: { from: number; to: number } | null = { from: 100, to: 200 };
  getVisibleRange = (): { from: number; to: number } | null => this.range;
  setVisibleRange = vi.fn((r: { from: number; to: number }) => {
    this.opts = { ...this.opts, autoScale: false };
    this.range = r;
  });
}

export class FakePane {
  preserveEmpty = false;
  stretchFactor = 1;
  element = document.createElement('div');
  constructor(private readonly chart: FakeChart) {}

  paneIndex = (): number => this.chart.paneList.indexOf(this);
  getSeries = (): FakeSeries[] => this.chart.series.filter((s) => !s.removed && s.pane === this);
  setPreserveEmptyPane = (preserve: boolean): void => {
    this.preserveEmpty = preserve;
  };
  setStretchFactor = (factor: number): void => {
    this.stretchFactor = factor;
  };
  /** Like the library: take this pane out and put it back at `index`. */
  moveTo = (index: number): void => {
    const list = this.chart.paneList;
    const from = list.indexOf(this);
    if (from < 0) return;
    list.splice(from, 1);
    list.splice(Math.max(0, Math.min(index, list.length)), 0, this);
  };
  getHTMLElement = (): HTMLElement => this.element;
  private readonly scales = new Map<string, FakePriceScale>();
  priceScale = (id: string): FakePriceScale => {
    let s = this.scales.get(id);
    if (!s) {
      s = new FakePriceScale();
      this.scales.set(id, s);
    }
    return s;
  };
  addSeries = (definition: unknown, options?: unknown): FakeSeries =>
    this.chart.addSeries(definition, options, this.paneIndex());
}

export interface FakeSeries {
  definition: unknown;
  options: unknown;
  /** The pane index asked for at creation (the pane may have moved since; see `pane`). */
  paneIndex: number | undefined;
  pane: FakePane;
  setData: ReturnType<typeof vi.fn>;
  applyOptions: ReturnType<typeof vi.fn>;
  createPriceLine: ReturnType<typeof vi.fn>;
  priceLines: FakePriceLine[];
  getPane: () => FakePane;
  /** Like the library: the scale named by the series' `priceScaleId` (default 'right') on its pane. */
  priceScale: () => FakePriceScale;
  /** Primitives attached now. Like the library, attach calls `attached` and detach calls `detached`. */
  primitives: FakePrimitive[];
  attachPrimitive: ReturnType<typeof vi.fn>;
  detachPrimitive: ReturnType<typeof vi.fn>;
  /** A fixed linear scale for tests: y = 1000 - 2 * price. */
  priceToCoordinate: (price: number) => number;
  removed: boolean;
  /** Set by createSeriesMarkers: the markers currently drawn on this series. */
  markersApi?: { markers: unknown[]; setMarkers: ReturnType<typeof vi.fn>; detach: ReturnType<typeof vi.fn> };
}

export interface FakePrimitive {
  attached?(param: { chart: unknown; series: unknown; requestUpdate: () => void }): void;
  detached?(): void;
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
  paneList: FakePane[] = [];
  element = document.createElement('div');

  constructor(
    public container: HTMLElement,
    options: unknown,
  ) {
    this.options = options;
    this.paneList.push(new FakePane(this)); // the default pane 0
  }

  private assertLive(): void {
    if (this.removed) throw new Error('Object is disposed');
  }

  addSeries = (definition: unknown, options?: unknown, paneIndex = 0): FakeSeries => {
    this.assertLive();
    // Like the library: an index past the end appends exactly one new pane.
    const index = Math.min(this.paneList.length, paneIndex);
    let pane = this.paneList[index];
    if (!pane) {
      pane = new FakePane(this);
      this.paneList.push(pane);
    }
    const priceLines: FakePriceLine[] = [];
    const s: FakeSeries = {
      definition,
      options,
      paneIndex,
      pane,
      setData: vi.fn(() => this.assertLive()),
      applyOptions: vi.fn(() => this.assertLive()),
      createPriceLine: vi.fn((o: { price: number; color?: string }) => {
        this.assertLive();
        const line: FakePriceLine = {
          options: o,
          applyOptions: vi.fn((p: { color?: string }) => {
            line.options = { ...line.options, ...p };
          }),
        };
        priceLines.push(line);
        return line;
      }),
      priceLines,
      getPane: () => {
        this.assertLive();
        return s.pane;
      },
      priceScale: () => s.pane.priceScale((options as { priceScaleId?: string } | undefined)?.priceScaleId ?? 'right'),
      primitives: [],
      attachPrimitive: vi.fn((p: FakePrimitive) => {
        this.assertLive();
        s.primitives.push(p);
        p.attached?.({ chart: this, series: s, requestUpdate: () => undefined });
      }),
      detachPrimitive: vi.fn((p: FakePrimitive) => {
        this.assertLive();
        const i = s.primitives.indexOf(p);
        if (i >= 0) s.primitives.splice(i, 1);
        p.detached?.();
      }),
      priceToCoordinate: (price: number) => 1000 - 2 * price,
      removed: false,
    };
    this.series.push(s);
    return s;
  };

  removeSeries = (s: FakeSeries): void => {
    this.assertLive();
    if (s.removed) throw new Error('Series already removed');
    s.removed = true;
    // Like the library (v5.2.1): removing a series does NOT call `detached` on its primitives.
    const pane = s.pane;
    if (!pane.preserveEmpty && pane.getSeries().length === 0 && this.paneList.length > 1) {
      this.paneList.splice(this.paneList.indexOf(pane), 1);
    }
  };

  panes = (): FakePane[] => {
    this.assertLive();
    return [...this.paneList];
  };
  addPane = (preserveEmpty = false): FakePane => {
    this.assertLive();
    const p = new FakePane(this);
    p.preserveEmpty = preserveEmpty;
    this.paneList.push(p);
    return p;
  };
  removePane = (index: number): void => {
    this.assertLive();
    if (this.paneList.length === 1) return;
    if (index < 0 || index >= this.paneList.length) throw new Error('Invalid pane index');
    this.paneList.splice(index, 1);
  };
  chartElement = (): HTMLElement => this.element;

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
    /** A fixed linear scale for tests: x = 100 + 8 * logical (bar spacing 8 px). */
    logicalToCoordinate: (logical: number) => {
      this.assertLive();
      return 100 + 8 * logical;
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
  /** Series per pane, top to bottom, as the chart sees them now. */
  get paneContents(): FakeSeries[][] {
    return this.paneList.map((p) => p.getSeries());
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
  HistogramSeries: { tag: 'Histogram' },
  LineStyle: { Solid: 0, Dotted: 1, Dashed: 2, LargeDashed: 3, SparseDotted: 4 },
  AreaSeries: { tag: 'Area' },
  ColorType: { Solid: 'solid' },
  CrosshairMode: { Normal: 0 },
  createSeriesMarkers: (series: FakeSeries, markers: unknown[] = []) => {
    const api = {
      markers,
      setMarkers: vi.fn((m: unknown[]) => {
        api.markers = m;
      }),
      detach: vi.fn(),
    };
    series.markersApi = api;
    return api;
  },
};
