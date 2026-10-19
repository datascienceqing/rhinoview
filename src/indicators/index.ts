/**
 * Public surface of the indicator module. Worker D (panes) imports from here only.
 *
 *   import { computeIndicator, DEFAULT_PARAMS } from '../indicators';
 *
 * Pure: no DOM, network, clock or randomness.
 */
export { computeIndicator } from './compute';
export { checkIndicatorParams } from './params';
export { CONFLUENCE_BOUNDS, CVWAP_BOUNDS, DEFAULT_PARAMS, FVG_BOUNDS, InvalidIndicatorParamsError, LINE_KEYS, LIQUIDITY_BOUNDS, LIQUIDITY_SWEEP_MODES, LIQUIDITY_ZONE_MODES, PERIOD_MAX, PERIOD_MIN, VPVR_BOUNDS } from './types';
export { buildVpvrProfile } from './vpvr';
export type { VpvrProfile, VpvrRow } from './vpvr';
export { computeLiquidity } from './liquidity';
export type { LiquidityDirection, LiquidityResult, LiquiditySide, LiquiditySweep, LiquidityZone } from './liquidity';
export { computeConfluence } from './confluence';
export type { ConfluenceCluster, ConfluenceEvent, ConfluencePoint, ConfluenceResult, ConfluenceSource, ConfluenceState } from './confluence';
export type { ComputeIndicator } from './types';
export { computeFvg } from './fvg';
export type { FvgResult, FvgZone } from './fvg';
export { computeCvwap } from './cvwap';
export type { CvwapResult } from './cvwap';
