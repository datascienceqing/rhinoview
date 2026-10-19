/**
 * Fair value gaps (FVG), after the user's Pine script "Fair Value Gaps (FVG) / Imbalances".
 * Pure: bars and params in, gap zones out.
 *
 * A three-bar gap forms at bar j (the third bar) when the wicks of bars j-2 and j do not
 * overlap:
 *  - bullish: `low[j] > high[j-2]`; the zone is `high[j-2] .. low[j]`.
 *  - bearish: `high[j] < low[j-2]`; the zone is `high[j] .. low[j-2]`.
 * The box starts at the middle bar j-1, like the script.
 *
 * Like the script:
 *  - No gap forms before ATR(14) has a value, also with both filters off.
 *  - Filter 1: the gap is at least `minGapAtrPct` % of the ATR. Filter 2: the body of the
 *    middle bar is at least `displacementAtrPct` % of the ATR. 0 turns a filter off.
 *  - Only the newest `maxZones` gaps stay. With style 'remove', a mitigated gap still holds
 *    its place in that count; it is only not drawn.
 *  - Mitigation, mode 'wick': the bar range overlaps the zone. Mode 'fill': the close is
 *    inside the zone. A gap is filled at the first close past its far edge (below the
 *    bottom of a bullish gap, above the top of a bearish gap). A filled gap is not checked
 *    again.
 *
 * One change from the script: the checks start on the bar AFTER the gap bar. The script also
 * checks the gap bar, whose own wick is the zone edge, so in mode 'wick' every gap was
 * mitigated on the bar that made it.
 */
import type { Bar, FvgParams } from '@shared/types';
import { atr } from './math';
import { assertValidParams } from './params';
import { FVG_ATR_PERIOD } from './types';

export type FvgSide = 'bull' | 'bear';

export interface FvgZone {
  /** Stable within one data set: side and the middle bar's time. */
  id: string;
  side: FvgSide;
  /** The middle bar: the box starts here. */
  startIndex: number;
  /** The third bar, which confirms the gap. */
  createIndex: number;
  /** The last bar of the box: the last loaded bar, or `startIndex + boxLength` (it can be past the data). */
  endIndex: number;
  top: number;
  bottom: number;
  /** The first bar after `createIndex` that entered the zone, or null. */
  touchIndex: number | null;
  /** The first bar after `createIndex` that closed past the far edge, or null. */
  fillIndex: number | null;
}

export interface FvgResult {
  /** Oldest first. */
  zones: FvgZone[];
}

/** Gap zones of `bars` (ascending by time). Throws on invalid params. */
export function computeFvg(bars: readonly Bar[], params: FvgParams): FvgResult {
  assertValidParams('fvg', params);
  const { minGapAtrPct, displacementAtrPct, maxZones, extend, boxLength, mitigation, mitigatedStyle } = params;
  const n = bars.length;
  const high = new Float64Array(n);
  const low = new Float64Array(n);
  const close = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const b = bars[i] as Bar;
    high[i] = b.high;
    low[i] = b.low;
    close[i] = b.close;
  }
  const atrValues = atr(high, low, close, FVG_ATR_PERIOD);

  // The newest `maxZones` gaps. An older gap can never come back, so it needs no more checks.
  let zones: FvgZone[] = [];

  for (let j = 0; j < n; j++) {
    const bar = bars[j] as Bar;

    // 1. Mitigation of the gaps that formed on an earlier bar.
    for (const z of zones) {
      if (z.fillIndex !== null) continue;
      const entered =
        mitigation === 'wick' ? bar.low <= z.top && bar.high >= z.bottom : bar.close <= z.top && bar.close >= z.bottom;
      if (entered && z.touchIndex === null) z.touchIndex = j;
      const filled = z.side === 'bull' ? bar.close < z.bottom : bar.close > z.top;
      if (filled) z.fillIndex = j;
    }

    // 2. A gap that this bar completes.
    const a = atrValues[j] as number;
    if (j < 2 || Number.isNaN(a)) continue;
    const first = bars[j - 2] as Bar;
    const middle = bars[j - 1] as Bar;
    const bodyOk = displacementAtrPct <= 0 || Math.abs(middle.close - middle.open) >= (a * displacementAtrPct) / 100;
    const sizeOk = (size: number) => minGapAtrPct <= 0 || size >= (a * minGapAtrPct) / 100;
    const add = (side: FvgSide, top: number, bottom: number) => {
      zones.push({
        id: `${side}-${middle.time}`,
        side,
        startIndex: j - 1,
        createIndex: j,
        endIndex: extend === 'right' ? n - 1 : j - 1 + boxLength,
        top,
        bottom,
        touchIndex: null,
        fillIndex: null,
      });
    };
    if (bar.low > first.high && bodyOk && sizeOk(bar.low - first.high)) add('bull', bar.low, first.high);
    if (bar.high < first.low && bodyOk && sizeOk(first.low - bar.high)) add('bear', first.low, bar.high);
    if (zones.length > maxZones) zones = zones.slice(zones.length - maxZones);
  }

  if (mitigatedStyle === 'remove') zones = zones.filter((z) => z.touchIndex === null && z.fillIndex === null);
  return { zones };
}
