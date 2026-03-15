# cloak-scraper

`cloak-scraper` is a Node.js API server that exposes scraping endpoints for other backend services.

It uses the JavaScript version of [CloakBrowser](https://github.com/CloakHQ/CloakBrowser) to browse pages with a stealth Chromium build and humanized behavior, improving reliability on bot-protected pages.

## Features

- Server-to-server scraping API
- Built-in endpoints:
  - `GET /x`
  - `GET /google`
- Extra endpoints:
  - `GET /duckduckgo`
  - `GET /headlines`
  - `GET /webpage`
  - `GET /health`
- Optional API key authentication via `API_PASSWORD`
  - If empty, API is open to all callers
- Built-in request queue for overload protection
- Configurable scraping limits and CloakBrowser launch options

## Requirements

- Node.js 20+
- npm 10+
- macOS/Linux/Windows supported by CloakBrowser

## Install

This section is written for non-developers. Follow each step in order.

### 1. Install Node.js (one time)

If you already have Node.js, skip to step 2.

Check if Node.js is installed:

```bash
node -v
npm -v
```

If those commands fail, install Node.js:

- Open https://nodejs.org
- Download the LTS version
- Run the installer with default options
- Re-open Terminal after install

Then run `node -v` and `npm -v` again to confirm it worked.

### 2. Open Terminal in this project folder

You should now be inside the `cloak-scraper` folder.

### 3. Install project dependencies

```bash
npm install
```

This downloads everything the server needs.

### 4. Prepare configuration

```bash
cp .env.example .env
```

- Open the `.env` file in a text editor.
- Set `API_PASSWORD` if you want to protect the API.
- Leave `API_PASSWORD` empty if you want open access.
- Save the file.

API key generator example: https://www.uuidgenerator.net/api/version4

## Run

### Start normally

```bash
npm start
```

When it starts, you should see a message similar to:

- `cloak-scraper listening on http://0.0.0.0:3030`

Development mode:

```bash
npm run dev
```

Health check:

```bash
curl "http://localhost:3030/health"
```

Stop the server anytime with `Ctrl + C` in Terminal.

## PM2

A PM2 ecosystem config is included at `ecosystem.config.cjs`.

Install PM2 globally (once):

```bash
npm install -g pm2
```

Start app with PM2:

```bash
pm2 start ecosystem.config.cjs --env production
```

Useful PM2 commands:

```bash
pm2 status
pm2 logs cloak-scraper
pm2 restart cloak-scraper
pm2 stop cloak-scraper
```

## Request queue

The server includes an in-memory request queue middleware to prevent overload when scrape calls arrive in bursts.

- Up to `QUEUE_CONCURRENCY` requests run at the same time
- Extra requests wait in queue
- When queue size reaches `QUEUE_MAX_SIZE`, new requests return `429`

Queue settings:

- `QUEUE_ENABLED=true|false`
- `QUEUE_CONCURRENCY=2`
- `QUEUE_MAX_SIZE=100`

`GET /health` includes queue runtime stats (`active`, `queued`, limits).


## Auth

When `API_PASSWORD` is set, clients must include either:

- Header `x-api-key: <your-password>`
- Header `Authorization: Bearer <your-password>`

Example:

```bash
curl "http://localhost:3030/google?search=ai+agents&results=5" \
  -H "x-api-key: YOUR_API_PASSWORD"
```

## Endpoints

### `GET /x`

Scrapes X/Twitter search results and returns tweet-like result cards.

Query params:

- `search` (required): word or phrase to search on X
- `results` (optional): max amount of results to return
- `user` (optional): if provided, only tweets from this user (`from:user` is added to query)

Example:

```bash
curl "http://localhost:3030/x?search=agentic+ai&user=OpenAI&results=8" \
  -H "x-api-key: YOUR_API_PASSWORD"
```

### `GET /google`

Scrapes Google search results.

Query params:

- `search` (required)
- `results` (optional)

Example:

```bash
curl "http://localhost:3030/google?search=cloakbrowser&results=10" \
  -H "x-api-key: YOUR_API_PASSWORD"
```

### `GET /duckduckgo`

Alternative search endpoint using DuckDuckGo.

Query params:

- `search` (required)
- `results` (optional)

### `GET /headlines`

Extracts page headings (`h1`, `h2`, `h3`) from any URL.

Query params:

- `url` (required, `http`/`https` only)
- `results` (optional)

### `GET /webpage`

Generic selector-based scraping endpoint.

Query params:

- `url` (required, `http`/`https` only)
- `selector` (optional, default `body`)
- `results` (optional)

## Response format

All endpoints return JSON with this shape:

```json
{
  "ok": true,
  "source": "google",
  "count": 5,
  "results": []
}
```

Errors:

```json
{
  "ok": false,
  "error": "...",
  "status": 400
}
```

## Environment variables

See `.env.example` for all options. Main ones:

- `API_PASSWORD` - empty means open mode
- `PORT`, `HOST`
- `QUEUE_ENABLED`, `QUEUE_CONCURRENCY`, `QUEUE_MAX_SIZE`
- `DEFAULT_RESULTS`, `MAX_RESULTS`
- `MAX_SCROLLS`, `SCROLL_DELAY_MS`
- `CLOAK_HEADLESS`, `CLOAK_HUMANIZE`, `CLOAK_HUMAN_PRESET`
- `CLOAK_PROXY`, `CLOAK_LOCALE`, `CLOAK_TIMEZONE`, `CLOAK_GEOIP`
- `CLOAK_ARGS` (comma-separated Chromium args)

## Notes on reliability

- X/Google DOM structures can change. The endpoint parsers are best-effort and may need selector updates over time.
- CloakBrowser downloads a Chromium binary on first run.
- On macOS, Gatekeeper may require a first-run approval for downloaded Chromium binaries.

## Security recommendations

- Set `API_PASSWORD` in production.
- Place this service behind a private network, VPN, or reverse proxy allowlist.
- Add per-IP rate limiting upstream if this API is internet-facing.

## Contributing

Contributions are welcome. See `CONTRIBUTING.md` for branch, checklist, and PR expectations.

## Code of Conduct

Community interactions are governed by `CODE_OF_CONDUCT.md`.

## Security policy

For vulnerability reporting and security handling, see `SECURITY.md`.

## Legal reminder

Scrape only where you are authorized to do so and follow each target website's terms and applicable laws.
