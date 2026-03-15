# polymarket-weather-trade

Autonomous weather betting bot on [Polymarket](https://polymarket.com) using OpenWeatherMap forecasts + NOAA climate observations + AI analysis.

Scans Polymarket for weather events every 2 hours, fetches OpenWeatherMap 5-day/3-hour forecast data plus NOAA CDO v2 climate data for each event location, then sends forecast + climate + market data to AI (one event at a time) to identify profitable mispricings. Each event now yields a single decision: BET or NO BET. If BET, the AI proposes exactly one YES-side outcome (the most likely temperature bucket).

## How It Works

1. **Scan** — Every 2h, fetches active temperature weather markets from Polymarket's Gamma API (weather-tagged -> temperature-tagged -> all-events -> all-markets), then keeps only `temperature` category markets
2. **Sort** — Events sorted by YES/NO price spread (biggest potential edge first), up to 30 events per scan
3. **Classify** — Extracts location + resolution time from Polymarket response fields (`tags`, `title`, `endDate`) and keeps only temperature-category events
4. **Forecast** — Fetches OpenWeatherMap 5-day/3h forecast with daily HIGH/LOW summary across all periods (not just event hour) plus ±12h detail around resolution time
5. **Climate** — Fetches NOAA CDO v2 climate observations: 2 recent daily samples (D-1, D-2) + same-date samples for the previous 5 years, with full-day TMAX/TMIN values
6. **Analyze** — Sends single event + weather + climate + market odds history to GPT-5-nano. AI returns structured JSON with 0–1 proposal (BET/NO BET). If BET, it must include one predicted outcome on YES side with confidence, estimated probability, edge, and reasoning.
7. **Bet** — Reprices the AI proposal from Polymarket before risk/price gates, then reprices again immediately before order submission. Bets are placed only when confidence ≥ 60%, edge ≥ 3%, and updated share price remains within configured odds bounds (`MIN_ODDS_VALUE` to `MAX_ODDS_VALUE`, defaults 0.05-0.70). Strategy is YES-only.
8. **Monitor** — Uses Polymarket WebSocket (`market` + authenticated `user`) updates to trigger near real-time take-profit/stop-loss/win/loss checks, with a slower fallback cron sweep; also cancels unfilled open orders older than 10 minutes and enriches cross-session positions using user orders + market `question` lookups so ticker lines keep readable titles

## Architecture

```
src/
├── index.js              # Express server + Telegram commands
├── scheduler.js          # Core pipeline: scan → weather → AI → bet
├── ai.js                 # OpenAI single-event analysis with structured JSON schema
├── config.js             # Central configuration
├── memory.js             # Polymarket-backed in-memory state + file logs
├── telegram.js           # Telegram bot notifications + commands
├── wallet.js             # Polygon wallet + Polymarket CLOB client
├── health.js             # Health checks
├── logger.js             # Winston logging
├── realtimeMonitor.js    # Polymarket WebSocket subscriptions + real-time triggers
├── retry.js              # Retry with backoff
├── setup.js              # API key derivation utility
├── diagnostic.js         # Balance diagnostic tool
├── adapters/
│   ├── gamma.js          # Polymarket Gamma API (event discovery)
│   └── clob.js           # Polymarket CLOB (trading + sell operations)
└── skills/
    ├── eventScanner.js   # Weather event classification + location extraction
    ├── weatherFetcher.js # OpenWeatherMap forecast + daily max/min summaries
    ├── climateFetcher.js # NOAA CDO v2 station/data fetch + climate formatting
    ├── betExecutor.js    # Bet execution + dynamic take-profit + status monitoring
    └── riskManager.js    # Risk management
```

  ### Runtime State Model (No SQLite)

  - Exchange truth comes from Polymarket APIs (Data API positions + CLOB open orders/trades).
  - Local state in `src/memory.js` is in-memory only and reconciled against exchange snapshots.
  - Operational logs are written to `logs/` (for example, daily log files and scan JSONL).

## Prerequisites

- **Node.js** >= 20
- **Polygon wallet** with USDC.e deposited on Polymarket
- **OpenAI API key** (GPT-5-nano or similar)
- **OpenWeatherMap API key**
- **NOAA CDO API token**
- **Polymarket account** with API credentials

## Setup

### 1. Clone & Install

```bash
git clone <repo-url> polymarket-weather-trade
cd polymarket-weather-trade
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` with your credentials. See the `.env.example` file for detailed descriptions of each variable.

### 3. Derive Polymarket API Credentials

```bash
npm run setup
```

This derives API credentials from your wallet's private key. Copy the output into your `.env` file.

### 4. OpenWeatherMap API Setup

polymarket-weather-trade uses OpenWeatherMap Forecast API (5 day / 3 hour):
https://openweathermap.org/forecast5?collection=current_forecast

1. Create an account at OpenWeatherMap
2. Generate an API key
3. Add to `.env`:

```bash
OWM_API_KEY=your_openweathermap_api_key
```

### 5. NOAA CDO API Setup

polymarket-weather-trade uses NOAA Climate Data Online (CDO) API v2:
https://www.ncdc.noaa.gov/cdo-web/webservices/v2

1. Request token at: https://www.ncdc.noaa.gov/cdo-web/token
2. Add token to `.env`:

```bash
NOAA_CDO_TOKEN=your_noaa_cdo_token
```

Notes:
- Base URL used by the bot: `https://www.ncei.noaa.gov/cdo-web/api/v2`
- NOAA data is observation-based (historical). The bot uses low-request daily sampling aligned to event end time.
- Per event, NOAA calls are sequential (350ms pause) and limited to: D-1 and D-2 daily samples plus one same-date sample for each of the previous 5 years (7 total data requests).
- TMAX/TMIN values are full-day observations (not hourly), so they accurately reflect daily highs and lows regardless of event resolution hour.

### 6. Telegram Notifications (Optional)

1. Message [@BotFather](https://t.me/BotFather) on Telegram → `/newbot`
2. Copy the bot token to `TELEGRAM_BOT_TOKEN` in `.env`
3. Send any message to your new bot
4. Visit `https://api.telegram.org/bot<TOKEN>/getUpdates` and find your chat ID
5. Set `TELEGRAM_CHAT_ID` in `.env`

### 7. Run

```bash
# Development (auto-restart on changes)
npm run dev

# Production
npm start

# With PM2 (recommended for production)
npm run pm2
```

## Configuration

Key settings in `src/config.js` (all configurable via `.env`):

| Setting | Default | Description |
|---------|---------|-------------|
| `scanCron` | `0 */2 * * *` | Scan schedule (every 2h) |
| `scanWindowMinHours` | `6` | Skip events resolving sooner than this |
| `scanWindowMaxHours` | `48` | Look for events resolving up to this far ahead |
| `maxEventsPerScan` | `30` | Max events to process per scan |
| `betAmountUsd` | `1` | Bet size in USD |
| `maxActiveBets` | `8` | Max concurrent active bets |
| `maxDailyBets` | `12` | Max bets placed per day |
| `minConfidence` | `60` | Minimum AI confidence (0–100) to place bet |
| `minEdge` | `0.03` | Minimum estimated edge (3%) to place bet |
| `minOddsValue` | `0.05` | Minimum market price to bet on |
| `maxOddsValue` | `0.70` | Maximum market price to bet on |
| `stopLossPct` | `0.25` | Stop loss at −25% from entry price |
| `takeProfitDisableBeforeEndMinutes` | `0` | Disable take-profit in final N minutes before `event_end` (stop-loss still active) |

### Dynamic Take-Profit

Take-profit targets scale dynamically based on entry price — cheap shares require larger percentage gains, expensive shares take profit earlier:

| Setting | Default | Description |
|---------|---------|-------------|
| `LOW_BET_TAKE_PROFIT` | `300` | Take-profit % for shares bought at $0.01 (300%) |
| `HIGH_BET_TAKE_PROFIT` | `5` | Take-profit % for shares bought at $0.99 (5%) |

The curve is **piecewise-linear** with an asymmetric split:
- **$0.01 → $0.50**: steep drop consuming **4/5** of the LOW→HIGH range
- **$0.50 → $0.99**: gentle drop consuming **1/5** of the range

Example targets with defaults (LOW=300%, HIGH=5%):

| Buy Price | Take Profit |
|-----------|-------------|
| $0.01 | 300% |
| $0.10 | 248% |
| $0.25 | 179% |
| $0.50 | 79% |
| $0.75 | 42% |
| $0.99 | 5% |

Optional end-window lockout:
- Set `TAKE_PROFIT_DISABLE_BEFORE_END_MINUTES` as a signed offset relative to `event_end`:
  - positive value (for example `120`): TP lockout starts N minutes before end
  - negative value (for example `-180`): TP lockout starts N minutes after end
- Stop-loss exits are still evaluated and executed during this window.

### Risk Management

| Setting | Default | Description |
|---------|---------|-------------|
| `maxBetSize` | `2` | Maximum single bet size in USD |

## AI Analysis

Each event is analyzed individually. The AI receives:
- Market data (all outcomes with YES/NO prices, 24h/6h/1h price movements)
- OpenWeatherMap forecast (daily summary + 3h periods around resolution)
- NOAA climate observations (recent + 5-year historical)
- Active bets and recent accuracy summary

The AI returns structured JSON:
- `forecastSummary` — weather outlook
- `uncertaintyAssessment` — confidence drivers and unknowns
- `climateSignalSummary` — historical pattern analysis
- `owmResolutionAlignment` — forecast vs resolution time alignment
- `bets[]` — 0 to 1 proposal:
  - `predictedOutcome` (exact market string)
  - `side` (always YES)
  - `confidence` (0–100)
  - `estimatedProbability` (0–1)
  - `edge` (estimated probability − market implied probability)
  - `reasoning` and `keyFactors`

## Weather Data

### OpenWeatherMap Forecast
- 5-day / 3-hour forecast periods
- **Daily summary** computed across all periods per day: HIGH temp, LOW temp, max wind, total rain/snow — ensuring daily maximums are visible even when event resolves at night
- Detailed 3h periods within ±12h of event resolution time
- Event resolution day tagged with `<<<EVENT DAY`, closest period tagged `<<<EVENT`

### NOAA Climate Observations
- GHCND dataset: TMAX, TMIN, TAVG, PRCP, SNOW, SNWD
- Station selected by distance (haversine) with data coverage tiebreaker
- Full-day TMAX/TMIN values (not hourly samples)
- 2 recent daily observations (D-1, D-2) + same-date observations for 5 prior years

## Weather Categories

polymarket-weather-trade classifies Polymarket weather events into:
- **Temperature** — Heat records, cold records, daily highs/lows
- **Precipitation** — Rain totals, drought, rainfall records
- **Snow** — Snowfall totals, snow depth, blizzards
- **Tropical** — Hurricanes, tropical storms, cyclones
- **Severe** — Tornadoes, thunderstorms, hail
- **Wind** — Wind speed records, gusts
- **Flooding** — Flood events, river levels
- **Humidity** — Dew point, humidity records

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /` | Bot info JSON |
| `GET /status` | Live HTML status dashboard |
| `GET /status/stream` | Server-sent events feed used by `/status` |
| `GET /settings` | HTML settings page (editable runtime/env overrides) |
| `GET /settings/data` | Settings JSON (effective values + source + apply mode) |
| `POST /settings/data` | Save settings overrides to `data/settings-overrides.json` |
| `GET /health` | Health checks |
| `GET /events` | Recent weather events |
| `GET /bets/active` | Active bets |
| `GET /bets/recent` | Recent bet history |
| `GET /risk` | Risk manager status |
| `GET /dashboard` | Dashboard metrics |
| `POST /trigger/scan` | Trigger manual scan |

`GET /status` is a live web dashboard. It streams updates via SSE from `/status/stream`, lists weather/temperature positions, and sorts them by profit percentage (highest first).

`GET /settings` excludes private keys, loads defaults from `.env`, persists first user change to `data/settings-overrides.json`, and then uses those overrides on subsequent runs.
Invalid values are rejected on save (`POST /settings/data`) with field-level validation errors.

## Telegram Commands

`/status` `/balance` `/bets` `/recent` `/stats` `/scan` `/report` `/health` `/risk` `/events` `/pnl` `/help`

## Paper Trading

Set `PAPER_TRADE=true` in `.env` to simulate bets without spending real money. All logic runs identically — bets are tracked in runtime state with `paper=1` but no Polymarket orders are placed.

Trading rules scope:
- Max active bets, duplicate-position checks, take-profit, and stop-loss are enforced only for polymarket-weather-trade weather categories.
- Non-weather positions (for example soccer) in the same Polymarket account are not counted toward polymarket-weather-trade weather limits.

## PM2 Management

```bash
npm run pm2          # Start
npm run pm2:stop     # Stop
npm run pm2:logs     # View logs
pm2 restart polymarket-weather-trade
pm2 monit            # Monitor dashboard
```

## License

MIT
