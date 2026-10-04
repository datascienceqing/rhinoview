/**
 * `GET /api/fundamentals/*`. PHASE 5 STUB — Worker W2 implements.
 * See docs/CONTRACT.md and server/fundamentals/types.ts.
 */
import type { FastifyInstance } from 'fastify';
import type { FundamentalsProvider } from '../fundamentals/types';

export interface FundamentalsRouteDeps {
  fundamentals: FundamentalsProvider;
}

export function registerFundamentalsRoutes(_app: FastifyInstance, _deps: FundamentalsRouteDeps): void {
  // W2: register GET /api/fundamentals/overview, /statements and /earnings here.
}
