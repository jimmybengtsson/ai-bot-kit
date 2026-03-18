// src/memory.js — Polymarket-backed in-memory state store (no SQLite)
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { config } from './config.js';
import { createLogger, logDetailedError } from './logger.js';
import { getClobClient } from './wallet.js';
import { fetchMarketQuestionByTokenId, fetchMarketQuestionByOrderRefs } from './adapters/gamma.js';

const log = createLogger('memory');

mkdirSync('logs', { recursive: true });

const WEATHER_CATEGORY_VALUES = new Set([
  'general',
  'temperature',
  'precipitation',
  'snow',
  'tropical',
  'severe',
  'humidity',
  'wind',
  'flooding',
  'climate',
]);

const state = {
  bets: new Map(),
  nextBetId: 1,
  dailyStats: new Map(),
  dailyLogs: new Map(),
  scanLog: [],
  weatherEvents: new Map(),
  oddsHistory: new Map(),
  tokenUsageByDate: new Map(),
  externalPositions: [],
  openOrders: [],
  recentTrades: [],
  refresh: {
    inFlight: null,
    lastAt: 0,
    lastTradesAt: 0,
  },
};

function today() {
  return new Date().toISOString().slice(0, 10);
}

function timeNow() {
  return new Date().toISOString().slice(11, 16);
}

function nowIso() {
  return new Date().toISOString();
}

function toSqliteDateTime(iso = nowIso()) {
  return String(iso).replace('T', ' ').replace('Z', '').slice(0, 19);
}

function toDateMs(value) {
  if (!value) return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1e12 ? value : value * 1000;
  }
  const n = Number(value);
  if (Number.isFinite(n)) {
    return n > 1e12 ? n : n * 1000;
  }
  const ts = new Date(String(value)).getTime();
  if (Number.isFinite(ts)) return ts;
  const tsZ = new Date(`${String(value)}Z`).getTime();
  return Number.isFinite(tsZ) ? tsZ : null;
}

function safeNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function safeBool(v) {
  if (v === null || v === undefined || v === '') return null;
  if (v === true || v === false) return v;
  const text = String(v).trim().toLowerCase();
  if (text === 'true' || text === '1' || text === 'yes') return true;
  if (text === 'false' || text === '0' || text === 'no') return false;
  return null;
}

function normalizeText(v) {
  return String(v || '').toLowerCase();
}

function looksWeatherText(text) {
  const t = normalizeText(text);
  if (!t) return false;
  return config.weatherKeywords.some((kw) => {
    const phrase = String(kw || '').trim().toLowerCase();
    if (!phrase) return false;
    const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    return new RegExp(`\\b${escaped}\\b`, 'i').test(t);
  });
}

function inferWeatherCategory(text) {
  const t = normalizeText(text);
  if (/\btemperature\b|\bdegrees\b|\bfahrenheit\b|\bcelsius\b|\bcold\b|\bhot\b|\bwarm\b|\bfreeze\b|\bfrost\b/i.test(t)) return 'temperature';
  if (/\brain\b|\bprecipitation\b|\brainfall\b/i.test(t)) return 'precipitation';
  if (/\bsnow\b|\bblizzard\b|\bice storm\b|\bsnowfall\b/i.test(t)) return 'snow';
  if (/\bhurricane\b|\btropical storm\b|\bcyclone\b|\btyphoon\b/i.test(t)) return 'tropical';
  if (/\btornado\b|\bhail\b|\bsevere storm\b/i.test(t)) return 'severe';
  if (/\bhumidity\b|\bdew point\b/i.test(t)) return 'humidity';
  if (/\bwind\b|\bgust\b/i.test(t)) return 'wind';
  if (/\bflood\b|\bdrought\b/i.test(t)) return 'flooding';
  if (/\bclimate\b|\bel nino\b|\bla nina\b/i.test(t)) return 'climate';
  return 'general';
}

function isOpenStatus(status) {
  return status === 'pending' || status === 'active' || status === 'placed';
}

function isWeatherCategory(category) {
  return WEATHER_CATEGORY_VALUES.has(String(category || 'general').toLowerCase());
}

function appendDailyLogToFile(date, line) {
  try {
    const path = `logs/daily-${date}.log`;
    appendFileSync(path, `${line}\n`, 'utf8');
  } catch (err) {
    log.warn(`Failed writing daily log file: ${err.message}`);
  }
}

function appendScanToFile(scanEntry) {
  try {
    appendFileSync('logs/scan-log.jsonl', `${JSON.stringify(scanEntry)}\n`, 'utf8');
  } catch (err) {
    log.warn(`Failed writing scan log file: ${err.message}`);
  }
}

function getOrCreateDailyStats(date = today()) {
  if (!state.dailyStats.has(date)) {
    state.dailyStats.set(date, {
      date,
      bets_placed: 0,
      bets_won: 0,
      bets_lost: 0,
      total_wagered: 0,
      total_pnl: 0,
      daily_tokens: 0,
    });
  }
  return state.dailyStats.get(date);
}

function cloneBet(b) {
  return { ...b };
}

