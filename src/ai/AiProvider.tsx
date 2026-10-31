/**
 * State of the AI helper (docs/AI_HELPER_PLAN.md, step C): the panel, the current
 * analysis, and the marks that the chart draws. One analysis at a time; a new question
 * stops the one before it.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { AiAlertsResponse, AiAnalyzeEvent, AiMarks, AiNumberCheck, EntityId } from '@shared/types';
import { deleteAlert } from '../alerts/api';
import { apiRequest, apiStream, toDataError } from '../data';

export type AiStatus = 'idle' | 'loading' | 'streaming' | 'done' | 'error';

export interface AiAnalysis {
  symbol: string;
  question: string;
  status: AiStatus;
  text: string;
  check: AiNumberCheck | null;
  marks: AiMarks | null;
  /** The facts said the prices are generated (synthetic or mock provider). */
  synthetic: boolean;
  /** Sentences of the data check, from the facts: stale data, missing fields. */
  stale: boolean;
  missing: string[];
  error: string | null;
}

/** The result of "AI alerts…" on the chart menu. */
export interface AiAlertsRun {
  symbol: string;
  status: 'loading' | 'done' | 'error';
  result: AiAlertsResponse | null;
  error: string | null;
  /** Alerts that the user removed from this result. */
  removed: number;
}

export interface AiState {
  open: boolean;
  setOpen(open: boolean): void;
  analysis: AiAnalysis | null;
  ask(symbol: string, question: string): void;
  stop(): void;
  /** Show the marks of the analysis on the chart. */
  showMarks: boolean;
  setShowMarks(show: boolean): void;
  clear(): void;
  /** Make the AI alerts for `symbol`, and open the panel to show them. */
  runAlerts(symbol: string): void;
  aiAlerts: AiAlertsRun | null;
  removeAiAlert(id: EntityId): Promise<void>;
  closeAiAlerts(): void;
}

const AiContext = createContext<AiState | null>(null);

export function useAi(): AiState {
  const ctx = useContext(AiContext);
  if (!ctx) throw new Error('useAi needs an AiProvider');
  return ctx;
}

/** The AI state, or null outside a provider (the chart panel in tests). */
export function useAiMaybe(): AiState | null {
  return useContext(AiContext);
}

/** The marks to draw for `symbol`, or null. Safe outside a provider (charts in tests). */
export function useAiMarks(symbol: string): AiMarks | null {
  const ctx = useContext(AiContext);
  if (!ctx?.showMarks || !ctx.analysis || ctx.analysis.symbol !== symbol.toUpperCase()) return null;
  return ctx.analysis.marks;
}

export function AiProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [analysis, setAnalysis] = useState<AiAnalysis | null>(null);
  const [showMarks, setShowMarks] = useState(true);
  const controller = useRef<AbortController | null>(null);
  const [aiAlerts, setAiAlerts] = useState<AiAlertsRun | null>(null);
  const alertsRun = useRef(0);

  const runAlerts = useCallback((symbol: string) => {
    const run = ++alertsRun.current;
    const sym = symbol.toUpperCase();
    setOpen(true);
    setAiAlerts({ symbol: sym, status: 'loading', result: null, error: null, removed: 0 });
    apiRequest<AiAlertsResponse>('/ai/alerts', { method: 'POST', body: { symbol: sym } })
      .then((result) => {
        if (run === alertsRun.current) setAiAlerts({ symbol: result.symbol, status: 'done', result, error: null, removed: 0 });
      })
      .catch((e: unknown) => {
        if (run === alertsRun.current) setAiAlerts({ symbol: sym, status: 'error', result: null, error: toDataError(e).message, removed: 0 });
      });
  }, []);

  const removeAiAlert = useCallback(async (id: EntityId) => {
    await deleteAlert(id);
    setAiAlerts((r) => (r?.result ? { ...r, removed: r.removed + 1, result: { ...r.result, added: r.result.added.filter((a) => a.id !== id) } } : r));
  }, []);

  const closeAiAlerts = useCallback(() => {
    alertsRun.current++;
    setAiAlerts(null);
  }, []);

  const stop = useCallback(() => {
    controller.current?.abort();
    controller.current = null;
    setAnalysis((a) => (a && (a.status === 'loading' || a.status === 'streaming') ? { ...a, status: a.text ? 'done' : 'idle' } : a));
  }, []);

  const ask = useCallback((symbol: string, question: string) => {
    controller.current?.abort();
    const ac = new AbortController();
    controller.current = ac;
    const sym = symbol.toUpperCase();
    setShowMarks(true);
    setAnalysis({ symbol: sym, question, status: 'loading', text: '', check: null, marks: null, synthetic: false, stale: false, missing: [], error: null });
    const update = (f: (a: AiAnalysis) => AiAnalysis) => {
      if (controller.current === ac) setAnalysis((a) => (a ? f(a) : a));
    };
    apiStream<AiAnalyzeEvent>(
      '/ai/analyze',
      (ev) => {
        if (ev.type === 'facts') {
          const check = (ev.facts.dataCheck ?? {}) as { stale?: boolean; missing?: string[] };
          update((a) => ({
            ...a, status: 'streaming', symbol: ev.symbol, marks: ev.marks,
            synthetic: ev.facts.synthetic === true, stale: check.stale === true, missing: check.missing ?? [],
          }));
        } else if (ev.type === 'delta') update((a) => ({ ...a, text: a.text + ev.text }));
        else if (ev.type === 'done') update((a) => ({ ...a, status: 'done', text: ev.text, check: ev.check }));
        else update((a) => ({ ...a, status: 'error', error: ev.error.message }));
      },
      { body: { symbol: sym, question }, signal: ac.signal },
    )
      .then(() => update((a) => (a.status === 'streaming' || a.status === 'loading' ? { ...a, status: 'error', error: null } : a)))
      .catch((e: unknown) => {
        const err = toDataError(e);
        if (err.code === 'ABORTED') return;
        update((a) => ({ ...a, status: 'error', error: err.message }));
      });
  }, []);

  const clear = useCallback(() => {
    controller.current?.abort();
    controller.current = null;
    setAnalysis(null);
  }, []);

  useEffect(() => () => controller.current?.abort(), []);

  const value = useMemo<AiState>(
    () => ({ open, setOpen, analysis, ask, stop, showMarks, setShowMarks, clear, runAlerts, aiAlerts, removeAiAlert, closeAiAlerts }),
    [open, analysis, ask, stop, showMarks, clear, runAlerts, aiAlerts, removeAiAlert, closeAiAlerts],
  );
  return <AiContext.Provider value={value}>{children}</AiContext.Provider>;
}
