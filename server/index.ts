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
import { AlertScheduler } from './alerts/scheduler';
import { serviceAlertSource } from './alerts/source';
import { QuotesCache } from './cache/quotesCache';
import { UNAVAILABLE_FUNDAMENTALS, createFundamentalsProvider } from './fundamentals';
import type { FundamentalsProvider } from './fundamentals';
import { createWorkspaceStore } from './workspace';
import { DeepSeekClient } from './ai/deepseek';
import type { ChatClient } from './ai/deepseek';
import { registerAiRoutes } from './routes/ai';
import { openAnalysesStore } from './ai/analyses';
import type { AnalysesStore } from './ai/analyses';
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
  /**
   * Run the alert checker. Off unless given: tests that only need the routes start no timers.
   * `budgetPerMinute` null means no cap (the synthetic provider).
   */
  alertChecks?: { budgetPerMinute: number | null; tickMs?: number };
  /** The AI helper. Omitted or a null client: the AI endpoints answer "not configured". */
  ai?: { client: ChatClient | null; dailyLimit: number; analyses?: AnalysesStore | null };
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
  registerApiRoutes(app, service, { fundamentalsAvailable: fundamentals.available, aiAvailable: Boolean(opts.ai?.client) });
  // One quote cache for the watchlist and the alert checker: a symbol in both costs one call.
  const quotesCache = new QuotesCache();
  registerQuotesRoutes(app, { service, cache: quotesCache });
  registerFundamentalsRoutes(app, { fundamentals });
  registerWorkspaceRoutes(app, { store: opts.workspace ?? null });
  registerAiRoutes(app, {
    service,
    fundamentals,
    now: opts.now ?? (() => Math.floor(Date.now() / 1000)),
    provider: service.capabilities().provider,
    client: opts.ai?.client ?? null,
    dailyLimit: opts.ai?.dailyLimit ?? 0,
    alerts: opts.alerts ?? null,
    analyses: opts.ai?.analyses ?? null,
  });
  let scheduler: AlertScheduler | null = null;
  if (opts.alerts && opts.alertChecks) {
    const checker = new AlertScheduler({
      store: opts.alerts,
      source: serviceAlertSource(service, quotesCache),
      now: opts.now ?? (() => Math.floor(Date.now() / 1000)),
      budgetPerMinute: opts.alertChecks.budgetPerMinute,
      warn: (m) => app.log.warn(m),
      notify: (m) => opts.alerts?.publish(m),
    });
    checker.start(opts.alertChecks.tickMs);
    const store = opts.alerts;
    app.addHook('onClose', async () => {
      checker.stop();
      // A clean stop saves the state-only changes that still wait for their write.
      await store.flush(true);
    });
    scheduler = checker;
  }
  registerAlertsRoutes(app, {
    store: opts.alerts ?? null,
    ...(scheduler ? { checkIntervalSeconds: () => (scheduler as AlertScheduler).checkIntervalSeconds() } : {}),
  });

  return app;
}

/** Production wiring: engine and fault injection both chosen from `env`. */
export async function createServer(): Promise<FastifyInstance> {
  const engine = await selectEngine(); // throws for DATA_PROVIDER=massive — fail at boot, not per request
  const fundamentals = await createFundamentalsProvider();
  const workspace = await createWorkspaceStore(env.WORKSPACE_FILE);
  const alerts = await openAlertsStore(env.ALERTS_FILE);
  return buildServer({ engine, provider: env.DATA_PROVIDER, faults: faultsFromEnv(), fundamentals,
    workspace,
    alerts,
    alertChecks: { budgetPerMinute: env.DATA_PROVIDER === 'synthetic' ? null : env.ALERT_CALL_BUDGET },
    ai: {
      client: env.DEEPSEEK_API_KEY
        ? new DeepSeekClient({ apiKey: env.DEEPSEEK_API_KEY, baseUrl: env.DEEPSEEK_BASE_URL, model: env.DEEPSEEK_MODEL })
        : null,
      dailyLimit: env.AI_DAILY_CALL_LIMIT,
      analyses: await openAnalysesStore(env.AI_ANALYSES_FILE),
    },
  });
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
