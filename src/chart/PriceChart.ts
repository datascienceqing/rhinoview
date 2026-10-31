import {
  BarSeries,
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  LineSeries,
  LineStyle,
  createChart,
  createSeriesMarkers,
} from 'lightweight-charts';
import type {
  IChartApi,
  IPaneApi,
  IPriceLine,
  ISeriesApi,
  Logical,
  ISeriesMarkersPluginApi,
  ISeriesPrimitive,
  MouseEventParams,
  Time,
  UTCTimestamp,
} from 'lightweight-charts';
import { snapMarkers } from './markers';
import type { ChartMarker } from './markers';
import type { Bar, ChartType } from '@shared/types';
import { classifyUpdate, toCandles, toCloseLine } from './convert';
import { VerticalPan } from './verticalPan';
import { readTheme } from './theme';
import type { ChartTheme } from './theme';
import { INTL_LOCALE, getLocale } from '../i18n/locale';
import { formatCrosshairTime, formatTick } from './timeFormat';

/** Bars shown after a fresh load; the rest is reachable by scrolling. */
export const INITIAL_VISIBLE_BARS = 100;
/** Empty space kept right of the latest bar. */
const RIGHT_PADDING_BARS = 5;
/** Ask for older history when the left edge is this many bars from the oldest loaded bar. */
export const LOAD_OLDER_THRESHOLD_BARS = 20;

export interface PriceChartHandlers {
  /** Time (Unix seconds) under the crosshair, or null when it leaves the chart. */
  onCrosshairTime?: (time: number | null) => void;
  /** The visible range is within LOAD_OLDER_THRESHOLD_BARS of the oldest bar. Fires often; callers must de-duplicate. */
  onNearStart?: () => void;
  /** The price axis switched between auto-fit and a position the user dragged it to. */
  onAutoScaleChange?: (autoScaled: boolean) => void;
}

/** A point on the chart: the pane under it and the price (or indicator value) at its height. */
export interface ChartPoint {
  /** 0 is the price pane. */
  paneIndex: number;
  pane: IPaneApi<Time>;
  /** The price in the price pane; the indicator value in an indicator pane. */
  value: number;
}

/** A point on the price pane: the nearest bar index (not clamped to the loaded bars) and the price. */
export interface PricePoint {
  index: number;
  price: number;
}

/** A press and a release nearer than this in px is a click, not a drag. */
const CLICK_SLOP_PX = 4;

/** One live series, tagged so `setData` is checked against the right data shape. */
type ActiveSeries =
  | { type: 'candlestick'; api: ISeriesApi<'Candlestick'> }
  | { type: 'line'; api: ISeriesApi<'Line'> }
  | { type: 'bar'; api: ISeriesApi<'Bar'> };

/**
 * Imperative owner of one lightweight-charts instance, with no React in it.
 *
 * After `dispose()` every method is a no-op: React effect cleanup, StrictMode
 * remounts and late async callbacks can all race with disposal, and touching a
 * series API on a removed chart throws.
 */
export class PriceChart {
  private chart: IChartApi | null;
  private series: ActiveSeries | null = null;
  private readonly verticalPan: VerticalPan;
  private bars: Bar[] = [];
  private markers: readonly ChartMarker[] = [];
  /** Bound to the current price series; recreated whenever the series is replaced. */
  private markersApi: ISeriesMarkersPluginApi<Time> | null = null;
  /** Drawings on the price series (the volume profile). Attached again to each new series. */
  private readonly pricePrimitives = new Set<ISeriesPrimitive<Time>>();
  private intraday = false;
  private theme: ChartTheme;
  /** Levels of the active price alerts of the shown symbol (plan section 4.7). */
  private alertLevels: readonly number[] = [];
  private alertLines: IPriceLine[] = [];

  private readonly onCrosshair = (param: MouseEventParams<Time>) => {
    const t = param.time;
    this.handlers.onCrosshairTime?.(typeof t === 'number' ? t : null);
  };

