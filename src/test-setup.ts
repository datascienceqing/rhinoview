import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { server } from '../mocks/server';
import { applyLocale } from './i18n/locale';

// Any request without a handler is a test bug (or a component calling fetch for
// something the mocks do not cover) — fail loudly rather than hit the network.
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
  // A test that switched to Chinese must not leak it: non-React code reads the language globally.
  applyLocale('en');
});
afterAll(() => server.close());
