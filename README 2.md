# BlueEdge — Polymarket crypto trader

A static, GitHub Pages–ready paper-trading terminal for Polymarket's crypto **Up or Down** markets on the **5 min, 15 min and 1 hour** timeframes, with live Binance prices. No build step.

## Files

| File | What it does |
| --- | --- |
| `index.html` | Layout. Sidebar on desktop, bottom tab bar on phones. |
| `styles.css` | Mobile-first styles. |
| `data.js` | Polymarket discovery + live prices, Binance feed, request limiting. |
| `strategy.js` | Market filters, synced %/$ risk, plain-English summary. |
| `app.js` | UI, paper trading, bot, settlement. |

## Live data

**Polymarket markets (Gamma REST).** One request for every crypto event ending in the next ~65 minutes (`/events?tag_slug=crypto…`), then only the 5m / 15m / 1h Up or Down markets are kept. Coins are discovered, not hardcoded. Recurring series found this way are remembered and used to fill any gaps.

**Polymarket prices (CLOB WebSocket).** `wss://ws-subscriptions-clob.polymarket.com/ws/market` streams best bid/ask for the live and next window of each market. No polling.

**Binance (WebSocket).** One combined stream per coin: `miniTicker` plus `kline_5m`, `kline_15m`, `kline_1h`. The kline open is the window's opening price. Tries `data-stream.binance.vision`, then `stream.binance.com`, then `stream.binance.us`, and remembers whichever works.

**Settlement.** When a window closes, the app asks Gamma for that market's official result and pays $1/share to the winning side.

## Staying under rate limits

- All REST calls go through one serial queue capped at 25 requests / 10 s (Polymarket allows far more).
- Responses are cached for 15 s; 429 / 5xx responses trigger exponential backoff.
- Market discovery runs every 60 s by default (configurable), plus once when a window rolls over.
- Discovery pauses in background tabs unless the bot is on or you have open positions.
- Prices come from WebSockets, so price updates cost zero REST requests.

Settings → Connections shows live status and requests in the last minute.

## Strategy

No signal scores. You set:

- Timeframes (5 min / 15 min / 1 hour)
- Side: follow Binance's move since the window opened, always Up, always Down, or the cheaper side
- Entry price range, max spread, min liquidity
- Wait after open / stop with time left
- Exit: hold to close, or take profit / stop loss
- **Risk:** stake per trade and daily loss limit, each as % **or** $. Editing either updates the other everywhere (Home, Strategy, other open tabs). Whichever you edited last is locked; the other follows your equity.

Fees use each market's `feeSchedule.rate` (shares × rate × p × (1 − p)). Orders under the market's minimum share size are rejected, like on Polymarket.

## Deploy

Put these files (plus `.nojekyll`) in the repo root → Settings → Pages → deploy from `main` / root.

## Limits

- Paper trading only. Never put private keys, seed phrases or API secrets in this site.
- The bot runs only while the page is open. Phones pause background tabs.
- 5m/15m markets resolve on Chainlink, not Binance, so the Binance "move since open" is a close approximation, not the official price to beat.
