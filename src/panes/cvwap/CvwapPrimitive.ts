/**
 * The Chart VWAP as a lightweight-charts series primitive on the price series, like VPVR.
 *
 * Its anchor is the leftmost visible bar, so on each redraw it reads the visible logical
 * range, computes the VWAP of the visible bars (memoized on that window) and paints it.
 * It gives no autoscale info, so it never moves the price axis.
 *
 * Logical index i is bars[i]: the price series has one data point per bar
 * (src/chart/convert.ts), so the visible logical range indexes the bars directly.
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
import type { Bar, CvwapParams } from '@shared/types';
import { computeCvwap } from '../../indicators/cvwap';
import type { CvwapResult } from '../../indicators/cvwap';
import { paintCvwap } from './paintCvwap';
import type { CvwapContext, CvwapPaintStyle } from './paintCvwap';

export type CvwapStyle = Omit<CvwapPaintStyle, 'bands' | 'average' | 'ohlc' | 'ohlcLabels'> & { visible: boolean };

/** The part of fancy-canvas' CanvasRenderingTarget2D the renderer uses. */
interface MediaTarget {
  useMediaCoordinateSpace<T>(f: (scope: { context: CvwapContext; mediaSize: { width: number; height: number } }) => T): T;
}

export class CvwapPrimitive implements ISeriesPrimitive<Time> {
  private chart: IChartApiBase<Time> | null = null;
  private series: ISeriesApi<SeriesType, Time> | null = null;
  private requestUpdate: (() => void) | null = null;
  private bars: readonly Bar[] = [];
  private memoKey = '';
  private memoBars: readonly Bar[] | null = null;
  private memo: CvwapResult | null = null;

  private readonly view: IPrimitivePaneView = {
    // Over the candles, like a Pine plot.
    zOrder: () => 'top',
    renderer: () => this.renderer(),
  };

  constructor(
    private params: CvwapParams,
    private style: CvwapStyle,
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
  update(bars: readonly Bar[], params: CvwapParams, style: CvwapStyle): void {
    this.bars = bars;
    this.params = params;
    this.style = style;
    this.requestUpdate?.();
  }

  /** The Chart VWAP of the visible bars, or null (detached, no range, no bars). */
  result(): CvwapResult | null {
    const range = this.chart?.timeScale().getVisibleLogicalRange();
    const n = this.bars.length;
    if (!range || n === 0) return null;
    const i0 = Math.max(0, Math.floor(range.from));
    const i1 = Math.min(n - 1, Math.ceil(range.to));
    if (i0 > i1) return null;
    const key = `${i0}:${i1}:${this.params.bandMult}`;
    if (key !== this.memoKey || this.bars !== this.memoBars) {
      this.memoKey = key;
      this.memoBars = this.bars;
      this.memo = computeCvwap(this.bars, i0, i1, this.params.bandMult);
    }
    return this.memo;
  }

  private renderer(): IPrimitivePaneRenderer | null {
    const chart = this.chart;
    const series = this.series;
    if (!chart || !series || !this.style.visible) return null;
    const result = this.result();
    if (!result) return null;
    const { params, style: s } = this;
    const style: CvwapPaintStyle = {
      vwapColor: s.vwapColor,
      bandColor: s.bandColor,
      averageColor: s.averageColor,
      highColor: s.highColor,
      lowColor: s.lowColor,
      levelColor: s.levelColor,
      bands: params.bandMult > 0,
      average: params.average === 'on',
      ohlc: params.ohlc === 'on',
      ohlcLabels: params.ohlcLabels === 'on',
    };
    const timeScale = chart.timeScale();
    const formatter = series.priceFormatter();
    return {
      draw: (target) => {
        (target as unknown as MediaTarget).useMediaCoordinateSpace(({ context, mediaSize }) =>
          paintCvwap(
            context,
            result,
            {
              xOf: (i) => timeScale.logicalToCoordinate(i as Logical),
              yOf: (p) => series.priceToCoordinate(p),
              rightX: mediaSize.width,
              formatPrice: (p) => formatter.format(p),
            },
            style,
          ),
        );
      },
    };
  }
}
