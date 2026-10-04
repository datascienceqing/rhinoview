/**
 * CLIENT WORKSPACE SEAM — orchestrator-owned, frozen for Phase 5.
 *
 * The ACTIVE CHART is the one piece of client state that three Phase 5 modules share:
 *   • layouts (W4) owns it: which named layout is active, and saving its changes;
 *   • the watchlist (W5) writes it: clicking a row calls `setSymbol`;
 *   • fundamentals (W6) reads it: the panel follows `chart.symbol`.
 * Defining it here, before any of them starts, is what lets them work in parallel
 * without editing each other's files.
 *
 * W4 replaces the in-memory provider with one that loads and saves layouts through
 * `/api/layouts`. W5 and W6 must depend ONLY on `useActiveChart()`.
 */
import type { ChartType, EntityId, IndicatorConfig, Timeframe } from '@shared/types';

export interface ActiveChart {
  /** The active layout's id, or null before the workspace has loaded. */
  layoutId: EntityId | null;
  /** The active layout's name, for display. */
  name: string;
  symbol: string;
  timeframe: Timeframe;
  chartType: ChartType;
  /** The active layout's indicators. Indicators belong to the layout, not the symbol. */
  indicators: IndicatorConfig[];
}

export interface ActiveChartApi {
  chart: ActiveChart;
  /** Change the active layout's symbol. Its indicators stay (TradingView behaviour). */
  setSymbol(symbol: string): void;
  setTimeframe(timeframe: Timeframe): void;
  setChartType(chartType: ChartType): void;
  setIndicators(indicators: IndicatorConfig[]): void;
}

/** The default chart, used before the workspace loads and by the in-memory provider. */
export const DEFAULT_ACTIVE_CHART: ActiveChart = {
  layoutId: null,
  name: 'Main',
  symbol: 'AAPL',
  timeframe: '1D',
  chartType: 'candlestick',
  indicators: [],
};
