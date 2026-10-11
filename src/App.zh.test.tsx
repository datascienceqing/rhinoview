/** The whole app in Chinese: the toolbar toggle, the texts, the formats and the colour attribute. */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { resetFakeCharts, lastChart } from './chart/testing/fakeLightweightCharts';
import { resetMockWorkspace } from '../mocks/workspace';
import { LOCALE_KEY } from './i18n';
import { App } from './App';

vi.mock('lightweight-charts', async () => (await import('./chart/testing/fakeLightweightCharts')).fakeModule);

beforeEach(() => {
  resetFakeCharts();
  resetMockWorkspace();
  localStorage.clear();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-01T12:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
});

describe('App in Chinese', () => {
  it('uses the stored choice: Chinese toolbar, chart title, quote badge and watchlist', async () => {
    localStorage.setItem(LOCALE_KEY, 'zh');
    render(<App />);
    expect(document.documentElement.dataset.locale).toBe('zh');
    expect(document.documentElement.lang).toBe('zh-CN');
    expect(await screen.findByTestId('crosshair-legend')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'K线' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '日线' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('group', { name: '周期' })).toBeInTheDocument();
    expect(screen.getByText('AAPL · 日线')).toBeInTheDocument();
    expect(await screen.findByTestId('synthetic-badge')).toHaveTextContent('模拟数据');
    expect(screen.getByRole('combobox', { name: '搜索代码' })).toHaveAttribute('placeholder', '搜索代码或公司');
    const watchlist = screen.getByTestId('watchlist-panel');
    expect(await within(watchlist).findByRole('button', { name: '新建列表' })).toBeInTheDocument();
    expect(within(watchlist).getByRole('button', { name: /^按涨跌幅排序/ })).toBeInTheDocument();
  });

  it('shows volumes in 万 and 亿 in the legend', async () => {
    localStorage.setItem(LOCALE_KEY, 'zh');
    render(<App />);
    const volume = await screen.findByTestId('legend-volume');
    expect(volume.textContent).toMatch(/[万亿]$/);
  });

  it('the toggle switches between English and Chinese, stores it, and redraws the chart labels', async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByTestId('crosshair-legend');
    expect(screen.getByRole('button', { name: 'Candles' })).toBeInTheDocument();
    const chart = lastChart();
    const before = chart.applyOptions.mock.calls.length;

    await user.click(screen.getByRole('button', { name: /Switch to Chinese/ }));
    expect(screen.getByRole('button', { name: 'K线' })).toBeInTheDocument();
    expect(document.documentElement.dataset.locale).toBe('zh');
    expect(localStorage.getItem(LOCALE_KEY)).toBe('zh');
    // The same chart instance, told to draw its labels again in the new language.
    expect(lastChart()).toBe(chart);
    await waitFor(() => expect(chart.applyOptions.mock.calls.length).toBeGreaterThan(before));
    expect(chart.applyOptions).toHaveBeenCalledWith(expect.objectContaining({ localization: { locale: 'zh-CN' } }));

    await user.click(screen.getByRole('button', { name: /Switch to English/ }));
    expect(screen.getByRole('button', { name: 'Candles' })).toBeInTheDocument();
    expect(document.documentElement.dataset.locale).toBe('en');
    expect(localStorage.getItem(LOCALE_KEY)).toBe('en');
  });

  it('the indicator menu and editor are in Chinese, and the indicator names stay in English', async () => {
    localStorage.setItem(LOCALE_KEY, 'zh');
    const user = userEvent.setup();
    render(<App />);
    await screen.findByTestId('crosshair-legend');
    await user.click(screen.getByRole('button', { name: /^指标/ }));
    expect(screen.getByRole('button', { name: '添加 RSI' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '添加 Liquidity' }));
    expect(screen.getByRole('button', { name: '删除 LIQ (10)' })).toBeInTheDocument();
    expect(screen.getByLabelText('区域')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: '整根 K 线' })).toBeInTheDocument();
  });
});
