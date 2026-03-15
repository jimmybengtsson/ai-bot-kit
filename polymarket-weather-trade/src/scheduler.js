// src/scheduler.js — Core orchestration: scan weather events -> OWM -> AI -> bet pipeline
import { CronJob } from 'cron';
import { config } from './config.js';
import { createLogger, emitEvent, logDetailedError } from './logger.js';
import { getBalance, ensureAllowances } from './wallet.js';
import { runHealthChecks } from './health.js';
import { scanForWeatherEvents } from './skills/eventScanner.js';
import { fetchWeatherData, formatWeatherDataForAI } from './skills/weatherFetcher.js';
import { fetchClimateData, formatClimateDataForAI } from './skills/climateFetcher.js';
import { analyzeWeatherEvent } from './ai.js';
import { placeBet, checkBetStatuses, getPriceHistory, getPolymarketOpenOrders, getCurrentExitPrice, getCurrentEntryPrice, getDynamicTakeProfitPct } from './skills/betExecutor.js';
import { cancelPolymarketOrder } from './adapters/clob.js';
import { riskManager } from './skills/riskManager.js';
import { notify } from './telegram.js';
import { startRealtimeMonitor, stopRealtimeMonitor, syncRealtimeSubscriptions } from './realtimeMonitor.js';
import {
  recordBet, updateBetStatus, updateBetOrderId, getActiveBets,
  getActiveBetCount, getRecentBets, hasOpenBetForToken, getTodayStats,
  upsertDailyStats, appendDailyLog, recordScan,
  getRecentDailyStats, incrementSellAttempts, getStalePlacedBets,
  recordOddsSnapshot, formatOddsMovementForAI, pruneOldOddsSnapshots,
  recordTokenUsage, getTodayTokenUsage, getAIAccuracySummary,
  saveWeatherEvent, updateWeatherEventStatus, expireOldWeatherEvents,
  refreshExchangeState,
} from './memory.js';

const log = createLogger('scheduler');

// ─── Validation ─────────────────────────────────────────────────────────────

function validateEvent(e) {
  if (!e.title) return { valid: false, reason: 'missing title' };
  if (!Array.isArray(e.outcomes) || e.outcomes.length === 0) {
    return { valid: false, reason: 'no outcomes' };
  }
  const hasValidOutcome = e.outcomes.some(o => o.tokenId && typeof o.price === 'number' && o.price > 0);
  if (!hasValidOutcome) return { valid: false, reason: 'no outcome with tokenId & price > 0' };
  return { valid: true };
}

/**
 * Match AI's predictedOutcome to available market outcomes.
 */
function matchOutcome(predicted, outcomes) {
  if (!predicted || !outcomes?.length) return null;
  const raw = predicted.trim();

  // Normalize side-prefixed AI strings like:
  // "YES - Will ...", "NO: ...", "YES — ..."
  const withoutSidePrefix = raw.replace(/^\s*(yes|no)\s*[-:–—]\s*/i, '').trim();
  const pCandidates = [raw, withoutSidePrefix].filter(Boolean);

  const norm = (s) => String(s || '')
    .toLowerCase()
    .replace(/[\u2012\u2013\u2014\u2015]/g, '-') // normalize dashes
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const candidateNorms = pCandidates.map(norm).filter(Boolean);

  // Compare against both the full market question and the cleaner label/bucket.
  const outcomeTexts = outcomes.map((o) => ({
    o,
    text: String(o.outcome || ''),
    label: String(o.label || ''),
  }));

  // Exact match
  for (const p of pCandidates) {
    const exact = outcomeTexts.find((x) => x.text === p || x.label === p);
    if (exact) return exact.o;
  }

  // Case-insensitive
  for (const p of pCandidates) {
    const pLower = p.toLowerCase();
    const ciExact = outcomeTexts.find((x) => x.text.toLowerCase() === pLower || x.label.toLowerCase() === pLower);
    if (ciExact) return ciExact.o;
  }

  // Yes/No alias matching
  const yesAliases = new Set(['yes', 'over', 'above', 'true']);
  const noAliases = new Set(['no', 'under', 'below', 'false']);
  if (pCandidates.some((p) => yesAliases.has(p.toLowerCase()))) {
    const yesOutcome = outcomes.find(o => yesAliases.has((o.outcome || '').toLowerCase()));
    if (yesOutcome) return yesOutcome;
  }
  if (pCandidates.some((p) => noAliases.has(p.toLowerCase()))) {
    const noOutcome = outcomes.find(o => noAliases.has((o.outcome || '').toLowerCase()));
    if (noOutcome) return noOutcome;
  }

  // Normalized exact match against outcome and label.
  for (const pNorm of candidateNorms) {
    const normalizedExact = outcomeTexts.find((x) => norm(x.text) === pNorm || norm(x.label) === pNorm);
    if (normalizedExact) return normalizedExact.o;
  }

  // Normalized contains match against outcome and label.
  for (const pNorm of candidateNorms) {
    const normalizedContains = outcomeTexts.find((x) => {
      const textNorm = norm(x.text);
      const labelNorm = norm(x.label);
      return textNorm.includes(pNorm) || pNorm.includes(textNorm) || labelNorm.includes(pNorm) || pNorm.includes(labelNorm);
    });
    if (normalizedContains) return normalizedContains.o;
  }

  return null;
}

function normalizeEventSignature(event) {
  const title = String(event?.title || '').trim().toLowerCase();
  const endTime = String(event?.endTime || '').trim();
  const tokenIds = (event?.outcomes || [])
    .map((o) => String(o?.tokenId || '').trim())
    .filter(Boolean)
    .sort()
    .join('|');
  return `${title}::${endTime}::${tokenIds}`;
}

function hasAnyOpenPositionForEvent(event) {
  return (event?.outcomes || []).some((o) => o?.tokenId && hasOpenBetForToken(o.tokenId));
}

// ─── Shared State ───────────────────────────────────────────────────────────

export const state = {
  initialized: false,
  lastTick: null,
  lastScan: null,
  lastEvents: [],
  lastDecisions: [],
  lastBalance: null,
  scanning: false,
  staleCancelRunning: false,
  statusTickRunning: false,
  statusTickPending: false,
  statusTickPendingForceRefresh: false,
  statusTickPendingReasons: new Set(),
  statusTickQueuedCount: 0,
};

