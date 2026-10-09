/**
 * `/api/workspace`, `/api/layouts`, `/api/watchlists`.
 * See docs/CONTRACT.md and server/workspace/types.ts.
 *
 * Bodies are validated with strict zod schemas (unknown fields -> BAD_REQUEST), then the
 * store applies the semantic rules. Store errors map to the contract:
 * not found -> 404 NOT_FOUND, stale revision -> 409 CONFLICT, validation -> 400 BAD_REQUEST.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ZodType } from 'zod';
import type { ApiResult } from '@shared/types';
import { ApiFailure, MESSAGES } from '../provider/errors';
import {
  createLayoutBodySchema,
  createWatchlistBodySchema,
  setActiveBodySchema,
  updateLayoutBodySchema,
  updateWatchlistBodySchema,
} from '../workspace/schemas';
import { WorkspaceConflictError, WorkspaceNotFoundError, WorkspaceValidationError } from '../workspace/types';
import type { WorkspaceStore } from '../workspace/types';
import { logUnexpected, sendFailure } from './envelope';

export interface WorkspaceRouteDeps {
  /** Null means "not available"; the routes then answer INTERNAL "not implemented". */
  store: WorkspaceStore | null;
}

function parseBody<T>(schema: ZodType<T>, body: unknown): T {
  // Fastify gives `undefined` for a missing body; treat it as an empty object so the
  // schema, not a crash, decides.
  const parsed = schema.safeParse(body ?? {});
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const where = issue && issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
  // zod's messages describe the schema, not user data, so they are safe to show.
  throw new ApiFailure('BAD_REQUEST', `Invalid request body. ${where}${issue?.message ?? ''}`.trim());
}

function toFailure(err: unknown): ApiFailure | null {
  if (err instanceof ApiFailure) return err;
  if (err instanceof WorkspaceNotFoundError) return new ApiFailure('NOT_FOUND', err.message);
  if (err instanceof WorkspaceConflictError) {
    return new ApiFailure('CONFLICT', 'This was changed elsewhere. Reload to see the latest version.');
  }
  if (err instanceof WorkspaceValidationError) return new ApiFailure('BAD_REQUEST', err.message);
  return null;
}

export function registerWorkspaceRoutes(app: FastifyInstance, deps: WorkspaceRouteDeps): void {
  async function respond<T>(reply: FastifyReply, status: number, body: (store: WorkspaceStore) => Promise<T>) {
    try {
      if (!deps.store) throw new ApiFailure('INTERNAL', 'Workspace storage is not implemented.');
      const data = await body(deps.store);
      return await reply.code(status).send({ ok: true, data } satisfies ApiResult<T>);
    } catch (err) {
      const failure = toFailure(err);
      if (failure) return sendFailure(reply, failure);
      logUnexpected(reply.log, err);
      return sendFailure(reply, new ApiFailure('INTERNAL', MESSAGES.internal));
    }
  }

  const idOf = (req: { params: unknown }) => String((req.params as { id: string }).id);

  app.get('/api/workspace', (_req, reply) => respond(reply, 200, (s) => s.getWorkspace()));

  app.get('/api/layouts', (_req, reply) =>
    respond(reply, 200, async (s) => {
      const { layouts, activeLayoutId } = await s.getWorkspace();
      return { layouts, activeLayoutId };
    }),
  );
  app.post('/api/layouts', (req, reply) =>
    respond(reply, 201, (s) => s.createLayout(parseBody(createLayoutBodySchema, req.body))),
  );
  app.put('/api/layouts/:id', (req, reply) =>
    respond(reply, 200, (s) => s.updateLayout(idOf(req), parseBody(updateLayoutBodySchema, req.body))),
  );
  app.delete('/api/layouts/:id', (req, reply) => respond(reply, 200, (s) => s.deleteLayout(idOf(req))));

  app.get('/api/watchlists', (_req, reply) =>
    respond(reply, 200, async (s) => {
      const { watchlists, activeWatchlistId } = await s.getWorkspace();
      return { watchlists, activeWatchlistId };
    }),
  );
  app.post('/api/watchlists', (req, reply) =>
    respond(reply, 201, (s) => s.createWatchlist(parseBody(createWatchlistBodySchema, req.body))),
  );
  app.put('/api/watchlists/:id', (req, reply) =>
    respond(reply, 200, (s) => s.updateWatchlist(idOf(req), parseBody(updateWatchlistBodySchema, req.body))),
  );
  app.delete('/api/watchlists/:id', (req, reply) => respond(reply, 200, (s) => s.deleteWatchlist(idOf(req))));

  app.put('/api/workspace/active', (req, reply) =>
    respond(reply, 200, (s) => s.setActive(parseBody(setActiveBodySchema, req.body))),
  );
}
