import { config } from './config.js';
import { state } from './scheduler.js';
import { getPolymarketPositions } from './adapters/clob.js';
import { getAddress } from './wallet.js';
import { createLogger } from './logger.js';

const log = createLogger('status');
const STATUS_REFRESH_MS = 20000;
const WEATHER_RE = /(weather|temperature|degrees|fahrenheit|celsius|daily-temperature|daily temperature|record high|record low|climate|heat|cold)/i;

const monitor = {
  startedAt: new Date(),
  account: '',
  lastUpdatedAt: null,
  error: null,
  allPositionsCount: 0,
  weatherPositions: [],
  timer: null,
  running: false,
  listeners: new Set(),
};

function toNum(...vals) {
  for (const v of vals) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function normalizePct(v) {
  if (!Number.isFinite(v)) return null;
  if (Math.abs(v) <= 1) return v * 100;
  return v;
}

function textParts(pos) {
  const tags = Array.isArray(pos.tags) ? pos.tags.map((t) => (typeof t === 'string' ? t : t?.slug || t?.label || '')).join(' ') : '';
  return [
    pos.title,
    pos.market_title,
    pos.event_title,
    pos.question,
    pos.slug,
    pos.market_slug,
    pos.event_slug,
    pos.description,
    pos.outcome,
    tags,
  ].filter(Boolean).join(' ');
}

function isWeatherPosition(pos) {
  return WEATHER_RE.test(textParts(pos));
}

function toIso(...vals) {
  for (const v of vals) {
    if (!v) continue;
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return null;
}

function detectSide(outcomeText, sideText) {
  const combined = `${String(sideText || '')} ${String(outcomeText || '')}`.toLowerCase();
  if (/\byes\b/.test(combined)) return 'YES';
  if (/\bno\b/.test(combined)) return 'NO';
  return 'N/A';
}

function mapPosition(pos) {
  const shares = toNum(
    pos.shares,
    pos.size,
    pos.position,
    pos.balance,
    pos.amount,
    pos.quantity,
    pos.total_shares,
  );

  const avgPrice = toNum(
    pos.avg_price,
    pos.average_price,
    pos.average_entry_price,
    pos.entry_price,
    pos.cost_basis,
  );

  const markPrice = toNum(
    pos.current_price,
    pos.mark_price,
    pos.last_price,
    pos.price,
    pos.bid,
    pos.ask,
  );

  let pnlUsd = toNum(
    pos.unrealized_pnl,
    pos.realized_pnl,
    pos.pnl,
    pos.cash_pnl,
    pos.dollar_pnl,
    pos.payout,
  );

  if (pnlUsd == null && shares != null && avgPrice != null && markPrice != null) {
    pnlUsd = (markPrice - avgPrice) * shares;
  }

  let pnlPct = normalizePct(toNum(
    pos.unrealized_pnl_pct,
    pos.realized_pnl_pct,
    pos.pnl_pct,
    pos.percent_pnl,
    pos.roi,
    pos.return_pct,
  ));

  if (pnlPct == null && avgPrice != null && avgPrice > 0 && markPrice != null) {
    pnlPct = ((markPrice - avgPrice) / avgPrice) * 100;
  }

  const outcome = String(pos.outcome || pos.side || pos.token_outcome || 'Unknown outcome');
  const side = detectSide(outcome, pos.side);
  const lastActivityAt = toIso(
    pos.updated_at,
    pos.updatedAt,
    pos.last_traded_at,
    pos.lastTradedAt,
    pos.timestamp,
    pos.created_at,
    pos.createdAt,
  ) || new Date().toISOString();

  return {
    id: String(pos.id || pos.position_id || pos.asset_id || pos.token_id || `${pos.market_slug || pos.slug || 'position'}_${pos.outcome || 'outcome'}`),
    marketTitle: String(pos.title || pos.market_title || pos.event_title || pos.question || pos.slug || 'Unknown market'),
    outcome,
    side,
    shares,
    avgPrice,
    markPrice,
    pnlUsd,
    pnlPct,
    updatedAt: lastActivityAt,
  };
}

function sortedWeatherPositions(rawPositions) {
  return rawPositions
    .filter(isWeatherPosition)
    .map(mapPosition)
    .sort((a, b) => (b.pnlPct ?? -Infinity) - (a.pnlPct ?? -Infinity));
}

function resolveAccount() {
  if (config.funderAddress) return config.funderAddress;
  try {
    return getAddress();
  } catch {
    return '';
  }
}

function broadcast() {
  const payload = JSON.stringify(getStatusPayload());
  for (const res of monitor.listeners) {
    res.write(`data: ${payload}\n\n`);
  }
}

async function refreshStatusData() {
  if (monitor.running) return;
  monitor.running = true;

  try {
    monitor.account = resolveAccount();
    const positions = await getPolymarketPositions(monitor.account);
    monitor.allPositionsCount = positions.length;
    monitor.weatherPositions = sortedWeatherPositions(positions);
    monitor.lastUpdatedAt = new Date().toISOString();
    monitor.error = null;
  } catch (err) {
    monitor.error = err.message;
    log.warn(`Status refresh failed: ${err.message}`);
  } finally {
    monitor.running = false;
    broadcast();
  }
}

function startPollingIfNeeded() {
  if (monitor.timer || monitor.listeners.size === 0) return;

  monitor.timer = setInterval(() => {
    refreshStatusData().catch((err) => {
      log.warn(`Periodic status refresh failed: ${err.message}`);
    });
  }, STATUS_REFRESH_MS);
}

function stopPollingIfIdle() {
  if (monitor.listeners.size > 0 || !monitor.timer) return;
  clearInterval(monitor.timer);
  monitor.timer = null;
}

export function startStatusMonitor() {
  // Intentionally idle by default. Polling starts only when an SSE client connects.
}

export async function refreshStatusSnapshot() {
  await refreshStatusData();
  return getStatusPayload();
}

export function getStatusPayload() {
  return {
    name: 'polymarket-weather-bet',
    status: 'ok',
    uptimeSeconds: Math.floor(process.uptime()),
    initialized: state.initialized,
    running: state.running,
    lastRunAt: state.lastRunAt,
    lastSummary: state.lastSummary,
    account: monitor.account,
    pollIntervalMs: STATUS_REFRESH_MS,
    positionsFetched: monitor.allPositionsCount,
    positionsShown: monitor.weatherPositions.length,
    lastUpdatedAt: monitor.lastUpdatedAt,
    error: monitor.error,
    positions: monitor.weatherPositions,
  };
}

export function registerStatusStreamClient(res) {
  monitor.listeners.add(res);
  res.write(`retry: 5000\n`);
  res.write(`data: ${JSON.stringify(getStatusPayload())}\n\n`);
  startPollingIfNeeded();
  refreshStatusData().catch((err) => {
    log.warn(`SSE connect refresh failed: ${err.message}`);
  });
}

export function unregisterStatusStreamClient(res) {
  monitor.listeners.delete(res);
  stopPollingIfIdle();
}

export function renderStatusPage() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>polymarket-weather-bet status</title>
  <style>
    :root {
      --bg: #f4f7fb;
      --card: #ffffff;
      --ink: #122033;
      --muted: #6d7c8f;
      --ok: #178f4f;
      --bad: #bf2f45;
      --yes-bg: #e8f8ef;
      --yes-ink: #0e7b43;
      --no-bg: #fdebed;
      --no-ink: #ad233d;
      --na-bg: #e8edf4;
      --na-ink: #4d6179;
      --line: #dce5ef;
    }
    body {
      margin: 0;
      font-family: Menlo, Consolas, Monaco, monospace;
      background: linear-gradient(180deg, #eef4fb 0%, #f9fcff 100%);
      color: var(--ink);
    }
    .wrap {
      max-width: 980px;
      margin: 0 auto;
      padding: 24px 16px 40px;
    }
    .head {
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 16px;
      box-shadow: 0 8px 24px rgba(18, 32, 51, 0.06);
      margin-bottom: 14px;
    }
    .title {
      font-size: 20px;
      margin: 0 0 8px;
      letter-spacing: 0.4px;
    }
    .meta {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 8px;
      font-size: 13px;
    }
    .chip { color: var(--muted); }
    .ok { color: var(--ok); font-weight: 700; }
    .bad { color: var(--bad); font-weight: 700; }
    .table-wrap {
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 14px;
      overflow: hidden;
      box-shadow: 0 8px 24px rgba(18, 32, 51, 0.06);
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    th, td {
      padding: 10px 12px;
      border-bottom: 1px solid var(--line);
      text-align: left;
      vertical-align: top;
    }
    th {
      background: #f8fbff;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.6px;
      color: var(--muted);
    }
    tr:last-child td { border-bottom: none; }
    .num { text-align: right; white-space: nowrap; }
    .pos { color: var(--ok); font-weight: 700; }
    .neg { color: var(--bad); font-weight: 700; }
    .market { max-width: 420px; }
    .market .title-line {
      font-weight: 600;
      margin-bottom: 4px;
      line-height: 1.3;
    }
    .market .sub {
      color: var(--muted);
      font-size: 12px;
    }
    .side-badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.2px;
      margin-right: 6px;
    }
    .side-yes { background: var(--yes-bg); color: var(--yes-ink); }
    .side-no { background: var(--no-bg); color: var(--no-ink); }
    .side-na { background: var(--na-bg); color: var(--na-ink); }
    .pnl-chip {
      display: inline-block;
      border-radius: 999px;
      padding: 2px 8px;
      font-weight: 700;
      font-size: 12px;
    }
    .pnl-gain { background: var(--yes-bg); color: var(--yes-ink); }
    .pnl-loss { background: var(--no-bg); color: var(--no-ink); }
    .pnl-flat { background: var(--na-bg); color: var(--na-ink); }
    .muted { color: var(--muted); }
    @media (max-width: 740px) {
      .hide-sm { display: none; }
      .market { max-width: 220px; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <section class="head">
      <h1 class="title">polymarket-weather-bet /status</h1>
      <div class="meta" id="meta"></div>
    </section>

    <section class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Market</th>
            <th>Outcome</th>
            <th class="num">Shares</th>
            <th class="num hide-sm">Avg</th>
            <th class="num hide-sm">Mark</th>
            <th class="num">PnL $</th>
            <th class="num">PnL %</th>
            <th class="num">Updated</th>
          </tr>
        </thead>
        <tbody id="rows"></tbody>
      </table>
    </section>
  </div>

  <script>
    const meta = document.getElementById('meta');
    const rows = document.getElementById('rows');

    function fmtNum(v, d = 2) {
      return Number.isFinite(v) ? v.toFixed(d) : '-';
    }

    function fmtUsd(v) {
      if (!Number.isFinite(v)) return '-';
      return (v >= 0 ? '+' : '') + '$' + v.toFixed(2);
    }

    function fmtPct(v) {
      if (!Number.isFinite(v)) return '-';
      return (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
    }

    function rowClass(v) {
      if (!Number.isFinite(v)) return 'muted';
      return v >= 0 ? 'pos' : 'neg';
    }

    function chipClass(v) {
      if (!Number.isFinite(v)) return 'pnl-flat';
      if (v > 0) return 'pnl-gain';
      if (v < 0) return 'pnl-loss';
      return 'pnl-flat';
    }

    function sideClass(side) {
      if (side === 'YES') return 'side-yes';
      if (side === 'NO') return 'side-no';
      return 'side-na';
    }

    function escapeHtml(s) {
      return String(s || '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
    }

    function relTime(iso) {
      if (!iso) return '-';
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return '-';
      const diffSec = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
      if (diffSec < 10) return 'just now';
      if (diffSec < 60) return diffSec + 's ago';
      const mins = Math.floor(diffSec / 60);
      if (mins < 60) return mins + 'm ago';
      const hrs = Math.floor(mins / 60);
      if (hrs < 24) return hrs + 'h ago';
      const days = Math.floor(hrs / 24);
      return days + 'd ago';
    }

    function render(payload) {
      const uptimeHours = (payload.uptimeSeconds / 3600).toFixed(2);
      meta.innerHTML =
        '<div><span class="chip">Status:</span> <span class="ok">' + payload.status + '</span></div>' +
        '<div><span class="chip">Uptime:</span> ' + uptimeHours + 'h</div>' +
        '<div><span class="chip">Initialized:</span> ' + payload.initialized + '</div>' +
        '<div><span class="chip">Scheduler Running:</span> ' + payload.running + '</div>' +
        '<div><span class="chip">Account:</span> ' + (payload.account || '-') + '</div>' +
        '<div><span class="chip">Positions Shown:</span> ' + payload.positionsShown + ' / ' + payload.positionsFetched + '</div>' +
        '<div><span class="chip">Last Refresh:</span> ' + (payload.lastUpdatedAt || '-') + '</div>' +
        '<div><span class="chip">Poll:</span> ' + payload.pollIntervalMs + 'ms</div>';

      if (payload.error) {
        meta.innerHTML += '<div><span class="chip">Error:</span> <span class="bad">' + payload.error + '</span></div>';
      }

      const sorted = [...(payload.positions || [])].sort((a, b) => {
        const av = Number.isFinite(a.pnlPct) ? a.pnlPct : -Infinity;
        const bv = Number.isFinite(b.pnlPct) ? b.pnlPct : -Infinity;
        return bv - av;
      });

      if (!sorted.length) {
        rows.innerHTML = '<tr><td colspan="8" class="muted">No weather/temperature positions found.</td></tr>';
        return;
      }

      rows.innerHTML = sorted.map((p) => (
        '<tr>'
        + '<td class="market"><div class="title-line">' + escapeHtml(p.marketTitle) + '</div><div class="sub">token ' + escapeHtml(p.id.slice(0, 12)) + '...</div></td>'
        + '<td><span class="side-badge ' + sideClass(p.side) + '">' + escapeHtml(p.side) + '</span><span>' + escapeHtml(p.outcome) + '</span></td>'
        + '<td class="num">' + fmtNum(p.shares, 2) + '</td>'
        + '<td class="num hide-sm">' + fmtNum(p.avgPrice, 4) + '</td>'
        + '<td class="num hide-sm">' + fmtNum(p.markPrice, 4) + '</td>'
        + '<td class="num ' + rowClass(p.pnlUsd) + '"><span class="pnl-chip ' + chipClass(p.pnlUsd) + '">' + fmtUsd(p.pnlUsd) + '</span></td>'
        + '<td class="num ' + rowClass(p.pnlPct) + '"><span class="pnl-chip ' + chipClass(p.pnlPct) + '">' + fmtPct(p.pnlPct) + '</span></td>'
        + '<td class="num muted">' + relTime(p.updatedAt) + '</td>'
        + '</tr>'
      )).join('');
    }

    const source = new EventSource('/status/stream');
    source.onmessage = (ev) => {
      try { render(JSON.parse(ev.data)); } catch {}
    };
    source.onerror = () => {
      fetch('/status/data').then((r) => r.json()).then(render).catch(() => {});
    };

    fetch('/status/data').then((r) => r.json()).then(render).catch(() => {});
  </script>
</body>
</html>`;
}
