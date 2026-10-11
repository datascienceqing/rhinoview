# Plan — Chart context menu and alerts

Status: draft for the user's review (2026-10-11). Branch: `feat/alerts`, from `main` at `3d24afc`.

Decisions D1–D12 (section 9) use the recommendations. The user confirmed D1, D5, D6 and D9,
and asked for D3 and D7 (2026-10-11). D2, D4, D8, D10, D11 and D12 are still recommendations;
the user can change them before the implementation starts.

**Implementer:** read `AGENTS.md`, `docs/AGENT_BRIEF.md` and `docs/CONTRACT.md` first. All
output for the user (reports, commit messages, the PR) must be in ASD-STE100 style.

## 1. Goal

1. A right-click on a blank spot of the chart opens a context menu. The menu can change the
   theme, switch the language, open the Financials page, and add an alert.
2. Alerts on the price and on indicators. An alert that fires shows a small popup window and
   plays a sound.

## 2. Where the user preferences are kept now

The user asked this question. This is the state on `main` at `3d24afc`.

| What | Where | Scope |
|---|---|---|
| Theme (`rhinoview:theme`) | `localStorage` | This browser only |
| Language (`rhinoview:locale`) | `localStorage` | This browser only |
| Watchlist sidebar width (`rhinoview:sidebar-width`) | `localStorage` | This browser only |
| Indicator migration flag (`rhinoview:indicators-migrated`) | `localStorage` | This browser only |
| Layouts: symbol, timeframe, chart type, indicators with params and colours | Server, one JSON file (`WORKSPACE_FILE`, default `data/workspace.json`) | Every browser of this server |
| Watchlists and their symbol order | Server, the same JSON file | Every browser of this server |
| Active layout and active watchlist | Server, the same JSON file | Every browser of this server |
| Watchlist sort, open menus, the Financials page | Memory of the tab | Lost on reload |

The rule so far: a setting that is about this device (look, language, panel size) is in
`localStorage`. Content that the user makes (layouts, lists) is on the server.

Alerts are content, and the server must check them. So alerts go to the server (section 5).
The sound setting (on or off, volume) is about this device, so it goes to `localStorage`.

## 3. Scope

In scope:

- A context menu on the chart: theme, language, Financials, add alert.
- Price alerts: crossing, crossing up, crossing down, at a price level.
- Indicator alerts: an indicator line against a value, against the price, or against another
  line of the same indicator (section 4.3).
- Once or every time; an expiry time.
- The server checks the alerts, also when no browser is open.
- A popup window with a sound for each alert that fires. After 30 s it shrinks into a bell
  button at the top right.
- An Alerts window: it lists the alerts that fired and all alerts. It can search, delete, and
  mark all fired alerts as checked. It is docked on the right, and the user can float it and
  drag it.
- Up to 1000 alerts, with no limit on the number of symbols (D3).
- An alert line on the chart for each active price alert of the shown symbol.
- English and Chinese text for all of it.

Out of scope (a later phase can add them):

- Notifications when no RhinoView tab is open (e-mail, mobile push, browser push). The server
  records the event, and the app shows it when the user opens a tab (D6).
- Alerts on drawings (the app has no drawing tools).
- Alerts on Volume, VRVP and Liquidity. They have no line, or their line is volume (D4).
- Drag of an alert line to move the level. It can come later.

## 4. Specification

### 4.1 Context menu

- A right-click on the chart canvas opens the menu at the pointer. A right-click on a legend,
  a button or a scale does not open it; the browser menu shows there.
- The keyboard opens the same menu: the context-menu key or Shift+F10, when the chart has
  focus. Then the price is the price at the middle of the visible range.
- Items, in this order:
  1. **Add alert at {price}…** The price is the price at the pointer, in the pane under the
     pointer (section 4.2). In an indicator pane the item is **Add alert on {indicator} at
     {value}…** (section 4.3).
  2. **Theme: dark / light** (one item that switches).
  3. **Language: 中文 / EN** (one item that switches).
  4. **Financials** (only when the server serves fundamentals).
- Esc, a click outside the menu, or a scroll of the chart closes the menu.
- The menu stays inside the window: near an edge it opens to the other side.

