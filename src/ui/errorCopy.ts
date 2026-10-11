import type { DataError } from '../data/errors';
import { t } from '../i18n';

export interface ErrorCopy {
  title: string;
  detail: string;
  /** Whether trying the same request again could plausibly succeed. */
  retryable: boolean;
}

export type Subject = 'chart' | 'quote' | 'search' | 'history' | 'workspace' | 'watchlist' | 'fundamentals';

/**
 * User-facing copy for a failure, in the current language. Branches on `error.code`
 * only — never on `error.message`, which the contract lets the server reword at will.
 */
export function describeError(error: DataError, subject: Subject): ErrorCopy {
  const noun = t(`error.subject.${subject}`);
  switch (error.code) {
    case 'UNKNOWN_SYMBOL':
      return { title: t('error.unknownSymbol.title'), detail: t('error.unknownSymbol.detail'), retryable: false };
    case 'RATE_LIMITED': {
      const wait = error.retryAfterSeconds;
      return {
        title: t('error.rateLimited.title'),
        detail: wait !== undefined ? t('error.rateLimited.wait', { seconds: wait }) : t('error.rateLimited.detail'),
        retryable: true,
      };
    }
    case 'UPSTREAM_ERROR':
      return { title: t('error.upstream.title'), detail: t('error.upstream.detail', { noun }), retryable: true };
    case 'UPSTREAM_TIMEOUT':
      return { title: t('error.timeout.title'), detail: t('error.timeout.detail', { noun }), retryable: true };
    case 'NETWORK':
      return { title: t('error.network.title'), detail: t('error.network.detail', { noun }), retryable: true };
    case 'UNAUTHORIZED':
      return { title: t('error.unauthorized.title'), detail: t('error.unauthorized.detail'), retryable: false };
    case 'NO_DATA':
      return { title: t('error.noData.title'), detail: t('error.noData.detail'), retryable: false };
    case 'NOT_FOUND':
      return { title: t('error.notFound.title'), detail: t('error.notFound.detail'), retryable: false };
    case 'CONFLICT':
      return { title: t('error.conflict.title'), detail: t('error.conflict.detail'), retryable: false };
    case 'BAD_REQUEST':
      return { title: t('error.badRequest.title'), detail: t('error.badRequest.detail'), retryable: false };
    case 'BAD_RESPONSE':
    case 'INTERNAL':
    case 'ABORTED':
      return { title: t('error.internal.title'), detail: t('error.internal.detail', { noun }), retryable: true };
  }
}