const ANALYSIS_TIMEOUT_MS = 10 * 60_000;
const ORDER_CANCEL_STALE_MINUTES = 10;
const THROTTLE_NO_ACTIVE_MS = 15 * 60_000;
const THROTTLE_ORDER_SUMMARY_MS = 5 * 60_000;
const STATUS_FALLBACK_CRON = '*/10 * * * *';

const throttledInfoState = new Map();

function infoThrottled(key, message, intervalMs) {
  const now = Date.now();
  const last = throttledInfoState.get(key) || 0;
  if (now - last < intervalMs) return;
  throttledInfoState.set(key, now);
  log.info(message);
}

let cronJobs = [];

// ─── Weather Event Scan & Bet Pipeline ──────────────────────────────────────

/**
 * Main scan loop: discovers weather events, fetches weather data, sends to AI,
 * places bets. Runs every 2 hours.
 *
 * For each weather event (sequentially):
 *   1. Fetch OpenWeatherMap forecast for the event location
 *   2. Send weather data + Polymarket data to AI
 *   3. Place bet if AI recommends
 *   4. ABORT loop if all active trading slots are full
 */
export async function weatherScan() {
  if (state.scanning) {
    log.info('Scan already in progress — skipping');
    return;
  }

  state.scanning = true;
  const scanStart = Date.now();

  log.info(`Weather scan started @ ${new Date().toISOString()}`);

  let eventsFound = 0;
  let betsPlaced = 0;
  const decisions = [];

  try {
    await refreshExchangeState();

    // Expire old events
    expireOldWeatherEvents();

    // Health check
    const health = await runHealthChecks();
    if (!health.healthy) {
      const failed = health.checks.filter(c => !c.ok).map(c => `${c.name}: ${c.detail}`);
      log.error(`Health check failed: ${failed.join(', ')} — aborting scan`);
      appendDailyLog(`SCAN ABORTED: health check failed — ${failed.join(', ')}`);
      return;
    }

    // Balance check
    const balance = await getBalance();
    state.lastBalance = balance;
    riskManager.setBalance(balance);
    if (balance < config.minBalanceStop) {
      log.error(`Balance critical: $${balance.toFixed(2)} — aborting scan`);
      appendDailyLog(`SCAN ABORTED: balance $${balance.toFixed(2)} below minimum`);
      return;
    }

    // Keep discovery running even when all slots are full so scan visibility remains accurate.
    const activeCount = getActiveBetCount();
    if (activeCount >= config.maxActiveBets) {
      log.info(`Active bets ${activeCount}/${config.maxActiveBets} (max reached) — scanning events but will skip new placements`);
      appendDailyLog(`SCAN LIMITED: active bets ${activeCount}/${config.maxActiveBets} (discovery only)`);
    }

    // Scan Polymarket for weather events resolving within the scan window.
    // Retry once if zero events are returned to handle transient upstream empties.
    log.info(`Scanning Polymarket for weather events (${config.scanWindowMinHours}-${config.scanWindowMaxHours}h ahead)...`);
    const scanArgs = {
      windowMinMinutes: config.scanWindowMinHours * 60,
      windowMaxMinutes: config.scanWindowMaxHours * 60,
    };

    let allEvents = await scanForWeatherEvents(scanArgs);
    eventsFound = allEvents.length;
    log.info(`Found ${eventsFound} weather events`);

    if (eventsFound === 0) {
      const retryDelayMs = 10_000;
      log.info(`No events found on first attempt — retrying scan in ${Math.round(retryDelayMs / 1000)}s...`);
      await sleep(retryDelayMs);
      allEvents = await scanForWeatherEvents(scanArgs);
      eventsFound = allEvents.length;
      log.info(`Retry scan found ${eventsFound} weather events`);
    }

    if (eventsFound === 0) {
      log.info('No weather events found — scan complete');
      appendDailyLog('Scan: 0 weather events found');
      state.lastScan = new Date().toISOString();
      state.lastEvents = [];
      state.lastDecisions = [];
      return;
    }

    // Validate events
    const validated = allEvents.filter(e => {
      const check = validateEvent(e);
      if (!check.valid) {
        log.warn(`Validation: "${e.title?.slice(0, 50)}" — REJECTED: ${check.reason}`);
        return false;
      }
      return true;
    });

    // Sort by spread descending (largest perceived edge first), then by closest resolution time.
    validated.sort((a, b) => {
      const spreadDiff = (Number(b.spread) || 0) - (Number(a.spread) || 0);
      if (spreadDiff !== 0) return spreadDiff;
      const at = new Date(a.endTime || 0).getTime();
      const bt = new Date(b.endTime || 0).getTime();
      return at - bt;
    });

    // Pre-filter before expensive API calls: remove copied events and events with existing open positions.
    const seenSignatures = new Set();
    const seenTokensInThisScan = new Set();
    const prefiltered = [];
    let skippedExistingPosition = 0;
    let skippedDuplicateCopy = 0;

    for (const event of validated) {
      const signature = normalizeEventSignature(event);
      if (seenSignatures.has(signature)) {
        skippedDuplicateCopy++;
        continue;
      }

      const eventTokenIds = (event.outcomes || []).map((o) => o?.tokenId).filter(Boolean);
      const tokenDupInScan = eventTokenIds.some((tid) => seenTokensInThisScan.has(tid));
      if (tokenDupInScan) {
        skippedDuplicateCopy++;
        continue;
      }

      if (hasAnyOpenPositionForEvent(event)) {
        skippedExistingPosition++;
        updateWeatherEventStatus(event.eventId, 'skipped');
        continue;
      }

      seenSignatures.add(signature);
      for (const tid of eventTokenIds) seenTokensInThisScan.add(tid);
      prefiltered.push(event);
    }

    // Limit to max events per scan while preserving spread-priority ordering.
    const toProcess = prefiltered.slice(0, config.maxEventsPerScan);
    log.info(`Processing ${toProcess.length} events after prefilter (valid=${validated.length}, total=${eventsFound}, skipped_existing=${skippedExistingPosition}, skipped_duplicates=${skippedDuplicateCopy})`);
    for (const e of toProcess.slice(0, 5)) {
      log.debug(`  Candidate: spread=${e.spread?.toFixed(3) ?? '?'} cheap=${e.cheapSide?.side ?? '?'}@${e.cheapSide?.price?.toFixed(3) ?? '?'} | "${e.title?.slice(0, 60)}"`);
    }
    if (toProcess.length > 5) {
      log.debug(`  ...plus ${toProcess.length - 5} more candidate event(s)`);
    }

    state.lastEvents = toProcess;

    // Save events to DB and record odds snapshots
    for (const e of toProcess) {
      saveWeatherEvent(e);
      if (e.outcomes?.length > 0) {
        recordOddsSnapshot(e.eventId, e.outcomes);
      }
    }

    // Process events one at a time — AI proposes up to 3 bets per event
    for (let i = 0; i < toProcess.length; i++) {
      const event = toProcess[i];
      const label = `[${i + 1}/${toProcess.length}] "${event.title?.slice(0, 60)}"`;

      // Check if all slots are full — ABORT if so
      if (getActiveBetCount() >= config.maxActiveBets) {
        log.info(`All ${config.maxActiveBets} trading slots full — aborting remaining events`);
        appendDailyLog(`ABORT: all ${config.maxActiveBets} slots full after ${i} events`);
        break;
      }

      log.info(`${label}`);
      log.info(`  Category: ${event.category} | Location: ${event.location || 'unknown'} | Spread: ${event.spread?.toFixed(3) ?? '?'} | Cheap: ${event.cheapSide?.side ?? '?'}@${event.cheapSide?.price?.toFixed(3) ?? '?'} | Resolves: ${event.endTime}`);

      // Pre-filter: skip events we've already bet on or that fail basic checks
      let prepared;
      try {
        prepared = await prepareEventData(event);
        if (!prepared) {
          decisions.push({ event: event.title, shouldBet: false, reasoning: 'Skipped in pre-check' });
          continue;
        }
      } catch (err) {
        logDetailedError(log, `Error preparing ${label}`, err, {
          event: event?.title || null,
          eventId: event?.eventId || null,
        });
        decisions.push({ event: event.title, shouldBet: false, reasoning: `Error: ${err.message}` });
        continue;
      }

      // Send to AI — single event, get 0-3 bet proposals
      try {
        const eventResult = await processEvent(prepared);
        for (const r of eventResult) {
          decisions.push({ event: event.title, ...r });
          if (r.betPlaced) betsPlaced++;
        }
      } catch (err) {
        logDetailedError(log, 'Event processing error', err, {
          event: event?.title || null,
          eventId: event?.eventId || null,
        });
        decisions.push({ event: event.title, shouldBet: false, reasoning: `AI error: ${err.message}` });
      }

      await sleep(1000);
    }

    state.lastDecisions = decisions;

  } catch (err) {
    logDetailedError(log, 'Weather scan failed', err);
    appendDailyLog(`Scan error: ${err.message}`);
    notify.error({ context: 'Weather scan', error: err.message }).catch(() => {});
  } finally {
    state.scanning = false;
    state.lastScan = new Date().toISOString();

    const elapsed = ((Date.now() - scanStart) / 1000).toFixed(1);
    log.info(`Weather scan complete: found=${eventsFound} placed=${betsPlaced} elapsed=${elapsed}s`);

    appendDailyLog(`Scan: ${eventsFound} events, ${betsPlaced} bets placed (${elapsed}s)`);
    recordScan(eventsFound, betsPlaced, `${decisions.length} analyzed`);

    notify.scanComplete({
      eventsFound,
      betsPlaced,
      decisions: decisions.map(d => ({
        event: d.event,
        shouldBet: d.shouldBet,
        predictedOutcome: d.predictedOutcome,
        confidence: d.confidence,
      })),
    }).catch(() => {});
  }
}

