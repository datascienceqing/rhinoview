/** Workspace store factory. Obeys the invariants in `./types.ts`. */
import { openWorkspaceStore } from './store';
import type { WorkspaceStoreOptions } from './store';
import type { WorkspaceStore } from './types';

export type { WorkspaceStore } from './types';
export { WorkspaceConflictError, WorkspaceNotFoundError, WorkspaceValidationError } from './types';
export type { WorkspaceFs, WorkspaceStoreOptions } from './store';

/**
 * Open (or create) the workspace file. Never returns null; the signature keeps the
 * frozen `server/index.ts` call site compiling.
 */
export async function createWorkspaceStore(
  filePath: string,
  opts?: WorkspaceStoreOptions,
): Promise<WorkspaceStore | null> {
  return openWorkspaceStore(filePath, opts);
}
