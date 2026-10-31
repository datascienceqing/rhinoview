/**
 * The zones of an AI analysis (FVGs and order blocks, docs/AI_HELPER_PLAN.md step C) as
 * bands across the whole price pane, under the candles. The server gives a zone a top and a
 * bottom, but no time range, so a band spans the full width. It gives no autoscale info, so
 * a far zone never squeezes the chart.
 */
import type { IPrimitivePaneRenderer, IPrimitivePaneView, ISeriesApi, ISeriesPrimitive, SeriesAttachedParameter, SeriesType, Time } from 'lightweight-charts';
import type { AiMarkZone } from '@shared/types';

export interface AiZoneStyle {
  demand: string;
  supply: string;
}

interface MediaScope {
  context: Pick<CanvasRenderingContext2D, 'fillStyle' | 'globalAlpha' | 'fillRect'>;
  mediaSize: { width: number; height: number };
}

interface MediaTarget {
  useMediaCoordinateSpace<T>(f: (scope: MediaScope) => T): T;
}

/** Fill opacity of a band: light, so the candles stay readable. */
export const ZONE_ALPHA = 0.1;

export class AiZonesPrimitive implements ISeriesPrimitive<Time> {
  private series: ISeriesApi<SeriesType, Time> | null = null;
  private requestUpdate: (() => void) | null = null;

  private readonly view: IPrimitivePaneView = {
    zOrder: () => 'bottom',
    renderer: (): IPrimitivePaneRenderer => ({
      draw: (target) => this.draw(target as unknown as MediaTarget),
    }),
  };

  constructor(
    private zones: readonly AiMarkZone[],
    private style: AiZoneStyle,
  ) {}

  attached(param: SeriesAttachedParameter<Time>): void {
    this.series = param.series;
    this.requestUpdate = param.requestUpdate;
  }

  detached(): void {
    this.series = null;
    this.requestUpdate = null;
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return [this.view];
  }

  update(zones: readonly AiMarkZone[], style: AiZoneStyle): void {
    this.zones = zones;
    this.style = style;
    this.requestUpdate?.();
  }

  /** The bands in pixels, top to bottom, for the zones on screen. */
  bands(): { y: number; height: number; role: AiMarkZone['role'] }[] {
    const s = this.series;
    if (!s) return [];
    const out: { y: number; height: number; role: AiMarkZone['role'] }[] = [];
    for (const z of this.zones) {
      const top = s.priceToCoordinate(z.top);
      const bottom = s.priceToCoordinate(z.bottom);
      if (top === null || bottom === null) continue;
      out.push({ y: Math.min(top, bottom), height: Math.max(1, Math.abs(bottom - top)), role: z.role });
    }
    return out;
  }

  private draw(target: MediaTarget): void {
    const bands = this.bands();
    if (bands.length === 0) return;
    target.useMediaCoordinateSpace(({ context, mediaSize }) => {
      context.globalAlpha = ZONE_ALPHA;
      for (const b of bands) {
        context.fillStyle = this.style[b.role];
        context.fillRect(0, b.y, mediaSize.width, b.height);
      }
      context.globalAlpha = 1;
    });
  }
}
