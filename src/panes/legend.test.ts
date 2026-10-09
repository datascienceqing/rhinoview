import { buildIndicatorLegend, findPointIndex, formatIndicatorValue } from './legend';
import { computeAll, indicator, makeBars } from './testing/testHelpers';

const bars = makeBars(80);

describe('formatIndicatorValue', () => {
  it('shows a dash for null instead of 0', () => {
    expect(formatIndicatorValue('sma', null)).toBe('—');
    expect(formatIndicatorValue('rsi', Number.NaN)).toBe('—');
  });
  it('uses 2 decimals for averages and RSI', () => {
    expect(formatIndicatorValue('sma', 101.456)).toBe('101.46');
    expect(formatIndicatorValue('rsi', 63.2178)).toBe('63.22');
  });
  it('shows volume compactly, like the OHLCV legend', () => {
    expect(formatIndicatorValue('volume', 7_720_000)).toBe('7.72M');
    expect(formatIndicatorValue('volume', 512)).toBe('512');
  });
  it('gives small MACD values more precision than large ones', () => {
    expect(formatIndicatorValue('macd', 0.01234)).toBe('0.0123');
    expect(formatIndicatorValue('macd', -1.2345)).toBe('-1.23');
  });
});

describe('findPointIndex', () => {
  it('finds exact times and returns -1 otherwise', () => {
    const pts = bars.map((b) => ({ time: b.time, value: 1 }));
    expect(findPointIndex(pts, bars[10]?.time ?? 0)).toBe(10);
    expect(findPointIndex(pts, 5)).toBe(-1);
    expect(findPointIndex([], 5)).toBe(-1);
  });
});

describe('buildIndicatorLegend', () => {
  const rsi = indicator('rsi');
  const [rsiItem, macdItem, smaItem] = computeAll(bars, [rsi, indicator('macd'), indicator('sma')]);
  if (!rsiItem || !macdItem || !smaItem) throw new Error('setup');
  const rsiValues = rsiItem.series?.lines[0]?.points ?? [];

  it('shows the value at the hovered bar', () => {
    const t = bars[40]?.time ?? 0;
    const model = buildIndicatorLegend(rsiItem, t);
    expect(model.lines[0]?.value).toBe(rsiValues[40]?.value);
    expect(model.lines[0]?.text).toBe((rsiValues[40]?.value ?? NaN).toFixed(2));
  });

  it('falls back to the latest bar when the crosshair is off the chart', () => {
    const model = buildIndicatorLegend(rsiItem, null);
    expect(model.lines[0]?.value).toBe(rsiValues.at(-1)?.value);
  });

  it('falls back to the latest bar for a time that has no bar', () => {
    expect(buildIndicatorLegend(rsiItem, 12345).lines[0]?.value).toBe(rsiValues.at(-1)?.value);
  });

  it('shows a dash, not 0, when hovering a warmup bar', () => {
    const model = buildIndicatorLegend(rsiItem, bars[3]?.time ?? 0);
    expect(model.lines[0]?.value).toBeNull();
    expect(model.lines[0]?.text).toBe('—');
  });

  it('lists all three MACD lines, signing the histogram', () => {
    const model = buildIndicatorLegend(macdItem, null);
    expect(model.lines.map((l) => l.key)).toEqual(['macd', 'signal', 'histogram']);
    const hist = model.lines[2];
    expect(hist?.tone).toBe((hist?.value ?? 0) >= 0 ? 'up' : 'down');
  });

  it('tags overlay vs separate by placement and titles by params', () => {
    expect(buildIndicatorLegend(smaItem, null)).toMatchObject({ placement: 'overlay', title: 'SMA (20)' });
    expect(buildIndicatorLegend(rsiItem, null)).toMatchObject({ placement: 'separate', title: 'RSI (14)' });
  });

  it('has no lines while there is no series, and carries the error', () => {
    const model = buildIndicatorLegend({ config: rsi, series: null, error: 'boom' }, null);
    expect(model.lines).toEqual([]);
    expect(model.error).toBe('boom');
  });
});

describe('volume legend', () => {
  const mixed = makeBars(30).map((b, i) => (i % 2 === 0 ? b : { ...b, open: b.close + 0.5 }));
  const [item] = computeAll(mixed, [indicator('volume')]);
  if (!item) throw new Error('unreachable');

  it('names the lines Vol and MA, and gives the bar no line colour', () => {
    const m = buildIndicatorLegend(item, null);
    expect(m.lines.map((l) => [l.name, l.text])).toEqual([
      ['Vol', '1.03K'],
      ['MA', '1.02K'],
    ]);
    expect(m.lines[0]?.color).toBeNull();
    expect(m.lines[1]?.color).toBe(item.config.color);
  });

  it('tones the volume value by the candle under the crosshair', () => {
    expect(buildIndicatorLegend(item, mixed[10]?.time ?? null).lines[0]?.tone).toBe('up');
    expect(buildIndicatorLegend(item, mixed[11]?.time ?? null).lines[0]?.tone).toBe('down');
    expect(buildIndicatorLegend(item, mixed[11]?.time ?? null).lines[1]?.tone).toBeNull();
  });
});
