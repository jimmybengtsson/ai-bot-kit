# solana-swap-bot Node Server

> Autonomous Solana crypto trading bot powered by AI — fully self-contained Node.js server with multi-strategy execution, cross-DEX arbitrage, social-signal context, and real-time risk management.

---

## Overview

solana-swap-bot is an autonomous trading bot that runs on Solana mainnet. It uses the OpenAI Responses API to analyze market data, detect arbitrage opportunities across 60+ Jupiter-integrated DEXes, process social context from an external X scraper, and execute trades through the Jupiter Swap API — all from a single Express server process managed by PM2.

## Latest Updates (2026-03-15)

- Implemented parallel arbitrage leg pre-validation in `scheduler.js` (Proposal 6.2): arb limit-prequote preparation now runs concurrently per leg before execution, reducing pre-check latency for multi-leg sequences.
- Improved trade-type instruction clarity in `ai.js` (Anti-pattern 12 "vague tool descriptions"): added concrete examples and explicit trigger-to-type mapping to reduce wrong type selection.
- Added env-driven config for all `config.js` fields and dynamic strategy allocation via `RISK_DEGEN_SHARE_PCT`.
  - `RISK_DEGEN_SHARE_PCT=60` -> degen 60%, guardian 40% (default)
  - `RISK_DEGEN_SHARE_PCT=0` -> degen disabled, guardian 100%
  - `RISK_DEGEN_SHARE_PCT=100` -> guardian disabled, degen 100%
  - AI schema/instructions, risk checks, and auto-arb strategy routing now adapt automatically.
- Added `REMOVE_DB.md`: phased plan to remove SQLite and run stateless using in-memory runtime state + on-chain data.
- Implemented REMOVE_DB phases 0/1/2 in one shot: introduced `src/runtimeStore.js` and switched memory read paths to in-memory.
- Implemented REMOVE_DB phase 3: removed `src/memory.js`, removed `better-sqlite3`, and rewired scheduler/risk/AI/server paths directly to `runtimeStore`.
- Completed REMOVE_DB phase 4 cleanup: `/config` explicitly reports stateless mode, `/memory/long-term` returns `410`, and docs now reflect runtimeStore-only operation.

### Key Capabilities

| Feature | Description |
|---|---|
| **Dual-strategy AI** | Degen/Guardian allocation is env-driven (`RISK_DEGEN_SHARE_PCT`, default 60/40) |
| **Any-to-any trading** | Trades all 72+ pair combinations across 9 watched tokens |
| **Multi-trade sequences** | Linked arbitrage legs via sequenceGroup — if one leg fails, the rest cancel |
| **Cross-DEX arbitrage** | Scans 60+ DEXes per pair, filters same-family arbs (Raydium vs Raydium CLMM) |
| **Social context** | External X scraper data fed directly into trading AI |
| **Responses API** | Server-side conversation chaining via `previous_response_id` — no history re-sending |
| **Structured JSON outputs** | Strict JSON schemas for trading decisions and news signals |
| **USDC reserve guard** | Keeps a configurable USDC cash floor for trading/take-profit while preserving SOL fee buffer |
| **Paper trading** | Full simulation mode with realistic Jupiter quotes |
| **Memory mode** | Stateless in-memory runtime store (`runtimeStore`) with bounded buffers |
| **Per-module logging** | 14 Winston log files with rotation (5 MB, 3 backups) |
| **PM2 production** | Auto-restart, boot persistence, log rotation, resource monitoring |

No external dependencies on OpenClaw or any other orchestration framework. The server uses the Solana CLI keypair directly and connects to OpenAI, Jupiter, and Helius APIs.

---

## Architecture

