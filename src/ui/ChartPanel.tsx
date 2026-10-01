import { useState } from 'react';
import { isIntraday } from '@shared/types';
import type { ChartType, Timeframe } from '@shared/types';
import { ChartView } from '../chart';
import { useBarHistory } from '../data';
import { CrosshairLegend } from './CrosshairLegend';
import { StatusMessage } from './StatusMessage';
import { describeError } from './errorCopy';

export interface ChartPanelProps {
  symbol: string;
  timeframe: Timeframe;
  chartType: ChartType;
}

/** The chart plus everything layered on it: legend, and loading/empty/error states. */
export function ChartPanel({ symbol, timeframe, chartType }: ChartPanelProps) {
  const history = useBarHistory(symbol, timeframe);
  const [hoverTime, setHoverTime] = useState<number | null>(null);

  const retry = (onClick: () => void) => (
    <button type="button" className="button" onClick={onClick}>
      Retry
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
      />

      {history.status === 'ready' && history.bars.length > 0 && (
        <div className="chart-overlay-top">
          <div className="legend-title">
            {symbol} · {timeframe}
          </div>
          <CrosshairLegend bars={history.bars} hoverTime={hoverTime} />
        </div>
      )}

      {history.status === 'loading' && (
        <div className="chart-overlay-center">
          <StatusMessage kind="loading" title={`Loading ${symbol} ${timeframe}…`} />
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
            title={`No ${timeframe} data for ${symbol}`}
            detail="The data provider returned no bars for this symbol and timeframe in the recent past. Try a longer timeframe."
          />
        </div>
      )}

      <div className="chart-overlay-bottom" aria-live="polite">
        {history.loadingOlder && <span className="chip">Loading older history…</span>}
        {history.olderError && (
          <span className="chip chip-error" role="alert">
            {describeError(history.olderError, 'history').title}: couldn’t load older history.
            {describeError(history.olderError, 'history').retryable && (
              <button type="button" className="link-button" onClick={history.retryOlder}>
                Retry
              </button>
            )}
          </span>
        )}
        {history.truncated && !history.loadingOlder && !history.exhausted && (
          <span
            className="chip"
            title="The server returned only the newest bars of the requested range. There is no gap; older bars load as you scroll left."
          >
            More history available · scroll left
          </span>
        )}
      </div>
    </div>
  );
}

function ErrorBlock({
  error,
  retry,
}: {
  error: Parameters<typeof describeError>[0];
  retry: React.ReactNode;
}) {
  const copy = describeError(error, 'chart');
  return <StatusMessage kind="error" title={copy.title} detail={copy.detail} action={copy.retryable ? retry : undefined} />;
}
