import type { IndicatorConfig } from '@shared/types';
import { loadIndicators, saveIndicators, storageKey } from './storage';
import type { StorageLike } from './storage';

function memoryStorage(initial: Record<string, string> = {}): StorageLike & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => data[k] ?? null,
    setItem: (k, v) => {
      data[k] = v;
    },
  };
}

const sma: IndicatorConfig = { id: 'a', kind: 'sma', params: { period: 20, source: 'close' }, color: '#2962ff', visible: true };
const macd: IndicatorConfig = {
  id: 'b',
  kind: 'macd',
  params: { fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 },
  color: '#e91e63',
  visible: false,
};

describe('indicator persistence', () => {
  it('round-trips configuration, including two instances of one kind', () => {
    const s = memoryStorage();
    const sma50: IndicatorConfig = { ...sma, id: 'c', params: { period: 50, source: 'close' }, color: '#00bcd4' };
    expect(saveIndicators('AAPL', [sma, macd, sma50], s)).toBe(true);
    expect(loadIndicators('AAPL', s)).toEqual([sma, macd, sma50]);
  });

  it('keys by symbol, so symbols do not share indicators', () => {
    const s = memoryStorage();
    saveIndicators('AAPL', [sma], s);
    saveIndicators('MSFT', [macd], s);
    expect(loadIndicators('AAPL', s)).toEqual([sma]);
    expect(loadIndicators('MSFT', s)).toEqual([macd]);
    expect(loadIndicators('TSLA', s)).toEqual([]);
    expect(storageKey('AAPL')).not.toBe(storageKey('MSFT'));
  });

  it('round-trips through the real localStorage too', () => {
    localStorage.clear();
    saveIndicators('NVDA', [sma]);
    expect(loadIndicators('NVDA')).toEqual([sma]);
    localStorage.clear();
  });
});

describe('persistence failure modes never throw and degrade to defaults', () => {
  it('returns [] when getItem throws', () => {
    const s: StorageLike = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => undefined,
    };
    expect(loadIndicators('AAPL', s)).toEqual([]);
  });

  it('reports false and does not throw when setItem throws (quota, private mode)', () => {
    const s: StorageLike = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    expect(saveIndicators('AAPL', [sma], s)).toBe(false);
  });

  it('survives the localStorage accessor itself throwing', () => {
    const spy = vi.spyOn(globalThis, 'localStorage', 'get').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    try {
      expect(loadIndicators('AAPL')).toEqual([]);
      expect(saveIndicators('AAPL', [sma])).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it.each([
    ['not json', '{oops'],
    ['truncated json', '{"version":1,"indicators":[{"id":"a"'],
    ['a bare number', '42'],
    ['null', 'null'],
    ['an array at the top level', '[1,2]'],
    ['indicators not an array', '{"version":1,"indicators":"sma"}'],
    ['empty string', ''],
  ])('returns [] for corrupt JSON: %s', (_name, raw) => {
    const s = memoryStorage({ [storageKey('AAPL')]: raw });
    expect(loadIndicators('AAPL', s)).toEqual([]);
  });

  it('drops invalid entries individually and keeps the valid ones', () => {
    const raw = JSON.stringify({
      version: 1,
      indicators: [
        sma,
        null,
        'x',
        { id: 'bad-kind', kind: 'bollinger', params: { period: 20 }, color: '#2962ff', visible: true },
        { id: 'bad-period', kind: 'rsi', params: { period: 0 }, color: '#2962ff', visible: true },
        { id: 'bad-macd', kind: 'macd', params: { fastPeriod: 30, slowPeriod: 26, signalPeriod: 9 }, color: '#2962ff', visible: true },
        { kind: 'rsi', params: { period: 14 }, color: '#2962ff', visible: true },
        macd,
      ],
    });
    const s = memoryStorage({ [storageKey('AAPL')]: raw });
    expect(loadIndicators('AAPL', s)).toEqual([sma, macd]);
  });

  it('repairs a bad colour or visibility rather than losing the indicator', () => {
    const raw = JSON.stringify({
      version: 1,
      indicators: [{ id: 'a', kind: 'rsi', params: { period: 14 }, color: 'url(javascript:1)', visible: 'yes' }],
    });
    const [only] = loadIndicators('AAPL', memoryStorage({ [storageKey('AAPL')]: raw }));
    expect(only).toMatchObject({ id: 'a', kind: 'rsi', visible: true });
    expect(only?.color).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('drops duplicate ids, which would otherwise make two indicators share one series', () => {
    const raw = JSON.stringify({ version: 1, indicators: [sma, { ...sma, params: { period: 5 } }] });
    expect(loadIndicators('AAPL', memoryStorage({ [storageKey('AAPL')]: raw }))).toEqual([sma]);
  });
});
