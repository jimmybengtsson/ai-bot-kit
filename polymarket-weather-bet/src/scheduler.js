import { CronJob } from 'cron';
import { config } from './config.js';
import { createLogger } from './logger.js';
import { ensureAllowances, getAddress, getBalance } from './wallet.js';
import { scanForTemperatureEvents } from './skills/eventScanner.js';
import { fetchTemperatureForecastContext } from './skills/weatherFetcher.js';
import { fetchClimateTemperatureContext } from './skills/climateFetcher.js';
import { chooseTemperatureOutcome, validateTemperatureOutcome } from './ai.js';
import { getOpenOrders, getPolymarketPositions, getYesAskPrice, placeYesOrder } from './adapters/clob.js';

const log = createLogger('scheduler');

export const state = {
  initialized: false,
  running: false,
  lastRunAt: null,
  lastSummary: null,
};

let jobs = [];
const portfolioState = {
  running: false,
  lastRunAt: null,
  lastSnapshot: null,
};
const PORTFOLIO_CRON = '*/5 * * * *';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getAccountForQueries() {
  if (config.funderAddress) return config.funderAddress;
  try {
    return getAddress();
  } catch {
    return '';
  }
}

function toNum(...vals) {
  for (const v of vals) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function utcDayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function toOrderDayKey(createdAt) {
  const n = Number(createdAt);
  if (Number.isFinite(n)) {
    const ms = n > 1e12 ? n : n * 1000;
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return '';
    return utcDayKey(d);
  }

  const d = new Date(createdAt);
  if (Number.isNaN(d.getTime())) return '';
  return utcDayKey(d);
}

function extractPosTokenId(position) {
  return String(position?.asset_id || position?.token_id || position?.tokenId || position?.asset || '');
}

function extractOpenOrderTokenId(order) {
  return String(order?.asset_id || order?.token_id || order?.tokenId || '');
}

function extractOpenOrderEventId(order) {
  return String(order?.market || order?.market_id || order?.condition_id || order?.conditionId || '');
}

function positionOpenDayKey(position) {
  const candidates = [
    position?.created_at,
    position?.createdAt,
    position?.opened_at,
    position?.openedAt,
    position?.open_time,
    position?.openTime,
    position?.first_traded_at,
    position?.firstTradeAt,
  ];

  for (const c of candidates) {
    const key = toOrderDayKey(c);
    if (key) return key;
  }

  return '';
}

function countTodaysOpenBuyOrders(openOrders) {
  const today = utcDayKey();
  return (openOrders || []).filter((o) => {
    const side = String(o?.side || '').toUpperCase();
    return side === 'BUY' && toOrderDayKey(o?.created_at) === today;
  }).length;
}

function effectiveDailyPlaced(positions, openOrders) {
  const today = utcDayKey();
  const exposureTokens = new Set();

  for (const p of (positions || [])) {
    if (positionOpenDayKey(p) !== today) continue;
    const token = extractPosTokenId(p);
    if (!token) continue;
    exposureTokens.add(token);
  }

  for (const o of (openOrders || [])) {
    const side = String(o?.side || '').toUpperCase();
    if (side !== 'BUY') continue;
    if (toOrderDayKey(o?.created_at) !== today) continue;
    const token = String(o?.asset_id || o?.token_id || '');
    if (!token) continue;
    exposureTokens.add(token);
  }

  return exposureTokens.size;
}

function canPlaceMoreToday(positions, openOrders) {
  return effectiveDailyPlaced(positions, openOrders) < config.dailyBetSlots;
}

function normalizeText(v) {
  return String(v || '')
    .toLowerCase()
    .replace(/[\u2012\u2013\u2014\u2015]/g, '-')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function matchOutcome(predicted, outcomes) {
  if (!predicted || !Array.isArray(outcomes) || outcomes.length === 0) return null;
  const raw = String(predicted).trim();
  const cleaned = raw.replace(/^\s*(yes|no)\s*[-:–—]\s*/i, '').trim();
  const candidates = [raw, cleaned].filter(Boolean);

  const pool = outcomes.map((o) => ({
    o,
    q: String(o.outcome || ''),
    label: String(o.label || ''),
  }));

  for (const c of candidates) {
    const exact = pool.find((p) => p.q === c || p.label === c);
    if (exact) return exact.o;
  }

  for (const c of candidates) {
    const cNorm = normalizeText(c);
    const hit = pool.find((p) => {
      const qNorm = normalizeText(p.q);
      const lNorm = normalizeText(p.label);
      return qNorm === cNorm
        || lNorm === cNorm
        || qNorm.includes(cNorm)
        || cNorm.includes(qNorm)
        || lNorm.includes(cNorm)
        || cNorm.includes(lNorm);
    });
    if (hit) return hit.o;
  }

  return null;
}

function extractPosEventId(position) {
  return String(position?.event_id || position?.eventId || position?.market_id || position?.condition_id || '');
}

function hasPositionForEvent(event, positions) {
  const tokenSet = new Set((event.outcomes || []).map((o) => String(o.tokenId || '')));
  const eventId = String(event.eventId || '');

  return (positions || []).some((p) => {
    const posToken = extractPosTokenId(p);
    const posEventId = extractPosEventId(p);
    return (posToken && tokenSet.has(posToken)) || (eventId && posEventId && posEventId === eventId);
  });
}

function hasOpenOrderForEvent(event, openOrders) {
  const tokenSet = new Set((event.outcomes || []).map((o) => String(o.tokenId || '')));
  const marketSet = new Set((event.outcomes || []).flatMap((o) => [o.marketId, o.conditionId]).map((v) => String(v || '')).filter(Boolean));
  const eventId = String(event.eventId || '');

  return (openOrders || []).some((o) => {
    const side = String(o?.side || '').toUpperCase();
    if (side !== 'BUY') return false;

    const orderToken = extractOpenOrderTokenId(o);
    const orderEvent = extractOpenOrderEventId(o);
    return (orderToken && tokenSet.has(orderToken))
      || (orderEvent && marketSet.has(orderEvent))
      || (eventId && orderEvent && orderEvent === eventId);
  });
}

function hasExposureForEvent(event, positions, openOrders) {
  return hasPositionForEvent(event, positions) || hasOpenOrderForEvent(event, openOrders);
}

function countUsedSlots(events, positions) {
  let count = 0;
  for (const event of events) {
    if (hasPositionForEvent(event, positions)) count++;
  }
  return count;
}

async function runPortfolioSnapshotJob(trigger = 'cron-5m') {
  if (portfolioState.running) {
    log.info(`Portfolio snapshot already running — skip (${trigger})`);
    return portfolioState.lastSnapshot;
  }

  portfolioState.running = true;
  const startedAt = new Date().toISOString();

  try {
    const account = getAccountForQueries();
    const [balanceUsd, positions, openOrders] = await Promise.all([
      getBalance(),
      getPolymarketPositions(account),
      getOpenOrders(account),
    ]);

    const positionRows = [];
    for (const p of (positions || [])) {
      const tokenId = extractPosTokenId(p);
      const buyPrice = toNum(p.avg_price, p.average_price, p.average_entry_price, p.entry_price, p.cost_basis);
      let currentPrice = toNum(p.current_price, p.mark_price, p.last_price, p.price, p.bid, p.ask);
      if (currentPrice == null && tokenId) {
        currentPrice = await getYesAskPrice(tokenId, null);
      }
      const changePct = (buyPrice != null && buyPrice > 0 && currentPrice != null)
        ? ((currentPrice - buyPrice) / buyPrice) * 100
        : null;
      positionRows.push({
        market: String(p.title || p.market_title || p.event_title || p.question || 'unknown'),
        tokenId,
        side: String(p.side || p.outcome || ''),
        size: toNum(p.shares, p.size, p.position, p.balance, p.amount, p.quantity, p.total_shares),
        buyPrice,
        currentPrice,
        changePct,
      });
    }

    const openOrderRows = [];
    for (const o of (openOrders || [])) {
      const side = String(o?.side || '').toUpperCase();
      const tokenId = String(o?.asset_id || o?.token_id || '');
      const buyPrice = toNum(o?.price);
      let currentPrice = null;
      if (side === 'BUY' && tokenId) {
        currentPrice = await getYesAskPrice(tokenId, null);
      }
      const changePct = (buyPrice != null && buyPrice > 0 && currentPrice != null)
        ? ((currentPrice - buyPrice) / buyPrice) * 100
        : null;
      openOrderRows.push({
        orderId: String(o?.id || ''),
        tokenId,
        side,
        size: toNum(o?.original_size),
        buyPrice,
        currentPrice,
        changePct,
        status: String(o?.status || ''),
        createdAt: o?.created_at || null,
      });
    }

    const snapshot = {
      trigger,
      startedAt,
      finishedAt: new Date().toISOString(),
      balanceUsd,
      positionsCount: positionRows.length,
      openOrdersCount: openOrderRows.length,
      positions: positionRows,
      openOrders: openOrderRows,
    };

    portfolioState.lastRunAt = snapshot.finishedAt;
    portfolioState.lastSnapshot = snapshot;

    log.info(`Portfolio snapshot: balance=$${balanceUsd.toFixed(2)} positions=${positionRows.length} openOrders=${openOrderRows.length}`);
    for (const row of positionRows.slice(0, 12)) {
      const change = row.changePct == null ? 'n/a' : `${row.changePct.toFixed(2)}%`;
      const buy = row.buyPrice == null ? 'n/a' : row.buyPrice;
      const cur = row.currentPrice == null ? 'n/a' : row.currentPrice;
      log.info(`Portfolio position: ${row.market} side=${row.side} size=${row.size ?? 'n/a'} buy=${buy} now=${cur} change=${change}`);
    }
    for (const row of openOrderRows.slice(0, 20)) {
      const change = row.changePct == null ? 'n/a' : `${row.changePct.toFixed(2)}%`;
      const buy = row.buyPrice == null ? 'n/a' : row.buyPrice;
      const cur = row.currentPrice == null ? 'n/a' : row.currentPrice;
      log.info(`Portfolio open-order: id=${row.orderId} side=${row.side} size=${row.size ?? 'n/a'} buy=${buy} now=${cur} change=${change} status=${row.status}`);
    }

    return snapshot;
  } catch (err) {
    log.warn(`Portfolio snapshot failed: ${err.message}`);
    return null;
  } finally {
    portfolioState.running = false;
  }
}

async function buildWeatherContext(event) {
  const forecast = await fetchTemperatureForecastContext(event.location, event.endTime);
  const climate = await fetchClimateTemperatureContext({
    lat: forecast.lat,
    lon: forecast.lon,
    eventEndTime: event.endTime,
    searchTime: new Date(),
  });

  return {
    forecast,
    climate,
    text: `${forecast.text}\n\n${climate.text}`,
  };
}

export async function runDailyTemperatureJob(trigger = 'cron') {
  if (state.running) {
    log.info(`Daily job already running — skip (${trigger})`);
    return state.lastSummary;
  }

  state.running = true;
  const startedAt = new Date().toISOString();
  log.info(`Daily temperature job started (${trigger}) at ${startedAt}`);

  const summary = {
    trigger,
    startedAt,
    eventsFound: 0,
    slotsUsedInitial: 0,
    placedTodayInitial: 0,
    openTodayInitial: 0,
    placed: 0,
    skipped: 0,
    finishedAt: null,
  };

  try {
    const events = await scanForTemperatureEvents({
      windowMinMinutes: config.scanWindowMinHours * 60,
      windowMaxMinutes: config.scanWindowMaxHours * 60,
    });
    summary.eventsFound = events.length;

    if (events.length === 0) {
      log.info('No temperature events in scan window');
      return summary;
    }

    const account = getAccountForQueries();
    let positions = await getPolymarketPositions(account);
    let openOrders = await getOpenOrders(account);
    let slotsUsed = countUsedSlots(events, positions);
    summary.slotsUsedInitial = slotsUsed;
    summary.openTodayInitial = countTodaysOpenBuyOrders(openOrders);
    summary.placedTodayInitial = effectiveDailyPlaced(positions, openOrders);

    if (slotsUsed >= config.dailyBetSlots) {
      log.info(`Slots already full from account positions: ${slotsUsed}/${config.dailyBetSlots}. Skipping loop.`);
      return summary;
    }

    if (!canPlaceMoreToday(positions, openOrders)) {
      log.info(`Daily placed cap already reached today: ${effectiveDailyPlaced(positions, openOrders)}/${config.dailyBetSlots}. Skipping loop.`);
      return summary;
    }

    for (const event of events) {
      positions = await getPolymarketPositions(account);
      openOrders = await getOpenOrders(account);
      slotsUsed = countUsedSlots(events, positions);

      if (slotsUsed >= config.dailyBetSlots) {
        log.info(`Slots filled (${slotsUsed}/${config.dailyBetSlots}) — stopping event loop`);
        break;
      }

      if (!canPlaceMoreToday(positions, openOrders)) {
        log.info(`Daily placed cap reached before next bet: ${effectiveDailyPlaced(positions, openOrders)}/${config.dailyBetSlots}`);
        break;
      }

      // Skip before weather/AI calls when any existing event exposure is already present.
      if (hasExposureForEvent(event, positions, openOrders)) {
        log.info(`Skip event due to existing exposure (position/open order): ${event.title}`);
        summary.skipped++;
        continue;
      }

      if (!event.location) {
        log.info(`Skip event (no location): ${event.title}`);
        summary.skipped++;
        continue;
      }

      log.info(`Analyzing event: ${event.title} | location=${event.location} | resolves=${event.endTime}`);

      const weather = await buildWeatherContext(event);
      const pick = await chooseTemperatureOutcome(event, weather.text);
      if (!pick?.shouldBet || !pick?.selectedOutcome) {
        log.info('AI picker returned no bet for this event');
        summary.skipped++;
        continue;
      }

      const selected = matchOutcome(pick.selectedOutcome, event.outcomes);
      if (!selected?.tokenId) {
        log.warn(`Could not match selected outcome: ${pick.selectedOutcome}`);
        summary.skipped++;
        continue;
      }

      const firstYesPrice = await getYesAskPrice(selected.tokenId, selected.price);
      if (firstYesPrice == null) {
        log.warn('Missing YES price quote — skip');
        summary.skipped++;
        continue;
      }

      if (firstYesPrice > config.yesPriceMax) {
        log.info(`Skip due to YES price ${firstYesPrice.toFixed(3)} > ${config.yesPriceMax}`);
        summary.skipped++;
        continue;
      }

      if (firstYesPrice < config.yesPriceMin) {
        log.info(`Skip due to YES price ${firstYesPrice.toFixed(3)} < ${config.yesPriceMin}`);
        summary.skipped++;
        continue;
      }

      const validation = await validateTemperatureOutcome(event, weather.text, pick);
      if (!validation?.agrees) {
        log.info(`Validator disagreed, skipping event: ${validation?.reasoning || 'no reason'}`);
        summary.skipped++;
        continue;
      }

      const askPrice = await getYesAskPrice(selected.tokenId, firstYesPrice);
      if (askPrice == null) {
        log.warn('Failed to fetch ask price for final order');
        summary.skipped++;
        continue;
      }

      if (askPrice > config.yesPriceMax) {
        log.info(`Skip final order due to YES price ${askPrice.toFixed(3)} > ${config.yesPriceMax}`);
        summary.skipped++;
        continue;
      }

      if (askPrice < config.yesPriceMin) {
        log.info(`Skip final order due to YES price ${askPrice.toFixed(3)} < ${config.yesPriceMin}`);
        summary.skipped++;
        continue;
      }

      if (!canPlaceMoreToday(positions, openOrders)) {
        log.info(`Daily placed cap reached before order post: ${effectiveDailyPlaced(positions, openOrders)}/${config.dailyBetSlots}`);
        break;
      }

      const order = await placeYesOrder({
        tokenId: selected.tokenId,
        askPrice,
        shares: config.fixedShares,
        negRisk: !!selected.negRisk,
        tickSize: selected.tickSize || '0.01',
      });

      if (!order.success) {
        log.warn(`Order failed: ${order.error || 'unknown error'}`);
        summary.skipped++;
        continue;
      }

      summary.placed++;
      slotsUsed++;
      const dailyPlacedNow = effectiveDailyPlaced(positions, openOrders) + 1;
      log.info(
        `BET PLACED: ${event.title} -> ${selected.outcome} YES @${askPrice} shares=${config.fixedShares} slots=${slotsUsed}/${config.dailyBetSlots} dailyPlaced=${dailyPlacedNow}/${config.dailyBetSlots}`,
      );

      if (slotsUsed >= config.dailyBetSlots) break;
      await sleep(1200);
    }

    return summary;
  } catch (err) {
    log.error(`Daily job failed: ${err.message}`);
    summary.error = err.message;
    return summary;
  } finally {
    summary.finishedAt = new Date().toISOString();
    state.lastRunAt = summary.finishedAt;
    state.lastSummary = summary;
    state.running = false;
    log.info(`Daily temperature job finished: found=${summary.eventsFound} placed=${summary.placed} skipped=${summary.skipped}`);
  }
}

export function startScheduler() {
  log.info(`Starting scheduler. Daily scan cron: ${config.dailyScanCron} (UTC)`);
  log.info(`Starting portfolio snapshot cron: ${PORTFOLIO_CRON} (UTC)`);

  jobs.push(new CronJob(
    config.dailyScanCron,
    async () => {
      if (!state.initialized) return;
      void runDailyTemperatureJob('cron');
    },
    null,
    true,
    'UTC',
  ));

  jobs.push(new CronJob(
    PORTFOLIO_CRON,
    async () => {
      if (!state.initialized) return;
      void runPortfolioSnapshotJob('cron-5m');
    },
    null,
    true,
    'UTC',
  ));

  (async () => {
    try {
      await ensureAllowances();
      const bal = await getBalance();
      log.info(`Startup balance: $${bal.toFixed(2)}`);
    } catch (err) {
      log.warn(`Startup checks warning: ${err.message}`);
    }

    state.initialized = true;
    void runPortfolioSnapshotJob('startup');
    await runDailyTemperatureJob('startup');
  })();
}

export function stopScheduler() {
  for (const job of jobs) job.stop();
  jobs = [];
}
