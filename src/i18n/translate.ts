import { en } from './en';
import { zh } from './zh';
import { getLocale } from './locale';
import type { Locale } from './locale';

export type Messages = typeof en;
export type MessageKey = keyof Messages;
/** The params a message takes: none for a plain string, else the argument of its function. */
export type MessageArgs<K extends MessageKey> = Messages[K] extends (p: infer P) => string ? [params: P] : [];

const CATALOGS: Record<Locale, Messages> = { en, zh };

/** The message `key` in `locale`. */
export function translateIn<K extends MessageKey>(locale: Locale, key: K, ...args: MessageArgs<K>): string {
  const message = CATALOGS[locale][key] as string | ((p: unknown) => string);
  return typeof message === 'function' ? message(args[0]) : message;
}

/** The message `key` in the current language. For code outside React (painters, formatters). */
export function t<K extends MessageKey>(key: K, ...args: MessageArgs<K>): string {
  return translateIn(getLocale(), key, ...args);
}

export type Translate = typeof t;
