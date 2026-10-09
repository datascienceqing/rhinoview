import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http } from 'msw';
import type { ChartLayout } from '@shared/types';
import { fail } from '../../mocks/envelope';
import { mockWorkspace, resetMockWorkspace } from '../../mocks/workspace';
import { server } from '../../mocks/server';
import { apiRequest } from '../data';
import { WorkspaceProvider, useActiveChart } from '../workspace';
import { LayoutSwitcher } from './LayoutSwitcher';

function Probe() {
  const { chart, setSymbol } = useActiveChart();
  return (
    <>
      <output data-testid="chart">
        {chart.name}|{chart.symbol}|{chart.timeframe}|{chart.chartType}|{chart.indicators.map((i) => i.kind).join(',')}
      </output>
      <button type="button" onClick={() => setSymbol('MSFT')}>
        edit symbol
      </button>
    </>
  );
}

const renderApp = () =>
  render(
    <WorkspaceProvider>
      <LayoutSwitcher />
      <Probe />
    </WorkspaceProvider>,
  );

/** A workspace with "Main" (AAPL 1D) and "Swing" (NVDA 1W, line, RSI). */
async function seedTwoLayouts(): Promise<ChartLayout> {
  const swing = await apiRequest<ChartLayout>('/layouts', {
    method: 'POST',
    body: {
      name: 'Swing',
      symbol: 'NVDA',
      timeframe: '1W',
      chartType: 'line',
      indicators: [{ id: 'r', kind: 'rsi', params: { period: 14 }, color: '#2962ff', visible: true }],
    },
  });
  return swing;
}

async function ready() {
  await waitFor(() => expect(screen.getByTestId('chart')).toHaveTextContent('|AAPL|'));
}
async function openPanel(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /^Layout:/ }));
  return screen.getByRole('dialog', { name: 'Layouts' });
}

beforeEach(() => resetMockWorkspace());