```
┌────────────────────────────────────────────────────────────┐
│                  solana-swap-bot Node Server               │
│                  Express + 6 Cron Jobs                     │
├────────────────────────┬───────────────────────────────────┤
│                        │                                   │
│   Degen Strategy (60%) │     Guardian Strategy (40%)       │
│   ─────────────────    │     ──────────────────────        │
│   Momentum / Social    │     Arbitrage / DCA               │
│   Max 8% per trade     │     Max 6% per trade              │
│   Aggressive entry     │     Conservative entry            │
│                        │                                   │
├────────────────────────┴───────────────────────────────────┤
│                                                            │
│   priceScanner ─── Jupiter Price v3 (9 tokens)             │
│   arbitrageFinder ── 72+ pairs × 60+ DEXes (batched)       │
│   tweetScanner ─── external scraper `/x` social context    │
│   tradeExecutor ─── Jupiter Quote + Swap (DEX routing)     │
│   portfolioTracker ── Helius RPC + Jupiter pricing         │
│   riskManager ─── daily limits, cooldown, circuit breaker  │
│                                                            │
│   ┌──────────────────────────────────────────────────┐     │
│   │        OpenAI Responses API (gpt-5-nano)         │     │
│   │  previous_response_id · JSON schema · store:true │     │
│   │       2 channels: trading · daily-report         │     │
│   └──────────────────────────────────────────────────┘     │
│                                                            │
├────────────────────────────────────────────────────────────┤
│   Solana Wallet (CLI keypair · skipPreflight: true)        │
│   Jupiter (Price v3 · Quote v1 · Swap v1)                  │
│   Helius (RPC · token balances)                            │
│   RuntimeStore (in-memory ring buffers + maps)             │
└────────────────────────────────────────────────────────────┘
```

---

## File Structure

```
solana-swap-bot/
├── package.json              # Dependencies, scripts, engines ≥20
├── ecosystem.config.cjs      # PM2 process config
├── .env.example              # Template for environment variables
├── .gitignore
├── README.md
├── src/
│   ├── index.js              # Express server, 20 API endpoints, graceful shutdown
│   ├── config.js             # Central config: tokens, DEXes, risk params
│   ├── logger.js             # Winston factory — per-module log files
│   ├── wallet.js             # Solana keypair, signAndSend, confirmTransaction (poll 5s)
│   ├── ai.js                 # OpenAI Responses API — trading + daily-report JSON workflows
│   ├── scheduler.js          # 7 cron jobs, trading loop, sequence execution, position tracking
│   ├── runtimeStore.js       # In-memory bounded runtime store for stateless mode
│   ├── health.js             # Health checks: RPC ping, wallet, disk space
│   ├── positionTracker.js    # In-memory position lifecycle (pending→confirmed/failed/cancelled)
│   └── skills/
│       ├── priceScanner.js   # Jupiter Price v3 + price change tracking
│       ├── arbitrageFinder.js# All-pairs cross-DEX spread scanner (72+ pairs)
│       ├── tradeExecutor.js  # Jupiter quote → swap → sign+send (paper + live)
│       ├── tweetScanner.js   # External scraper `/x` social context fetcher
│       ├── portfolioTracker.js # Helius wallet balances + USD valuation
│       └── riskManager.js    # Risk rules, circuit breaker, trade persistence
└── logs/                     # Auto-created — 14 log files
    ├── combined.log          # All modules merged (10 MB rotation)
    ├── server.log            # Express startup, routes
    ├── scheduler.log         # Cron ticks, trading loop orchestration
    ├── ai.log                # OpenAI requests, decisions, errors
    ├── wallet.log            # Keypair loading, transaction signing
    ├── health.log            # Health check results
    ├── priceScanner.log      # Price fetches
    ├── arbitrage.log         # Cross-DEX spread detection
    ├── tradeExecutor.log     # Jupiter quotes, swaps, signatures
    ├── tweetScanner.log      # External social context fetches
    ├── portfolio.log         # Wallet balances, valuations
    ├── riskManager.log       # Risk checks, trade recording
    ├── pm2-out.log           # PM2 stdout
    └── pm2-error.log         # PM2 stderr
```

---

## Watched Tokens

19 SPL tokens tracked across all pairs (342 directional combinations):

