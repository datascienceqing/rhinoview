/**
 * Proxy server entry point. Keep this file thin: boot, plugins, route registration,
 * listen. Logic lives in `server/provider/`, `server/routes/` and `server/cache/`.
 */
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { BarsCache } from './cache/barsCache';
import { env, redact } from './env';
import type { MarketEngine } from './market/types';
import { selectEngine } from './provider/engine';
import { NO_FAULTS, createFaultInjector, faultsFromEnv } from './provider/faults';
import type { FaultConfig } from './provider/faults';
import { MarketService } from './provider/service';
import { registerApiRoutes } from './routes';
import { registerFundamentalsRoutes } from './routes/fundamentals';
import { registerQuotesRoutes } from './routes/quotes';
import { registerWorkspaceRoutes } from './routes/workspace';
import { registerAlertsRoutes } from './routes/alerts';
import { openAlertsStore } from './alerts/store';
import type { AlertsStore } from './alerts/store';
import { UNAVAILABLE_FUNDAMENTALS, createFundamentalsProvider } from './fundamentals';
import type { FundamentalsProvider } from './fundamentals';
import { createWorkspaceStore } from './workspace';
import type { WorkspaceStore } from './workspace';

export interface BuildServerOptions {
  /** The engine to serve from. Required: selection is async, see `createServer`. */
  engine: MarketEngine;
  /** Fault injection. Defaults to none — a caller-supplied engine is not the synthetic provider. */
  faults?: FaultConfig;
  /** Provider label for `/api/capabilities`. Diagnostics only. */
  provider?: string;
  cache?: BarsCache;
  now?: () => number;
  /** Cap on bars per response; tests shrink it to exercise truncation cheaply. */
  maxBars?: number;
  /** Test seams for fault injection. */
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Phase 5. Defaults to a provider that serves nothing. */
  fundamentals?: FundamentalsProvider;
  /** Phase 5. Null means the workspace routes answer "not implemented". */
  workspace?: WorkspaceStore | null;
  /** Null means the alerts routes answer "not implemented". */
  alerts?: AlertsStore | null;
}

export function buildServer(opts: BuildServerOptions): FastifyInstance {
  const app = Fastify({
    logger: {
      level: process.env.NODE_ENV === 'test' ? 'silent' : 'info',
      // Belt-and-braces: even if a URL carrying the key reaches the logger, redact it.
      serializers: {
        req: (req) => ({ method: req.method, url: redact(req.url) }),
      },
    },
  });

  const service = new MarketService({
    engine: opts.engine,
    ...(opts.provider ? { provider: opts.provider } : {}),
    faults: createFaultInjector(opts.faults ?? NO_FAULTS, opts.random, opts.sleep),
    ...(opts.cache ? { cache: opts.cache } : {}),
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.maxBars ? { maxBars: opts.maxBars } : {}),
    log: app.log,
  });

  app.get('/api/health', async () => ({ ok: true as const, data: { status: 'up' } }));
  const fundamentals = opts.fundamentals ?? UNAVAILABLE_FUNDAMENTALS;
  registerApiRoutes(app, service, { fundamentalsAvailable: fundamentals.available });
  registerQuotesRoutes(app, { service });
  registerFundamentalsRoutes(app, { fundamentals });
  registerWorkspaceRoutes(app, { store: opts.workspace ?? null });
  registerAlertsRoutes(app, { store: opts.alerts ?? null });

  return app;
}

/** Production wiring: engine and fault injection both chosen from `env`. */
export async function createServer(): Promise<FastifyInstance> {
  const engine = await selectEngine(); // throws for DATA_PROVIDER=massive — fail at boot, not per request
  const fundamentals = await createFundamentalsProvider();
  const workspace = await createWorkspaceStore(env.WORKSPACE_FILE);
  const alerts = await openAlertsStore(env.ALERTS_FILE);
  return buildServer({ engine, provider: env.DATA_PROVIDER, faults: faultsFromEnv(), fundamentals, workspace, alerts });
}

// Only listen when run directly, so tests can import buildServer() without binding a port.
const isDirectRun = process.argv[1]?.endsWith('server/index.ts') ?? false;
if (isDirectRun) {
  try {
    const app = await createServer();
    await app.listen({ port: env.SERVER_PORT, host: '127.0.0.1' });
  } catch (err: unknown) {
    // One clear line, not a stack trace: the usual cause is a configuration problem.
    console.error(`Failed to start: ${redact(err instanceof Error ? err.message : String(err))}`);
    process.exit(1);
  }
}
