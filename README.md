# ai-bot-kit

`ai-bot-kit` is a collection of Node.js AI bots and supporting server tools for automated betting/trading workflows and data scraping.

This repository groups multiple services that can run independently, but are designed to work well together in production setups.

## Projects in this repository

### `cloak-scraper`

Status: ⚠️ Not stable | 🧪 In testing | 🟡 In progress

Stealth scraping API service built on CloakBrowser.
It provides HTTP endpoints for search and webpage extraction (`/google`, `/duckduckgo`, `/x`, `/webpage`, `/headlines`) with optional API-key auth and request-queue protection.

### `polymarket-weather-bet`

Status: ✅ Stable | 🧪 In testing | 🟠 Needs review

Daily stateless weather betting server for Polymarket.
It scans upcoming temperature markets, gathers OpenWeatherMap + NOAA context, uses AI to pick and validate one YES outcome, and places (or simulates) fixed-size orders within configured risk/price limits.

### `polymarket-weather-trade`

Status: ✅ Stable | 🧪 In testing | 🟠 Needs review

Autonomous weather trading bot for Polymarket.
It runs recurring scans, analyzes events with AI, executes YES-side entries under risk gates, and manages open positions with real-time monitoring, stop-loss/take-profit logic, and optional Telegram notifications.

## Typical deployment pattern

1. Run `cloak-scraper` as a shared scraping utility service.
2. Run one or both Polymarket bots based on strategy profile:
   - `polymarket-weather-bet` for low-frequency daily execution.
   - `polymarket-weather-trade` for higher-frequency monitoring and trade management.
3. Use PM2 ecosystem files in each folder for process management.

## Notes

- Each project includes its own `README.md`, `.env.example`, and PM2 config.
- Review required API keys and wallet credentials per project before running live.
- Keep `PAPER_TRADE=true` during initial testing.

## Repository GitHub Files

This repository keeps all GitHub/community governance files at the top level (root), and not inside each server folder.

Included at root:

- `LICENSE` (MIT)
- `NOTICE`
- `CONTRIBUTING.md`
- `CODE_OF_CONDUCT.md`
- `SECURITY.md`
- `.github/ISSUE_TEMPLATE/*`
- `.github/pull_request_template.md`
- `.editorconfig`

## Status Templates

Copy-paste any of these for project/server status lines:

- `Status: ✅ Stable`
- `Status: ⚠️ Not stable`
- `Status: 🧪 In testing`
- `Status: 🔴 Blocked`
- `Status: 🟠 Needs review`
- `Status: 🟡 In progress`
- `Status: 🔵 Planned`
- `Status: 🟢 Production ready`
