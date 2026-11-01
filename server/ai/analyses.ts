/**
 * Saved analyses (docs/AI_HELPER_PLAN.md, step E): the facts behind each AI alert, so the
 * agent can explain the alert when it fires. One JSON file, newest first, at most
 * MAX_ANALYSES entries. Written atomically like the alerts file.
 */
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { EntityId } from '@shared/types';
import { nodeWorkspaceFs } from '../workspace/store';
import type { WorkspaceFs } from '../workspace/store';

export const MAX_ANALYSES = 200;
const VERSION = 1;

export interface SavedAnalysis {
  id: EntityId;
  symbol: string;
  createdAt: number;
  question: string;
  facts: Record<string, unknown>;
  /** The model answer, when there was one. AI alerts make no model call. */
  text: string | null;
  alertIds: EntityId[];
}

export interface AnalysesStore {
  save(a: Omit<SavedAnalysis, 'id'> & { id?: EntityId }): Promise<SavedAnalysis>;
  get(id: EntityId): SavedAnalysis | null;
}

export interface AnalysesStoreOptions {
  fs?: WorkspaceFs;
  newId?: () => string;
  warn?: (message: string) => void;
}

export async function openAnalysesStore(filePath: string, opts: AnalysesStoreOptions = {}): Promise<AnalysesStore> {
  const fs = opts.fs ?? nodeWorkspaceFs;
  const newId = opts.newId ?? (() => randomUUID());
  const dir = dirname(filePath);
  await fs.mkdir(dir);
  let list: SavedAnalysis[] = [];
  const text = await fs.readFile(filePath);
  if (text !== null) {
    try {
      const parsed = JSON.parse(text) as { version?: number; analyses?: SavedAnalysis[] };
      if (parsed.version === VERSION && Array.isArray(parsed.analyses)) list = parsed.analyses;
    } catch {
      (opts.warn ?? console.warn)(`Analyses file ${filePath} is not valid JSON. It starts empty.`);
    }
  }
  // One write at a time, in order.
  let queue = Promise.resolve();

  async function persist(): Promise<void> {
    const tmp = join(dir, `.${newId()}.tmp`);
    try {
      await fs.writeFileSynced(tmp, `${JSON.stringify({ version: VERSION, analyses: list })}\n`);
      await fs.rename(tmp, filePath);
    } catch (err) {
      await fs.rm(tmp).catch(() => undefined);
      throw err;
    }
  }

  return {
    async save(a) {
      const saved: SavedAnalysis = { ...a, id: a.id ?? newId() };
      list = [saved, ...list.filter((x) => x.id !== saved.id)].slice(0, MAX_ANALYSES);
      const write = queue.then(persist);
      queue = write.catch(() => undefined);
      await write;
      return saved;
    },
    get(id) {
      return list.find((x) => x.id === id) ?? null;
    },
  };
}
