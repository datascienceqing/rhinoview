import { render } from '@testing-library/react';
import type { AiMarks, Bar } from '@shared/types';
import { lastChart, resetFakeCharts } from './testing/fakeLightweightCharts';
import { AiZonesPrimitive } from './AiZonesPrimitive';
import { ChartView } from './ChartView';
import { aiLineTitle } from './PriceChart';

vi.mock('lightweight-charts', async () => (await import('./testing/fakeLightweightCharts')).fakeModule);

const bars: Bar[] = [1, 2, 3].map((t) => ({ time: t, open: 100, high: 101, low: 99, close: 100, volume: 5, vwap: null, transactions: null }));
const MARKS: AiMarks = {
  lines: [
    { price: 110, label: 'short retest entry', role: 'trigger' },
    { price: 113, label: 'short retest stop', role: 'stop' },
    { price: 95, label: 'short retest T1', role: 'target' },
  ],
  zones: [{ top: 104, bottom: 102, label: 'bearish FVG', role: 'supply' }],
};

beforeEach(resetFakeCharts);

const zonesOf = () => lastChart().liveSeries[0]?.primitives.filter((p) => p instanceof AiZonesPrimitive) ?? [];

describe('AI marks on the chart', () => {
  it('draws a dotted line per level and one zone layer, and keeps them after a chart type change', () => {
    const { rerender } = render(<ChartView bars={bars} chartType="candlestick" intraday={false} aiMarks={MARKS} />);
    const lines = () => lastChart().liveSeries[0]?.priceLines.map((l) => [l.options.price, (l.options as { title?: string }).title]);
    expect(lines()).toEqual([[110, 'AI▼ entry'], [113, 'AI▼ stop'], [95, 'AI▼ T1']]);
    expect(zonesOf()).toHaveLength(1);

    rerender(<ChartView bars={bars} chartType="line" intraday={false} aiMarks={MARKS} />);
    expect(lines()).toHaveLength(3);
    expect(zonesOf()).toHaveLength(1);
  });

  it('removes the lines and the zones with null', () => {
    const { rerender } = render(<ChartView bars={bars} chartType="candlestick" intraday={false} aiMarks={MARKS} />);
    rerender(<ChartView bars={bars} chartType="candlestick" intraday={false} aiMarks={null} />);
    expect(lastChart().liveSeries[0]?.priceLines).toEqual([]);
    expect(zonesOf()).toHaveLength(0);
  });

  it('keeps the alert lines when the AI lines change', () => {
    const { rerender } = render(<ChartView bars={bars} chartType="candlestick" intraday={false} alertLevels={[120]} aiMarks={MARKS} />);
    rerender(<ChartView bars={bars} chartType="candlestick" intraday={false} alertLevels={[120]} aiMarks={null} />);
    expect(lastChart().liveSeries[0]?.priceLines.map((l) => l.options.price)).toEqual([120]);
  });

  it('puts each zone between its prices', () => {
    render(<ChartView bars={bars} chartType="candlestick" intraday={false} aiMarks={MARKS} />);
    const zone = zonesOf()[0] as AiZonesPrimitive;
    // The fake maps price p to y = 1000 − 2p.
    expect(zone.bands()).toEqual([{ y: 792, height: 4, role: 'supply' }]);
  });
});

describe('aiLineTitle', () => {
  it('keeps the side and the level name short', () => {
    expect(aiLineTitle({ price: 1, label: 'long market stop', role: 'stop' })).toBe('AI▲ stop');
    expect(aiLineTitle({ price: 1, label: 'short continuation T2', role: 'target' })).toBe('AI▼ T2');
    expect(aiLineTitle({ price: 1, label: 'zone', role: 'target' })).toBe('AI');
  });
});
