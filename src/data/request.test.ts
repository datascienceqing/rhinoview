import { apiRequest } from './request';
import type { FetchLike } from './request';

function recordingFetch(): { fetch: FetchLike; inits: (RequestInit | undefined)[] } {
  const inits: (RequestInit | undefined)[] = [];
  const fetch: FetchLike = (_input, init) => {
    inits.push(init);
    return Promise.resolve(new Response(JSON.stringify({ ok: true, data: 1 }), { status: 200 }));
  };
  return { fetch, inits };
}

describe('apiRequest keepalive', () => {
  it('passes keepalive to fetch when asked, so a save on pagehide can outlive the page', async () => {
    const { fetch, inits } = recordingFetch();
    await apiRequest('/x', { method: 'PUT', body: { a: 1 }, keepalive: true, fetch });
    expect(inits[0]?.keepalive).toBe(true);
  });

  it('leaves keepalive unset by default', async () => {
    const { fetch, inits } = recordingFetch();
    await apiRequest('/x', { fetch });
    expect(inits[0]?.keepalive).toBeUndefined();
  });
});
