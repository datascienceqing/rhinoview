import { HistogramSeries, LineSeries, LineStyle } from 'lightweight-charts';
import type { IChartApi, IPaneApi, IPriceLine, ISeriesApi, ISeriesPrimitive, Time } from 'lightweight-charts';
import type { Bar, ConfluenceParams, IndicatorConfig, IndicatorKind, IndicatorSeries, LiquidityParams, VpvrParams } from '@shared/types';
import { INDICATOR_PLACEMENT } from '@shared/types';
import { withAlpha } from '../chart/theme';
import type { ChartTheme } from '../chart/theme';
import { LINE_KEYS } from '../indicators/types';
import { MACD_SIGNAL_COLOR } from './config';
import { ConfluencePrimitive } from './confluence/ConfluencePrimitive';
import type { ConfluenceStyle } from './confluence/ConfluencePrimitive';
import { toHistogramData, toLineData, toVolumeData } from './convert';
import type { ComputedIndicator } from './computeCache';
import { LiquidityPrimitive } from './liquidity/LiquidityPrimitive';
import type { LiquidityStyle } from './liquidity/LiquidityPrimitive';
import { VpvrPrimitive } from './vpvr/VpvrPrimitive';
import type { VpvrStyle } from './vpvr/VpvrPrimitive';

/** What the layer needs from the chart that owns it. `api` is null once that chart is disposed. */
export interface ChartHost {
  readonly api: IChartApi | null;
  readonly colors: Pick<ChartTheme, 'up' | 'down' | 'text' | 'background'>;
  /** Drawings on the price series (volume profile, liquidity, confluence). The host keeps them across chart type changes. */
  attachPricePrimitive?(primitive: ISeriesPrimitive<Time>): void;
  detachPricePrimitive?(primitive: ISeriesPrimitive<Time>): void;
}

/** Top offset in px of each separate indicator's pane, relative to the chart container, by indicator id. */
export type PaneLayout = Record<string, number>;

/** Price pane : sub-pane height ratio. The library splits height by stretch factor (default 1 each). */
const PRICE_PANE_STRETCH = 3;
const SUB_PANE_STRETCH = 1;
const RSI_LEVELS = [30, 70] as const;
/**
 * Volume sits in the bottom part of the price pane, on its own hidden scale, like
 * TradingView: the top margin is the share of the pane height left above the bars.
 */
const VOLUME_SCALE_MARGINS = { top: 0.8, bottom: 0 } as const;
const VOLUME_ALPHA = 0.5;
/** Line keys drawn as histograms. */
const HISTOGRAM_KEYS: ReadonlySet<string> = new Set(['histogram', 'volume']);

type LineHandle = { type: 'line'; api: ISeriesApi<'Line'> } | { type: 'histogram'; api: ISeriesApi<'Histogram'> };

interface Entry {
  kind: IndicatorKind;
  lines: Map<string, LineHandle>;
  /** Pane of a `separate` indicator. Held by reference, never by index: indices shift when a pane below is removed. */
  pane: IPaneApi<Time> | null;
  /** The drawing of a VPVR, a Liquidity or a Confluence indicator, which have no series. */
  primitive: VpvrPrimitive | LiquidityPrimitive | ConfluencePrimitive | null;
  /** The bars last given to `primitive`. */
  bars: readonly Bar[] | undefined;
  /** RSI's 30/70 guides, kept so a theme change can recolour them. */
  priceLines: IPriceLine[];
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
  /** The items of the last sync, for a theme refresh. */
  private items: readonly ComputedIndicator[] = [];
  private observer: ResizeObserver | null = null;
  private frame: number | null = null;
  private disposed = false;

  constructor(
    private readonly host: ChartHost,
    private readonly onLayout?: (layout: PaneLayout) => void,
  ) {}

  /** The id of the separate indicator drawn in `pane`, or null (the price pane, or no indicator). */
  idAtPane(pane: IPaneApi<Time>): string | null {
    for (const [id, entry] of this.entries) if (entry.pane === pane) return id;
    return null;
  }

  /** Number of indicators currently drawn. */
  get size(): number {
    return this.entries.size;
  }

