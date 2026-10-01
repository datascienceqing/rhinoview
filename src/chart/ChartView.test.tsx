import { render } from '@testing-library/react';
import { StrictMode } from 'react';
import type { Bar } from '@shared/types';
import { charts, fakeModule, lastChart, resetFakeCharts } from './testing/fakeLightweightCharts';
import { ChartView } from './ChartView';
import { PriceChart } from './PriceChart';

vi.mock('lightweight-charts', async () => (await import('./testing/fakeLightweightCharts')).fakeModule);

const bar = (time: number, close = 100): Bar => ({
  time,
  open: close,
  high: close + 1,
  low: close - 1,
  close,
  volume: 5,
  vwap: null,
  transactions: null,
});
const mk = (...times: number[]) => times.map((t) => bar(t));

beforeEach(resetFakeCharts);

describe('ChartView lifecycle', () => {
  it('removes every chart it creates, leaving exactly one alive, under StrictMode remounts', () => {
    const { unmount } = render(
      <StrictMode>
        <ChartView bars={mk(1, 2, 3)} chartType="candlestick" intraday={false} />
      </StrictMode>,
    );
    expect(charts.length).toBe(2); // mount, simulated unmount, remount
    expect(charts.filter((c) => !c.removed)).toHaveLength(1);
    unmount();
    expect(charts.every((c) => c.removed)).toBe(true);
  });

  it('turns every PriceChart method into a no-op after dispose (the fake throws on a removed chart)', () => {
    const pc = new PriceChart(document.createElement('div'));
    pc.setChartType('candlestick');
    pc.setBars(mk(1, 2, 3));
    pc.dispose();
    expect(() => {
      pc.setBars(mk(0, 1, 2, 3));
      pc.setChartType('line');
      pc.setIntraday(true);
      pc.dispose();
    }).not.toThrow();
    expect(pc.api).toBeNull();
  });

  it('feeds bar times to the series unchanged (Unix seconds in, seconds out)', () => {
    render(<ChartView bars={mk(1790775000, 1790775300)} chartType="candlestick" intraday />);
    const series = lastChart().liveSeries[0];
    const data = series?.setData.mock.calls.at(-1)?.[0] as { time: number }[];
    expect(data.map((d) => d.time)).toEqual([1790775000, 1790775300]);
  });
});

describe('ChartView series types', () => {
  it('uses the v5 addSeries(definition) API with the right definition per chart type', () => {
    const { rerender } = render(<ChartView bars={mk(1, 2)} chartType="candlestick" intraday={false} />);
    const chart = lastChart();
    expect(chart.liveSeries.map((s) => s.definition)).toEqual([fakeModule.CandlestickSeries]);

    rerender(<ChartView bars={mk(1, 2)} chartType="line" intraday={false} />);
    expect(chart.liveSeries.map((s) => s.definition)).toEqual([fakeModule.LineSeries]);

    rerender(<ChartView bars={mk(1, 2)} chartType="area" intraday={false} />);
    expect(chart.liveSeries.map((s) => s.definition)).toEqual([fakeModule.AreaSeries]);
  });

  it('switches type on the same chart instance and re-applies the data (no rebuild)', () => {
    const { rerender } = render(<ChartView bars={mk(1, 2, 3)} chartType="candlestick" intraday={false} />);
    rerender(<ChartView bars={mk(1, 2, 3)} chartType="line" intraday={false} />);
    expect(charts).toHaveLength(1);
    const line = lastChart().liveSeries[0];
    expect(line?.setData).toHaveBeenCalled();
    const data = line?.setData.mock.calls.at(-1)?.[0] as { value: number }[];
    expect(data.map((d) => d.value)).toEqual([100, 100, 100]);
  });
});

describe('ChartView events', () => {
  it('reports the crosshair time, and null when the crosshair leaves the chart', () => {
    const onCrosshairTime = vi.fn();
    render(<ChartView bars={mk(1, 2)} chartType="candlestick" intraday={false} onCrosshairTime={onCrosshairTime} />);
    lastChart().hover(2);
    lastChart().hover(undefined);
    expect(onCrosshairTime.mock.calls).toEqual([[2], [null]]);
  });

  it('asks for older history only when the visible range nears the oldest bar', () => {
    const onNearStart = vi.fn();
    render(<ChartView bars={mk(1, 2)} chartType="candlestick" intraday={false} onNearStart={onNearStart} />);
    lastChart().scrollTo({ from: 150, to: 250 });
    expect(onNearStart).not.toHaveBeenCalled();
    lastChart().scrollTo({ from: -10, to: 90 });
    expect(onNearStart).toHaveBeenCalledTimes(1);
  });

  it('keeps the scroll position when older bars are prepended (range shifts by the number added)', () => {
    const { rerender } = render(<ChartView bars={mk(10, 11, 12)} chartType="candlestick" intraday={false} />);
    const chart = lastChart();
    chart.visibleRange = { from: 0, to: 20 };
    rerender(<ChartView bars={mk(7, 8, 9, 10, 11, 12)} chartType="candlestick" intraday={false} />);
    expect(chart.visibleRange).toEqual({ from: 3, to: 23 });
  });

  it('resets the view (does not shift) when the whole series is replaced', () => {
    const { rerender } = render(<ChartView bars={mk(10, 11, 12)} chartType="candlestick" intraday={false} />);
    const chart = lastChart();
    chart.visibleRange = { from: 0, to: 20 };
    rerender(<ChartView bars={mk(100, 200, 300, 400)} chartType="candlestick" intraday={false} />);
    expect(chart.visibleRange).toEqual({ from: 0, to: 20 }); // not shifted
    expect(chart.fitContentCalls).toBeGreaterThan(1); // initial load + the replace
  });
});