### 4.2 Price alerts

| Field | Values | Default |
|---|---|---|
| Symbol | The chart symbol | The symbol on the chart |
| Condition | Crossing, Crossing up, Crossing down | Crossing |
| Level | A price, 2 decimals | The price at the right-click point |
| Trigger | Once, Every time | Once |
| Expiry | 1, 2 or 3 weeks; 1, 2 or 3 months; 1, 2 or 3 years | 1 month |
| Message | Free text, up to 200 characters | "{symbol} crossing {level}" |

Rules:

- **Crossing up:** the previous observed price was below the level, and the new observed price
  is at or above it. **Crossing down** is the mirror. **Crossing** is either one.
- A new alert has no previous price. Its first check only stores the side; it does not fire.
  So an alert at the current price does not fire at once.
- **Once:** the alert fires one time, then its status is "triggered". The user can enable it again.
- **Every time:** the alert fires on each new crossing until it expires. After it fires, it
  must cross back before it can fire again in the same direction (this is the crossing rule).
- **Expiry:** at the expiry time the status becomes "expired". An expired alert does not fire.
- The server checks a price alert each 30 s (D2). A short spike between two checks can be
  missed. To reduce this, the check also uses the day high and the day low of the quote: if
  the day high went up through the level since the last check, that counts as a crossing up.

### 4.3 Indicator alerts

An indicator alert is on one line of one indicator, on one symbol and one timeframe.

| Field | Values | Default |
|---|---|---|
| Indicator | A copy of the indicator config (kind and params) | The indicator of the pane |
| Line | A line key of the indicator, for example `value`, `macd`, `signal` | The first line |
| Timeframe | The chart timeframe | The chart timeframe |
| Condition | Crossing, Crossing up, Crossing down | Crossing |
| Target | A value; the close price; another line of the same indicator | The value at the right-click point |
| Trigger, Expiry, Message | As for price alerts | As for price alerts |

Rules:

- The alert keeps a **copy** of the indicator (kind and params). It does not refer to the
  layout's indicator: the user can edit or delete that indicator, and the alert must not change.
- The check runs at each **bar close** of the alert's timeframe, on closed bars only. A
  forming bar can cross and cross back, so a check on it gives false alerts.
- Examples: RSI(14) crossing up 70; close crossing down SMA(50); MACD line crossing up the
  signal line.

### 4.4 State to keep for an alert

The user expected a lot of state for indicator alerts. It is small, because the server can
compute the indicator again from the bars each time:

| State | Price alert | Indicator alert |
|---|---|---|
| The definition (section 4.2 or 4.3) | yes | yes, plus the indicator copy |
| `lastSide`: above, below or unknown | yes | yes |
| `lastCheckedAt` | yes | — |
| `lastBarTime`: the last closed bar that was checked | — | yes |
| `firedCount`, `lastFiredAt` | yes | yes |

The server does not store indicator history. To compute RSI(14) at a bar it loads about 300
closed bars and runs the same pure function as the client (`src/indicators`). The server
already imports `checkIndicatorParams` from there.

### 4.5 The popup window and the sound

- An alert that fires shows a small popup window at the **bottom left** of the app window: the
  symbol, the message, the price or value, and the time. It has two buttons: **Show on chart**
  and **Dismiss**.
- **Dismiss** marks that event as checked (section 4.6) and closes the popup.
- If the user does not dismiss it, the popup **shrinks into the bell button at the top right**
  after 30 s (D7). The event stays unchecked.
- More popups stack upward, up to 3. Above 3, one line says "{n} more alerts". That line also
  shrinks into the bell after 30 s.
- The sound is a short chime, made with the Web Audio API. No sound file is in the bundle.
- Browsers block sound until the user clicks the page once. Before that click, the popup shows
  without sound, and it shows a small "Sound is off until you click" note.
- When the tab is hidden, the app can also show a browser notification, if the user allowed
  it (D8).
- Sound on or off and the volume are a device setting in `localStorage`
  (`rhinoview:alert-sound`). A switch is in the Alerts window.

### 4.6 The bell button and the Alerts window

