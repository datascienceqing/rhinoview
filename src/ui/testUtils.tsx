import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import type { DataSource } from '../data';
import { DataSourceProvider, HttpDataSource } from '../data';

/** Render under a data source; defaults to the real HttpDataSource served by MSW. */
export function renderWithDataSource(ui: ReactElement, ds: DataSource = new HttpDataSource()) {
  return render(<DataSourceProvider value={ds}>{ui}</DataSourceProvider>);
}

/** A DataSource where every method rejects unless overridden — unexpected calls fail loudly. */
export function fakeDataSource(overrides: Partial<DataSource> = {}): DataSource {
  const unexpected = (name: string) => () => Promise.reject(new Error(`unexpected ${name} call`));
  return {
    searchSymbols: unexpected('searchSymbols'),
    getBars: unexpected('getBars'),
    getSnapshot: unexpected('getSnapshot'),
    ...overrides,
  };
}
