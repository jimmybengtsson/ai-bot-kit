# polymarket-weather-trade

Autonomous weather betting bot on [Polymarket](https://polymarket.com) using OpenWeatherMap forecasts + NOAA climate observations + AI analysis.

Scans Polymarket for weather events every 2 hours, fetches OpenWeatherMap 5-day/3-hour forecast data plus NOAA CDO v2 climate data for each event location, then sends forecast + climate + market data to AI (one event at a time) to identify profitable mispricings. Each event now yields a single decision: BET or NO BET. If BET, the AI proposes exactly one YES-side outcome (the most likely temperature bucket).

## Latest Server Updates (2026-03-18)

- Completed PR-A follow-up visibility in ops metrics: `GET /metrics` now includes `summaries.prA` with validator and boundary-guard gate rejection counts.
- Added runbook tuning guidance for PR-A thresholds in `OPERATIONS.md` (validator/boundary gate calibration flow).
- Added explicit public read control for status/health endpoints via `PUBLIC_READ_ENDPOINTS_ENABLED`.
- Added project CI workflow: `.github/workflows/polymarket-weather-trade-ci.yml` (syntax checks + tests).

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
| `scanCron` | `0 */2 * * *` | Scan schedule (UTC) |
| `dailyReportCron` | `50 23 * * *` | Daily report cron (UTC) |
| `staleOrderCancelCron` | `* * * * *` | Stale order cancel cron (UTC) |
| `statusFallbackCron` | `*/10 * * * *` | Fallback status-check cron (UTC) |
| `scanWindowMinHours` | `12` | Skip events resolving sooner than this |
| `scanWindowMaxHours` | `48` | Look for events resolving up to this far ahead |
| `maxEventsPerScan` | `30` | Max events to process per scan |
| `betAmountUsd` | `1` | Bet size in USD |
| `maxActiveBets` | `8` | Max concurrent active bets |
| `maxDailyBets` | `12` | Max bets placed per day |
| `maxDailyUniqueExposures` | `12` | Daily cap on unique exposure keys (`event+token`) across positions/open orders/in-flight intents |
| `minConfidence` | `60` | Minimum AI confidence (0–100) to place bet |
| `minEdge` | `0.03` | Minimum estimated edge (3%) to place bet |
| `minOddsValue` | `0.05` | Minimum market price to bet on |
| `maxOddsValue` | `0.70` | Maximum market price to bet on |
| `stopLossPct` | `0.25` | Stop loss at −25% from entry price |
| `resolutionGraceMinutes` | `120` | Minimum post-close wait before auto settlement to won/lost |
| `tradingMode` | `paper` | Runtime mode: `off`, `shadow`, `paper`, `live` |
| `publicReadEndpointsEnabled` | `true` | Controls whether status/health read endpoints are public (`false` requires ops auth) |
| `volatilityConfidenceEnabled` | `true` | Enables volatility-scaled confidence floor |
| `volatilityLowPct` | `8` | Volatility threshold (pct) for low confidence bump |
| `volatilityHighPct` | `18` | Volatility threshold (pct) for high confidence bump |
| `liquidityMinScore` | `55` | Minimum liquidity quality score before order placement |
| `circuitBreakerFailureThreshold` | `3` | Consecutive failures before scope breaker opens |
| `circuitBreakerCooldownMs` | `300000` | Breaker open cooldown before half-open probe |

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

Dynamic end-window lockout:
- Take-profit lockout is computed dynamically per position from live data (`buyPrice`, `currentPrice`, and `minutes-to-end`).
- Higher-risk profiles (very cheap entries and large unrealized gains) lock out take-profit earlier before event end.
- If `event_end` has passed but `closed=true` is not observed yet, TP is not permanently frozen solely on `event_end`.
- Stop-loss exits are still evaluated and executed during this window.

### Resolution-Aware Settlement (Conservative)

Settlement now follows Polymarket/UMA resolution flow conservatively:
- `closed=true` alone is not enough to mark a bet won/lost immediately.
- A post-close grace window is enforced (2 hours baseline) before auto-resolution checks.
- Auto-resolution only happens when terminal payout-like prices are observed:
  - win: price `>= 0.999` (treated as redeemable $1.00)
  - loss: price `<= 0.001` (treated as redeemable $0.00)
- Secondary source: when orderbook prices are unavailable, the bot checks Gamma market outcome prices for the token side and only settles if they are terminal.

This avoids premature win/loss marking before final payout value is actually reached.

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
| `GET /status/stream` | SSE feed for status snapshots; supports `?typed=true` and heartbeat events |
| `GET /settings` | HTML settings page (editable runtime/env overrides) |
| `GET /settings/data` | Settings JSON (effective values + source + apply mode) |
| `POST /settings/data` | Save settings overrides to `data/settings-overrides.json` (ops auth required) |
| `GET /health/live` | Liveness probe (process only) |
| `GET /health/ready` | Readiness probe (exchange/wallet/balance/openai prerequisites) |
| `GET /health` | Full health checks |
| `GET /metrics` | Typed counters/events snapshot with bounded retention (ops auth required) |
| `GET /slo` | Availability/latency aggregate snapshot (`windowHours` query) (ops auth required) |
| `GET /events` | Recent weather events |
| `GET /bets/active` | Active bets |
| `GET /bets/recent` | Recent bet history |
| `GET /risk` | Risk manager status |
| `GET /dashboard` | Dashboard metrics |
| `POST /trigger/scan` | Trigger manual scan (ops auth required) |
| `POST /trigger/report` | Trigger manual report (ops auth required) |
| `GET /trading-mode` | Current runtime mode |
| `POST /trading-mode` | Change runtime mode (ops auth required, `live` needs `confirm=true`) |
| `GET /ops/executions` | Recent execution lifecycle records (ops auth required) |
| `GET /ops/incidents` | Recent incidents including partial fills/breaker events (ops auth required) |
| `GET /ops/circuit-breakers` | Current per-scope circuit breaker state (ops auth required) |
| `GET /ops/expected-fills` | Pending/observed expected-fill reconciliation state (ops auth required) |
| `GET /ops/reconciliation` | Recent reconciliation outcomes from in-memory and durable audit records (ops auth required) |
| `GET /ops/audit` | Durable audit trail for AI/risk/order/incidents (`type`, `limit`) (ops auth required) |

`GET /status` is a live web dashboard. It streams updates via SSE from `/status/stream`, lists weather/temperature positions, and sorts them by profit percentage (highest first).

`GET /status/stream` supports typed SSE for automation clients:
- `?typed=true` emits named events (`snapshot`, `heartbeat`) and event ids.
- `?heartbeatMs=15000` customizes heartbeat cadence (minimum 3000 ms).

`GET /settings` excludes private keys, loads defaults from `.env`, persists first user change to `data/settings-overrides.json`, and then uses those overrides on subsequent runs.
Invalid values are rejected on save (`POST /settings/data`) with field-level validation errors.

## Telegram Commands

`/status` `/balance` `/bets` `/recent` `/stats` `/scan` `/report` `/health` `/risk` `/events` `/pnl` `/help`

## Paper Trading

`TRADING_MODE` is now the preferred execution switch:
- `off`: analysis and scans can run, but no order placement/sells are submitted.
- `shadow`: decision-only mode, no execution submissions.
- `paper`: simulated orders.
- `live`: real order submission (must be set explicitly and requires confirmation through `/trading-mode`).

## Ops API Auth

Set `OPS_API_TOKEN` to protect mutation/ops endpoints. Protected routes accept:
- `Authorization: Bearer <token>`
- `x-ops-token: <token>`
- `?opsToken=<token>` (for clients that cannot set headers)

Set `PUBLIC_READ_ENDPOINTS_ENABLED=false` if you also want status/health reads (`/status`, `/status/stream`, `/health/live`, `/health/ready`, `/health`) to require ops token auth.

Phase 4 reconciliation knobs:
- `EXPECTED_FILL_STALE_MS` controls stale pending expected-fill detection.
- `RECONCILIATION_TOLERANCE_SIZE` and `RECONCILIATION_TOLERANCE_PRICE_PCT` define mismatch thresholds.
- `EXCHANGE_REFRESH_MIN_INTERVAL_MS` and `STALE_PLACED_GRACE_MINUTES` tune exchange-state reconciliation cadence/safety.

PR-A strategy guard knobs:
- `AI_VALIDATOR_ENABLED` enables second-pass candidate validation for borderline picks.
- `AI_VALIDATOR_CONFIDENCE_MAX` and `AI_VALIDATOR_EDGE_MAX` define borderline zones that trigger second-pass validation.
- `BOUNDARY_NO_TRADE_BAND_DEG` defines the no-trade buffer around integer threshold boundaries.
- `BOUNDARY_OVERRIDE_CONFIDENCE` and `BOUNDARY_OVERRIDE_EDGE` allow high-quality candidates to override boundary guard rejection.
- `GET /metrics` includes `summaries.prA` with `aiValidatorRejects`, `boundaryGuardRejects`, and PR-A share of total gate rejections.

PR-B exposure controls:
- `MAX_DAILY_UNIQUE_EXPOSURES` caps daily unique exposure keys (`event_id + token_id`) computed from active positions, open BUY orders, and in-flight entry intents.
- Scheduler now blocks event entry when any same-event exposure already exists across positions/open orders/in-flight execution intents.

PR-C execution quality controls:
- `VOLATILITY_CONFIDENCE_ENABLED` toggles dynamic confidence floor bumps using recent odds volatility.
- `VOLATILITY_LOW_PCT` / `VOLATILITY_HIGH_PCT` and corresponding bump values tune additional confidence required in volatile windows.
- `LIQUIDITY_MIN_SCORE`, `LIQUIDITY_FRESH_MS`, and `LIQUIDITY_MAX_SPREAD_PCT` configure the pre-order liquidity-quality gate.

## Testing and CI

Phase 5 test coverage is now included under `tests/`:
- Unit tests:
  - stop-loss strictness (`tests/unit/betExecutor.test.js`)
  - outcome matching (`tests/unit/outcomeMatching.test.js`)
  - execution idempotency (`tests/unit/executionStore.test.js`)
  - settings validation (`tests/unit/settingsValidation.test.js`)
  - NOAA sample-type formatting separation (`tests/unit/climateFormatting.test.js`)
- Integration tests:
  - scheduler status-tick queue replay semantics (`tests/integration/statusTickQueue.test.js`)

NPM test and quality commands:
- `npm run test`
- `npm run test:unit`
- `npm run test:integration`
- `npm run check:syntax`

CI workflow:
- `.github/workflows/polymarket-weather-trade-ci.yml`
- Runs dependency install, syntax checks, unit tests, and integration tests on pushes/PRs that touch this project.

## Dev Lifecycle Scripts

Phase 5 lifecycle scripts:
- `npm run dev:up` starts local server and writes pid file.
- `npm run dev:status` prints current server status.
- `npm run dev:smoke` performs basic endpoint smoke checks.
- `npm run dev:down` stops local server from pid file.

## Operations Runbook

Operational incident and recovery procedures are documented in `OPERATIONS.md`, including:
- health-first triage flow,
- breaker and incident inspection endpoints,
- expected-fill/reconciliation handling,
- safe live-mode transition checklist.

## Strategy Roadmap (Second Pass)

Additional trading-strategy upgrades from a second-pass cross-bot analysis are documented in:
- `UPDATES_NEW.md`

Focus areas in this new roadmap:
- dual-pass AI agreement for borderline entries,
- event-level exposure budgeting across positions + open orders,
- volatility-scaled confidence floors,
- liquidity quality scoring,
- boundary no-trade bands,
- time-to-resolution partial de-risk ladders,
- post-trade attribution with auto-tuning suggestions.

Trading rules scope:
- Max active bets, duplicate-position checks, take-profit, and stop-loss are enforced only for polymarket-weather-trade weather categories.
- Non-weather positions (for example soccer) in the same Polymarket account are not counted toward polymarket-weather-trade weather limits.

## Detailed Update Coverage

This section summarizes all major delivered updates currently implemented in this repository, grouped by rollout tracks.

### Phase 1: Safety and Control Plane

- Added privileged ops authentication (`OPS_API_TOKEN`) for mutation/control endpoints and `/ops/*` routes.
- Added explicit runtime execution modes (`off`, `shadow`, `paper`, `live`) with guarded live-mode transition.
- Split health endpoints into liveness/readiness/full diagnostics (`/health/live`, `/health/ready`, `/health`).

### Phase 2: Execution Reliability Hardening

- Added durable execution lifecycle state with deterministic execution keys to prevent duplicate submissions.
- Added per-scope circuit breakers for repeated execution failures.
- Added managed execution transitions for entry and exit flows, with structured incident tagging.

### Phase 3: Observability and Metrics

- Added typed telemetry counters/events with bounded retention and API access via `/metrics`.
- Added SLO/availability aggregation endpoint `/slo` for operational monitoring windows.
- Upgraded status SSE stream to support typed events (`snapshot`, `heartbeat`) for automation clients.

### Phase 4: Reconciliation and Incident Recovery

- Added expected-fill tracking and stale/mismatch detection in execution durability layer.
- Added reconciliation thresholds and cadence knobs for size/price drift and exchange refresh behavior.
- Added operational visibility endpoints for expected fills and reconciliation outcomes (`/ops/expected-fills`, `/ops/reconciliation`).

### Phase 5: Quality Gates and Operational Runbook

- Added unit and integration test suites under `tests/unit` and `tests/integration`.
- Added CI workflow to run syntax checks, unit tests, and integration tests on relevant push/PR activity.
- Added lifecycle scripts (`dev:up`, `dev:status`, `dev:smoke`, `dev:down`) and documented incident handling in `OPERATIONS.md`.

### PR-A: Dual-Pass Validator + Boundary No-Trade Guard

- Added optional second-pass AI validator path for borderline candidates (confidence/edge band).
- Added deterministic boundary no-trade guard around integer temperature thresholds with strict override requirements.
- Added scheduler gate-rejection telemetry/audit emission for validator disagreement and boundary rejections.

### PR-B: Event Exposure Ledger + Unique Daily Exposure Budget

- Added event exposure snapshots combining active positions, open BUY orders, and in-flight entry intents.
- Added unique daily exposure budget keyed by `event_id + token_id` for restart-safe daily capacity control.
- Added scheduler pre-analysis and pre-submit exposure checks to block overexposed events before order placement.

### PR-C: Volatility Confidence Floor + Liquidity Quality Gate

- Added volatility summary helper from recent odds movement to derive dynamic confidence requirements.
- Added volatility-aware confidence bump logic in risk checks so high-volatility setups require stronger conviction.
- Added liquidity quality scoring (spread, top-of-book depth, freshness) and scheduler gating before execution.

### Additional Runtime Strategy Improvements (Already Live)

- Live repricing is performed both post-AI and immediately pre-order to reduce stale quote entries.
- Hard odds bounds and strict YES-only BET/NO BET decision policy are enforced at execution gate level.
- WebSocket-driven realtime monitoring triggers faster TP/SL evaluation with queued replay fallback.
- Take-profit lockout supports signed offsets relative to event end while keeping stop-loss always active.
- Cross-session title enrichment and exchange-backed reconciliation keep status visibility stable after restarts.

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
