#!/usr/bin/env node
/* global console, fetch, process, setTimeout */
/* eslint-disable no-restricted-globals -- a Node script, not client code; the client rule does not apply */
/**
 * Phase 5 end-to-end check against a REAL server over HTTP.
 *
 * Usage:
 *   node scripts/e2e-phase5.mjs              # starts its own server (synthetic, temp workspace)
 *   BASE_URL=http://127.0.0.1:8787 node scripts/e2e-phase5.mjs   # uses a running server
 *
 * When it starts its own server it uses DATA_PROVIDER=synthetic and a temporary
 * WORKSPACE_FILE, so it never touches data/workspace.json. Exit code 0 = all checks pass.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = Number(process.env.E2E_PORT ?? 18787);
let base = process.env.BASE_URL;
let child;
let tmp;

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`PASS  ${name}`);
  } else {
    failed++;
    console.log(`FAIL  ${name}${detail === undefined ? '' : `  -> ${JSON.stringify(detail).slice(0, 400)}`}`);
  }
}

async function call(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON body */
  }
  return { status: res.status, json };
}

async function startServer() {
  tmp = mkdtempSync(join(tmpdir(), 'rhinoview-e2e-'));
  base = `http://127.0.0.1:${PORT}`;
  child = spawn('npx', ['tsx', 'server/index.ts'], {
    env: {
      ...process.env,
      DATA_PROVIDER: 'synthetic',
      SERVER_PORT: String(PORT),
      WORKSPACE_FILE: join(tmp, 'workspace.json'),
      FMP_API_KEY: '',
    },
    stdio: ['ignore', 'ignore', 'inherit'],
    // Own process group, so stop() also ends the tsx grandchild that npx starts.
    detached: true,
  });
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('server did not start within 20 s');
}

function stop() {
  if (child) {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
  }
  if (tmp) rmSync(tmp, { recursive: true, force: true });
}

