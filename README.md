# BlueEdge: Polymarket crypto trader

A static GitHub Pages app for Polymarket's 5 min, 15 min and 1 hour crypto **Up or Down** markets. It has a Paper account (fake money, no sign-in), a Live account (your real Polymarket account), a bot, and live Binance charts. There's no build step and no server.

## Files (all in the repo root)

| File | What it does |
| --- | --- |
| `index.html` | Layout, strict Content-Security-Policy |
| `styles.css` | Mobile-first styles |
| `app.js` | UI, paper account, bot, live orders view |
| `data.js` | Polymarket market discovery + live prices, Binance price feed |
| `strategy.js` | Timeframes + stake (% or $, synced) and the fixed entry rules |
| `live.js` | Live account: encrypted vault, balance, orders, positions, order placement |
| `chart.js` | Binance candlestick chart (history + realtime) |
| `polymarket-sdk.js` | Polymarket's official TypeScript SDK `@polymarket/client` 0.10.0, bundled for the browser (MIT) |
| `lightweight-charts.js` | TradingView Lightweight Charts 5.2.1 standalone build (Apache-2.0, attribution logo kept on) |

Both libraries are vendored, so no third-party scripts load at runtime.

## What's new in 3.2.0

- **Accounts:** save as many live accounts as you like. Each one is encrypted on the device with its own passcode, and "Save all to file" / "Load file" move them as a single JSON file.
- **L1 and L2:**
  - L1 is the signer private key. It signs orders and is required to trade.
  - L2 is the CLOB API key, secret and passphrase. On its own it gives a read-only account: balance, open orders, fills and cancels.
- **Check balance and connection** tests your account (limited to once every 15 seconds):
  - Signer key
  - L2 authentication
  - Balance
  - Close-only mode
  - Trading approvals
  - Order stream
  - Region
- **Price to beat:** comes from Polymarket's Chainlink feed, the price 5 and 15 minute markets resolve on. Markets that resolve on Binance use Binance.
- **Settlement:** uses the official CLOB market result first, then Gamma, then an estimate from Chainlink or Binance after 90 seconds, then a refund after 20 minutes. Trades never stay stuck on "Settling".
- **Markets → Resolved** shows how recent windows ended.
- **Quiet order books** get a REST refresh.
- **Mobile:** pinch-zoom and sideways scrolling are blocked outside the chart.
- **Bot switch:** there's now one, in the bot card on Home.

## Connecting a live account

Settings → Connect a Polymarket account:

- **Wallet address:** the 0x address in your polymarket.com profile menu.
- **Signer private key:** the key for your **Signer Address**. It signs every order. BlueEdge uses it to create CLOB trading credentials automatically (`createOrDeriveApiKey` via the SDK).
- **Relayer API key + address (optional):** polymarket.com → Settings → API Keys → Relayer. Enables gasless approval setup. If you add it, BlueEdge checks that the signer key matches the relayer address.
- **Passcode:** encrypts everything on the device with PBKDF2-SHA256 (310k iterations) + AES-GCM.

**Builder API keys are not used and should never be entered.** Polymarket requires them to stay on a server, and they can't sign orders.

After connecting, Settings shows the account and a **View account details** option (passcode required, auto-hides after 60 s). Use **Lock** to clear keys from memory, or **Disconnect** to remove the account so a different one can be connected. **Download account file** saves the encrypted vault as JSON on your device, and **Load an account file** restores it.

Needs HTTPS (GitHub Pages provides it). Polymarket blocks order placement in some regions; BlueEdge shows that error rather than working around it.

## Live trading

- **Orders:** `placeMarketOrder` BUY, FAK, `amount` = your stake in USD, `maxPrice` = current ask + 2¢.
- **Sells:** FAK with `minPrice` = bid − 2¢.
- **Open orders, positions, fills:** `listOpenOrders`, `listPositions`, `listAccountTrades`.
- **Balance:** `fetchBalanceAllowance` (pUSD).
- **Cancel:** `cancelOrder`, or `cancelAll`.
- **Updates:** the authenticated user WebSocket triggers refreshes. Polling is only a 30 s backup (90 s in background tabs).
- **Credentials:** cached encrypted and reused on unlock, so keys aren't re-derived every session.
- **Bot safety:** asks for confirmation before starting in Live mode, never auto-resumes after a reload, and tries each market once.

## Bot rules

You set **timeframes** and **stake**. The entry rules are fixed and listed in the app under "How the bot picks trades":

- Follow Binance's move since the window opened.
- Enter between 30 s after the open and 60 s before the close.
- Pay 35–75¢ with a spread of 3¢ or less.
- At most 3 open positions, and one entry per market.

## Chart

- **Coins:** the chart shows exactly the coins Polymarket currently lists.
- **Intervals:** 1m, 3m, 5m, 15m, 30m, 1h, 2h, 4h, 6h, 8h, 12h, 1d, 3d, 1w, 1M.
- **History:** loads 1,000 real candles, and older candles load as you scroll left.
- **Realtime:** a kline WebSocket keeps the chart current. It reconnects and backfills any gap if the stream goes quiet.
- **Tick size:** comes from Binance `exchangeInfo`.
- **Window open line:** tap a market under the chart to draw its window-open price.

## Rate limits

- Gamma: serial queue ≤25 req/10 s with backoff.
- Prices: all come from WebSockets.
- Binance REST: ≤60 req/min with host fallback (binance.vision → binance.com → binance.us).
- Live account: stream-driven.
