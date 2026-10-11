/** Locale-aware number formats. Chinese uses 万 and 亿 for large numbers. */
import { INTL_LOCALE, getLocale } from './locale';
import type { Locale } from './locale';

const compactCache = new Map<Locale, Intl.NumberFormat>();

/** 1.23M / 123.46万, 1.23B / 12.35亿. */
export function formatCompactNumber(value: number, locale: Locale = getLocale()): string {
  let f = compactCache.get(locale);
  if (!f) {
    f = new Intl.NumberFormat(INTL_LOCALE[locale], { notation: 'compact', maximumFractionDigits: 2 });
    compactCache.set(locale, f);
  }
  return f.format(value);
}
