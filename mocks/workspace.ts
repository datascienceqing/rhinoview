/**
 * MSW mock of the workspace endpoints — ORCHESTRATOR-OWNED, frozen for Phase 5.
 *
 * Both W4 (layouts) and W5 (watchlist) build against this one mock, so it implements
 * the WHOLE contract as strictly as the real server must: validation, limits, name
 * uniqueness, revision conflicts, not-found, "at least one layout", and active-id
 * reassignment on delete. A mock that accepts more than the server does hid the Gate 1
 * blocker; this one must not repeat that.
 */
import { http } from 'msw';
import type {
  ApiErrorCode,
  ChartLayout,
  CreateLayoutBody,
  CreateWatchlistBody,
  SetActiveBody,
  UpdateLayoutBody,
  UpdateWatchlistBody,
  Watchlist,
  Workspace,
} from '@shared/types';
import { MAX_LAYOUTS, MAX_NAME_LENGTH, MAX_QUOTE_SYMBOLS, MAX_WATCHLISTS, TIMEFRAMES } from '@shared/types';
import { fail, ok } from './envelope';

const CHART_TYPES = ['candlestick', 'line', 'area'] as const;
const SYMBOL_RE = /^[A-Za-z0-9.^=-]{1,16}$/;

let seq = 0;
let clock = 1_790_000_000;
const nextId = (p: string) => `${p}_${(++seq).toString(36)}`;
const now = () => ++clock;

function defaults(): Workspace {
  const t = now();
  const layout: ChartLayout = {
    id: nextId('lay'), name: 'Main', symbol: 'AAPL', timeframe: '1D', chartType: 'candlestick',
    indicators: [], revision: 1, createdAt: t, updatedAt: t,
  };
  const watchlist: Watchlist = {
    id: nextId('wl'), name: 'Watchlist', symbols: ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL'],
    revision: 1, createdAt: t, updatedAt: t,
  };
  return { layouts: [layout], watchlists: [watchlist], activeLayoutId: layout.id, activeWatchlistId: watchlist.id };
}

let ws: Workspace = defaults();

/** Tests: restore the default workspace. Call in beforeEach. */
export function resetMockWorkspace(next?: Workspace): void {
  ws = next ?? defaults();
}

/** Tests: read the mock's current state. */
export function mockWorkspace(): Workspace {
  return structuredClone(ws);
}

class Reject extends Error {
  constructor(public code: ApiErrorCode, message: string, public current?: unknown) {
    super(message);
  }
}

function name(raw: unknown, taken: { id: string; name: string }[], selfId?: string): string {
  if (typeof raw !== 'string') throw new Reject('BAD_REQUEST', 'name is required.');
  const n = raw.trim();
  if (n.length < 1 || n.length > MAX_NAME_LENGTH) throw new Reject('BAD_REQUEST', `name must be 1-${MAX_NAME_LENGTH} characters.`);
  if (taken.some((e) => e.id !== selfId && e.name.toLowerCase() === n.toLowerCase())) {
    throw new Reject('BAD_REQUEST', `The name "${n}" is already in use.`);
  }
  return n;
}

function symbols(raw: unknown): string[] {
  if (!Array.isArray(raw)) throw new Reject('BAD_REQUEST', 'symbols must be an array.');
  const out: string[] = [];
  for (const s of raw) {
    if (typeof s !== 'string' || !SYMBOL_RE.test(s)) throw new Reject('BAD_REQUEST', `Invalid symbol: ${String(s)}`);
    const u = s.toUpperCase();
    if (!out.includes(u)) out.push(u);
  }
  if (out.length > MAX_QUOTE_SYMBOLS) throw new Reject('BAD_REQUEST', `A watchlist holds at most ${MAX_QUOTE_SYMBOLS} symbols.`);
  return out;
}

function layoutFields(b: Partial<CreateLayoutBody>, into: ChartLayout): void {
  if (b.symbol !== undefined) {
    if (!SYMBOL_RE.test(b.symbol)) throw new Reject('BAD_REQUEST', 'Invalid symbol.');
    into.symbol = b.symbol.toUpperCase();
  }
  if (b.timeframe !== undefined) {
    if (!TIMEFRAMES.includes(b.timeframe)) throw new Reject('BAD_REQUEST', 'Invalid timeframe.');
    into.timeframe = b.timeframe;
  }
  if (b.chartType !== undefined) {
    if (!(CHART_TYPES as readonly string[]).includes(b.chartType)) throw new Reject('BAD_REQUEST', 'Invalid chartType.');
    into.chartType = b.chartType;
  }
  if (b.indicators !== undefined) {
    if (!Array.isArray(b.indicators)) throw new Reject('BAD_REQUEST', 'indicators must be an array.');
    into.indicators = structuredClone(b.indicators);
  }
}

function find<T extends { id: string }>(list: T[], id: string, kind: 'layout' | 'watchlist'): T {
  const e = list.find((x) => x.id === id);
  if (!e) throw new Reject('NOT_FOUND', `No ${kind} with id ${id}.`);
  return e;
}

function checkRevision(entity: ChartLayout | Watchlist, revision: unknown): void {
  if (typeof revision !== 'number') throw new Reject('BAD_REQUEST', 'revision is required.');
  if (revision !== entity.revision) throw new Reject('CONFLICT', 'This was changed elsewhere.', structuredClone(entity));
}

