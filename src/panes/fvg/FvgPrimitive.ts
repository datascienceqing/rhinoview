/**
 * The FVG indicator as a lightweight-charts series primitive on the price series, like the
 * Liquidity indicator.
 *
 * The math runs on ALL loaded bars, because a gap and its mitigation depend on history; the
 * result is memoized on the bars and the params. Each redraw paints only the gaps that
 * overlap the visible logical range. It gives no autoscale info, so it never moves the
 * price axis.
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
import type { Bar, FvgParams } from '@shared/types';
import { computeFvg } from '../../indicators/fvg';
import type { FvgResult, FvgZone } from '../../indicators/fvg';
import { paintFvg } from './paintFvg';
import type { FvgContext, FvgPaintStyle } from './paintFvg';

export interface FvgStyle extends Omit<FvgPaintStyle, 'labels'> {
  visible: boolean;
}

/** The part of fancy-canvas' CanvasRenderingTarget2D the renderer uses. */
interface MediaTarget {
  useMediaCoordinateSpace<T>(f: (scope: { context: FvgContext; mediaSize: { width: number; height: number } }) => T): T;
}

export class FvgPrimitive implements ISeriesPrimitive<Time> {
  private chart: IChartApiBase<Time> | null = null;
  private series: ISeriesApi<SeriesType, Time> | null = null;
  private requestUpdate: (() => void) | null = null;
  private bars: readonly Bar[] = [];
  private memoBars: readonly Bar[] | null = null;
  private memoKey = '';
  private memo: FvgResult | null = null;

  private readonly view: IPrimitivePaneView = {
    // Under the candles: a gap box is a background zone, and the bars that enter it stay readable.
    zOrder: () => 'bottom',
    renderer: () => this.renderer(),
  };

  constructor(
    private params: FvgParams,
    private style: FvgStyle,
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
  update(bars: readonly Bar[], params: FvgParams, style: FvgStyle): void {
    this.bars = bars;
    this.params = params;
    this.style = style;
    this.requestUpdate?.();
  }

  /** Gaps of all loaded bars, memoized on the bars and the params. */
  result(): FvgResult {
    const key = JSON.stringify(this.params);
    if (this.memo === null || this.bars !== this.memoBars || key !== this.memoKey) {
      this.memoBars = this.bars;
      this.memoKey = key;
      this.memo = computeFvg(this.bars, this.params);
    }
    return this.memo;
  }

  /** The gaps to draw now, or null (detached, no range, no bars). */
  visible(): FvgZone[] | null {
    const range = this.chart?.timeScale().getVisibleLogicalRange();
    if (!range || this.bars.length === 0) return null;
    const from = Math.floor(range.from);
    const to = Math.ceil(range.to);
    return this.result().zones.filter((z) => z.startIndex <= to && z.endIndex >= from);
  }

  private renderer(): IPrimitivePaneRenderer | null {
    const chart = this.chart;
    const series = this.series;
    if (!chart || !series || !this.style.visible) return null;
    const zones = this.visible();
    if (!zones || zones.length === 0) return null;
    const style: FvgPaintStyle = { ...this.style, labels: this.params.labels === 'on' };
    const timeScale = chart.timeScale();
    const xOf = (i: number): number | null => timeScale.logicalToCoordinate(i as Logical);
    const x0 = xOf(0);
    const x1 = xOf(1);
    const halfBar = x0 !== null && x1 !== null ? Math.abs(x1 - x0) / 2 : 0;
    const formatter = series.priceFormatter();
    return {
      draw: (target) => {
        (target as unknown as MediaTarget).useMediaCoordinateSpace(({ context }) =>
          paintFvg(context, zones, { xOf, yOf: (p) => series.priceToCoordinate(p), halfBar, formatPrice: (p) => formatter.format(p) }, style),
        );
      },
    };
  }
}
