/**
 * `/api/workspace`, `/api/layouts`, `/api/watchlists`. PHASE 5 STUB — Worker W3 implements.
 * See docs/CONTRACT.md and server/workspace/types.ts.
 */
import type { FastifyInstance } from 'fastify';
import type { WorkspaceStore } from '../workspace/types';

export interface WorkspaceRouteDeps {
  /** Null until the store exists; the routes then answer INTERNAL "not implemented". */
  store: WorkspaceStore | null;
}

export function registerWorkspaceRoutes(_app: FastifyInstance, _deps: WorkspaceRouteDeps): void {
  // W3: register the workspace, layout and watchlist routes here.
}