| Symbol | Mint | Decimals |
|---|---|---|
| SOL | `So111...1112` | 9 |
| USDC | `EPjFW...Dt1v` | 6 |
| JUP | `JUPyi...vCN` | 6 |
| BONK | `DezXA...B263` | 5 |
| WIF | `EKpQG...zcjm` | 6 |
| RAY | `4k3Dy...X6R` | 6 |
| ORCA | `orcaE...ZE` | 6 |
| PYTH | `HZ1Jo...Ct3` | 6 |
| JTO | `jtojt...mCL` | 9 |
| PUMP | `pumpC...Dfn` | 6 |
| TRUMP | `6p6xg...iPN` | 6 |
| RENDER | `rndri...of` | 8 |
| PENGU | `2zMMh...uv` | 6 |
| HNT | `hntyV...ux` | 8 |
| FARTCOIN | `9BB6N...ump` | 6 |
| GRASS | `Grass...Xjs` | 9 |
| W | `85VBF...mQ` | 6 |
| KMNO | `KMNo3...sS` | 6 |
| MET | `METvs...QL` | 6 |

The AI can trade any token to any other token. Server-side SOL→base-unit conversion uses actual prices and the `tokenDecimals` map to compute exact lamport amounts.

---

## DEX Coverage

### Arbitrage Whitelist (14 DEXes)

The arbitrage finder compares prices across these 14 curated DEXes (`compareDexes`), filtering same-family matches:

Orca, HumidiFi, Meteora, Raydium CLMM, Manifest, PancakeSwap, Raydium, PumpSwap, Stabble Stable Swap, Stabble Weighted Swap, Stabble CLMM, Byreal, Meteora DAMM v2, Whirlpool

### Full DEX Routing (60+)

When no specific DEX is requested, Jupiter routes through 60+ integrated DEXes for best execution.

<details>
<summary><strong>Full DEX list (click to expand)</strong></summary>

**Raydium family:** Raydium, Raydium CLMM, Raydium CP

**Orca family:** Orca V1, Orca V2, Whirlpool

**Meteora family:** Meteora, Meteora DLMM, Meteora DAMM v2

**Order-book / hybrid:** Phoenix, OpenBook V2, Manifest

**Concentrated / specialized AMMs:** Lifinity, Lifinity V2, Invariant, Stabble Stable Swap, Stabble Weighted Swap, Stabble CLMM, Crema, FluxBeam, Obric V2

**General AMMs:** Aldrin, Aldrin V2, Cropper, Saros, Saros DLMM, PancakeSwap, GooseFX GAMMA, Saber, Saber (Decimals), Mercurial, Penguin, Guacswap, Bonkswap

**Perps / staking / LST:** Perps, Sanctum, Sanctum Infinity

**Launchpad / meme AMMs:** Pump.fun, Pump.fun Amm, Dynamic Bonding Curve, Moonit, Boop.fun

**Other verified DEXes:** SolFi, SolFi V2, Woofi, Perena, Perena Star, DefiTuna, Gavel, Heaven, Scorch, Aquifer, HumidiFi, BisonFi, AlphaQ, Riptide, Solayer, WhaleStreet, ZeroFi, GoonFi, GoonFi V2, Obsidian, Quantum, 1DEX, Byreal, Carrot, RunnerRodeo, StepN, TesseraV, Virtuals, XOrca

</details>

---

## Trading Pipeline

Each trading loop tick (every 20 min) executes this sequence:

```
1. Health check      → RPC ping, wallet access, disk space
2. Daily limit check → Skip early if halted / target reached
3. Wallet balance    → Helius RPC + Jupiter pricing
4. Price scan        → Jupiter Price v3 for all 19 tokens
5. Price history     → Compute m10/m30 from own snapshots
6. Price changes     → DexScreener m5/h1/h6/h24 + own m10/m30
7. Arbitrage scan    → 171 pairs × 14 whitelisted DEXes (batched)
8. AI decision       → OpenAI Responses API (structured JSON)
9. Fee optimization  → Merge duplicates + collapse chains
10. Trade execution  → Jupiter Quote → Swap → signAndSend
11. On-chain confirm → Poll confirmation (60s standalone / 180s sequence)
12. Log & persist    → RuntimeStore + daily log
```

### Multi-Trade Sequences

The AI can propose multiple trades in a single response, linked via `sequenceGroup`:

- **sequenceGroup = 0** — standalone trade, executed independently
- **sequenceGroup > 0** — linked sequence (e.g. arbitrage buy-leg + sell-leg)
  - If any leg fails → all remaining legs in that group are cancelled
  - Strategies can be mixed within a group — each leg is risk-checked individually

### Any-to-Any Trading

All 19 tokens can be traded against each other. The AI receives the full mint map and can propose:
- SOL → JUP (standard buy)
- BONK → USDC (take profit)
- JUP → WIF (cross-token momentum trade)
- ORCA → USDC (rebalance to main cash reserve)

### DEX-Specific Routing

Each trade can specify a `dex` field to route through a specific DEX (used for arbitrage legs). When `dex` is empty, Jupiter finds the best route automatically.

### Reserve Guards

The scheduler enforces two reserve protections:

- SOL fee buffer: before executing any trade that spends SOL, it checks that SOL does not drop below `SOL_RESERVE` (default 0.05).
- USDC cash floor: before executing trades that spend USDC, it checks that USDC remains above `USDC_RESERVE` (default 25).

The AI also receives `SOL_LOW_ALERT` and `USDC_LOW_ALERT` context hints when reserves are low.

### Fee Optimization

Before execution, the `optimizeTrades()` function optimizes the AI's proposed trades:

- **Merge duplicates:** Combines same-pair trades (e.g. two SOL→JUP trades become one)
- **Collapse chains:** Detects A→B + B→C patterns and collapses to A→C (only if a whitelisted DEX route exists)
- **Combined strategy:** Merged trades use `strategy: "combined"` with CMAX = DMAX + GMAX

### On-Chain Confirmation

Every trade (standalone and sequence legs) is confirmed on-chain after `signAndSend` via polling:

- Standalone trades: 60s timeout, poll every 5s
- Sequence legs: 180s timeout, poll every 5s
- Trades start as `pending` in DB, updated to `confirmed` or `cancelled` after confirmation

### Position Tracking

The `positionTracker` module tracks the lifecycle of every position in memory:

- `openPosition()` → `confirmTransaction()` → `confirmPosition()` / `resolvePosition()`
- Stale position cron (`*/30`): Phase 1 checks in-memory >30min, Phase 2 queries DB pending >30min <24h

---

## AI Integration

### AI Channels

| Channel | Function | Tools | Schema |
|---|---|---|---|
| **trading** | `analyzeAndDecide()` | — | `trading_decision` (action, trades[], reasoning) |
| **daily-report** | `generateDailyReport()` | — | Free-form text |

Each channel maintains its own `previous_response_id` for server-side conversation chaining, so the model sees its full history without re-sending it every request.

### OpenAI Responses API

All AI calls use `client.responses.create()` (not Chat Completions). Benefits:

- **Server-side chaining** — `previous_response_id` links each call to the full prior conversation
- **Structured outputs** — `text.format` with strict JSON schemas for deterministic, parseable responses
- **Prompt caching** — 40–80% cost reduction for repeated system instruction prefixes
- **Stored responses** — `store: true` enables server-side history reference

### Compact Prompt Design

To minimize token usage and avoid 429 rate limits:

- System prompt: ~700 characters with all rules compacted
- Wallet data: only tokens with value > $0.01, shortened keys
- Arbitrage: top 8 results, no raw `allQuotes`
- Triangular arb: top 5 results
- Recent trades: max 30 with price/amount/PnL/DEX/time
- Divergence pairs: max 10
- Multi-timeframe price changes: 6 timeframes (m5, m10, m30, h1, h6, h24) — m10/m30 from own price history
- Soft limits: DMAX/GMAX sent as 90% of actual hard max to prevent edge-case rejections
- Trade history includes full AI reason (no truncation)

### Trading Decision Schema

```json
{
  "action": "trade" | "hold",
  "trades": [{
    "strategy": "degen" | "guardian",
    "type": "momentum" | "arbitrage" | "news" | "dca",
    "inputMint": "So111...",
    "outputMint": "EPjFW...",
    "amountUsd": 12.50,
    "reason": "SOL momentum breakout +4.2% in 30min",
    "slippageBps": 50,
    "dex": "Raydium",
    "sequenceGroup": 0
  }],
  "reasoning": "Strong momentum signal on SOL with confirming news."
}
```

