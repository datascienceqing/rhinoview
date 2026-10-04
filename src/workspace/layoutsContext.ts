/**
 * The layout-management side of the workspace: everything the switcher needs that the
 * frozen `ActiveChartApi` (symbol / timeframe / chart type / indicators) does not carry.
 * Kept apart from `useActiveChart` so W5 and W6 depend on the small seam only.
 */
import { createContext, useContext } from 'react';
import type { EntityId } from '@shared/types';

export type SaveState = 'saved' | 'saving' | 'error';
export type WorkspaceStatus = 'loading' | 'ready' | 'error';

/** The outcome of a user-triggered action; `message` is safe to show as is. */
export type ActionResult = { ok: true } | { ok: false; message: string };

export interface LayoutsApi {
  status: WorkspaceStatus;
  /** Why loading failed, when `status` is 'error'. */
  loadError: string | null;
  layouts: { id: EntityId; name: string }[];
  activeId: EntityId | null;
  saveState: SaveState;
  /** A short message the user should read (a conflict, a failed switch). Null when none. */
  notice: string | null;
  dismissNotice(): void;
  /** Fetch the layouts again (after a failed load). */
  reload(): void;
  /** Send edits that failed to save again. Never used for a conflict. */
  retrySave(): void;
  switchTo(id: EntityId): Promise<ActionResult>;
  create(name: string): Promise<ActionResult>;
  rename(id: EntityId, name: string): Promise<ActionResult>;
  duplicate(id: EntityId): Promise<ActionResult>;
  remove(id: EntityId): Promise<ActionResult>;
}

/** Null outside the persistent provider (for example under the in-memory one). */
export const LayoutsContext = createContext<LayoutsApi | null>(null);

export function useLayouts(): LayoutsApi | null {
  return useContext(LayoutsContext);
}

/** 'ready' when there is no persistent provider, so isolated components never wait. */
export function useWorkspaceStatus(): WorkspaceStatus {
  return useContext(LayoutsContext)?.status ?? 'ready';
}
