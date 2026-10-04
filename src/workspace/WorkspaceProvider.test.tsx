import { act, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { http } from 'msw';
import type { ChartLayout, IndicatorConfig } from '@shared/types';
import { fail, ok } from '../../mocks/envelope';
import { mockWorkspace, resetMockWorkspace } from '../../mocks/workspace';
import { server } from '../../mocks/server';
import { apiRequest } from '../data';
import { SAVE_DEBOUNCE_MS, WorkspaceProvider, useActiveChart, useLayouts } from '.';
import type { ActiveChartApi, LayoutsApi } from '.';
import { MIGRATED_FLAG_KEY, storageKey } from '../panes/storage';

let api: ActiveChartApi;
let layoutsApi: LayoutsApi | null;

function Capture() {
  api = useActiveChart();
  layoutsApi = useLayouts();
  const { chart } = api;
  return (
    <div>
      <span data-testid="layout-id">{chart.layoutId ?? 'none'}</span>
      <span data-testid="symbol">{chart.symbol}</span>
      <span data-testid="timeframe">{chart.timeframe}</span>
      <span data-testid="indicators">{chart.indicators.map((i) => i.kind).join(',')}</span>
      <span data-testid="notice">{layoutsApi?.notice ?? ''}</span>
      <span data-testid="save-state">{layoutsApi?.saveState}</span>
    </div>
  );
}

const renderProvider = () =>
  render(
    <WorkspaceProvider>
      <Capture />
    </WorkspaceProvider>,
  );

interface Recorded {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}

/** Every write the client sends to /api/layouts*, in order. */
function recordWrites(): Recorded[] {
  const seen: Recorded[] = [];
  server.events.on('request:start', ({ request }) => {
    const path = new URL(request.url).pathname;
    if (request.method === 'GET' || !path.startsWith('/api/layouts')) return;
    void request
      .clone()
      .json()
      .then(
        (body: Record<string, unknown>) => seen.push({ method: request.method, path, body }),
        () => seen.push({ method: request.method, path, body: null }),
      );
  });
  return seen;
}
const puts = (seen: Recorded[]) => seen.filter((r) => r.method === 'PUT');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const layout0 = (): ChartLayout => {
  const l = mockWorkspace().layouts[0];
  if (!l) throw new Error('mock workspace has no layout');
  return l;
};

const rsi: IndicatorConfig = { id: 'r1', kind: 'rsi', params: { period: 14 }, color: '#2962ff', visible: true };

beforeEach(() => {
  resetMockWorkspace();
  localStorage.clear();
});
afterEach(() => {
  server.events.removeAllListeners();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('loading', () => {
  it('exposes the server active layout through useActiveChart', async () => {
    resetMockWorkspace({
      ...mockWorkspace(),
      layouts: [{ ...layout0(), symbol: 'MSFT', timeframe: '1W', chartType: 'line', indicators: [rsi] }],
    });
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('symbol')).toHaveTextContent('MSFT'));
    expect(screen.getByTestId('timeframe')).toHaveTextContent('1W');
    expect(screen.getByTestId('indicators')).toHaveTextContent('rsi');
    expect(screen.getByTestId('layout-id')).toHaveTextContent(layout0().id);
  });

  it('keeps a working, unsaved chart when layouts cannot be loaded, and recovers on reload', async () => {
    server.use(http.get('*/api/layouts', () => fail({ code: 'UPSTREAM_ERROR', message: 'down' })));
    renderProvider();
    await waitFor(() => expect(layoutsApi?.status).toBe('error'));
    act(() => api.setSymbol('NVDA'));
    expect(screen.getByTestId('symbol')).toHaveTextContent('NVDA');

    server.resetHandlers();
    act(() => layoutsApi?.reload());
    await waitFor(() => expect(layoutsApi?.status).toBe('ready'));
    expect(screen.getByTestId('symbol')).toHaveTextContent('AAPL'); // the server's layout replaces the scratch chart
  });
});

describe('saving', () => {
  it('sends one PUT per burst of edits, after the debounce, carrying the revision and only the changed fields', async () => {
    const seen = recordWrites();
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('layout-id')).not.toHaveTextContent('none'));

    act(() => api.setSymbol('MSFT'));
    act(() => api.setTimeframe('1W'));
    act(() => api.setSymbol('NVDA'));
    await sleep(SAVE_DEBOUNCE_MS / 2);
    expect(puts(seen)).toHaveLength(0); // still inside the debounce window
    expect(screen.getByTestId('save-state')).toHaveTextContent('saving');

    await waitFor(() => expect(layout0().symbol).toBe('NVDA'), { timeout: 3000 });
    expect(puts(seen)).toHaveLength(1);
    expect(puts(seen)[0]?.body).toEqual({ revision: 1, symbol: 'NVDA', timeframe: '1W' });
    expect(layout0().revision).toBe(2);
    await waitFor(() => expect(screen.getByTestId('save-state')).toHaveTextContent('saved'));
  });

  it('sends the next revision for the next edit, without refetching', async () => {
    const seen = recordWrites();
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('layout-id')).not.toHaveTextContent('none'));
    act(() => api.setSymbol('MSFT'));
    await waitFor(() => expect(layout0().revision).toBe(2), { timeout: 3000 });
    act(() => api.setChartType('line'));
    await waitFor(() => expect(layout0().revision).toBe(3), { timeout: 3000 });
    expect(puts(seen).map((p) => p.body)).toEqual([
      { revision: 1, symbol: 'MSFT' },
      { revision: 2, chartType: 'line' },
    ]);
  });

  it('keeps an edit made while a save is in flight and sends it after, at the new revision', async () => {
    const seen = recordWrites();
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('layout-id')).not.toHaveTextContent('none'));
    act(() => api.setSymbol('MSFT'));
    await waitFor(() => expect(puts(seen)).toHaveLength(1), { timeout: 3000 });
    act(() => api.setTimeframe('1h')); // the first PUT is on the wire or just done
    await waitFor(() => expect(layout0().timeframe).toBe('1h'), { timeout: 3000 });
    expect(puts(seen).map((p) => p.body?.['revision'])).toEqual([1, 2]);
    expect(layout0()).toMatchObject({ symbol: 'MSFT', timeframe: '1h', revision: 3 });
  });

  it('saves indicators in the layout', async () => {
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('layout-id')).not.toHaveTextContent('none'));
    act(() => api.setIndicators([rsi]));
    await waitFor(() => expect(layout0().indicators).toEqual([rsi]), { timeout: 3000 });
  });

  it('shows an error state for a transient failure and keeps the edit for a user retry', async () => {
    server.use(http.put('*/api/layouts/:id', () => fail({ code: 'UPSTREAM_ERROR', message: 'down' })));
    const seen = recordWrites();
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('layout-id')).not.toHaveTextContent('none'));
    act(() => api.setSymbol('MSFT'));
    await waitFor(() => expect(screen.getByTestId('save-state')).toHaveTextContent('error'), { timeout: 3000 });
    expect(screen.getByTestId('symbol')).toHaveTextContent('MSFT'); // the edit stays on screen
    await sleep(SAVE_DEBOUNCE_MS + 300);
    expect(puts(seen)).toHaveLength(1); // no automatic retry

    server.resetHandlers();
    act(() => layoutsApi?.retrySave());
    await waitFor(() => expect(layout0().symbol).toBe('MSFT'), { timeout: 3000 });
    await waitFor(() => expect(screen.getByTestId('save-state')).toHaveTextContent('saved'));
  });
});