---

## Risk Management

### Risk Parameters

| Rule | Value | Description |
|---|---|---|
| Degen max per trade | Env (`RISK_DEGEN_MAX_PCT`) | Applied on degen budget share from `RISK_DEGEN_SHARE_PCT` |
| Guardian max per trade | Env (`RISK_GUARDIAN_MAX_PCT`) | Applied on guardian budget share (`100 - RISK_DEGEN_SHARE_PCT`) |
| Daily loss halt | 5% of starting balance | `halted = true`, all trades rejected |
| Daily target stop | 10% profit | Stop trading for the day |
| Consecutive loss cooldown | 3 losses (Degen) | Cooldown until reset |
| SOL reserve | Env (`SOL_RESERVE`) | Fee-only SOL floor (default 0.05) |
| USDC reserve | Env (`USDC_RESERVE`) | Main trading/take-profit cash floor |
| Conflict resolution | Guardian overrides Degen | On same token, conservative wins |
| Soft limits to AI | 90% of hard max | Prevents edge-case rejections |
| Max held tokens | 8 (excl. USDC) | Triggers sell-off mode when exceeded |

### Circuit Breaker Flow

```
Trade proposal → Risk check
  ├── Halted? → REJECTED
  ├── Initial balance not set? → REJECTED
  ├── Daily loss limit hit? → HALT + REJECTED
  ├── Daily target reached? → REJECTED
  ├── Consecutive losses? → REJECTED (cooldown)
  ├── Amount > strategy max? → REJECTED
  ├── SOL reserve breach? → REJECTED
  ├── USDC reserve breach? → REJECTED
  └── All passed → APPROVED → Execute
```

---

## Social Signal Ingestion

Trading context includes recent X/Twitter posts fetched from an external scraper server (`GET /x`).
If `SCRAPER_SERVER_ADDRESS` is empty, tweet scanning is skipped and the bot continues without TW context.

---

## Cron Schedule

All schedules are configurable via `.env` (`CRON_*`) and run in UTC.

| Task | Expression | Frequency | Description |
|---|---|---|---|
| Trading loop | `CRON_TRADING_LOOP` (default `10 * * * *`) | Hourly at :10 (default) | Full pipeline: health → wallet → prices → arb → AI → execute |
| Portfolio | `CRON_PORTFOLIO_SNAPSHOT` (default `*/15 * * * *`) | Every 15 min (default) | Helius wallet valuation + risk manager balance update |
| Memory flush | `CRON_MEMORY_FLUSH` (default `0 */2 * * *`) | Every 2 hours (default) | Persist trade stats to long-term memory |
| Daily report | `CRON_DAILY_REPORT` (default `53 23 * * *`) | 23:53 UTC (default) | AI-generated performance summary + risk manager reset |
| Stale positions | `CRON_STALE_POSITION_CHECK` (default `*/30 * * * *`) | Every 30 min (default) | Phase 1: in-memory >30min, Phase 2: runtime pending >30min <24h |

On startup, initial portfolio/prices/changes are fetched, then the first trading loop tick runs after a 5-second delay.

---

## Runtime Store

Runtime state is held in `src/runtimeStore.js` with bounded buffers/maps (no DB file).

| Key | Purpose |
|---|---|
| `eventLog` | Timestamped daily entries: heartbeats, trades, errors, stale checks |
| `longTermMemory` | Memory flush notes and learned summaries |
| `trades` | Trade history including pending/confirmed/cancelled/failed lifecycle |
| `pendingTrades` | Signature-indexed pending trades for stale reconciliation |
| `conversations` | Channel conversation snippets for AI channels |
| `responseIds` | `previous_response_id` mapping by channel |
| `aiMemo` | Last tick AI memo for continuity |
| `tickMetrics` | Recent decision-quality metrics |

---

## API Endpoints

18 REST endpoints for monitoring and manual control:

