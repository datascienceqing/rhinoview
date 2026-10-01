import { describe, expect, it, vi } from 'vitest';
import { RateLimitedError } from './errors';
import { InjectedFaultError, NO_FAULTS, createFaultInjector } from './faults';

describe('createFaultInjector', () => {
  it('does nothing, and draws no randomness, when every fault is off', async () => {
    const random = vi.fn(() => 0);
    const sleep = vi.fn(() => Promise.resolve());
    await createFaultInjector(NO_FAULTS, random, sleep).gate();
    expect(random).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
  });

  it('sleeps for the latency before drawing', async () => {
    const order: string[] = [];
    const injector = createFaultInjector(
      { ...NO_FAULTS, latencyMs: 40 },
      () => (order.push('draw'), 0.5),
      () => (order.push('sleep'), Promise.resolve()),
    );
    await injector.gate();
    expect(order).toEqual(['sleep', 'draw']);
  });

  it('throws RateLimitedError with retryAfterSeconds for draws below rateLimitRate', async () => {
    const injector = createFaultInjector({ ...NO_FAULTS, rateLimitRate: 0.5, retryAfterSeconds: 9 }, () => 0.49);
    await expect(injector.gate()).rejects.toMatchObject({ name: 'RateLimitedError', retryAfterSeconds: 9 });
    await expect(injector.gate()).rejects.toBeInstanceOf(RateLimitedError);
  });

  it('throws an injected upstream failure for draws in the error slice', async () => {
    const injector = createFaultInjector({ ...NO_FAULTS, rateLimitRate: 0.25, errorRate: 0.25 }, () => 0.3);
    await expect(injector.gate()).rejects.toBeInstanceOf(InjectedFaultError);
  });

  it('passes for draws at or above rateLimitRate + errorRate', async () => {
    const injector = createFaultInjector({ ...NO_FAULTS, rateLimitRate: 0.25, errorRate: 0.25 }, () => 0.5);
    await expect(injector.gate()).resolves.toBeUndefined();
  });
});
