/**
 * Public surface of the indicator module. Worker D (panes) imports from here only.
 *
 *   import { computeIndicator, DEFAULT_PARAMS } from '../indicators';
 *
 * Pure: no DOM, network, clock or randomness.
 */
export { computeIndicator } from './compute';
export { checkIndicatorParams } from './params';
export { DEFAULT_PARAMS, InvalidIndicatorParamsError, LINE_KEYS, PERIOD_MAX, PERIOD_MIN } from './types';
export type { ComputeIndicator } from './types';