### Read Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/` | Server status: name, version, wallet, paper mode, uptime, lastTick |
| GET | `/health` | Health checks: RPC ping, wallet access, disk space (503 if unhealthy) |
| GET | `/prices` | Latest token prices + short-term % changes |
| GET | `/portfolio` | Wallet balances (SOL + SPL tokens) + USD valuations |
| GET | `/arbitrage` | Latest cross-DEX arbitrage opportunities |
| GET | `/risk` | Risk state: initialBalance, currentBalance, PnL, halted, tradeCount |
| GET | `/decision` | Last AI trading decision (action, trades, reasoning) |
| GET | `/positions` | In-memory position tracker: pending, confirmed, failed positions |
| GET | `/memory/today` | Today's daily log (plain text) |
| GET | `/memory/long-term` | Deprecated, returns `410` migration message |
| GET | `/config` | Current config: model, paperTrade, tokens, risk params, cron schedule |

### Manual Triggers

| Method | Path | Description |
|---|---|---|
| POST | `/trigger/trade` | Run one trading loop tick immediately |
| POST | `/trigger/portfolio` | Run portfolio snapshot immediately |
| POST | `/trigger/memory-flush` | Flush accumulated stats to long-term memory |
| POST | `/trigger/daily-report` | Generate AI daily report immediately |
| POST | `/trigger/positions-check` | Run stale position check immediately |

All `/trigger/*` routes require `SERVER_ADMIN_API_KEY`.
Provide it via `x-admin-key` or `Authorization: Bearer <key>`.

---

## Raspberry Pi Installation

### Prerequisites

| Component | Requirement |
|---|---|
| **Model** | Raspberry Pi 4 (4 GB) or Pi 5 (8 GB) |
| **OS** | Raspberry Pi OS (64-bit) |
| **Node.js** | v20 or later (v22 recommended) |
| **Network** | Ethernet recommended |
| **Storage** | 32 GB+ microSD or NVMe SSD |

### Step 1 — System updates

```bash
sudo apt update && sudo apt full-upgrade -y
sudo apt install -y build-essential git curl
```

### Step 2 — Install Node.js 22 via nvm

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
source ~/.bashrc
nvm install 22
nvm use 22
node --version   # → v22.x.x
```

### Step 3 — Install Solana CLI

```bash
mkdir -p ~/crypto/solana/bin
sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)" -- --install-dir ~/crypto/solana

echo 'export PATH="$HOME/crypto/solana/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc
solana --version
```

### Step 4 — Create / import wallet

```bash
# Generate new wallet
solana-keygen new --outfile ~/.config/solana/trading-bot.json
# Or restore from seed phrase:
# solana-keygen recover --outfile ~/.config/solana/trading-bot.json

chmod 600 ~/.config/solana/trading-bot.json
solana config set --url https://api.mainnet-beta.solana.com
solana config set --keypair ~/.config/solana/trading-bot.json
solana address
solana balance
```

### Step 5 — Clone and install

```bash
cd ~
git clone <your-repo-url> solana-swap-bot
cd solana-swap-bot
npm install
```

### Step 6 — Configure environment

```bash
cp .env.example .env
nano .env
```

```env
SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_HELIUS_KEY
HELIUS_API_KEY=YOUR_HELIUS_KEY
JUPITER_API_KEY=YOUR_JUPITER_KEY
WALLET_PATH=YOUR_WALLET_PATH
OPENAI_API_KEY=sk-YOUR_OPENAI_KEY
OPENAI_MODEL=gpt-5-nano
PAPER_TRADE=true
LOG_LEVEL=info
PORT=3000

# Optional external scraper server for Twitter/X (see cloak-scraper README)
# If empty, tweet scanning is disabled.
SCRAPER_SERVER_ADDRESS=http://localhost:3030

# Optional API key for scraper server auth (cloak-scraper API_PASSWORD)
SCRAPER_SERVER_API_KEY=

