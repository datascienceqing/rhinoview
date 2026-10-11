/**
 * The Confluence indicator as a lightweight-charts series primitive on the price series,
 * like Liquidity (docs/CONFLUENCE_PLAN.md, section 6).
 *
 * The math runs on ALL loaded bars, because the levels depend on history; the result is
 * memoized on the bars and the params. Each redraw paints the levels of the last bar and
 * the event marks in the visible logical range. x comes from
 * `timeScale().logicalToCoordinate`, y from the price series' `priceToCoordinate`. It gives
 * no autoscale info, so it never moves the price axis.
 *
 * Logical index i is bars[i]: the price series has one data point per bar
 * (src/chart/convert.ts), so bar indexes are logical indexes.
 */
import type {
  IChartApiBase,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  Logical,
  SeriesAttachedParameter,
  SeriesType,
  Time,
} from 'lightweight-charts';
import type { Bar, ConfluenceParams } from '@shared/types';
import { computeConfluence } from '../../indicators/confluence';
import type { ConfluenceResult } from '../../indicators/confluence';
import { t } from '../../i18n';
import { paintConfluence } from './paintConfluence';
import type { ConfluenceContext, ConfluenceDrawing, ConfluencePaintStyle } from './paintConfluence';

export interface ConfluenceStyle extends ConfluencePaintStyle {
  visible: boolean;
}

/** The part of fancy-canvas' CanvasRenderingTarget2D the renderer uses. */
interface MediaTarget {
  useMediaCoordinateSpace<T>(f: (scope: { context: ConfluenceContext; mediaSize: { width: number; height: number } }) => T): T;
}

export class ConfluencePrimitive implements ISeriesPrimitive<Time> {
  private chart: IChartApiBase<Time> | null = null;
  private series: ISeriesApi<SeriesType, Time> | null = null;
  private requestUpdate: (() => void) | null = null;
  private bars: readonly Bar[] = [];
  private memoBars: readonly Bar[] | null = null;
  private memoKey = '';
  private memo: ConfluenceResult | null = null;

  private readonly view: IPrimitivePaneView = {
    // Over the candles, so a level stays visible across a large bar.
    zOrder: () => 'top',
    renderer: () => this.renderer(),
  };

  constructor(
    private params: ConfluenceParams,
    private style: ConfluenceStyle,
  ) {}

  attached(param: SeriesAttachedParameter<Time>): void {
    this.chart = param.chart;
    this.series = param.series;
    this.requestUpdate = param.requestUpdate;
  }

  detached(): void {
    this.chart = null;
    this.series = null;
    this.requestUpdate = null;
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return [this.view];
  }

  /** New bars, params or style. Redraws. */
  update(bars: readonly Bar[], params: ConfluenceParams, style: ConfluenceStyle): void {
    this.bars = bars;
    this.params = params;
    this.style = style;
    this.requestUpdate?.();
  }

  /** Clusters, events and the latch of all loaded bars, memoized on the bars and the params. */
  result(): ConfluenceResult {
    const key = JSON.stringify(this.params);
    if (this.memo === null || this.bars !== this.memoBars || key !== this.memoKey) {
      this.memoBars = this.bars;
      this.memoKey = key;
      this.memo = computeConfluence(this.bars, this.params);
    }
    return this.memo;
  }

  /** What to draw now, or null (detached, no range, no bars). */
  drawing(): ConfluenceDrawing | null {
    const range = this.chart?.timeScale().getVisibleLogicalRange();
    const n = this.bars.length;
    if (!range || n === 0) return null;
    const { mode, events, last } = this.result();
    if (!last) return null;
    const from = Math.floor(range.from);
    const to = Math.ceil(range.to);
    const marks = events
      .filter((e) => e.index >= from && e.index <= to)
      .map((e) => {
        const b = this.bars[e.index] as Bar;
        return { index: e.index, high: b.high, low: b.low };
      });
    return {
      mode,
      sources: this.params.sources,
      state: last,
      close: (this.bars[n - 1] as Bar).close,
      startIndex: Math.max(0, n - 1 - this.params.swingLookback),
      marks,
    };
  }

  private renderer(): IPrimitivePaneRenderer | null {
    const chart = this.chart;
    const series = this.series;
    if (!chart || !series || !this.style.visible) return null;
    const drawing = this.drawing();
    if (!drawing) return null;
    const style = this.style;
    const timeScale = chart.timeScale();
    const xOf = (i: number): number | null => timeScale.logicalToCoordinate(i as Logical);
    const x0 = xOf(0);
    const x1 = xOf(1);
    const halfBar = x0 !== null && x1 !== null ? Math.abs(x1 - x0) / 2 : 0;
    const formatter = series.priceFormatter();
    // Read at draw time, so a language change shows on the next paint.
    const words = {
      trigger: t('confluence.trigger'),
      secondary: t('confluence.secondary'),
      invalidation: t('confluence.invalidation'),
      retest: t('confluence.retest'),
      latched: t('confluence.latched'),
    };
    return {
      draw: (target) => {
        (target as unknown as MediaTarget).useMediaCoordinateSpace(({ context, mediaSize }) =>
          paintConfluence(
            context,
            drawing,
            {
              xOf,
              yOf: (p) => series.priceToCoordinate(p),
              halfBar,
              width: mediaSize.width,
              formatPrice: (p) => formatter.format(p),
            },
            style,
            words,
          ),
        );
      },
    };
  }
}
