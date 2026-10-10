import type { IndicatorConfig } from '@shared/types';
import { PriceChart } from '../chart/PriceChart';
import { charts, fakeModule, lastChart, resetFakeCharts } from '../chart/testing/fakeLightweightCharts';
import type { FakeSeries } from '../chart/testing/fakeLightweightCharts';
import { IndicatorPanes } from './IndicatorPanes';
import type { PaneLayout } from './IndicatorPanes';
import { DEFAULT_PARAMS } from '../indicators/types';
import { MACD_SIGNAL_COLOR } from './config';
import { ComputeCache } from './computeCache';
import type { LiquidityPrimitive } from './liquidity/LiquidityPrimitive';
import type { VpvrPrimitive } from './vpvr/VpvrPrimitive';
import { fakeComputeIndicator } from './testing/fakeCompute';
import { indicator, makeBars } from './testing/testHelpers';

vi.mock('lightweight-charts', async () => (await import('../chart/testing/fakeLightweightCharts')).fakeModule);

const bars = makeBars(120);

function setup(onLayout?: (l: PaneLayout) => void) {
  const price = new PriceChart(document.createElement('div'));
  price.setChartType('candlestick');
  price.setBars(bars);
  const panes = new IndicatorPanes(price, onLayout);
  const chart = lastChart();
  // One cache across syncs, as in the app: unchanged params keep their series object.
  const cache = new ComputeCache(fakeComputeIndicator);
  const sync = (configs: IndicatorConfig[]) => panes.sync(cache.resolve(bars, configs));
  return { price, panes, chart, sync, cache };
}

const tags = (series: FakeSeries[]) => series.map((s) => (s.definition as { tag: string }).tag);

beforeEach(resetFakeCharts);

describe('overlay vs separate routing', () => {
  it('draws SMA and EMA on the price pane without creating a pane', () => {
    const { chart, sync } = setup();
    sync([indicator('sma'), indicator('ema')]);
    expect(chart.paneList).toHaveLength(1);
    expect(tags(chart.paneContents[0] ?? [])).toEqual(['Candlestick', 'Line', 'Line']);
  });

  it('puts RSI and MACD in their own panes below, one pane each', () => {
    const { chart, sync } = setup();
    sync([indicator('rsi'), indicator('macd')]);
    expect(chart.paneList).toHaveLength(3);
    expect(tags(chart.paneContents[0] ?? [])).toEqual(['Candlestick']);
    expect(tags(chart.paneContents[1] ?? [])).toEqual(['Line']);
    expect(tags(chart.paneContents[2] ?? [])).toEqual(['Line', 'Line', 'Histogram']);
  });

  it('routes a mixed set correctly regardless of add order', () => {
    const { chart, sync } = setup();
    sync([indicator('rsi'), indicator('sma'), indicator('macd'), indicator('ema')]);
    expect(chart.paneList).toHaveLength(3);
    expect(tags(chart.paneContents[0] ?? [])).toEqual(['Candlestick', 'Line', 'Line']);
  });

  it('uses the v5 addSeries(definition, options, paneIndex) API on the one chart (no second chart)', () => {
    const { chart, sync } = setup();
    sync([indicator('rsi')]);
    expect(charts).toHaveLength(1);
    const rsi = chart.paneContents[1]?.[0];
    expect(rsi?.definition).toBe(fakeModule.LineSeries);
    expect(rsi?.paneIndex).toBe(1);
  });
});

