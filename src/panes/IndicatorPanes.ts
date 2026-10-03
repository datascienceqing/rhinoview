import { HistogramSeries, LineSeries, LineStyle } from 'lightweight-charts';
import type { IChartApi, IPaneApi, ISeriesApi, Time } from 'lightweight-charts';
import type { IndicatorConfig, IndicatorKind, IndicatorSeries } from '@shared/types';
import { INDICATOR_PLACEMENT } from '@shared/types';
import { withAlpha } from '../chart/theme';
import type { ChartTheme } from '../chart/theme';
import { LINE_KEYS } from '../indicators/types';
import { MACD_SIGNAL_COLOR } from './config';
import { toHistogramData, toLineData } from './convert';
import type { ComputedIndicator } from './computeCache';

/** What the layer needs from the chart that owns it. `api` is null once that chart is disposed. */
export interface ChartHost {
  readonly api: IChartApi | null;
  readonly colors: Pick<ChartTheme, 'up' | 'down' | 'text'>;
}

/** Top offset in px of each separate indicator's pane, relative to the chart container, by indicator id. */
export type PaneLayout = Record<string, number>;

/** Price pane : sub-pane height ratio. The library splits height by stretch factor (default 1 each). */
const PRICE_PANE_STRETCH = 3;
const SUB_PANE_STRETCH = 1;
const RSI_LEVELS = [30, 70] as const;

type LineHandle = { type: 'line'; api: ISeriesApi<'Line'> } | { type: 'histogram'; api: ISeriesApi<'Histogram'> };

interface Entry {
  kind: IndicatorKind;
  lines: Map<string, LineHandle>;
  /** Pane of a `separate` indicator. Held by reference, never by index: indices shift when a pane below is removed. */
  pane: IPaneApi<Time> | null;
  /** The series last written to the lines; `undefined` = never written. Identity is the "did it change" test. */
  written: IndicatorSeries | null | undefined;
  color: string | undefined;
  visible: boolean | undefined;
}

/**
 * Draws indicators onto a chart using lightweight-charts v5's native panes: `overlay`
 * indicators go on pane 0 with the price series; each `separate` indicator gets its own
 * pane. All panes share the chart's one time scale, so pan and zoom move together with
 * no synchronisation code here.
 *
 * `sync` is declarative: pass the full desired list and it adds, updates and removes by
 * `config.id`, touching only what changed. Like `PriceChart`, every method is a no-op
 * once the chart is gone, because series APIs throw on a disposed chart.
 *
 * Pane lifecycle is the library's: removing a pane's last series removes the pane
 * (`_cleanupIfPaneIsEmpty`), so this class removes series and never calls `removePane`.
 * Calling it as well would remove a second, innocent pane.
 */
export class IndicatorPanes {
  private readonly entries = new Map<string, Entry>();
  private observer: ResizeObserver | null = null;
  private frame: number | null = null;
  private disposed = false;

  constructor(
    private readonly host: ChartHost,
    private readonly onLayout?: (layout: PaneLayout) => void,
  ) {}

  /** Number of indicators currently drawn. */
  get size(): number {
    return this.entries.size;
  }

