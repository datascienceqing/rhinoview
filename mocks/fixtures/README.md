# Fixtures

**These are currently SYNTHETIC**, generated deterministically so the front end can be
built before a live API key is in place. They are contract-valid — correct field names,
time in Unix seconds, nulls where nulls belong, weekends excluded, strictly increasing
timestamps — but the prices are a seeded random walk, not real market data.

They will be **replaced with real recorded upstream responses** at the Phase 0 gate,
once a massive.com key is available. Phase 2 exists specifically to absorb the
differences real data brings (half-days, gaps, thin history, split adjustments).

## Contract-shaped — for the client (MSW)

These mock the **proxy**, so they are already in `shared/types.ts` shape:
`bars-AAPL-1D.json`, `bars-AAPL-5m.json`, `snapshot-AAPL.json`,
`search-aapl.json`, `search-empty.json`.

## Upstream-shaped — for the proxy's tests

`upstream/` holds raw massive.com shapes: single-letter keys (`o h l c v vw n t`) and
**`t` in MILLISECONDS**. The proxy's job is converting these to the contract.

- `aggs-AAPL-1D.json` — single page.
- `aggs-AAPL-1D-page1.json` + `aggs-AAPL-1D-page2.json` — a paginated pair. Page 1
  carries a `next_url`; **page 2 deliberately repeats page 1's last bar**, so
  de-duplication across page boundaries has something to catch.
