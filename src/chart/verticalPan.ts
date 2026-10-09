/**
 * TradingView-style vertical panning for lightweight-charts.
 *
 * WHY THIS EXISTS. lightweight-charts already moves the price axis when the pane is
 * dragged, but only while that price scale is NOT auto-scaled: `startScrollPrice` and
 * `scrollPriceTo` return early when `isAutoScale()` is true (verified in the v5.2.1
 * source). Auto-scale is on by default, so a vertical drag did nothing.
 *
 * The scale cannot be switched off in the middle of a drag: the library records the
 * drag's start point only when the drag starts, and `scrollTo` does nothing without it.
 * So auto-scale is switched off on the PRESS, before the library sees any movement:
 *   - pointerdown in a pane (not on an axis): switch that pane's scale to manual;
 *   - pointerup: if the pointer moved less than VERTICAL_PAN_THRESHOLD_PX vertically,
 *     switch it back to auto. A click or a horizontal pan therefore keeps auto-scale,
 *     and only a real vertical drag leaves the axis where the user put it.
 * The way back is `resetAutoScale()` (the "Auto" button) or the library's own
 * double-click on the price axis.
 *
 * Mouse and pen only. Touch keeps the library's default gestures.
 */
import type { IChartApi, IPaneApi, Time } from 'lightweight-charts';

/** Vertical movement below this is jitter in a horizontal pan, not a vertical pan. */
export const VERTICAL_PAN_THRESHOLD_PX = 6;

const SCALE_ID = 'right';

interface Press {
  pointerId: number;
  startY: number;
  maxDy: number;
  pane: IPaneApi<Time>;
  /** The scale was auto-scaled before this press, so this press switched it off. */
  wasAuto: boolean;
}

export class VerticalPan {
  private press: Press | null = null;

  constructor(
    private readonly container: HTMLElement,
    private readonly chart: IChartApi,
    /** Called whenever the auto-scale state may have changed. */
    private readonly onChange: () => void,
  ) {
    // Capture phase, and pointerdown precedes the library's mousedown: the scale is
    // manual before the library starts its drag.
    container.addEventListener('pointerdown', this.onDown, true);
    // The library resets a price scale on an axis double-click; it runs first, then we report it.
    container.addEventListener('dblclick', this.onDoubleClick);
    // On window: the pointer often leaves the chart during a drag.
    window.addEventListener('pointermove', this.onMove, true);
    window.addEventListener('pointerup', this.onUp, true);
    window.addEventListener('pointercancel', this.onUp, true);
  }

  /** True when every pane's price scale fits its data automatically. */
  isAutoScaled(): boolean {
    return this.chart.panes().every((p) => p.priceScale(SCALE_ID).options().autoScale);
  }

  /** Fit every pane's price axis to its data again. */
  resetAutoScale(): void {
    for (const pane of this.chart.panes()) pane.priceScale(SCALE_ID).applyOptions({ autoScale: true });
    this.onChange();
  }

  dispose(): void {
    this.container.removeEventListener('pointerdown', this.onDown, true);
    this.container.removeEventListener('dblclick', this.onDoubleClick);
    window.removeEventListener('pointermove', this.onMove, true);
    window.removeEventListener('pointerup', this.onUp, true);
    window.removeEventListener('pointercancel', this.onUp, true);
    this.press = null;
  }

  /** The pane whose plot area (not its price axis) is under the point, if any. */
  private paneAt(x: number, y: number): IPaneApi<Time> | null {
    for (const pane of this.chart.panes()) {
      const el = pane.getHTMLElement();
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (y < r.top || y >= r.bottom) continue;
      const axisWidth = pane.priceScale(SCALE_ID).width();
      return x >= r.left && x < r.right - axisWidth ? pane : null;
    }
    return null;
  }

  private readonly onDown = (e: PointerEvent): void => {
    if (e.button !== 0 || e.pointerType === 'touch' || this.press) return;
    const pane = this.paneAt(e.clientX, e.clientY);
    if (!pane) return;
    const scale = pane.priceScale(SCALE_ID);
    const wasAuto = scale.options().autoScale;
    if (wasAuto) scale.applyOptions({ autoScale: false });
    this.press = { pointerId: e.pointerId, startY: e.clientY, maxDy: 0, pane, wasAuto };
  };

  private readonly onMove = (e: PointerEvent): void => {
    const p = this.press;
    if (!p || e.pointerId !== p.pointerId) return;
    p.maxDy = Math.max(p.maxDy, Math.abs(e.clientY - p.startY));
  };

  private readonly onUp = (e: PointerEvent): void => {
    const p = this.press;
    if (!p || e.pointerId !== p.pointerId) return;
    this.press = null;
    if (!p.wasAuto) return; // it was already manual; nothing of ours to undo
    if (p.maxDy < VERTICAL_PAN_THRESHOLD_PX) {
      try {
        p.pane.priceScale(SCALE_ID).applyOptions({ autoScale: true });
      } catch {
        // The pane was removed during the press (its indicator was deleted). Nothing to restore.
      }
    }
    this.onChange();
  };

  private readonly onDoubleClick = (): void => {
    this.onChange();
  };
}
