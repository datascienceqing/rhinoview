import { useCallback, useState } from 'react';
import type { ChartMarker } from '../chart/markers';
import { INDICATOR_PLACEMENT, isIntraday } from '@shared/types';
import type { ChartType, Timeframe } from '@shared/types';
import { ChartView } from '../chart';
import { useBarHistory, useCapabilities } from '../data';
import { IndicatorLegendRow, IndicatorMenu, useComputedIndicators, useIndicators } from '../panes';
import type { PaneLayout } from '../panes';
import { effectiveTimeframe, useActiveChart, useWorkspaceStatus } from '../workspace';
import { CrosshairLegend } from './CrosshairLegend';
import { StatusMessage } from './StatusMessage';
import { useI18n } from '../i18n';
import { describeError } from './errorCopy';

export interface ChartPanelProps {
  symbol: string;
  timeframe: Timeframe;
  chartType: ChartType;
  /** Phase 5 seam: flags on the price series, for example earnings. */
  markers?: readonly ChartMarker[];
}

/**
 * The chart plus everything layered on it: legend, and loading/empty/error states.
 * Until the workspace has loaded there is no real symbol or timeframe yet, so it waits
 * instead of fetching the placeholder chart and then the real one.
 */
export function ChartPanel(props: ChartPanelProps) {
  const { t } = useI18n();
  const status = useWorkspaceStatus();
  if (status === 'loading') {
    return (
      <div className="chart-panel">
        <div className="chart-overlay-center">
          <StatusMessage kind="loading" title={t('chart.loadingLayout')} />
        </div>
      </div>
    );
  }
  return <LoadedChartPanel {...props} />;
}

function LoadedChartPanel({ symbol, timeframe: savedTimeframe, chartType, markers }: ChartPanelProps) {
  // A saved timeframe the provider cannot serve is drawn as the nearest supported one.
  // The layout itself is untouched until the user picks (see TimeframeSelector).
  const { t } = useI18n();
  const timeframe = effectiveTimeframe(savedTimeframe, useCapabilities());
  const tfLabel = t(`timeframe.${timeframe}`);
  const history = useBarHistory(symbol, timeframe);
  const [hoverTime, setHoverTime] = useState<number | null>(null);
  // Indicators belong to the active layout, not to the symbol.
  const { chart, setIndicators } = useActiveChart();
  const indicatorState = useIndicators(chart.indicators, setIndicators);
  const computed = useComputedIndicators(history.bars, indicatorState.indicators);
  const [paneTops, setPaneTops] = useState<PaneLayout>({});
  // Measured on every layout pass; only a real change may cause a render.
  const onPaneLayout = useCallback((next: PaneLayout) => {
    setPaneTops((prev) => {
      const keys = Object.keys(next);
      return keys.length === Object.keys(prev).length && keys.every((k) => prev[k] === next[k]) ? prev : next;
    });
  }, []);
  const overlays = computed.filter((c) => INDICATOR_PLACEMENT[c.config.kind] === 'overlay');
  const separate = computed.filter((c) => INDICATOR_PLACEMENT[c.config.kind] === 'separate');

  const retry = (onClick: () => void) => (
    <button type="button" className="button" onClick={onClick}>
      {t('common.retry')}
    </button>
  );

  return (
    <div className="chart-panel">
      {/* The chart stays mounted under the overlays so switching states never rebuilds it. */}
      <ChartView
        bars={history.bars}
        chartType={chartType}
        intraday={isIntraday(timeframe)}
        onCrosshairTime={setHoverTime}
        onNearStart={history.loadOlder}
        indicators={computed}
        onPaneLayout={onPaneLayout}
        {...(markers ? { markers } : {})}
      />

      {history.status === 'ready' && history.bars.length > 0 && (
        <div className="chart-overlay-top">
          <div className="legend-title">
            {symbol} · {tfLabel}
          </div>
          <CrosshairLegend bars={history.bars} hoverTime={hoverTime} />
          {overlays.map((item) => (
            <IndicatorLegendRow key={item.config.id} item={item} hoverTime={hoverTime} />
          ))}
        </div>
      )}

      {/* Each separate indicator's legend sits at the top of its own pane. */}
      {history.status === 'ready' &&
        history.bars.length > 0 &&
        separate.map((item) => {
          const top = paneTops[item.config.id];
          return top === undefined ? null : (
            <IndicatorLegendRow key={item.config.id} item={item} hoverTime={hoverTime} top={top} />
          );
        })}

      <div className="chart-overlay-tools">
        <IndicatorMenu items={computed} actions={indicatorState} />
      </div>

      {history.status === 'loading' && (
        <div className="chart-overlay-center">
          <StatusMessage kind="loading" title={t('chart.loading', { symbol, timeframe: tfLabel })} />
        </div>
      )}

      {history.status === 'error' && history.error && (
        <div className="chart-overlay-center">
          <ErrorBlock error={history.error} retry={retry(history.reload)} />
        </div>
      )}

      {history.status === 'ready' && history.bars.length === 0 && (
        <div className="chart-overlay-center">
          <StatusMessage
            kind="empty"
            title={t('chart.emptyTitle', { symbol, timeframe: tfLabel })}
            detail={t('chart.emptyDetail')}
          />
        </div>
      )}

      <div className="chart-overlay-bottom" aria-live="polite">
        {history.loadingOlder && <span className="chip">{t('chart.loadingOlder')}</span>}
        {history.olderError && (
          <span className="chip chip-error" role="alert">
            {t('chart.olderFailed', { reason: describeError(history.olderError, 'history').title })}
            {describeError(history.olderError, 'history').retryable && (
              <button type="button" className="link-button" onClick={history.retryOlder}>
                {t('common.retry')}
              </button>
            )}
          </span>
        )}
        {history.truncated && !history.loadingOlder && !history.exhausted && (
          <span
            className="chip"
            title={t('chart.moreHistoryTitle')}
          >
            {t('chart.moreHistory')}
          </span>
        )}
      </div>
    </div>
  );
}

function ErrorBlock({ error, retry }: { error: Parameters<typeof describeError>[0]; retry: React.ReactNode }) {
  const copy = describeError(error, 'chart');
  return (
    <StatusMessage kind="error" title={copy.title} detail={copy.detail} action={copy.retryable ? retry : undefined} />
  );
}