// ─── Event Preparation (pre-filter + fetch data) ───────────────────────────

async function prepareEventData(event) {
  // Skip immediately if any outcome token is already open (avoid duplicate/copy analysis costs).
  const outcomesWithToken = (event.outcomes || []).filter(o => o.tokenId);
  const openOutcomeCount = outcomesWithToken.filter(o => hasOpenBetForToken(o.tokenId)).length;
  if (openOutcomeCount > 0) {
    log.info('  Event already has an open position (token overlap) — skipping');
    updateWeatherEventStatus(event.eventId, 'skipped');
    return null;
  }

  // Risk check
  const riskCheck = riskManager.canPlaceBet();
  if (!riskCheck.allowed) {
    log.warn(`  Risk check blocked: ${riskCheck.reason}`);
    return null;
  }

  // Token budget check
  const tokensUsedToday = getTodayTokenUsage();
  if (tokensUsedToday >= config.maxDailyTokens) {
    log.warn(`  Daily token budget exhausted (${tokensUsedToday}/${config.maxDailyTokens})`);
    return null;
  }

  // Fetch forecast data before AI request
  let weatherText = '';
  if (event.location) {
    try {
      const weatherData = await fetchWeatherData(event.location);
      const forecastText = formatWeatherDataForAI(weatherData, event.endTime);

      let climateText = '';
      try {
        const climateData = await fetchClimateData({
          locationName: event.location,
          lat: weatherData.lat,
          lon: weatherData.lon,
          eventEndTime: event.endTime,
        });

        const recentSamples = (Array.isArray(climateData?.recentSamples) ? climateData.recentSamples : [])
          .filter((s) => (s?.sampleType || 'recent') === 'recent');
        const yearlySamples = (Array.isArray(climateData?.yearlyComparisons) ? climateData.yearlyComparisons : [])
          .filter((s) => (s?.sampleType || 'yearly') === 'yearly');
        const recentUsable = recentSamples.reduce((sum, s) => sum + (Array.isArray(s?.records) ? s.records.length : 0), 0);
        const yearlyUsable = yearlySamples.reduce((sum, s) => sum + (Array.isArray(s?.records) ? s.records.length : 0), 0);
        const totalUsable = recentUsable + yearlyUsable;
        log.info(`  NOAA usable records: ${totalUsable} (recent ${recentUsable}, yearly ${yearlyUsable})`);

        climateText = formatClimateDataForAI(climateData);
      } catch (climateErr) {
        log.warn(`  NOAA climate fetch failed for ${event.location}: ${climateErr.message}`);
        climateText = `NOAA climate data unavailable: ${climateErr.message}`;
      }

      weatherText = `${forecastText}\n\n${climateText}`;
    } catch (err) {
      log.warn(`  OWM fetch failed for ${event.location}: ${err.message}`);
      weatherText = `OpenWeatherMap forecast unavailable: ${err.message}`;
    }
  } else {
    weatherText = 'OpenWeatherMap forecast unavailable: event location not detected';
  }

  // Append odds movement context for AI
  const oddsMovement = formatOddsMovementForAI(event.eventId, event.outcomes);
  if (oddsMovement) {
    weatherText = weatherText ? `${weatherText}\n\n${oddsMovement}` : oddsMovement;
  }

  // Fetch price history for all outcomes
  const priceHistories = {};
  await Promise.allSettled(
    event.outcomes
      .filter(o => o.tokenId)
      .map(async (o) => {
        try {
          priceHistories[o.outcome] = await getPriceHistory(o.tokenId);
        } catch {
          priceHistories[o.outcome] = { current: o.price, change24h: null, change6h: null, change1h: null, change10m: null };
        }
      })
  );

  return { event, weatherText, priceHistories };
}