describe('adding and removing panes', () => {
  it('creates a pane when the first separate indicator is added and removes it with the last', () => {
    const { chart, sync } = setup();
    expect(chart.paneList).toHaveLength(1);
    const rsi = indicator('rsi');
    sync([rsi]);
    expect(chart.paneList).toHaveLength(2);
    sync([]);
    expect(chart.paneList).toHaveLength(1);
    expect(chart.paneContents[0]).toHaveLength(1); // price series survives
  });

  it('removes every series of a removed MACD, leaving no orphans and no pane', () => {
    const { chart, sync } = setup();
    sync([indicator('macd')]);
    const macdSeries = chart.liveSeries.filter((s) => s.pane.paneIndex() === 1);
    expect(macdSeries).toHaveLength(3);
    sync([]);
    expect(macdSeries.every((s) => s.removed)).toBe(true);
    expect(chart.paneList).toHaveLength(1);
    expect(chart.liveSeries).toHaveLength(1);
  });

  it('removes only the targeted pane and keeps the rest bound to the right indicators', () => {
    const { chart, sync } = setup();
    const rsi = indicator('rsi');
    const macd = indicator('macd');
    sync([rsi, macd]);
    // Remove the upper sub-pane: the MACD pane's index shifts from 2 to 1.
    sync([macd]);
    expect(chart.paneList).toHaveLength(2);
    expect(tags(chart.paneContents[1] ?? [])).toEqual(['Line', 'Line', 'Histogram']);
    // And a new RSI lands in a fresh pane at the bottom, not in MACD's.
    sync([macd, rsi]);
    expect(chart.paneList).toHaveLength(3);
    expect(tags(chart.paneContents[1] ?? [])).toEqual(['Line', 'Line', 'Histogram']);
    expect(tags(chart.paneContents[2] ?? [])).toEqual(['Line']);
  });

  it('never calls removePane: the library drops the empty pane itself, and a second removal would take an innocent one', () => {
    const { chart, sync } = setup();
    const removePane = vi.spyOn(chart, 'removePane');
    const a = indicator('rsi');
    const b = indicator('macd');
    sync([a, b]);
    sync([b]);
    sync([]);
    expect(removePane).not.toHaveBeenCalled();
    expect(chart.paneList).toHaveLength(1);
  });

  it('removing an overlay removes its series and leaves panes alone', () => {
    const { chart, sync } = setup();
    const sma = indicator('sma');
    const rsi = indicator('rsi');
    sync([sma, rsi]);
    sync([rsi]);
    expect(chart.paneList).toHaveLength(2);
    expect(tags(chart.paneContents[0] ?? [])).toEqual(['Candlestick']);
  });

  it('gives the price pane the larger share and each sub-pane an equal one', () => {
    const { chart, sync } = setup();
    sync([indicator('rsi'), indicator('macd')]);
    const [price, a, b] = chart.paneList;
    expect(price?.stretchFactor).toBeGreaterThan(a?.stretchFactor ?? Infinity);
    expect(a?.stretchFactor).toBe(b?.stretchFactor);
  });
});

describe('coexisting instances', () => {
  it('keeps two SMAs with different periods as two series with their own data', () => {
    const { chart, sync } = setup();
    const a = indicator('sma');
    const b = { ...indicator('sma', [a]), params: { period: 50, source: 'close' as const } };
    sync([a, b]);
    const lines = chart.paneContents[0]?.slice(1) ?? [];
    expect(lines).toHaveLength(2);
    const firstDefined = (s: FakeSeries) => {
      const data = s.setData.mock.calls.at(-1)?.[0] as { value?: number }[];
      return data.findIndex((d) => d.value !== undefined);
    };
    expect(lines.map(firstDefined)).toEqual([19, 49]);
  });

  it('removing one of two SMAs leaves the other drawing', () => {
    const { chart, sync } = setup();
    const a = indicator('sma');
    const b = indicator('sma', [a]);
    sync([a, b]);
    const [sa, sb] = chart.paneContents[0]?.slice(1) ?? [];
    sync([b]);
    expect(sa?.removed).toBe(true);
    expect(sb?.removed).toBe(false);
  });

  it('gives two RSIs a pane each', () => {
    const { chart, sync } = setup();
    const a = indicator('rsi');
    sync([a, indicator('rsi', [a])]);
    expect(chart.paneList).toHaveLength(3);
  });
});

