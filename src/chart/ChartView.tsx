import { useEffect, useRef } from 'react';
import type { Bar, ChartType } from '@shared/types';
import { IndicatorPanes } from '../panes/IndicatorPanes';
import type { PaneLayout } from '../panes/IndicatorPanes';
import type { ComputedIndicator } from '../panes/computeCache';
import { PriceChart } from './PriceChart';

const NO_INDICATORS: readonly ComputedIndicator[] = [];

export interface ChartViewProps {
  bars: Bar[];
  chartType: ChartType;
  /** Drives axis/crosshair time formatting (local time vs UTC date). */
  intraday: boolean;
  onCrosshairTime?: (time: number | null) => void;
  onNearStart?: () => void;
  /** Indicators to draw: overlays on the price pane, separate ones in their own panes. */
  indicators?: readonly ComputedIndicator[];
  /** Where each separate indicator's pane starts (px from the chart's top), for placing legends. */
  onPaneLayout?: (layout: PaneLayout) => void;
}

/**
 * React glue for `PriceChart`: owns create/dispose and forwards props. All chart
 * logic lives in PriceChart so this stays a thin lifecycle adapter.
 *
 * Effect order matters: the first effect creates the chart; the ones below it
 * configure it. React runs them in declaration order on mount and on StrictMode's
 * simulated remount, so a recreated chart is always fully re-configured.
 */
export function ChartView({
  bars,
  chartType,
  intraday,
  onCrosshairTime,
  onNearStart,
  indicators = NO_INDICATORS,
  onPaneLayout,
}: ChartViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<PriceChart | null>(null);
  const panesRef = useRef<IndicatorPanes | null>(null);
  // Callbacks are read through refs so changing them never recreates the chart.
  const handlers = useRef({ onCrosshairTime, onNearStart, onPaneLayout });
  useEffect(() => {
    handlers.current = { onCrosshairTime, onNearStart, onPaneLayout };
  });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const chart = new PriceChart(container, {
      onCrosshairTime: (t) => handlers.current.onCrosshairTime?.(t),
      onNearStart: () => handlers.current.onNearStart?.(),
    });
    const panes = new IndicatorPanes(chart, (layout) => handlers.current.onPaneLayout?.(layout));
    chartRef.current = chart;
    panesRef.current = panes;
    return () => {
      chartRef.current = null;
      panesRef.current = null;
      // Panes first: it only drops its references, so it never touches a removed chart.
      panes.dispose();
      chart.dispose();
    };
  }, []);

  useEffect(() => {
    chartRef.current?.setIntraday(intraday);
  }, [intraday]);

  useEffect(() => {
    chartRef.current?.setChartType(chartType);
  }, [chartType]);

  useEffect(() => {
    chartRef.current?.setBars(bars);
  }, [bars]);

  useEffect(() => {
    panesRef.current?.sync(indicators);
  }, [indicators]);

  return <div ref={containerRef} className="chart-container" data-testid="chart-container" />;
}
