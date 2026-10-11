import type { ReactNode } from 'react';
import type { AsyncState } from '../data';
import { describeError } from '../ui/errorCopy';
import { StatusMessage } from '../ui/StatusMessage';
import { useI18n } from '../i18n';

type Props<T> = {
  state: AsyncState<T> & { reload: () => void };
  loading: string;
  children: (data: T) => ReactNode;
};

/** Loading, error (with retry when it can help) and success for one fundamentals request. */
export function AsyncBlock<T>({ state, loading, children }: Props<T>) {
  const { t } = useI18n();
  if (state.status === 'success') return <>{children(state.data)}</>;
  if (state.status === 'error') {
    const copy = describeError(state.error, 'fundamentals');
    return (
      <StatusMessage
        kind="error"
        title={copy.title}
        detail={copy.detail}
        action={
          copy.retryable ? (
            <button type="button" className="fund-retry" onClick={state.reload}>
              {t('common.retry')}
            </button>
          ) : undefined
        }
      />
    );
  }
  return <StatusMessage kind="loading" title={loading} />;
}