describe('conflicts', () => {
  it('on CONFLICT adopts the server version, tells the user, and never retries the write', async () => {
    const seen = recordWrites();
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('layout-id')).not.toHaveTextContent('none'));
    // "Another tab" changes the layout: the server is now at revision 2.
    await apiRequest(`/layouts/${layout0().id}`, { method: 'PUT', body: { revision: 1, timeframe: '1W' } });
    seen.length = 0;

    act(() => api.setSymbol('MSFT')); // based on revision 1: stale
    await waitFor(() => expect(screen.getByTestId('notice')).toHaveTextContent(/changed elsewhere/), { timeout: 3000 });
    expect(screen.getByTestId('timeframe')).toHaveTextContent('1W'); // the other tab's change
    expect(screen.getByTestId('symbol')).toHaveTextContent('AAPL'); // our rejected edit is gone
    await sleep(SAVE_DEBOUNCE_MS + 400);
    expect(puts(seen)).toHaveLength(1); // exactly the one rejected write
    expect(layout0().symbol).toBe('AAPL');
    expect(screen.getByTestId('save-state')).toHaveTextContent('saved');

    // The next edit is based on the adopted revision and succeeds.
    act(() => api.setSymbol('MSFT'));
    await waitFor(() => expect(layout0().symbol).toBe('MSFT'), { timeout: 3000 });
    expect(puts(seen).at(-1)?.body?.['revision']).toBe(2);
  });

  it('adopts the server version when the layout was deleted elsewhere (NOT_FOUND)', async () => {
    const created = await apiRequest<ChartLayout>('/layouts', { method: 'POST', body: { name: 'Second' } });
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('layout-id')).not.toHaveTextContent('none'));
    await apiRequest(`/layouts/${layout0().id}`, { method: 'DELETE' }); // active layout vanishes
    act(() => api.setSymbol('MSFT'));
    await waitFor(() => expect(screen.getByTestId('layout-id')).toHaveTextContent(created.id), { timeout: 3000 });
    expect(screen.getByTestId('notice')).not.toBeEmptyDOMElement();
  });
});

