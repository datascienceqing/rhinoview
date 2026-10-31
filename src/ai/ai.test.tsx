import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import type { AiAnalyzeEvent } from '@shared/types';
import { server } from '../../mocks/server';
import { apiStream } from '../data';
import { I18nProvider } from '../i18n';
import { AiPanel } from './AiPanel';
import { AiProvider, useAi, useAiMarks } from './AiProvider';
import { Markdown, parseBlocks } from './Markdown';

const MARKS = { lines: [{ price: 101.5, label: 'short retest T1', role: 'target' as const }], zones: [] };

/** A text/event-stream body with one `data:` line per event, cut into small pieces. */
function sse(events: AiAnalyzeEvent[]): ReadableStream<Uint8Array> {
  const text = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (let i = 0; i < text.length; i += 17) c.enqueue(enc.encode(text.slice(i, i + 17)));
      c.close();
    },
  });
}

function streamHandler(events: AiAnalyzeEvent[], seen?: { body?: unknown }) {
  return http.post('*/api/ai/analyze', async ({ request }) => {
    if (seen) seen.body = await request.json();
    return new HttpResponse(sse(events), { headers: { 'Content-Type': 'text/event-stream' } });
  });
}

const facts = (over: Record<string, unknown> = {}): AiAnalyzeEvent => ({
  type: 'facts', symbol: 'AAPL', marks: MARKS, facts: { synthetic: false, dataCheck: { stale: false, missing: [] }, ...over },
});

describe('apiStream', () => {
  it('reads every event, also when an event is split across chunks', async () => {
    server.use(streamHandler([facts(), { type: 'delta', text: 'Hi' }, { type: 'done', text: 'Hi', check: { checked: 0, unknown: [] } }]));
    const got: string[] = [];
    await apiStream<AiAnalyzeEvent>('/ai/analyze', (e) => got.push(e.type), { body: {} });
    expect(got).toEqual(['facts', 'delta', 'done']);
  });

  it('throws the envelope error of a failure before the stream', async () => {
    server.use(http.post('*/api/ai/analyze', () => HttpResponse.json({ ok: false, error: { code: 'RATE_LIMITED', message: 'The daily limit of AI requests is reached.' } }, { status: 429 })));
    await expect(apiStream('/ai/analyze', () => undefined, { body: {} })).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });
});

describe('Markdown', () => {
  it('parses headings, tables, lists, code, and paragraphs', () => {
    const blocks = parseBlocks('## Verdict\n\nLine one\nline two\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n- x\n- y\n\n```\ncode\n```');
    expect(blocks.map((b) => b.kind)).toEqual(['heading', 'para', 'table', 'list', 'code']);
  });

  it('renders bold and code, and never raw HTML', () => {
    const { container } = render(<Markdown text={'**Stop** at `284.2` <img src=x onerror=alert(1)>'} />);
    expect(container.querySelector('strong')?.textContent).toBe('Stop');
    expect(container.querySelector('code')?.textContent).toBe('284.2');
    expect(container.querySelector('img')).toBeNull();
  });

  it('marks a flagged number only as a whole number', () => {
    const { container } = render(<Markdown text="R:R 4.3:1, not 14.35 or 4.31" flagged={['4.3']} />);
    expect([...container.querySelectorAll('mark')].map((m) => m.textContent)).toEqual(['4.3']);
  });
});

function Probe({ symbol }: { symbol: string }) {
  const marks = useAiMarks(symbol);
  const { setOpen } = useAi();
  return (
    <>
      <span data-testid="marks">{marks ? marks.lines.length : 'none'}</span>
      <button type="button" onClick={() => setOpen(true)}>
        open
      </button>
    </>
  );
}

function renderPanel(symbol = 'AAPL') {
  render(
    <I18nProvider>
      <AiProvider>
        <Probe symbol={symbol} />
        <AiPanel symbol={symbol} />
      </AiProvider>
    </I18nProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'open' }));
}

