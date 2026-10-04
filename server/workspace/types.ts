/**
 * WORKSPACE STORE SEAM — between the persistence layer and the HTTP layer.
 *
 * ORCHESTRATOR-OWNED. Frozen for Phase 5. Report problems; do not edit.
 *
 * The workspace holds the user's named chart layouts and watchlists. It is one user's
 * data, kept in one JSON file on the server, so that charts and watchlists follow the
 * user to any browser that reaches the app.
 */
import type {
  ChartLayout,
  CreateLayoutBody,
  CreateWatchlistBody,
  EntityId,
  SetActiveBody,
  UpdateLayoutBody,
  UpdateWatchlistBody,
  Watchlist,
  Workspace,
} from '@shared/types';

export interface WorkspaceStore {
  getWorkspace(): Promise<Workspace>;

  /** @throws WorkspaceValidationError */
  createLayout(body: CreateLayoutBody): Promise<ChartLayout>;
  /** @throws WorkspaceNotFoundError | WorkspaceConflictError | WorkspaceValidationError */
  updateLayout(id: EntityId, body: UpdateLayoutBody): Promise<ChartLayout>;
  /** @throws WorkspaceNotFoundError | WorkspaceValidationError (when it is the last layout) */
  deleteLayout(id: EntityId): Promise<Workspace>;

  /** @throws WorkspaceValidationError */
  createWatchlist(body: CreateWatchlistBody): Promise<Watchlist>;
  /** @throws WorkspaceNotFoundError | WorkspaceConflictError | WorkspaceValidationError */
  updateWatchlist(id: EntityId, body: UpdateWatchlistBody): Promise<Watchlist>;
  /** @throws WorkspaceNotFoundError */
  deleteWatchlist(id: EntityId): Promise<Workspace>;

  /** @throws WorkspaceNotFoundError when an id does not exist */
  setActive(body: SetActiveBody): Promise<Workspace>;
}

/** → 404 NOT_FOUND */
export class WorkspaceNotFoundError extends Error {
  constructor(public readonly kind: 'layout' | 'watchlist', public readonly id: string) {
    super(`No ${kind} with id ${id}`);
    this.name = 'WorkspaceNotFoundError';
  }
}

/** → 409 CONFLICT. Carries the current entity so the client can show the latest state. */
export class WorkspaceConflictError extends Error {
  constructor(public readonly current: ChartLayout | Watchlist) {
    super(`Stale revision; current revision is ${current.revision}`);
    this.name = 'WorkspaceConflictError';
  }
}

/** → 400 BAD_REQUEST. `message` must be safe and useful to show to the user. */
export class WorkspaceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceValidationError';
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// INVARIANTS. Each one is an acceptance criterion and each one needs a test.
//
// 1. DURABLE BEFORE THE RESPONSE. A write is on disk before the request answers.
//
// 2. ATOMIC FILE WRITES. Write a temporary file in the same directory, fsync it, then
//    rename it over the old file. A crash at any moment leaves the old file or the new
//    file, never a half-written file.
//
// 3. ONE WRITER AT A TIME. Serialize all writes inside the process (a promise-chain
//    mutex). Two requests must not interleave read-modify-write and lose an update.
//
// 4. NEVER DESTROY THE ONLY COPY. A missing file creates the default workspace. A file
//    that does not parse or does not validate is RENAMED to
//    `<file>.corrupt-<unix-seconds>`, a warning is logged, and the store starts from
//    the default workspace. Never crash on a bad file. Never overwrite it without the
//    backup.
//
// 5. OPTIMISTIC CONCURRENCY. Every layout and watchlist has a `revision` that starts
//    at 1 and increments on every successful write. An update with a stale revision
//    throws WorkspaceConflictError. This is what stops two open tabs from silently
//    overwriting each other.
//
// 6. AT LEAST ONE LAYOUT. Deleting the last layout is a validation error. Deleting the
//    active layout makes the most recently updated remaining layout active.
//    Deleting the active watchlist makes the most recently updated remaining watchlist
//    active, or null when none remain.
//
// 7. NAMES. Trimmed, 1–MAX_NAME_LENGTH characters, unique within their kind compared
//    case-insensitively. A duplicate is a validation error with a clear message.
//
// 8. LIMITS. At most MAX_LAYOUTS layouts, MAX_WATCHLISTS watchlists, and
//    MAX_QUOTE_SYMBOLS symbols in one watchlist. Exceeding one is a validation error.
//
// 9. SYMBOLS. The store does not call the market engine; it validates FORMAT only:
//    1–16 characters of [A-Za-z0-9.^=-], uppercased, duplicates removed (keep the first
//    occurrence, keep the user's order). A symbol can be valid today and delisted
//    tomorrow, so existence is the quotes endpoint's job (`missing`), not the store's.
//
// 10. LAYOUT CONTENTS. `timeframe` is a valid Timeframe, `chartType` a valid ChartType,
//     and each indicator a valid IndicatorConfig whose params obey the bounds in
//     src/indicators/types.ts. Reject an invalid layout; never store one.
//
// 11. DEFAULT WORKSPACE. One layout named "Main": AAPL, 1D, candlestick, no indicators.
//     One watchlist named "Watchlist": AAPL, MSFT, NVDA, AMZN, GOOGL. Both active.
//
// 12. VERSIONED FILE. The file carries `"version": 1` at the top level, so a later
//     phase can migrate it. The file never contains a secret.
//
// 13. LOCATION. `WORKSPACE_FILE` from server/env.ts, default `data/workspace.json`.
//     Create the directory when it does not exist. `data/` is gitignored.
// ───────────────────────────────────────────────────────────────────────────────