// ─── Single-Event AI Analysis + Bet Placement (up to 3 bets per event) ──────

async function processEvent(prepared) {
  const { event } = prepared;
  log.debug('  Sending event to AI for analysis...');
  const recentBets = getRecentBets(30);
  const activeBets = getActiveBets();
  const accuracySummary = getAIAccuracySummary(event.category);

  let aiResult;
  try {
    aiResult = await Promise.race([
      analyzeWeatherEvent(prepared, recentBets, activeBets, accuracySummary),
      new Promise((_, reject) => setTimeout(() => reject(new Error('AI analysis timeout')), ANALYSIS_TIMEOUT_MS)),
    ]);
  } catch (err) {
    logDetailedError(log, 'AI analysis failed in scheduler', err, {
      event: event?.title || null,
      eventId: event?.eventId || null,
    });
    return [{ shouldBet: false, betPlaced: false, reasoning: `AI error: ${err.message}`, predictedOutcome: '', confidence: 0 }];
  }

  // Record token usage
  if (aiResult._tokenUsage?.total) {
    recordTokenUsage(aiResult._tokenUsage.total);
  }

  updateWeatherEventStatus(event.eventId, 'analyzed');

  const bets = aiResult.bets || [];
  if (bets.length === 0) {
    log.info(`  AI says NO BETS: "${event.title?.slice(0, 50)}"`);
    appendDailyLog(`PASS: "${event.title?.slice(0, 50)}" — no bets proposed`);
    return [{ shouldBet: false, betPlaced: false, reasoning: 'No bets proposed', predictedOutcome: '', confidence: 0 }];
  }

  // Process AI proposal(s) (policy: 0 or 1 YES-side bet)
  const results = [];
  for (let bidx = 0; bidx < bets.length; bidx++) {
    const bet = bets[bidx];
    const result = { shouldBet: true, betPlaced: false, reasoning: bet.reasoning || '', predictedOutcome: bet.predictedOutcome, confidence: bet.confidence || 0 };

    emitEvent('scheduler', 'ai_decision', {
      event: event.title,
      category: event.category,
      shouldBet: true,
      predictedOutcome: bet.predictedOutcome || null,
      side: bet.side || 'YES',
      confidence: bet.confidence ?? null,
      edge: bet.edge ?? null,
    });

    log.debug(`  AI decision ${bidx + 1}/${bets.length}: "${bet.predictedOutcome}" ${bet.side} (confidence: ${bet.confidence}%, edge: ${((bet.edge || 0) * 100).toFixed(1)}%)`);

    // Re-check slot availability
    if (getActiveBetCount() >= config.maxActiveBets) {
      log.info(`  Slots full — skipping remaining bets for "${event.title?.slice(0, 50)}"`);
      result.reasoning = 'Slots filled';
      results.push(result);
      break;
    }

    // Resolve which token to buy based on side
    const targetOutcome = matchOutcome(bet.predictedOutcome, event.outcomes);
    if (!targetOutcome) {
      log.warn(`  Could not match "${bet.predictedOutcome}" to available outcomes`);
      log.debug(`  Available: ${event.outcomes.map(o => `${o.outcome}${o.label ? ` [${o.label}]` : ''}`).join(', ')}`);
      appendDailyLog(`SKIP: "${event.title?.slice(0, 40)}" — outcome mismatch "${bet.predictedOutcome}"`);
      results.push(result);
      continue;
    }

    // Determine token and price based on YES/NO side
    const side = (bet.side || 'YES').toUpperCase();
    if (side !== 'YES') {
      log.info(`  Skipping non-YES AI side "${side}" for "${bet.predictedOutcome}" (YES-only strategy)`);
      appendDailyLog(`SKIP: "${event.title?.slice(0, 40)}" — non-YES side proposed (${side})`);
      result.reasoning = 'Only YES-side bets are allowed';
      results.push(result);
      continue;
    }

    let tokenId, betPrice;
    if (side === 'NO' && targetOutcome.noTokenId) {
      tokenId = targetOutcome.noTokenId;
      betPrice = targetOutcome.noPrice ?? (1 - (targetOutcome.price || 0));
    } else {
      tokenId = targetOutcome.tokenId;
      betPrice = targetOutcome.price;
    }

    if (!tokenId) {
      log.warn(`  No ${side} tokenId for "${bet.predictedOutcome}"`);
      results.push(result);
      continue;
    }

    log.debug(`  Matched: "${bet.predictedOutcome}" ${side} -> tokenId=${tokenId?.slice(0, 12)}... snapshotPrice=${betPrice}`);

    // Reprice from live Polymarket BUY quote immediately after AI response,
    // then apply odds limits on this refreshed value (not stale scan snapshot).
    const aiSnapshotPrice = Number(betPrice);
    const repricedAfterAi = await getCurrentEntryPrice(tokenId);
    if (!Number.isFinite(repricedAfterAi) || repricedAfterAi <= 0) {
      log.info(`  Live entry quote unavailable — skipping (${bet.predictedOutcome} ${side})`);
      appendDailyLog(`SKIP: "${event.title?.slice(0, 40)}" — no live entry quote (${bet.predictedOutcome} ${side})`);
      result.reasoning = 'Live entry quote unavailable';
      results.push(result);
      continue;
    }
    betPrice = repricedAfterAi;
    log.info(`  Live repricing after AI: snapshot=${Number.isFinite(aiSnapshotPrice) ? aiSnapshotPrice.toFixed(3) : 'n/a'} -> current=${betPrice.toFixed(3)}`);

    // Never add to an existing open position for the same unique outcome token
    if (hasOpenBetForToken(tokenId)) {
      log.info(`  Open position already exists for token — skipping (${bet.predictedOutcome} ${side})`);
      appendDailyLog(`SKIP: "${event.title?.slice(0, 40)}" — token already open (${bet.predictedOutcome} ${side})`);
      result.reasoning = 'Open position already exists for this token';
      results.push(result);
      continue;
    }

    // Enforce confidence/edge + category + active-slot risk checks at placement time.
    const decisionGate = riskManager.checkBetAllowed({
      category: event.category,
      confidence: Number(bet.confidence || 0),
      edge: Number(bet.edge || 0),
    });
    if (!decisionGate.allowed) {
      log.info(`  Risk gate blocked: ${decisionGate.reason}`);
      appendDailyLog(`SKIP: "${event.title?.slice(0, 40)}" — ${decisionGate.reason}`);
      result.reasoning = decisionGate.reason;
      results.push(result);
      continue;
    }

    // Validate odds
    const oddsCheck = riskManager.validateOdds(betPrice);
    if (!oddsCheck.valid) {
      log.info(`  Odds validation failed: ${oddsCheck.reason}`);
      appendDailyLog(`SKIP: "${event.title?.slice(0, 40)}" — ${oddsCheck.reason}`);
      results.push(result);
      continue;
    }

    // Reprice once more immediately before order placement to guard against
    // fast moves between decision gate and execution.
    const preOrderPrice = await getCurrentEntryPrice(tokenId);
    if (!Number.isFinite(preOrderPrice) || preOrderPrice <= 0) {
      log.info(`  Pre-order live quote unavailable — skipping (${bet.predictedOutcome} ${side})`);
      appendDailyLog(`SKIP: "${event.title?.slice(0, 40)}" — pre-order quote unavailable (${bet.predictedOutcome} ${side})`);
      result.reasoning = 'Pre-order live quote unavailable';
      results.push(result);
      continue;
    }
    if (Math.abs(preOrderPrice - betPrice) >= 0.001) {
      log.info(`  Pre-order repricing: ${betPrice.toFixed(3)} -> ${preOrderPrice.toFixed(3)}`);
    }
    betPrice = preOrderPrice;

    const preOrderOddsCheck = riskManager.validateOdds(betPrice);
    if (!preOrderOddsCheck.valid) {
      log.info(`  Pre-order odds validation failed: ${preOrderOddsCheck.reason}`);
      appendDailyLog(`SKIP: "${event.title?.slice(0, 40)}" — ${preOrderOddsCheck.reason} (pre-order)`);
      result.reasoning = preOrderOddsCheck.reason;
      results.push(result);
      continue;
    }

    // Place bet
    const defaultBetAmountUsd = parseFloat(config.betAmountUsd || 1);
    const useFixedSharesMode = betPrice < 0.20;
    const requestedShares = useFixedSharesMode ? 5 : null;
    const estimatedAmountUsd = useFixedSharesMode
      ? parseFloat((requestedShares * betPrice).toFixed(4))
      : defaultBetAmountUsd;
    const sharesToBuy = useFixedSharesMode
      ? requestedShares
      : parseFloat((defaultBetAmountUsd / betPrice).toFixed(2));

    if (useFixedSharesMode) {
      log.debug(`  Low-price mode: price ${betPrice} < 0.20, placing fixed ${requestedShares} shares (est. $${estimatedAmountUsd})`);
    }
    log.debug(`  Placing bet (${sharesToBuy} shares) on "${targetOutcome.outcome}" ${side} at price ${betPrice} (est. $${estimatedAmountUsd})...`);

    const betResult = await placeBet({
      tokenId,
      price: betPrice,
      negRisk: targetOutcome.negRisk,
      tickSize: targetOutcome.tickSize,
      shares: requestedShares,
    });

    if (betResult.success) {
      const betId = recordBet({
        eventId: event.eventId,
        marketId: targetOutcome.marketId,
        tokenId,
        category: event.category || 'general',
        eventTitle: event.title,
        location: event.location || '',
        predictedOutcome: `${bet.predictedOutcome} (${side})`,
        oddsAtBet: betPrice,
        amountUsd: betResult.amountUsd ?? estimatedAmountUsd,
        shares: betResult.shares || 1,
        negRisk: targetOutcome.negRisk || false,
        tickSize: targetOutcome.tickSize || '0.01',
        orderId: betResult.orderId,
        status: betResult.paperTrade ? 'active' : 'placed',
        paper: betResult.paperTrade || false,
        aiReasoning: bet.reasoning,
        eventEnd: event.endTime,
        confidence: bet.confidence,
        aiEdge: bet.edge,
      });

      if (betId && betResult.orderId) {
        updateBetOrderId(betId, betResult.orderId);
      }

      const todayStats = getTodayStats();
      upsertDailyStats({
        ...todayStats,
        bets_placed: todayStats.bets_placed + 1,
        total_wagered: todayStats.total_wagered + (betResult.amountUsd ?? estimatedAmountUsd),
      });

      result.betPlaced = true;
      const finalAmountUsd = betResult.amountUsd ?? estimatedAmountUsd;
      log.info(`  BET PLACED: "${event.title?.slice(0, 50)}" -> ${bet.predictedOutcome} ${side} at ${betPrice} ($${finalAmountUsd})`);
      appendDailyLog(`BET: "${event.title?.slice(0, 50)}" -> ${bet.predictedOutcome} ${side} @${betPrice} ($${finalAmountUsd}) [${betResult.paperTrade ? 'PAPER' : 'LIVE'}]`);

      emitEvent('scheduler', 'bet_placed', {
        event: event.title,
        category: event.category,
        predictedOutcome: `${bet.predictedOutcome} (${side})`,
        price: betPrice,
        amountUsd: finalAmountUsd,
        shares: betResult.shares || 1,
        confidence: bet.confidence,
        edge: bet.edge,
        paperTrade: !!betResult.paperTrade,
      });

      notify.betPlaced({
        eventTitle: event.title,
        category: event.category,
        location: event.location,
        predictedOutcome: `${bet.predictedOutcome} (${side})`,
        price: betPrice,
        amount: finalAmountUsd,
        shares: betResult.shares || 1,
        confidence: bet.confidence,
        edge: bet.edge,
        reasoning: bet.reasoning,
        paperTrade: betResult.paperTrade,
      }).catch(() => {});

      syncRealtimeSubscriptions().catch(() => {});
    } else {
      log.error(`  BET FAILED: ${betResult.error}`);
      appendDailyLog(`FAILED: "${event.title?.slice(0, 40)}" — ${betResult.error}`);
      notify.error({ context: `Bet: ${event.title?.slice(0, 40)}`, error: betResult.error }).catch(() => {});
    }

    results.push(result);
  }

  return results;
}

