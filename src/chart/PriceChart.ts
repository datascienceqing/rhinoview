import {
  AreaSeries,
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  LineSeries,
  createChart,
} from 'lightweight-charts';
import type { IChartApi, ISeriesApi, MouseEventParams, Time } from 'lightweight-charts';
import type { Bar, ChartType } from '@shared/types';
import { classifyUpdate, toCandles, toCloseLine } from './convert';
import { readTheme, withAlpha } from './theme';
import type { ChartTheme } from './theme';
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
}

/** One live series, tagged so `setData` is checked against the right data shape. */
type ActiveSeries =
  | { type: 'candlestick'; api: ISeriesApi<'Candlestick'> }
  | { type: 'line'; api: ISeriesApi<'Line'> }
  | { type: 'area'; api: ISeriesApi<'Area'> };

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
  private bars: Bar[] = [];
  private intraday = false;
  private readonly theme: ChartTheme;

  private readonly onCrosshair = (param: MouseEventParams<Time>) => {
    const t = param.time;
    this.handlers.onCrosshairTime?.(typeof t === 'number' ? t : null);
  };

  private readonly onRange = (range: { from: number; to: number } | null) => {
    if (range && range.from < LOAD_OLDER_THRESHOLD_BARS) this.handlers.onNearStart?.();
  };

  constructor(
    container: HTMLElement,
    private readonly handlers: PriceChartHandlers = {},
  ) {
    this.theme = readTheme(container);
    const t = this.theme;
    this.chart = createChart(container, {
      // Resizes with its container via the library's own ResizeObserver.
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: t.background },
        textColor: t.text,
        // The on-chart logo is OFF, which the library permits only when the attribution
        // requirement is met another way. It is: see NOTICE at the repo root, and the
        // user-visible credit link rendered in the app footer. Do not remove either of
        // those — together they are what makes turning this off licence-compliant.
        attributionLogo: false,
      },
      grid: { vertLines: { color: t.grid }, horzLines: { color: t.grid } },
      rightPriceScale: { borderColor: t.border },
      timeScale: {
        borderColor: t.border,
        rightOffset: RIGHT_PADDING_BARS,
        tickMarkFormatter: (time: Time, type: number) => formatTick(time, type, this.intraday),
      },
      localization: { timeFormatter: (time: Time) => formatCrosshairTime(time, this.intraday) },
      crosshair: { mode: CrosshairMode.Normal },
    });
    // Pane 0 holds the price series, and `setChartType` removes that series before adding
    // its replacement. With indicator panes below, the library would delete the "empty"
    // pane 0 and the new series would land in an indicator's pane. Never let it.
    this.chart.panes()[0]?.setPreserveEmptyPane(true);
    this.chart.subscribeCrosshairMove(this.onCrosshair);
    this.chart.timeScale().subscribeVisibleLogicalRangeChange(this.onRange);
  }

  /** The underlying chart, for panes/indicators that add series at a pane index. Null once disposed. */
  get api(): IChartApi | null {
    return this.chart;
  }

  /** Resolved theme colours, for layers that draw on this chart (indicator panes). */
  get colors(): ChartTheme {
    return this.theme;
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
    if (this.series) chart.removeSeries(this.series.api);
    this.series = this.addSeriesFor(chart, type);
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
      this.resetView();
    }
  }

  dispose(): void {
    const chart = this.chart;
    if (!chart) return;
    this.chart = null;
    this.series = null;
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
        s.api.setData(toCandles(this.bars));
        break;
      case 'line':
      case 'area':
        s.api.setData(toCloseLine(this.bars));
        break;
    }
  }

  private addSeriesFor(chart: IChartApi, type: ChartType): ActiveSeries {
    const t = this.theme;
    switch (type) {
      case 'candlestick':
        return {
          type,
          api: chart.addSeries(CandlestickSeries, {
            upColor: t.up,
            downColor: t.down,
            borderUpColor: t.up,
            borderDownColor: t.down,
            wickUpColor: t.up,
            wickDownColor: t.down,
          }),
        };
      case 'line':
        return { type, api: chart.addSeries(LineSeries, { color: t.accent, lineWidth: 2 }) };
      case 'area':
        return {
          type,
          api: chart.addSeries(AreaSeries, {
            lineColor: t.accent,
            lineWidth: 2,
            topColor: withAlpha(t.accent, 0.4),
            bottomColor: withAlpha(t.accent, 0),
          }),
        };
    }
  }
}