describe('AiPanel', () => {
  it('asks, streams the answer, flags unknown numbers, and shows the marks', async () => {
    const seen: { body?: unknown } = {};
    server.use(
      streamHandler(
        [
          facts({ synthetic: true }),
          { type: 'delta', text: '**No.** T1 R:R ' },
          { type: 'delta', text: '4.3:1.' },
          { type: 'done', text: '**No.** T1 R:R 4.3:1.', check: { checked: 1, unknown: ['4.3'] } },
        ],
        seen,
      ),
    );
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Can I short AAPL here?' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));

    expect(await screen.findByText(/1 of 1 number is not in the calculated data/)).toBeInTheDocument();
    expect(seen.body).toEqual({ symbol: 'AAPL', question: 'Can I short AAPL here?' });
    expect(screen.getByText('4.3', { selector: 'mark' })).toBeInTheDocument();
    expect(screen.getByText('Generated prices, not market prices')).toBeInTheDocument();
    expect(screen.getByTestId('marks')).toHaveTextContent('1');

    // The checkbox hides the marks; Clear removes the analysis.
    fireEvent.click(screen.getByRole('checkbox'));
    expect(screen.getByTestId('marks')).toHaveTextContent('none');
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(screen.queryByText('4.3', { selector: 'mark' })).toBeNull();
  });

  it('shows a stream error', async () => {
    server.use(streamHandler([facts(), { type: 'error', error: { code: 'UNAUTHORIZED', message: 'The AI service refused the API key.' } }]));
    renderPanel();
    fireEvent.change(screen.getByRole('textbox', { name: 'Question' }), { target: { value: 'Buy?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The AI service refused the API key.');
  });

  it('draws no marks for another symbol', async () => {
    server.use(streamHandler([facts(), { type: 'done', text: 'ok', check: { checked: 0, unknown: [] } }]));
    renderPanel('MSFT');
    fireEvent.change(screen.getByRole('textbox', { name: 'Question' }), { target: { value: 'Buy?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
    await waitFor(() => expect(screen.getByText(/This answer is about AAPL/)).toBeInTheDocument());
    expect(screen.getByTestId('marks')).toHaveTextContent('none');
  });
});

describe('AI alerts in the panel', () => {
  function AlertsProbe() {
    const { runAlerts } = useAi();
    return (
      <button type="button" onClick={() => runAlerts('ter')}>
        run
      </button>
    );
  }

  it('shows the added alerts and the rejected levels, and removes an alert', async () => {
    const deleted: string[] = [];
    const alert = {
      id: 'al1', symbol: 'TER', condition: { type: 'price', direction: 'up', level: 324.15 }, frequency: 'once', expiry: '1M', expiresAt: 0,
      message: 'AI ▼ short retest: entry 324.15.', status: 'active', revision: 1, createdAt: 0, updatedAt: 0,
      state: { lastSide: null, lastCheckedAt: null, lastDayHigh: null, lastDayLow: null, lastBarTime: null, firedCount: 0, lastFiredAt: null },
      origin: { kind: 'ai', analysisId: 'an1', plan: 'short retest', role: 'entry' },
    };
    let body: unknown;
    server.use(
      http.post('*/api/ai/alerts', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({
          ok: true,
          data: { analysisId: 'an1', symbol: 'TER', synthetic: false, added: [alert], rejected: [{ plan: 'short retest', role: 'target', level: 273.07, reason: 'The price reaches this target before the entry.' }] },
        });
      }),
      http.delete('*/api/alerts/:id', ({ params }) => {
        deleted.push(String(params.id));
        return HttpResponse.json({ ok: true, data: { id: params.id } });
      }),
    );
    render(
      <I18nProvider>
        <AiProvider>
          <AlertsProbe />
          <AiPanel symbol="TER" />
        </AiProvider>
      </I18nProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'run' }));
    expect(await screen.findByText('Added 1 alert')).toBeInTheDocument();
    expect(body).toEqual({ symbol: 'TER' });
    expect(screen.getByText('↑ 324.15')).toBeInTheDocument();
    expect(screen.getByText('1 level rejected')).toBeInTheDocument();
    expect(screen.getByText(/short retest T1 273.07: The price reaches this target/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(deleted).toEqual(['al1']));
    expect(await screen.findByText('You removed the AI alert.')).toBeInTheDocument();
  });
});

