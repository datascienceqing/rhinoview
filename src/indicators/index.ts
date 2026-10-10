/**
 * Public surface of the indicator module. Worker D (panes) imports from here only.
 *
 *   import { computeIndicator, DEFAULT_PARAMS } from '../indicators';
 *
 * Pure: no DOM, network, clock or randomness.
 */
export { computeIndicator } from './compute';
export { checkIndicatorParams } from './params';
export { DEFAULT_PARAMS, InvalidIndicatorParamsError, LINE_KEYS, LIQUIDITY_BOUNDS, LIQUIDITY_SWEEP_MODES, LIQUIDITY_ZONE_MODES, PERIOD_MAX, PERIOD_MIN, VPVR_BOUNDS } from './types';
export { buildVpvrProfile } from './vpvr';
export type { VpvrProfile, VpvrRow } from './vpvr';
export { computeLiquidity } from './liquidity';
export type { LiquidityDirection, LiquidityResult, LiquiditySide, LiquiditySweep, LiquidityZone } from './liquidity';
export type { ComputeIndicator } from './types';