async function main() {
  if (!base) await startServer();

  // Capabilities
  const caps = await call('GET', '/api/capabilities');
  check('capabilities ok', caps.status === 200 && caps.json?.ok === true, caps.json);
  check('capabilities.fundamentals is boolean', typeof caps.json?.data?.fundamentals === 'boolean', caps.json);

  // Default workspace
  const ws = await call('GET', '/api/workspace');
  const w = ws.json?.data;
  check('GET /api/workspace ok', ws.status === 200 && ws.json?.ok === true, ws.json);
  const main = w?.layouts?.find((l) => l.id === w.activeLayoutId);
  check('default layout "Main" AAPL 1D candlestick', main?.name === 'Main' && main?.symbol === 'AAPL' && main?.timeframe === '1D' && main?.chartType === 'candlestick', main);
  const defWl = w?.watchlists?.[0];
  check('default watchlist AAPL,MSFT,NVDA,AMZN,GOOGL', JSON.stringify(defWl?.symbols) === JSON.stringify(['AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL']), defWl);
  check('activeWatchlistId is the default watchlist', w?.activeWatchlistId === defWl?.id, w?.activeWatchlistId);

  // Layout: create, update, conflict, delete
  const created = await call('POST', '/api/layouts', { name: 'E2E', symbol: 'MSFT', timeframe: '1h' });
  check('POST /api/layouts -> 201', created.status === 201 && created.json?.data?.revision === 1, created);
  const lid = created.json?.data?.id;
  const dupName = await call('POST', '/api/layouts', { name: 'e2e' });
  check('duplicate name (case-insensitive) -> 400 BAD_REQUEST', dupName.status === 400 && dupName.json?.error?.code === 'BAD_REQUEST', dupName);
  const unknownField = await call('POST', '/api/layouts', { name: 'X1', bogus: true });
  check('unknown field -> 400 BAD_REQUEST', unknownField.status === 400, unknownField);
  const badInd = await call('PUT', `/api/layouts/${lid}`, { revision: 1, indicators: [{ id: 'i1', kind: 'sma', params: { period: 0 }, color: '#2962ff', visible: true }] });
  check('invalid indicator params -> 400', badInd.status === 400, badInd);
  const upd = await call('PUT', `/api/layouts/${lid}`, { revision: 1, symbol: 'NVDA' });
  check('PUT /api/layouts/:id -> revision 2', upd.status === 200 && upd.json?.data?.revision === 2 && upd.json?.data?.symbol === 'NVDA', upd);
  const stale = await call('PUT', `/api/layouts/${lid}`, { revision: 1, symbol: 'AMZN' });
  check('stale revision -> 409 CONFLICT', stale.status === 409 && stale.json?.error?.code === 'CONFLICT', stale);
  const nf = await call('PUT', '/api/layouts/does-not-exist', { revision: 1, symbol: 'AMZN' });
  check('unknown id -> 404 NOT_FOUND', nf.status === 404 && nf.json?.error?.code === 'NOT_FOUND', nf);
  const act = await call('PUT', '/api/workspace/active', { activeLayoutId: lid });
  check('PUT /api/workspace/active', act.status === 200 && act.json?.data?.activeLayoutId === lid, act);
  const del = await call('DELETE', `/api/layouts/${lid}`);
  check('DELETE active layout moves activeLayoutId to an existing layout', del.status === 200 && del.json?.data?.layouts?.some((l) => l.id === del.json?.data?.activeLayoutId) && del.json?.data?.activeLayoutId !== lid, del.json);
  const lastDel = await call('DELETE', `/api/layouts/${main?.id}`);
  check('deleting the last layout -> 400', lastDel.status === 400, lastDel);

  // Watchlist: create, add symbols, quotes
  const wl = await call('POST', '/api/watchlists', { name: 'E2E list' });
  check('POST /api/watchlists -> 201', wl.status === 201, wl);
  const wid = wl.json?.data?.id;
  const wupd = await call('PUT', `/api/watchlists/${wid}`, { revision: wl.json?.data?.revision, symbols: ['AAPL', 'MSFT', 'JPM'] });
  check('PUT watchlist symbols', wupd.status === 200 && wupd.json?.data?.symbols?.length === 3, wupd);
  const syms = (wupd.json?.data?.symbols ?? []).join(',');
  const q = await call('GET', `/api/quotes?symbols=${syms},ZZZZQX`);
  check('GET /api/quotes ok', q.status === 200 && q.json?.ok === true, q.json);
  check('quotes in request order', JSON.stringify(q.json?.data?.quotes?.map((s) => s.symbol)) === JSON.stringify(['AAPL', 'MSFT', 'JPM']), q.json?.data?.quotes?.map((s) => s.symbol));
  check('unknown symbol in missing', JSON.stringify(q.json?.data?.missing) === JSON.stringify(['ZZZZQX']), q.json?.data);
  const tooMany = await call('GET', `/api/quotes?symbols=${Array.from({ length: 51 }, (_, i) => `S${i}`).join(',')}`);
  check('51 symbols -> 400', tooMany.status === 400, tooMany.status);
  const empty = await call('GET', '/api/quotes?symbols=');
  check('empty symbols -> 400', empty.status === 400, empty.status);
  // Gate 5 F1: an index symbol must not fail the whole request.
  const idx = await call('GET', `/api/quotes?symbols=AAPL,${encodeURIComponent('^GSPC')}`);
  check('quotes AAPL,^GSPC -> 200 with AAPL quote', idx.status === 200 && idx.json?.data?.quotes?.[0]?.symbol === 'AAPL', idx.json);
  const badChar = await call('GET', '/api/quotes?symbols=AAPL,A%2FB');
  check('quotes with a "/" symbol -> 400', badChar.status === 400, badChar.status);
  // Gate 5 F6: the active update is all or nothing.
  const before = (await call('GET', '/api/workspace')).json?.data;
  const otherLayout = await call('POST', '/api/layouts', { name: 'E2E active' });
  const half = await call('PUT', '/api/workspace/active', { activeLayoutId: otherLayout.json?.data?.id, activeWatchlistId: 'does-not-exist' });
  const after = (await call('GET', '/api/workspace')).json?.data;
  check('active update with one bad id -> 404 and no change', half.status === 404 && after?.activeLayoutId === before?.activeLayoutId, { half: half.status, before: before?.activeLayoutId, after: after?.activeLayoutId });
  const wdel = await call('DELETE', `/api/watchlists/${wid}`);
  check('DELETE watchlist -> 200 and gone', wdel.status === 200 && !wdel.json?.data?.watchlists?.some((x) => x.id === wid), wdel.status);

  // Fundamentals
  const ov = await call('GET', '/api/fundamentals/overview?symbol=AAPL');
  check('overview AAPL ok', ov.status === 200 && ov.json?.data?.profile?.symbol === 'AAPL', ov.json?.error ?? ov.status);
  const st = await call('GET', '/api/fundamentals/statements?symbol=AAPL&statement=income&period=quarter');
  check('statements AAPL income quarter ok, newest first', st.status === 200 && st.json?.data?.rows?.length > 0 && st.json.data.rows[0].periodEnd >= st.json.data.rows.at(-1).periodEnd, st.json?.error ?? st.status);
  const er = await call('GET', '/api/fundamentals/earnings?symbol=AAPL');
  check('earnings AAPL ok', er.status === 200 && Array.isArray(er.json?.data?.events), er.json?.error ?? er.status);
  const badSt = await call('GET', '/api/fundamentals/statements?symbol=AAPL&statement=nope&period=annual');
  check('bad statement kind -> 400', badSt.status === 400, badSt.status);
  // Gate 5 F2: a well-formed index symbol is unknown, not a bad request.
  const fidx = await call('GET', `/api/fundamentals/earnings?symbol=${encodeURIComponent('^GSPC')}`);
  check('fundamentals ^GSPC -> 404 UNKNOWN_SYMBOL', fidx.status === 404 && fidx.json?.error?.code === 'UNKNOWN_SYMBOL', fidx.json);
  const ann = await call('GET', '/api/fundamentals/statements?symbol=MSFT&statement=balance&period=annual');
  check('statements MSFT balance annual: at most 10 rows, FY rows', ann.status === 200 && ann.json?.data?.rows?.length > 0 && ann.json.data.rows.length <= 10 && ann.json.data.rows.every((r) => r.fiscalPeriod === 'FY'), ann.json?.error ?? ann.status);
  const unk = await call('GET', '/api/fundamentals/overview?symbol=ZZZZQX');
  check('unknown symbol -> 404 UNKNOWN_SYMBOL', unk.status === 404 && unk.json?.error?.code === 'UNKNOWN_SYMBOL', unk.json);

  console.log(`\n${passed} passed, ${failed} failed`);
  return failed === 0 ? 0 : 1;
}

main()
  .then((code) => {
    stop();
    process.exit(code);
  })
  .catch((err) => {
    console.error(err);
    stop();
    process.exit(1);
  });