// ─── Legacy wrapper ─────────────────────────────────────────────────────────

export async function bettingLoop() {
  await weatherScan();
}

// ─── Daily Report ───────────────────────────────────────────────────────────

export async function dailyReport() {
  log.info('Generating daily report...');
  const todayStats = getTodayStats();
  const recentDays = getRecentDailyStats(7);
  const activeBets = getActiveBets();
  const recentBets = getRecentBets(10);
  const riskSummary = riskManager.getSummary();

  const report = [
    '===========================================',
    '  POLYMARKET-WEATHER-TRADE DAILY REPORT',
    `  Date: ${new Date().toISOString().slice(0, 10)}`,
    '===========================================',
    '',
    `Balance: $${riskSummary.balance?.toFixed(2) || '?'}`,
    `Active bets: ${activeBets.length}/${config.maxActiveBets}`,
    '',
    '-- Today --',
    `  Bets placed: ${todayStats.bets_placed}`,
    `  Won: ${todayStats.bets_won}`,
    `  Lost: ${todayStats.bets_lost}`,
    `  Total wagered: $${todayStats.total_wagered.toFixed(2)}`,
    `  P&L: $${todayStats.total_pnl.toFixed(2)}`,
    '',
    '-- Last 7 Days --',
    ...recentDays.map(d =>
      `  ${d.date}: ${d.bets_placed} bets, W:${d.bets_won} L:${d.bets_lost}, P&L:$${d.total_pnl.toFixed(2)}`
    ),
    '',
    '-- Risk Status --',
    `  Low balance: ${riskSummary.lowBalance ? 'YES' : 'No'}`,
    `  Today bets: ${riskSummary.todayBetsPlaced ?? 0}/${config.maxDailyBets}`,
    '',
    '-- Active Bets --',
    ...activeBets.map(b => {
      const buyP = parseFloat(b.odds_at_bet || 0);
      const tpPct = getDynamicTakeProfitPct(buyP);
      const tpPrice = buyP > 0 ? buyP * (1 + tpPct) : 0;
      return `  ${b.event_title || 'Event'} -> ${b.predicted_outcome} @${b.odds_at_bet} ($${b.amount_usd}) | TP price ${tpPrice.toFixed(3)} (${(tpPct * 100).toFixed(0)}%)`;
    }),
    '',
    '-- Recent Bets --',
    ...recentBets.map(b => {
      const icon = b.status === 'resolved' ? (b.result === 'won' ? 'W' : 'L') : '?';
      return `  [${icon}] ${b.event_title || 'Event'} -> ${b.predicted_outcome} @${b.odds_at_bet}`;
    }),
  ].join('\n');

  log.info(report);
  appendDailyLog('Daily report generated');
  notify.dailyReport(report).catch(() => {});
  pruneOldOddsSnapshots();

  return report;
}

