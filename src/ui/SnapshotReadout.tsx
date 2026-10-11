import type { Snapshot } from '@shared/types';
import { useAsync, useDataSource } from '../data';
import { useI18n } from '../i18n';
import { describeError } from './errorCopy';
import { directionClass, formatChange, formatPercent, formatPrice } from './format';

export interface SnapshotReadoutProps {
  symbol: string;
  name: string | null;
}

/** Header quote: price, absolute and percent change, and a loud DELAYED badge when applicable. */
export function SnapshotReadout({ symbol, name }: SnapshotReadoutProps) {
  const { t } = useI18n();
  const ds = useDataSource();
  const snapshot = useAsync(symbol, (signal) => ds.getSnapshot(symbol, { signal }));

  return (
    <div className="readout" data-testid="snapshot-readout">
      <div className="readout-id">
        <span className="readout-symbol">{symbol}</span>
        {name && <span className="readout-name">{name}</span>}
      </div>
      {snapshot.status === 'success' && <Quote snapshot={snapshot.data} />}
      {snapshot.status === 'loading' && (
        <span className="readout-note" role="status">
          {t('quote.loading')}
        </span>
      )}
      {snapshot.status === 'error' && (
        <QuoteError error={snapshot.error} onRetry={snapshot.reload} />
      )}
    </div>
  );
}

function Quote({ snapshot }: { snapshot: Snapshot }) {
  const { t } = useI18n();
  const dir = directionClass(snapshot.change);
  return (
    <>
      <span className="readout-price" data-testid="snapshot-price">
        {formatPrice(snapshot.price)}
      </span>
      <span className={`readout-change ${dir}`} data-testid="snapshot-change">
        {formatChange(snapshot.change)}
      </span>
      <span className={`readout-change ${dir}`} data-testid="snapshot-change-percent">
        {formatPercent(snapshot.changePercent)}
      </span>
      {snapshot.delayed && (
        <span
          className="badge-delayed"
          data-testid="delayed-badge"
          title={t('quote.delayedTitle')}
        >
          {t('quote.delayed')}
        </span>
      )}
    </>
  );
}

function QuoteError({ error, onRetry }: { error: Parameters<typeof describeError>[0]; onRetry: () => void }) {
  const { t } = useI18n();
  const copy = describeError(error, 'quote');
  return (
    <span className="readout-note readout-error" role="alert">
      {t('quote.unavailable', { reason: copy.title })}
      {copy.retryable && (
        <button type="button" className="link-button" onClick={onRetry}>
          {t('common.retry')}
        </button>
      )}
    </span>
  );
}
