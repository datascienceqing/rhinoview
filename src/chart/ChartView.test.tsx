import { act, fireEvent, render, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import type { Bar } from '@shared/types';
import { charts, fakeModule, lastChart, resetFakeCharts } from './testing/fakeLightweightCharts';
import { ChartView } from './ChartView';
import { PriceChart } from './PriceChart';
import { ThemeProvider } from '../theme';
import { ThemeToggle } from '../ui/ThemeToggle';

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

  it('reports its PriceChart to onChart after it is created, and null when it is disposed', () => {
    const onChart = vi.fn();
    const { unmount } = render(<ChartView bars={mk(1, 2, 3)} chartType="candlestick" intraday={false} onChart={onChart} />);
    expect(onChart).toHaveBeenCalledTimes(1);
    expect(onChart.mock.calls[0]?.[0]).toBeInstanceOf(PriceChart);
    unmount();
    expect(onChart).toHaveBeenLastCalledWith(null);
  });

  it('feeds bar times to the series unchanged (Unix seconds in, seconds out)', () => {
    render(<ChartView bars={mk(1790775000, 1790775300)} chartType="candlestick" intraday />);
    const series = lastChart().liveSeries[0];
    const data = series?.setData.mock.calls.at(-1)?.[0] as { time: number }[];
    expect(data.map((d) => d.time)).toEqual([1790775000, 1790775300]);
  });
});