  sync(items: readonly ComputedIndicator[]): void {
    const chart = this.chart();
    if (!chart) return;
    this.items = items;

    const wanted = new Set(items.map((i) => i.config.id));
    for (const [id, entry] of this.entries) {
      if (wanted.has(id)) continue;
      for (const line of entry.lines.values()) chart.removeSeries(line.api);
      if (entry.primitive) this.host.detachPricePrimitive?.(entry.primitive);
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
    this.orderPanes(items);

    this.measureSoon();
  }

  /**
   * Put the separate panes in the order of `items`, below the price pane. A new pane opens
   * at the bottom, and a pane that already exists stays where it is, so a reorder of the
   * list must move the panes itself. Moving each one to its place from the top gives the
   * full order.
   */
  private orderPanes(items: readonly ComputedIndicator[]): void {
    let index = 1;
    for (const item of items) {
      const pane = this.entries.get(item.config.id)?.pane;
      if (!pane) continue;
      if (pane.paneIndex() !== index) pane.moveTo(index);
      index += 1;
    }
  }

  /**
   * The host's theme colours changed: write every indicator again with them. Histogram
   * bars carry their colour in the data, and the drawings carry it in their style, so a
   * changed option alone is not enough.
   */
  refreshTheme(): void {
    if (!this.chart()) return;
    for (const entry of this.entries.values()) {
      entry.written = undefined;
      entry.color = undefined;
      for (const line of entry.priceLines) line.applyOptions({ color: this.guideColor() });
    }
    for (const item of this.items) {
      const entry = this.entries.get(item.config.id);
      if (entry) this.update(entry, item);
    }
  }

  private guideColor(): string {
    return withAlpha(this.host.colors.text, 0.5);
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
      primitive: null,
      bars: undefined,
      priceLines: [],
      written: undefined,
      color: undefined,
      visible: undefined,
    };
    const separate = INDICATOR_PLACEMENT[config.kind] === 'separate';
    const addLine = (key: string, type: LineHandle['type']) => {
      const handle = this.addSeries(chart, entry, config, key, type, separate);
      entry.lines.set(key, handle);
    };
    for (const key of LINE_KEYS[config.kind]) {
      addLine(key, HISTOGRAM_KEYS.has(key) ? 'histogram' : 'line');
    }
    if (config.kind === 'vpvr') {
      entry.primitive = new VpvrPrimitive(this.vpvrStyle(config));
      this.host.attachPricePrimitive?.(entry.primitive);
    }
    if (config.kind === 'liquidity') {
      entry.primitive = new LiquidityPrimitive(config.params as LiquidityParams, this.liquidityStyle(config));
      this.host.attachPricePrimitive?.(entry.primitive);
    }
    if (config.kind === 'confluence') {
      entry.primitive = new ConfluencePrimitive(config.params as ConfluenceParams, this.confluenceStyle(config));
      this.host.attachPricePrimitive?.(entry.primitive);
    }
    if (config.kind === 'rsi') {
      const rsi = entry.lines.get('value');
      if (rsi?.type === 'line') {
        for (const price of RSI_LEVELS) {
          const line = rsi.api.createPriceLine({
            price,
            color: this.guideColor(),
            lineWidth: 1,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: true,
            title: '',
          });
          entry.priceLines.push(line);
        }
      }
    }
    return entry;
  }

  private addSeries(
    chart: IChartApi,
    entry: Entry,
    config: IndicatorConfig,
    key: string,
    type: LineHandle['type'],
    separate: boolean,
  ): LineHandle {
    // First series of a separate indicator opens a new pane at the bottom; the rest join it.
    const { kind } = config;
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
      // Own scale per volume indicator, so volume never stretches the price axis.
      ...(kind === 'volume' && { priceScaleId: `volume:${config.id}`, priceFormat: { type: 'volume' as const } }),
    };
    let handle: LineHandle;
    if (type === 'histogram') {
      handle = { type, api: chart.addSeries(HistogramSeries, { ...options, lastValueVisible: false }, paneIndex) };
      if (kind === 'volume') handle.api.priceScale().applyOptions({ scaleMargins: VOLUME_SCALE_MARGINS });
    } else {
      const color = key === 'signal' ? MACD_SIGNAL_COLOR : undefined;
      handle = {
        type,
        api: chart.addSeries(LineSeries, { ...options, lineWidth: kind === 'volume' ? 1 : 2, ...(color && { color }) }, paneIndex),
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

  private vpvrStyle(config: IndicatorConfig): VpvrStyle {
    const p = config.params as VpvrParams;
    return {
      rows: p.rows,
      widthFrac: p.widthPct / 100,
      valueAreaFrac: p.valueAreaPct / 100,
      upColor: config.color,
      downColor: this.host.colors.down,
      pocColor: this.host.colors.text,
      visible: config.visible,
    };
  }

  private liquidityStyle(config: IndicatorConfig): LiquidityStyle {
    const { up, down, text } = this.host.colors;
    return { upColor: up, downColor: down, levelColor: config.color, textColor: text, visible: config.visible };
  }

  /** D6: the up colour in mode "turn", the down colour in mode "breakdown"; the indicator colour for the sources. */
  private confluenceStyle(config: IndicatorConfig): ConfluenceStyle {
    const { up, down, text, background } = this.host.colors;
    const turn = (config.params as ConfluenceParams).mode === 'turn';
    return { modeColor: turn ? up : down, sourceColor: config.color, textColor: text, labelBackground: background, visible: config.visible };
  }

  private update(entry: Entry, item: ComputedIndicator): void {
    const { config, series, bars } = item;

    if (entry.primitive) {
      // Bars, params (they come with a new series), colour or visibility changed.
      if (entry.written !== series || entry.bars !== bars || entry.color !== config.color || entry.visible !== config.visible) {
        const drawn = series ? (bars ?? []) : [];
        if (entry.primitive instanceof LiquidityPrimitive) {
          entry.primitive.update(drawn, config.params as LiquidityParams, this.liquidityStyle(config));
        } else if (entry.primitive instanceof ConfluencePrimitive) {
          entry.primitive.update(drawn, config.params as ConfluenceParams, this.confluenceStyle(config));
        } else {
          entry.primitive.update(drawn, this.vpvrStyle(config));
        }
      }
      entry.bars = bars;
    }

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
        if (line.type === 'histogram' && key === 'volume') {
          line.api.setData(toVolumeData(points, bars, withAlpha(up, VOLUME_ALPHA), withAlpha(down, VOLUME_ALPHA)));
        } else if (line.type === 'histogram') line.api.setData(toHistogramData(points, upTint, downTint));
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
