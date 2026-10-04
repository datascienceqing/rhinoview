/**
 * Workspace store factory. PHASE 5 STUB — Worker W3 replaces the body.
 *
 * Until W3 lands, the workspace routes answer INTERNAL "not implemented".
 */
import type { WorkspaceStore } from './types';

export type { WorkspaceStore } from './types';
export { WorkspaceConflictError, WorkspaceNotFoundError, WorkspaceValidationError } from './types';

export async function createWorkspaceStore(_filePath: string): Promise<WorkspaceStore | null> {
  return null;
}
