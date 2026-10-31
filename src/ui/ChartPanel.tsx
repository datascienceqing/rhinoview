import { useCallback, useMemo, useState } from 'react';
import type { ChartMarker } from '../chart/markers';
import { INDICATOR_PLACEMENT, isIntraday } from '@shared/types';
import type { ChartType, Timeframe } from '@shared/types';
import { ChartView } from '../chart';
import type { ChartMenuTarget } from '../chart';
import { ChartContextMenu } from '../chart/ChartContextMenu';
import type { ChartMenuItem } from '../chart/ChartContextMenu';
import { ALERT_INDICATOR_KINDS } from '@shared/types';
import type { AlertCondition, AlertIndicatorKind, AlertTarget, ConfluenceParams, IndicatorConfig } from '@shared/types';
import { CLOSE_TARGET_KINDS } from '../alerts/condition';
import { useAlerts } from '../alerts/AlertsProvider';
import { formatLevel, formatValue, roundLevel } from '../alerts/describe';
import { LINE_KEYS } from '../indicators/types';
import { computeConfluence } from '../indicators/confluence';
import { indicatorTitle } from '../panes/config';
import { useBarHistory, useCapabilities } from '../data';
import { IndicatorLegendRow, IndicatorMenu, useComputedIndicators, useIndicators } from '../panes';
import { LatchHandles } from '../panes/confluence/LatchHandle';
import { DrawingTools } from '../drawings/DrawingTools';
import type { PriceChart } from '../chart/PriceChart';
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
  // The live chart, for the confluence latch handle; null while there is none.
  const [priceChart, setPriceChart] = useState<PriceChart | null>(null);
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
  // Active price alerts of this symbol draw a line (plan section 4.7); so do confluence alerts, at
  // their frozen level, because the indicator's own level can move away from it.
  const alertLevels = useMemo(
    () =>
      alerts
        .filter((a) => a.symbol === symbol && a.status === 'active')
        .flatMap((a) => (a.condition.type === 'price' ? [a.condition.level] : a.condition.type === 'confluence' ? [a.condition.lock.top] : [])),
    [alerts, symbol],
  );
  // The latched levels for the menu, computed only while it is open: the same math as the
  // drawing, so the alert keeps exactly the level the chart shows.
  const latchedLevels = useMemo(() => {
    if (menu?.pane !== 'price') return [];
    return indicatorState.indicators.flatMap((config) => {
      if (config.kind !== 'confluence' || !config.visible) return [];
      const params = config.params as ConfluenceParams;
      if (params.latch !== 'on' || params.latchTime <= 0) return [];
      try {
        const r = computeConfluence(history.bars, params);
        const lockBar = r.latch.lockIndex === null ? undefined : history.bars[r.latch.lockIndex];
        const primary = r.last?.primary;
        if (!r.latch.holds || !primary || !lockBar) return [];
        const condition: AlertCondition = {
          type: 'confluence',
          timeframe,
          params: structuredClone(params),
          lock: { bottom: primary.bottom, top: primary.top, count: primary.count, time: lockBar.time },
        };
        return [{ config, condition }];
      } catch {
        return [];
      }
    });
  }, [menu, indicatorState.indicators, history.bars, timeframe]);

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
      for (const { config, condition } of latchedLevels) {
        if (condition.type !== 'confluence') continue;
        items.push({
          id: `alert-${config.id}`,
          label: t('menu.addLatchAlert', { indicator: indicatorTitle(config), level: formatLevel(condition.lock.top) }),
          onSelect: () => openDialog({ symbol, condition }),
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
        onChart={setPriceChart}
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
        <LatchHandles
          chart={priceChart}
          bars={history.bars}
          indicators={indicatorState.indicators}
          intraday={isIntraday(timeframe)}
          onChange={indicatorState.setParams}
        />
      )}

      {history.status === 'ready' && history.bars.length > 0 && (
        <DrawingTools chart={priceChart} symbol={symbol} bars={history.bars} />
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