describe('migration of per-symbol localStorage indicators', () => {
  const legacy = (symbol: string, list: IndicatorConfig[]) =>
    localStorage.setItem(storageKey(symbol), JSON.stringify({ version: 1, indicators: list }));

  it('imports the active symbol entry into a layout with no indicators, then retires every legacy key', async () => {
    legacy('AAPL', [rsi]);
    legacy('MSFT', [{ ...rsi, id: 'r2' }]);
    localStorage.setItem('charting-app:theme', 'dark');
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('indicators')).toHaveTextContent('rsi'));
    await waitFor(() => expect(layout0().indicators).toEqual([rsi]), { timeout: 3000 }); // saved to the server
    await waitFor(() => expect(localStorage.getItem(MIGRATED_FLAG_KEY)).toBe('1'));
    expect(localStorage.getItem(storageKey('AAPL'))).toBeNull();
    expect(localStorage.getItem(storageKey('MSFT'))).toBeNull();
    expect(localStorage.getItem('charting-app:theme')).toBe('dark');
  });

  it('does not overwrite a layout that already has indicators, but still retires the legacy keys', async () => {
    const mine: IndicatorConfig = { ...rsi, id: 'mine', kind: 'ema', params: { period: 9, source: 'close' } };
    resetMockWorkspace({ ...mockWorkspace(), layouts: [{ ...layout0(), indicators: [mine] }] });
    legacy('AAPL', [rsi]);
    renderProvider();
    await waitFor(() => expect(localStorage.getItem(MIGRATED_FLAG_KEY)).toBe('1'));
    expect(screen.getByTestId('indicators')).toHaveTextContent('ema');
    expect(localStorage.getItem(storageKey('AAPL'))).toBeNull();
    expect(layout0().indicators).toEqual([mine]);
  });

  it('retires the keys and writes nothing when there is nothing to import', async () => {
    const seen = recordWrites();
    legacy('MSFT', [rsi]); // not the active symbol
    renderProvider();
    await waitFor(() => expect(localStorage.getItem(MIGRATED_FLAG_KEY)).toBe('1'));
    expect(localStorage.getItem(storageKey('MSFT'))).toBeNull();
    expect(screen.getByTestId('indicators')).toBeEmptyDOMElement();
    expect(seen).toHaveLength(0);
  });

  it('runs once: with the flag set, legacy entries are left alone', async () => {
    localStorage.setItem(MIGRATED_FLAG_KEY, '1');
    legacy('AAPL', [rsi]);
    renderProvider();
    await waitFor(() => expect(layoutsApi?.status).toBe('ready'));
    await sleep(100);
    expect(screen.getByTestId('indicators')).toBeEmptyDOMElement();
    expect(localStorage.getItem(storageKey('AAPL'))).not.toBeNull();
  });

  it('keeps the legacy keys when the server cannot take the migrated indicators', async () => {
    server.use(http.put('*/api/layouts/:id', () => fail({ code: 'UPSTREAM_ERROR', message: 'down' })));
    legacy('AAPL', [rsi]);
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('save-state')).toHaveTextContent('error'), { timeout: 3000 });
    expect(localStorage.getItem(storageKey('AAPL'))).not.toBeNull();
    expect(localStorage.getItem(MIGRATED_FLAG_KEY)).toBeNull();
  });

  it('still loads and works when every storage access throws', async () => {
    const boom = () => {
      throw new Error('SecurityError');
    };
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(boom);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(boom);
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(boom);
    vi.spyOn(Storage.prototype, 'key').mockImplementation(boom);
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('layout-id')).not.toHaveTextContent('none'));
    act(() => api.setIndicators([rsi]));
    await waitFor(() => expect(layout0().indicators).toEqual([rsi]), { timeout: 3000 });
  });

  it('migrates once under StrictMode, which mounts the provider twice', async () => {
    legacy('AAPL', [rsi]);
    const seen = recordWrites();
    render(
      <StrictMode>
        <WorkspaceProvider>
          <Capture />
        </WorkspaceProvider>
      </StrictMode>,
    );
    await waitFor(() => expect(layout0().indicators).toEqual([rsi]), { timeout: 3000 });
    await waitFor(() => expect(localStorage.getItem(MIGRATED_FLAG_KEY)).toBe('1'));
    expect(puts(seen)).toHaveLength(1);
  });
});