**Bell button.** It is at the right end of the toolbar (top right). It shows the number of
unchecked fired alerts. A click on it opens the Alerts window, at the default position, on the
**Triggered** tab.

**Default position: docked on the right.** The window fills the height of the area under the
toolbar, along the right edge, 360 px wide, over the watchlist sidebar (D10). The chart does
not change its size.

**Float and drag.** The user drags the title bar to float the window. It then moves freely
inside the app window, and it stays inside it. A **Dock** button in the title bar docks it
again.

**Minimize.** A **Minimize** button (and Esc, when the window has focus) shrinks the window into
the bell. The next click on the bell opens it again **at the default docked position**, not at
the old floating position. The floating position is not stored.

**Tabs.**

| Tab | Rows | Order |
|---|---|---|
| Triggered | The events that fired (the log, up to 1000 events) | Newest first; unchecked first |
| Alerts | All alerts (up to 1000) | Active first, then by symbol |

**Search.** One search box filters the open tab by symbol or by indicator, for example "AAPL",
"RSI" or "MACD". It ignores case. It also finds Chinese indicator names in the Chinese interface.

**Different looks.** Each row shows its type and status at a glance:

| What | Look |
|---|---|
| Price alert | A horizontal-line icon |
| Indicator alert | A wave icon, and the indicator title, for example "RSI (14)" |
| Direction | ↑ crossing up, ↓ crossing down, ↕ crossing |
| Unchecked fired event | Bold text, a dot in the accent colour, a light accent background |
| Checked fired event | Normal text |
| Active alert | Normal text |
| Paused alert | Dim text, a pause icon |
| Fired "once" alert (done) | A check mark |
| Expired alert | Dim text, struck through |

**Actions.**

- A click on a row shows its symbol on the chart. For an indicator alert, the chart also shows
  the alert's timeframe (D11). A click on an unchecked event also marks it as checked.
- Each row has a **Delete** button. On the Alerts tab it deletes the alert. On the Triggered tab
  it deletes the event from the log.
- On the Alerts tab, each row also has **Edit** and **Pause / Enable**.
- **Mark all as checked** (on the Triggered tab): all unchecked events become checked. The
  bell count becomes 0. It does not delete events and it does not change the alerts.
- The checked state is stored on the server, so all tabs and browsers agree.

### 4.7 Alert lines on the chart

- Each active price alert of the shown symbol draws a dashed horizontal line at its level,
  with a small bell label at the right. It uses a price line of the series
  (`createPriceLine`), so the price axis shows the level.
- A triggered or paused alert draws no line.

## 5. Design

### 5.1 Where the check runs

The **server** checks the alerts (D1). Reasons:

- The alert also works when the tab is in the background or closed. Browsers slow down timers
  in hidden tabs, so a check in the client is not reliable.
- Two open tabs must not fire one alert two times. One checker on the server prevents this.
- The server already has the quote cache and the bars cache. A check reuses them.

### 5.2 Server parts

| Part | File | Notes |
|---|---|---|
| Contract | `shared/types.ts`, `docs/CONTRACT.md` | `Alert`, `AlertCondition`, `AlertEvent`, bodies, limits |
| Store | `server/alerts/store.ts` | A second JSON file (`ALERTS_FILE`, default `data/alerts.json`). Same atomic write and serial queue as the workspace store. |
| Check (pure) | `server/alerts/evaluate.ts` | `evaluate(alert, observation) -> { fire, nextState }`. No clock, no I/O. Most tests go here. |
| Scheduler | `server/alerts/scheduler.ts` | A queue of symbols with active alerts, checked in turn inside a call budget (section 6). Price alerts use one quote for each symbol. Indicator alerts use closed bars, after each bar close. Injectable clock. |
| Events | `server/alerts/events.ts` | Keeps the last 1000 events, each with a `checked` flag. Sends new ones on a Server-Sent Events stream. |
| Routes | `server/routes/alerts.ts` | CRUD, the event list, the event stream |

Why a second file, not the workspace file: the scheduler writes the state of an alert each
30 s. In the workspace file, each such write would raise the revision, and the user's own edits
would get CONFLICT. In a separate file, the user's fields have a `revision`, and the checker's
state fields do not change it.

