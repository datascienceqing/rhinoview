import { useCallback, useMemo, useState } from 'react';
import type { ChartMarker } from '../chart/markers';
import { INDICATOR_PLACEMENT, isIntraday } from '@shared/types';
import type { ChartType, Timeframe } from '@shared/types';
import { ChartView } from '../chart';
import type { ChartMenuTarget } from '../chart';
import { ChartContextMenu } from '../chart/ChartContextMenu';
import type { ChartMenuItem } from '../chart/ChartContextMenu';
import { ALERT_INDICATOR_KINDS } from '@shared/types';
import type { AlertIndicatorKind, AlertTarget, IndicatorConfig } from '@shared/types';
import { CLOSE_TARGET_KINDS } from '../alerts/condition';
import { useAlerts } from '../alerts/AlertsProvider';
import { formatLevel, formatValue, roundLevel } from '../alerts/describe';
import { LINE_KEYS } from '../indicators/types';
import { indicatorTitle } from '../panes/config';
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
  /** The chart menu's Financials item; omitted when the server serves no fundamentals. */
  onOpenFinancials?: () => void;
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

function LoadedChartPanel({ symbol, timeframe: savedTimeframe, chartType, markers, onOpenFinancials }: ChartPanelProps) {
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
  const { alerts, openDialog } = useAlerts();
  const [menu, setMenu] = useState<ChartMenuTarget | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  // Active price alerts of this symbol draw a line (plan section 4.7).
  const alertLevels = useMemo(
    () => alerts.filter((a) => a.symbol === symbol && a.status === 'active' && a.condition.type === 'price').map((a) => (a.condition as { level: number }).level),
    [alerts, symbol],
  );

  /** An indicator alert draft on the first line of `config`. */
  function openIndicatorDialog(config: IndicatorConfig, kind: AlertIndicatorKind, target: AlertTarget) {
    openDialog({
      symbol,
      condition: {
        type: 'indicator',
        timeframe,
        indicator: { kind, params: structuredClone(config.params) },
        line: LINE_KEYS[kind][0] as string,
        direction: 'cross',
        target,
      },
    });
  }

  /**
   * The add-alert items for the point under the menu. On the price pane: the price, then each
   * visible SMA or EMA (they share the price scale, so the target is the close). On an
   * indicator pane: that indicator at the value under the pointer.
   */
  function alertItems(target: ChartMenuTarget): ChartMenuItem[] {
    if (target.pane === 'price') {
      const items: ChartMenuItem[] = [];
      const level = roundLevel(target.price);
      if (level > 0) {
        items.push({
          id: 'alert',
          label: t('menu.addAlert', { price: formatLevel(level) }),
          onSelect: () => openDialog({ symbol, condition: { type: 'price', direction: 'cross', level } }),
        });
      }
      for (const config of indicatorState.indicators) {
        const kind = config.kind as AlertIndicatorKind;
        if (!config.visible || !CLOSE_TARGET_KINDS.includes(kind)) continue;
        items.push({
          id: `alert-${config.id}`,
          label: t('menu.addOverlayAlert', { indicator: indicatorTitle(config) }),
          onSelect: () => openIndicatorDialog(config, kind, { type: 'close' }),
        });
      }
      return items;
    }
    const config = indicatorState.indicators.find((c) => c.id === target.indicatorId);
    if (!config || !(ALERT_INDICATOR_KINDS as readonly string[]).includes(config.kind)) return [];
    const kind = config.kind as AlertIndicatorKind;
    const value = Number(formatValue(target.value));
    return [
      {
        id: 'alert',
        label: t('menu.addIndicatorAlert', { indicator: indicatorTitle(config), value: formatValue(value) }),
        onSelect: () => openIndicatorDialog(config, kind, { type: 'value', value }),
      },
    ];
  }

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
        onContextMenu={setMenu}
        alertLevels={alertLevels}
      />

      {menu && (
        <ChartContextMenu
          x={menu.x}
          y={menu.y}
          alertItems={alertItems(menu)}
          {...(onOpenFinancials ? { onFinancials: onOpenFinancials } : {})}
          onClose={closeMenu}
        />
      )}

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