async function runBetStatusCheck({ forceRefresh = false, reason = 'scheduled' } = {}) {
  if (!state.initialized) return;
  if (state.statusTickRunning) {
    state.statusTickPending = true;
    state.statusTickPendingForceRefresh = state.statusTickPendingForceRefresh || !!forceRefresh;
    state.statusTickPendingReasons.add(String(reason || 'queued'));
    state.statusTickQueuedCount += 1;
    return;
  }
  state.statusTickRunning = true;

  try {
    await refreshExchangeState({ force: forceRefresh });

    const dbBets = getActiveBets();

    // Stale bet cleanup
    const staleBets = getStalePlacedBets();
    if (staleBets.length > 0) {
      log.info(`Found ${staleBets.length} stale placed bet(s) — marking expired`);
      for (const stale of staleBets) {
        log.debug(`  Stale bet #${stale.id}: ${stale.event_title || 'Event'} — expired`);
        updateBetStatus(stale.id, 'expired', null, 0);
        appendDailyLog(`EXPIRED: stale bet #${stale.id} ${stale.event_title || 'Event'}`);
        notify.betResult({
          action: 'expired',
          eventTitle: stale.event_title,
          predictedOutcome: stale.predicted_outcome,
          buyPrice: Number(stale.odds_at_bet),
          sellPrice: null,
          pnl: 0,
          shares: stale.shares,
        }).catch(() => {});
      }
    }

    if (dbBets.length === 0) {
      infoThrottled('status-no-active-bets', `Bet status check (${reason}): no active bets`, THROTTLE_NO_ACTIVE_MS);
      await syncRealtimeSubscriptions().catch(() => {});
      return;
    }

    log.debug(`Bet status check (${reason}): checking ${dbBets.length} active bet(s)...`);

    let polyOrders = [];
    try {
      polyOrders = await getPolymarketOpenOrders();
      if (polyOrders.length > 0) {
        log.debug(`Polymarket reports ${polyOrders.length} open order(s)`);
      }
    } catch (err) {
      log.warn(`Could not fetch Polymarket orders: ${err.message}`);
    }

    logOpenOrderStatuses(dbBets, polyOrders);

    // Detailed per-position trace is debug-only to keep checks stable.
    for (const bet of dbBets) {
      const directBuy = Number(bet.odds_at_bet);
      const derivedBuy = Number(bet.amount_usd) > 0 && Number(bet.shares) > 0
        ? Number(bet.amount_usd) / Number(bet.shares)
        : 0;
      const buyPrice = Number.isFinite(directBuy) && directBuy > 0 ? directBuy : derivedBuy;
      const tpPct = getDynamicTakeProfitPct(buyPrice);
      const slPct = config.stopLossPct ?? 0.25;
      const tpPrice = buyPrice > 0 ? buyPrice * (1 + tpPct) : Number.POSITIVE_INFINITY;
      const slPrice = buyPrice > 0 ? buyPrice * (1 - slPct) : Number.NEGATIVE_INFINITY;
      const currentPrice = await getCurrentExitPrice(bet.token_id);

      log.debug(
        `  #${bet.id} ${bet.event_title || 'Event'} -> ${bet.predicted_outcome} `
        + `| bought@${buyPrice.toFixed(3)} | current@${Number.isFinite(currentPrice) ? currentPrice.toFixed(3) : 'n/a'} | status=${bet.status} `
        + `| TP=${tpPrice.toFixed(3)} (${(tpPct * 100).toFixed(1)}%) `
        + `| SL=${slPrice.toFixed(3)} (-${(slPct * 100).toFixed(1)}%)`,
      );
    }

    const actions = await checkBetStatuses(dbBets, updateBetStatus, appendDailyLog, incrementSellAttempts, polyOrders);
    const sold = actions.filter((a) => a.action === 'take_profit');
    const stopped = actions.filter((a) => a.action === 'stop_loss');
    const redeemed = actions.filter((a) => a.action === 'redeemed');
    const lost = actions.filter((a) => a.action === 'lost');

    if (sold.length) log.info(`Status check (${reason}): sold ${sold.length} position(s)`);
    if (stopped.length) log.info(`Status check (${reason}): stop-loss sold ${stopped.length} position(s)`);
    if (redeemed.length) log.info(`Status check (${reason}): redeemed ${redeemed.length} win(s)`);
    if (lost.length) log.info(`Status check (${reason}): resolved ${lost.length} loss(es)`);
    if (!sold.length && !stopped.length && !redeemed.length && !lost.length) {
      infoThrottled(
        'status-hold-summary',
        `Status check (${reason}): ${dbBets.length} active, ${polyOrders.length} open orders, no exits`,
        THROTTLE_ORDER_SUMMARY_MS,
      );
    }

    for (const a of actions) {
      if (a.action === 'hold') continue;
      const bet = dbBets.find((b) => b.id === a.betId);
      if (!bet) continue;
      notify.betResult({
        action: a.action,
        eventTitle: bet.event_title,
        predictedOutcome: bet.predicted_outcome,
        buyPrice: Number(bet.odds_at_bet),
        sellPrice: a.sellPrice ?? a.currentPrice ?? null,
        pnl: a.pnl ?? null,
        shares: bet.shares,
      }).catch(() => {});
    }

    await syncRealtimeSubscriptions().catch(() => {});
  } catch (err) {
    logDetailedError(log, `Bet status check failed (${reason})`, err);
    notify.error({ context: `Bet status check (${reason})`, error: err.message }).catch(() => {});
  } finally {
    state.statusTickRunning = false;

    if (state.statusTickPending) {
      const queuedForceRefresh = state.statusTickPendingForceRefresh;
      const queuedReasons = Array.from(state.statusTickPendingReasons);
      const queuedCount = state.statusTickQueuedCount;

      state.statusTickPending = false;
      state.statusTickPendingForceRefresh = false;
      state.statusTickPendingReasons.clear();
      state.statusTickQueuedCount = 0;

      const queuedReason = queuedReasons.length > 0
        ? `queued:${queuedReasons.join(',')}`
        : 'queued:realtime';

      log.info(`Replaying queued status check: queued_realtime_checks=${queuedCount || 1} reason=${queuedReason}`);

      queueMicrotask(() => {
        runBetStatusCheck({ forceRefresh: queuedForceRefresh, reason: queuedReason }).catch((err) => {
          log.warn(`Queued status check failed: ${err.message}`);
        });
      });
    }
  }
}

