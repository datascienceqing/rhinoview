/**
 * File-backed workspace store. See the thirteen invariants in `./types.ts`.
 *
 * State lives in memory after the first load and every write goes through one promise
 * chain (invariant 3). A mutation computes the NEXT state from the current one, writes
 * it atomically, and only then replaces the in-memory state, so a failed write leaves
 * both the file and the memory exactly as they were.
 */
import { randomUUID } from 'node:crypto';
import * as nodeFs from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  ChartLayout,
  CreateLayoutBody,
  CreateWatchlistBody,
  EntityId,
  IndicatorConfig,
  SetActiveBody,
  UpdateLayoutBody,
  UpdateWatchlistBody,
  Watchlist,
  Workspace,
} from '@shared/types';
import { MAX_LAYOUTS, MAX_NAME_LENGTH, MAX_QUOTE_SYMBOLS, MAX_WATCHLISTS, TIMEFRAMES } from '@shared/types';
// The one sanctioned src -> server production import: identical validation on both sides.
import { checkIndicatorParams } from '../../src/indicators/params';
import { FILE_VERSION, workspaceFileSchema } from './schemas';
import { WorkspaceConflictError, WorkspaceNotFoundError, WorkspaceValidationError } from './types';
import type { WorkspaceStore } from './types';

/** The file operations the store uses. Tests replace them to simulate a crash. */
export interface WorkspaceFs {
  mkdir(path: string): Promise<void>;
  readFile(path: string): Promise<string | null>;
  /** Write `data` to `path` and fsync it before returning. */
  writeFileSynced(path: string, data: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  rm(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  /** Best effort: make the rename itself durable. */
  syncDir(path: string): Promise<void>;
}

export const nodeWorkspaceFs: WorkspaceFs = {
  async mkdir(path) {
    await nodeFs.mkdir(path, { recursive: true });
  },
  async readFile(path) {
    try {
      return await nodeFs.readFile(path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  },
  async writeFileSynced(path, data) {
    const handle = await nodeFs.open(path, 'w');
    try {
      await handle.writeFile(data, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
  rename: (from, to) => nodeFs.rename(from, to),
  rm: (path) => nodeFs.rm(path, { force: true }),
  async exists(path) {
    try {
      await nodeFs.access(path);
      return true;
    } catch {
      return false;
    }
  },
  async syncDir(path) {
    try {
      const handle = await nodeFs.open(path, 'r');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch {
      // Directory fsync is not supported everywhere (Windows). The file itself is synced.
    }
  },
};

export interface WorkspaceStoreOptions {
  fs?: WorkspaceFs;
  /** Unix seconds. */
  now?: () => number;
  newId?: () => string;
  warn?: (message: string) => void;
}

const SYMBOL_RE = /^[A-Za-z0-9.^=-]{1,16}$/;

function bad(message: string): never {
  throw new WorkspaceValidationError(message);
}

/** Canonical symbol: format checked, uppercased. Existence is the quotes endpoint's job. */
function canonicalSymbol(raw: string): string {
  if (typeof raw !== 'string' || !SYMBOL_RE.test(raw)) {
    bad('A symbol must be 1-16 characters: letters, digits and . ^ = -');
  }
  return raw.toUpperCase();
}

function canonicalSymbols(raw: string[]): string[] {
  const out: string[] = [];
  for (const s of raw) {
    const c = canonicalSymbol(s);
    if (!out.includes(c)) out.push(c);
  }
  if (out.length > MAX_QUOTE_SYMBOLS) bad(`A watchlist holds at most ${MAX_QUOTE_SYMBOLS} symbols.`);
  return out;
}

function checkIndicators(list: IndicatorConfig[]): IndicatorConfig[] {
  const ids = new Set<string>();
  for (const ind of list) {
    const message = checkIndicatorParams(ind.kind, ind.params);
    if (message !== null) bad(`Invalid indicator: ${message}`);
    if (ids.has(ind.id)) bad(`Duplicate indicator id: ${ind.id}`);
    ids.add(ind.id);
  }
  return structuredClone(list);
}

/** Trimmed, bounded, and unique among `others` ignoring case. */
function canonicalName(raw: string, others: readonly { name: string }[]): string {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (name.length < 1 || name.length > MAX_NAME_LENGTH) bad(`The name must be 1-${MAX_NAME_LENGTH} characters.`);
  const lower = name.toLowerCase();
  if (others.some((o) => o.name.toLowerCase() === lower)) bad(`The name "${name}" is already in use.`);
  return name;
}

/** Most recently updated; on a tie the later entry wins (seconds are coarse). */
function newest<T extends { updatedAt: number }>(list: readonly T[]): T | undefined {
  let best: T | undefined;
  for (const e of list) if (best === undefined || e.updatedAt >= best.updatedAt) best = e;
  return best;
}

function defaultWorkspace(now: number, newId: () => string): Workspace {
  const layout: ChartLayout = {
    id: newId(), name: 'Main', symbol: 'AAPL', timeframe: '1D', chartType: 'candlestick',
    indicators: [], revision: 1, createdAt: now, updatedAt: now,
  };
  const watchlist: Watchlist = {
    id: newId(), name: 'Watchlist', symbols: ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL'],
    revision: 1, createdAt: now, updatedAt: now,
  };
  return { layouts: [layout], watchlists: [watchlist], activeLayoutId: layout.id, activeWatchlistId: watchlist.id };
}

/** Parse and validate file text. Returns null when the file is not a valid workspace. */
function parseFile(text: string): Workspace | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = workspaceFileSchema.safeParse(json);
  if (!parsed.success) return null;
  const ws: Workspace = {
    layouts: parsed.data.layouts,
    watchlists: parsed.data.watchlists,
    activeLayoutId: parsed.data.activeLayoutId,
    activeWatchlistId: parsed.data.activeWatchlistId,
  };
  if (!ws.layouts.some((l) => l.id === ws.activeLayoutId)) return null;
  if (ws.activeWatchlistId !== null && !ws.watchlists.some((w) => w.id === ws.activeWatchlistId)) return null;
  for (const l of ws.layouts) {
    if (!(TIMEFRAMES as readonly string[]).includes(l.timeframe)) return null;
    if (!SYMBOL_RE.test(l.symbol)) return null;
    if (l.indicators.some((i) => checkIndicatorParams(i.kind, i.params) !== null)) return null;
  }
  if (ws.watchlists.some((w) => w.symbols.some((s) => !SYMBOL_RE.test(s)))) return null;
  return ws;
}

export async function openWorkspaceStore(filePath: string, opts: WorkspaceStoreOptions = {}): Promise<WorkspaceStore> {
  const fs = opts.fs ?? nodeWorkspaceFs;
  const clock = opts.now ?? (() => Math.floor(Date.now() / 1000));
  const newId = opts.newId ?? (() => randomUUID());
  const warn = opts.warn ?? ((m: string) => console.warn(m));
  const dir = dirname(filePath);

  /** Atomic write (invariant 2): temp file in the same directory, fsync, rename. */
  async function persist(ws: Workspace): Promise<void> {
    const tmp = join(dir, `.${newId()}.tmp`);
    const text = `${JSON.stringify({ version: FILE_VERSION, ...ws }, null, 2)}\n`;
    try {
      await fs.writeFileSynced(tmp, text);
      await fs.rename(tmp, filePath);
    } catch (err) {
      await fs.rm(tmp).catch(() => undefined);
      throw err;
    }
    await fs.syncDir(dir);
  }

  async function load(): Promise<Workspace> {
    await fs.mkdir(dir);
    const text = await fs.readFile(filePath);
    if (text !== null) {
      const ws = parseFile(text);
      if (ws) return ws;
      // Invariant 4: keep the bad file, then start fresh.
      let backup = `${filePath}.corrupt-${clock()}`;
      for (let n = 1; await fs.exists(backup); n++) backup = `${filePath}.corrupt-${clock()}-${n}`;
      await fs.rename(filePath, backup);
      warn(`Workspace file ${filePath} is not valid. Renamed to ${backup}. Starting from the default workspace.`);
    }
    const fresh = defaultWorkspace(clock(), newId);
    await persist(fresh);
    return fresh;
  }

  let state = await load();

  // Invariant 3: one writer at a time. A failed task must not break the chain.
  let tail: Promise<unknown> = Promise.resolve();
  function serial<T>(task: () => Promise<T>): Promise<T> {
    const run = tail.then(task, task);
    tail = run.catch(() => undefined);
    return run;
  }

  /** Run `change` on a copy of the state, persist the copy, then adopt it. */
  function mutate<T>(change: (draft: Workspace) => T): Promise<T> {
    return serial(async () => {
      const draft = structuredClone(state);
      const result = change(draft);
      await persist(draft);
      state = draft;
      return structuredClone(result);
    });
  }

  function find<T extends { id: string }>(list: T[], id: EntityId, kind: 'layout' | 'watchlist'): T {
    const e = list.find((x) => x.id === id);
    if (!e) throw new WorkspaceNotFoundError(kind, id);
    return e;
  }

  function checkRevision(entity: ChartLayout | Watchlist, revision: number): void {
    if (!Number.isInteger(revision)) bad('revision must be an integer.');
    if (revision !== entity.revision) throw new WorkspaceConflictError(structuredClone(entity));
  }

  return {
    getWorkspace: () => serial(async () => structuredClone(state)),

    createLayout: (body: CreateLayoutBody) =>
      mutate((ws) => {
        if (ws.layouts.length >= MAX_LAYOUTS) bad(`A workspace holds at most ${MAX_LAYOUTS} layouts.`);
        const t = clock();
        const layout: ChartLayout = {
          id: newId(),
          name: canonicalName(body.name, ws.layouts),
          symbol: body.symbol === undefined ? 'AAPL' : canonicalSymbol(body.symbol),
          timeframe: body.timeframe ?? '1D',
          chartType: body.chartType ?? 'candlestick',
          indicators: body.indicators === undefined ? [] : checkIndicators(body.indicators),
          revision: 1, createdAt: t, updatedAt: t,
        };
        assertEnums(layout);
        ws.layouts.push(layout);
        return layout;
      }),

    updateLayout: (id, body: UpdateLayoutBody) =>
      mutate((ws) => {
        const layout = find(ws.layouts, id, 'layout');
        checkRevision(layout, body.revision);
        if (body.name !== undefined) {
          layout.name = canonicalName(body.name, ws.layouts.filter((l) => l.id !== id));
        }
        if (body.symbol !== undefined) layout.symbol = canonicalSymbol(body.symbol);
        if (body.timeframe !== undefined) layout.timeframe = body.timeframe;
        if (body.chartType !== undefined) layout.chartType = body.chartType;
        if (body.indicators !== undefined) layout.indicators = checkIndicators(body.indicators);
        assertEnums(layout);
        layout.revision += 1;
        layout.updatedAt = clock();
        return layout;
      }),

    deleteLayout: (id) =>
      mutate((ws) => {
        find(ws.layouts, id, 'layout');
        if (ws.layouts.length === 1) bad('You cannot delete the last layout.');
        ws.layouts = ws.layouts.filter((l) => l.id !== id);
        if (ws.activeLayoutId === id) ws.activeLayoutId = (newest(ws.layouts) as ChartLayout).id;
        return ws;
      }),

    createWatchlist: (body: CreateWatchlistBody) =>
      mutate((ws) => {
        if (ws.watchlists.length >= MAX_WATCHLISTS) bad(`A workspace holds at most ${MAX_WATCHLISTS} watchlists.`);
        const t = clock();
        const list: Watchlist = {
          id: newId(),
          name: canonicalName(body.name, ws.watchlists),
          symbols: body.symbols === undefined ? [] : canonicalSymbols(body.symbols),
          revision: 1, createdAt: t, updatedAt: t,
        };
        ws.watchlists.push(list);
        // Same as the mock: the first watchlist after "none" becomes active, so the
        // client never has watchlists but no active one.
        if (ws.activeWatchlistId === null) ws.activeWatchlistId = list.id;
        return list;
      }),

    updateWatchlist: (id, body: UpdateWatchlistBody) =>
      mutate((ws) => {
        const list = find(ws.watchlists, id, 'watchlist');
        checkRevision(list, body.revision);
        if (body.name !== undefined) list.name = canonicalName(body.name, ws.watchlists.filter((w) => w.id !== id));
        if (body.symbols !== undefined) list.symbols = canonicalSymbols(body.symbols);
        list.revision += 1;
        list.updatedAt = clock();
        return list;
      }),

    deleteWatchlist: (id) =>
      mutate((ws) => {
        find(ws.watchlists, id, 'watchlist');
        ws.watchlists = ws.watchlists.filter((w) => w.id !== id);
        if (ws.activeWatchlistId === id) ws.activeWatchlistId = newest(ws.watchlists)?.id ?? null;
        return ws;
      }),

    setActive: (body: SetActiveBody) =>
      mutate((ws) => {
        // Check both ids before changing either: no half-applied request.
        if (body.activeLayoutId !== undefined) find(ws.layouts, body.activeLayoutId, 'layout');
        if (body.activeWatchlistId !== undefined && body.activeWatchlistId !== null) {
          find(ws.watchlists, body.activeWatchlistId, 'watchlist');
        }
        if (body.activeLayoutId !== undefined) ws.activeLayoutId = body.activeLayoutId;
        if (body.activeWatchlistId !== undefined) ws.activeWatchlistId = body.activeWatchlistId;
        return ws;
      }),
  };
}

/** Runtime backstop for callers that bypass the zod route schemas. */
function assertEnums(layout: ChartLayout): void {
  if (!(TIMEFRAMES as readonly string[]).includes(layout.timeframe)) bad('Invalid timeframe.');
  if (!['candlestick', 'line', 'area'].includes(layout.chartType)) bad('Invalid chartType.');
}
