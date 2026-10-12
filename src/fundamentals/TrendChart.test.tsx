import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { niceTicks, TrendChart } from './TrendChart';

describe('niceTicks', () => {
  it('covers the range with round steps that include zero', () => {
    expect(niceTicks(0, 394)).toEqual([0, 100, 200, 300, 400]);
    expect(niceTicks(-0.12, 0.3)).toEqual([-0.2, 0, 0.2, 0.4]);
    expect(niceTicks(0, 0.3)).toEqual([0, 0.1, 0.2, 0.3]);
  });
});

describe('TrendChart', () => {
  const labels = Array.from({ length: 12 }, (_, i) => `Q${(i % 4) + 1} FY${2023 + Math.floor(i / 4)}`);
  const values = labels.map((_, i) => (i + 1) * 10);

  it('labels the y axis with the tick format', () => {
    const { getByTestId } = render(
      <TrendChart id="t" title="T" kind="bar" labels={labels} series={[{ name: 'T', color: 'red', values }]} format={String} tick={(v) => `${v}u`} />,
    );
    const ys = [...getByTestId('chart-t').querySelectorAll('.fund-y-tick text')].map((e) => e.textContent);
    expect(ys).toEqual(['0u', '50u', '100u', '150u']);
  });

  it('labels the x axis, and drops labels that would touch but keeps the newest', () => {
    const { getByTestId } = render(
      <TrendChart id="t" title="T" kind="bar" labels={labels} series={[{ name: 'T', color: 'red', values }]} format={String} />,
    );
    const xs = [...getByTestId('chart-t').querySelectorAll('.fund-x-tick')].map((e) => e.textContent);
    expect(xs.length).toBeGreaterThan(1);
    expect(xs.length).toBeLessThan(labels.length);
    expect(xs[xs.length - 1]).toBe('Q4 FY2025');
  });
});
