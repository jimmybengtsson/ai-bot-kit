// src/index.js — polymarket-weather-trade server entry point
import express from 'express';
import { config, validateConfig } from './config.js';
import { createLogger } from './logger.js';

const log = createLogger('server');
import { getAddress, getBalance } from './wallet.js';
import { startScheduler, stopScheduler, state, bettingLoop, dailyReport } from './scheduler.js';
import { runHealthChecks } from './health.js';
import { readDailyLog, getActiveBets, getRecentBets, getRecentDailyStats, getDashboardMetrics, closeDb } from './memory.js';
import { riskManager } from './skills/riskManager.js';
import { registerCommands, startPolling, stopPolling, isTelegramConfigured } from './telegram.js';
import { getCurrentExitPrice } from './skills/betExecutor.js';
import { initSettingsStore, getPublicSettingsView, savePublicSettings, getSettingsFilePath } from './settingsStore.js';

const app = express();
app.use(express.json());

function resolveEntryPrice(bet) {
  const direct = Number(bet?.odds_at_bet);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const amount = Number(bet?.amount_usd);
  const shares = Number(bet?.shares);
  if (Number.isFinite(amount) && Number.isFinite(shares) && shares > 0) return amount / shares;
  return 0;
}

function formatTimeLeftHm(eventEnd) {
  if (!eventEnd) return 'n/a';
  const ts = new Date(eventEnd).getTime();
  if (!Number.isFinite(ts)) return 'n/a';
  const mins = Math.max(0, Math.floor((ts - Date.now()) / 60_000));
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

async function buildStatusSnapshot() {
  const wallet = getAddress();
  const uptimeSec = process.uptime();
  const balance = await getBalance().catch(() => null);
  const active = getActiveBets();

  const rows = await Promise.all(active.map(async (bet) => {
    const buy = resolveEntryPrice(bet);
    const shares = Number(bet?.shares) || 0;
    const current = await getCurrentExitPrice(bet.token_id).catch(() => null);
    const effectiveCurrent = Number.isFinite(current) ? current : buy;
    const pnlPct = buy > 0 && Number.isFinite(effectiveCurrent)
      ? ((effectiveCurrent - buy) / buy) * 100
      : null;
    const pnlUsd = Number.isFinite(effectiveCurrent)
      ? (effectiveCurrent - buy) * shares
      : null;

    return {
      id: String(bet?.id || ''),
      title: String(bet?.event_title || 'Event'),
      outcome: String(bet?.predicted_outcome || ''),
      category: String(bet?.category || ''),
      status: String(bet?.status || ''),
      buyPrice: Number.isFinite(buy) ? buy : null,
      currentPrice: Number.isFinite(effectiveCurrent) ? effectiveCurrent : null,
      shares,
      pnlPct,
      pnlUsd,
      timeLeft: formatTimeLeftHm(bet?.event_end),
      eventEnd: bet?.event_end || null,
      tokenId: String(bet?.token_id || ''),
    };
  }));

  rows.sort((a, b) => {
    const pa = Number.isFinite(a.pnlPct) ? a.pnlPct : Number.NEGATIVE_INFINITY;
    const pb = Number.isFinite(b.pnlPct) ? b.pnlPct : Number.NEGATIVE_INFINITY;
    return pb - pa;
  });

  return {
    appName: 'polymarket-weather-trade',
    now: new Date().toISOString(),
    wallet,
    balance,
    uptimeSec,
    lastScan: state.lastScan,
    lastBalance: state.lastBalance,
    count: rows.length,
    positions: rows,
  };
}

// ─── Status ─────────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.json({
    name: 'polymarket-weather-trade',
    version: '1.0.0',
    description: 'Autonomous weather betting bot on Polymarket using OpenWeatherMap data',
    wallet: getAddress(),
    paperTrade: config.paperTrade(),
    uptime: process.uptime(),
    lastScan: state.lastScan,
    lastBalance: state.lastBalance,
  });
});