  private readonly onRange = (range: { from: number; to: number } | null) => {
    if (range && range.from < LOAD_OLDER_THRESHOLD_BARS) this.handlers.onNearStart?.();
  };

  constructor(
    private readonly container: HTMLElement,
    private readonly handlers: PriceChartHandlers = {},
  ) {
    this.theme = readTheme(container);
    const t = this.theme;
    this.chart = createChart(container, {
      // Resizes with its container via the library's own ResizeObserver.
      autoSize: true,
      ...this.chartColors(),
      layout: {
        ...this.chartColors().layout,
        // The on-chart logo is OFF, which the library permits only when the attribution
        // requirement is met another way. It is: see NOTICE at the repo root, and the
        // user-visible credit link rendered in the app footer. Do not remove either of
        // those — together they are what makes turning this off licence-compliant.
        attributionLogo: false,
      },
      timeScale: {
        borderColor: t.border,
        rightOffset: RIGHT_PADDING_BARS,
        tickMarkFormatter: (time: Time, type: number) => formatTick(time, type, this.intraday),
      },
      localization: { locale: INTL_LOCALE[getLocale()], timeFormatter: (time: Time) => formatCrosshairTime(time, this.intraday) },
      crosshair: { mode: CrosshairMode.Normal },
    });
    // Pane 0 holds the price series, and `setChartType` removes that series before adding
    // its replacement. With indicator panes below, the library would delete the "empty"
    // pane 0 and the new series would land in an indicator's pane. Never let it.
    this.chart.panes()[0]?.setPreserveEmptyPane(true);
    this.chart.subscribeCrosshairMove(this.onCrosshair);
    this.chart.timeScale().subscribeVisibleLogicalRangeChange(this.onRange);
    // Lets a vertical drag move the price axis, as in TradingView. See verticalPan.ts.
    this.verticalPan = new VerticalPan(container, this.chart, () =>
      this.handlers.onAutoScaleChange?.(this.verticalPan.isAutoScaled()),
    );
  }

  /**
   * The pane and the value at a point in client (viewport) coordinates, or null when the
   * point is not on a pane's plot area: on a price scale, on the time scale, or outside.
   */
  pointAt(clientX: number, clientY: number): ChartPoint | null {
    const chart = this.chart;
    if (!chart) return null;
    const panes = chart.panes();
    for (let i = 0; i < panes.length; i++) {
      const pane = panes[i] as IPaneApi<Time>;
      const el = pane.getHTMLElement();
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (clientY < r.top || clientY >= r.bottom) continue;
      const x = clientX - r.left;
      // The pane's row holds the plot area and then the right price scale.
      if (x < 0 || x >= chart.paneSize(i).width) return null;
      const series = i === 0 ? this.series?.api : pane.getSeries()[0];
      const value = series?.coordinateToPrice(clientY - r.top);
      if (value === null || value === undefined || !Number.isFinite(value)) return null;
      return { paneIndex: i, pane, value };
    }
    return null;
  }

  /**
   * Pointer moves over the chart and clicks (a press and a release in one spot) on the
   * price pane, as a bar index and a price, for the drawing tools. A move off the price
   * pane gives null. Returns the unsubscribe.
   */
  subscribePricePointer(handlers: { move(p: PricePoint | null): void; click(p: PricePoint): void }): () => void {
    const container = this.container;
    if (!this.chart) return () => undefined;
    const at = (e: PointerEvent): PricePoint | null => {
      const point = this.pointAt(e.clientX, e.clientY);
      const r = point?.pane.getHTMLElement()?.getBoundingClientRect();
      const index = r ? this.barAt(e.clientX - r.left) : null;
      return point && point.paneIndex === 0 && index !== null ? { index, price: point.value } : null;
    };
    let down: { x: number; y: number } | null = null;
    const onDown = (e: PointerEvent) => {
      down = e.button === 0 ? { x: e.clientX, y: e.clientY } : null;
    };
    const onUp = (e: PointerEvent) => {
      const start = down;
      down = null;
      if (!start || Math.hypot(e.clientX - start.x, e.clientY - start.y) > CLICK_SLOP_PX) return;
      const p = at(e);
      if (p) handlers.click(p);
    };
    const onMove = (e: PointerEvent) => handlers.move(at(e));
    const onLeave = () => handlers.move(null);
    container.addEventListener('pointerdown', onDown);
    container.addEventListener('pointerup', onUp);
    container.addEventListener('pointermove', onMove);
    container.addEventListener('pointerleave', onLeave);
    return () => {
      container.removeEventListener('pointerdown', onDown);
      container.removeEventListener('pointerup', onUp);
      container.removeEventListener('pointermove', onMove);
      container.removeEventListener('pointerleave', onLeave);
    };
  }

