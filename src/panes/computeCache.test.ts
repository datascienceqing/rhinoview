import type { IndicatorConfig } from '@shared/types';
import type { ComputeIndicator } from '../indicators/types';
import { ComputeCache } from './computeCache';
import { fakeComputeIndicator } from './testing/fakeCompute';
import { indicator, makeBars } from './testing/testHelpers';

function setup() {
  const compute = vi.fn<ComputeIndicator>(fakeComputeIndicator);
  return { compute, cache: new ComputeCache(compute) };
}

describe('ComputeCache', () => {
  it('computes each indicator once for unchanged bars and params', () => {
    const { compute, cache } = setup();
    const bars = makeBars(50);
    const configs = [indicator('sma'), indicator('rsi')];
    cache.resolve(bars, configs);
    cache.resolve(bars, [...configs]);
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it('recomputes only the indicator whose params changed', () => {
    const { compute, cache } = setup();
    const bars = makeBars(50);
    const [a, b] = [indicator('sma'), indicator('sma')];
    cache.resolve(bars, [a, b]);
    compute.mockClear();
    const edited: IndicatorConfig = { ...a, params: { period: 5, source: 'close' } };
    const out = cache.resolve(bars, [edited, b]);
    expect(compute).toHaveBeenCalledTimes(1);
    expect(compute.mock.calls[0]?.[2]).toEqual({ period: 5, source: 'close' });
    expect(out[0]?.series?.params).toEqual({ period: 5, source: 'close' });
  });

  it('does not recompute for a colour or visibility change, and keeps the same series object', () => {
    const { compute, cache } = setup();
    const bars = makeBars(50);
    const a = indicator('ema');
    const first = cache.resolve(bars, [a])[0];
    compute.mockClear();
    const second = cache.resolve(bars, [{ ...a, color: '#000000', visible: false }])[0];
    expect(compute).not.toHaveBeenCalled();
    expect(second?.series).toBe(first?.series);
  });

  it('recomputes every indicator when the bars change', () => {
    const { compute, cache } = setup();
    const configs = [indicator('sma'), indicator('macd')];
    cache.resolve(makeBars(50), configs);
    compute.mockClear();
    const out = cache.resolve(makeBars(60), configs);
    expect(compute).toHaveBeenCalledTimes(2);
    expect(out[0]?.series?.lines[0]?.points).toHaveLength(60);
  });

  it('yields a null series without calling compute when there are no bars', () => {
    const { compute, cache } = setup();
    const out = cache.resolve([], [indicator('sma')]);
    expect(compute).not.toHaveBeenCalled();
    expect(out[0]).toMatchObject({ series: null, error: null });
  });

  it('turns a throwing compute into an error on that indicator only', () => {
    const cache = new ComputeCache((bars, kind, params) => {
      if (kind === 'rsi') throw new Error('boom');
      return fakeComputeIndicator(bars, kind, params);
    });
    const out = cache.resolve(makeBars(40), [indicator('rsi'), indicator('sma')]);
    expect(out[0]).toMatchObject({ series: null, error: 'boom' });
    expect(out[1]?.series).not.toBeNull();
  });

  it('forgets removed indicators, so re-adding computes afresh', () => {
    const { compute, cache } = setup();
    const bars = makeBars(30);
    const a = indicator('sma');
    cache.resolve(bars, [a]);
    cache.resolve(bars, []);
    compute.mockClear();
    cache.resolve(bars, [a]);
    expect(compute).toHaveBeenCalledTimes(1);
  });
});
