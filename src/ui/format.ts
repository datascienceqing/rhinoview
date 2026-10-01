const DASH = '—';

export function formatPrice(value: number | null): string {
  return value === null ? DASH : value.toFixed(2);
}

/** Signed absolute change, e.g. "+1.46" / "-0.30". */
export function formatChange(value: number | null): string {
  if (value === null) return DASH;
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}`;
}

/**
 * `fraction` is the contract's fractional change: 0.0123 means +1.23%.
 * Multiplying by 100 here, for display, is the only place that happens.
 */
export function formatPercent(fraction: number | null): string {
  if (fraction === null) return DASH;
  const pct = fraction * 100;
  return `${pct > 0 ? '+' : ''}${pct.toFixed(2)}%`;
}

const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 });

export function formatVolume(value: number | null): string {
  return value === null ? DASH : compact.format(value);
}

/** CSS class for a signed value; null/zero are neutral. */
export function directionClass(value: number | null): 'up' | 'down' | 'flat' {
  if (value === null || value === 0) return 'flat';
  return value > 0 ? 'up' : 'down';
}
