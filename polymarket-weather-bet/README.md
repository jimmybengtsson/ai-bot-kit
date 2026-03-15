# polymarket-weather-bet

Stateless Polymarket weather betting server focused on daily temperature markets.

`polymarket-weather-bet` runs as an Express API with a cron scheduler. It scans upcoming weather/temperature events on Polymarket, builds weather context from OpenWeatherMap and NOAA, asks OpenAI to choose a single outcome, validates that choice with a second AI pass, then places a YES order (or simulates one in paper mode).

## What This Server Does

- Runs one automatic daily job (`DAILY_SCAN_CRON`, default `16:00 UTC`).
- Runs a separate portfolio snapshot cron every 5 minutes (UTC) to log wallet balance, positions, and open orders with buy/current price and % change.
- Also runs once at startup after wallet checks.
- Scans active Polymarket events/markets that resolve in a configurable future window.
- Filters to temperature-like events and extracts tradable outcomes (`tokenId`, tick size, prices, etc.).
- Prevents duplicate exposure by checking live account positions against event tokens/event IDs.
- Builds weather evidence:
- OpenWeatherMap current conditions plus 5-day forecast context (daily highs/lows plus event-day periods).
- NOAA historical TMAX context (recent days and same calendar date over prior years).
- Uses OpenAI structured output to:
- Pick one exact outcome string.
- Validate whether the pick still holds.
- Enforces both lower and upper YES ask caps (`YES_PRICE_MIN` to `YES_PRICE_MAX`) before placing.
- Places fixed-size BUY YES orders (`FIXED_SHARES`) through Polymarket CLOB.
- Verifies live tick size (`get-tick-size`) before each order and aligns price precision to minimum tick size.
- Exposes health/status endpoints and a manual trigger endpoint.

## What It Does Not Do

- No database, no local persistence.
- No trade lifecycle management (no auto-sell, stop-loss, take-profit, or payout collection).
- No portfolio optimization beyond daily slot limit and event-level duplicate prevention.

## Runtime Flow

At each job run (`startup`, `cron`, or `manual`):

1. Load candidate events from Gamma APIs (tagged events, all events, and active markets pages).
2. Keep only temperature-like items inside the configured resolve window.
3. Shuffle events to avoid deterministic ordering bias.
4. Pull current account positions from Data API and compute used slots.
5. If slots are full (`DAILY_BET_SLOTS`), stop immediately.
6. For each remaining event:
7. Skip if already exposed to that event via token or event ID.
8. Skip if location cannot be extracted.
9. Build OWM + NOAA context text.
10. AI pick pass chooses one outcome or declines.
11. Match AI outcome text back to actual market outcome.
12. Fetch YES ask and skip if outside `[YES_PRICE_MIN, YES_PRICE_MAX]`.
13. AI validation pass confirms/denies first pick.
14. Re-check latest ask and only place BUY YES order if still inside `[YES_PRICE_MIN, YES_PRICE_MAX]`.
15. Continue until slots are full or events are exhausted.

## API Endpoints

- `GET /`: service status, scheduler state, last run summary, and config snapshot.
- `GET /health`: simple uptime/heartbeat response.
- `GET /status`: realtime HTML dashboard with uptime and weather/temperature positions sorted by PnL %.
- `GET /status/data`: one-shot JSON snapshot refresh (used as dashboard fallback/reload source).
- `GET /status/stream`: Server-Sent Events stream for live dashboard updates; 20s polling runs only while at least one SSE client is connected.
- `GET /settings`: HTML settings editor for all `.env.example` variables except `POLYGON_PRIVATE_KEY`.
- `GET /settings/data`: settings payload (effective values + defaults + source).
- `POST /settings/data`: persist overrides to `data/settings.json`.
- `POST /trigger/run`: execute the daily job immediately and return summary.

## Configuration Model

Main config is in `src/config.js` and is loaded from environment variables.

Settings precedence for runtime values is:

1. `data/settings.json` override (created on first save from `/settings`)
2. `.env` / process environment fallback

The settings file is cached in memory for fast reads and refreshed if the file changes on disk.

`/settings` also shows whether each variable applies in realtime or requires a restart.

