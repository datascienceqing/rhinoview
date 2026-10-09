/**
 * The VPVR as a lightweight-charts series primitive, attached to the price series.
 *
 * On each redraw it reads the visible logical range, buckets the visible bars by price
 * (memoized on that window) and paints the rows from the right edge of the pane. Row
 * y-positions use the price series' own scale; row widths are fractions of the pane
 * width. It gives no autoscale info, so it never moves the price axis.
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
  SeriesAttachedParameter,
  SeriesType,
  Time,
} from 'lightweight-charts';
import type { Bar } from '@shared/types';
import { buildVpvrProfile } from '../../indicators/vpvr';
import type { VpvrProfile } from '../../indicators/vpvr';
import { paintVpvr } from './paintVpvr';
import type { PaintContext } from './paintVpvr';

export interface VpvrStyle {
  rows: number;
  /** Share of the pane width the largest row takes, 0..1. */
  widthFrac: number;
  /** Share of the volume the value area covers, 0..1. */
  valueAreaFrac: number;
  upColor: string;
  downColor: string;
  pocColor: string;
  visible: boolean;
}

/** The part of fancy-canvas' CanvasRenderingTarget2D the renderer uses. */
interface MediaTarget {
  useMediaCoordinateSpace<T>(f: (scope: { context: PaintContext; mediaSize: { width: number; height: number } }) => T): T;
}

export class VpvrPrimitive implements ISeriesPrimitive<Time> {
  private chart: IChartApiBase<Time> | null = null;
  private series: ISeriesApi<SeriesType, Time> | null = null;
  private requestUpdate: (() => void) | null = null;
  private bars: readonly Bar[] = [];
  private memoKey = '';
  private memoBars: readonly Bar[] | null = null;
  private memo: VpvrProfile | null = null;

  private readonly view: IPrimitivePaneView = {
    // Over the candles, like TradingView's profile.
    zOrder: () => 'top',
    renderer: () => this.renderer(),
  };

  constructor(private style: VpvrStyle) {}

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

  /** New bars or style. Redraws. */
  update(bars: readonly Bar[], style: VpvrStyle): void {
    this.bars = bars;
    this.style = style;
    this.requestUpdate?.();
  }

  /** The profile of the visible bars, or null (detached, no range, no volume). */
  profile(): VpvrProfile | null {
    const range = this.chart?.timeScale().getVisibleLogicalRange();
    const n = this.bars.length;
    if (!range || n === 0) return null;
    const i0 = Math.max(0, Math.floor(range.from));
    const i1 = Math.min(n - 1, Math.ceil(range.to));
    if (i0 > i1) return null;
    const { rows, valueAreaFrac } = this.style;
    const key = `${i0}:${i1}:${rows}:${valueAreaFrac}`;
    if (key !== this.memoKey || this.bars !== this.memoBars) {
      this.memoKey = key;
      this.memoBars = this.bars;
      this.memo = buildVpvrProfile(this.bars, i0, i1, rows, valueAreaFrac);
    }
    return this.memo;
  }

  private renderer(): IPrimitivePaneRenderer | null {
    const series = this.series;
    if (!series || !this.style.visible) return null;
    const profile = this.profile();
    if (!profile) return null;
    const style = this.style;
    return {
      draw: (target) => {
        (target as unknown as MediaTarget).useMediaCoordinateSpace(({ context, mediaSize }) =>
          paintVpvr(
            context,
            profile,
            { rightX: mediaSize.width, maxW: mediaSize.width * style.widthFrac, yOf: (p) => series.priceToCoordinate(p) },
            { upColor: style.upColor, downColor: style.downColor, showPoc: true, pocColor: style.pocColor },
          ),
        );
      },
    };
  }
}
