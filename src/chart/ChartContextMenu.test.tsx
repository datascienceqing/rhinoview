import { fireEvent, render, screen } from '@testing-library/react';
import { I18nProvider } from '../i18n';
import { indicator, computeAll, makeBars } from '../panes/testing/testHelpers';
import { ThemeProvider } from '../theme';
import { ChartContextMenu, SCROLL_CLOSE_PX, SCROLL_GRACE_MS } from './ChartContextMenu';
import { ChartView } from './ChartView';
import type { ChartMenuTarget } from './ChartView';
import { lastChart, resetFakeCharts } from './testing/fakeLightweightCharts';
import type { FakePane } from './testing/fakeLightweightCharts';

vi.mock('lightweight-charts', async () => (await import('./testing/fakeLightweightCharts')).fakeModule);

beforeEach(resetFakeCharts);

const bars = makeBars(60);

/** Place a pane's row on the page: rows are 300 px high, from y = 0, 860 px wide (800 plot + 60 scale). */
function placePanes(panes: FakePane[]) {
  panes.forEach((p, i) => {
    p.element.getBoundingClientRect = () => ({ left: 0, top: i * 300, right: 860, bottom: (i + 1) * 300, width: 860, height: 300, x: 0, y: i * 300, toJSON: () => ({}) });
  });
}

function rightClick(x: number, y: number): boolean {
  const container = screen.getByTestId('chart-container');
  return fireEvent.contextMenu(container, { clientX: x, clientY: y, bubbles: true, cancelable: true });
}

describe('ChartView: where the chart menu opens', () => {
  it('a right-click on the price plot opens it with the price at the pointer', () => {
    const onMenu = vi.fn<(t: ChartMenuTarget) => void>();
    render(<ChartView bars={bars} chartType="candlestick" intraday={false} onContextMenu={onMenu} />);
    placePanes(lastChart().paneList);
    // The fake price scale: price = (1000 - y) / 2, with y from the top of the pane.
    const notPrevented = rightClick(100, 120);
    expect(notPrevented).toBe(false);
    expect(onMenu).toHaveBeenCalledWith({ x: 100, y: 120, pane: 'price', price: 440 });
  });

  it('a right-click on the price scale or the time scale leaves the browser menu', () => {
    const onMenu = vi.fn();
    render(<ChartView bars={bars} chartType="candlestick" intraday={false} onContextMenu={onMenu} />);
    placePanes(lastChart().paneList);
    expect(rightClick(830, 120)).toBe(true); // on the price scale
    expect(rightClick(100, 320)).toBe(true); // below the only pane: the time scale
    expect(onMenu).not.toHaveBeenCalled();
  });

  it('a right-click in an RSI pane gives that indicator and the RSI value', () => {
    const onMenu = vi.fn<(t: ChartMenuTarget) => void>();
    const rsi = indicator('rsi');
    render(<ChartView bars={bars} chartType="candlestick" intraday={false} indicators={computeAll(bars, [rsi])} onContextMenu={onMenu} />);
    placePanes(lastChart().paneList);
    expect(lastChart().paneList).toHaveLength(2);
    // 260 px into pane 1: the fake scale gives (1000 - 260) / 2.
    rightClick(100, 300 + 260);
    expect(onMenu).toHaveBeenCalledWith({ x: 100, y: 560, pane: 'indicator', indicatorId: rsi.id, value: 370 });
  });

  it('Shift+F10 and the menu key open it at the middle of the chart with the middle price', () => {
    const onMenu = vi.fn<(t: ChartMenuTarget) => void>();
    render(<ChartView bars={bars} chartType="candlestick" intraday={false} onContextMenu={onMenu} />);
    const container = screen.getByTestId('chart-container');
    container.getBoundingClientRect = () => ({ left: 0, top: 0, right: 800, bottom: 400, width: 800, height: 400, x: 0, y: 0, toJSON: () => ({}) });
    expect(container).toHaveAttribute('tabindex', '0');
    fireEvent.keyDown(container, { key: 'F10', shiftKey: true });
    fireEvent.keyDown(container, { key: 'ContextMenu' });
    expect(onMenu).toHaveBeenCalledTimes(2);
    // The fake price scale shows 100..200.
    expect(onMenu).toHaveBeenLastCalledWith({ x: 400, y: 200, pane: 'price', price: 150 });
  });

  it('without a handler there is no menu and the chart takes no focus', () => {
    render(<ChartView bars={bars} chartType="candlestick" intraday={false} />);
    placePanes(lastChart().paneList);
    expect(rightClick(100, 120)).toBe(true);
    expect(screen.getByTestId('chart-container')).not.toHaveAttribute('tabindex');
  });
});

