import type { IndicatorConfig } from '@shared/types';
import { MIGRATED_FLAG_KEY, isMigrated, loadIndicators, retireLegacyIndicators, storageKey } from './storage';
import type { EnumerableStorageLike, StorageLike } from './storage';

function memoryStorage(initial: Record<string, string> = {}): EnumerableStorageLike & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    get length() {
      return Object.keys(data).length;
    },
    key: (i) => Object.keys(data)[i] ?? null,
    getItem: (k) => data[k] ?? null,
    setItem: (k, v) => {
      data[k] = v;
    },
    removeItem: (k) => {
      delete data[k];
    },
  };
}

/** Legacy entries, in the exact shape Phase 3 wrote them. */
const entry = (list: IndicatorConfig[]) => JSON.stringify({ version: 1, indicators: list });

const sma: IndicatorConfig = {
  id: 'a',
  kind: 'sma',
  params: { period: 20, source: 'close' },
  color: '#2962ff',
  visible: true,
};
const macd: IndicatorConfig = {
  id: 'b',
  kind: 'macd',
  params: { fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 },
  color: '#e91e63',
  visible: false,
};

describe('legacy indicator reading', () => {
  it('reads configuration, including two instances of one kind', () => {
    const sma50: IndicatorConfig = {
      ...sma,
      id: 'c',
      params: { period: 50, source: 'close' },
      color: '#00bcd4',
    };
    const s = memoryStorage({
      [storageKey('AAPL')]: entry([sma, macd, sma50]),
    });
    expect(loadIndicators('AAPL', s)).toEqual([sma, macd, sma50]);
  });

  it('keys by symbol, so symbols do not share indicators', () => {
    const s = memoryStorage({
      [storageKey('AAPL')]: entry([sma]),
      [storageKey('MSFT')]: entry([macd]),
    });
    expect(loadIndicators('AAPL', s)).toEqual([sma]);
    expect(loadIndicators('MSFT', s)).toEqual([macd]);
    expect(loadIndicators('TSLA', s)).toEqual([]);
    expect(storageKey('AAPL')).not.toBe(storageKey('MSFT'));
  });

  it('reads through the real localStorage too', () => {
    localStorage.clear();
    localStorage.setItem(storageKey('NVDA'), entry([sma]));
    expect(loadIndicators('NVDA')).toEqual([sma]);
    localStorage.clear();
  });
});

describe('retiring legacy indicators', () => {
  it('removes every charting-app:indicators:* key, keeps unrelated keys, and sets the flag', () => {
    const s = memoryStorage({
      [storageKey('AAPL')]: entry([sma]),
      [storageKey('MSFT')]: entry([macd]),
      'charting-app:theme': 'dark',
      other: 'x',
    });
    expect(isMigrated(s)).toBe(false);
    retireLegacyIndicators(s);
    expect(Object.keys(s.data).sort()).toEqual(['charting-app:theme', MIGRATED_FLAG_KEY, 'other'].sort());
    expect(s.data[MIGRATED_FLAG_KEY]).toBe('1');
    expect(isMigrated(s)).toBe(true);
  });

  it('still removes keys when setItem throws, and still sets the flag when removeItem throws', () => {
    const noSet = memoryStorage({ [storageKey('AAPL')]: entry([sma]) });
    noSet.setItem = () => {
      throw new Error('QuotaExceededError');
    };
    expect(() => retireLegacyIndicators(noSet)).not.toThrow();
    expect(noSet.data[storageKey('AAPL')]).toBeUndefined();

    const noRemove = memoryStorage({ [storageKey('AAPL')]: entry([sma]) });
    noRemove.removeItem = () => {
      throw new Error('SecurityError');
    };
    expect(() => retireLegacyIndicators(noRemove)).not.toThrow();
    expect(noRemove.data[MIGRATED_FLAG_KEY]).toBe('1');
  });

  it('does not throw when the store cannot be enumerated or the accessor itself throws', () => {
    const broken = memoryStorage();
    Object.defineProperty(broken, 'length', {
      get() {
        throw new Error('SecurityError');
      },
    });
    expect(() => retireLegacyIndicators(broken)).not.toThrow();
    expect(broken.data[MIGRATED_FLAG_KEY]).toBe('1');

    const spy = vi.spyOn(globalThis, 'localStorage', 'get').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    try {
      expect(() => retireLegacyIndicators()).not.toThrow();
      expect(isMigrated()).toBe(false);
    } finally {
      spy.mockRestore();
    }
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

  it('survives the localStorage accessor itself throwing', () => {
    const spy = vi.spyOn(globalThis, 'localStorage', 'get').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    try {
      expect(loadIndicators('AAPL')).toEqual([]);
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
        {
          id: 'bad-kind',
          kind: 'bollinger',
          params: { period: 20 },
          color: '#2962ff',
          visible: true,
        },
        {
          id: 'bad-period',
          kind: 'rsi',
          params: { period: 0 },
          color: '#2962ff',
          visible: true,
        },
        {
          id: 'bad-macd',
          kind: 'macd',
          params: { fastPeriod: 30, slowPeriod: 26, signalPeriod: 9 },
          color: '#2962ff',
          visible: true,
        },
        {
          kind: 'rsi',
          params: { period: 14 },
          color: '#2962ff',
          visible: true,
        },
        macd,
      ],
    });
    const s = memoryStorage({ [storageKey('AAPL')]: raw });
    expect(loadIndicators('AAPL', s)).toEqual([sma, macd]);
  });

  it('repairs a bad colour or visibility rather than losing the indicator', () => {
    const raw = JSON.stringify({
      version: 1,
      indicators: [
        {
          id: 'a',
          kind: 'rsi',
          params: { period: 14 },
          color: 'url(javascript:1)',
          visible: 'yes',
        },
      ],
    });
    const [only] = loadIndicators('AAPL', memoryStorage({ [storageKey('AAPL')]: raw }));
    expect(only).toMatchObject({ id: 'a', kind: 'rsi', visible: true });
    expect(only?.color).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('drops duplicate ids, which would otherwise make two indicators share one series', () => {
    const raw = JSON.stringify({
      version: 1,
      indicators: [sma, { ...sma, params: { period: 5 } }],
    });
    expect(loadIndicators('AAPL', memoryStorage({ [storageKey('AAPL')]: raw }))).toEqual([sma]);
  });
});