  /** The price at the middle of the visible price range (keyboard menu), or null. */
  centerPrice(): number | null {
    const range = this.series?.api.priceScale().getVisibleRange();
    if (!range) return null;
    const mid = (range.from + range.to) / 2;
    return Number.isFinite(mid) ? mid : null;
  }

  /** Dashed lines at the levels of the active price alerts. They survive a chart type change. */
  setAlertLines(levels: readonly number[]): void {
    if (!this.chart) return;
    this.alertLevels = levels;
    this.writeAlertLines();
  }

  /** Fit the price axis of every pane to its data again (the "Auto" button). */
  resetAutoScale(): void {
    if (!this.chart) return;
    this.verticalPan.resetAutoScale();
  }

  // ───────────── geometry for overlays (the confluence latch handle) ─────────────

  /** Pixel x of the centre of bar `index`, from the left of the chart, or null. */
  barX(index: number): number | null {
    return this.chart?.timeScale().logicalToCoordinate(index as Logical) ?? null;
  }

  /** The bar index nearest pixel `x`, not clamped to the loaded bars, or null. */
  barAt(x: number): number | null {
    const logical = this.chart?.timeScale().coordinateToLogical(x) ?? null;
    return logical === null ? null : Math.round(logical);
  }

  /** The visible logical range, or null. */
  visibleRange(): { from: number; to: number } | null {
    return this.chart?.timeScale().getVisibleLogicalRange() ?? null;
  }

  /** Width of the plot area in px, without the price scale. */
  plotWidth(): number {
    return this.chart?.timeScale().width() ?? 0;
  }

  /** Height of the price pane in px. */
  pricePaneHeight(): number {
    return this.chart?.panes()[0]?.getHeight() ?? 0;
  }

  /** Scroll so bar `index` is at the centre, with the same number of bars in view. */
  scrollToBar(index: number): void {
    const range = this.visibleRange();
    if (!this.chart || !range) return;
    const half = (range.to - range.from) / 2;
    this.chart.timeScale().setVisibleLogicalRange({ from: index - half, to: index + half });
  }

  /** Call `listener` when the bars move on screen: a scroll, a zoom or a resize. Returns the unsubscribe. */
  subscribeView(listener: () => void): () => void {
    const chart = this.chart;
    if (!chart) return () => undefined;
    const timeScale = chart.timeScale();
    timeScale.subscribeVisibleLogicalRangeChange(listener);
    timeScale.subscribeSizeChange(listener);
    return () => {
      // A disposed chart has already dropped its subscribers, and throws on any call.
      if (this.chart !== chart) return;
      timeScale.unsubscribeVisibleLogicalRangeChange(listener);
      timeScale.unsubscribeSizeChange(listener);
    };
  }

  /** The underlying chart, for panes/indicators that add series at a pane index. Null once disposed. */
  get api(): IChartApi | null {
    return this.chart;
  }

  /**
   * Attach a drawing to the price series. It survives a chart type change: it is
   * detached from the old series and attached to the new one.
   */
  attachPricePrimitive(primitive: ISeriesPrimitive<Time>): void {
    if (!this.chart || this.pricePrimitives.has(primitive)) return;
    this.pricePrimitives.add(primitive);
    this.series?.api.attachPrimitive(primitive);
  }

