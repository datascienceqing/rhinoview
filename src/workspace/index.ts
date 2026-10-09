/**
 * Public surface of the client workspace. App.tsx imports `WorkspaceProvider` from here
 * and never changes. It is the persistent provider (layouts on the server);
 * `InMemoryWorkspaceProvider` stays for tests and isolated components.
 */
export type { ActiveChart, ActiveChartApi } from './types';
export { DEFAULT_ACTIVE_CHART } from './types';
export { useActiveChart, InMemoryWorkspaceProvider } from './ActiveChartContext';
export { WorkspaceProvider, SAVE_DEBOUNCE_MS } from './WorkspaceProvider';
export { useLayouts, useWorkspaceStatus } from './layoutsContext';
export type { ActionResult, LayoutsApi, SaveState, WorkspaceStatus } from './layoutsContext';
export { effectiveTimeframe } from './timeframe';
