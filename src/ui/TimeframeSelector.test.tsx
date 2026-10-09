import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http } from 'msw';
import type { ChartLayout, Timeframe } from '@shared/types';
import { TIMEFRAMES } from '@shared/types';
import { ok } from '../../mocks/envelope';
import { mockWorkspace, resetMockWorkspace } from '../../mocks/workspace';
import { server } from '../../mocks/server';
import { resetCapabilitiesCache } from '../data';
import { InMemoryWorkspaceProvider, WorkspaceProvider, useActiveChart } from '../workspace';
import { TimeframeSelector } from './TimeframeSelector';

const NO_1M: Timeframe[] = ['5m', '15m', '1h', '1D', '1W'];
const serveCapabilities = (timeframes: Timeframe[]) =>
  server.use(
    http.get('*/api/capabilities', () => ok({ timeframes, delayed: true, provider: 'test', fundamentals: true })),
  );

beforeEach(() => {
  resetCapabilitiesCache();
  resetMockWorkspace();
});

const button = (tf: string) =>
  within(screen.getByRole('group', { name: 'Timeframe' })).getByRole('button', { name: tf });

describe('TimeframeSelector', () => {
  it('enables every timeframe while capabilities are not known yet', () => {
    server.use(http.get('*/api/capabilities', () => new Promise(() => undefined))); // never answers
    render(<TimeframeSelector value="1D" onChange={() => undefined} />);
    for (const tf of TIMEFRAMES) expect(button(tf)).toBeEnabled();
  });

  it('disables the timeframes the provider does not serve, and enables the rest', async () => {
    serveCapabilities(NO_1M);
    render(<TimeframeSelector value="1D" onChange={() => undefined} />);
    await waitFor(() => expect(button('1m')).toBeDisabled());
    for (const tf of NO_1M) expect(button(tf)).toBeEnabled();
    expect(button('1D')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByTestId('timeframe-fallback-notice')).toBeNull();
  });

  it('does not call onChange for a disabled timeframe', async () => {
    serveCapabilities(NO_1M);
    const onChange = vi.fn();
    render(<TimeframeSelector value="1D" onChange={onChange} />);
    await waitFor(() => expect(button('1m')).toBeDisabled());
    await userEvent.setup().click(button('1m'));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('shows the next coarser supported timeframe, with a notice, when the saved one is not served', async () => {
    serveCapabilities(NO_1M);
    render(<TimeframeSelector value="1m" onChange={() => undefined} />);
    expect(await screen.findByTestId('timeframe-fallback-notice')).toHaveTextContent(/1m is not available.*Showing 5m/);
    expect(button('5m')).toHaveAttribute('aria-pressed', 'true');
    expect(button('1m')).toHaveAttribute('aria-pressed', 'false');
  });

  it('leaves the SAVED layout alone until the user picks a timeframe', async () => {
    serveCapabilities(NO_1M);
    resetMockWorkspace({
      ...mockWorkspace(),
      layouts: [{ ...(mockWorkspace().layouts[0] as ChartLayout), timeframe: '1m' }],
    });
    const writes: string[] = [];
    server.events.on('request:start', ({ request }) => {
      if (request.method === 'PUT') writes.push(new URL(request.url).pathname);
    });
    function Connected() {
      const { chart, setTimeframe } = useActiveChart();
      return <TimeframeSelector value={chart.timeframe} onChange={setTimeframe} />;
    }
    const user = userEvent.setup();
    render(
      <WorkspaceProvider>
        <Connected />
      </WorkspaceProvider>,
    );
    expect(await screen.findByTestId('timeframe-fallback-notice')).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 900)); // longer than the save debounce
    expect(writes).toEqual([]);
    expect(mockWorkspace().layouts[0]?.timeframe).toBe('1m');

    await user.click(button('15m'));
    await waitFor(() => expect(mockWorkspace().layouts[0]?.timeframe).toBe('15m'), { timeout: 3000 });
    expect(screen.queryByTestId('timeframe-fallback-notice')).toBeNull();
    server.events.removeAllListeners();
  });

  it('lets the user pick the timeframe that is already shown as the fallback, saving it', async () => {
    serveCapabilities(NO_1M);
    const onChange = vi.fn();
    render(
      <InMemoryWorkspaceProvider>
        <TimeframeSelector value="1m" onChange={onChange} />
      </InMemoryWorkspaceProvider>,
    );
    await screen.findByTestId('timeframe-fallback-notice');
    await userEvent.setup().click(button('5m'));
    expect(onChange).toHaveBeenCalledWith('5m');
  });
});