describe('flush on page close', () => {
  /** Records the `keepalive` flag of every layout PUT, as the browser would receive it. */
  function spyKeepalive(): (boolean | undefined)[] {
    const flags: (boolean | undefined)[] = [];
    const real = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      if (init?.method === 'PUT') flags.push(init.keepalive);
      return real(input, init);
    });
    return flags;
  }

  it.each([
    ['pagehide', () => window.dispatchEvent(new Event('pagehide'))],
    [
      'visibilitychange to hidden',
      () => {
        vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
        document.dispatchEvent(new Event('visibilitychange'));
      },
    ],
  ])('sends the pending edit at once with keepalive on %s', async (_name, fire) => {
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('layout-id')).not.toHaveTextContent('none'));
    const flags = spyKeepalive();
    act(() => api.setSymbol('MSFT'));
    fire(); // well inside the debounce window
    await waitFor(() => expect(layout0().symbol).toBe('MSFT'), { timeout: 400 });
    expect(flags).toEqual([true]);
  });

  it('uses no keepalive for the ordinary debounced save', async () => {
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('layout-id')).not.toHaveTextContent('none'));
    const flags = spyKeepalive();
    act(() => api.setSymbol('MSFT'));
    await waitFor(() => expect(layout0().symbol).toBe('MSFT'), { timeout: 3000 });
    expect(flags.every((f) => !f)).toBe(true);
  });
});

describe('edits made while the workspace loads', () => {
  const slowLayouts = () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    server.use(
      http.get('*/api/layouts', async () => {
        await gate;
        return ok({ layouts: mockWorkspace().layouts, activeLayoutId: mockWorkspace().activeLayoutId });
      }),
    );
    return release;
  };

  it('applies them to the loaded layout and saves them, newest edit winning per field', async () => {
    const release = slowLayouts();
    const seen = recordWrites();
    renderProvider();
    act(() => api.setSymbol('MSFT'));
    act(() => api.setSymbol('NVDA'));
    act(() => api.setTimeframe('1W'));
    release();
    await waitFor(() => expect(layout0().symbol).toBe('NVDA'), { timeout: 3000 });
    expect(layout0().timeframe).toBe('1W');
    expect(screen.getByTestId('symbol')).toHaveTextContent('NVDA');
    expect(puts(seen).map((p) => p.body)).toEqual([{ revision: 1, symbol: 'NVDA', timeframe: '1W' }]);
  });

  it('drops them when the load fails: the chart keeps working unsaved', async () => {
    server.use(
      http.get('*/api/layouts', async () => {
        await new Promise((r) => setTimeout(r, 50));
        return fail({ code: 'UPSTREAM_ERROR', message: 'down' });
      }),
    );
    const seen = recordWrites();
    renderProvider();
    act(() => api.setSymbol('MSFT'));
    await waitFor(() => expect(layoutsApi?.status).toBe('error'));
    expect(screen.getByTestId('symbol')).toHaveTextContent('MSFT');
    server.resetHandlers();
    await sleep(SAVE_DEBOUNCE_MS + 200);
    expect(seen).toHaveLength(0);
    expect(layout0().symbol).toBe('AAPL');
  });
});