- Realtime examples: `PAPER_TRADE`, `DAILY_BET_SLOTS`, `SCAN_WINDOW_*`, `YES_PRICE_*`, `FIXED_SHARES`, `OPENAI_MODEL`, `OWM_API_KEY`, `NOAA_CDO_TOKEN`.
- Realtime examples: `PAPER_TRADE`, `DAILY_BET_SLOTS`, `SCAN_WINDOW_*`, `YES_PRICE_*`, `FIXED_SHARES`, `ORDER_EXPIRY_MINUTES`, `OPENAI_MODEL`, `OWM_API_KEY`, `NOAA_CDO_TOKEN`.
- Restart-required examples: `PORT`, `LOG_LEVEL`, `OPENAI_API_KEY`, `FUNDER_ADDRESS`, `SIGNATURE_TYPE`, `POLY_API_*`, `POLY_PASSPHRASE`.

- Required keys fail startup validation:
- `POLYGON_PRIVATE_KEY`
- `OPENAI_API_KEY`
- `OWM_API_KEY`
- `NOAA_CDO_TOKEN`
- Optional Polymarket API credentials (`POLY_API_KEY`, `POLY_API_SECRET`, `POLY_PASSPHRASE`) can be derived from wallet if omitted.
- `PAPER_TRADE=true` (default) simulates order placement and avoids allowance updates.

Both price bounds are enforced in the scheduler before validation and again right before placing the final order.

Limit orders are submitted as `GTD` and expire after `ORDER_EXPIRY_MINUTES` (default `60`).

The scheduler also enforces a same-day placed-bet cap using `DAILY_BET_SLOTS` before each order post.
The cap is derived from Polymarket account state (same-day positions plus same-day unfilled open BUY orders), so it remains correct across server restarts.

## Project Structure

- `src/index.js`: Express server bootstrap + routes + scheduler start.
- `src/scheduler.js`: orchestration loop, slot checks, AI calls, order flow.
- `src/config.js`: environment loading and startup validation.
- `src/logger.js`: Winston logger factory.
- `src/retry.js`: retry/backoff utility and network-retry predicate.
- `src/status.js`: status monitor, weather-position filtering/sorting, SSE payload, and dashboard HTML.
- `src/settingsStore.js`: persisted settings cache + disk sync + file watcher.
- `src/settingsPage.js`: settings dashboard HTML renderer.
- `src/wallet.js`: signer setup, CLOB client, API key derivation, allowance/balance.
- `src/adapters/gamma.js`: Polymarket Gamma API fetchers.
- `src/adapters/clob.js`: positions fetch, ask quote, order placement.
- `src/skills/eventScanner.js`: event discovery/filtering/shuffle.
- `src/skills/weatherFetcher.js`: OWM forecast parsing and context generation.
- `src/skills/climateFetcher.js`: NOAA station lookup and TMAX historical context.
- `src/ai.js`: OpenAI structured pick and validation calls.

## Installation

### 1. Prerequisites

- Node.js `20+`
- npm (bundled with Node.js)
- A funded Polymarket/Polygon-compatible wallet private key
- API keys/tokens:
- OpenAI API key
- OpenWeatherMap API key
- NOAA CDO token

### 2. Install dependencies

```bash
cd /path/to/polymarket-weather-bet
npm install
```

Optional (recommended for production): install PM2 globally.

```bash
npm install -g pm2
```

### 3. Create environment file

```bash
cp .env.example .env
```

### 4. Fill `.env` values

Set all required secrets and choose runtime behavior.

- For safe testing, keep `PAPER_TRADE=true`.
- For live execution, set `PAPER_TRADE=false`, verify wallet/funder addresses, and ensure collateral/allowances are available.

### 5. Start server

```bash
npm start
```

Development watch mode:

```bash
npm run dev
```

PM2 mode (uses `ecosystem.config.cjs`):

```bash
pm2 start ecosystem.config.cjs
pm2 status
```

If you change restart-required values in `/settings`, restart app with:

```bash
pm2 restart polymarket-weather-bet
```

### 6. Verify server

- Open `GET http://localhost:3010/health`
- Open `GET http://localhost:3010/`
- Trigger a run with `POST http://localhost:3010/trigger/run`

## Operational Notes

- Scheduler timezone is UTC.
- Startup routine performs wallet checks and then runs one immediate job.
- Slot usage is derived from live positions each loop iteration.
- In paper mode, orders are logged with simulated order IDs and notional cost.
