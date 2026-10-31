import { useEffect, useRef, useState } from 'react';
import type { AiMarks, Bar, ChartType } from '@shared/types';
import { IndicatorPanes } from '../panes/IndicatorPanes';
import type { PaneLayout } from '../panes/IndicatorPanes';
import type { ComputedIndicator } from '../panes/computeCache';
import { useTheme } from '../theme';
import { PriceChart } from './PriceChart';
import type { ChartMarker } from './markers';
import { useI18n } from '../i18n';

const NO_INDICATORS: readonly ComputedIndicator[] = [];
const NO_MARKERS: readonly ChartMarker[] = [];
const NO_LEVELS: readonly number[] = [];

/** Where the chart menu opens, and what is under it (docs/ALERTS_PLAN.md, section 4.1). */
export type ChartMenuTarget =
  | { x: number; y: number; pane: 'price'; price: number }
  | { x: number; y: number; pane: 'indicator'; indicatorId: string; value: number };

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
  /** A right-click on a pane's plot area, or the menu key. Not called on a scale or a legend. */
  onContextMenu?: (target: ChartMenuTarget) => void;
  /** Levels of the active price alerts of this symbol: dashed lines (plan section 4.7). */
  alertLevels?: readonly number[];
  /** The levels and zones of an AI analysis of this symbol (docs/AI_HELPER_PLAN.md, step C). */
  aiMarks?: AiMarks | null;
  /** The chart after it is created, and null when it is disposed: overlays (the latch handle) read its geometry. */
  onChart?: (chart: PriceChart | null) => void;
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
  onContextMenu,
  alertLevels = NO_LEVELS,
  aiMarks = null,
  onChart,
}: ChartViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<PriceChart | null>(null);
  // False after a vertical drag moved the price axis; the "Auto" button then shows.
  const [autoScaled, setAutoScaled] = useState(true);
  const panesRef = useRef<IndicatorPanes | null>(null);
  // Callbacks are read through refs so changing them never recreates the chart.
  const handlers = useRef({ onCrosshairTime, onNearStart, onPaneLayout, onContextMenu, onChart });
  useEffect(() => {
    handlers.current = { onCrosshairTime, onNearStart, onPaneLayout, onContextMenu, onChart };
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
    // A right-click on a plot area opens our menu; anywhere else the browser menu shows.
    const onMenu = (e: MouseEvent) => {
      const open = handlers.current.onContextMenu;
      const point = open ? chart.pointAt(e.clientX, e.clientY) : null;
      if (!open || !point) return;
      const base = { x: e.clientX, y: e.clientY };
      if (point.paneIndex === 0) {
        e.preventDefault();
        open({ ...base, pane: 'price', price: point.value });
        return;
      }
      const indicatorId = panes.idAtPane(point.pane);
      if (indicatorId === null) return;
      e.preventDefault();
      open({ ...base, pane: 'indicator', indicatorId, value: point.value });
    };
    container.addEventListener('contextmenu', onMenu);
    handlers.current.onChart?.(chart);
    return () => {
      container.removeEventListener('contextmenu', onMenu);
      chartRef.current = null;
      panesRef.current = null;
      handlers.current.onChart?.(null);
      // Panes first: it only drops its references, so it never touches a removed chart.
      panes.dispose();
      chart.dispose();
    };
  }, []);

  // The theme and the language are already on <html> when this runs (src/theme, src/i18n),
  // so the chart reads the new colours: Chinese swaps up and down. The panes paint with the
  // chart's colours, so they refresh after it. Labels on the canvas follow the language.
  const { theme } = useTheme();
  const { locale, t } = useI18n();
  const drawnLocale = useRef(locale);
  useEffect(() => {
    const newLocale = drawnLocale.current !== locale;
    drawnLocale.current = locale;
    if (newLocale) chartRef.current?.refreshLocale();
    const recoloured = chartRef.current?.refreshTheme();
    // Liquidity and VRVP labels are on the canvas, so the panes redraw for a new language too.
    if (recoloured || newLocale) panesRef.current?.refreshTheme();
  }, [theme, locale]);

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

  useEffect(() => {
    chartRef.current?.setAlertLines(alertLevels);
  }, [alertLevels]);

  useEffect(() => {
    chartRef.current?.setAiMarks(aiMarks);
  }, [aiMarks]);

  // The keyboard opens the same menu: the menu key or Shift+F10. The price is the middle
  // of the visible range, and the menu opens at the middle of the chart.
  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const isMenuKey = e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10');
    const price = isMenuKey && onContextMenu ? chartRef.current?.centerPrice() : null;
    if (price === null || price === undefined || !onContextMenu) return;
    e.preventDefault();
    const r = e.currentTarget.getBoundingClientRect();
    onContextMenu({ x: r.left + r.width / 2, y: r.top + r.height / 2, pane: 'price', price });
  }

  return (
    <>
      <div
        ref={containerRef}
        className="chart-container"
        data-testid="chart-container"
        tabIndex={onContextMenu ? 0 : undefined}
        aria-label={onContextMenu ? t('menu.chartLabel') : undefined}
        onKeyDown={onKeyDown}
      />
      {/* A sibling of the container, never inside it: the library owns that element's DOM. */}
      {!autoScaled && (
        <button
          type="button"
          className="chart-auto-scale"
          onClick={() => chartRef.current?.resetAutoScale()}
          title={t('chart.autoTitle')}
        >
          {t('chart.auto')}
        </button>
      )}
    </>
  );
}