describe('what each indicator draws', () => {
  it('draws MACD as macd and signal lines plus a sign-coloured histogram', () => {
    const { chart, sync } = setup();
    sync([indicator('macd')]);
    const [macd, signal, hist] = chart.paneContents[1] ?? [];
    expect(macd?.definition).toBe(fakeModule.LineSeries);
    expect(signal?.definition).toBe(fakeModule.LineSeries);
    expect(hist?.definition).toBe(fakeModule.HistogramSeries);
    expect((signal?.options as { color?: string }).color).toBe(MACD_SIGNAL_COLOR);

    const data = hist?.setData.mock.calls.at(-1)?.[0] as { value?: number; color?: string }[];
    const defined = data.filter((d) => d.value !== undefined);
    expect(defined.length).toBeGreaterThan(10);
    const colours = new Set(defined.map((d) => d.color));
    expect(colours.size).toBe(2); // both signs occur in the fixture
    for (const d of defined) {
      const isUp = (d.value ?? 0) >= 0;
      expect(d.color === data.find((x) => x.value !== undefined && (x.value >= 0) === isUp)?.color).toBe(true);
    }
  });

  it('shows RSI 30 and 70 reference lines and pins its scale to 0-100', () => {
    const { chart, sync } = setup();
    sync([indicator('rsi')]);
    const rsi = chart.paneContents[1]?.[0];
    expect(rsi?.priceLines.map((l) => l.options.price)).toEqual([30, 70]);
    const opts = rsi?.options as { autoscaleInfoProvider: () => { priceRange: { minValue: number; maxValue: number } } };
    expect(opts.autoscaleInfoProvider().priceRange).toEqual({ minValue: 0, maxValue: 100 });
  });

  it('puts no reference lines on other indicators', () => {
    const { chart, sync } = setup();
    sync([indicator('macd'), indicator('sma')]);
    expect(chart.liveSeries.every((s) => s.priceLines.length === 0)).toBe(true);
  });

  it('writes warmup as whitespace, never as a value', () => {
    const { chart, sync } = setup();
    sync([indicator('sma'), indicator('rsi'), indicator('macd')]);
    for (const s of chart.liveSeries.slice(1)) {
      const data = s.setData.mock.calls.at(-1)?.[0] as { time: number; value?: number }[];
      expect(data).toHaveLength(bars.length);
      expect(data[0] && 'value' in data[0]).toBe(false);
      expect(data.some((d) => d.value === 0)).toBe(false);
      expect(data.map((d) => d.time)).toEqual(bars.map((b) => b.time));
    }
  });
});

describe('updating without rebuilding', () => {
  it('writes new data only to the indicator whose params changed', () => {
    const { chart, sync } = setup();
    const a = indicator('sma');
    const b = indicator('sma', [a]);
    sync([a, b]);
    const [sa, sb] = chart.paneContents[0]?.slice(1) ?? [];
    sa?.setData.mockClear();
    sb?.setData.mockClear();
    sync([{ ...a, params: { period: 5, source: 'close' } }, b]);
    expect(sa?.setData).toHaveBeenCalledTimes(1);
    expect(sb?.setData).not.toHaveBeenCalled();
    expect(charts).toHaveLength(1);
    expect(chart.series.filter((s) => s.removed)).toHaveLength(0); // edited in place, not recreated
  });

  it('applies colour and visibility via options only, with no data rewrite', () => {
    const { chart, sync } = setup();
    const a = indicator('rsi');
    sync([a]);
    const s = chart.paneContents[1]?.[0];
    s?.setData.mockClear();
    sync([{ ...a, color: '#112233', visible: false }]);
    expect(s?.setData).not.toHaveBeenCalled();
    expect(s?.applyOptions).toHaveBeenLastCalledWith({ visible: false, color: '#112233' });
  });

  it('hides all three MACD lines but keeps the signal colour', () => {
    const { chart, sync } = setup();
    const m = indicator('macd');
    sync([m]);
    sync([{ ...m, visible: false, color: '#112233' }]);
    const [macd, signal, hist] = chart.paneContents[1] ?? [];
    expect(macd?.applyOptions).toHaveBeenLastCalledWith({ visible: false, color: '#112233' });
    expect(signal?.applyOptions).toHaveBeenLastCalledWith({ visible: false });
    expect(hist?.applyOptions).toHaveBeenLastCalledWith({ visible: false });
  });

  it('does nothing when synced again with identical input', () => {
    const { chart, sync } = setup();
    const configs = [indicator('sma'), indicator('macd')];
    sync(configs);
    chart.liveSeries.forEach((s) => s.setData.mockClear());
    sync(configs);
    expect(chart.liveSeries.every((s) => s.setData.mock.calls.length === 0)).toBe(true);
  });

  it('clears an indicator that loses its series (new symbol loading), keeping the pane', () => {
    const { chart, sync, panes } = setup();
    const rsi = indicator('rsi');
    sync([rsi]);
    panes.sync([{ config: rsi, series: null, error: null }]);
    const s = chart.paneContents[1]?.[0];
    expect(s?.setData).toHaveBeenLastCalledWith([]);
    expect(chart.paneList).toHaveLength(2);
  });
});

