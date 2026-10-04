import type { DataError } from '../data/errors';

export interface ErrorCopy {
  title: string;
  detail: string;
  /** Whether trying the same request again could plausibly succeed. */
  retryable: boolean;
}

export type Subject = 'chart' | 'quote' | 'search' | 'history' | 'workspace' | 'watchlist' | 'fundamentals';

const NOUN: Record<Subject, string> = {
  chart: 'chart data',
  quote: 'the quote',
  search: 'search results',
  history: 'older history',
  workspace: 'your saved charts',
  watchlist: 'the watchlist',
  fundamentals: 'financial data',
};

/**
 * User-facing copy for a failure. Branches on `error.code` only — never on
 * `error.message`, which the contract lets the server reword at will.
 */
export function describeError(error: DataError, subject: Subject): ErrorCopy {
  const noun = NOUN[subject];
  switch (error.code) {
    case 'UNKNOWN_SYMBOL':
      return {
        title: 'Symbol not found',
        detail: 'We could not find that symbol. Check the spelling or search for another.',
        retryable: false,
      };
    case 'RATE_LIMITED': {
      const wait = error.retryAfterSeconds;
      return {
        title: 'Too many requests',
        detail:
          wait !== undefined
            ? `The data provider is rate limiting us. Try again in ${wait} second${wait === 1 ? '' : 's'}.`
            : 'The data provider is rate limiting us. Wait a moment and try again.',
        retryable: true,
      };
    }
    case 'UPSTREAM_ERROR':
      return {
        title: 'Data provider error',
        detail: `The data provider failed while loading ${noun}. This is usually temporary.`,
        retryable: true,
      };
    case 'UPSTREAM_TIMEOUT':
      return {
        title: 'Data provider timed out',
        detail: `The data provider took too long to return ${noun}. Try again.`,
        retryable: true,
      };
    case 'NETWORK':
      return {
        title: 'Connection lost',
        detail: `Could not reach the server to load ${noun}. Check your internet connection and try again.`,
        retryable: true,
      };
    case 'UNAUTHORIZED':
      return {
        title: 'Data access not authorised',
        detail: 'The server’s market-data credentials were rejected or do not cover this data. This needs an administrator.',
        retryable: false,
      };
    case 'NO_DATA':
      return {
        title: 'No data available',
        detail: 'The data provider has no data for this symbol and range.',
        retryable: false,
      };
    case 'NOT_FOUND':
      return {
        title: 'No longer exists',
        detail: 'That item was deleted, possibly from another tab. Reload to see the current list.',
        retryable: false,
      };
    case 'CONFLICT':
      return {
        title: 'Changed elsewhere',
        detail: 'This was edited in another tab or window. Your view has been refreshed; reapply your change.',
        retryable: false,
      };
    case 'BAD_REQUEST':
      return {
        title: 'Invalid request',
        detail: 'The request was rejected as invalid. This is a bug in the app, not something you did.',
        retryable: false,
      };
    case 'BAD_RESPONSE':
    case 'INTERNAL':
    case 'ABORTED':
      return {
        title: 'Something went wrong',
        detail: `An unexpected error occurred while loading ${noun}. Try again.`,
        retryable: true,
      };
  }
}
