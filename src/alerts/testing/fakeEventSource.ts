/**
 * A stand-in for EventSource under jsdom, which has none. Tests push stream messages with
 * `emit`, and simulate a lost and restored connection with `reopen`.
 */
import type { AlertStreamMessage } from '@shared/types';
import type { EventSourceFactory } from '../AlertsProvider';

export class FakeEventSource extends EventTarget {
  closed = false;
  constructor(public readonly url: string) {
    super();
  }
  close(): void {
    this.closed = true;
  }
  /** The stream opened (first time, or again after a loss). */
  open(): void {
    this.dispatchEvent(new Event('open'));
  }
  /** The connection broke and the browser connected again. */
  reopen(): void {
    this.dispatchEvent(new Event('error'));
    this.open();
  }
  emit(message: AlertStreamMessage): void {
    this.dispatchEvent(new MessageEvent(message.type, { data: JSON.stringify(message) }));
  }
}

/** A factory that records every source it makes; `last()` is the live one. */
export function fakeEventSources() {
  const made: FakeEventSource[] = [];
  const factory: EventSourceFactory = (url) => {
    const s = new FakeEventSource(url);
    made.push(s);
    return s as unknown as EventSource;
  };
  return {
    factory,
    made,
    last(): FakeEventSource {
      const s = made[made.length - 1];
      if (!s) throw new Error('No EventSource was created');
      return s;
    },
  };
}
