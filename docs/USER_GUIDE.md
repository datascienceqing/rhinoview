# RhinoView user guide

<p><b>English</b> · <a href="USER_GUIDE.zh-CN.md">简体中文</a></p>

This guide tells you how to use RhinoView. To install and start the application, read
[Setup](../README.md#setup) in the README.

## Contents

1. [The basics](#1-the-basics)
2. [The right-click menu](#2-the-right-click-menu)
3. [Indicators](#3-indicators)
4. [Alerts](#4-alerts)
5. [Alert limits and the call budget](#5-alert-limits-and-the-call-budget)
6. [Alert notifications](#6-alert-notifications)

## 1. The basics

Most controls show their purpose on the screen. This list tells only the controls that
are not clear:

- **Chart types.** **Candles**, **Line**, and **Bars**. **Bars** are OHLC bars, as in
  TradingView: the left tick is the open, and the right tick is the close.
- **Pan and zoom.** Drag the chart to move it. Drag the price axis, or turn the wheel on
  it, to zoom the prices. Click **Auto** to fit the prices again.
- **Layouts.** The button at the top left. A layout keeps the symbol, the timeframe, the
  chart type, and the indicators. RhinoView saves each change automatically.
- **Watchlist.** Click a row to show the symbol. Drag a row, or press Alt+Up or Alt+Down, to
  reorder it.
- **SYNTHETIC badge.** If it shows, the prices are generated. They are not market prices.

## 2. The right-click menu

Right-click a pane of the chart. You can also press Shift+F10 or the menu key when the
chart has the focus. The items in the menu change with the pane and the pointer position:

| Where you right-click | Alert items in the menu |
|---|---|
| Price pane | **Add alert at {price}…**: a price alert at the price under the pointer. |
| Price pane, with a visible SMA or EMA | **Add alert on {indicator}…**: one item for each visible SMA and EMA. The alert fires when the close crosses the line. |
| RSI pane or MACD pane | **Add alert on {indicator} at {value}…**: the indicator value under the pointer. |

Each menu also has these items:

- **Theme**: change between the dark theme and the light theme.
- **Language**: change between English and Chinese.

The menu shows no alert item on the price axis, on the time axis, or on the legend. A
right-click there opens the browser menu.

## 3. Indicators

### 3.1 Add and change indicators

1. Click **Indicators** at the top right of the chart.
2. Click an indicator to add it.
3. Change its parameters, its colour, and its visibility in the same panel.

An invalid parameter shows an error, and RhinoView does not apply it. To change the order,
drag ⠿, press Alt+Up or Alt+Down, or click ▲ or ▼. The panes below the chart use this order.

### 3.2 The indicators

| Indicator | Pane | What it shows | Alerts |
|---|---|---|---|
| SMA | Price | Simple moving average | Yes: the close crosses the line |
| EMA | Price | Exponential moving average | Yes: the close crosses the line |
| RSI | Own pane | Relative strength index, 0 to 100 | Yes: RSI crosses a value |
| MACD | Own pane | MACD line, signal line, and histogram | Yes: a line crosses a value or another line |
| Volume | Price | Volume, with a moving average of the volume | No |
| VRVP | Price | Volume profile of the visible bars, with the value area | No |
| Liquidity | Price | Liquidity zones at pivot highs and lows, and their sweeps | No |
| Confluence | Price | Clusters of levels, and a close through a cluster with high volume | No |

The legend at the top left shows the value of each indicator at the bar under the pointer.

### 3.3 Indicator alerts use closed bars

An indicator alert checks only a closed bar. It does not check the bar that is open now.

- An intraday alert (1m to 1h) checks each bar after the bar closes.
- A daily or weekly alert checks the bar after its full period ends, at 00:00 UTC. Thus a
  daily alert comes some hours after the US market close.

The alert keeps the timeframe and the parameters of the indicator at the time that you
make the alert. A later change to the indicator on the chart does not change the alert.

## 4. Alerts

The server checks the alerts. The alerts continue when you close the browser.

### 4.1 Create an alert

1. Right-click the chart (refer to [The right-click menu](#2-the-right-click-menu)).
2. Click an **Add alert** item. The **Create alert** dialog opens.
3. Set the fields:
   - **Condition**: **Crossing**, **Crossing up**, or **Crossing down**.
   - **Price**, **Value**, or **Target**: the level that the alert watches.
   - **Trigger**: **Once**, or **Every time**.
   - **Expires in**: 1 week to 3 years. The default is 1 month.
   - **Message**: up to 200 characters. If you leave it empty, RhinoView writes a message.
4. Click **Create**.

A dashed line with 🔔 shows each price alert on the chart.

### 4.2 Manage the alerts

Click the bell at the top right. The Alerts window has two tabs:

- **Triggered**: the alerts that fired, newest first. **Mark all as checked** clears the
  count on the bell.
- **Alerts**: all your alerts. For each alert, you can **Edit**, **Pause**, **Enable**, or
  **Delete** it.

The search box finds alerts by symbol or by indicator. You can dock the window next to the
chart, or minimize it.

## 5. Alert limits and the call budget

### 5.1 Limits

| Item | Limit |
|---|---|
| Alerts | 1000 in total |
| Symbols with alerts | No limit |
| Events in the **Triggered** log | The newest 1000. The server deletes older events. |
| Alert message | 200 characters |

When you have 1000 alerts, you cannot add an alert. Delete an alert first.

### 5.2 How often the server checks an alert

The server checks a symbol at most one time each 30 seconds. All the alerts of one symbol
share one check.

With a real data provider, each check is one call to the provider. The provider permits
only some calls each minute. Thus the alerts get a fixed **call budget**:
**150 calls a minute** (`ALERT_CALL_BUDGET` in `.env`). The watchlist uses the other calls.

The server checks the symbols with alerts in turn. The time between two checks of one
symbol is the larger of these two values:

- 30 seconds.
- The number of symbols with alerts, divided by 150, in minutes.

| Symbols with alerts | One check of each symbol |
|---|---|
| Up to 75 | Each 30 seconds |
| 150 | Each minute |
| 300 | Each 2 minutes |
| 1000 | Each 7 minutes, approximately |

The Alerts window shows the current interval, for example "Checked every 7 min".

### 5.3 What the budget changes

- **A late alert, not a lost alert.** Each check compares the level with the last price and
  with the high and the low of the day. Thus the server finds a crossing between two checks.
  Only the notification comes later.
- **Many symbols make all alerts later.** To get faster alerts, put your alerts on fewer
  symbols. Many alerts on one symbol cost no more than one alert.
- **Indicator alerts use the same budget.** One call serves all the alerts of one symbol on
  one timeframe.
- **The watchlist shares the quotes.** A symbol in the watchlist and in an alert costs one call.
- **Budget warning.** When the budget is used up and symbols wait, the Alerts window shows a
  note. The note tells you that some alerts are checked late. You can dismiss it.
- **Delayed data.** If the provider sends delayed quotes, the alert is also delayed. The
  popup then shows "Delayed data".
- **Synthetic data.** The synthetic provider has no budget. The server checks each symbol
  each 30 seconds.

To change the budget, set `ALERT_CALL_BUDGET` in `.env` (1 to 1000), and restart the server.

**Do not set the budget higher than the plan of your data provider permits.** For example,
FMP Starter permits 300 calls a minute for the alerts and the watchlist together.

## 6. Alert notifications

### 6.1 Popups

An alert that fires shows a popup at the bottom left of the window.

- **Show on chart** opens the symbol of the alert.
- **Dismiss** marks the event as checked and closes the popup.
- After 30 seconds, the popup goes into the bell. The event stays unchecked.
- Up to 3 popups show at one time. A line tells the number of more alerts.

### 6.2 Sound

Each popup plays a short chime. The **Sound** switch and the volume slider are in the
Alerts window. The browser keeps this setting for this device only.

A browser plays no sound until you click the page one time. Before that click, the popup
shows the note "Sound is off until you click the page."

### 6.3 Browser notifications

When the RhinoView tab is hidden, the browser can show a system notification.

1. Open the Alerts window.
2. In **Browser notifications**, click **Allow**.
3. Accept the request of the browser.

If you blocked notifications before, the Alerts window tells you. Then change the
notification setting of the site in your browser.

### 6.4 When no RhinoView tab is open

**Keep a RhinoView tab open to get popups, sound, and notifications.** When no tab is open,
the server still checks the alerts. The events wait in the **Triggered** log, and the bell
shows them when you open RhinoView again. RhinoView sends no e-mail and no mobile push.