function mapExternalPositionToBet(position) {
  const tokenId = position?.asset_id || position?.token_id || position?.tokenId || position?.asset;
  if (!tokenId) return null;

  const title =
    position?.title
    || position?.question
    || position?.market_slug
    || position?.market
    || `External weather position ${String(tokenId).slice(0, 10)}`;
  const outcome = position?.outcome || position?.outcome_name || position?.side || 'YES';
  const shares = Math.abs(safeNum(position?.size) ?? safeNum(position?.shares) ?? safeNum(position?.quantity) ?? 0);
  if (!(shares > 0)) return null;

  const avgPrice = safeNum(position?.avg_price) ?? safeNum(position?.avgPrice) ?? 0.5;
  const amountUsd =
    safeNum(position?.size_usd)
    ?? safeNum(position?.currentValue)
    ?? parseFloat((avgPrice * shares).toFixed(4));
  const combinedText = `${title} ${position?.description || ''} ${position?.market_slug || ''}`;
  if (!looksWeatherText(combinedText)) return null;

  const category = inferWeatherCategory(combinedText);
  const sourceOpenedAt = (
    position?.opened_at
    || position?.open_time
    || position?.created_at
    || position?.createdAt
    || position?.time
    || position?.timestamp
    || null
  );
  const sourceOpenedMs = toDateMs(sourceOpenedAt);
  const placedAt = Number.isFinite(sourceOpenedMs)
    ? toSqliteDateTime(new Date(sourceOpenedMs).toISOString())
    : toSqliteDateTime();
  const marketClosed = safeBool(position?.closed ?? position?.is_closed ?? position?.market_closed);

  return {
    id: `ext_${String(tokenId)}`,
    event_id: String(position?.event_id || position?.eventId || position?.market_id || position?.condition_id || tokenId),
    market_id: String(position?.market_id || position?.market || position?.condition_id || tokenId),
    token_id: String(tokenId),
    category,
    event_title: String(title),
    location: '',
    predicted_outcome: String(outcome),
    odds_at_bet: avgPrice,
    amount_usd: amountUsd,
    shares,
    neg_risk: Boolean(position?.neg_risk ?? position?.negRisk ?? position?.is_neg_risk ?? false) ? 1 : 0,
    tick_size: String(
      position?.orderPriceMinTickSize
      || position?.minimum_tick_size
      || position?.min_tick_size
      || position?.tick_size
      || '0.01',
    ),
    order_id: null,
    status: 'active',
    result: null,
    pnl_usd: 0,
    paper: 0,
    ai_reasoning: 'Synced from Polymarket positions API',
    event_end: position?.end_date || position?.endDate || null,
    market_closed: marketClosed,
    confidence: null,
    ai_edge: null,
    sell_attempts: 0,
    placed_at: placedAt,
    source_opened_at: sourceOpenedAt,
    resolved_at: null,
    created_at: placedAt,
  };
}

function normalizeOrderId(order) {
  return String(order?.id || order?.orderID || order?.orderId || order?.order_id || '');
}

function normalizeOrderTokenId(order) {
  return String(order?.asset_id || order?.token_id || order?.tokenId || order?.asset || '').trim();
}

function normalizeOrderMarketId(order) {
  return String(order?.market || order?.market_id || order?.marketId || order?.condition_id || '').trim();
}

function normalizeOrderSide(order) {
  return String(order?.side || order?.order_side || '').trim().toUpperCase();
}

function toDateKey(value) {
  const ms = toDateMs(value);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString().slice(0, 10);
}

function normalizeEventId(value) {
  const id = String(value || '').trim();
  return id || null;
}

function normalizeOrderCreatedAt(order) {
  return (
    order?.created_at
    || order?.createdAt
    || order?.timestamp
    || order?.time
    || order?.placed_at
    || null
  );
}

function needsTitleBackfill(row) {
  const title = String(row?.event_title || row?.title || '').trim();
  if (!title) return true;
  return title.toLowerCase().startsWith('external weather position ');
}

async function buildOrderQuestionMaps(openOrders = []) {
  const orders = Array.isArray(openOrders) ? openOrders : [];
  const byToken = new Map();
  const byMarket = new Map();

  await Promise.allSettled(
    orders.map(async (order) => {
      const tokenId = normalizeOrderTokenId(order);
      const marketId = normalizeOrderMarketId(order);
      if (!tokenId && !marketId) return;

      try {
        const q = await fetchMarketQuestionByOrderRefs({ tokenId, marketId });
        if (!q) return;
        if (tokenId && !byToken.has(tokenId)) byToken.set(tokenId, q);
        if (marketId && !byMarket.has(marketId)) byMarket.set(marketId, q);
      } catch (err) {
        log.debug(`Market question lookup by order refs failed (token=${tokenId.slice(0, 18)} market=${marketId.slice(0, 18)}): ${err.message}`);
      }
    }),
  );

  return { byToken, byMarket };
}