// ─── Cron Scheduler ─────────────────────────────────────────────────────────

export function startScheduler() {
  log.info('Starting polymarket-weather-trade scheduler...');

  // Weather scan every 2 hours
  cronJobs.push(new CronJob(
    config.scanCron,
    async () => {
      if (!state.initialized) return;
      log.debug('Cron triggered: weather scan');
      await weatherScan();
    },
    null, true, 'UTC',
  ));
  log.info(`Scheduled weather scan: ${config.scanCron}`);

  // Daily report — 23:50 UTC
  cronJobs.push(new CronJob(
    '50 23 * * *',
    async () => {
      if (!state.initialized) return;
      await dailyReport();
    },
    null, true, 'UTC',
  ));
  log.info('Scheduled daily report: 23:50 UTC');

  // Stale open-order cancellation — every minute
  cronJobs.push(new CronJob(
    '* * * * *',
    async () => {
      if (!state.initialized) return;
      if (state.staleCancelRunning) return;
      state.staleCancelRunning = true;

      try {
        await refreshExchangeState();
        const dbBets = getActiveBets();
        if (dbBets.length === 0) return;

        const openOrders = await getPolymarketOpenOrders();
        await cancelStaleUnfilledOrders(dbBets, openOrders);
      } catch (err) {
        log.warn(`Stale-order cancel tick failed: ${err.message}`);
      } finally {
        state.staleCancelRunning = false;
      }
    },
    null, true, 'UTC',
  ));
  log.info(`Scheduled stale-order cancellation: every 1min (>${ORDER_CANCEL_STALE_MINUTES}m unfilled)`);

  // Bet status fallback check — realtime WebSocket monitor handles primary triggers.
  cronJobs.push(new CronJob(
    STATUS_FALLBACK_CRON,
    async () => {
      await runBetStatusCheck({ forceRefresh: true, reason: 'fallback_cron' });
    },
    null, true, 'UTC',
  ));
  log.info(`Scheduled fallback bet status check: ${STATUS_FALLBACK_CRON}`);

  // Initialize
  (async () => {
    try {
      log.info('Setting up exchange allowances...');
      await ensureAllowances();

      log.info('Running initial balance check...');
      const balance = await getBalance();
      state.lastBalance = balance;
      riskManager.setBalance(balance);
      log.info(`Initial balance: $${balance.toFixed(2)}`);

      await refreshExchangeState({ force: true, includeTrades: true });

      await startRealtimeMonitor({
        getTrackedSnapshot: async () => {
          const active = getActiveBets();
          return {
            assetIds: active.map((b) => b.token_id).filter(Boolean),
            marketIds: active.map((b) => b.market_id).filter(Boolean),
          };
        },
        onSignal: async ({ reason, forceRefresh }) => {
          await runBetStatusCheck({ forceRefresh: !!forceRefresh, reason: `realtime:${reason}` });
        },
      });

      state.initialized = true;
      log.info('Scheduler initialized — running startup weather scan');
      appendDailyLog(`polymarket-weather-trade started. Balance: $${balance.toFixed(2)}`);

      notify.startup({
        balance,
        paperTrade: config.paperTrade(),
        wallet: (await import('./wallet.js')).getAddress(),
        model: config.openaiModel,
      }).catch(() => {});

      await weatherScan();
      log.info('Startup scan complete — next scan per cron schedule');
    } catch (err) {
      logDetailedError(log, 'Initialization failed', err);
      state.initialized = true;
    }
  })();
}

