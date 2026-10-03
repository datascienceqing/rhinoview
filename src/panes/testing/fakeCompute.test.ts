import { InvalidIndicatorParamsError } from '../../indicators/types';
import { fakeComputeIndicator } from './fakeCompute';
import { makeBars } from './testHelpers';

const bars = makeBars(120);

// The pane UI's stand-in must honour the seam's conventions, or the UI tests prove nothing.
describe('fakeComputeIndicator honours the seam conventions', () => {
  it('returns one point per bar, same times and order', () => {
    const s = fakeComputeIndicator(bars, 'macd', { fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 });
    for (const line of s.lines) expect(line.points.map((p) => p.time)).toEqual(bars.map((b) => b.time));
  });

  it('leaves SMA warmup null, never zero, and defines everything after', () => {
    const s = fakeComputeIndicator(bars, 'sma', { period: 20 });
    const pts = s.lines[0]?.points ?? [];
    expect(s.warmup).toBe(19);
    expect(pts.slice(0, 19).every((p) => p.value === null)).toBe(true);
    expect(pts.slice(19).every((p) => p.value !== null)).toBe(true);
  });

  it('seeds the EMA with the SMA of the first period values', () => {
    const s = fakeComputeIndicator(bars, 'ema', { period: 10 });
    const first = s.lines[0]?.points[9]?.value;
    const mean = bars.slice(0, 10).reduce((a, b) => a + b.close, 0) / 10;
    expect(first).toBeCloseTo(mean, 10);
  });

  it('keeps RSI within 0..100', () => {
    const s = fakeComputeIndicator(bars, 'rsi', { period: 14 });
    const vals = (s.lines[0]?.points ?? []).flatMap((p) => (p.value === null ? [] : [p.value]));
    expect(vals.length).toBe(bars.length - 14);
    expect(Math.min(...vals)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...vals)).toBeLessThanOrEqual(100);
  });

  it('gives MACD three lines whose histogram is macd - signal and changes sign', () => {
    const s = fakeComputeIndicator(bars, 'macd', { fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 });
    expect(s.lines.map((l) => l.key)).toEqual(['macd', 'signal', 'histogram']);
    const [macd, signal, hist] = s.lines.map((l) => l.points);
    let signs = new Set<number>();
    hist?.forEach((h, i) => {
      const m = macd?.[i]?.value;
      const sg = signal?.[i]?.value;
      if (h.value === null) return;
      expect(h.value).toBeCloseTo((m ?? NaN) - (sg ?? NaN), 10);
      signs = signs.add(Math.sign(h.value));
    });
    expect(signs.has(1) && signs.has(-1)).toBe(true);
    expect(s.warmup).toBe(25);
  });

  it('throws on invalid params, like the real module', () => {
    expect(() => fakeComputeIndicator(bars, 'sma', { period: 0 })).toThrow(InvalidIndicatorParamsError);
    expect(() => fakeComputeIndicator(bars, 'macd', { fastPeriod: 26, slowPeriod: 12, signalPeriod: 9 })).toThrow(
      InvalidIndicatorParamsError,
    );
  });
});