describe('price series and panes', () => {
  it('keeps the price series in pane 0 when the chart type is switched with a sub-pane open', () => {
    const { price, chart, sync } = setup();
    sync([indicator('rsi')]);
    price.setChartType('line');
    price.setChartType('area');
    expect(chart.paneList).toHaveLength(2);
    expect(tags(chart.paneContents[0] ?? [])).toEqual(['Area']);
    expect(tags(chart.paneContents[1] ?? [])).toEqual(['Line']);
  });
});

describe('layout reporting', () => {
  it('reports a top offset for each separate indicator and none for overlays', () => {
    const onLayout = vi.fn<(l: PaneLayout) => void>();
    const { sync } = setup(onLayout);
    const rsi = indicator('rsi');
    const sma = indicator('sma');
    sync([sma, rsi]);
    const layout = onLayout.mock.calls.at(-1)?.[0] ?? {};
    expect(Object.keys(layout)).toEqual([rsi.id]);
    expect(layout[rsi.id]).toEqual(expect.any(Number));
  });
});

describe('disposal', () => {
  it('turns sync and dispose into no-ops after the chart is removed (the fake throws on a removed chart)', () => {
    const { price, panes, chart, sync } = setup();
    sync([indicator('rsi'), indicator('sma')]);
    price.dispose();
    expect(chart.removed).toBe(true);
    expect(() => {
      sync([]);
      sync([indicator('macd')]);
      panes.dispose();
      panes.dispose();
    }).not.toThrow();
  });

  it('is inert after its own dispose, even with a live chart', () => {
    const { chart, panes, sync } = setup();
    sync([indicator('rsi')]);
    const before = chart.series.length;
    panes.dispose();
    sync([indicator('macd')]);
    expect(chart.series).toHaveLength(before);
    expect(panes.size).toBe(0);
  });

  it('can be disposed before the chart without touching it', () => {
    const { price, panes, chart, sync } = setup();
    sync([indicator('macd')]);
    const calls = chart.series.map((s) => s.setData.mock.calls.length);
    panes.dispose();
    price.dispose();
    expect(chart.series.map((s) => s.setData.mock.calls.length)).toEqual(calls);
  });
});

