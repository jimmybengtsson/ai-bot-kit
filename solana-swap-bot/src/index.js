// src/index.js — solana-swap-bot Node.js server entry point
import express from 'express';
import { timingSafeEqual } from 'crypto';
import { config, validateStartupConfig } from './config.js';
import { createLogger } from './logger.js';

const log = createLogger('server');
import { getPublicKey } from './wallet.js';
import {
  startScheduler,
  stopScheduler,
  state,
  tradingLoop,
  portfolioSnapshot,
  memoryFlush,
  dailyReport,
  stalePositionCheck,
  getAllPositions,
} from './scheduler.js';
import { runHealthChecks } from './health.js';
import { readTodayEvents, getRecentTickMetrics } from './runtimeStore.js';
import { riskManager } from './skills/riskManager.js';

const app = express();
app.use(express.json());

function secureEquals(a, b) {
  const aa = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (aa.length !== bb.length) return false;
  return timingSafeEqual(aa, bb);
}

function requireAdminApiKey(req, res, next) {
  const expected = config.serverAdminApiKey;
  if (!expected) {
    return res.status(503).json({
      error: 'Trigger routes disabled',
      message: 'Set SERVER_ADMIN_API_KEY to enable /trigger endpoints.',
    });
  }

  const headerKey = String(req.get('x-admin-key') || '').trim();
  const authHeader = String(req.get('authorization') || '').trim();
  const bearer = authHeader.toLowerCase().startsWith('bearer ')
    ? authHeader.slice(7).trim()
    : '';
  const provided = headerKey || bearer;

  if (!provided || !secureEquals(provided, expected)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  return next();
}

app.use('/trigger', requireAdminApiKey);

// ─── Status ─────────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.json({
    name: 'solana-swap-bot',
    version: '1.0.0',
    wallet: getPublicKey(),
    paperTrade: config.paperTrade(),
    uptime: process.uptime(),
    lastTick: state.lastTick,
  });
});

// ─── Health ─────────────────────────────────────────────────────────────────

app.get('/health', async (req, res) => {
  const health = await runHealthChecks();
  res.status(health.healthy ? 200 : 503).json(health);
});

// ─── Prices ─────────────────────────────────────────────────────────────────

app.get('/prices', (req, res) => {
  res.json({
    prices: state.lastPrices,
    priceChanges: state.lastPriceChanges,
    timestamp: state.lastTick,
  });
});

// ─── Portfolio ──────────────────────────────────────────────────────────────

app.get('/portfolio', (req, res) => {
  res.json(state.lastWallet || { error: 'No data yet' });
});

// ─── Arbitrage ──────────────────────────────────────────────────────────────

app.get('/arbitrage', (req, res) => {
  res.json({ opportunities: state.lastArbitrage, timestamp: state.lastTick });
});

// ─── Tweets ───────────────────────────────────────────────────────────────────────

app.get('/tweets', (req, res) => {
  res.json({ tweets: state.lastTweets || [], count: (state.lastTweets || []).length });
});

// ─── Risk ───────────────────────────────────────────────────────────────────

app.get('/risk', (req, res) => {
  res.json(riskManager.getDailySummary());
});

// ─── Last AI Decision ───────────────────────────────────────────────────────

app.get('/decision', (req, res) => {
  res.json(state.lastDecision || { action: 'none', reasoning: 'No tick yet' });
});

// ─── Positions ──────────────────────────────────────────────────────────────

app.get('/positions', (req, res) => {
  const data = getAllPositions();
  res.json({
    active: data.active,
    resolved: data.resolved,
    totalTracked: data.totalTracked,
    timestamp: new Date().toISOString(),
  });
});

// ─── Memory ─────────────────────────────────────────────────────────────────

app.get('/memory/today', (req, res) => {
  res.type('text/plain').send(readTodayEvents() || 'No entries today.');
});

app.get('/memory/long-term', (req, res) => {
  res.status(410).json({
    error: 'Endpoint removed in stateless mode',
    message: 'Long-term memory persistence was removed with SQLite deprecation.',
  });
});

// ─── Manual Triggers ────────────────────────────────────────────────────────

