import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IndicatorConfig } from '@shared/types';
import { MAX_LAYOUTS, MAX_NAME_LENGTH, MAX_QUOTE_SYMBOLS, MAX_WATCHLISTS } from '@shared/types';
import { createWorkspaceStore } from './index';
import { nodeWorkspaceFs } from './store';
import type { WorkspaceFs } from './store';
import {
  WorkspaceConflictError,
  WorkspaceNotFoundError,
  WorkspaceValidationError,
} from './types';
import type { WorkspaceStore } from './types';

let dir: string;
let file: string;
let clock: number;
const warn = vi.fn();

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rhinoview-ws-'));
  file = join(dir, 'nested', 'workspace.json');
  clock = 1_790_000_000;
  warn.mockClear();
});
afterEach(() => rm(dir, { recursive: true, force: true }));

async function open(extra: { fs?: WorkspaceFs } = {}): Promise<WorkspaceStore> {
  const store = await createWorkspaceStore(file, { now: () => clock, warn, ...extra });
  if (!store) throw new Error('store is null');
  return store;
}
const tick = () => (clock += 1);
const onDisk = async () => JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
const sma: IndicatorConfig = { id: 'i1', kind: 'sma', params: { period: 20, source: 'close' }, color: '#fff', visible: true };

describe('default workspace (invariants 11, 13)', () => {
  it('creates the directory and the default workspace when the file is missing', async () => {
    const ws = await (await open()).getWorkspace();
    expect(ws.layouts).toHaveLength(1);
    expect(ws.layouts[0]).toMatchObject({
      name: 'Main', symbol: 'AAPL', timeframe: '1D', chartType: 'candlestick', indicators: [], revision: 1,
    });
    expect(ws.watchlists).toHaveLength(1);
    expect(ws.watchlists[0]).toMatchObject({ name: 'Watchlist', symbols: ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL'] });
    expect(ws.activeLayoutId).toBe(ws.layouts[0]?.id);
    expect(ws.activeWatchlistId).toBe(ws.watchlists[0]?.id);
  });

  it('writes a versioned file (invariant 12)', async () => {
    await open();
    expect((await onDisk()).version).toBe(1);
  });
});

describe('durability (invariants 1, 2)', () => {
  it('has the write on disk before the call resolves', async () => {
    const store = await open();
    const created = await store.createLayout({ name: 'Second' });
    const saved = (await onDisk()) as { layouts: { id: string }[] };
    expect(saved.layouts.map((l) => l.id)).toContain(created.id);
  });

  it('survives a restart', async () => {
    const created = await (await open()).createLayout({ name: 'Second', symbol: 'tsla' });
    const again = await (await open()).getWorkspace();
    expect(again.layouts.find((l) => l.id === created.id)).toMatchObject({ name: 'Second', symbol: 'TSLA' });
  });

  it('keeps the old file intact and the memory unchanged when a crash hits between temp write and rename', async () => {
    await open();
    const before = await readFile(file, 'utf8');
    const crashing: WorkspaceFs = {
      ...nodeWorkspaceFs,
      rename: () => Promise.reject(new Error('simulated crash before rename')),
    };
    const crashed = await open({ fs: crashing }); // reopen over the same file, with a failing rename
    await expect(crashed.createLayout({ name: 'Lost' })).rejects.toThrow('simulated crash');
    expect(await readFile(file, 'utf8')).toBe(before);
    expect((await crashed.getWorkspace()).layouts.map((l) => l.name)).toEqual(['Main']);
    expect(await readdir(join(dir, 'nested'))).toEqual(['workspace.json']); // no temp litter
    // A normal store still reads the intact old file.
    await expect((await open()).getWorkspace()).resolves.toMatchObject({ layouts: [{ name: 'Main' }] });
  });

  it('writes the temp file in the same directory as the target, then renames it', async () => {
    const calls: string[] = [];
    const spy: WorkspaceFs = {
      ...nodeWorkspaceFs,
      async writeFileSynced(p, d) {
        calls.push(`write ${p.startsWith(join(dir, 'nested'))}`);
        return nodeWorkspaceFs.writeFileSynced(p, d);
      },
      async rename(a, b) {
        calls.push(`rename ${b === file}`);
        return nodeWorkspaceFs.rename(a, b);
      },
    };
    const store = await open({ fs: spy });
    calls.length = 0;
    await store.createWatchlist({ name: 'W2' });
    expect(calls).toEqual(['write true', 'rename true']);
  });
});

describe('corrupt file (invariant 4)', () => {
  const cases: [string, string][] = [
    ['unparseable JSON', '{ not json'],
    ['valid JSON of the wrong shape', JSON.stringify({ hello: 'world' })],
    ['an unknown version', JSON.stringify({ version: 2, layouts: [], watchlists: [], activeLayoutId: 'x', activeWatchlistId: null })],
  ];
  for (const [label, text] of cases) {
    it(`renames ${label} to .corrupt-<ts> and starts from the default workspace`, async () => {
      await rm(join(dir, 'nested'), { recursive: true, force: true });
      const { mkdir } = await import('node:fs/promises');
      await mkdir(join(dir, 'nested'));
      await writeFile(file, text);
      const ws = await (await open()).getWorkspace();
      expect(ws.layouts[0]?.name).toBe('Main');
      expect(await readFile(`${file}.corrupt-${clock}`, 'utf8')).toBe(text);
      expect(warn).toHaveBeenCalledTimes(1);
      expect((await onDisk()).version).toBe(1); // fresh file written
    });
  }

  it('does not overwrite an earlier backup made in the same second', async () => {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(dir, 'nested'));
    await writeFile(file, 'first bad');
    await open();
    await writeFile(file, 'second bad');
    await open();
    expect(await readFile(`${file}.corrupt-${clock}`, 'utf8')).toBe('first bad');
    expect(await readFile(`${file}.corrupt-${clock}-1`, 'utf8')).toBe('second bad');
  });

  it('treats a file whose active layout id does not exist as corrupt', async () => {
    await open();
    const good = await onDisk();
    await writeFile(file, JSON.stringify({ ...good, activeLayoutId: 'ghost' }));
    await open();
    expect((await readdir(join(dir, 'nested'))).some((f) => f.includes('.corrupt-'))).toBe(true);
  });

  it.each<[string, (layout: Record<string, unknown>) => void]>([
    ['a bad layout symbol', (l) => { l.symbol = 'not a symbol!'; }],
    ['a bad layout timeframe', (l) => { l.timeframe = '2h'; }],
  ])('treats a file with %s as corrupt', async (_label, spoil) => {
    await open();
    const good = (await onDisk()) as { layouts: Record<string, unknown>[] };
    spoil(good.layouts[0] as Record<string, unknown>);
    await writeFile(file, JSON.stringify(good));
    const ws = await (await open()).getWorkspace();
    expect(ws.layouts.map((l) => l.name)).toEqual(['Main']);
    expect((await readdir(join(dir, 'nested'))).some((f) => f.includes('.corrupt-'))).toBe(true);
  });
});

describe('a retired chart type in the file (invariant 4)', () => {
  it("reads chartType 'area' as 'bar' and keeps the layout", async () => {
    const store = await open();
    const layout = await store.createLayout({ name: 'Old', indicators: [sma] });
    const saved = (await onDisk()) as { layouts: { id: string; chartType: string }[] };
    for (const l of saved.layouts) if (l.id === layout.id) l.chartType = 'area';
    await writeFile(file, JSON.stringify(saved));
    const ws = await (await open()).getWorkspace();
    expect(ws.layouts.find((l) => l.id === layout.id)).toMatchObject({ name: 'Old', chartType: 'bar', indicators: [sma] });
    expect((await readdir(join(dir, 'nested'))).some((f) => f.includes('.corrupt-'))).toBe(false);
  });
});

describe('an invalid indicator in the file (invariant 4)', () => {
  const rsi: IndicatorConfig = { id: 'i2', kind: 'rsi', params: { period: 14 }, color: '#0f0', visible: true };

  /** A saved workspace with two layouts and a second watchlist; `bad` goes into layout "Test". */
  async function fileWith(bad: unknown): Promise<{ layoutId: string; watchlistId: string }> {
    const store = await open();
    const layout = await store.createLayout({ name: 'Test', indicators: [sma, rsi] });
    const watchlist = await store.createWatchlist({ name: 'Tech', symbols: ['TSLA', 'AMD'] });
    const saved = (await onDisk()) as { layouts: { id: string; indicators: unknown[] }[] };
    saved.layouts.find((l) => l.id === layout.id)?.indicators.splice(1, 0, bad);
    await writeFile(file, JSON.stringify(saved));
    warn.mockClear();
    return { layoutId: layout.id, watchlistId: watchlist.id };
  }

  const backups = async () => (await readdir(join(dir, 'nested'))).filter((f) => f.includes('.corrupt-'));

  it('drops an indicator of an unknown kind and keeps every other indicator, layout and watchlist', async () => {
    const unknown = { id: 'x9', kind: 'bollinger', params: { period: 20 }, color: '#f00', visible: true };
    const { layoutId, watchlistId } = await fileWith(unknown);
    const ws = await (await open()).getWorkspace();
    expect(ws.layouts.map((l) => l.name)).toEqual(['Main', 'Test']);
    expect(ws.layouts.find((l) => l.id === layoutId)?.indicators).toEqual([sma, rsi]);
    expect(ws.watchlists.map((w) => w.name)).toEqual(['Watchlist', 'Tech']);
    expect(ws.watchlists.find((w) => w.id === watchlistId)?.symbols).toEqual(['TSLA', 'AMD']);
    expect(await backups()).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toContain('"Test"');
    expect(message).toContain(layoutId);
    expect(message).toContain('"x9"');
    expect(message).toContain('"bollinger"');
  });

  it('drops an indicator whose params fail checkIndicatorParams, with that reason in the warning', async () => {
    const { checkIndicatorParams } = await import('../../src/indicators/params');
    const badParams = { ...sma, id: 'p0', params: { period: 0, source: 'close' } };
    const reason = checkIndicatorParams(badParams.kind, badParams.params) as string;
    const { layoutId } = await fileWith(badParams);
    const ws = await (await open()).getWorkspace();
    expect(ws.layouts.find((l) => l.id === layoutId)?.indicators).toEqual([sma, rsi]);
    expect(await backups()).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toContain('"Test"');
    expect(message).toContain('"p0"');
    expect(message).toContain('"sma"');
    expect(message).toContain(reason);
  });

  it.each<[string, unknown]>([
    ['a value that is not an object', 42],
    ['an indicator with a field we did not write', { ...rsi, id: 'z1', extra: true }],
    ['an indicator without an id', { kind: 'rsi', params: { period: 14 }, color: '#0f0', visible: true }],
  ])('drops %s', async (_label, bad) => {
    const { layoutId } = await fileWith(bad);
    const ws = await (await open()).getWorkspace();
    expect(ws.layouts.find((l) => l.id === layoutId)?.indicators).toEqual([sma, rsi]);
    expect(await backups()).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('warns once for each dropped indicator', async () => {
    const store = await open();
    const unknown = (id: string) => ({ id, kind: 'bollinger', params: {}, color: '#f00', visible: true });
    await store.createLayout({ name: 'Test', indicators: [sma] });
    const saved = (await onDisk()) as { layouts: { indicators: unknown[] }[] };
    saved.layouts[0]?.indicators.push(unknown('a'));
    saved.layouts[1]?.indicators.push(unknown('b'), unknown('c'));
    await writeFile(file, JSON.stringify(saved));
    warn.mockClear();
    const ws = await (await open()).getWorkspace();
    expect(ws.layouts.map((l) => l.indicators)).toEqual([[], [sma]]);
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it('writes the cleaned workspace back to disk at once', async () => {
    const { layoutId } = await fileWith({ id: 'x9', kind: 'bollinger', params: {}, color: '#f00', visible: true });
    const ws = await (await open()).getWorkspace();
    const saved = (await onDisk()) as { version: number; layouts: { id: string; indicators: unknown[] }[] };
    expect(saved.version).toBe(1);
    expect(saved.layouts.find((l) => l.id === layoutId)?.indicators).toEqual([sma, rsi]);
    expect(saved).toEqual({ version: 1, ...ws });
    // The next start finds nothing to drop.
    warn.mockClear();
    await open();
    expect(warn).not.toHaveBeenCalled();
  });

  it('does not rewrite a file that has nothing to drop', async () => {
    await open();
    const writes: string[] = [];
    const spy: WorkspaceFs = {
      ...nodeWorkspaceFs,
      async writeFileSynced(p, d) {
        writes.push(p);
        return nodeWorkspaceFs.writeFileSynced(p, d);
      },
    };
    await open({ fs: spy });
    expect(writes).toEqual([]);
  });
});

describe('a process killed after the temp write', () => {
  it('leaves a stray temp file that the next start ignores, with the old data intact', async () => {
    const store = await open();
    await store.createLayout({ name: 'Kept' });
    await writeFile(join(dir, 'nested', '.half.tmp'), '{"version":1,"lay');
    const names = (await (await open()).getWorkspace()).layouts.map((l) => l.name);
    expect(names).toEqual(['Main', 'Kept']);
  });
});

describe('one writer at a time (invariant 3)', () => {
  it('loses no update when 20 writes run in parallel', async () => {
    const store = await open();
    const created = await Promise.all(Array.from({ length: 20 }, (_, i) => store.createLayout({ name: `L${i}` })));
    expect(new Set(created.map((l) => l.id)).size).toBe(20);
    const ws = await store.getWorkspace();
    expect(ws.layouts).toHaveLength(21);
    expect(((await onDisk()) as { layouts: unknown[] }).layouts).toHaveLength(21);
  });

  it('applies 20 parallel updates to the same entity in turn, so each revision is used once', async () => {
    const store = await open();
    const [watchlist] = (await store.getWorkspace()).watchlists;
    const id = watchlist?.id as string;
    // All 20 carry revision 1: exactly one may win, the other 19 must conflict.
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) => store.updateWatchlist(id, { revision: 1, name: `N${i}` })),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results) if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(WorkspaceConflictError);
    expect((await store.getWorkspace()).watchlists[0]?.revision).toBe(2);
  });

  it('chains 20 sequential-revision updates fired at once without losing any', async () => {
    const store = await open();
    const [watchlist] = (await store.getWorkspace()).watchlists;
    const id = watchlist?.id as string;
    let rev = 1;
    const ops = Array.from({ length: 20 }, () => {
      const r = rev++;
      return store.updateWatchlist(id, { revision: r, symbols: [`S${r}`] });
    });
    // Revisions 1..20 were issued in order; serialization means each sees the previous result.
    await Promise.all(ops);
    const final = (await store.getWorkspace()).watchlists[0];
    expect(final?.revision).toBe(21);
    expect(final?.symbols).toEqual(['S20']);
  });

  it('keeps serving writes after one write fails', async () => {
    const store = await open();
    await expect(store.createLayout({ name: 'Main' })).rejects.toBeInstanceOf(WorkspaceValidationError);
    await expect(store.createLayout({ name: 'Fine' })).resolves.toMatchObject({ name: 'Fine' });
  });
});

describe('optimistic concurrency (invariant 5)', () => {
  it('increments the revision on every write and updates updatedAt', async () => {
    const store = await open();
    const layout = (await store.getWorkspace()).layouts[0];
    tick();
    const next = await store.updateLayout(layout?.id as string, { revision: 1, timeframe: '1W' });
    expect(next.revision).toBe(2);
    expect(next.updatedAt).toBe(clock);
    expect(next.createdAt).toBe(layout?.createdAt);
  });

  it('throws WorkspaceConflictError carrying the current entity for a stale revision, and changes nothing', async () => {
    const store = await open();
    const layout = (await store.getWorkspace()).layouts[0];
    await store.updateLayout(layout?.id as string, { revision: 1, timeframe: '1W' });
    const err = await store.updateLayout(layout?.id as string, { revision: 1, timeframe: '5m' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkspaceConflictError);
    expect((err as WorkspaceConflictError).current).toMatchObject({ revision: 2, timeframe: '1W' });
    expect((await store.getWorkspace()).layouts[0]?.timeframe).toBe('1W');
  });

  it('conflicts for a revision from the future too', async () => {
    const store = await open();
    const [w] = (await store.getWorkspace()).watchlists;
    await expect(store.updateWatchlist(w?.id as string, { revision: 9 })).rejects.toBeInstanceOf(WorkspaceConflictError);
  });

  it('throws not-found before it looks at the revision', async () => {
    const store = await open();
    await expect(store.updateLayout('nope', { revision: 5 })).rejects.toBeInstanceOf(WorkspaceNotFoundError);
    await expect(store.updateWatchlist('nope', { revision: 5 })).rejects.toBeInstanceOf(WorkspaceNotFoundError);
  });
});

describe('layouts: last-layout and active ids (invariant 6)', () => {
  it('refuses to delete the last layout', async () => {
    const store = await open();
    const [l] = (await store.getWorkspace()).layouts;
    await expect(store.deleteLayout(l?.id as string)).rejects.toThrow(/last layout/);
    expect((await store.getWorkspace()).layouts).toHaveLength(1);
  });

  it('answers not-found for an unknown layout, also when it is the only layout', async () => {
    await expect((await open()).deleteLayout('nope')).rejects.toBeInstanceOf(WorkspaceNotFoundError);
  });

  it('makes the most recently updated remaining layout active when the active one is deleted', async () => {
    const store = await open();
    const main = (await store.getWorkspace()).layouts[0];
    tick();
    const a = await store.createLayout({ name: 'A' });
    tick();
    const b = await store.createLayout({ name: 'B' });
    tick();
    await store.updateLayout(a.id, { revision: 1, symbol: 'MSFT' }); // A is now newest
    const ws = await store.deleteLayout(main?.id as string); // Main is active
    expect(ws.activeLayoutId).toBe(a.id);
    expect(ws.layouts.map((l) => l.id)).toEqual([a.id, b.id]);
  });

  it('keeps the active layout when a different layout is deleted', async () => {
    const store = await open();
    const main = (await store.getWorkspace()).layouts[0];
    const other = await store.createLayout({ name: 'Other' });
    expect((await store.deleteLayout(other.id)).activeLayoutId).toBe(main?.id);
  });

  it('moves the active watchlist to the newest remaining one, or null when none remain', async () => {
    const store = await open();
    const first = (await store.getWorkspace()).watchlists[0];
    tick();
    const second = await store.createWatchlist({ name: 'Second' });
    tick();
    const third = await store.createWatchlist({ name: 'Third' });
    tick();
    await store.updateWatchlist(second.id, { revision: 1, symbols: ['IBM'] });
    let ws = await store.deleteWatchlist(first?.id as string);
    expect(ws.activeWatchlistId).toBe(second.id);
    ws = await store.deleteWatchlist(second.id);
    expect(ws.activeWatchlistId).toBe(third.id);
    ws = await store.deleteWatchlist(third.id);
    expect(ws.watchlists).toEqual([]);
    expect(ws.activeWatchlistId).toBeNull();
  });

  it('activates a watchlist created when none exist', async () => {
    const store = await open();
    const first = (await store.getWorkspace()).watchlists[0];
    await store.deleteWatchlist(first?.id as string);
    const created = await store.createWatchlist({ name: 'New' });
    expect((await store.getWorkspace()).activeWatchlistId).toBe(created.id);
  });

  it('setActive switches both ids, accepts null, and changes nothing when one id is unknown', async () => {
    const store = await open();
    const main = (await store.getWorkspace()).layouts[0];
    const l2 = await store.createLayout({ name: 'L2' });
    const w2 = await store.createWatchlist({ name: 'W2' });
    let ws = await store.setActive({ activeLayoutId: l2.id, activeWatchlistId: w2.id });
    expect([ws.activeLayoutId, ws.activeWatchlistId]).toEqual([l2.id, w2.id]);
    ws = await store.setActive({ activeWatchlistId: null });
    expect(ws.activeWatchlistId).toBeNull();
    await expect(store.setActive({ activeLayoutId: main?.id as string, activeWatchlistId: 'nope' })).rejects.toBeInstanceOf(
      WorkspaceNotFoundError,
    );
    expect((await store.getWorkspace()).activeLayoutId).toBe(l2.id); // not half-applied
    await expect(store.setActive({ activeLayoutId: 'nope' })).rejects.toBeInstanceOf(WorkspaceNotFoundError);
  });
});

describe('names (invariant 7)', () => {
  it('trims names', async () => {
    expect((await (await open()).createLayout({ name: '  Padded  ' })).name).toBe('Padded');
  });

  it('rejects a duplicate layout name regardless of case or padding', async () => {
    const store = await open();
    await expect(store.createLayout({ name: ' MAIN ' })).rejects.toThrow(/already in use/);
  });

  it('rejects a duplicate watchlist name regardless of case', async () => {
    await expect((await open()).createWatchlist({ name: 'wAtChLiSt' })).rejects.toThrow(/already in use/);
  });

  it('allows the same name in a layout and a watchlist (unique within their kind)', async () => {
    await expect((await open()).createWatchlist({ name: 'Main' })).resolves.toMatchObject({ name: 'Main' });
  });

  it('lets an entity keep its own name on update, and rejects a rename onto another', async () => {
    const store = await open();
    const main = (await store.getWorkspace()).layouts[0];
    const other = await store.createLayout({ name: 'Other' });
    await expect(store.updateLayout(main?.id as string, { revision: 1, name: 'MAIN' })).resolves.toMatchObject({ name: 'MAIN' });
    await expect(store.updateLayout(other.id, { revision: 1, name: 'main' })).rejects.toThrow(/already in use/);
  });

  it('rejects empty, blank and too-long names, and accepts exactly the maximum', async () => {
    const store = await open();
    await expect(store.createLayout({ name: '' })).rejects.toBeInstanceOf(WorkspaceValidationError);
    await expect(store.createLayout({ name: '   ' })).rejects.toBeInstanceOf(WorkspaceValidationError);
    await expect(store.createLayout({ name: 'x'.repeat(MAX_NAME_LENGTH + 1) })).rejects.toBeInstanceOf(WorkspaceValidationError);
    await expect(store.createLayout({ name: 'x'.repeat(MAX_NAME_LENGTH) })).resolves.toBeDefined();
  });
});

describe('limits (invariant 8)', () => {
  it(`rejects layout number ${MAX_LAYOUTS + 1}`, async () => {
    const store = await open();
    for (let i = 1; i < MAX_LAYOUTS; i++) await store.createLayout({ name: `L${i}` });
    expect((await store.getWorkspace()).layouts).toHaveLength(MAX_LAYOUTS);
    await expect(store.createLayout({ name: 'one more' })).rejects.toThrow(/at most/);
  });

  it(`rejects watchlist number ${MAX_WATCHLISTS + 1}`, async () => {
    const store = await open();
    for (let i = 1; i < MAX_WATCHLISTS; i++) await store.createWatchlist({ name: `W${i}` });
    await expect(store.createWatchlist({ name: 'one more' })).rejects.toThrow(/at most/);
  });

  it(`rejects more than ${MAX_QUOTE_SYMBOLS} symbols on create and on update, and accepts exactly the maximum`, async () => {
    const store = await open();
    const many = (n: number) => Array.from({ length: n }, (_, i) => `S${i}`);
    await expect(store.createWatchlist({ name: 'Big', symbols: many(MAX_QUOTE_SYMBOLS + 1) })).rejects.toThrow(/at most/);
    const ok = await store.createWatchlist({ name: 'Max', symbols: many(MAX_QUOTE_SYMBOLS) });
    await expect(store.updateWatchlist(ok.id, { revision: 1, symbols: many(MAX_QUOTE_SYMBOLS + 1) })).rejects.toThrow(/at most/);
  });

  it('counts symbols after duplicates are removed', async () => {
    const store = await open();
    const syms = [...Array.from({ length: MAX_QUOTE_SYMBOLS }, (_, i) => `S${i}`), 's0', 'S1'];
    await expect(store.createWatchlist({ name: 'Dups', symbols: syms })).resolves.toBeDefined();
  });
});

describe('symbols (invariant 9)', () => {
  it('uppercases, removes duplicates case-insensitively, and keeps first occurrence and order', async () => {
    const w = await (await open()).createWatchlist({ name: 'T', symbols: ['msft', 'AAPL', 'MSFT', 'aapl', 'brk.b', '^gspc'] });
    expect(w.symbols).toEqual(['MSFT', 'AAPL', 'BRK.B', '^GSPC']);
  });

  it.each(['', 'A B', 'A'.repeat(17), 'AAPL!', 'ÄPL', 'a/b'])('rejects the bad symbol %j', async (bad) => {
    const store = await open();
    await expect(store.createWatchlist({ name: 'T', symbols: [bad] })).rejects.toBeInstanceOf(WorkspaceValidationError);
    await expect(store.createLayout({ name: 'T', symbol: bad })).rejects.toBeInstanceOf(WorkspaceValidationError);
  });

  it('accepts 16 characters and every allowed punctuation mark', async () => {
    const w = await (await open()).createWatchlist({ name: 'T', symbols: ['A'.repeat(16), 'A.B^C=D-E'] });
    expect(w.symbols).toHaveLength(2);
  });

  it('does not call any engine: an unlisted but well-formed symbol is stored', async () => {
    const w = await (await open()).createWatchlist({ name: 'T', symbols: ['ZZZZZZ'] });
    expect(w.symbols).toEqual(['ZZZZZZ']);
  });
});

describe('layout contents (invariant 10)', () => {
  it('stores a layout with valid indicators', async () => {
    const l = await (await open()).createLayout({ name: 'I', indicators: [sma] });
    expect(l.indicators).toEqual([sma]);
  });

  it('stores a liquidity indicator with its enum fields', async () => {
    const liq: IndicatorConfig = {
      id: 'q1',
      kind: 'liquidity',
      params: { lookback: 5, zoneMode: 'range', sweepMode: 'both', minTouches: 1, maxAge: 200, sweepExtend: 10 },
      color: '#ff9800',
      visible: true,
    };
    const l = await (await open()).createLayout({ name: 'Q', indicators: [liq] });
    expect(l.indicators).toEqual([liq]);
  });

  it('stores an fvg indicator with decimals and enum fields', async () => {
    const fvg: IndicatorConfig = {
      id: 'f1',
      kind: 'fvg',
      params: { minGapAtrPct: 12.5, displacementAtrPct: 0, maxZones: 40, extend: 'fixed', boxLength: 30, labels: 'on', mitigation: 'fill', mitigatedStyle: 'remove' },
      color: '#ff9800',
      visible: true,
    };
    const l = await (await open()).createLayout({ name: 'F', indicators: [fvg] });
    expect(l.indicators).toEqual([fvg]);
  });

  it('stores a confluence indicator with decimals, enums and a latch date, and keeps it after a reopen', async () => {
    const conf: IndicatorConfig = {
      id: 'c1',
      kind: 'confluence',
      params: {
        mode: 'breakdown', swingLookback: 120, tolerancePct: 0.6, bandWidthMult: 2.5, pivotLeft: 3, pivotRight: 4,
        pivotMaxAge: 300, turnMinConfluence: 2, turnMinDistancePct: 0.2, breakdownMinConfluence: 4,
        breakdownMinDistancePct: 0.75, volumeLength: 20, volumeMult: 1.8, closeQuality: 0.35, sources: 'fibs',
        latch: 'on', latchTime: 1_790_000_000,
      },
      color: '#00bcd4',
      visible: true,
    };
    const l = await (await open()).createLayout({ name: 'C', indicators: [conf] });
    expect(l.indicators).toEqual([conf]);
    const again = (await (await open()).getWorkspace()).layouts.find((x) => x.id === l.id);
    expect(again?.indicators).toEqual([conf]);
  });

  it('rejects a confluence indicator with a bad mode or a fractional count', async () => {
    const store = await open();
    const base = { id: 'c1', kind: 'confluence' as const, color: '#00bcd4', visible: true };
    const { DEFAULT_PARAMS } = await import('../../src/indicators/types');
    await expect(
      store.createLayout({ name: 'C', indicators: [{ ...base, params: { ...DEFAULT_PARAMS.confluence, mode: 'up' as never } }] }),
    ).rejects.toThrow(/mode/);
    await expect(
      store.createLayout({ name: 'C', indicators: [{ ...base, params: { ...DEFAULT_PARAMS.confluence, pivotLeft: 2.5 } }] }),
    ).rejects.toThrow(/pivotLeft/);
  });

  it('stores a vpvr indicator', async () => {
    const vpvr: IndicatorConfig = { id: 'p1', kind: 'vpvr', params: { rows: 24, widthPct: 30, valueAreaPct: 70 }, color: '#2962ff', visible: true };
    const l = await (await open()).createLayout({ name: 'P', indicators: [vpvr] });
    expect(l.indicators).toEqual([vpvr]);
  });

  it('stores a volume indicator, and keeps it after a reopen', async () => {
    const volume: IndicatorConfig = { id: 'v1', kind: 'volume', params: { period: 20 }, color: '#2962ff', visible: true };
    const store = await open();
    const l = await store.createLayout({ name: 'V', indicators: [volume] });
    expect(l.indicators).toEqual([volume]);
    const again = (await (await open()).getWorkspace()).layouts.find((x) => x.id === l.id);
    expect(again?.indicators).toEqual([volume]);
  });

  it.each<[string, IndicatorConfig]>([
    ['period 0', { ...sma, params: { period: 0, source: 'close' } }],
    ['period 501', { ...sma, params: { period: 501 } }],
    ['a fractional period', { ...sma, params: { period: 2.5 } }],
    ['a bad source', { ...sma, params: { period: 5, source: 'median' as never } }],
    ['volume with period 0', { ...sma, kind: 'volume', params: { period: 0 } }],
    ['vpvr with 1 row', { ...sma, kind: 'vpvr', params: { rows: 1, widthPct: 30, valueAreaPct: 70 } }],
    ['liquidity with lookback 1', { ...sma, kind: 'liquidity', params: { lookback: 1, zoneMode: 'wick', sweepMode: 'wicks', minTouches: 0, maxAge: 300, sweepExtend: 20 } }],
    ['liquidity with a bad zone mode', { ...sma, kind: 'liquidity', params: { lookback: 10, zoneMode: 'body', sweepMode: 'wicks', minTouches: 0, maxAge: 300, sweepExtend: 20 } as never }],
    ['liquidity with a missing sweep mode', { ...sma, kind: 'liquidity', params: { lookback: 10, zoneMode: 'wick', minTouches: 0, maxAge: 300, sweepExtend: 20 } as never }],
    ['fvg with a bad mitigation mode', { ...sma, kind: 'fvg', params: { minGapAtrPct: 0, displacementAtrPct: 0, maxZones: 30, extend: 'right', boxLength: 20, labels: 'off', mitigation: 'close', mitigatedStyle: 'dim' } as never }],
    ['vpvr with a period instead of rows', { ...sma, kind: 'vpvr', params: { period: 20 } as never }],
    ['macd with fast >= slow', { ...sma, kind: 'macd', params: { fastPeriod: 26, slowPeriod: 12, signalPeriod: 9 } }],
    ['macd with a missing period', { ...sma, kind: 'macd', params: { fastPeriod: 12, slowPeriod: 26 } as never }],
    ['an unknown kind', { ...sma, kind: 'bollinger' as never }],
  ])('rejects %s with the same message the client editor shows', async (_label, ind) => {
    const store = await open();
    const { checkIndicatorParams } = await import('../../src/indicators/params');
    const expected = checkIndicatorParams(ind.kind, ind.params) as string;
    await expect(store.createLayout({ name: 'I', indicators: [ind] })).rejects.toThrow(expected);
  });

  it('rejects two indicators with the same id', async () => {
    await expect((await open()).createLayout({ name: 'I', indicators: [sma, sma] })).rejects.toThrow(/Duplicate indicator id/);
  });

  it('rejects an invalid timeframe or chart type that bypasses the type system', async () => {
    const store = await open();
    await expect(store.createLayout({ name: 'T', timeframe: '2h' as never })).rejects.toBeInstanceOf(WorkspaceValidationError);
    await expect(store.createLayout({ name: 'C', chartType: 'bars' as never })).rejects.toBeInstanceOf(WorkspaceValidationError);
  });

  it('never stores a rejected update: layout and file stay as they were', async () => {
    const store = await open();
    const l = (await store.getWorkspace()).layouts[0];
    const before = await readFile(file, 'utf8');
    await expect(
      store.updateLayout(l?.id as string, { revision: 1, name: 'Renamed', indicators: [{ ...sma, params: { period: 0 } }] }),
    ).rejects.toBeInstanceOf(WorkspaceValidationError);
    expect(await readFile(file, 'utf8')).toBe(before);
    expect((await store.getWorkspace()).layouts[0]).toMatchObject({ name: 'Main', revision: 1 });
  });

  it('applies defaults to omitted create fields and updates only the fields given', async () => {
    const store = await open();
    const l = await store.createLayout({ name: 'D' });
    expect(l).toMatchObject({ symbol: 'AAPL', timeframe: '1D', chartType: 'candlestick', indicators: [], revision: 1 });
    const u = await store.updateLayout(l.id, { revision: 1, chartType: 'bar', indicators: [sma] });
    expect(u).toMatchObject({ name: 'D', symbol: 'AAPL', chartType: 'bar', indicators: [sma], revision: 2 });
  });

  it('returns copies: changing a result does not change the store', async () => {
    const store = await open();
    const ws = await store.getWorkspace();
    ws.layouts[0]!.name = 'Hacked';
    expect((await store.getWorkspace()).layouts[0]?.name).toBe('Main');
  });
});

describe('file content (invariant 12)', () => {
  it('holds only the documented keys', async () => {
    await (await open()).createLayout({ name: 'X' });
    expect(Object.keys(await onDisk()).sort()).toEqual(['activeLayoutId', 'activeWatchlistId', 'layouts', 'version', 'watchlists']);
  });
});
