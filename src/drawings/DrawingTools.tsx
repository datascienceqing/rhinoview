/**
 * The drawing tools: Measure and Fib retracement, with their toolbar at the top of the chart.
 *
 * Both tools work as in TradingView: pick the tool, click the first point, move the
 * pointer (the drawing follows it), and click the second point. The tool then switches
 * off. A measure shows until the next click on the chart or Escape. A Fib retracement
 * stays, one list per symbol, until "Remove drawings". Escape also cancels a drawing that
 * is not complete.
 *
 * Drawings are kept in memory for this session only: the workspace contract has no field
 * for them.
 */
import { useEffect, useMemo, useReducer, useRef } from 'react';
import type { Bar } from '@shared/types';
import type { PriceChart } from '../chart/PriceChart';
import { useI18n } from '../i18n';
import { useTheme } from '../theme';
import { DrawingsPrimitive } from './DrawingsPrimitive';
import { toAnchor, toIndexPoint } from './geometry';
import type { Anchor, DrawingTool, Segment } from './geometry';
import type { DrawScene, DrawStyle } from './paintDrawings';
import './drawings.css';

export interface DrawingState {
  tool: DrawingTool | null;
  /** The drawing between its first and its second click. */
  draft: { tool: DrawingTool; a: Anchor; b: Anchor } | null;
  /** The last complete measure; it shows until the next click. */
  measure: Segment<Anchor> | null;
  /** Fib retracements of each symbol. */
  fibs: Readonly<Record<string, readonly Segment<Anchor>[]>>;
}

export type DrawingAction =
  | { type: 'tool'; tool: DrawingTool }
  | { type: 'click'; symbol: string; p: Anchor }
  | { type: 'move'; p: Anchor }
  | { type: 'cancel' }
  | { type: 'clear'; symbol: string };

export const INITIAL_DRAWINGS: DrawingState = { tool: null, draft: null, measure: null, fibs: {} };

export function drawingReducer(state: DrawingState, action: DrawingAction): DrawingState {
  switch (action.type) {
    case 'tool':
      // A second press on the active tool switches it off.
      return { ...state, tool: state.tool === action.tool ? null : action.tool, draft: null, measure: null };
    case 'click': {
      const { draft } = state;
      if (draft) {
        const seg = { a: draft.a, b: action.p };
        if (draft.tool === 'measure') return { ...state, tool: null, draft: null, measure: seg };
        const list = state.fibs[action.symbol] ?? [];
        return { ...state, tool: null, draft: null, fibs: { ...state.fibs, [action.symbol]: [...list, seg] } };
      }
      if (state.tool) return { ...state, draft: { tool: state.tool, a: action.p, b: action.p }, measure: null };
      return state.measure ? { ...state, measure: null } : state;
    }
    case 'move':
      return state.draft ? { ...state, draft: { ...state.draft, b: action.p } } : state;
    case 'cancel':
      return state.tool || state.draft || state.measure ? { ...state, tool: null, draft: null, measure: null } : state;
    case 'clear':
      return { ...state, fibs: { ...state.fibs, [action.symbol]: [] } };
  }
}

export interface DrawingToolsProps {
  chart: PriceChart | null;
  symbol: string;
  bars: readonly Bar[];
}

export function DrawingTools({ chart, symbol, bars }: DrawingToolsProps) {
  const { t } = useI18n();
  const { theme } = useTheme();
  const [state, dispatch] = useReducer(drawingReducer, INITIAL_DRAWINGS);
  const latest = useRef({ symbol, bars });
  latest.current = { symbol, bars };

  const style = useMemo((): DrawStyle | null => {
    const c = chart?.colors;
    return c
      ? { upColor: c.up, downColor: c.down, textColor: c.text, labelText: '#ffffff', barsLabel: (n) => t('draw.bars', { count: n }) }
      : null;
    // `theme` is in the list because the chart's colours change with it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chart, theme, t]);

  const primitive = useRef<DrawingsPrimitive | null>(null);
  useEffect(() => {
    if (!chart || !style) return;
    const p = new DrawingsPrimitive(style);
    primitive.current = p;
    chart.attachPricePrimitive(p);
    return () => {
      primitive.current = null;
      chart.detachPricePrimitive(p);
    };
    // The primitive lives as long as the chart; the style goes in with each update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chart]);

  // A new symbol starts with no measure and no drawing in progress.
  useEffect(() => {
    dispatch({ type: 'cancel' });
  }, [symbol]);

  useEffect(() => {
    if (!chart) return;
    return chart.subscribePricePointer({
      move: (p) => {
        if (p && latest.current.bars.length > 0) dispatch({ type: 'move', p: toAnchor(latest.current.bars, p) });
      },
      click: (p) => {
        const { bars: b, symbol: s } = latest.current;
        if (b.length > 0) dispatch({ type: 'click', symbol: s, p: toAnchor(b, p) });
      },
    });
  }, [chart]);

  const active = state.tool !== null || state.draft !== null || state.measure !== null;
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dispatch({ type: 'cancel' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active]);

  const fibs = state.fibs[symbol];
  useEffect(() => {
    if (!style || !primitive.current) return;
    const scene: DrawScene = { fibs: [], measure: null };
    if (bars.length > 0) {
      const seg = (s: Segment<Anchor>) => ({ a: toIndexPoint(bars, s.a), b: toIndexPoint(bars, s.b) });
      const { draft } = state;
      scene.fibs = [...(fibs ?? []), ...(draft?.tool === 'fib' ? [draft] : [])].map(seg);
      const measure = draft?.tool === 'measure' ? draft : state.measure;
      scene.measure = measure ? seg(measure) : null;
    }
    primitive.current.update(scene, style);
  }, [bars, fibs, state, style]);

  const button = (tool: DrawingTool, label: string, title: string, icon: React.ReactNode) => (
    <button
      type="button"
      className="drawing-tool"
      aria-pressed={state.tool === tool}
      aria-label={label}
      title={title}
      onClick={() => dispatch({ type: 'tool', tool })}
    >
      {icon}
    </button>
  );

  return (
    <div className="drawing-toolbar" role="toolbar" aria-label={t('draw.group')}>
      {button('measure', t('draw.measure'), t('draw.measureTitle'), <MeasureIcon />)}
      {button('fib', t('draw.fib'), t('draw.fibTitle'), <FibIcon />)}
      {fibs && fibs.length > 0 && (
        <button
          type="button"
          className="drawing-tool"
          aria-label={t('draw.clear')}
          title={t('draw.clear')}
          onClick={() => dispatch({ type: 'clear', symbol })}
        >
          <TrashIcon />
        </button>
      )}
    </div>
  );
}

const iconProps = {
  width: 18,
  height: 18,
  viewBox: '0 0 18 18',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.3,
  'aria-hidden': true,
} as const;

/** A ruler. */
function MeasureIcon() {
  return (
    <svg {...iconProps}>
      <path d="M2.5 12.5 12.5 2.5l3 3-10 10z" />
      <path d="M5 10l1.5 1.5M7 8l2 2M9 6l1.5 1.5M11 4l2 2" />
    </svg>
  );
}

/** Level lines with a diagonal through them. */
function FibIcon() {
  return (
    <svg {...iconProps}>
      <path d="M2 3.5h14M2 7.5h14M2 11h14M2 15h14" strokeOpacity={0.7} />
      <path d="M3 15 15 3.5" strokeDasharray="2 1.5" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg {...iconProps}>
      <path d="M3 5h12M7 5V3h4v2M4.5 5l.8 10h7.4l.8-10M7.5 8v4.5M10.5 8v4.5" />
    </svg>
  );
}