  sync(items: readonly ComputedIndicator[]): void {
    const chart = this.chart();
    if (!chart) return;

    const wanted = new Set(items.map((i) => i.config.id));
    for (const [id, entry] of this.entries) {
      if (wanted.has(id)) continue;
      for (const line of entry.lines.values()) chart.removeSeries(line.api);
      this.entries.delete(id);
    }

    for (const item of items) {
      const { config } = item;
      let entry = this.entries.get(config.id);
      if (!entry) {
        entry = this.create(chart, config);
        this.entries.set(config.id, entry);
      }
      this.update(entry, item);
    }

    this.measureSoon();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.observer?.disconnect();
    this.observer = null;
    if (this.frame !== null && typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(this.frame);
    this.frame = null;
    // Series and panes belong to the chart, which is removed by its owner; touching them here could throw.
    this.entries.clear();
  }

  private chart(): IChartApi | null {
    return this.disposed ? null : this.host.api;
  }

  // ───────────── create ─────────────

  private create(chart: IChartApi, config: IndicatorConfig): Entry {
    const entry: Entry = {
      kind: config.kind,
      lines: new Map(),
      pane: null,
      written: undefined,
      color: undefined,
      visible: undefined,
    };
    const separate = INDICATOR_PLACEMENT[config.kind] === 'separate';
    const addLine = (key: string, type: LineHandle['type']) => {
      const handle = this.addSeries(chart, entry, config.kind, key, type, separate);
      entry.lines.set(key, handle);
    };
    for (const key of LINE_KEYS[config.kind]) {
      addLine(key, key === 'histogram' ? 'histogram' : 'line');
    }
    if (config.kind === 'rsi') {
      const rsi = entry.lines.get('value');
      if (rsi?.type === 'line') {
        for (const price of RSI_LEVELS) {
          rsi.api.createPriceLine({
            price,
            color: withAlpha(this.host.colors.text, 0.5),
            lineWidth: 1,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: true,
            title: '',
          });
        }
      }
    }
    return entry;
  }

  private addSeries(
    chart: IChartApi,
    entry: Entry,
    kind: IndicatorKind,
    key: string,
    type: LineHandle['type'],
    separate: boolean,
  ): LineHandle {
    // First series of a separate indicator opens a new pane at the bottom; the rest join it.
    const paneIndex = !separate ? 0 : entry.pane ? entry.pane.paneIndex() : chart.panes().length;
    const options = {
      priceLineVisible: false,
      lastValueVisible: separate,
      ...(kind === 'rsi' && {
        // Fixed scale so the 30/70 guides sit at the same heights regardless of the data.
        autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } }),
        priceFormat: { type: 'price' as const, precision: 2, minMove: 0.01 },
      }),
      ...(kind === 'macd' && { priceFormat: { type: 'price' as const, precision: 3, minMove: 0.001 } }),
    };
    let handle: LineHandle;
    if (type === 'histogram') {
      handle = { type, api: chart.addSeries(HistogramSeries, { ...options, lastValueVisible: false }, paneIndex) };
    } else {
      const color = key === 'signal' ? MACD_SIGNAL_COLOR : undefined;
      handle = {
        type,
        api: chart.addSeries(LineSeries, { ...options, lineWidth: 2, ...(color && { color }) }, paneIndex),
      };
    }
    if (separate && !entry.pane) {
      entry.pane = handle.api.getPane();
      entry.pane.setStretchFactor(SUB_PANE_STRETCH);
      // Pane 0 is created by the chart itself; give it the larger share once there is anything to share with.
      chart.panes()[0]?.setStretchFactor(PRICE_PANE_STRETCH);
    }
    return handle;
  }

  // ───────────── update ─────────────

  private update(entry: Entry, item: ComputedIndicator): void {
    const { config, series } = item;

    if (entry.color !== config.color || entry.visible !== config.visible) {
      for (const [key, line] of entry.lines) {
        if (line.type === 'line') {
          line.api.applyOptions({
            visible: config.visible,
            // MACD's signal line keeps its own colour; only the primary line follows the config.
            ...(key !== 'signal' && { color: config.color }),
          });
        } else {
          line.api.applyOptions({ visible: config.visible });
        }
      }
      entry.color = config.color;
      entry.visible = config.visible;
    }

    if (entry.written !== series) {
      const { up, down } = this.host.colors;
      const upTint = withAlpha(up, 0.7);
      const downTint = withAlpha(down, 0.7);
      for (const [key, line] of entry.lines) {
        const points = series?.lines.find((l) => l.key === key)?.points ?? [];
        if (line.type === 'histogram') line.api.setData(toHistogramData(points, upTint, downTint));
        else line.api.setData(toLineData(points));
      }
      entry.written = series;
    }
  }

  // ───────────── layout ─────────────

  /**
   * Pane geometry is only known after the library lays out (a frame later) and changes
   * when panes are added, removed, or dragged by their separator, so legends are placed
   * from measurements taken here rather than computed.
   */
  private measureSoon(): void {
    this.measure();
    if (typeof requestAnimationFrame === 'undefined' || this.frame !== null) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.measure();
    });
  }

  private measure(): void {
    if (!this.onLayout || !this.chart()) return;
    const origin = this.chart()?.chartElement().getBoundingClientRect().top ?? 0;
    const layout: PaneLayout = {};
    for (const [id, entry] of this.entries) {
      const el = entry.pane?.getHTMLElement();
      if (!el) continue;
      layout[id] = el.getBoundingClientRect().top - origin;
      this.observe(el);
    }
    this.onLayout(layout);
  }

  private observe(el: HTMLElement): void {
    if (typeof ResizeObserver === 'undefined') return;
    this.observer ??= new ResizeObserver(() => this.measure());
    this.observer.observe(el); // idempotent per element
  }
}