async function enrichExternalPositionsWithQuestions(positions = [], openOrders = []) {
  const rows = Array.isArray(positions) ? positions.map(cloneBet) : [];
  if (!rows.length) return rows;

  // Requirement: on each 1-minute tick, use user orders + market data as cross-session title source.
  const { byToken, byMarket } = await buildOrderQuestionMaps(openOrders);

  for (const row of rows) {
    if (!needsTitleBackfill(row)) continue;

    const tokenId = String(row?.token_id || '').trim();
    const marketId = String(row?.market_id || '').trim();

    const titleFromOrders = (tokenId && byToken.get(tokenId)) || (marketId && byMarket.get(marketId));
    if (titleFromOrders) {
      row.event_title = titleFromOrders;
      continue;
    }

    // Secondary fallback for positions not currently represented in open orders.
    if (tokenId) {
      try {
        const q = await fetchMarketQuestionByTokenId(tokenId);
        if (q) row.event_title = q;
      } catch (err) {
        log.debug(`Fallback title lookup failed for token ${tokenId.slice(0, 18)}: ${err.message}`);
      }
    }
  }

  return rows;
}

function betEstimatedNotional(bet) {
  const amount = safeNum(bet?.amount_usd);
  if (amount !== null) return amount;
  const odds = safeNum(bet?.odds_at_bet) ?? 0;
  const shares = safeNum(bet?.shares) ?? 1;
  return odds * shares;
}

async function fetchExternalPositions() {
  if (!config.funderAddress) return [];
  const url = new URL(`${config.dataHost}/positions`);
  url.searchParams.set('user', config.funderAddress);

  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`Positions API ${res.status} ${res.statusText}`);
  const data = await res.json();
  if (!Array.isArray(data)) return [];

  return data.map(mapExternalPositionToBet).filter(Boolean);
}

async function fetchOpenOrders() {
  const client = await getClobClient();
  const orders = await client.getOpenOrders();
  return Array.isArray(orders) ? orders : [];
}

async function fetchRecentTrades() {
  const client = await getClobClient();
  const trades = await client.getTrades({}, true);
  return Array.isArray(trades) ? trades : [];
}

function reconcileLocalBetsAgainstExchange() {
  const externalByToken = new Map(
    state.externalPositions.map((p) => [String(p?.token_id || ''), p]).filter(([token]) => !!token),
  );
  const openOrderIds = new Set(state.openOrders.map(normalizeOrderId).filter(Boolean));
  const positionTokenIds = new Set(state.externalPositions.map((p) => String(p.token_id)));

  for (const bet of state.bets.values()) {
    if (!isOpenStatus(bet.status)) continue;

    const tokenId = String(bet.token_id || '');
    const orderId = String(bet.order_id || '');
    const external = externalByToken.get(tokenId);
    if (external) {
      if (external.market_closed !== null && external.market_closed !== undefined) {
        bet.market_closed = external.market_closed;
      }
      if (!bet.event_end && external.event_end) {
        bet.event_end = external.event_end;
      }
    }

    if (orderId && openOrderIds.has(orderId)) {
      bet.status = 'placed';
      continue;
    }

    if (tokenId && positionTokenIds.has(tokenId)) {
      bet.status = 'active';
      continue;
    }

    if (bet.status === 'placed') {
      const placedAtMs = toDateMs(bet.placed_at);
      if (placedAtMs && (Date.now() - placedAtMs) < (config.stalePlacedGraceMinutes * 60_000)) {
        continue;
      }
    }

    if (bet.status !== 'cancelled') {
      bet.status = 'cancelled';
      bet.result = bet.result || 'manual_exit';
      bet.resolved_at = toSqliteDateTime();
    }
  }
}

export async function refreshExchangeState({ force = false, includeTrades = false } = {}) {
  const now = Date.now();
  if (!force && (now - state.refresh.lastAt) < config.exchangeRefreshMinIntervalMs) return;
  if (state.refresh.inFlight) {
    await state.refresh.inFlight;
    return;
  }

  state.refresh.inFlight = (async () => {
    try {
      const [positions, openOrders] = await Promise.all([
        fetchExternalPositions().catch((err) => {
          log.warn(`Positions refresh failed: ${err.message}`);
          return [];
        }),
        fetchOpenOrders().catch((err) => {
          log.warn(`Open-orders refresh failed: ${err.message}`);
          return [];
        }),
      ]);

      state.openOrders = openOrders;
      state.externalPositions = await enrichExternalPositionsWithQuestions(positions, openOrders);

      const shouldRefreshTrades = includeTrades || (now - state.refresh.lastTradesAt) > (5 * 60_000);
      if (shouldRefreshTrades) {
        state.recentTrades = await fetchRecentTrades().catch((err) => {
          log.warn(`Trades refresh failed: ${err.message}`);
          return state.recentTrades;
        });
        state.refresh.lastTradesAt = Date.now();
      }

      reconcileLocalBetsAgainstExchange();
      state.refresh.lastAt = Date.now();
    } finally {
      state.refresh.inFlight = null;
    }
  })();

  await state.refresh.inFlight;
}

// ─── Bet API ────────────────────────────────────────────────────────────────

