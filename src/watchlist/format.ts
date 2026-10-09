const DASH = '—';
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 });

export const fmtPrice = (v: number | null) => (v === null ? DASH : v.toFixed(2));
export const fmtChange = (v: number | null) => (v === null ? DASH : `${v > 0 ? '+' : ''}${v.toFixed(2)}`);
/** `fraction` is the contract's fractional change: 0.0123 is +1.23%. */
export const fmtPercent = (f: number | null) => (f === null ? DASH : `${f > 0 ? '+' : ''}${(f * 100).toFixed(2)}%`);
export const fmtVolume = (v: number | null) => (v === null ? DASH : compact.format(v));
export const fmtRange = (lo: number | null, hi: number | null) =>
  lo === null || hi === null ? DASH : `${lo.toFixed(2)}–${hi.toFixed(2)}`;

/** Colour is by sign of the change. Null and zero are neutral. */
export function direction(v: number | null): 'up' | 'down' | 'flat' {
  if (v === null || v === 0) return 'flat';
  return v > 0 ? 'up' : 'down';
}

/**
 * Key for matching a stored symbol to a quote. The server answers under the engine's
 * canonical spelling, which can differ from what is stored: case, and `.` against `-`
 * (BRK.B and BRK-B). Compare through this key on both sides.
 */
export const normKey = (symbol: string) => symbol.toUpperCase().replace(/\./g, '-');