describe('ChartView: alert lines', () => {
  it('draws a dashed line per level, and keeps them after a chart type change', () => {
    const { rerender } = render(<ChartView bars={bars} chartType="candlestick" intraday={false} alertLevels={[150, 160]} />);
    const price = () => lastChart().liveSeries[0];
    expect(price()?.priceLines.map((l) => l.options.price)).toEqual([150, 160]);
    rerender(<ChartView bars={bars} chartType="line" intraday={false} alertLevels={[150, 160]} />);
    expect(price()?.priceLines.map((l) => l.options.price)).toEqual([150, 160]);
    rerender(<ChartView bars={bars} chartType="line" intraday={false} alertLevels={[170]} />);
    expect(price()?.priceLines.map((l) => l.options.price)).toEqual([170]);
  });
});

describe('ChartContextMenu', () => {
  function renderMenu(over: Partial<Parameters<typeof ChartContextMenu>[0]> = {}) {
    const props = {
      x: 50,
      y: 60,
      alertItems: [
        { id: 'alert', label: 'Add alert at 150.00…', onSelect: vi.fn() },
        { id: 'alert-sma', label: 'Add alert on SMA 20…', onSelect: vi.fn() },
        { id: 'alert-ema', label: 'Add alert on EMA 50…', onSelect: vi.fn() },
      ],
      onClose: vi.fn(),
      ...over,
    };
    render(
      <I18nProvider>
        <ThemeProvider>
          <ChartContextMenu {...props} />
        </ThemeProvider>
      </I18nProvider>,
    );
    return props;
  }

  it('lists the items in order and focuses the first', () => {
    renderMenu();
    const items = screen.getAllByRole('menuitem').map((b) => b.textContent);
    expect(items).toEqual(['Add alert at 150.00…', 'Add alert on SMA 20…', 'Add alert on EMA 50…']);
    expect(screen.getAllByRole('menuitem')[0]).toHaveFocus();
  });

  it('a pick runs the item and closes the menu', () => {
    const p = renderMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Add alert at 150.00…' }));
    expect(p.alertItems[0]?.onSelect).toHaveBeenCalled();
    expect(p.onClose).toHaveBeenCalled();
  });

  it('Esc, a click outside and a scroll close it; arrows move the focus', () => {
    const p = renderMenu();
    const items = screen.getAllByRole('menuitem');
    expect(items).toHaveLength(3);
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowDown' });
    expect(items[1]).toHaveFocus();
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowUp' });
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowUp' });
    expect(items[2]).toHaveFocus();
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    fireEvent.pointerDown(document.body);
    expect(p.onClose).toHaveBeenCalledTimes(2);
  });

  it('a scroll closes it, but not the small wheel noise of a touch mouse during the right-click', () => {
    let now = 1_000;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    const p = renderMenu();
    // Right after it opens: even a large wheel event is the click, not a scroll.
    fireEvent.wheel(window, { deltaY: 100 });
    now += SCROLL_GRACE_MS;
    // Later: small movements add up, and close it only at SCROLL_CLOSE_PX.
    fireEvent.wheel(window, { deltaY: 3 });
    fireEvent.wheel(window, { deltaX: -2 });
    expect(p.onClose).not.toHaveBeenCalled();
    fireEvent.wheel(window, { deltaY: SCROLL_CLOSE_PX });
    expect(p.onClose).toHaveBeenCalledTimes(1);
    clock.mockRestore();
  });

  it('a wheel in lines counts as pixels', () => {
    let now = 1_000;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    const p = renderMenu();
    now += SCROLL_GRACE_MS;
    fireEvent.wheel(window, { deltaY: 2, deltaMode: 1 });
    expect(p.onClose).toHaveBeenCalledTimes(1);
    clock.mockRestore();
  });

  it('has no theme, language, or Financials items', () => {
    renderMenu();
    expect(screen.queryByRole('menuitem', { name: /Theme|Language|Financials/ })).toBeNull();
  });
});
