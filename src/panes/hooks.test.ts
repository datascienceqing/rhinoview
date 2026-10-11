import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { IndicatorConfig } from '@shared/types';
import { moveIndicator, useIndicators } from './hooks';
import { indicator } from './testing/testHelpers';

const list = (): IndicatorConfig[] => {
  const a = indicator('sma');
  const b = indicator('rsi', [a]);
  const c = indicator('macd', [a, b]);
  return [a, b, c];
};
const kinds = (items: readonly IndicatorConfig[]) => items.map((c) => c.kind);

describe('moveIndicator', () => {
  it('moves an item up or down to the given index', () => {
    const items = list();
    expect(kinds(moveIndicator(items, items[2]?.id ?? '', 0))).toEqual(['macd', 'sma', 'rsi']);
    expect(kinds(moveIndicator(items, items[0]?.id ?? '', 2))).toEqual(['rsi', 'macd', 'sma']);
    expect(kinds(moveIndicator(items, items[1]?.id ?? '', 0))).toEqual(['rsi', 'sma', 'macd']);
  });

  it('returns the same array when nothing moves: same index, out of range, or an unknown id', () => {
    const items = list();
    expect(moveIndicator(items, items[1]?.id ?? '', 1)).toBe(items);
    expect(moveIndicator(items, items[1]?.id ?? '', -1)).toBe(items);
    expect(moveIndicator(items, items[1]?.id ?? '', 3)).toBe(items);
    expect(moveIndicator(items, 'nope', 0)).toBe(items);
  });
});

describe('useIndicators move', () => {
  it('commits the new order, and commits nothing for a move that changes nothing', () => {
    const items = list();
    const setIndicators = vi.fn();
    const { result } = renderHook(() => useIndicators(items, setIndicators));
    act(() => result.current.move(items[0]?.id ?? '', 0));
    act(() => result.current.move(items[0]?.id ?? '', -1));
    expect(setIndicators).not.toHaveBeenCalled();
    act(() => result.current.move(items[0]?.id ?? '', 1));
    expect(setIndicators).toHaveBeenCalledTimes(1);
    expect(kinds(setIndicators.mock.calls[0]?.[0] as IndicatorConfig[])).toEqual(['rsi', 'sma', 'macd']);
  });

  it('composes two moves in one burst on the latest list', () => {
    const items = list();
    const setIndicators = vi.fn();
    const { result } = renderHook(() => useIndicators(items, setIndicators));
    act(() => {
      result.current.move(items[2]?.id ?? '', 1);
      result.current.move(items[2]?.id ?? '', 0);
    });
    expect(kinds(setIndicators.mock.calls.at(-1)?.[0] as IndicatorConfig[])).toEqual(['macd', 'sma', 'rsi']);
  });
});
