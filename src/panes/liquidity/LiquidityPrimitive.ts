/**
 * The Liquidity indicator as a lightweight-charts series primitive on the price series,
 * like the VPVR (docs/LIQUIDITY_PLAN.md, section 6).
 *
 * The math runs on ALL loaded bars, because a zone depends on history; the result is
 * memoized on the bars and the params. Each redraw paints only the zones and sweeps that
 * overlap the visible logical range. x comes from `timeScale().logicalToCoordinate`, y
 * from the price series' `priceToCoordinate`. It gives no autoscale info, so it never
 * moves the price axis.
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
import type { Bar, LiquidityParams } from '@shared/types';
import { computeLiquidity } from '../../indicators/liquidity';
import type { LiquidityResult, LiquiditySweep, LiquidityZone } from '../../indicators/liquidity';
import { paintLiquidity } from './paintLiquidity';
import type { LiquidityContext, LiquidityPaintStyle } from './paintLiquidity';

export interface LiquidityStyle extends LiquidityPaintStyle {
  visible: boolean;
}

/** The part of fancy-canvas' CanvasRenderingTarget2D the renderer uses. */
interface MediaTarget {
  useMediaCoordinateSpace<T>(f: (scope: { context: LiquidityContext; mediaSize: { width: number; height: number } }) => T): T;
}

/** The zones and sweeps that overlap the visible bars `[from, to]`. */
export interface VisibleLiquidity {
  zones: LiquidityZone[];
  sweeps: LiquiditySweep[];
}

export class LiquidityPrimitive implements ISeriesPrimitive<Time> {
  private chart: IChartApiBase<Time> | null = null;
  private series: ISeriesApi<SeriesType, Time> | null = null;
  private requestUpdate: (() => void) | null = null;
  private bars: readonly Bar[] = [];
  private memoBars: readonly Bar[] | null = null;
  private memoKey = '';
  private memo: LiquidityResult | null = null;

  private readonly view: IPrimitivePaneView = {
    // Over the candles, so a zone box does not hide behind a large bar.
    zOrder: () => 'top',
    renderer: () => this.renderer(),
  };

  constructor(
    private params: LiquidityParams,
    private style: LiquidityStyle,
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
  update(bars: readonly Bar[], params: LiquidityParams, style: LiquidityStyle): void {
    this.bars = bars;
    this.params = params;
    this.style = style;
    this.requestUpdate?.();
  }

  /** Zones and sweeps of all loaded bars, memoized on the bars and the params. */
  result(): LiquidityResult {
    const key = JSON.stringify(this.params);
    if (this.memo === null || this.bars !== this.memoBars || key !== this.memoKey) {
      this.memoBars = this.bars;
      this.memoKey = key;
      this.memo = computeLiquidity(this.bars, this.params);
    }
    return this.memo;
  }

  /** The items to draw now, or null (detached, no range, no bars). */
  visible(): VisibleLiquidity | null {
    const range = this.chart?.timeScale().getVisibleLogicalRange();
    const n = this.bars.length;
    if (!range || n === 0) return null;
    const from = Math.floor(range.from);
    const to = Math.ceil(range.to);
    const { zones, sweeps } = this.result();
    return {
      zones: zones.filter((z) => z.pivotIndex <= to && z.endIndex >= from),
      sweeps: sweeps.filter((s) => s.index <= to && s.endIndex >= from),
    };
  }

  private renderer(): IPrimitivePaneRenderer | null {
    const chart = this.chart;
    const series = this.series;
    if (!chart || !series || !this.style.visible) return null;
    const items = this.visible();
    if (!items || (items.zones.length === 0 && items.sweeps.length === 0)) return null;
    const style = this.style;
    const timeScale = chart.timeScale();
    const xOf = (i: number): number | null => timeScale.logicalToCoordinate(i as Logical);
    const x0 = xOf(0);
    const x1 = xOf(1);
    const halfBar = x0 !== null && x1 !== null ? Math.abs(x1 - x0) / 2 : 0;
    return {
      draw: (target) => {
        (target as unknown as MediaTarget).useMediaCoordinateSpace(({ context }) =>
          paintLiquidity(context, items.zones, items.sweeps, { xOf, yOf: (p) => series.priceToCoordinate(p), halfBar }, style),
        );
      },
    };
  }
}
