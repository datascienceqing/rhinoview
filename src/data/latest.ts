import { DataError } from './errors';

/**
 * "Latest wins" request runner: makes out-of-order delivery structurally impossible.
 *
 * Each `run` aborts the previous request AND invalidates its result. Aborting alone
 * is not enough — a data source that ignores the signal (or a response that was
 * already in flight when the abort fired) could still resolve late and overwrite
 * newer state. So a superseded run always rejects with `ABORTED`, even if its
 * underlying promise resolves successfully afterwards.
 */
export class LatestOnly {
  private controller: AbortController | null = null;
  private seq = 0;

  run<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    const mine = ++this.seq;
    const superseded = () => mine !== this.seq || controller.signal.aborted;

    return task(controller.signal).then(
      (value) => {
        if (superseded()) throw new DataError('ABORTED', 'Superseded by a newer request');
        return value;
      },
      (error: unknown) => {
        if (superseded()) throw new DataError('ABORTED', 'Superseded by a newer request');
        throw error;
      },
    );
  }

  /** Abort the in-flight request (if any) and drop its result. */
  cancel(): void {
    this.seq++;
    this.controller?.abort();
    this.controller = null;
  }
}
