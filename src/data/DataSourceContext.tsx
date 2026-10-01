import { createContext, useContext } from 'react';
import type { DataSource } from './DataSource';

const DataSourceContext = createContext<DataSource | null>(null);

export const DataSourceProvider = DataSourceContext.Provider;

/** Components get data through this hook and nothing else — never via fetch. */
export function useDataSource(): DataSource {
  const ds = useContext(DataSourceContext);
  if (!ds) throw new Error('useDataSource must be used inside <DataSourceProvider>');
  return ds;
}