### 5.3 HTTP contract (new)

| Method and path | Body | Answer |
|---|---|---|
| `GET /api/alerts` | — | `{ alerts: Alert[] }` |
| `POST /api/alerts` | `CreateAlertBody` | `Alert` (201) |
| `PUT /api/alerts/:id` | `UpdateAlertBody` (with `revision`) | `Alert`; a stale revision gives `CONFLICT` |
| `DELETE /api/alerts/:id` | — | 204 |
| `GET /api/alerts/events?since=` | — | `{ events: AlertEvent[], unchecked: number }`, newest first |
| `PUT /api/alerts/events/checked` | `{ ids: string[] }` or `{ all: true }` | `{ unchecked: number }` |
| `DELETE /api/alerts/events/:id` | — | 204 |
| `GET /api/alerts/stream` | — | `text/event-stream`: an `alert` event for each event that fires, and a `checked` event when the checked state changes (so other tabs update their bell) |

Limits: at most 1000 alerts, with no limit on the number of symbols (D3). The log keeps the last
1000 events. The messages are at most 200 characters. The search runs in the client: 1000 rows
are small.

### 5.4 Client parts

| Part | File | Notes |
|---|---|---|
| Price at the pointer | `src/chart/PriceChart.ts` | `pointAt(x, y)`: the pane, and the price or the indicator value, with `coordinateToPrice` |
| Context menu | `src/chart/ChartContextMenu.tsx` | Opens on `contextmenu` over the canvas only |
| Alert dialog | `src/alerts/AlertDialog.tsx` | The fields of section 4.2 or 4.3 |
| Bell button | `src/alerts/AlertBell.tsx` | Section 4.6; the unchecked count |
| Alerts window | `src/alerts/AlertsWindow.tsx` | Docked, floating, minimized; tabs, search, actions (section 4.6) |
| Window drag | `src/alerts/useFloatingWindow.ts` | Pointer drag of the title bar; keeps the window inside the app window |
| Event stream | `src/alerts/useAlertStream.ts` | `EventSource` on `/api/alerts/stream`; it connects again after a loss, and then loads the missed events with `?since=` |
| Popup and sound | `src/alerts/AlertToasts.tsx`, `src/alerts/chime.ts` | Bottom left; shrinks into the bell after 30 s (section 4.5) |
| Alert lines | `src/chart/PriceChart.ts` | Section 4.7 |
| Mocks | `mocks/alerts.ts` | Uses the server zod schemas, like the workspace mock |

## 6. Rate budget (FMP Starter: 300 calls a minute)

With 1000 alerts and no symbol limit, the server cannot check every symbol each 30 s: 1000
symbols would need about 2000 calls a minute, and FMP Starter has no batch quote. So the
scheduler rotates (D2):

- Alerts get a fixed budget: **150 calls a minute** (`ALERT_CALL_BUDGET`). The watchlist keeps
  the rest (it needs at most 100 calls a minute).
- The symbols with active alerts form a queue. The scheduler checks them in turn, as fast as
  the budget allows, but no symbol more often than each 30 s.
- So the time between two checks of one symbol is `max(30 s, symbols / 150 per minute)`:
  - 20 symbols: each 30 s.
  - 150 symbols: each minute.
  - 1000 symbols: about each 7 minutes.
- A crossing between two checks is still found: the check compares the level with the last
  price **and** with the day high and day low of the quote. Only the alert comes later.
- Symbols with an alert near the current price can go to the front of the queue (a later
  improvement; not in this phase).
- Indicator alerts use the same budget. One bars call serves all alerts of one symbol and one
  timeframe. After a bar close they wait in the queue, so a 5m alert can come some minutes late
  when many symbols have alerts.
- The quote cache is shared with the watchlist, so a symbol in both costs one call.
- The synthetic provider has no budget: all symbols are checked each 30 s.
- The Alerts window shows the current check interval, for example "Checked every 7 min".

## 7. Waves and gates

1. **Wave 0 (one agent):** contract, types, limits, the evaluate seam with its rules as
   comments, the mock. Gate: typecheck, lint, all tests.
