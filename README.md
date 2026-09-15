# BlueEdge — Polymarket 15M Trader

A GitHub Pages-compatible, front-end-only trading terminal for researching short-duration Polymarket crypto markets against live public Binance market data.

## What works on GitHub Pages

- Custom dark blue trading UI
- Polymarket public market discovery through the Gamma API
- Live public Binance WebSocket ticker data
- Crypto market filtering
- 5m / 15m / 1h strategy settings
- Probability / edge / signal-score calculator
- Local strategy persistence
- Local paper-trading bot with independent start/stop state
- Local trade log
- Browser-only backtest demo
- Responsive mobile layout
- No build step and no nested folders

## Deploy

1. Create a GitHub repository.
2. Put all files from this directory in the repository root.
3. In GitHub: Settings → Pages → Deploy from a branch.
4. Select `main` and `/ (root)`.
5. Open the generated Pages URL.

## Important execution limitation

GitHub Pages is static hosting. It cannot safely hold server-side secrets, maintain a secure multi-user database, or sign authenticated Polymarket orders for users.

This build therefore intentionally provides **paper execution only**. Do not paste a private key, Polymarket signing secret, Binance secret, or wallet seed into the browser.

For real-money automated execution, keep this exact frontend and add a separate secure backend/serverless execution service. The backend should authenticate users, encrypt credentials, sign orders server-side, enforce risk limits, and write the authoritative database/audit log.

## Public data

Polymarket documents its Gamma API as public market data with no authentication required:
https://docs.polymarket.com/market-data/overview

The market list endpoint is:
https://gamma-api.polymarket.com/markets

Binance provides public WebSocket market streams. This frontend uses the public ticker stream for BTCUSDT, ETHUSDT and SOLUSDT.

## Strategy model

The example model combines:

- Polymarket YES price
- external Binance price
- deterministic momentum-style score
- estimated model probability
- probability edge
- entry/target/stop thresholds
- time-to-expiration cutoff
- risk controls

The displayed model is a research framework, not a profitability guarantee.

## Security

Never put:
- private keys
- wallet seed phrases
- Polymarket signing credentials
- Binance API secrets
- database passwords

in GitHub Pages JavaScript.

For a production version, use a backend with server-side secrets and an audited execution path.