describe('volume', () => {
  /** Alternating candles: even bars close up, odd bars close down. */
  const mixed = makeBars(40).map((b, i) => (i % 2 === 0 ? b : { ...b, open: b.close + 0.5 }));

  function setupVolume(source = mixed) {
    const price = new PriceChart(document.createElement('div'));
    price.setChartType('candlestick');
    price.setBars(source);
    const panes = new IndicatorPanes(price);
    const chart = lastChart();
    const cache = new ComputeCache(fakeComputeIndicator);
    return { price, chart, sync: (configs: IndicatorConfig[]) => panes.sync(cache.resolve(source, configs)) };
  }

  it('draws on the price pane, with no new pane: a histogram plus its MA line', () => {
    const { chart, sync } = setupVolume();
    sync([indicator('volume')]);
    expect(chart.paneList).toHaveLength(1);
    expect(tags(chart.paneContents[0] ?? [])).toEqual(['Candlestick', 'Histogram', 'Line']);
  });

  it('uses its own scale in the bottom fifth of the pane, never the price scale', () => {
    const { chart, sync } = setupVolume();
    const config = indicator('volume');
    sync([config]);
    const [, hist, ma] = chart.paneContents[0] ?? [];
    const scaleId = `volume:${config.id}`;
    expect((hist?.options as { priceScaleId?: string }).priceScaleId).toBe(scaleId);
    expect((ma?.options as { priceScaleId?: string }).priceScaleId).toBe(scaleId);
    expect(chart.paneList[0]?.priceScale(scaleId).options().scaleMargins).toEqual({ top: 0.8, bottom: 0 });
    // The price axis is untouched, so vertical pan and auto-scale still act on prices only.
    expect(chart.paneList[0]?.priceScale('right').applyOptions).not.toHaveBeenCalled();
  });

  it('colours each bar by its candle, like TradingView: close at or above open is up', () => {
    const { price, chart, sync } = setupVolume();
    sync([indicator('volume')]);
    const hist = chart.paneContents[0]?.[1];
    const data = hist?.setData.mock.calls.at(-1)?.[0] as { time: number; value?: number; color?: string }[];
    expect(data.map((d) => d.value)).toEqual(mixed.map((b) => b.volume));
    const up = data[0]?.color;
    const down = data[1]?.color;
    expect(up).not.toBe(down);
    expect(up).toContain('rgba');
    data.forEach((d, i) => expect(d.color).toBe(i % 2 === 0 ? up : down));
    // Built from the chart's own theme colours.
    expect(price.colors.up).toBeTruthy();
  });

  it('a recolour moves only the MA line; the bars keep their candle colours', () => {
    const { chart, sync } = setupVolume();
    const config = indicator('volume');
    sync([config]);
    const [, hist, ma] = chart.paneContents[0] ?? [];
    sync([{ ...config, color: '#123456' }]);
    expect(ma?.applyOptions).toHaveBeenLastCalledWith(expect.objectContaining({ color: '#123456' }));
    expect(hist?.applyOptions).toHaveBeenLastCalledWith({ visible: true });
  });

  it('two volume indicators get two scales', () => {
    const { chart, sync } = setupVolume();
    const a = indicator('volume');
    const b = indicator('volume', [a]);
    sync([a, b]);
    const ids = (chart.paneContents[0] ?? []).slice(1).map((s) => (s.options as { priceScaleId?: string }).priceScaleId);
    expect(new Set(ids)).toEqual(new Set([`volume:${a.id}`, `volume:${b.id}`]));
  });
});

describe('vpvr', () => {
  const priceSeries = (chart: ReturnType<typeof setup>['chart']) => chart.paneContents[0]?.[0];

  it('adds no series and no pane: it is a drawing attached to the price series', () => {
    const { chart, sync } = setup();
    sync([indicator('vpvr')]);
    expect(chart.paneList).toHaveLength(1);
    expect(tags(chart.paneContents[0] ?? [])).toEqual(['Candlestick']);
    expect(priceSeries(chart)?.primitives).toHaveLength(1);
  });

  it('draws the visible bars with the indicator colour for up volume and the theme for the rest', () => {
    const { price, chart, sync } = setup();
    const config = indicator('vpvr');
    sync([config]);
    const prim = priceSeries(chart)?.primitives[0] as unknown as VpvrPrimitive;
    chart.visibleRange = { from: 100, to: 119 };
    const profile = prim.profile();
    expect(profile?.rows).toHaveLength(24);
    const visible = bars.slice(100, 120);
    expect(profile?.min).toBe(Math.min(...visible.map((b) => b.low)));
    const style = (prim as unknown as { style: { upColor: string; downColor: string; widthFrac: number } }).style;
    expect(style).toMatchObject({ upColor: config.color, downColor: price.colors.down, widthFrac: 0.3 });
  });

  it('detaches the drawing when the indicator is removed', () => {
    const { chart, sync } = setup();
    sync([indicator('vpvr')]);
    sync([]);
    expect(priceSeries(chart)?.primitives).toHaveLength(0);
  });

  it('keeps the drawing when the chart type changes: detached from the old series, attached to the new', () => {
    const { price, chart, sync } = setup();
    sync([indicator('vpvr')]);
    const old = priceSeries(chart);
    const prim = old?.primitives[0];
    price.setChartType('line');
    expect(old?.primitives).toHaveLength(0);
    const fresh = chart.liveSeries.find((s) => (s.definition as { tag: string }).tag === 'Line');
    expect(fresh?.primitives).toEqual([prim]);
  });

  it('passes new params, colour and visibility to the drawing', () => {
    const { chart, sync } = setup();
    const config = indicator('vpvr');
    sync([config]);
    const prim = priceSeries(chart)?.primitives[0] as unknown as VpvrPrimitive;
    const update = vi.spyOn(prim, 'update');
    sync([{ ...config, params: { rows: 50, widthPct: 40, valueAreaPct: 60 }, visible: false }]);
    expect(update).toHaveBeenLastCalledWith(bars, expect.objectContaining({ rows: 50, widthFrac: 0.4, valueAreaFrac: 0.6, visible: false }));
  });

  it('does not redraw when synced again with identical input', () => {
    const { chart, sync } = setup();
    const config = indicator('vpvr');
    sync([config]);
    const prim = priceSeries(chart)?.primitives[0] as unknown as VpvrPrimitive;
    const update = vi.spyOn(prim, 'update');
    sync([config]);
    expect(update).not.toHaveBeenCalled();
  });
});