export function recordBet(bet) {
  try {
    const id = state.nextBetId++;
    const ts = toSqliteDateTime();
    const row = {
      id,
      event_id: bet.eventId,
      market_id: bet.marketId,
      token_id: bet.tokenId,
      category: bet.category || 'general',
      event_title: bet.eventTitle,
      location: bet.location || '',
      predicted_outcome: bet.predictedOutcome,
      odds_at_bet: bet.oddsAtBet,
      amount_usd: bet.amountUsd || bet.oddsAtBet,
      shares: bet.shares || 1,
      neg_risk: bet.negRisk ? 1 : 0,
      tick_size: bet.tickSize || '0.01',
      order_id: bet.orderId || null,
      status: bet.status || 'pending',
      result: null,
      pnl_usd: 0,
      paper: bet.paper ? 1 : 0,
      ai_reasoning: bet.aiReasoning || null,
      event_end: bet.eventEnd || null,
      market_closed: safeBool(bet.marketClosed ?? bet.closed ?? bet.isClosed),
      confidence: bet.confidence ?? null,
      ai_edge: bet.aiEdge ?? null,
      sell_attempts: 0,
      placed_at: ts,
      resolved_at: null,
      created_at: ts,
    };

    state.bets.set(id, row);
    log.info(`Bet recorded: "${String(row.event_title || '').slice(0, 50)}" -> ${row.predicted_outcome} $${Number(row.amount_usd).toFixed(4)} (ID: ${id})`);
    return id;
  } catch (err) {
    logDetailedError(log, 'Failed to record bet', err, {
      eventTitle: bet?.eventTitle || null,
      predictedOutcome: bet?.predictedOutcome || null,
    });
    return null;
  }
}

export function updateBetStatus(betId, status, result = null, pnlUsd = 0) {
  const bet = state.bets.get(Number(betId));
  if (!bet) return;

  bet.status = status;
  bet.result = result;
  bet.pnl_usd = Number(pnlUsd || 0);
  bet.resolved_at = toSqliteDateTime();

  const stats = getOrCreateDailyStats();
  stats.total_pnl += Number(pnlUsd || 0);
  if (status === 'won') stats.bets_won += 1;
  if (status === 'lost') stats.bets_lost += 1;

  log.info(`Bet ${betId} updated: status=${status}, result=${result}, pnl=${pnlUsd}`);
}

export function updateBetOrderId(betId, orderId) {
  const bet = state.bets.get(Number(betId));
  if (!bet) return;
  bet.order_id = orderId || null;
}

export function getActiveBets() {
  const activeLocal = [];
  const localOpenTokenIds = new Set();

  for (const bet of state.bets.values()) {
    if (!isOpenStatus(bet.status)) continue;
    if (!isWeatherCategory(bet.category)) continue;
    activeLocal.push(cloneBet(bet));
    if (bet.token_id) localOpenTokenIds.add(String(bet.token_id));
  }

  const externalOnly = [];
  for (const pos of state.externalPositions) {
    const tokenId = String(pos.token_id || '');
    if (!tokenId) continue;
    if (localOpenTokenIds.has(tokenId)) continue;
    externalOnly.push(cloneBet(pos));
  }

  const all = [...activeLocal, ...externalOnly];
  all.sort((a, b) => {
    const at = toDateMs(a.placed_at) || 0;
    const bt = toDateMs(b.placed_at) || 0;
    return bt - at;
  });
  return all;
}

export function getActiveBetCount() {
  const active = getActiveBets();
  return active.filter((b) => betEstimatedNotional(b) > 0.01).length;
}