  detachPricePrimitive(primitive: ISeriesPrimitive<Time>): void {
    if (!this.pricePrimitives.delete(primitive) || !this.chart) return;
    this.series?.api.detachPrimitive(primitive);
  }

  /**
   * Read the theme colours again (the app theme changed) and apply them to the chart and
   * the price series. Returns false, and does nothing, when the colours did not change.
   * Layers that draw on this chart (indicator panes) must refresh after it.
   */
  refreshTheme(): boolean {
    const chart = this.chart;
    if (!chart) return false;
    const next = readTheme(this.container);
    if (JSON.stringify(next) === JSON.stringify(this.theme)) return false;
    this.theme = next;
    chart.applyOptions(this.chartColors());
    if (this.series) this.series.api.applyOptions(this.seriesColors(this.series.type));
    this.writeMarkers(); // the default marker colour is the accent
    for (const line of this.alertLines) line.applyOptions({ color: this.theme.accent });
    return true;
  }

  /** Resolved theme colours, for layers that draw on this chart (indicator panes). */
  get colors(): ChartTheme {
    return this.theme;
  }

  /**
   * The language changed (src/i18n has already applied it). The time formatters read the
   * current language; an options change makes the library draw the labels again.
   */
  refreshLocale(): void {
    this.chart?.applyOptions({ localization: { locale: INTL_LOCALE[getLocale()] } });
  }

  setIntraday(intraday: boolean): void {
    if (!this.chart || this.intraday === intraday) return;
    this.intraday = intraday;
    // Time-axis labels are cached by the library; any options change forces a re-render.
    this.chart.applyOptions({ timeScale: { timeVisible: intraday, secondsVisible: false } });
  }

  /** Swap series type in place; the chart, its scales and the visible range survive. */
  setChartType(type: ChartType): void {
    const chart = this.chart;
    if (!chart || this.series?.type === type) return;
    const range = chart.timeScale().getVisibleLogicalRange();
    if (this.series) {
      // removeSeries does not call `detached` on the primitives (v5.2.1 source), so do it here.
      for (const p of this.pricePrimitives) this.series.api.detachPrimitive(p);
      chart.removeSeries(this.series.api);
    }
    // The markers plugin was attached to the removed series and went with it. Without
    // this reset, writeMarkers would keep writing to the dead plugin and the new series
    // would show no flags — ChartView.test.tsx "keeps the markers when the chart type
    // changes" fails exactly that way.
    this.markersApi = null;
    // The price lines went with the old series too.
    this.alertLines = [];
    this.series = this.addSeriesFor(chart, type);
    this.writeAlertLines();
    for (const p of this.pricePrimitives) this.series.api.attachPrimitive(p);
    this.writeData();
    if (range && this.bars.length > 0) chart.timeScale().setVisibleLogicalRange(range);
  }

  /**
   * Set the bars. A prepend (older history arrived) keeps the user's scroll
   * position; anything else (new symbol/timeframe) resets the view to the latest bars.
   */
  setBars(bars: Bar[]): void {
    const chart = this.chart;
    if (!chart) return;
    const update = classifyUpdate(this.bars, bars);
    if (update.kind === 'same') return;

    const range = chart.timeScale().getVisibleLogicalRange();
    this.bars = bars;
    this.writeData();

    if (update.kind === 'prepend') {
      // Logical indices are positions in the data array, so every existing bar moved
      // right by `added`. Shift the visible range by the same amount.
      if (range) {
        chart.timeScale().setVisibleLogicalRange({
          from: range.from + update.added,
          to: range.to + update.added,
        });
      }
    } else {
      // New symbol or timeframe: a price position dragged for the old data means nothing now.
      if (!this.verticalPan.isAutoScaled()) this.verticalPan.resetAutoScale();
      this.resetView();
    }
  }