const newest = <T extends { updatedAt: number }>(l: T[]) => [...l].sort((a, b) => b.updatedAt - a.updatedAt)[0];

async function handle<T>(fn: () => T | Promise<T>) {
  try {
    return ok(await fn());
  } catch (e) {
    if (e instanceof Reject) return fail({ code: e.code, message: e.message });
    throw e;
  }
}

const body = async <T>(request: Request): Promise<T> => {
  try {
    return (await request.json()) as T;
  } catch {
    throw new Reject('BAD_REQUEST', 'Malformed JSON body.');
  }
};

export function createWorkspaceHandlers() {
  return [
    http.get('*/api/workspace', () => handle(() => structuredClone(ws))),
    http.get('*/api/layouts', () => handle(() => ({ layouts: structuredClone(ws.layouts), activeLayoutId: ws.activeLayoutId }))),
    http.get('*/api/watchlists', () =>
      handle(() => ({ watchlists: structuredClone(ws.watchlists), activeWatchlistId: ws.activeWatchlistId })),
    ),

    http.post('*/api/layouts', ({ request }) =>
      handle(async () => {
        const b = await body<CreateLayoutBody>(request);
        if (ws.layouts.length >= MAX_LAYOUTS) throw new Reject('BAD_REQUEST', `At most ${MAX_LAYOUTS} layouts.`);
        const t = now();
        const l: ChartLayout = {
          id: nextId('lay'), name: name(b.name, ws.layouts), symbol: 'AAPL', timeframe: '1D', chartType: 'candlestick',
          indicators: [], revision: 1, createdAt: t, updatedAt: t,
        };
        layoutFields(b, l);
        ws.layouts.push(l);
        return structuredClone(l);
      }),
    ),

    http.put('*/api/layouts/:id', ({ request, params }) =>
      handle(async () => {
        const b = await body<UpdateLayoutBody>(request);
        const l = find(ws.layouts, String(params.id), 'layout');
        checkRevision(l, b.revision);
        const next = structuredClone(l);
        if (b.name !== undefined) next.name = name(b.name, ws.layouts, l.id);
        layoutFields(b, next);
        next.revision += 1;
        next.updatedAt = now();
        Object.assign(l, next);
        return structuredClone(l);
      }),
    ),

    http.delete('*/api/layouts/:id', ({ params }) =>
      handle(() => {
        const l = find(ws.layouts, String(params.id), 'layout');
        if (ws.layouts.length === 1) throw new Reject('BAD_REQUEST', 'You cannot delete the last layout.');
        ws.layouts = ws.layouts.filter((x) => x.id !== l.id);
        if (ws.activeLayoutId === l.id) ws.activeLayoutId = (newest(ws.layouts) as ChartLayout).id;
        return structuredClone(ws);
      }),
    ),

    http.post('*/api/watchlists', ({ request }) =>
      handle(async () => {
        const b = await body<CreateWatchlistBody>(request);
        if (ws.watchlists.length >= MAX_WATCHLISTS) throw new Reject('BAD_REQUEST', `At most ${MAX_WATCHLISTS} watchlists.`);
        const t = now();
        const w: Watchlist = {
          id: nextId('wl'), name: name(b.name, ws.watchlists), symbols: b.symbols === undefined ? [] : symbols(b.symbols),
          revision: 1, createdAt: t, updatedAt: t,
        };
        ws.watchlists.push(w);
        if (ws.activeWatchlistId === null) ws.activeWatchlistId = w.id;
        return structuredClone(w);
      }),
    ),

    http.put('*/api/watchlists/:id', ({ request, params }) =>
      handle(async () => {
        const b = await body<UpdateWatchlistBody>(request);
        const w = find(ws.watchlists, String(params.id), 'watchlist');
        checkRevision(w, b.revision);
        const next = structuredClone(w);
        if (b.name !== undefined) next.name = name(b.name, ws.watchlists, w.id);
        if (b.symbols !== undefined) next.symbols = symbols(b.symbols);
        next.revision += 1;
        next.updatedAt = now();
        Object.assign(w, next);
        return structuredClone(w);
      }),
    ),

    http.delete('*/api/watchlists/:id', ({ params }) =>
      handle(() => {
        const w = find(ws.watchlists, String(params.id), 'watchlist');
        ws.watchlists = ws.watchlists.filter((x) => x.id !== w.id);
        if (ws.activeWatchlistId === w.id) ws.activeWatchlistId = newest(ws.watchlists)?.id ?? null;
        return structuredClone(ws);
      }),
    ),

    http.put('*/api/workspace/active', ({ request }) =>
      handle(async () => {
        const b = await body<SetActiveBody>(request);
        if (b.activeLayoutId !== undefined) ws.activeLayoutId = find(ws.layouts, b.activeLayoutId, 'layout').id;
        if (b.activeWatchlistId !== undefined) {
          ws.activeWatchlistId = b.activeWatchlistId === null ? null : find(ws.watchlists, b.activeWatchlistId, 'watchlist').id;
        }
        return structuredClone(ws);
      }),
    ),
  ];
}