app.post('/trigger/trade', async (req, res) => {
  await tradingLoop();
  res.json({ ok: true, decision: state.lastDecision });
});

app.post('/trigger/portfolio', async (req, res) => {
  await portfolioSnapshot();
  res.json({ ok: true, wallet: state.lastWallet });
});

app.post('/trigger/memory-flush', async (req, res) => {
  await memoryFlush();
  res.json({ ok: true });
});

app.post('/trigger/daily-report', async (req, res) => {
  await dailyReport();
  res.json({ ok: true });
});

app.post('/trigger/positions-check', async (req, res) => {
  await stalePositionCheck();
  const data = getAllPositions();
  res.json({ ok: true, active: data.active.length, resolved: data.resolved.length, totalTracked: data.totalTracked });
});

// ─── Metrics (9.2 — Decision Quality) ───────────────────────────────────────

app.get('/metrics', (req, res) => {
  const count = Math.min(parseInt(req.query.count) || 50, 500);
  const rows = getRecentTickMetrics(count);
  // Compute aggregates
  const total = rows.length;
  const holds = rows.filter(r => r.action === 'hold').length;
  const trades = rows.filter(r => r.action === 'trade').length;
  const totalArbAvail = rows.reduce((s, r) => s + (r.arb_available || 0), 0);
  const totalArbTaken = rows.reduce((s, r) => s + (r.arb_taken || 0), 0);
  const avgLatency = total ? Math.round(rows.reduce((s, r) => s + (r.latency_ms || 0), 0) / total) : 0;
  res.json({
    ticks: total,
    holdRate: total ? Math.round(holds / total * 100) : 0,
    tradeRate: total ? Math.round(trades / total * 100) : 0,
    arbUtilization: totalArbAvail ? Math.round(totalArbTaken / totalArbAvail * 100) : null,
    avgLatencyMs: avgLatency,
    currentHoldStreak: rows.length ? rows[rows.length - 1].hold_streak : 0,
    recent: rows.slice(-10),
  });
});

// ─── Config (read-only) ────────────────────────────────────────────────────

app.get('/config', (req, res) => {
  res.json({
    model: config.openaiModel,
    paperTrade: config.paperTrade(),
    statelessMode: true,
    scraperServerConfigured: !!config.scraperServerAddress,
    watchedTokens: Object.keys(config.watchedTokens),
    risk: config.risk,
    regime: state.lastRegime || null,
    cronSchedule: {
      tradingLoop: config.cron.tradingLoop,
      portfolio: config.cron.portfolioSnapshot,
      portfolioSnapshot: config.cron.portfolioSnapshot,
      memoryFlush: config.cron.memoryFlush,
      dailyReport: config.cron.dailyReport,
      stalePositionCheck: config.cron.stalePositionCheck,
    },
  });
});

// ─── Start ──────────────────────────────────────────────────────────────────

const startupValidation = validateStartupConfig();
for (const w of startupValidation.warnings) {
  log.warn(`Startup config warning: ${w}`);
}
if (!startupValidation.ok) {
  for (const e of startupValidation.errors) {
    log.error(`Startup config error: ${e}`);
  }
  log.error(`Startup aborted due to invalid configuration (mode=${startupValidation.mode}).`);
  process.exit(1);
}

app.listen(config.port, () => {
  log.info(`
╔══════════════════════════════════════════════╗
║          🦀 solana-swap-bot Node Server      ║
╠══════════════════════════════════════════════╣
║  Port:        ${String(config.port).padEnd(30)}║
║  Wallet:      ${getPublicKey().slice(0, 26)}...  ║
║  Paper mode:  ${String(config.paperTrade()).padEnd(30)}║
║  AI model:    ${config.openaiModel.padEnd(30)}║
╚══════════════════════════════════════════════╝`);

  startScheduler();
});

// Graceful shutdown
process.on('SIGTERM', () => {
  log.info('SIGTERM received — shutting down');
  stopScheduler();
  process.exit(0);
});

process.on('SIGINT', () => {
  log.info('SIGINT received — shutting down');
  stopScheduler();
  process.exit(0);
});
