/**
 * Proxy server entry point. Phase 0 scaffold — Worker A owns routes and the
 * upstream client. Keep this file thin: boot, plugins, route registration, listen.
 */
import Fastify from 'fastify';
import { env, redact } from './env';

export function buildServer() {
  const app = Fastify({
    logger: {
      level: process.env.NODE_ENV === 'test' ? 'silent' : 'info',
      // Belt-and-braces: even if a URL carrying the key reaches the logger, redact it.
      serializers: {
        req: (req) => ({ method: req.method, url: redact(req.url) }),
      },
    },
  });

  // Routes are registered here in Phase 1:
  //   app.register(barsRoutes);
  //   app.register(searchRoutes);
  //   app.register(snapshotRoutes);
  //   app.register(indicatorRoutes);

  app.get('/api/health', async () => ({ ok: true as const, data: { status: 'up' } }));

  return app;
}

// Only listen when run directly, so tests can import buildServer() without binding a port.
const isDirectRun = process.argv[1]?.endsWith('server/index.ts') ?? false;
if (isDirectRun) {
  const app = buildServer();
  app.listen({ port: env.SERVER_PORT, host: '127.0.0.1' }).catch((err: unknown) => {
    app.log.error(err);
    process.exit(1);
  });
}