describe('PriceChart geometry for overlays', () => {
  // The fake: x = 100 + 8 * logical, plot width 700, price pane height 400.
  it('maps bars to x and x to the nearest bar, and reports the plot and pane sizes', () => {
    const pc = new PriceChart(document.createElement('div'));
    expect(pc.barX(5)).toBe(140);
    expect(pc.barAt(143)).toBe(5);
    expect(pc.barAt(145)).toBe(6);
    expect(pc.plotWidth()).toBe(700);
    expect(pc.pricePaneHeight()).toBe(400);
  });

  it('scrolls a bar to the centre and keeps the number of bars in view', () => {
    const pc = new PriceChart(document.createElement('div'));
    lastChart().visibleRange = { from: 100, to: 160 };
    pc.scrollToBar(40);
    expect(pc.visibleRange()).toEqual({ from: 10, to: 70 });
  });

  it('calls a view listener on a scroll and on a resize, until it unsubscribes', () => {
    const pc = new PriceChart(document.createElement('div'));
    const chart = lastChart();
    const listener = vi.fn();
    const off = pc.subscribeView(listener);
    chart.scrollTo({ from: 1, to: 2 });
    chart.sizeHandlers.forEach((h) => h());
    expect(listener).toHaveBeenCalledTimes(2);
    off();
    chart.scrollTo({ from: 3, to: 4 });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('is safe after dispose: no geometry, and an unsubscribe that does nothing', () => {
    const pc = new PriceChart(document.createElement('div'));
    const off = pc.subscribeView(vi.fn());
    pc.dispose();
    expect(() => off()).not.toThrow();
    expect(pc.barX(1)).toBeNull();
    expect(pc.barAt(1)).toBeNull();
    expect(pc.visibleRange()).toBeNull();
    expect(pc.plotWidth()).toBe(0);
    expect(pc.pricePaneHeight()).toBe(0);
    expect(() => pc.scrollToBar(1)).not.toThrow();
    expect(pc.subscribeView(vi.fn())()).toBeUndefined();
  });
});

describe('ChartView series types', () => {
  it('uses the v5 addSeries(definition) API with the right definition per chart type', () => {
    const { rerender } = render(<ChartView bars={mk(1, 2)} chartType="candlestick" intraday={false} />);
    const chart = lastChart();
    expect(chart.liveSeries.map((s) => s.definition)).toEqual([fakeModule.CandlestickSeries]);

    rerender(<ChartView bars={mk(1, 2)} chartType="line" intraday={false} />);
    expect(chart.liveSeries.map((s) => s.definition)).toEqual([fakeModule.LineSeries]);

    rerender(<ChartView bars={mk(1, 2)} chartType="bar" intraday={false} />);
    expect(chart.liveSeries.map((s) => s.definition)).toEqual([fakeModule.BarSeries]);
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

describe('ChartView markers (Phase 5 seam)', () => {
  const DAY = 86_400;
  const T0 = 1_790_000_000;
  const daily = [0, 1, 2, 3].map((d) => bar(T0 + d * DAY));
  const earnings = [{ id: 'e1', time: T0 + 2 * DAY, text: 'E' }];
  const priceSeries = () => lastChart().liveSeries[0];

  it('draws a marker on the bar that contains its date', () => {
    render(<ChartView bars={daily} chartType="candlestick" intraday={false} markers={earnings} />);
    const drawn = priceSeries()?.markersApi?.markers as { time: number; text: string }[];
    expect(drawn.map((m) => [m.time, m.text])).toEqual([[T0 + 2 * DAY, 'E']]);
  });

  it('keeps the markers when the chart type changes (the price series is replaced)', () => {
    const { rerender } = render(<ChartView bars={daily} chartType="candlestick" intraday={false} markers={earnings} />);
    rerender(<ChartView bars={daily} chartType="line" intraday={false} markers={earnings} />);
    const series = priceSeries();
    expect(series?.definition).toEqual(fakeModule.LineSeries);
    expect((series?.markersApi?.markers as unknown[]).length).toBe(1);
  });

  it('attaches no markers plugin when there are no markers', () => {
    render(<ChartView bars={daily} chartType="candlestick" intraday={false} />);
    expect(priceSeries()?.markersApi).toBeUndefined();
  });
});

describe('ChartView vertical pan and the Auto button', () => {
  const DAY = 86_400;
  const T0 = 1_790_000_000;
  const daily = [0, 1, 2, 3].map((d) => bar(T0 + d * DAY));
  const other = [0, 1, 2].map((d) => bar(T0 + 100 * DAY + d * DAY, 50));

  // jsdom has no PointerEvent; the code reads only these fields.
  const pointer = (type: string, x: number, y: number) => {
    const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
    Object.defineProperty(e, 'pointerId', { value: 1 });
    Object.defineProperty(e, 'pointerType', { value: 'mouse' });
    return e;
  };

  function verticalDrag() {
    const pane = lastChart().paneList[0];
    if (!pane) throw new Error('no pane');
    pane.element.getBoundingClientRect = () =>
      ({ top: 0, bottom: 400, left: 0, right: 800, width: 800, height: 400, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    act(() => {
      screen.getByTestId('chart-container').dispatchEvent(pointer('pointerdown', 300, 200));
      window.dispatchEvent(pointer('pointermove', 300, 320));
      window.dispatchEvent(pointer('pointerup', 300, 320));
    });
  }
  const priceScale = () => lastChart().paneList[0]?.priceScale('right');

  it('shows no Auto button while the axis is auto-fitted', () => {
    render(<ChartView bars={daily} chartType="candlestick" intraday={false} />);
    expect(screen.queryByRole('button', { name: 'Auto' })).toBeNull();
  });

  it('shows Auto after a vertical drag; a click fits the axis again and hides the button', () => {
    render(<ChartView bars={daily} chartType="candlestick" intraday={false} />);
    verticalDrag();
    expect(priceScale()?.options().autoScale).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Auto' }));
    expect(priceScale()?.options().autoScale).toBe(true);
    expect(screen.queryByRole('button', { name: 'Auto' })).toBeNull();
  });

  it('fits the axis again when the bars are replaced (new symbol or timeframe)', () => {
    const { rerender } = render(<ChartView bars={daily} chartType="candlestick" intraday={false} />);
    verticalDrag();
    rerender(<ChartView bars={other} chartType="candlestick" intraday={false} />);
    expect(priceScale()?.options().autoScale).toBe(true);
    expect(screen.queryByRole('button', { name: 'Auto' })).toBeNull();
  });

  it('keeps the dragged axis when older history is prepended', () => {
    const { rerender } = render(<ChartView bars={daily} chartType="candlestick" intraday={false} />);
    verticalDrag();
    rerender(<ChartView bars={[bar(T0 - DAY), ...daily]} chartType="candlestick" intraday={false} />);
    expect(priceScale()?.options().autoScale).toBe(false);
  });
});

describe('theme change', () => {
  // jsdom does not inherit CSS variables, so the light values go on the container itself.
  const sheet = document.createElement('style');
  sheet.textContent =
    "[data-theme='light'] [data-testid='chart-container'] { --bg: #ffffff; --text: #131722; --border: #e0e3eb; --up: #00796b; --down: #cc2936; --accent: #2962ff; }";
  beforeAll(() => document.head.appendChild(sheet));
  afterAll(() => sheet.remove());
  afterEach(() => {
    delete document.documentElement.dataset.theme;
  });

  const memory = () => {
    const data: Record<string, string> = {};
    return () => ({ getItem: (k: string) => data[k] ?? null, setItem: (k: string, v: string) => void (data[k] = v) });
  };

  it('repaints the chart and the price series in the new colours', () => {
    render(
      <ThemeProvider storage={memory()}>
        <ThemeToggle />
        <ChartView bars={mk(1, 2)} chartType="candlestick" intraday={false} />
      </ThemeProvider>,
    );
    const chart = lastChart();
    const candles = chart.liveSeries[0];
    act(() => screen.getByRole('button', { name: 'Switch to light theme' }).click());
    expect(chart.applyOptions).toHaveBeenLastCalledWith(
      expect.objectContaining({ layout: expect.objectContaining({ background: expect.objectContaining({ color: '#ffffff' }), textColor: '#131722' }) }),
    );
    expect(candles?.applyOptions).toHaveBeenLastCalledWith(expect.objectContaining({ upColor: '#00796b', downColor: '#cc2936' }));
  });

  it('does not touch the chart when the colours did not change', () => {
    const { rerender } = render(
      <ThemeProvider storage={memory()}>
        <ChartView bars={mk(1, 2)} chartType="candlestick" intraday={false} />
      </ThemeProvider>,
    );
    const chart = lastChart();
    const calls = chart.applyOptions.mock.calls.length;
    rerender(
      <ThemeProvider storage={memory()}>
        <ChartView bars={mk(1, 2)} chartType="candlestick" intraday={false} />
      </ThemeProvider>,
    );
    expect(chart.applyOptions.mock.calls.length).toBe(calls);
  });
});
