/**
 * The drawing tools as one lightweight-charts series primitive on the price series. The
 * React layer (DrawingTools.tsx) owns the drawings and gives a new scene on each change.
 * It gives no autoscale info, so a drawing never moves the price axis.
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
import { paintDrawings } from './paintDrawings';
import type { DrawContext, DrawScene, DrawStyle } from './paintDrawings';

/** The part of fancy-canvas' CanvasRenderingTarget2D the renderer uses. */
interface MediaTarget {
  useMediaCoordinateSpace<T>(f: (scope: { context: DrawContext }) => T): T;
}

const EMPTY: DrawScene = { fibs: [], measure: null };

export class DrawingsPrimitive implements ISeriesPrimitive<Time> {
  private chart: IChartApiBase<Time> | null = null;
  private series: ISeriesApi<SeriesType, Time> | null = null;
  private requestUpdate: (() => void) | null = null;
  private scene: DrawScene = EMPTY;

  private readonly view: IPrimitivePaneView = {
    // Over the candles, as in TradingView: a drawing is a tool the user is looking at.
    zOrder: () => 'top',
    renderer: () => this.renderer(),
  };

  constructor(private style: DrawStyle) {}

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

  update(scene: DrawScene, style: DrawStyle): void {
    this.scene = scene;
    this.style = style;
    this.requestUpdate?.();
  }

  private renderer(): IPrimitivePaneRenderer | null {
    const chart = this.chart;
    const series = this.series;
    const scene = this.scene;
    if (!chart || !series || (scene.fibs.length === 0 && !scene.measure)) return null;
    const timeScale = chart.timeScale();
    const formatter = series.priceFormatter();
    const style = this.style;
    return {
      draw: (target) => {
        (target as unknown as MediaTarget).useMediaCoordinateSpace(({ context }) =>
          paintDrawings(
            context,
            scene,
            {
              xOf: (i) => timeScale.logicalToCoordinate(i as Logical),
              yOf: (p) => series.priceToCoordinate(p),
              formatPrice: (p) => formatter.format(p),
            },
            style,
          ),
        );
      },
    };
  }
}