export function stopScheduler() {
  log.info('Stopping scheduler...');
  stopRealtimeMonitor();
  for (const job of cronJobs) job.stop();
  cronJobs = [];
  log.info('All cron jobs stopped');
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function extractOpenOrderId(order) {
  return order?.id || order?.orderID || order?.orderId || order?.order_id || null;
}

function extractOpenOrderCreatedAtMs(order) {
  const raw = order?.createdAt ?? order?.created_at ?? order?.inserted_at ?? null;
  if (raw === null || raw === undefined) return null;

  if (typeof raw === 'number' && Number.isFinite(raw)) {
    // Some APIs return seconds, others milliseconds.
    return raw > 1e12 ? raw : raw * 1000;
  }

  const asNum = Number(raw);
  if (Number.isFinite(asNum)) {
    return asNum > 1e12 ? asNum : asNum * 1000;
  }

  const ts = new Date(String(raw)).getTime();
  return Number.isFinite(ts) ? ts : null;
}

function isOlderThanMinutes(sqliteDateTime, minutes) {
  if (!sqliteDateTime || minutes <= 0) return false;
  const raw = String(sqliteDateTime);
  const ts = raw.includes('T')
    ? new Date(raw).getTime()
    : new Date(`${raw}Z`).getTime();
  if (Number.isNaN(ts)) return false;
  return (Date.now() - ts) >= (minutes * 60_000);
}

function logOpenOrderStatuses(dbBets, polyOrders = []) {
  const orders = Array.isArray(polyOrders) ? polyOrders : [];
  const placedByOrderId = new Map(
    (Array.isArray(dbBets) ? dbBets : [])
      .filter((b) => b.status === 'placed' && b.order_id)
      .map((b) => [String(b.order_id), b])
  );

  log.debug(`Open-order status: exchange=${orders.length}, tracked_placed=${placedByOrderId.size}`);
  if (orders.length === 0) return;

  for (const order of orders) {
    const orderId = String(extractOpenOrderId(order) || 'unknown');
    const trackedBet = placedByOrderId.get(orderId);
    const status = order?.status || order?.orderStatus || 'open';
    const side = order?.side || order?.order_side || '?';
    const price = order?.price ?? order?.order_price ?? '?';
    const size = order?.size ?? order?.original_size ?? order?.remaining_size ?? '?';
    const createdAt = order?.createdAt || order?.created_at || order?.inserted_at || '?';

    if (trackedBet) {
      log.debug(
        `  OPEN ${orderId}: ${side} ${size} @${price} status=${status} created=${createdAt} | tracked bet #${trackedBet.id} (${trackedBet.event_title?.slice(0, 40) || 'Event'})`
      );
    } else {
      log.debug(`  OPEN ${orderId}: ${side} ${size} @${price} status=${status} created=${createdAt} | not tracked by weather DB`);
    }
  }
}

async function cancelStaleUnfilledOrders(dbBets, polyOrders = []) {
  if (!Array.isArray(dbBets)) return;

  const openOrderIds = new Set(
    (Array.isArray(polyOrders) ? polyOrders : [])
      .map(extractOpenOrderId)
      .filter(Boolean)
      .map(String)
  );

  let cancelled = 0;
  for (const bet of dbBets) {
    if (bet.status !== 'placed') continue;
    if (!bet.order_id) continue;
    if (!isOlderThanMinutes(bet.placed_at, ORDER_CANCEL_STALE_MINUTES)) continue;

    const orderId = String(bet.order_id);
    if (openOrderIds.size > 0 && !openOrderIds.has(orderId)) continue;

    const result = await cancelPolymarketOrder(orderId);
    if (!result.success) {
      const errMsg = result.error || 'unknown error';
      // If cancel keeps failing with 400/invalid payload, the order is likely already
      // filled or expired on-chain — mark as cancelled to stop retrying every minute.
      if (errMsg.includes('Invalid order') || errMsg.includes('400') || errMsg.includes('404') || errMsg.includes('not found')) {
        log.warn(`Stale order cancel for bet #${bet.id} got permanent rejection (${errMsg}) — marking as cancelled`);
        updateBetStatus(bet.id, 'cancelled', 'cancelled', 0);
        appendDailyLog(`CANCELLED: stale order for "${bet.event_title?.slice(0, 40) || 'Event'}" (cancel rejected: ${errMsg.slice(0, 60)})`);
        cancelled++;
        continue;
      }
      log.warn(`Stale order cancel failed for bet #${bet.id} (${orderId}): ${errMsg}`);
      continue;
    }

    updateBetStatus(bet.id, 'cancelled', 'cancelled', 0);
    appendDailyLog(`CANCELLED: unfilled order >${ORDER_CANCEL_STALE_MINUTES}m for "${bet.event_title?.slice(0, 40) || 'Event'}"`);
    notify.betResult({
      action: 'cancelled',
      eventTitle: bet.event_title,
      predictedOutcome: bet.predicted_outcome,
      buyPrice: Number(bet.odds_at_bet),
      sellPrice: null,
      pnl: 0,
      shares: bet.shares,
    }).catch(() => {});

    cancelled++;
  }

  if (cancelled > 0) {
    log.info(`Canceled ${cancelled} stale unfilled order(s) older than ${ORDER_CANCEL_STALE_MINUTES}m`);
  }

  // Also clean up exchange open orders that are not tracked in weather DB and older than threshold.
  const trackedOrderIds = new Set(
    (Array.isArray(dbBets) ? dbBets : [])
      .map((b) => (b?.order_id ? String(b.order_id) : null))
      .filter(Boolean)
  );

  let cancelledUntracked = 0;
  for (const order of (Array.isArray(polyOrders) ? polyOrders : [])) {
    const orderId = String(extractOpenOrderId(order) || '');
    if (!orderId) continue;
    if (trackedOrderIds.has(orderId)) continue;

    const createdAtMs = extractOpenOrderCreatedAtMs(order);
    if (!Number.isFinite(createdAtMs)) continue;
    if ((Date.now() - createdAtMs) < ORDER_CANCEL_STALE_MINUTES * 60_000) continue;

    const result = await cancelPolymarketOrder(orderId);
    if (!result.success) {
      log.warn(`Untracked stale order cancel failed for ${orderId}: ${result.error || 'unknown error'}`);
      continue;
    }

    cancelledUntracked++;
    const side = String(order?.side || order?.order_side || '?').toUpperCase();
    const size = order?.size ?? order?.original_size ?? order?.remaining_size ?? '?';
    const price = order?.price ?? order?.order_price ?? '?';
    log.info(`Canceled untracked stale open order ${orderId}: ${side} ${size} @${price}`);
  }

  if (cancelledUntracked > 0) {
    appendDailyLog(`CANCELLED: ${cancelledUntracked} untracked stale open order(s) >${ORDER_CANCEL_STALE_MINUTES}m`);
    log.info(`Canceled ${cancelledUntracked} untracked stale open order(s) older than ${ORDER_CANCEL_STALE_MINUTES}m`);
  }
}