app.get('/status', (req, res) => {
  res.type('html').send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>polymarket-weather-trade status</title>
  <style>
    body { font-family: ui-sans-serif, -apple-system, Segoe UI, sans-serif; margin: 20px; background: #f6f8fb; color: #0f172a; }
    h1 { margin: 0 0 12px 0; font-size: 22px; }
    .meta { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px; margin-bottom: 14px; }
    .card { background: #fff; border-radius: 10px; padding: 10px 12px; box-shadow: 0 1px 2px rgba(0,0,0,0.07); }
    .sub { color: #64748b; font-size: 12px; }
    table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 10px; overflow: hidden; }
    th, td { padding: 10px 8px; border-bottom: 1px solid #eef2f7; font-size: 13px; text-align: left; }
    th { background: #f1f5f9; font-weight: 600; }
    tr:last-child td { border-bottom: none; }
    .pos { color: #16a34a; font-weight: 600; }
    .neg { color: #dc2626; font-weight: 600; }
  </style>
</head>
<body>
  <h1>polymarket-weather-trade status</h1>
  <div class="meta" id="meta"></div>
  <table>
    <thead>
      <tr>
        <th>Position</th><th>Buy</th><th>Current</th><th>Shares</th><th>PnL %</th><th>PnL $</th><th>Left</th><th>Status</th>
      </tr>
    </thead>
    <tbody id="rows"></tbody>
  </table>
  <script>
    const fmt = (n, d=3) => Number.isFinite(n) ? n.toFixed(d) : 'n/a';
    const fmtPct = (n) => Number.isFinite(n) ? n.toFixed(1) + '%' : 'n/a';
    const fmtUsd = (n) => Number.isFinite(n) ? '$' + n.toFixed(2) : 'n/a';

    function render(s) {
      const upH = (s.uptimeSec / 3600).toFixed(2);
      document.getElementById('meta').innerHTML = [
        ['Now', s.now],
        ['Wallet', s.wallet || 'n/a'],
        ['Balance', Number.isFinite(s.balance) ? '$' + s.balance.toFixed(2) : 'n/a'],
        ['Uptime', upH + 'h'],
        ['Last Scan', s.lastScan || 'never'],
        ['Positions', String(s.count || 0)],
      ].map(([k,v]) => '<div class="card"><div class="sub">'+k+'</div><div>'+v+'</div></div>').join('');

      document.getElementById('rows').innerHTML = (s.positions || []).map((p) => {
        const pctCls = Number.isFinite(p.pnlPct) ? (p.pnlPct >= 0 ? 'pos' : 'neg') : '';
        const usdCls = Number.isFinite(p.pnlUsd) ? (p.pnlUsd >= 0 ? 'pos' : 'neg') : '';
        return '<tr>' +
          '<td><div>' + (p.title || 'Event') + '</div><div class="sub">' + (p.outcome || '') + '</div></td>' +
          '<td>' + fmt(p.buyPrice) + '</td>' +
          '<td>' + fmt(p.currentPrice) + '</td>' +
          '<td>' + fmt(p.shares, 2) + '</td>' +
          '<td class="'+pctCls+'">' + fmtPct(p.pnlPct) + '</td>' +
          '<td class="'+usdCls+'">' + fmtUsd(p.pnlUsd) + '</td>' +
          '<td>' + (p.timeLeft || 'n/a') + '</td>' +
          '<td>' + (p.status || '') + '</td>' +
        '</tr>';
      }).join('');
    }

    const stream = new EventSource('/status/stream');
    stream.onmessage = (ev) => {
      try { render(JSON.parse(ev.data)); } catch {}
    };
    stream.onerror = () => {
      // Browser reconnects automatically for SSE.
    };
  </script>
</body>
</html>`);
});

app.get('/status/stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const sendSnapshot = async () => {
    const snap = await buildStatusSnapshot();
    res.write(`data: ${JSON.stringify(snap)}\n\n`);
  };

  await sendSnapshot().catch(() => {});
  const timer = setInterval(() => {
    sendSnapshot().catch(() => {});
  }, 5000);

  req.on('close', () => {
    clearInterval(timer);
    res.end();
  });
});

app.get('/settings', (req, res) => {
  res.type('html').send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>polymarket-weather-trade settings</title>
  <style>
    body { font-family: ui-sans-serif, -apple-system, Segoe UI, sans-serif; margin: 20px; background: #f6f8fb; color: #0f172a; }
    h1 { margin: 0 0 8px 0; font-size: 22px; }
    p { margin: 0 0 12px 0; color: #475569; }
    .bar { display: flex; gap: 10px; align-items: center; margin-bottom: 12px; }
    .badge { border-radius: 999px; padding: 3px 9px; font-size: 11px; font-weight: 600; }
    .rt { background: #dcfce7; color: #166534; }
    .rs { background: #fef3c7; color: #92400e; }
    .src { background: #e2e8f0; color: #334155; }
    table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 10px; overflow: hidden; }
    th, td { padding: 9px 8px; border-bottom: 1px solid #eef2f7; font-size: 12px; vertical-align: top; text-align: left; }
    th { background: #f1f5f9; font-weight: 600; }
    input { width: 100%; box-sizing: border-box; border: 1px solid #cbd5e1; border-radius: 8px; padding: 7px 8px; font-size: 12px; }
    button { border: none; border-radius: 8px; padding: 9px 12px; background: #0f172a; color: white; font-weight: 600; cursor: pointer; }
    .muted { color: #64748b; font-size: 11px; }
    .ok { color: #166534; }
    .warn { color: #92400e; }
  </style>
</head>
<body>
  <h1>Settings</h1>
  <p>Private keys are excluded. Values use <code>.env</code> by default and switch to file-backed overrides after save.</p>
  <div class="bar">
    <button id="saveBtn">Save Settings</button>
    <div id="status" class="muted">Loading...</div>
  </div>
  <table>
    <thead>
      <tr>
        <th style="width:18%">Variable</th>
        <th style="width:17%">Current Value</th>
        <th style="width:17%">.env Default</th>
        <th style="width:9%">Source</th>
        <th style="width:9%">Apply</th>
        <th>Description</th>
      </tr>
    </thead>
    <tbody id="rows"></tbody>
  </table>

  <script>
    let rows = [];
    const valueMap = {};

    function esc(s) {
      return String(s ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;');
    }

    function applyBadge(mode) {
      if (mode === 'restart') return '<span class="badge rs">restart</span>';
      return '<span class="badge rt">realtime</span>';
    }

    function render(data) {
      rows = data.settings || [];
      const body = document.getElementById('rows');

      body.innerHTML = rows.map((r) => {
        valueMap[r.name] = r.currentValue ?? '';
        return '<tr>' +
          '<td><code>' + esc(r.name) + '</code></td>' +
          '<td><input data-name="' + esc(r.name) + '" value="' + esc(r.currentValue || '') + '" /></td>' +
          '<td><code>' + esc(r.envDefault || '') + '</code></td>' +
          '<td><span class="badge src">' + esc(r.source || 'env') + '</span></td>' +
          '<td>' + applyBadge(r.applies) + '</td>' +
          '<td class="muted">' + esc(r.description || '') + '</td>' +
        '</tr>';
      }).join('');

      document.querySelectorAll('input[data-name]').forEach((el) => {
        el.addEventListener('input', (ev) => {
          valueMap[ev.target.getAttribute('data-name')] = ev.target.value;
        });
      });

      document.getElementById('status').textContent = 'Loaded ' + rows.length + ' settings';
      document.getElementById('status').className = 'muted';
    }

    async function load() {
      const res = await fetch('/settings/data');
      const data = await res.json();
      render(data);
    }

    async function save() {
      const res = await fetch('/settings/data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: valueMap }),
      });
      const out = await res.json();

      if (!res.ok) {
        const details = Array.isArray(out.fieldErrors) && out.fieldErrors.length
          ? ' [' + out.fieldErrors.slice(0, 4).map((e) => e.name + ': ' + e.message).join(' | ') + ']'
          : '';
        document.getElementById('status').textContent = (out.error || 'Save failed') + details;
        document.getElementById('status').className = 'warn';
        return;
      }

      const restartCount = (out.restartRequired || []).length;
      const realtimeCount = (out.realtime || []).length;
      const msg = 'Saved. changed=' + out.changedCount + ', realtime=' + realtimeCount + ', restart=' + restartCount;
      document.getElementById('status').textContent = msg;
      document.getElementById('status').className = restartCount > 0 ? 'warn' : 'ok';
      await load();
    }

    document.getElementById('saveBtn').addEventListener('click', save);
    load().catch((err) => {
      document.getElementById('status').textContent = 'Load failed: ' + err.message;
      document.getElementById('status').className = 'warn';
    });
  </script>
</body>
</html>`);
});

app.get('/settings/data', (req, res) => {
  const settings = getPublicSettingsView();
  res.json({
    settings,
    settingsFile: getSettingsFilePath(),
    count: settings.length,
  });
});

app.post('/settings/data', (req, res) => {
  try {
    const values = req.body?.values;
    if (!values || typeof values !== 'object') {
      return res.status(400).json({ error: 'Body must include { values: { KEY: value } }' });
    }

    const result = savePublicSettings(values);
    return res.json(result);
  } catch (err) {
    if (err?.code === 'VALIDATION_FAILED') {
      return res.status(400).json({
        error: 'One or more settings are invalid',
        fieldErrors: err.fieldErrors || [],
      });
    }
    return res.status(500).json({ error: err.message });
  }
});

app.get('/health', async (req, res) => {
  const health = await runHealthChecks();
  res.status(health.healthy ? 200 : 503).json(health);
});

app.get('/balance', async (req, res) => {
  try {
    const bal = await getBalance();
    res.json({ balance: bal, currency: 'USDC', lowBalance: bal < config.minBalanceWarn });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/bets/active', (req, res) => {
  res.json({ bets: getActiveBets(), count: getActiveBets().length });
});

app.get('/bets/recent', (req, res) => {
  const count = parseInt(req.query.count || '30', 10);
  res.json({ bets: getRecentBets(count), count });
});

app.get('/events', (req, res) => {
  res.json({ events: state.lastEvents, count: state.lastEvents.length, lastScan: state.lastScan });
});

app.get('/risk', (req, res) => {
  res.json(riskManager.getSummary());
});

app.get('/decisions', (req, res) => {
  res.json({ decisions: state.lastDecisions, lastScan: state.lastScan });
});

app.get('/stats', (req, res) => {
  const days = parseInt(req.query.days || '7', 10);
  res.json({ stats: getRecentDailyStats(days) });
});

app.get('/dashboard', (req, res) => {
  res.json(getDashboardMetrics());
});

app.get('/log/today', (req, res) => {
  res.type('text/plain').send(readDailyLog() || 'No entries today.');
});

app.all('/trigger/scan', async (req, res) => {
  log.info(`Manual scan triggered via API (${req.method})`);
  await bettingLoop();
  res.json({ ok: true, message: 'Weather scan complete' });
});

app.post('/trigger/report', async (req, res) => {
  const report = await dailyReport();
  res.type('text/plain').send(report);
});

app.get('/config', (req, res) => {
  res.json({
    model: config.openaiModel,
    paperTrade: config.paperTrade(),
    betAmount: config.betAmountUsd,
    maxActiveBets: config.maxActiveBets,
    minBalanceWarn: config.minBalanceWarn,
    minBalanceStop: config.minBalanceStop,
    risk: config.risk,
    scanCron: config.scanCron,
    scanWindowHours: `${config.scanWindowMinHours}-${config.scanWindowMaxHours}`,
    weatherKeywords: config.weatherKeywords.length,
    owmConfigured: !!config.owmApiKey,
    noaaConfigured: !!config.noaaCdoToken,
  });
});

// ─── Validate config ────────────────────────────────────────────────────────

initSettingsStore();

const configCheck = validateConfig();
for (const w of configCheck.warnings) log.warn(`Config: ${w}`);
if (!configCheck.valid) {
  for (const e of configCheck.errors) log.error(`Config ERROR: ${e}`);
  log.error('Configuration validation failed — fix the above errors and restart');
  process.exit(1);
}

// ─── Start ──────────────────────────────────────────────────────────────────

app.listen(config.port, () => {
  log.info(`polymarket-weather-trade server started on :${config.port} | wallet=${getAddress().slice(0, 10)}... | paper=${config.paperTrade()} | model=${config.openaiModel}`);
  log.info(`Runtime config: bet=$${config.betAmountUsd} maxActive=${config.maxActiveBets} OWM=${config.owmApiKey ? 'set' : 'missing'} NOAA=${config.noaaCdoToken ? 'set' : 'missing'} Telegram=${isTelegramConfigured() ? 'enabled' : 'disabled'} schedule="${config.scanCron}"`);

  startScheduler();

  if (isTelegramConfigured()) {
    log.info('Telegram bot configured — registering commands');

    registerCommands({
      status: async () => {
        const bal = await getBalance().catch(() => null);
        const active = getActiveBets();
        return (
          `<b>polymarket-weather-trade Status</b>\n\n` +
          `Balance: <b>$${bal?.toFixed(2) ?? '?'}</b>\n` +
          `Active bets: ${active.length}/${config.maxActiveBets}\n` +
          `Paper mode: ${config.paperTrade()}\n` +
          `Uptime: ${(process.uptime() / 3600).toFixed(1)}h\n` +
          `Model: ${config.openaiModel}\n` +
          `Last scan: ${state.lastScan || 'Never'}`
        );
      },

      balance: async () => {
        const bal = await getBalance().catch(() => null);
        return `Balance: <b>$${bal?.toFixed(2) ?? 'Error'}</b>`;
      },

      bets: async () => {
        const active = getActiveBets();
        if (active.length === 0) return 'No active bets.';
        const lines = active.map(b =>
          `  - ${b.event_title?.slice(0, 40) || 'Event'} -> <b>${b.predicted_outcome}</b> @${Number(b.odds_at_bet).toFixed(3)} ($${b.amount_usd})`
        );
        return `<b>Active Bets (${active.length})</b>\n\n${lines.join('\n')}`;
      },

      recent: async () => {
        const bets = getRecentBets(10);
        if (bets.length === 0) return 'No recent bets.';
        const lines = bets.map(b => {
          const icon = b.status === 'resolved' ? (b.result === 'won' ? 'W' : 'L') : '?';
          return `[${icon}] ${b.event_title?.slice(0, 35) || 'Event'} -> ${b.predicted_outcome} @${Number(b.odds_at_bet).toFixed(3)}`;
        });
        return `<b>Recent Bets</b>\n\n${lines.join('\n')}`;
      },

      stats: async () => {
        const days = getRecentDailyStats(7);
        if (days.length === 0) return 'No stats yet.';
        const today = days[0];
        const lines = days.map(d =>
          `${d.date}: ${d.bets_placed} bets, W:${d.bets_won} L:${d.bets_lost}, P&amp;L:$${d.total_pnl.toFixed(2)}`
        );
        return (
          `<b>Stats (7 days)</b>\n\n` +
          `Today: ${today.bets_placed} bets, W:${today.bets_won} L:${today.bets_lost}\n` +
          `P&amp;L today: $${today.total_pnl.toFixed(2)}\n\n` +
          `<pre>${lines.join('\n')}</pre>`
        );
      },

      scan: async () => {
        await bettingLoop();
        return `Scan complete.\nEvents: ${state.lastEvents.length}\nDecisions: ${state.lastDecisions.length}`;
      },

      report: async () => {
        const report = await dailyReport();
        return `<b>Daily Report</b>\n\n<pre>${escapeHtml(report)}</pre>`;
      },

      health: async () => {
        const h = await runHealthChecks();
        const lines = h.checks.map(c => `${c.ok ? 'OK' : 'FAIL'} ${c.name}: ${c.detail || 'OK'}`);
        return `<b>Health Check</b>\n\n${lines.join('\n')}`;
      },

      risk: async () => {
        const r = riskManager.getSummary();
        return (
          `<b>Risk Status</b>\n\n` +
          `Low balance: ${r.lowBalance ? 'YES' : 'No'}\n` +
          `Today bets: ${r.todayBetsPlaced ?? 0}/${config.maxDailyBets}\n` +
          `Active bets: ${r.activeBets ?? 0}/${r.maxActive ?? config.maxActiveBets}`
        );
      },

      events: async () => {
        const e = state.lastEvents;
        if (!e || e.length === 0) return 'No weather events from last scan.';
        const lines = e.slice(0, 15).map(ev =>
          `- ${ev.title?.slice(0, 50) || '?'} (${ev.category || '?'})`
        );
        return `<b>Last Scanned Events (${e.length})</b>\n\n${lines.join('\n')}`;
      },

      pnl: async () => {
        const days = getRecentDailyStats(30);
        if (days.length === 0) return 'No P&amp;L data yet.';
        const totalPnl = days.reduce((s, d) => s + d.total_pnl, 0);
        const totalBets = days.reduce((s, d) => s + d.bets_placed, 0);
        const totalWon = days.reduce((s, d) => s + d.bets_won, 0);
        const totalLost = days.reduce((s, d) => s + d.bets_lost, 0);
        const winRate = totalBets > 0 ? ((totalWon / (totalWon + totalLost)) * 100).toFixed(1) : '0';
        return (
          `<b>All-Time P&amp;L (${days.length}d)</b>\n\n` +
          `Total P&amp;L: <b>$${totalPnl.toFixed(2)}</b>\n` +
          `Bets: ${totalBets} (W:${totalWon} L:${totalLost})\n` +
          `Win rate: ${winRate}%`
        );
      },
    });

    startPolling();
    log.info('Telegram bot polling active');
  } else {
    log.info('Telegram not configured — set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID to enable');
  }
});

function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

process.on('SIGTERM', () => {
  log.info('SIGTERM — shutting down');
  stopPolling();
  stopScheduler();
  closeDb();
  process.exit(0);
});

process.on('SIGINT', () => {
  log.info('SIGINT — shutting down');
  stopPolling();
  stopScheduler();
  closeDb();
  process.exit(0);
});
