import { setupWorker } from 'msw/browser';
import { createHandlers } from './handlers';

/** Dev latency so loading states are visible rather than flashing past. */
export const worker = setupWorker(...createHandlers({ latencyMs: 400 }));