  /** Flags on the price series, for example earnings. Re-snapped whenever bars change. */
  setMarkers(markers: readonly ChartMarker[]): void {
    if (!this.chart) return;
    this.markers = markers;
    this.writeMarkers();
  }

  dispose(): void {
    const chart = this.chart;
    if (!chart) return;
    this.chart = null;
    this.series = null;
    this.markersApi = null;
    this.alertLines = [];
    this.pricePrimitives.clear();
    this.verticalPan.dispose();
    chart.unsubscribeCrosshairMove(this.onCrosshair);
    chart.timeScale().unsubscribeVisibleLogicalRangeChange(this.onRange);
    chart.remove();
  }

  private resetView(): void {
    const chart = this.chart;
    if (!chart) return;
    const n = this.bars.length;
    if (n === 0) return;
    if (n > INITIAL_VISIBLE_BARS) {
      chart.timeScale().setVisibleLogicalRange({
        from: n - INITIAL_VISIBLE_BARS,
        to: n - 1 + RIGHT_PADDING_BARS,
      });
    } else {
      chart.timeScale().fitContent();
    }
  }

  private writeData(): void {
    const s = this.series;
    if (!s) return;
    switch (s.type) {
      case 'candlestick':
      case 'bar':
        s.api.setData(toCandles(this.bars));
        break;
      case 'line':
        s.api.setData(toCloseLine(this.bars));
        break;
    }
    // Bars or series changed, so the markers must snap again.
    this.writeMarkers();
  }

  private writeAlertLines(): void {
    const s = this.series;
    if (!s) return;
    for (const line of this.alertLines) s.api.removePriceLine(line);
    this.alertLines = this.alertLevels.map((price) =>
      s.api.createPriceLine({
        price,
        color: this.theme.accent,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: '🔔',
      }),
    );
  }

  private writeMarkers(): void {
    const s = this.series;
    if (!s) return;
    if (!this.markersApi) {
      // Nothing to draw and no plugin yet: do not attach one.
      if (this.markers.length === 0) return;
      this.markersApi = createSeriesMarkers(s.api as ISeriesApi<'Candlestick'>, []);
    }
    this.markersApi.setMarkers(
      snapMarkers(this.bars, this.markers).map((m) => ({
        time: m.barTime as UTCTimestamp,
        position: m.position ?? 'belowBar',
        shape: 'circle' as const,
        color: m.color ?? this.theme.accent,
        text: m.text,
        id: m.id,
      })),
    );
  }

  /** The theme-dependent chart options: used at creation and on a theme change. */
  private chartColors() {
    const t = this.theme;
    return {
      layout: { background: { type: ColorType.Solid, color: t.background }, textColor: t.text },
      grid: { vertLines: { color: t.grid }, horzLines: { color: t.grid } },
      rightPriceScale: { borderColor: t.border },
      timeScale: { borderColor: t.border },
    } as const;
  }

  /** The theme-dependent options of the price series of each type. */
  private seriesColors(type: ChartType) {
    const t = this.theme;
    switch (type) {
      case 'candlestick':
        return {
          upColor: t.up,
          downColor: t.down,
          borderUpColor: t.up,
          borderDownColor: t.down,
          wickUpColor: t.up,
          wickDownColor: t.down,
        };
      case 'line':
        return { color: t.accent };
      case 'bar':
        return { upColor: t.up, downColor: t.down };
    }
  }

  private addSeriesFor(chart: IChartApi, type: ChartType): ActiveSeries {
    switch (type) {
      case 'candlestick':
        return { type, api: chart.addSeries(CandlestickSeries, this.seriesColors(type)) };
      case 'line':
        return { type, api: chart.addSeries(LineSeries, { ...this.seriesColors(type), lineWidth: 2 }) };
      case 'bar':
        // OHLC bars as TradingView draws them: open tick left, close tick right.
        return { type, api: chart.addSeries(BarSeries, { ...this.seriesColors(type), openVisible: true, thinBars: false }) };
    }
  }
}
