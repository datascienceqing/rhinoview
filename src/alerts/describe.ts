/**
 * Text and order for alerts and events (docs/ALERTS_PLAN.md, section 4.6). Pure, except
 * that the text reads the current language through `t`.
 */
import type { Alert, AlertCondition, AlertDirection, AlertEvent, AlertStatus } from '@shared/types';
import { t, translateIn } from '../i18n';
import { indicatorTitle } from '../panes/config';

/** ↕ crossing, ↑ crossing up, ↓ crossing down. */
export const DIRECTION_ARROW: Record<AlertDirection, string> = { cross: '↕', up: '↑', down: '↓' };

/**
 * A price level for an alert. From 1 up it keeps cents; below 1 it keeps 4 significant
 * digits, so a sub-cent symbol (0.004123) does not round to 0.
 */
export function roundLevel(price: number): number {
  return Math.abs(price) >= 1 ? Math.round(price * 100) / 100 : Number(price.toPrecision(4));
}

/** A price as text for alerts: 2 decimals from 1 up, else the digits `roundLevel` keeps. */
export function formatLevel(price: number): string {
  return Math.abs(price) >= 1 ? price.toFixed(2) : String(roundLevel(price));
}

/** Indicator values are not prices: keep up to 4 significant decimals, as the legend does. */
export function formatValue(value: number): string {
  if (Math.abs(value) >= 100) return value.toFixed(2);
  return Number(value.toPrecision(4)).toString();
}

function lineName(line: string): string {
  // `value` is the only line of SMA, EMA and RSI: the title already names it.
  if (line === 'value') return '';
  return t(`indicator.line.${line}` as 'indicator.line.macd');
}

/** The thing that is compared: "RSI (14)", or "MACD (12, 26, 9) Signal". */
export function subjectOf(condition: Extract<AlertCondition, { type: 'indicator' }>): string {
  const name = lineName(condition.line);
  const title = indicatorTitle(condition.indicator);
  return name ? `${title} ${name}` : title;
}

/** The target in words: "70", "close", "Signal". */
export function targetText(condition: Extract<AlertCondition, { type: 'indicator' }>): string {
  const target = condition.target;
  if (target.type === 'value') return formatValue(target.value);
  if (target.type === 'close') return t('alerts.closeName');
  return lineName(target.line) || target.line;
}

/** The message the app writes when the user leaves it empty: "AAPL crossing 190.00". */
export function defaultMessage(symbol: string, condition: AlertCondition): string {
  const verb = t(`alerts.verb.${condition.direction}`);
  if (condition.type === 'price') return t('alerts.message.price', { symbol, verb, level: formatLevel(condition.level) });
  return t('alerts.message.indicator', { symbol, indicator: subjectOf(condition), verb, target: targetText(condition) });
}

/** The message to show: the user's own, else the default. */
export const messageOf = (a: Pick<Alert, 'symbol' | 'condition' | 'message'>): string => a.message || defaultMessage(a.symbol, a.condition);

/** A short summary for a row: "↕ 190.00" or "RSI (14) ↑ 70". */
export function summaryOf(condition: AlertCondition): string {
  const arrow = DIRECTION_ARROW[condition.direction];
  if (condition.type === 'price') return `${arrow} ${formatLevel(condition.level)}`;
  return `${subjectOf(condition)} ${arrow} ${targetText(condition)}`;
}

/**
 * True when `query` matches the symbol or the indicator, in either language, ignoring case.
 * An empty query matches everything.
 */
export function matchesSearch(item: { symbol: string; condition: AlertCondition }, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const words = [item.symbol];
  if (item.condition.type === 'indicator') {
    const kind = item.condition.indicator.kind;
    words.push(subjectOf(item.condition), translateIn('en', `indicator.kind.${kind}`), translateIn('zh', `indicator.kind.${kind}`));
  }
  return words.some((w) => w.toLowerCase().includes(q));
}

const STATUS_ORDER: Record<AlertStatus, number> = { active: 0, paused: 1, triggered: 2, expired: 3 };

/** The Alerts tab: active first, then by symbol, then newest first. */
export function sortAlerts(alerts: readonly Alert[]): Alert[] {
  return [...alerts].sort(
    (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.symbol.localeCompare(b.symbol) || b.createdAt - a.createdAt,
  );
}

/** The Triggered tab: unchecked first, then newest first. */
export function sortEvents(events: readonly AlertEvent[]): AlertEvent[] {
  return [...events].sort((a, b) => Number(a.checked) - Number(b.checked) || b.firedAt - a.firedAt);
}

/** "Checked every 30 s" or "Checked every 7 min". */
export function intervalText(seconds: number): string {
  return seconds < 120 ? t('alerts.interval.seconds', { n: seconds }) : t('alerts.interval.minutes', { n: Math.round(seconds / 60) });
}