describe('theme refresh', () => {
  // getComputedStyle reads nothing from a detached element, so the container is attached.
  const attached: HTMLElement[] = [];
  afterEach(() => attached.splice(0).forEach((el) => el.remove()));

  function setupOn(container: HTMLElement) {
    document.body.appendChild(container);
    attached.push(container);
    const price = new PriceChart(container);
    price.setChartType('candlestick');
    price.setBars(bars);
    const panes = new IndicatorPanes(price);
    const chart = lastChart();
    const cache = new ComputeCache(fakeComputeIndicator);
    return { price, panes, chart, sync: (configs: IndicatorConfig[]) => panes.sync(cache.resolve(bars, configs)) };
  }

  it('writes the histograms again in the new colours, and recolours the RSI guides', () => {
    const container = document.createElement('div');
    const { price, panes, chart, sync } = setupOn(container);
    sync([indicator('macd'), indicator('rsi')]);
    const hist = chart.liveSeries.find((s) => (s.definition as { tag: string }).tag === 'Histogram');
    const rsi = chart.paneContents[2]?.[0];
    const before = (hist?.setData.mock.calls.at(-1)?.[0] as { color?: string }[]).map((d) => d.color);

    container.style.setProperty('--up', '#00796b');
    container.style.setProperty('--down', '#cc2936');
    container.style.setProperty('--text', '#131722');
    expect(price.refreshTheme()).toBe(true);
    panes.refreshTheme();

    const after = (hist?.setData.mock.calls.at(-1)?.[0] as { color?: string }[]).map((d) => d.color);
    expect(after).not.toEqual(before);
    expect(new Set(after.filter(Boolean))).toEqual(new Set(['rgba(0, 121, 107, 0.7)', 'rgba(204, 41, 54, 0.7)']));
    expect(rsi?.priceLines.map((l) => l.options.color)).toEqual(['rgba(19, 23, 34, 0.5)', 'rgba(19, 23, 34, 0.5)']);
  });

  it('gives a drawing (VRVP) its new style', () => {
    const container = document.createElement('div');
    const { price, panes, chart, sync } = setupOn(container);
    sync([indicator('vpvr')]);
    const prim = chart.paneContents[0]?.[0]?.primitives[0] as unknown as VpvrPrimitive;
    const update = vi.spyOn(prim, 'update');
    container.style.setProperty('--down', '#cc2936');
    price.refreshTheme();
    panes.refreshTheme();
    expect(update).toHaveBeenLastCalledWith(bars, expect.objectContaining({ downColor: '#cc2936' }));
  });

  it('gives the Liquidity drawing its new style', () => {
    const container = document.createElement('div');
    const { price, panes, chart, sync } = setupOn(container);
    const config = indicator('liquidity');
    sync([config]);
    const prim = chart.paneContents[0]?.[0]?.primitives[0] as unknown as LiquidityPrimitive;
    const update = vi.spyOn(prim, 'update');
    container.style.setProperty('--up', '#00796b');
    container.style.setProperty('--down', '#cc2936');
    price.refreshTheme();
    panes.refreshTheme();
    expect(update).toHaveBeenLastCalledWith(bars, config.params, expect.objectContaining({ upColor: '#00796b', downColor: '#cc2936' }));
  });

  it('a refresh with no colour change writes the same colours', () => {
    const { panes, chart, sync } = setupOn(document.createElement('div'));
    sync([indicator('macd')]);
    const hist = chart.liveSeries.find((s) => (s.definition as { tag: string }).tag === 'Histogram');
    const before = hist?.setData.mock.calls.at(-1)?.[0];
    panes.refreshTheme();
    expect(hist?.setData.mock.calls.at(-1)?.[0]).toEqual(before);
  });
});
describe('liquidity', () => {
  const priceSeries = (chart: ReturnType<typeof setup>['chart']) => chart.paneContents[0]?.[0];
  const primOf = (chart: ReturnType<typeof setup>['chart']) => priceSeries(chart)?.primitives[0] as unknown as LiquidityPrimitive;
  const styleOf = (prim: LiquidityPrimitive) => (prim as unknown as { style: Record<string, unknown> }).style;

  it('adds no series and no pane: it is a drawing attached to the price series', () => {
    const { chart, sync } = setup();
    sync([indicator('liquidity')]);
    expect(chart.paneList).toHaveLength(1);
    expect(tags(chart.paneContents[0] ?? [])).toEqual(['Candlestick']);
    expect(priceSeries(chart)?.primitives).toHaveLength(1);
  });

  it('computes zones from the loaded bars, and uses the theme for zones and the indicator colour for levels', () => {
    const { price, chart, sync } = setup();
    const config = indicator('liquidity');
    sync([{ ...config, params: { ...DEFAULT_PARAMS.liquidity, lookback: 3 } }]);
    const prim = primOf(chart);
    expect(prim.result().zones.length).toBeGreaterThan(0);
    expect(styleOf(prim)).toMatchObject({ upColor: price.colors.up, downColor: price.colors.down, levelColor: config.color, visible: true });
  });

  it('detaches the drawing when the indicator is removed', () => {
    const { chart, sync } = setup();
    sync([indicator('liquidity')]);
    sync([]);
    expect(priceSeries(chart)?.primitives).toHaveLength(0);
  });

  it('keeps the drawing when the chart type changes: detached from the old series, attached to the new', () => {
    const { price, chart, sync } = setup();
    sync([indicator('liquidity')]);
    const old = priceSeries(chart);
    const prim = old?.primitives[0];
    price.setChartType('area');
    expect(old?.primitives).toHaveLength(0);
    const fresh = chart.liveSeries.find((s) => (s.definition as { tag: string }).tag === 'Area');
    expect(fresh?.primitives).toEqual([prim]);
    price.setChartType('candlestick');
    expect(fresh?.primitives).toHaveLength(0);
    expect(chart.liveSeries.find((s) => (s.definition as { tag: string }).tag === 'Candlestick')?.primitives).toEqual([prim]);
  });

  it('passes new params, colour and visibility to the drawing', () => {
    const { chart, sync } = setup();
    const config = indicator('liquidity');
    sync([config]);
    const prim = primOf(chart);
    const update = vi.spyOn(prim, 'update');
    const params = { ...DEFAULT_PARAMS.liquidity, lookback: 4, sweepMode: 'both' as const };
    sync([{ ...config, params, color: '#123456', visible: false }]);
    expect(update).toHaveBeenLastCalledWith(bars, params, expect.objectContaining({ levelColor: '#123456', visible: false }));
  });

  it('does not redraw when synced again with identical input', () => {
    const { chart, sync } = setup();
    const config = indicator('liquidity');
    sync([config]);
    const prim = primOf(chart);
    const update = vi.spyOn(prim, 'update');
    sync([config]);
    expect(update).not.toHaveBeenCalled();
  });

  it('lives next to a VPVR on the same price series; removing one keeps the other', () => {
    const { chart, sync } = setup();
    const liq = indicator('liquidity');
    const vpvr = indicator('vpvr');
    sync([liq, vpvr]);
    expect(priceSeries(chart)?.primitives).toHaveLength(2);
    sync([vpvr]);
    expect(priceSeries(chart)?.primitives).toHaveLength(1);
    expect(priceSeries(chart)?.primitives[0]).not.toBe(undefined);
  });
});

