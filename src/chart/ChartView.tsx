import { useEffect, useRef, useState } from 'react';
import type { Bar, ChartType } from '@shared/types';
import { IndicatorPanes } from '../panes/IndicatorPanes';
import type { PaneLayout } from '../panes/IndicatorPanes';
import type { ComputedIndicator } from '../panes/computeCache';
import { useTheme } from '../theme';
import { PriceChart } from './PriceChart';
import type { ChartMarker } from './markers';

const NO_INDICATORS: readonly ComputedIndicator[] = [];
const NO_MARKERS: readonly ChartMarker[] = [];

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
  /** Flags on the price series, for example earnings. Phase 5 seam; see markers.ts. */
  markers?: readonly ChartMarker[];
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
  markers = NO_MARKERS,
}: ChartViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<PriceChart | null>(null);
  // False after a vertical drag moved the price axis; the "Auto" button then shows.
  const [autoScaled, setAutoScaled] = useState(true);
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
      onAutoScaleChange: setAutoScaled,
    });
    setAutoScaled(true); // a new chart starts auto-fitted
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

  // The theme is already on <html> when this runs (src/theme), so the chart reads the new
  // colours. The panes paint with the chart's colours, so they refresh after it.
  const { theme } = useTheme();
  useEffect(() => {
    if (chartRef.current?.refreshTheme()) panesRef.current?.refreshTheme();
  }, [theme]);

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

  useEffect(() => {
    chartRef.current?.setMarkers(markers);
  }, [markers]);

  return (
    <>
      <div ref={containerRef} className="chart-container" data-testid="chart-container" />
      {/* A sibling of the container, never inside it: the library owns that element's DOM. */}
      {!autoScaled && (
        <button
          type="button"
          className="chart-auto-scale"
          onClick={() => chartRef.current?.resetAutoScale()}
          title="Fit the price axis to the visible bars again"
        >
          Auto
        </button>
      )}
    </>
  );
}
