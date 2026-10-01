import { isAbortError } from './errors';
import { LatestOnly } from './latest';

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('LatestOnly', () => {
  it('delivers the newest result even when an older request resolves after it', async () => {
    const latest = new LatestOnly();
    const slow = deferred<string>();
    const fast = deferred<string>();

    const first = latest.run(() => slow.promise);
    const second = latest.run(() => fast.promise);

    fast.resolve('new');
    await expect(second).resolves.toBe('new');

    // The older response lands late — and must be rejected, not delivered.
    slow.resolve('stale');
    await expect(first).rejects.toSatisfy(isAbortError);
  });

  it('drops a stale result even when the task ignores its abort signal', async () => {
    const latest = new LatestOnly();
    const ignoresSignal = deferred<string>();
    const first = latest.run(() => ignoresSignal.promise);
    void latest.run(() => Promise.resolve('new'));
    ignoresSignal.resolve('stale');
    await expect(first).rejects.toSatisfy(isAbortError);
  });

  it('aborts the previous request signal when a new one starts', () => {
    const latest = new LatestOnly();
    const signals: AbortSignal[] = [];
    const never = () => new Promise<never>(() => {});
    void latest.run((s) => (signals.push(s), never()));
    void latest.run((s) => (signals.push(s), never()));
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
  });

  it('reports a stale request that fails as ABORTED rather than as its error', async () => {
    const latest = new LatestOnly();
    const slow = deferred<string>();
    const first = latest.run(() => slow.promise);
    void latest.run(() => Promise.resolve('new'));
    slow.reject(new Error('boom'));
    await expect(first).rejects.toSatisfy(isAbortError);
  });

  it('cancel() drops the in-flight result', async () => {
    const latest = new LatestOnly();
    const d = deferred<string>();
    const p = latest.run(() => d.promise);
    latest.cancel();
    d.resolve('late');
    await expect(p).rejects.toSatisfy(isAbortError);
  });

  it('propagates the real error of the current request', async () => {
    const latest = new LatestOnly();
    await expect(latest.run(() => Promise.reject(new Error('real')))).rejects.toThrow('real');
  });
});