describe('LayoutSwitcher', () => {
  it('shows the active layout name and lists every layout', async () => {
    await seedTwoLayouts();
    const user = userEvent.setup();
    renderApp();
    await ready();
    expect(screen.getByRole('button', { name: 'Layout: Main' })).toBeInTheDocument();
    const panel = await openPanel(user);
    expect(
      within(panel)
        .getAllByRole('button', { name: /^(Main|Swing)$/ })
        .map((b) => b.textContent),
    ).toEqual(['Main', 'Swing']);
  });

  it('switching layouts swaps symbol, timeframe, chart type and indicators, and records the active layout', async () => {
    const swing = await seedTwoLayouts();
    const user = userEvent.setup();
    renderApp();
    await ready();
    expect(screen.getByTestId('chart')).toHaveTextContent('Main|AAPL|1D|candlestick|');

    const panel = await openPanel(user);
    await user.click(within(panel).getByRole('button', { name: 'Swing' }));
    await waitFor(() => expect(screen.getByTestId('chart')).toHaveTextContent('Swing|NVDA|1W|line|rsi'));
    expect(screen.queryByRole('dialog', { name: 'Layouts' })).toBeNull(); // closes after a switch
    await waitFor(() => expect(mockWorkspace().activeLayoutId).toBe(swing.id));

    // And back: Main's own settings return, untouched by Swing.
    const again = await openPanel(user);
    await user.click(within(again).getByRole('button', { name: 'Main' }));
    await waitFor(() => expect(screen.getByTestId('chart')).toHaveTextContent('Main|AAPL|1D|candlestick|'));
  });

  it('saves an unsaved edit to the old layout when switching away, not to the new one', async () => {
    const swing = await seedTwoLayouts();
    const user = userEvent.setup();
    renderApp();
    await ready();
    await user.click(screen.getByRole('button', { name: 'edit symbol' })); // inside the debounce window...
    const panel = await openPanel(user);
    await user.click(within(panel).getByRole('button', { name: 'Swing' })); // ...switch away at once
    await waitFor(() => expect(mockWorkspace().layouts[0]?.symbol).toBe('MSFT'), { timeout: 3000 });
    expect(mockWorkspace().layouts.find((l) => l.id === swing.id)?.symbol).toBe('NVDA');
    expect(screen.getByTestId('chart')).toHaveTextContent('Swing|NVDA|');
  });

  it('creates a layout from a name, makes it active, and refuses a duplicate name with the server message', async () => {
    const user = userEvent.setup();
    renderApp();
    await ready();
    let panel = await openPanel(user);
    await user.click(within(panel).getByRole('button', { name: 'New…' }));
    await user.type(within(panel).getByLabelText('New layout name'), 'main'); // same as "Main", case-insensitively
    await user.click(within(panel).getByRole('button', { name: 'Create' }));
    expect(await within(panel).findByRole('alert')).toHaveTextContent(/already in use/);
    expect(mockWorkspace().layouts).toHaveLength(1);

    const input = within(panel).getByLabelText('New layout name');
    await user.clear(input);
    await user.type(input, 'Intraday');
    await user.click(within(panel).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Layout: Intraday' })).toBeInTheDocument());
    expect(mockWorkspace().layouts.map((l) => l.name)).toEqual(['Main', 'Intraday']);
    expect(mockWorkspace().activeLayoutId).toBe(mockWorkspace().layouts[1]?.id);
    panel = screen.queryByRole('dialog', { name: 'Layouts' }) as HTMLElement;
    expect(panel).toBeNull();
  });

  it('renames the active layout and shows server rejections', async () => {
    await seedTwoLayouts();
    const user = userEvent.setup();
    renderApp();
    await ready();
    const panel = await openPanel(user);
    await user.click(within(panel).getByRole('button', { name: 'Rename…' }));
    const input = within(panel).getByLabelText('Layout name');
    expect(input).toHaveValue('Main');

    await user.clear(input);
    await user.type(input, 'swing');
    await user.click(within(panel).getByRole('button', { name: 'Rename' }));
    expect(await within(panel).findByRole('alert')).toHaveTextContent(/already in use/);

    await user.clear(input);
    await user.type(input, '  Core  ');
    await user.click(within(panel).getByRole('button', { name: 'Rename' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Layout: Core' })).toBeInTheDocument());
    expect(mockWorkspace().layouts[0]?.name).toBe('Core');
  });

  it('duplicates the active layout, including its indicators, under a free name, and activates the copy', async () => {
    const swing = await seedTwoLayouts();
    await apiRequest('/workspace/active', { method: 'PUT', body: { activeLayoutId: swing.id } });
    const user = userEvent.setup();
    renderApp();
    await waitFor(() => expect(screen.getByTestId('chart')).toHaveTextContent('Swing|NVDA|1W|line|rsi'));
    const panel = await openPanel(user);
    await user.click(within(panel).getByRole('button', { name: 'Duplicate' }));
    await waitFor(() => expect(screen.getByTestId('chart')).toHaveTextContent('Swing copy|NVDA|1W|line|rsi'));
    const names = mockWorkspace().layouts.map((l) => l.name);
    expect(names).toEqual(['Main', 'Swing', 'Swing copy']);

    // A second duplicate must not collide with the first copy.
    const p2 = await openPanel(user);
    await user.click(within(p2).getByRole('button', { name: 'Duplicate' }));
    await waitFor(() => expect(mockWorkspace().layouts.map((l) => l.name)).toContain('Swing copy copy'));
  });

  describe('delete', () => {
    it('asks for confirmation, and Cancel deletes nothing', async () => {
      await seedTwoLayouts();
      const user = userEvent.setup();
      renderApp();
      await ready();
      const panel = await openPanel(user);
      await user.click(within(panel).getByRole('button', { name: 'Delete…' }));
      const confirm = within(panel).getByRole('alertdialog', { name: 'Confirm delete' });
      expect(confirm).toHaveTextContent('Delete layout “Main”?');
      expect(mockWorkspace().layouts).toHaveLength(2); // nothing sent yet
      await user.click(within(confirm).getByRole('button', { name: 'Cancel' }));
      expect(within(panel).queryByRole('alertdialog')).toBeNull();
      expect(mockWorkspace().layouts).toHaveLength(2);
    });

    it('deletes after confirmation and moves to the layout the server makes active', async () => {
      const swing = await seedTwoLayouts();
      const user = userEvent.setup();
      renderApp();
      await ready();
      const panel = await openPanel(user);
      await user.click(within(panel).getByRole('button', { name: 'Delete…' }));
      await user.click(within(panel).getByRole('button', { name: 'Delete' }));
      await waitFor(() => expect(screen.getByTestId('chart')).toHaveTextContent('Swing|NVDA|1W|line|rsi'));
      expect(mockWorkspace().layouts.map((l) => l.id)).toEqual([swing.id]);
    });

    it('refreshes the list and says so when the layout was already deleted in another tab', async () => {
      const swing = await seedTwoLayouts();
      const user = userEvent.setup();
      renderApp();
      await ready();
      const panel = await openPanel(user);
      await user.click(within(panel).getByRole('button', { name: 'Delete…' }));
      const main = mockWorkspace().layouts[0];
      await apiRequest(`/layouts/${main?.id}`, { method: 'DELETE' }); // "another tab" removes Main first
      await user.click(within(panel).getByRole('button', { name: 'Delete' }));
      expect(await screen.findByTestId('layout-notice')).toHaveTextContent(/already deleted elsewhere/);
      await waitFor(() => expect(screen.getByTestId('chart')).toHaveTextContent('Swing|NVDA|'));
      expect(mockWorkspace().layouts.map((l) => l.id)).toEqual([swing.id]);
    });

    it('shows the server refusal when deleting the last layout, and keeps it', async () => {
      const user = userEvent.setup();
      renderApp();
      await ready();
      const panel = await openPanel(user);
      await user.click(within(panel).getByRole('button', { name: 'Delete…' }));
      await user.click(within(panel).getByRole('button', { name: 'Delete' }));
      expect(await within(panel).findByRole('alert')).toHaveTextContent(/cannot delete the last layout/i);
      expect(mockWorkspace().layouts).toHaveLength(1);
      expect(screen.getByRole('button', { name: 'Layout: Main' })).toBeInTheDocument();
    });
  });

  it('reports a failed switch, and stays on the current layout', async () => {
    await seedTwoLayouts();
    server.use(
      http.put('*/api/workspace/active', () => fail({ code: 'UPSTREAM_ERROR', message: 'Server unavailable.' })),
    );
    const user = userEvent.setup();
    renderApp();
    await ready();
    const panel = await openPanel(user);
    await user.click(within(panel).getByRole('button', { name: 'Swing' }));
    expect(await within(panel).findByRole('alert')).toHaveTextContent(/Could not switch layout/);
    await waitFor(() => expect(screen.getByTestId('chart')).toHaveTextContent('Main|AAPL|'));
  });

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    renderApp();
    await ready();
    await openPanel(user);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Layouts' })).toBeNull();
  });

  describe('save state', () => {
    it('shows Saved, then Saving while an edit waits to be written, then Saved again', async () => {
      const user = userEvent.setup();
      renderApp();
      await ready();
      const state = screen.getByTestId('layout-save-state');
      expect(state).toHaveTextContent('Saved');
      await user.click(screen.getByRole('button', { name: 'edit symbol' }));
      expect(state).toHaveTextContent('Saving…');
      await waitFor(() => expect(mockWorkspace().layouts[0]?.symbol).toBe('MSFT'), { timeout: 3000 });
      await waitFor(() => expect(state).toHaveTextContent('Saved'));
    });

    it('shows "Save failed" with a Retry button when the server fails, and Retry saves the edit', async () => {
      server.use(http.put('*/api/layouts/:id', () => fail({ code: 'UPSTREAM_ERROR', message: 'down' })));
      const user = userEvent.setup();
      renderApp();
      await ready();
      await user.click(screen.getByRole('button', { name: 'edit symbol' }));
      const state = screen.getByTestId('layout-save-state');
      await waitFor(() => expect(state).toHaveTextContent('Save failed'), { timeout: 3000 });
      expect(mockWorkspace().layouts[0]?.symbol).toBe('AAPL');

      server.resetHandlers();
      await user.click(within(state).getByRole('button', { name: 'Retry' }));
      await waitFor(() => expect(mockWorkspace().layouts[0]?.symbol).toBe('MSFT'), { timeout: 3000 });
      await waitFor(() => expect(state).toHaveTextContent('Saved'));
    });
  });

  it('shows the conflict notice, and it can be dismissed', async () => {
    const user = userEvent.setup();
    renderApp();
    await ready();
    const id = mockWorkspace().layouts[0]?.id;
    await apiRequest(`/layouts/${id}`, { method: 'PUT', body: { revision: 1, timeframe: '1W' } });
    await user.click(screen.getByRole('button', { name: 'edit symbol' }));
    const notice = await screen.findByTestId('layout-notice', undefined, { timeout: 3000 });
    expect(notice).toHaveTextContent(/changed elsewhere/);
    await waitFor(() => expect(screen.getByTestId('chart')).toHaveTextContent('Main|AAPL|1W|'));
    await user.click(within(notice).getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByTestId('layout-notice')).toBeNull();
  });
});
