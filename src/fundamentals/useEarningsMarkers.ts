/**
 * Earnings flags ("E") for the price chart. PHASE 5 SLOT — Worker W6 implements.
 * Returns ChartMarkers dated at 00:00 America/New_York of each report date; the chart
 * snaps them to bars (src/chart/markers.ts). Wave 0 returns none.
 */
import type { ChartMarker } from '../chart/markers';

const NONE: readonly ChartMarker[] = [];

export function useEarningsMarkers(_symbol: string): readonly ChartMarker[] {
  return NONE;
}
