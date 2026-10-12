import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { en } from './en';
import { zh } from './zh';
import { I18nProvider, useI18n } from './I18nProvider';
import { LOCALE_KEY, applyLocale, detectLocale, getLocale, readStoredLocale } from './locale';
import type { LocaleStorage } from './locale';
import { formatCompactNumber } from './format';
import { t, translateIn } from './translate';
import type { MessageKey } from './translate';

function memory(initial: Record<string, string> = {}): () => LocaleStorage & { data: Record<string, string> } {
  const data = { ...initial };
  const store = { data, getItem: (k: string) => data[k] ?? null, setItem: (k: string, v: string) => void (data[k] = v) };
  return () => store;
}
const throwing = (): LocaleStorage => {
  throw new Error('SecurityError');
};

describe('detectLocale', () => {
  it.each([
    [['zh-CN'], 'zh'],
    [['zh-TW', 'en'], 'zh'],
    [['zh'], 'zh'],
    [['en-US', 'zh-CN'], 'en'],
    [['fr-FR'], 'en'],
    [[], 'en'],
  ] as const)('%j -> %s', (languages, expected) => {
    expect(detectLocale(languages)).toBe(expected);
  });
});

describe('readStoredLocale', () => {
  it('a stored choice wins over the browser language', () => {
    expect(readStoredLocale(memory({ [LOCALE_KEY]: 'en' }), ['zh-CN'])).toBe('en');
    expect(readStoredLocale(memory({ [LOCALE_KEY]: 'zh' }), ['en-US'])).toBe('zh');
  });

  it('an unknown or missing stored value falls back to the browser language', () => {
    expect(readStoredLocale(memory({ [LOCALE_KEY]: 'de' }), ['zh-CN'])).toBe('zh');
    expect(readStoredLocale(memory(), ['en-GB'])).toBe('en');
  });

  it('blocked storage falls back to the browser language', () => {
    expect(readStoredLocale(throwing, ['zh-CN'])).toBe('zh');
  });
});

describe('applyLocale', () => {
  it('sets the language for non-React code, and data-locale and lang on <html>', () => {
    applyLocale('zh');
    expect(getLocale()).toBe('zh');
    expect(document.documentElement.dataset.locale).toBe('zh');
    expect(document.documentElement.lang).toBe('zh-CN');
    expect(t('toolbar.financials')).toBe('财务');
    applyLocale('en');
    expect(document.documentElement.lang).toBe('en-US');
    expect(t('toolbar.financials')).toBe('Financials');
  });
});

describe('catalogs', () => {
  const keys = Object.keys(en) as MessageKey[];
  /** Sample params, enough for every message function. */
  const params = new Proxy({}, { get: (_t, k) => (k === 'n' || k === 'seconds' || k === 'count' || k === 'max' || k === 'min' || k === 'rows' || k === 'lookback' || k === 'year' ? 2 : 'X') });
  const text = (locale: 'en' | 'zh', key: MessageKey) => (translateIn as (l: string, k: string, p: unknown) => string)(locale, key, params);

  it('have the same keys', () => {
    expect(Object.keys(zh).sort()).toEqual([...keys].sort());
  });

  it('every message renders to non-empty text in both languages', () => {
    for (const key of keys) {
      expect(text('en', key).length, key).toBeGreaterThan(0);
      expect(text('zh', key).length, key).toBeGreaterThan(0);
    }
  });

  // Indicator names, titles and legend line names stay in English (user decision, 2026-10-11).
  const INDICATOR_NAME = /^indicator\.(kind\.|title|line\.)/;
  // Standard abbreviations stay the same in Chinese (user decision).
  const SAME = new Set<string>(['fund.metric.pegRatio', 'fund.metric.evToEbitda']);
  // Alert messages are compositions of parts that are translated one by one (the verb, the line).
  const COMPOSED = new Set<string>(['alerts.message.price', 'alerts.message.indicator']);

  it('every Chinese message is Chinese, except indicator names and the agreed abbreviations', () => {
    const cjk = /[一-鿿]/;
    const untranslated = keys.filter((k) => !SAME.has(k) && !COMPOSED.has(k) && !INDICATOR_NAME.test(k) && !k.startsWith('locale.') && !cjk.test(text('zh', k)));
    expect(untranslated).toEqual([]);
  });

  it('keeps every indicator name, title and legend line name exactly as in English', () => {
    const names = keys.filter((k) => INDICATOR_NAME.test(k));
    expect(names.length).toBeGreaterThanOrEqual(15);
    for (const k of names) expect(zh[k], k).toBe(en[k]);
  });

  it('the language toggle names the other language', () => {
    expect(en['locale.toggle']).toBe('中文');
    expect(zh['locale.toggle']).toBe('EN');
  });
});

describe('formatCompactNumber', () => {
  it('uses K/M/B in English and 万/亿 in Chinese', () => {
    expect(formatCompactNumber(1_234_567, 'en')).toBe('1.23M');
    expect(formatCompactNumber(1_234_567, 'zh')).toBe('123.46万');
    expect(formatCompactNumber(123_456_789, 'zh')).toBe('1.23亿');
    expect(formatCompactNumber(950, 'zh')).toBe('950');
  });
});

function Probe() {
  const { locale, t: tr, toggleLocale } = useI18n();
  return (
    <button type="button" onClick={toggleLocale}>
      {locale}:{tr('toolbar.financials')}
    </button>
  );
}

describe('I18nProvider', () => {
  it('starts from the browser language, toggles, and stores the choice', async () => {
    const storage = memory();
    render(
      <I18nProvider storage={storage} languages={['zh-CN']}>
        <Probe />
      </I18nProvider>,
    );
    expect(screen.getByRole('button')).toHaveTextContent('zh:财务');
    expect(document.documentElement.dataset.locale).toBe('zh');
    await userEvent.setup().click(screen.getByRole('button'));
    expect(screen.getByRole('button')).toHaveTextContent('en:Financials');
    expect(storage().data[LOCALE_KEY]).toBe('en');
    expect(getLocale()).toBe('en');
  });

  it('without a provider the language is English', () => {
    render(<Probe />);
    expect(screen.getByRole('button')).toHaveTextContent('en:Financials');
  });

  it('still works when storage throws', () => {
    act(() => {
      render(
        <I18nProvider storage={throwing} languages={['zh-CN']}>
          <Probe />
        </I18nProvider>,
      );
    });
    expect(screen.getByRole('button')).toHaveTextContent('zh:财务');
  });
});