export function getEventExposureSnapshot({ eventId = null, eventTokenIds = [], inFlightIntents = [] } = {}) {
  const tokenSet = new Set((Array.isArray(eventTokenIds) ? eventTokenIds : []).map((t) => String(t || '').trim()).filter(Boolean));
  const normalizedEventId = normalizeEventId(eventId);
  const exposures = [];
  const seen = new Set();

  const register = (kind, source, details = {}) => {
    const tokenId = String(details?.tokenId || '').trim() || null;
    const eventRef = normalizeEventId(details?.eventId);
    const key = `${kind}::${source}::${eventRef || ''}::${tokenId || ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    exposures.push({ kind, source, eventId: eventRef, tokenId, details });
  };

  for (const bet of getActiveBets()) {
    const betToken = String(bet?.token_id || '').trim();
    const betEvent = normalizeEventId(bet?.event_id || bet?.market_id);
    const sameToken = betToken && tokenSet.has(betToken);
    const sameEvent = normalizedEventId && betEvent && betEvent === normalizedEventId;
    if (!sameToken && !sameEvent) continue;
    register('active_position', bet?.id ? 'local_or_external_bet' : 'external_position', {
      eventId: betEvent,
      tokenId: betToken,
      status: bet?.status || 'active',
      title: bet?.event_title || null,
    });
  }

  for (const order of (Array.isArray(state.openOrders) ? state.openOrders : [])) {
    const tokenId = normalizeOrderTokenId(order);
    const marketId = normalizeEventId(normalizeOrderMarketId(order));
    const side = normalizeOrderSide(order);
    const sameToken = tokenId && tokenSet.has(tokenId);
    const sameEvent = normalizedEventId && marketId && marketId === normalizedEventId;
    if (!sameToken && !sameEvent) continue;
    register('open_order', 'clob_open_orders', {
      eventId: marketId,
      tokenId,
      side,
      orderId: normalizeOrderId(order) || null,
    });
  }

  for (const intent of (Array.isArray(inFlightIntents) ? inFlightIntents : [])) {
    const tokenId = String(intent?.tokenId || '').trim();
    const intentEventId = normalizeEventId(intent?.eventId || intent?.scope?.split('::')[0] || null);
    const sameToken = tokenId && tokenSet.has(tokenId);
    const sameEvent = normalizedEventId && intentEventId && intentEventId === normalizedEventId;
    if (!sameToken && !sameEvent) continue;
    register('in_flight_intent', 'execution_store', {
      eventId: intentEventId,
      tokenId,
      key: intent?.key || null,
      state: intent?.state || null,
    });
  }

  return {
    hasExposure: exposures.length > 0,
    count: exposures.length,
    reasons: exposures.map((e) => e.kind),
    exposures,
  };
}

export function getDailyUniqueExposureCount({ date = today(), inFlightIntents = [] } = {}) {
  const targetDate = String(date || today()).slice(0, 10);
  const unique = new Set();

  for (const bet of getActiveBets()) {
    const openedDate = toDateKey(bet?.source_opened_at || bet?.placed_at || bet?.created_at);
    if (openedDate !== targetDate) continue;
    const eventId = normalizeEventId(bet?.event_id || bet?.market_id);
    const tokenId = String(bet?.token_id || '').trim();
    if (!eventId && !tokenId) continue;
    unique.add(`${eventId || 'unknown'}::${tokenId || 'unknown'}`);
  }

  for (const order of (Array.isArray(state.openOrders) ? state.openOrders : [])) {
    const side = normalizeOrderSide(order);
    if (side && side !== 'BUY') continue;
    const orderDate = toDateKey(normalizeOrderCreatedAt(order));
    if (orderDate !== targetDate) continue;
    const eventId = normalizeEventId(normalizeOrderMarketId(order));
    const tokenId = normalizeOrderTokenId(order);
    if (!eventId && !tokenId) continue;
    unique.add(`${eventId || 'unknown'}::${tokenId || 'unknown'}`);
  }

  for (const intent of (Array.isArray(inFlightIntents) ? inFlightIntents : [])) {
    const intentDate = toDateKey(intent?.createdAt || intent?.updatedAt);
    if (intentDate !== targetDate) continue;
    const eventId = normalizeEventId(intent?.eventId || intent?.scope?.split('::')[0] || null);
    const tokenId = String(intent?.tokenId || '').trim();
    if (!eventId && !tokenId) continue;
    unique.add(`${eventId || 'unknown'}::${tokenId || 'unknown'}`);
  }

  return unique.size;
}

export function getRecentBets(count = 30) {
  const rows = Array.from(state.bets.values());
  rows.sort((a, b) => Number(b.id) - Number(a.id));
  return rows.slice(0, count).reverse().map(cloneBet);
}

export function hasOpenBetForToken(tokenId) {
  if (!tokenId) return false;
  const target = String(tokenId);
  return getActiveBets().some((b) => String(b.token_id || '') === target);
}

// ─── Daily Stats API ────────────────────────────────────────────────────────

export function getTodayStats() {
  return { ...getOrCreateDailyStats(today()) };
}

export function upsertDailyStats(stats) {
  const date = stats.date || today();
  state.dailyStats.set(date, {
    date,
    bets_placed: Number(stats.bets_placed || 0),
    bets_won: Number(stats.bets_won || 0),
    bets_lost: Number(stats.bets_lost || 0),
    total_wagered: Number(stats.total_wagered || 0),
    total_pnl: Number(stats.total_pnl || 0),
    daily_tokens: Number(stats.daily_tokens || stats.dailyTokens || getOrCreateDailyStats(date).daily_tokens || 0),
  });
}

export function getRecentDailyStats(days = 7) {
  const rows = Array.from(state.dailyStats.values());
  rows.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return rows.slice(0, days).reverse().map((r) => ({ ...r }));
}

// ─── Category Concentration ─────────────────────────────────────────────────

export function getActiveCategoryCounts() {
  const counts = {};
  for (const bet of getActiveBets()) {
    const key = String(bet.category || 'general');
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

// ─── Token Tracking ─────────────────────────────────────────────────────────

export function recordTokenUsage(tokens) {
  const date = today();
  const n = Number(tokens || 0);
  if (!Number.isFinite(n) || n <= 0) return;

  const prev = state.tokenUsageByDate.get(date) || 0;
  const next = prev + n;
  state.tokenUsageByDate.set(date, next);

  const ds = getOrCreateDailyStats(date);
  ds.daily_tokens = next;
}

export function getTodayTokenUsage() {
  return state.tokenUsageByDate.get(today()) || 0;
}

// ─── AI Accuracy Summary ────────────────────────────────────────────────────

export function getAIAccuracySummary(category = null, limit = 20) {
  const resolved = Array.from(state.bets.values())
    .filter((b) => b.status === 'won' || b.status === 'lost' || (b.resolved_at && (b.result === 'won' || b.result === 'lost' || b.result === 'sold_profit')))
    .sort((a, b) => (toDateMs(b.resolved_at) || 0) - (toDateMs(a.resolved_at) || 0))
    .slice(0, limit);

  if (resolved.length === 0) return '';

  const isWin = (b) => b.result === 'won' || b.result === 'sold_profit' || b.status === 'won';
  const isLoss = (b) => b.result === 'lost' || b.status === 'lost';
  const pct = (w, t) => (t > 0 ? `${((w / t) * 100).toFixed(0)}%` : 'N/A');

  const overallWins = resolved.filter(isWin).length;
  const overallLosses = resolved.filter(isLoss).length;
  const lines = [`Last ${resolved.length} picks: ${overallWins}W-${overallLosses}L (${pct(overallWins, overallWins + overallLosses)})`];

  const highConfidence = Array.from(state.bets.values()).filter((b) => (
    (b.status === 'won' || b.status === 'lost' || b.result === 'won' || b.result === 'lost' || b.result === 'sold_profit')
    && Number(b.confidence) >= 80
  ));
  if (highConfidence.length > 0) {
    const w = highConfidence.filter(isWin).length;
    const l = highConfidence.filter(isLoss).length;
    lines.push(`High-confidence (>=80%): ${w}W-${l}L (${pct(w, w + l)})`);
  }

  if (category) {
    const catRows = Array.from(state.bets.values()).filter((b) => (
      String(b.category || '') === String(category)
      && (b.status === 'won' || b.status === 'lost' || b.result === 'won' || b.result === 'lost' || b.result === 'sold_profit')
    ));
    if (catRows.length > 0) {
      const w = catRows.filter(isWin).length;
      const l = catRows.filter(isLoss).length;
      lines.push(`${category} picks: ${w}W-${l}L (${pct(w, w + l)})`);
    }
  }

  return lines.join('\n');
}

// ─── Daily Log ──────────────────────────────────────────────────────────────

export function appendDailyLog(message) {
  const date = today();
  const line = `${timeNow()} - ${message}`;
  if (!state.dailyLogs.has(date)) state.dailyLogs.set(date, []);
  state.dailyLogs.get(date).push(line);
  appendDailyLogToFile(date, line);
}

export function readDailyLog() {
  const date = today();
  const inMemory = state.dailyLogs.get(date);
  if (Array.isArray(inMemory) && inMemory.length > 0) {
    return inMemory.join('\n');
  }

  const path = `logs/daily-${date}.log`;
  if (!existsSync(path)) return '';
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return '';
  }
}

// ─── Scan Log ───────────────────────────────────────────────────────────────

export function recordScan(eventsFound, betsPlaced, details = '') {
  const scan = {
    scan_time: nowIso(),
    events_found: Number(eventsFound || 0),
    bets_placed: Number(betsPlaced || 0),
    details: String(details || ''),
  };
  state.scanLog.push(scan);
  if (state.scanLog.length > 1000) state.scanLog.shift();
  appendScanToFile(scan);
}

// ─── Cooldown API ───────────────────────────────────────────────────────────
// ─── Stale Bet Recovery ─────────────────────────────────────────────────────

export function incrementSellAttempts(betId) {
  const bet = state.bets.get(Number(betId));
  if (!bet) return 0;
  bet.sell_attempts = Number(bet.sell_attempts || 0) + 1;
  return bet.sell_attempts;
}

export function getStalePlacedBets() {
  const now = Date.now();
  const rows = [];
  for (const bet of state.bets.values()) {
    if (bet.status !== 'placed') continue;
    const placedAtMs = toDateMs(bet.placed_at);
    if (!placedAtMs || (now - placedAtMs) < 4 * 3600_000) continue;
    if (!bet.event_end) continue;
    const endMs = toDateMs(bet.event_end);
    if (!endMs || endMs >= now) continue;
    rows.push(cloneBet(bet));
  }
  rows.sort((a, b) => (toDateMs(a.placed_at) || 0) - (toDateMs(b.placed_at) || 0));
  return rows;
}

// ─── Weather Events API ─────────────────────────────────────────────────────

export function saveWeatherEvent(event) {
  if (!event?.eventId) return false;
  if (state.weatherEvents.has(String(event.eventId))) return false;
  state.weatherEvents.set(String(event.eventId), {
    event_id: String(event.eventId),
    title: String(event.title || ''),
    category: String(event.category || 'general'),
    location: String(event.location || ''),
    end_time: event.endTime || null,
    outcomes: Array.isArray(event.outcomes) ? event.outcomes : [],
    status: 'pending',
    analyzed_at: null,
    created_at: toSqliteDateTime(),
  });
  return true;
}

export function updateWeatherEventStatus(eventId, status) {
  const key = String(eventId || '');
  const row = state.weatherEvents.get(key);
  if (!row) return;
  row.status = status;
  row.analyzed_at = toSqliteDateTime();
}

export function expireOldWeatherEvents() {
  const now = Date.now();
  let changed = 0;
  for (const row of state.weatherEvents.values()) {
    if (row.status !== 'pending') continue;
    const end = toDateMs(row.end_time);
    if (!end || end > now) continue;
    row.status = 'expired';
    row.analyzed_at = toSqliteDateTime();
    changed += 1;
  }
  if (changed > 0) {
    log.info(`Expired ${changed} past weather event(s)`);
  }
}

// ─── Odds Snapshots ─────────────────────────────────────────────────────────

export function recordOddsSnapshot(eventId, outcomes) {
  const nowTs = toSqliteDateTime();
  for (const item of (Array.isArray(outcomes) ? outcomes : [])) {
    const tokenId = item?.tokenId;
    const outcome = item?.outcome;
    const price = Number(item?.price);
    if (!tokenId || !outcome || !Number.isFinite(price) || price <= 0) continue;

    const key = `${eventId}::${String(outcome)}`;
    if (!state.oddsHistory.has(key)) state.oddsHistory.set(key, []);
    state.oddsHistory.get(key).push({
      token_id: String(tokenId),
      event_id: String(eventId),
      outcome: String(outcome),
      price,
      snapshot_at: nowTs,
    });
  }
}

export function getOddsHistory(eventId, outcome) {
  const key = `${eventId}::${String(outcome)}`;
  const rows = state.oddsHistory.get(key) || [];
  return rows.map((r) => ({ price: r.price, snapshot_at: r.snapshot_at }));
}

export function formatOddsMovementForAI(eventId, outcomes) {
  const lines = [];
  for (const { outcome, price: currentPrice } of (Array.isArray(outcomes) ? outcomes : [])) {
    const history = getOddsHistory(eventId, outcome);
    if (history.length < 2) continue;

    const opening = history[0];
    const pctChange = ((currentPrice - opening.price) / opening.price * 100).toFixed(1);
    const direction = currentPrice > opening.price ? 'UP' : currentPrice < opening.price ? 'DOWN' : 'FLAT';
    const openDate = opening.snapshot_at?.slice(0, 16) || '?';

    let line = `  ${outcome}: opened ${opening.price.toFixed(3)} (${openDate}) -> now ${currentPrice.toFixed(3)} (${direction} ${pctChange}%)`;

    const sixHoursAgo = Date.now() - 6 * 3600_000;
    const recentSnapshots = history.filter((h) => {
      const ts = toDateMs(h.snapshot_at);
      return ts && ts >= sixHoursAgo;
    });
    if (recentSnapshots.length >= 2) {
      const recentPct = ((currentPrice - recentSnapshots[0].price) / recentSnapshots[0].price * 100).toFixed(1);
      line += ` | last 6h: ${recentPct > 0 ? '+' : ''}${recentPct}%`;
    }

    lines.push(line);
  }

  if (lines.length === 0) return '';
  return `HISTORICAL ODDS MOVEMENT:\n${lines.join('\n')}`;
}

export function getEventVolatilitySummary(eventId, outcomes, { shortWindowMs = 60 * 60_000, mediumWindowMs = 6 * 60 * 60_000 } = {}) {
  const eventKey = String(eventId || '').trim();
  const rows = Array.isArray(outcomes) ? outcomes : [];
  let maxAbsMoveShortPct = 0;
  let maxAbsMoveMediumPct = 0;
  let sampledOutcomes = 0;
  const now = Date.now();

  const computeMovePct = (historyRows, windowMs, currentPrice) => {
    const recent = historyRows.filter((h) => {
      const ts = toDateMs(h?.snapshot_at);
      return Number.isFinite(ts) && ts >= (now - windowMs);
    });
    if (recent.length < 2) return null;
    const baseline = Number(recent[0]?.price);
    if (!Number.isFinite(baseline) || baseline <= 0 || !Number.isFinite(currentPrice) || currentPrice <= 0) return null;
    return Math.abs((currentPrice - baseline) / baseline) * 100;
  };

  for (const outcome of rows) {
    const outcomeName = String(outcome?.outcome || '').trim();
    const currentPrice = Number(outcome?.price);
    if (!eventKey || !outcomeName || !Number.isFinite(currentPrice) || currentPrice <= 0) continue;

    const key = `${eventKey}::${outcomeName}`;
    const history = state.oddsHistory.get(key) || [];
    if (!Array.isArray(history) || history.length < 2) continue;

    sampledOutcomes += 1;
    const shortPct = computeMovePct(history, shortWindowMs, currentPrice);
    const mediumPct = computeMovePct(history, mediumWindowMs, currentPrice);
    if (Number.isFinite(shortPct)) maxAbsMoveShortPct = Math.max(maxAbsMoveShortPct, shortPct);
    if (Number.isFinite(mediumPct)) maxAbsMoveMediumPct = Math.max(maxAbsMoveMediumPct, mediumPct);
  }

  return {
    eventId: eventKey,
    sampledOutcomes,
    maxAbsMoveShortPct,
    maxAbsMoveMediumPct,
    eventVolatilityPct: Math.max(maxAbsMoveShortPct, maxAbsMoveMediumPct),
  };
}

export function pruneOldOddsSnapshots() {
  const cutoff = Date.now() - 7 * 24 * 3600_000;
  let removed = 0;

  for (const [key, rows] of state.oddsHistory.entries()) {
    const next = rows.filter((row) => {
      const ts = toDateMs(row.snapshot_at);
      return ts && ts >= cutoff;
    });
    removed += Math.max(0, rows.length - next.length);
    if (next.length > 0) state.oddsHistory.set(key, next);
    else state.oddsHistory.delete(key);
  }

  if (removed > 0) {
    log.info(`Pruned ${removed} old odds snapshots`);
  }
}

// ─── Close ──────────────────────────────────────────────────────────────────

export function closeDb() {
  log.info('No DB in use (Polymarket-backed state)');
}

// ─── Dashboard Metrics ──────────────────────────────────────────────────────

function getResolvedBets() {
  return Array.from(state.bets.values()).filter((b) => (
    b.status === 'won'
    || b.status === 'lost'
    || b.result === 'won'
    || b.result === 'lost'
    || b.result === 'sold_profit'
  ));
}

export function getDashboardMetrics() {
  const resolved = getResolvedBets();
  const metrics = {};

  const wins = resolved.filter((b) => b.result === 'won' || b.result === 'sold_profit' || b.status === 'won');
  const losses = resolved.filter((b) => b.result === 'lost' || b.status === 'lost');

  const totalWagered = resolved.reduce((sum, b) => sum + Number(b.amount_usd || 0), 0);
  const totalPnl = resolved.reduce((sum, b) => sum + Number(b.pnl_usd || 0), 0);

  metrics.allTime = {
    totalBets: resolved.length,
    wins: wins.length,
    losses: losses.length,
    winRate: (wins.length + losses.length) > 0 ? (wins.length / (wins.length + losses.length)) * 100 : 0,
    totalWagered,
    totalPnl,
    roi: totalWagered > 0 ? (totalPnl / totalWagered) * 100 : 0,
    avgBetSize: resolved.length > 0 ? totalWagered / resolved.length : 0,
    firstBet: resolved.length > 0 ? resolved[0].placed_at : null,
    lastBet: resolved.length > 0 ? resolved[resolved.length - 1].placed_at : null,
  };

  const sevenDaysAgo = Date.now() - 7 * 24 * 3600_000;
  const recent = resolved.filter((b) => {
    const ts = toDateMs(b.placed_at);
    return ts && ts >= sevenDaysAgo;
  });
  const recentWins = recent.filter((b) => b.result === 'won' || b.result === 'sold_profit' || b.status === 'won').length;
  const recentLosses = recent.filter((b) => b.result === 'lost' || b.status === 'lost').length;

  metrics.last7days = {
    totalBets: recent.length,
    wins: recentWins,
    losses: recentLosses,
    winRate: (recentWins + recentLosses) > 0 ? (recentWins / (recentWins + recentLosses)) * 100 : 0,
    totalWagered: recent.reduce((sum, b) => sum + Number(b.amount_usd || 0), 0),
    totalPnl: recent.reduce((sum, b) => sum + Number(b.pnl_usd || 0), 0),
  };

  const byCategoryMap = new Map();
  for (const b of resolved) {
    const key = String(b.category || 'general');
    if (!byCategoryMap.has(key)) {
      byCategoryMap.set(key, { category: key, totalBets: 0, wins: 0, losses: 0, totalPnl: 0 });
    }
    const row = byCategoryMap.get(key);
    row.totalBets += 1;
    if (b.result === 'won' || b.result === 'sold_profit' || b.status === 'won') row.wins += 1;
    if (b.result === 'lost' || b.status === 'lost') row.losses += 1;
    row.totalPnl += Number(b.pnl_usd || 0);
  }

  metrics.byCategory = Array.from(byCategoryMap.values()).map((c) => ({
    ...c,
    winRate: (c.wins + c.losses) > 0 ? (c.wins / (c.wins + c.losses)) * 100 : 0,
  })).sort((a, b) => b.totalPnl - a.totalPnl);

  const buckets = [
    { key: '<20%', min: 0, max: 0.2 },
    { key: '20-40%', min: 0.2, max: 0.4 },
    { key: '40-60%', min: 0.4, max: 0.6 },
    { key: '60-80%', min: 0.6, max: 0.8 },
    { key: '80%+', min: 0.8, max: 1.001 },
  ];

  metrics.calibration = buckets.map((bucket) => {
    const rows = resolved.filter((b) => {
      const odds = Number(b.odds_at_bet || 0);
      return odds >= bucket.min && odds < bucket.max;
    });
    const w = rows.filter((b) => b.result === 'won' || b.result === 'sold_profit' || b.status === 'won').length;
    const l = rows.filter((b) => b.result === 'lost' || b.status === 'lost').length;
    const avgOdds = rows.length > 0 ? rows.reduce((s, b) => s + Number(b.odds_at_bet || 0), 0) / rows.length : 0;
    return {
      oddsBucket: bucket.key,
      totalBets: rows.length,
      wins: w,
      losses: l,
      actualWinRate: (w + l) > 0 ? (w / (w + l)) * 100 : 0,
      impliedProbability: avgOdds * 100,
      totalPnl: rows.reduce((s, b) => s + Number(b.pnl_usd || 0), 0),
    };
  });

  return metrics;
}
