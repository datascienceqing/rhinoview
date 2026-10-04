/**
 * Public surface of the client workspace. App.tsx imports `WorkspaceProvider` from here
 * and never changes: W4 swaps WHICH provider this exports, from in-memory to persistent.
 */
export type { ActiveChart, ActiveChartApi } from './types';
export { DEFAULT_ACTIVE_CHART } from './types';
export { useActiveChart, InMemoryWorkspaceProvider } from './ActiveChartContext';
export { InMemoryWorkspaceProvider as WorkspaceProvider } from './ActiveChartContext';
