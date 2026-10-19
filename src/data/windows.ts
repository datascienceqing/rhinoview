import type { Timeframe } from '@shared/types';

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * How much calendar time one history request covers, per timeframe. Sized to land
 * a few hundred bars (not 50k) for a normal trading calendar, so the first paint is
 * fast and there is real room to scroll back and lazy-load. Calendar spans, so
 * weekends/holidays make the bar count smaller; `fetchBackwards` widens on empties.
 */
export const CHUNK_SECONDS: Record<Timeframe, number> = {
  '1m': 2 * DAY,
  '5m': 7 * DAY,
  '15m': 14 * DAY,
  '1h': 45 * DAY,
  '4h': 180 * DAY,
  '1D': 180 * DAY,
  '1W': 3 * 365 * DAY,
};

/**
 * Consecutive empty windows tolerated before concluding there is no older data.
 * One empty window proves little (a weekend of 1m bars is empty), several in a row
 * with a doubling span is strong evidence we reached the start of the series.
 */
export const MAX_EMPTY_PROBES = 3;