2. **Wave 1 (parallel, separate paths):**
   - S1: the alert store and the routes.
   - S2: `evaluate.ts` and the scheduler, with a fake clock and a fake engine.
   - S3: the event list and the SSE stream.
   - C1: the price at the pointer, the context menu, the alert lines.
   - C2: the alert dialog and the Alerts panel.
   - C3: the event stream client, the popups and the sound.
3. **Gate A:** a review of all diffs together (contract drift, double fire, time zones, i18n).
4. **Wave 2 (integration):** an end-to-end test with the synthetic engine and a fake clock: make
   an alert, move the clock over a crossing, see one event on the stream. A browser check: right-
   click, add an alert, see the popup. FMP checks only when a key is available.
5. **Gate B:** final review, then the PR.

Tests that must exist:

- Crossing, up, down; the first check does not fire; once and every time; expiry.
- No double fire with two tabs open (one server checker).
- Indicator alerts check closed bars only; a forming bar does not fire.
- The scheduler respects the symbol limit and the shared quote cache.
- The SSE client connects again and loads the missed events.
- The context menu opens only on the canvas, and with the keyboard.
- A popup shrinks into the bell after 30 s (fake timers); Dismiss marks its event as checked.
- The bell opens the window docked; drag floats it; minimize and open again docks it.
- The floating window cannot leave the app window.
- Search filters by symbol and by indicator, in both languages.
- Mark all as checked sets the count to 0 in every open tab (the `checked` stream event).
- The scheduler keeps inside its call budget with 1000 symbols, and checks no symbol more
  often than each 30 s.
- All new text exists in English and in Chinese (the catalog test already checks this).

## 8. Risks

- **Missed spikes:** a check between two quotes can miss a short spike. The day high and low
  reduce this, but only for a spike that makes a new high or low of the day (section 4.2).
- **Late alerts with many symbols:** with 1000 symbols on FMP Starter, one symbol is checked
  about each 7 minutes, so an alert can come up to 7 minutes late (section 6).
- **Delayed data:** with delayed quotes, the alert is also delayed. The popup says "delayed"
  when the quote was delayed.
- **No tab open:** without a tab, there is no popup and no sound. The event waits in the log.
- **Sound policy:** the browser plays no sound before the first click in the page.
- **Synthetic data:** the synthetic price moves only in market hours. Tests use a fake clock.
- **Server restart:** the state is in `data/alerts.json`, so a restart keeps it. After a long
  stop, the first check only stores the side again; it does not fire for crossings that
  happened while the server was off.

## 9. Decisions for the user

| # | Question | Recommendation |
|---|---|---|
| D1 | Where does the check run? | On the server (section 5.1). **Confirmed by the user.** |
| D2 | How often does the server check price alerts? | Each 30 s at most; with many symbols, in turn inside a budget of 150 calls a minute (section 6). |
| D3 | Limits? | 1000 alerts, no limit on symbols. **Asked by the user.** |
| D4 | Which indicators can have alerts? | SMA, EMA, RSI and MACD. Not Volume, VRVP or Liquidity in this phase. |
| D5 | "Every time": how often can one alert fire? | On each new crossing; it must cross back first. **Confirmed by the user.** |
| D6 | Alerts when no tab is open? | The server records them; the app shows them on the next visit. No push or e-mail in this phase. **Confirmed by the user.** |
| D7 | What happens to a popup? | Bottom left; after 30 s it shrinks into the bell at the top right, unchecked. **Asked by the user.** |
| D8 | A browser notification when the tab is hidden? | Yes, if the user allows it. The app asks only after the user makes the first alert. |
| D9 | Expiry choices: 1, 2 or 3 weeks, months or years (9 choices)? | Yes, default 1 month. **Confirmed by the user.** |
| D10 | Where is the docked Alerts window? | Along the right edge, 360 px wide, over the watchlist sidebar. The chart keeps its size. |
| D11 | A click on an indicator alert: symbol only, or also its timeframe? | Symbol and timeframe, so the user sees the indicator that fired. |
| D12 | How many events does the log keep? | The last 1000. |