# Cron schedules (UTC)
CRON_TRADING_LOOP=10 * * * *
CRON_PORTFOLIO_SNAPSHOT=*/15 * * * *
CRON_MEMORY_FLUSH=0 */2 * * *
CRON_DAILY_REPORT=53 23 * * *
CRON_STALE_POSITION_CHECK=*/30 * * * *

# Required to enable /trigger/* endpoints
SERVER_ADMIN_API_KEY=

# Shared outbound HTTP timeout (ms)
HTTP_TIMEOUT_MS=15000
```

> **Start with `PAPER_TRADE=true`** to verify everything works before risking real funds.

#### External Scraper Server

Twitter/X data is fetched through an external scraper server (for example `cloak-scraper`).

1. Run your scraper server (see its README for setup).
2. Set `SCRAPER_SERVER_ADDRESS` in `.env` (example: `http://localhost:3030`).
3. If scraper auth is enabled (`API_PASSWORD`), set matching `SCRAPER_SERVER_API_KEY` in this bot.
4. Ensure the scraper server exposes `GET /x` as documented.

If `SCRAPER_SERVER_ADDRESS` is empty, tweet scanning is skipped and the trading loop continues without TW data.

### Step 7 — Test run

```bash
npm start
```

```
╔══════════════════════════════════════════════╗
║           🦀 solana-swap-bot Node Server           ║
╠══════════════════════════════════════════════╣
║  Port:        3000                           ║
║  Wallet:      AbCdEf1234567890AbCdEf...      ║
║  Paper mode:  true                           ║
║  AI model:    gpt-5-nano                     ║
╚══════════════════════════════════════════════╝
```

Test the API:
```bash
curl http://localhost:3000/
curl http://localhost:3000/health
curl http://localhost:3000/prices
curl http://localhost:3000/portfolio
curl http://localhost:3000/risk
curl -X POST http://localhost:3000/trigger/trade
```

### Step 8 — Run with PM2

```bash
npm install -g pm2

# Start via ecosystem config
npm run pm2
# — or directly:
pm2 start ecosystem.config.cjs
```

Useful PM2 commands:
```bash
pm2 status               # Process list
pm2 logs solana-swap-bot        # Stream live logs
pm2 restart solana-swap-bot     # Restart
pm2 stop solana-swap-bot        # Stop
pm2 delete solana-swap-bot      # Remove from PM2
pm2 monit                 # Real-time dashboard
```

**Auto-start on boot:**
```bash
pm2 startup
# Run the printed sudo command, then:
pm2 save
```

**Per-module logs:**
```bash
tail -f logs/scheduler.log    # Trading loop activity
tail -f logs/ai.log           # AI decisions and errors
tail -f logs/tradeExecutor.log # Jupiter swaps
tail -f logs/combined.log     # Everything
```

### Step 9 — Go live

Once paper trading looks good:
```bash
nano ~/solana-swap-bot/.env
# Change: PAPER_TRADE=false
pm2 restart solana-swap-bot && pm2 save
```

---

## Dependencies

| Package | Version | Purpose |
|---|---|---|
| `express` | ^4.21.0 | HTTP server + API endpoints |
| `openai` | ^4.85.0 | Responses API client |
| `@solana/web3.js` | ^1.98.0 | Wallet, transactions, RPC |
| `cron` | ^3.1.7 | 6 cron jobs |
| `winston` | ^3.14.2 | Per-module log files |
| `dotenv` | ^16.4.5 | `.env` configuration |
| `bs58` | ^6.0.0 | Base58 encoding |
| `tweetnacl` | ^1.0.3 | Ed25519 transaction signing |

---

## API Keys Required

| Service | Get it at | Used for |
|---|---|---|
| **Helius** | [helius.dev](https://helius.dev) | Solana RPC + token balances |
| **Jupiter** | [station.jup.ag](https://station.jup.ag/docs/apis) | Price v3, Quote v1, Swap v1, DEX metadata |
| **OpenAI** | [platform.openai.com](https://platform.openai.com) | Trade reasoning and daily reports |

---

## Disclaimer

Automated crypto trading carries significant financial risk. Start with paper trading (`PAPER_TRADE=true`). Only trade with amounts you can afford to lose. This software is provided as-is with no guarantees.
