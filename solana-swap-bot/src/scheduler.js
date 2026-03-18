// src/scheduler.js — Cron-based task scheduler
import { CronJob } from 'cron';
import { config, getStrategyHardMaxSol } from './config.js';
import { createLogger } from './logger.js';

const log = createLogger('scheduler');
import { getPrices, getAllPriceChanges, findDivergencePairs } from './skills/priceScanner.js';
import { findArbitrageOpportunities } from './skills/arbitrageFinder.js';
import { scanTweets } from './skills/tweetScanner.js';
import { getWalletBalances } from './skills/portfolioTracker.js';
import { confirmTransaction } from './wallet.js';
import { riskManager } from './skills/riskManager.js';
import { executeSwap } from './skills/tradeExecutor.js';
import { analyzeAndDecide, validateDecision, generateDailyReport } from './ai.js';
import {
  appendEvent,
  readTodayEvents,
  appendLongTermMemory,
  addTrade,
  updatePendingTrade,
  getPendingTradesByAge,
  setAiMemo,
  getAiMemo,
  addTickMetric,
  getLastHoldStreakValue,
  getTokenPerformanceRuntime,
} from './runtimeStore.js';
import { runHealthChecks } from './health.js';
import { fetchWithTimeout } from './http.js';
import {
  openPosition, confirmPosition, resolvePosition,
  getPendingPositions, getStalePendingPositions, getAllPositions, pruneHistory,
} from './positionTracker.js';

// Store latest data for the API
export const state = {
  lastPrices: {},
  lastPriceChanges: {},
  lastArbitrage: [],
  lastTriangularArbitrage: [],
  lastRouteMap: {},
  lastArbRateMap: {},
  lastDivergence: null,
  lastFailedSequences: [],   // [{group, completed: [...], failed: {...}, cancelled: [...], ts}]
  lastLimitCancelled: [],     // [{group, completed, timedOut, cancelled, ts}] — arb legs cancelled due to limit timeout
  rejectedCombos: [],         // [{dex, pair, reason, ts}] — combos to avoid (sent to AI)
  lastTweets: [],
  lastRegime: null,
  lastWallet: null,
  lastDecision: null,
  lastHealth: null,
  lastTick: null,
  running: false,
  initialized: false, // true after initial scan sequence completes
  pendingSellOff: null,       // token symbol being sold off — persists across ticks
  priceHistory: [],           // [{ts, prices: {SYM: price}}] — rolling 1h window for m10/m30
  lastTickTrades: [],         // [{outputSym, entryPriceUsd, amountSol, pair, strategy, type}] — for LTO computation
};

// ─── Helper: find closest price snapshot ────────────────────────────────────

/**
 * Find the price of a symbol from the snapshot closest to targetTs.
 * Returns null if no snapshot within ±5 min of target.
 */
function findClosestSnapshot(history, targetTs, sym) {
  let bestDiff = Infinity;
  let bestPrice = null;
  for (const snap of history) {
    const diff = Math.abs(snap.ts - targetTs);
    if (diff < bestDiff && snap.prices[sym] != null) {
      bestDiff = diff;
      bestPrice = snap.prices[sym];
    }
  }
  // Only return if we have a snapshot within 5 minutes of the target
  return bestDiff <= 5 * 60 * 1000 ? bestPrice : null;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function average(values) {
  if (!values.length) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function detectRegime(priceChanges) {
  const rows = Object.values(priceChanges || {}).filter(c =>
    c && Number.isFinite(Number(c.h1)) && Number.isFinite(Number(c.h24))
  );

  if (!rows.length) {
    return {
      mode: 'chop',
      vol: 'medium',
      breadthH1: 0.5,
      avgH24: 0,
      rvH1: 0,
      dMul: 0.9,
      gMul: 0.95,
      cMul: 0.93,
    };
  }

  const h1 = rows.map(r => Number(r.h1) || 0);
  const h24 = rows.map(r => Number(r.h24) || 0);
  const breadthH1 = h1.filter(v => v > 0).length / h1.length;
  const avgH24 = average(h24);
  const rvH1 = average(h1.map(v => Math.abs(v)));

  let mode = 'chop';
  if (breadthH1 >= 0.65 && avgH24 > 0) mode = 'risk-on';
  else if (breadthH1 <= 0.35 && avgH24 < 0) mode = 'risk-off';

  let vol = 'medium';
  if (rvH1 < 1.5) vol = 'low';
  else if (rvH1 >= 4.0) vol = 'high';

  const volMul = vol === 'low' ? 1.1 : vol === 'high' ? 0.75 : 1.0;
  const degenModeMul = mode === 'risk-on' ? 1.2 : mode === 'risk-off' ? 0.5 : 0.9;
  const guardModeMul = mode === 'risk-on' ? 1.0 : mode === 'risk-off' ? 0.75 : 0.95;

  const dMul = clamp(degenModeMul * volMul, 0.35, 1.25);
  const gMul = clamp(guardModeMul * (vol === 'high' ? 0.85 : vol === 'low' ? 1.05 : 1.0), 0.5, 1.15);
  const cMul = clamp((dMul * config.risk.degenShare) + (gMul * config.risk.guardianShare), 0.45, 1.2);

  return {
    mode,
    vol,
    breadthH1: +breadthH1.toFixed(3),
    avgH24: +avgH24.toFixed(2),
    rvH1: +rvH1.toFixed(2),
    dMul: +dMul.toFixed(3),
    gMul: +gMul.toFixed(3),
    cMul: +cMul.toFixed(3),
  };
}

/**
 * Build focused tweet searches from a token pair.
 * Returns 3 queries: "A B", "A", "B".
 */
function buildTweetSearchTerms(filteredArbitrage, filteredDivergence) {
  let coinA = '';
  let coinB = '';

  const topArb = filteredArbitrage?.[0];
  if (topArb?.inputSymbol && topArb?.outputSymbol) {
    coinA = String(topArb.inputSymbol).trim();
    coinB = String(topArb.outputSymbol).trim();
  }

  if (!coinA || !coinB) {
    const topDiv = filteredDivergence?.pairs?.[0];
    if (topDiv?.up && topDiv?.down) {
      coinA = String(topDiv.up).trim();
      coinB = String(topDiv.down).trim();
    }
  }

  if (!coinA || !coinB) return [];
  if (coinA.toUpperCase() === coinB.toUpperCase()) return [coinA];

  return [`${coinA} ${coinB}`, coinA, coinB];
}

// ─── Trading Loop ───────────────────────────────────────────────────────────

async function tradingLoop() {
  if (!state.initialized) { log.warn('Init not done, skipping trading tick'); return; }
  if (state.running) { log.warn('Trading loop already running, skipping tick'); return; }
  state.running = true;
  const tickStart = Date.now();

  try {
    log.info('═══ TRADING LOOP TICK ═══');

    // 1. Health check
    state.lastHealth = await runHealthChecks();
    if (!state.lastHealth.healthy) {
      const failed = state.lastHealth.checks.filter(c => !c.ok).map(c => c.name);
      appendEvent(`HEALTH_FAIL — ${failed.join(', ')}`);
      log.error(`Health check failed, skipping tick: ${failed.join(', ')}`);
      return;
    }

    // 1b. Tick per-strategy cooldowns (must happen before any trade checks)
    riskManager.tickCooldowns();

    // 2. Wallet balance
    state.lastWallet = await getWalletBalances();
    riskManager.updateBalance(state.lastWallet.totalValueSol);
    if (riskManager.initialBalance === 0) {
      riskManager.setBalance(state.lastWallet.totalValueSol);
    }

    // 2a. Early daily limit check — skip expensive API calls if limit already hit
    const dailyLimit = riskManager.isDailyLimitReached();
    if (dailyLimit.limitReached) {
      appendEvent(`DAILY_LIMIT — ${dailyLimit.reason}`);
      log.info(`Skipping tick: ${dailyLimit.reason}`);
      return;
    }

    // 2b. Token-limit check — only count whitelisted holdings (excl. USDC)
    const usdcMint = config.watchedTokens.USDC;
    const solMint  = config.watchedTokens.SOL;
    const _mintToSym = Object.fromEntries(
      Object.entries(config.watchedTokens).map(([s, m]) => [m, s])
    );
    const heldSymbols = [];
    if ((state.lastWallet?.solBalance || 0) > 0.001) heldSymbols.push('SOL');
    for (const [mint, info] of Object.entries(state.lastWallet?.tokens || {})) {
      if (mint === usdcMint || mint === solMint) continue; // USDC=cash, SOL counted above
      const sym = _mintToSym[mint];
      if (!sym) continue;                              // ignore scam/unknown tokens
      if (info.valueUsd > 0.01) heldSymbols.push(sym);
    }

    let sellOff = null;
    const overLimit = heldSymbols.length > config.risk.maxHeldTokens;
    if (state.pendingSellOff && heldSymbols.includes(state.pendingSellOff)) {
      // Continue selling the same token until it's fully gone from wallet
      sellOff = { token: state.pendingSellOff, held: heldSymbols, count: heldSymbols.length };
      log.info(`Sell-off: continuing ${state.pendingSellOff} (${heldSymbols.length}/${config.risk.maxHeldTokens} tokens)`);
    } else if (overLimit) {
      // Over limit, no pending — let AI choose which to sell
      sellOff = { token: null, held: heldSymbols, count: heldSymbols.length };
      log.info(`Sell-off: ${heldSymbols.length}/${config.risk.maxHeldTokens} tokens — AI will choose`);
      state.pendingSellOff = null;
    } else {
      state.pendingSellOff = null;                     // under limit, clear
    }

    // 3. Price scan
    state.lastPrices = await getPrices();

    // 3b. Store price snapshot for m10/m30 computation
    state.priceHistory.push({ ts: Date.now(), prices: { ...state.lastPrices } });
    // Keep only last 1 hour of snapshots
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    state.priceHistory = state.priceHistory.filter(s => s.ts >= oneHourAgo);
    log.debug(`Price history: ${state.priceHistory.length} snapshots`);

    // 4. Price changes (multi-timeframe: m5, h1, h6, h24 from DexScreener + m10/m30 computed)
    state.lastPriceChanges = await getAllPriceChanges();

    // 4a. Compute m10 and m30 from own price history and merge into priceChanges
    const now = Date.now();
    for (const sym of Object.keys(state.lastPrices)) {
      const currentPrice = state.lastPrices[sym];
      if (!currentPrice || currentPrice <= 0) continue;
      if (!state.lastPriceChanges[sym]) state.lastPriceChanges[sym] = {};
      const pc = state.lastPriceChanges[sym];

      // Find closest snapshot to 10 min ago
      const target10 = now - 10 * 60 * 1000;
      const target30 = now - 30 * 60 * 1000;

      const snap10 = findClosestSnapshot(state.priceHistory, target10, sym);
      const snap30 = findClosestSnapshot(state.priceHistory, target30, sym);

      if (snap10 != null && snap10 > 0) {
        pc.m10 = +((currentPrice - snap10) / snap10 * 100).toFixed(2);
      }
      if (snap30 != null && snap30 > 0) {
        pc.m30 = +((currentPrice - snap30) / snap30 * 100).toFixed(2);
      }
    }

    // 4b. Divergence pairs — tokens moving in opposite directions
    state.lastDivergence = findDivergencePairs(state.lastPriceChanges);

    // 5. Arbitrage scan — all pairs (SOL⇄JUP, USDC⇄BONK, JUP⇄WIF, etc.)
    const arbResult = await findArbitrageOpportunities(state.lastPrices, 10);
    state.lastArbitrage = arbResult.opportunities;
    state.lastTriangularArbitrage = arbResult.triangularOpportunities || [];
    state.lastRouteMap = arbResult.routeMap;
    state.lastArbRateMap = arbResult.rateMap || {};

    // 5b. Build wallet holdings set — tokens the wallet actually holds
    //     Used to filter arb/divergence proposals so AI only sees actionable data.
    const _mintToSymAll = Object.fromEntries(
      Object.entries(config.watchedTokens).map(([s, m]) => [m, s])
    );
    const walletHoldings = new Set(); // SYM names of tokens we actually hold
    if ((state.lastWallet?.solBalance || 0) > 0.001) walletHoldings.add('SOL');
    for (const [mint, info] of Object.entries(state.lastWallet?.tokens || {})) {
      const sym = _mintToSymAll[mint];
      if (!sym) continue;
      if ((info.amount || 0) > 0 && (info.valueUsd || 0) > 0.01) walletHoldings.add(sym);
    }
    // USDC is always tradeable (it's our primary cash reserve)
    if ((state.lastWallet?.tokens?.[config.watchedTokens.USDC]?.amount || 0) > 0) {
      walletHoldings.add('USDC');
    }
    log.info(`Wallet holdings: [${[...walletHoldings].join(', ')}] (${walletHoldings.size} tokens)`);

    // 5c. Filter arb opportunities — only keep opps where we hold the inputToken
    //     For 2-leg arb: we need to hold the token we sell on leg 1 (inputSymbol)
    let filteredArbitrage = (state.lastArbitrage || []).filter(opp => {
      if (!walletHoldings.has(opp.inputSymbol)) {
        log.debug(`Arb filtered out: ${opp.pair} — not holding ${opp.inputSymbol}`);
        return false;
      }
      return true;
    });
    //     For 3-leg arb: we need to hold the token at leg 1 start
    let filteredTriArbitrage = (state.lastTriangularArbitrage || []).filter(opp => {
      const startSym = opp.path?.split('→')[0];
      if (startSym && !walletHoldings.has(startSym)) {
        log.debug(`3-leg arb filtered out: ${opp.path} — not holding ${startSym}`);
        return false;
      }
      return true;
    });

    // 5d. Filter divergence pairs — only keep pairs where we hold the "up" token
    //     (divergence strategy = sell up token to buy down token)
    const filteredDivergence = state.lastDivergence
      ? {
          ...state.lastDivergence,
          pairs: (state.lastDivergence.pairs || []).filter(d => {
            if (!walletHoldings.has(d.up)) {
              log.debug(`Divergence filtered out: ${d.up}/${d.down} — not holding ${d.up}`);
              return false;
            }
            return true;
          }),
        }
      : null;

    if (state.lastArbitrage?.length !== filteredArbitrage.length) {
      log.info(`Arb filter: ${state.lastArbitrage.length} → ${filteredArbitrage.length} (removed ${state.lastArbitrage.length - filteredArbitrage.length} not in wallet)`);
    }
    if (state.lastTriangularArbitrage?.length !== filteredTriArbitrage.length) {
      log.info(`3-leg arb filter: ${state.lastTriangularArbitrage.length} → ${filteredTriArbitrage.length} (removed ${state.lastTriangularArbitrage.length - filteredTriArbitrage.length} not in wallet)`);
    }

    // 5g. Deterministic arb execution — auto-execute strong arbs without AI (11.1)
    const autoArbMin = config.arb?.autoArbMinSpreadPct || 5.0;
    const autoArbTrades = []; // trades built here, executed after step 5g
    const strongArbs = filteredArbitrage.filter(a => a.spreadPct >= autoArbMin);
    const strongTriArbs = filteredTriArbitrage.filter(a => a.spreadPct >= autoArbMin);

    if (strongArbs.length || strongTriArbs.length) {
      log.info(`Auto-arb (11.1): ${strongArbs.length} 2-leg + ${strongTriArbs.length} 3-leg above ${autoArbMin}% threshold`);
      const symToMint = config.watchedTokens;
      const walletSol = state.lastWallet?.totalValueSol || 0;
      const autoArbStrategy = config.risk.degenEnabled ? 'degen' : 'guardian';
      const autoArbMax = getStrategyHardMaxSol(walletSol, autoArbStrategy);
      let seqGroupId = 100; // start high to avoid collision with AI-generated groups

      for (const opp of strongArbs) {
        const sg = seqGroupId++;
        autoArbTrades.push(
          {
            strategy: autoArbStrategy, type: 'arbitrage',
            inputToken: opp.inputSymbol, outputToken: opp.outputSymbol,
            inputMint: opp.inputMint, outputMint: opp.outputMint,
            amountSol: Math.min(autoArbMax, walletSol * 0.05),
            reason: `Auto-arb: ${opp.pair} ${opp.spreadPct}% net via ${opp.buyDex}→${opp.sellDex}`,
            slippageBps: config.arb?.slippageBps || 30,
            dex: opp.buyDex, sequenceGroup: sg,
          },
          {
            strategy: autoArbStrategy, type: 'arbitrage',
            inputToken: opp.outputSymbol, outputToken: opp.inputSymbol,
            inputMint: opp.outputMint, outputMint: opp.inputMint,
            amountSol: Math.min(autoArbMax, walletSol * 0.05),
            reason: `Auto-arb: ${opp.pair} ${opp.spreadPct}% net sell@${opp.sellDex}`,
            slippageBps: config.arb?.slippageBps || 30,
            dex: opp.sellDex, sequenceGroup: sg,
          },
        );
      }

      for (const opp of strongTriArbs) {
        const sg = seqGroupId++;
        const legs = [opp.leg1, opp.leg2, opp.leg3];
        const pathSyms = opp.path.split('→');
        for (let li = 0; li < 3; li++) {
          const leg = legs[li];
          const inSym = pathSyms[li];
          const outSym = pathSyms[li + 1];
          autoArbTrades.push({
            strategy: autoArbStrategy, type: 'arbitrage',
            inputToken: inSym, outputToken: outSym,
            inputMint: leg.inputMint, outputMint: leg.outputMint,
            amountSol: Math.min(autoArbMax, walletSol * 0.05),
            reason: `Auto-arb: ${opp.path} ${opp.spreadPct}% net leg ${li + 1}`,
            slippageBps: config.arb?.slippageBps || 30,
            dex: leg.dex, sequenceGroup: sg,
          });
        }
      }

      // Execute auto-arb trades directly
      if (autoArbTrades.length) {
        log.info(`Auto-arb: executing ${autoArbTrades.length} trade legs (${strongArbs.length} 2-leg + ${strongTriArbs.length} 3-leg)`);
        await executeTradeDecision(autoArbTrades);
        appendEvent(`AUTO_ARB — ${strongArbs.length} 2-leg + ${strongTriArbs.length} 3-leg (≥${autoArbMin}% spread)`);

        // Record for LTO
        for (const t of autoArbTrades) {
          state.lastTickTrades.push({
            outputSym: t.outputToken,
            entryPriceUsd: state.lastPrices[t.outputToken] || 0,
            amountSol: t.amountSol,
            pair: `${t.inputToken}→${t.outputToken}`,
            strategy: t.strategy,
            type: t.type,
          });
        }
      }

      // Remove auto-executed arbs from data sent to AI
      filteredArbitrage = filteredArbitrage.filter(a => a.spreadPct < autoArbMin);
      filteredTriArbitrage = filteredTriArbitrage.filter(a => a.spreadPct < autoArbMin);
    }

    // 6. Tweets — fetch recent social signals from external scraper
    const tweetSearchTerms = buildTweetSearchTerms(filteredArbitrage, filteredDivergence);
    if (tweetSearchTerms.length) {
      log.info(`Tweet search focus: ${tweetSearchTerms.join(' | ')}`);
    }

    const rawTweets = await scanTweets(120, 20, tweetSearchTerms).catch(err => {
      log.warn(`Tweet scan failed: ${err.message}`);
      return [];
    });
    state.lastTweets = rawTweets;
    log.info(`Tweets: ${rawTweets.length} (2h)`);
    // 5e. Compute Last Tick Outcome (LTO) — unrealized PnL feedback for AI
    const lto = [];
    for (const lt of state.lastTickTrades) {
      const currentPrice = state.lastPrices[lt.outputSym];
      if (currentPrice && lt.entryPriceUsd && lt.entryPriceUsd > 0) {
        const pnlPct = +((currentPrice - lt.entryPriceUsd) / lt.entryPriceUsd * 100).toFixed(2);
        lto.push({
          p: lt.pair,
          s: lt.strategy?.[0],
          ty: lt.type,
          sol: lt.amountSol,
          entry: +lt.entryPriceUsd.toPrecision(4),
          now: +currentPrice.toPrecision(4),
          pnl: pnlPct,
        });
      }
    }
    if (lto.length) {
      log.info(`LTO: ${lto.length} trade outcome(s) from last tick — ${lto.map(l => `${l.p} ${l.pnl > 0 ? '+' : ''}${l.pnl}%`).join(', ')}`);
    }

    // 5f. Compute per-token historical performance (7.2)
    const _mintToSymTP = Object.fromEntries(
      Object.entries(config.watchedTokens).map(([s, m]) => [m, s])
    );
    const tokenPerfRaw = getTokenPerformanceRuntime();
    const tokenPerf = {};
    for (const row of tokenPerfRaw) {
      const sym = _mintToSymTP[row.output_mint];
      if (!sym || sym === 'SOL' || sym === 'USDC') continue;
      const entry = { t: row.cnt };
      if (row.rated > 0) {
        entry.w = Math.round(row.wins / row.rated * 100);
      }
      if (row.avg_pnl_pct != null) entry.avg = row.avg_pnl_pct;
      if (row.last_ts) {
        const agoMs = Date.now() - new Date(row.last_ts).getTime();
        const agoH = Math.round(agoMs / 3600000);
        entry.last = agoH < 24 ? `${agoH}h` : `${Math.round(agoH / 24)}d`;
      }
      tokenPerf[sym] = entry;
    }
    if (Object.keys(tokenPerf).length) {
      log.info(`Token perf: ${Object.keys(tokenPerf).length} tokens with history`);
    }

    // Build constraints bundle for AI (C field) with regime + volatility scaling
    const cWalletSol = state.lastWallet?.totalValueSol || 0;
    const usdcBal = state.lastWallet?.tokens?.[usdcMint]?.amount || 0;
    const regime = detectRegime(state.lastPriceChanges);
    state.lastRegime = regime;
    const dBase = getStrategyHardMaxSol(cWalletSol, 'degen');
    const gBase = getStrategyHardMaxSol(cWalletSol, 'guardian');
    const dHard = +dBase.toFixed(4);
    const gHard = +gBase.toFixed(4);
    const cHard = +(dHard + gHard).toFixed(4);
    const dMax = +Math.min(dHard, dBase * regime.dMul).toFixed(4);
    const gMax = +Math.min(gHard, gBase * regime.gMul).toFixed(4);
    const cMax = +(dMax + gMax).toFixed(4);

    log.info(`Regime: ${regime.mode} | vol=${regime.vol} | breadth=${regime.breadthH1} | rvH1=${regime.rvH1} | caps d=${dMax} g=${gMax} c=${cMax}`);

    const constraints = {
      dMax,
      gMax,
      cMax,
      dBase: dHard,
      gBase: gHard,
      dHard,
      gHard,
      cHard,
      dOn: !!config.risk.degenEnabled,
      gOn: !!config.risk.guardianEnabled,
      dPct: config.risk.degenSharePct,
      gPct: config.risk.guardianSharePct,
      dCool: riskManager.degenCooldownTicks,
      gCool: riskManager.guardianCooldownTicks,
      rg: regime.mode,
      vol: regime.vol,
      dMul: regime.dMul,
      gMul: regime.gMul,
      cMul: regime.cMul,
      maxT: config.risk.maxTradesPerTick || 2,
      usdcBal: +usdcBal.toFixed(4),
      usdcReserve: config.usdcReserve,
      sellOff: !!sellOff,
      banned: getActiveRejectedCombos().length,
    };

    const context = {
      wallet: state.lastWallet,
      prices: state.lastPrices,
      priceChanges: state.lastPriceChanges,
      arbitrage: filteredArbitrage,
      triangularArbitrage: filteredTriArbitrage,
      routeMap: state.lastRouteMap,
      tweets: rawTweets,
      recentTrades: riskManager.getRecentTrades(30),
      divergence: filteredDivergence,
      failedSequences: state.lastFailedSequences,
      limitCancelled: state.lastLimitCancelled,
      rejectedCombos: getActiveRejectedCombos(),
      sellOff,
      memo: getAiMemo(),
      lto,
      regime,
      constraints,
      tokenPerf,
    };

    const decision = await analyzeAndDecide(context);
    state.lastDecision = decision;

    // 6a. Save AI working memory (memo) for next tick
    if (decision.memo) {
      setAiMemo(decision.memo);
    }

    // 6a2. Validate trade decision with second AI (1.1)
    if (decision.action === 'trade' && decision.trades?.length) {
      const validation = await validateDecision(decision._marketData || '', decision);
      if (validation.verdict === 'reject') {
        log.warn(`Validator rejected ${decision.trades.length} trade(s) — falling back to hold`);
        appendEvent(`VALIDATOR_REJECT — ${validation.reasoning}`);
        decision.action = 'hold';
        decision.trades = [];
        decision.reasoning += ` [VALIDATOR REJECTED: ${validation.reasoning}]`;
      }
    }
    delete decision._marketData; // Clean up internal field

    // 6b. Map AI symbol names → mint addresses (schema uses symbols, not mints)
    const symToMint = config.watchedTokens;
    if (decision.trades?.length) {
      for (const t of decision.trades) {
        t.inputMint  = symToMint[t.inputToken]  || t.inputToken;
        t.outputMint = symToMint[t.outputToken] || t.outputToken;
      }
    }

    // 6c. Server-side trade optimizer — combine duplicate / chained pairs to save fees
    if (decision.action === 'trade' && decision.trades?.length > 1) {
      decision.trades = optimizeTrades(decision.trades);
    }

    // 7. Execute trades — process each sequenceGroup atomically
    if (decision.action === 'trade' && decision.trades?.length) {
      await executeTradeDecision(decision.trades);
      // Clear failed sequences / limit cancellations after AI has seen them
      state.lastFailedSequences = [];
      state.lastLimitCancelled = [];

      // 7a. Record executed trades for LTO computation next tick
      state.lastTickTrades = decision.trades.map(t => ({
        outputSym: t.outputToken,
        entryPriceUsd: state.lastPrices[t.outputToken] || 0,
        amountSol: t.amountSol,
        pair: `${t.inputToken}→${t.outputToken}`,
        strategy: t.strategy,
        type: t.type,
      }));

      // 7b. Track sell-off token chosen by AI
      if (sellOff) {
        for (const t of decision.trades) {
          if (t.outputMint === usdcMint
              && t.inputMint !== solMint && t.inputMint !== usdcMint) {
            const sym = _mintToSym[t.inputMint];
            if (sym) {
              state.pendingSellOff = sym;
              log.info(`Sell-off tracking: ${sym} → USDC`);
              break;
            }
          }
        }
      }
    } else {
      state.lastTickTrades = []; // No trades this tick — clear LTO
      const priceSummary = Object.entries(state.lastPrices)
        .map(([s, p]) => `${s} $${p}`)
        .join(', ');
      appendEvent(`HEARTBEAT_OK — ${priceSummary}`);
    }

    state.lastTick = new Date().toISOString();
    log.info(`Tick completed in ${Date.now() - tickStart}ms`);

    // 8. Save tick metrics (9.2)
    {
      const action = (decision.action === 'trade' && decision.trades?.length) ? 'trade' : 'hold';
      const tradeCount = action === 'trade' ? decision.trades.length : 0;
      const arbAvailable = (filteredArbitrage?.length || 0) + (filteredTriArbitrage?.length || 0);
      const arbTaken = action === 'trade'
        ? decision.trades.filter(t => t.type === 'arbitrage').length
        : 0;
      const prevStreak = getLastHoldStreakValue();
      const holdStreak = action === 'hold' ? prevStreak + 1 : 0;

      // Win rate by type from this tick's trades (only those with pnl info)
      const byType = {};
      if (action === 'trade') {
        for (const t of decision.trades) {
          if (!byType[t.type]) byType[t.type] = { n: 0 };
          byType[t.type].n++;
        }
      }

      addTickMetric({
        tickTs: state.lastTick,
        action,
        tradeCount,
        arbAvailable,
        arbTaken,
        holdStreak,
        latencyMs: Date.now() - tickStart,
        data: Object.keys(byType).length ? { byType } : null,
      });
    }

  } catch (err) {
    log.error(`Trading loop error: ${err.message}`);
    appendEvent(`ERROR — ${err.message}`);
  } finally {
    state.running = false;
  }
}

// ─── Trade Optimizer — combine duplicate / chained pairs to save fees ─────────

/**
 * Optimize the AI's trade list by merging standalone trades that share the same
 * pair or form a chain (A→B + B→C = A→C). Sequence groups (arb legs) are never
 * touched. Combined amount is capped at the combined strategy max.
 */
function optimizeTrades(trades) {
  const mintToSym = Object.fromEntries(
    Object.entries(config.watchedTokens).map(([s, m]) => [m, s])
  );

  // Build a quick lookup: "SYM→SYM" → [dex, …] from the route map
  const routeMap = state.lastRouteMap || {};

  // Pass 0: Flatten single-leg sequence groups to standalone.
  // If the AI put a trade in a sequenceGroup but no other trade shares that group,
  // it's effectively standalone and should participate in the merge passes below.
  const seqCount = new Map();
  for (const t of trades) {
    const g = t.sequenceGroup || 0;
    if (g > 0) seqCount.set(g, (seqCount.get(g) || 0) + 1);
  }
  for (const t of trades) {
    const g = t.sequenceGroup || 0;
    if (g > 0 && seqCount.get(g) === 1) {
      log.info(`Trade optimizer: flattened orphan seq=${g} (${mintToSym[t.inputMint] || '?'}→${mintToSym[t.outputMint] || '?'}) to standalone`);
      t.sequenceGroup = 0;
    }
  }

  // Separate sequence trades (arb legs) from standalone trades — only optimize standalone
  const seqTrades = trades.filter(t => (t.sequenceGroup || 0) > 0);
  let standalone  = trades.filter(t => (t.sequenceGroup || 0) === 0);

  if (standalone.length < 2) return trades; // nothing to combine

  // Calculate combined hard max for clamping merged trades
  const walletSol = state.lastWallet?.totalValueSol || 0;
  const combinedHardMax = getStrategyHardMaxSol(walletSol, 'combined');
  const combinedEnabled = config.risk.degenEnabled && config.risk.guardianEnabled;
  const activeSingleStrategy = config.risk.degenEnabled ? 'degen' : 'guardian';

  let changed = false;

  // Pass 0b: Cancel round-trips and net-zero chains (4.3)
  // Round-trip: A→B + B→A among standalone trades — cancel both
  {
    const rtRemove = new Set();
    for (let i = 0; i < standalone.length; i++) {
      if (rtRemove.has(i)) continue;
      for (let j = i + 1; j < standalone.length; j++) {
        if (rtRemove.has(j)) continue;
        if (standalone[i].inputMint === standalone[j].outputMint &&
            standalone[i].outputMint === standalone[j].inputMint) {
          const fwd = `${mintToSym[standalone[i].inputMint] || '?'}→${mintToSym[standalone[i].outputMint] || '?'}`;
          log.info(`Trade optimizer: cancelled round-trip ${fwd} (buy then sell same token in one tick)`);
          appendEvent(`ROUND_TRIP_CANCEL — ${fwd}`);
          rtRemove.add(i);
          rtRemove.add(j);
          changed = true;
        }
      }
    }
    // Net-zero 3-leg chain: A→B + B→C + C→A among standalone trades — cancel all 3
    if (standalone.length >= 3) {
      for (let i = 0; i < standalone.length; i++) {
        if (rtRemove.has(i)) continue;
        for (let j = i + 1; j < standalone.length; j++) {
          if (rtRemove.has(j)) continue;
          if (standalone[i].outputMint !== standalone[j].inputMint) continue;
          for (let k = j + 1; k < standalone.length; k++) {
            if (rtRemove.has(k)) continue;
            if (standalone[j].outputMint === standalone[k].inputMint &&
                standalone[k].outputMint === standalone[i].inputMint) {
              const path = `${mintToSym[standalone[i].inputMint] || '?'}→${mintToSym[standalone[j].inputMint] || '?'}→${mintToSym[standalone[k].inputMint] || '?'}→${mintToSym[standalone[i].inputMint] || '?'}`;
              log.info(`Trade optimizer: cancelled net-zero chain ${path}`);
              appendEvent(`NET_ZERO_CANCEL — ${path}`);
              rtRemove.add(i);
              rtRemove.add(j);
              rtRemove.add(k);
              changed = true;
            }
          }
        }
      }
    }
    if (rtRemove.size > 0) {
      standalone = standalone.filter((_, i) => !rtRemove.has(i));
    }
  }

  if (standalone.length < 2) return [...standalone, ...seqTrades];

  // Pass 1: Merge same-pair trades (e.g. degen USDC→SOL + guardian USDC→SOL → combined USDC→SOL)
  const pairBuckets = new Map(); // "inputMint|outputMint" → [indices]
  for (let i = 0; i < standalone.length; i++) {
    const key = `${standalone[i].inputMint}|${standalone[i].outputMint}`;
    if (!pairBuckets.has(key)) pairBuckets.set(key, []);
    pairBuckets.get(key).push(i);
  }
  const removeIndices = new Set();
  for (const [, indices] of pairBuckets) {
    if (indices.length < 2) continue;
    // Merge all into the first trade
    const primary = standalone[indices[0]];
    let totalSol = primary.amountSol;
    const reasons = [primary.reason];
    const dexes = new Set();
    if (primary.dex) dexes.add(primary.dex);
    for (let k = 1; k < indices.length; k++) {
      const dup = standalone[indices[k]];
      totalSol += dup.amountSol;
      reasons.push(dup.reason);
      if (dup.dex) dexes.add(dup.dex);
      removeIndices.add(indices[k]);
    }
    // Cap at combined max
    primary.amountSol = Math.min(totalSol, combinedHardMax);
    primary.strategy = combinedEnabled ? 'combined' : activeSingleStrategy;
    primary.reason = reasons.join(' + ');
    // DEX: keep if all trades agree on the same DEX, otherwise let Jupiter auto-route
    if (dexes.size === 1) {
      primary.dex = [...dexes][0];
    } else {
      primary.dex = '';
    }
    const inSym  = mintToSym[primary.inputMint]  || '?';
    const outSym = mintToSym[primary.outputMint] || '?';
    log.info(`Trade optimizer: merged ${indices.length} same-pair trades ${inSym}→${outSym} into 1 ${primary.strategy} (${primary.amountSol.toFixed(4)} SOL, dex=${primary.dex || 'auto'})`);
    changed = true;
  }
  if (removeIndices.size > 0) {
    standalone = standalone.filter((_, i) => !removeIndices.has(i));
  }

  // Pass 2: Collapse chains (A→B + B→C → A→C) among remaining standalone trades
  // Only collapse when exactly 2 standalone trades form a chain and both are non-arb
  if (standalone.length === 2) {
    const [a, b] = standalone;
    let chain = null;
    if (a.outputMint === b.inputMint && a.outputMint !== a.inputMint) {
      chain = { first: a, second: b };
    } else if (b.outputMint === a.inputMint && b.outputMint !== b.inputMint) {
      chain = { first: b, second: a };
    }
    if (chain && chain.first.inputMint !== chain.second.outputMint) {
      const inSym  = mintToSym[chain.first.inputMint]   || '?';
      const midSym = mintToSym[chain.first.outputMint]  || '?';
      const outSym = mintToSym[chain.second.outputMint] || '?';

      // Verify the direct pair has a known route before collapsing
      const directPair = `${inSym}/${outSym}`;
      const reversePair = `${outSym}/${inSym}`;
      const directRoutes = routeMap[directPair] || routeMap[reversePair] || [];

      if (directRoutes.length > 0) {
        // Pick a DEX from the known routes (prefer whitelisted)
        const whitelistSet = new Set(config.compareDexes);
        const validDex = directRoutes.find(d => whitelistSet.has(d)) || '';

        const totalSol = Math.min(chain.first.amountSol + chain.second.amountSol, combinedHardMax);
        const merged = {
          ...chain.first,
          outputToken: chain.second.outputToken,
          outputMint:  chain.second.outputMint,
          amountSol:   totalSol,
          strategy:    combinedEnabled ? 'combined' : activeSingleStrategy,
          reason:      `Chain collapsed ${inSym}→${midSym}→${outSym}: ${chain.first.reason} + ${chain.second.reason}`,
          dex: validDex,
          sequenceGroup: 0,
        };
        standalone = [merged];
        log.info(`Trade optimizer: collapsed chain ${inSym}→${midSym}→${outSym} into direct ${inSym}→${outSym} (${totalSol.toFixed(4)} SOL, strategy=${merged.strategy}, dex=${validDex || 'auto'})`);
        changed = true;
      } else {
        log.info(`Trade optimizer: skipping chain collapse ${inSym}→${midSym}→${outSym} — no direct route for ${directPair}`);
      }
    }
  }

  if (!changed) return trades;

  let result = [...standalone, ...seqTrades];

  // Final safety net: deduplicate any remaining standalone trades with identical pair + dex
  const seen = new Map(); // "inputMint|outputMint|dex" → index in result
  const dupeRemove = new Set();
  for (let i = 0; i < result.length; i++) {
    const t = result[i];
    if ((t.sequenceGroup || 0) > 0) continue; // don't touch multi-leg sequences
    const key = `${t.inputMint}|${t.outputMint}|${t.dex || ''}`;
    if (seen.has(key)) {
      const pi = seen.get(key);
      const primary = result[pi];
      primary.amountSol = Math.min(primary.amountSol + t.amountSol, combinedHardMax);
      primary.strategy = combinedEnabled ? 'combined' : activeSingleStrategy;
      primary.reason = `${primary.reason} + ${t.reason}`;
      dupeRemove.add(i);
      const inSym  = mintToSym[t.inputMint]  || '?';
      const outSym = mintToSym[t.outputMint] || '?';
      log.info(`Trade optimizer (safety net): merged duplicate ${inSym}→${outSym} dex=${t.dex || 'auto'}`);
    } else {
      seen.set(key, i);
    }
  }
  if (dupeRemove.size > 0) {
    result = result.filter((_, i) => !dupeRemove.has(i));
  }

  log.info(`Trade optimizer: ${trades.length} trades → ${result.length} trades`);

  // Pass 3: Cap total trades at maxTradesPerTick (8.1)
  const maxTrades = config.risk.maxTradesPerTick || 2;
  if (result.length > maxTrades) {
    // Keep arb sequences intact — sort standalone by amountSol descending and truncate
    const seqs = result.filter(t => (t.sequenceGroup || 0) > 0);
    let stds = result.filter(t => (t.sequenceGroup || 0) === 0);
    stds.sort((a, b) => b.amountSol - a.amountSol);
    const budget = maxTrades - seqs.length;
    if (budget > 0 && stds.length > budget) {
      log.info(`Trade optimizer: truncating ${stds.length} standalone trades to ${budget} (maxTradesPerTick=${maxTrades}, ${seqs.length} sequence trades kept)`);
      stds = stds.slice(0, budget);
    }
    result = [...stds, ...seqs].slice(0, maxTrades);
  }

  return result;
}

// ─── Atomic SequenceGroup Execution ─────────────────────────────────────────

/**
 * Execute AI trade proposals grouped by sequenceGroup.
 * Each group is fully pre-validated (risk + SOL reserve + amounts) BEFORE any
 * trade in that group is executed. If any leg fails validation, the entire
 * group is cancelled. Groups are processed one at a time in order.
 */
async function executeTradeDecision(trades) {
  const mintToSymbol = Object.fromEntries(
    Object.entries(config.watchedTokens).map(([sym, mint]) => [mint, sym])
  );

  // ── Build ordered groups: preserve insertion order, group 0 items are individual ──
  const groupOrder = [];          // ordered unique group ids
  const groupMap = new Map();     // gid → [trade, ...]
  for (const trade of trades) {
    const gid = trade.sequenceGroup || 0;
    if (gid === 0) {
      // Each standalone trade is its own "group"
      const soloId = `solo_${groupOrder.length}`;
      groupOrder.push(soloId);
      groupMap.set(soloId, [trade]);
    } else {
      if (!groupMap.has(gid)) {
        groupOrder.push(gid);
        groupMap.set(gid, []);
      }
      groupMap.get(gid).push(trade);
    }
  }

  // ── Process each group atomically ──
  for (const gid of groupOrder) {
    const groupTrades = groupMap.get(gid);
    const isSequence = typeof gid === 'number' && gid > 0;
    const seqLabel = isSequence ? ` [seq=${gid}]` : '';

    // --- Phase 1: pre-validate ALL DEXes in the group before doing anything ---
    // This prevents starting a sequence where a later leg would be rejected.
    {
      let dexOk = true;
      for (const trade of groupTrades) {
        if (trade.dex && !config.compareDexes.includes(trade.dex)) {
          const inputSym  = mintToSymbol[trade.inputMint] || '?';
          const outputSym = mintToSymbol[trade.outputMint] || '?';
          const pairStr   = `${inputSym}→${outputSym}`;
          log.warn(`DEX rejected${seqLabel}: "${trade.dex}" is not in compareDexes whitelist`);
          appendEvent(`DEX_INVALID${seqLabel} — ${trade.dex} ${pairStr} | not in whitelist, cancelling group`);
          recordRejectedCombo(trade.dex, pairStr, 'DEX not in whitelist');
          dexOk = false;
          break;
        }
      }
      if (!dexOk) continue;
    }

    // --- Phase 2: clamp amounts & pre-validate ALL legs before executing any ---
    // Track simulated wallet balances to check if later legs are still possible
    // after earlier legs consume funds.
    const solPrice = state.lastPrices?.SOL || 0;
    let simWalletSol = state.lastWallet?.totalValueSol || 0;
    let simSolBalance = state.lastWallet?.solBalance || 0;
    let simUsdcBalance = state.lastWallet?.tokens?.[config.watchedTokens.USDC]?.amount || 0;
    let groupApproved = true;

    for (const trade of groupTrades) {

      // Clamp to hard max (SOL-denominated)
      const hardMax = getStrategyHardMaxSol(simWalletSol, trade.strategy);
      if (trade.amountSol > hardMax) {
        log.info(`Clamped ${trade.amountSol} SOL → ${Math.floor(hardMax * 10000) / 10000} SOL (${trade.strategy} hard max)`);
        trade.amountSol = Math.floor(hardMax * 10000) / 10000;
      }

      // Risk check (SOL-denominated)
      const riskResult = riskManager.checkTrade({ amountSol: trade.amountSol, strategy: trade.strategy });
      if (!riskResult.approved) {
        log.warn(`Risk rejected${seqLabel}: ${riskResult.reason}`);
        appendEvent(`REJECTED${seqLabel} — ${trade.reason} | ${riskResult.reason}`);
        groupApproved = false;
        break;
      }

      // SOL reserve check with simulated balance
      const inputSymbol = mintToSymbol[trade.inputMint];
      const outputSymbol = mintToSymbol[trade.outputMint];
      const inputPrice = inputSymbol && state.lastPrices?.[inputSymbol];
      const amountUsd = trade.amountSol * solPrice;
      if (inputSymbol === 'SOL') {
        if (simSolBalance - trade.amountSol < config.solReserve) {
          log.warn(`SOL reserve guard${seqLabel}: sim ${(simSolBalance - trade.amountSol).toFixed(4)} SOL < ${config.solReserve}`);
          appendEvent(`SOL_RESERVE${seqLabel} — ${trade.reason} | would breach reserve`);
          groupApproved = false;
          break;
        }
        simSolBalance -= trade.amountSol;
      } else if (inputSymbol === 'USDC' && outputSymbol !== 'USDC' && inputPrice && inputPrice > 0) {
        const usdcNeeded = amountUsd / inputPrice;
        if (simUsdcBalance - usdcNeeded < config.usdcReserve) {
          log.warn(`USDC reserve guard${seqLabel}: sim ${(simUsdcBalance - usdcNeeded).toFixed(2)} USDC < ${config.usdcReserve}`);
          appendEvent(`USDC_RESERVE${seqLabel} — ${trade.reason} | would breach reserve`);
          groupApproved = false;
          break;
        }
        simUsdcBalance -= usdcNeeded;
      }

      // Check amount converts to valid base units
      const decimals = config.tokenDecimals[trade.inputMint] ?? 9;
      // Convert SOL-notional amount to token amount via USD prices
      if (inputPrice && inputPrice > 0) {
        const baseUnits = Math.round((amountUsd / inputPrice) * 10 ** decimals);
        if (!baseUnits || baseUnits <= 0) {
          log.warn(`Invalid base units${seqLabel} for ${trade.reason}`);
          groupApproved = false;
          break;
        }
      }

      // Simulate wallet change in SOL
      simWalletSol -= trade.amountSol;
    }

    if (!groupApproved) {
      if (isSequence) {
        log.warn(`Sequence group ${gid} pre-validation failed — entire group cancelled`);
        appendEvent(`SEQ_CANCEL — group=${gid} | pre-validation failed`);
      }
      continue;
    }

    // --- Phase 2b: Compute limit prices from arb finder's original quotes ---
    // Uses the exact price ratios discovered during the arb scan so that limits
    // protect the spread.  Falls back to a fresh pre-quote (tight 99.9% floor)
    // only when the arb rateMap has no matching entry.
    let legLimits = null;
    if (isSequence && groupTrades[0]?.type === 'arbitrage') {
      legLimits = [];
      const rMap = state.lastArbRateMap || {};
      const qHeaders = { 'x-api-key': config.jupiterApiKey };

      const limitPromises = groupTrades.map(async (trade) => {
        const inSym  = mintToSymbol[trade.inputMint];
        const inPx   = inSym && state.lastPrices?.[inSym];
        const sp     = state.lastPrices?.SOL || 0;
        const dec    = config.tokenDecimals[trade.inputMint] ?? 9;
        const usd    = trade.amountSol * sp;
        let bu = 0;
        if (inPx && inPx > 0) bu = Math.round((usd / inPx) * 10 ** dec);
        if (bu <= 0) return 0;

        // Look up the arb finder's discovered rate for this exact mint+dex combo
        const rateKey = `${trade.inputMint}|${trade.outputMint}|${trade.dex || ''}`;
        const rate = rMap[rateKey];

        if (rate && rate.inAmount > 0) {
          // Scale the arb finder's ratio to the actual trade size
          const expectedOut = (rate.outAmount / rate.inAmount) * bu;
          const limit = Math.floor(expectedOut * 0.999); // 0.1% dust tolerance only
          log.info(`Arb limit (from finder rate): ${inSym}→${mintToSymbol[trade.outputMint] || '?'} on ${trade.dex || 'best'}: expect ${Math.round(expectedOut)}, limit ${limit}`);
          return limit;
        }

        // Fallback: fresh pre-quote with tight limit (no arb rate available)
        const qp = new URLSearchParams({
          inputMint: trade.inputMint,
          outputMint: trade.outputMint,
          amount: String(bu),
          slippageBps: String(trade.slippageBps || config.arb?.slippageBps || 30),
        });
        if (trade.dex) qp.set('dexes', trade.dex);
        try {
          const resp = await fetchWithTimeout(`${config.jupiterQuoteApi}?${qp}`, {
            headers: qHeaders,
            timeoutMs: config.httpTimeoutMs,
          });
          const q = await resp.json();
          const limit = q.outAmount ? Math.floor(parseInt(q.outAmount, 10) * 0.999) : 0;
          log.info(`Arb limit (fallback pre-quote): ${inSym}→${mintToSymbol[trade.outputMint] || '?'} on ${trade.dex || 'best'}: quote ${q.outAmount}, limit ${limit}`);
          return limit;
        } catch {
          return 0;
        }
      });

      legLimits = await Promise.all(limitPromises);
      log.info(`Arb limits: [${legLimits.join(', ')}]`);
    }

    // --- Phase 3: execute all legs in order; stop on first failure ---
    // Refresh wallet before execution to get latest balances for pre-trade checks
    let liveWallet;
    try {
      liveWallet = await getWalletBalances();
    } catch (err) {
      log.warn(`Failed to refresh wallet for pre-trade check: ${err.message}`);
      liveWallet = state.lastWallet; // fall back to last known
    }

    const completed = [];
    let failedLeg = null;
    const cancelled = [];

    for (let i = 0; i < groupTrades.length; i++) {
      const trade = groupTrades[i];
      const inputSymbol = mintToSymbol[trade.inputMint];
      const inputPrice = inputSymbol && state.lastPrices?.[inputSymbol];
      const solPrice = state.lastPrices?.SOL || 0;
      const decimals = config.tokenDecimals[trade.inputMint] ?? 9;
      let baseUnits = trade.amountLamports;
      // Convert amountSol → USD → token amount → base units
      const amountUsd = trade.amountSol * solPrice;
      if (inputPrice && inputPrice > 0) {
        baseUnits = Math.round((amountUsd / inputPrice) * 10 ** decimals);
        log.info(`Converted ${trade.amountSol} SOL (~$${amountUsd.toFixed(2)}) → ${baseUnits} base units (${inputSymbol} @ $${inputPrice})`);
      }

      // --- Pre-execution wallet balance check ---
      // Verify we actually hold enough of the inputToken before executing
      if (inputSymbol === 'SOL') {
        const liveSolBal = liveWallet?.solBalance || 0;
        if (trade.amountSol > liveSolBal - (config.solReserve || 0.05)) {
          log.warn(`Pre-exec check FAILED${seqLabel}: need ${trade.amountSol} SOL but wallet has ${liveSolBal.toFixed(4)} SOL (reserve ${config.solReserve})`);
          appendEvent(`BALANCE_CHECK${seqLabel} — need ${trade.amountSol} SOL, have ${liveSolBal.toFixed(4)} SOL`);
          failedLeg = { leg: i + 1, pair: `${inputSymbol}→${mintToSymbol[trade.outputMint] || '?'}`, dex: trade.dex || 'best-route', amountSol: trade.amountSol, error: 'insufficient_balance', reason: trade.reason, ...classifyError('insufficient_balance') };
          for (let j = i + 1; j < groupTrades.length; j++) {
            const ct = groupTrades[j];
            cancelled.push({ leg: j + 1, pair: `${mintToSymbol[ct.inputMint] || '?'}→${mintToSymbol[ct.outputMint] || '?'}`, dex: ct.dex || 'best-route', amountSol: ct.amountSol });
          }
          break;
        }
      } else if (inputSymbol === 'USDC' && mintToSymbol[trade.outputMint] !== 'USDC') {
        const tokenMint = trade.inputMint;
        const tokenInfo = liveWallet?.tokens?.[tokenMint];
        const tokenAmount = tokenInfo?.amount || 0;
        const usdcPrice = state.lastPrices?.USDC || 1;
        const usdcNeeded = amountUsd / usdcPrice;
        if (tokenAmount <= 0 || tokenAmount - usdcNeeded < (config.usdcReserve || 0)) {
          log.warn(`Pre-exec check FAILED${seqLabel}: need ${usdcNeeded.toFixed(2)} USDC but wallet has ${tokenAmount.toFixed(2)} USDC (reserve ${config.usdcReserve})`);
          appendEvent(`BALANCE_CHECK${seqLabel} — need ${usdcNeeded.toFixed(2)} USDC, have ${tokenAmount.toFixed(2)} USDC`);
          failedLeg = { leg: i + 1, pair: `${inputSymbol}→${mintToSymbol[trade.outputMint] || '?'}`, dex: trade.dex || 'best-route', amountSol: trade.amountSol, error: 'insufficient_balance', reason: trade.reason, ...classifyError('insufficient_balance') };
          for (let j = i + 1; j < groupTrades.length; j++) {
            const ct = groupTrades[j];
            cancelled.push({ leg: j + 1, pair: `${mintToSymbol[ct.inputMint] || '?'}→${mintToSymbol[ct.outputMint] || '?'}`, dex: ct.dex || 'best-route', amountSol: ct.amountSol });
          }
          break;
        }
      } else if (inputSymbol) {
        const tokenMint = trade.inputMint;
        const tokenInfo = liveWallet?.tokens?.[tokenMint];
        const tokenAmount = tokenInfo?.amount || 0;
        const tokenValueUsd = tokenInfo?.valueUsd || 0;
        const neededUsd = amountUsd;
        if (tokenAmount <= 0 || tokenValueUsd < neededUsd * 0.5) {
          log.warn(`Pre-exec check FAILED${seqLabel}: need ~$${neededUsd.toFixed(2)} of ${inputSymbol} but wallet has $${tokenValueUsd.toFixed(2)} (${tokenAmount} tokens)`);
          appendEvent(`BALANCE_CHECK${seqLabel} — need ~$${neededUsd.toFixed(2)} of ${inputSymbol}, have $${tokenValueUsd.toFixed(2)}`);
          failedLeg = { leg: i + 1, pair: `${inputSymbol}→${mintToSymbol[trade.outputMint] || '?'}`, dex: trade.dex || 'best-route', amountSol: trade.amountSol, error: 'insufficient_balance', reason: trade.reason, ...classifyError('insufficient_balance') };
          for (let j = i + 1; j < groupTrades.length; j++) {
            const ct = groupTrades[j];
            cancelled.push({ leg: j + 1, pair: `${mintToSymbol[ct.inputMint] || '?'}→${mintToSymbol[ct.outputMint] || '?'}`, dex: ct.dex || 'best-route', amountSol: ct.amountSol });
          }
          break;
        }
      }

      const dexLabel = trade.dex ? ` via ${trade.dex}` : '';
      log.info(`Executing${seqLabel}${dexLabel}: ${trade.strategy} ${trade.type} — ${trade.reason}`);
      log.debug(`Exec details: input=${inputSymbol} output=${mintToSymbol[trade.outputMint]||'?'} baseUnits=${baseUnits} slippage=${trade.slippageBps || config.arb?.slippageBps || 30} dex=${trade.dex||'auto'} limit=${legLimits?.[i]||0}`);

      let swapSlippage = trade.slippageBps || config.arb?.slippageBps || 30;
      let swapDex = trade.dex || '';
      let result = await executeSwap({
        inputMint: trade.inputMint,
        outputMint: trade.outputMint,
        amount: baseUnits,
        slippageBps: swapSlippage,
        dex: swapDex,
        ...(legLimits?.[i] > 0 && {
          minOutAmount: legLimits[i],
          limitTimeoutMs: config.arb?.limitTimeoutMs || 180000,
        }),
      });

      // --- Smart retry for standalone trades (Proposal 5.1) ---
      // Only retry standalone (non-sequence) trades with transient errors. Max 1 retry.
      if (!result.success && !isSequence && result.error !== 'limit_timeout') {
        const errLower = (result.error || '').toLowerCase();
        let retryReason = null;
        let retryDelay = 0;

        if (errLower.includes('slippage') || errLower.includes('slippagetolerance')) {
          // Double slippage and retry
          swapSlippage = Math.min(swapSlippage * 2, 300); // cap at 3%
          retryReason = `slippage (${trade.slippageBps || 30}→${swapSlippage} bps)`;
        } else if ((errLower.includes('liquidity') || errLower.includes('no route') || errLower.includes('no quotes')) && swapDex) {
          // Re-quote with auto-route (remove specific DEX)
          swapDex = '';
          retryReason = `liquidity on ${trade.dex} → auto-route`;
        } else if (errLower.includes('timeout') || errLower.includes('econnrefused') || errLower.includes('etimedout') || errLower.includes('fetch failed') || errLower.includes('network')) {
          retryReason = 'network/RPC error';
          retryDelay = 5000;
        }

        if (retryReason) {
          log.info(`Smart retry: ${retryReason} — retrying ${inputSymbol}→${mintToSymbol[trade.outputMint] || '?'} once...`);
          appendEvent(`SMART_RETRY — ${retryReason} | ${inputSymbol}→${mintToSymbol[trade.outputMint] || '?'}`);
          if (retryDelay > 0) await new Promise(r => setTimeout(r, retryDelay));
          result = await executeSwap({
            inputMint: trade.inputMint,
            outputMint: trade.outputMint,
            amount: baseUnits,
            slippageBps: swapSlippage,
            dex: swapDex,
          });
          log.debug(`Retry result: success=${result.success} sig=${result.signature||'none'} error=${result.error||'none'}`);
        }
      }

      log.debug(`Swap result: success=${result.success} sig=${result.signature||'none'} paper=${result.paperTrade||false} error=${result.error||'none'}`);

      if (result.success) {
        const outputSymbol = mintToSymbol[trade.outputMint] || '?';
        const tradePair = `${inputSymbol || '?'}→${outputSymbol}`;
        const isPaper = result.paperTrade || false;
        const outputPrice = (state.lastPrices?.[outputSymbol]) || 0;

        // --- Track this position in positionTracker ---
        let posId = null;
        if (result.signature && result.signature !== 'PAPER_TRADE_SIM') {
          posId = openPosition({
            signature: result.signature,
            inputToken: inputSymbol || '?',
            outputToken: outputSymbol,
            inputMint: trade.inputMint,
            outputMint: trade.outputMint,
            amountSol: trade.amountSol,
            dex: trade.dex || '',
            strategy: trade.strategy,
            type: trade.type,
            reason: trade.reason || '',
            sequenceGroup: gid,
            leg: i + 1,
            isSequence,
          });
          log.debug(`Position opened: ${posId} for sig=${result.signature}`);
        }

        // --- Record pending trade in runtime store immediately (before confirmation) ---
        if (result.signature && result.signature !== 'PAPER_TRADE_SIM') {
          addTrade({
            ...trade,
            signature: result.signature,
            paperTrade: false,
            pnlSol: 0,
            reason: trade.reason || '',
            inputPriceUsd: inputPrice || 0,
            outputPriceUsd: outputPrice,
            status: 'pending',
            timestamp: new Date().toISOString(),
          });
          log.debug(`Pending trade recorded in runtime store for sig=${result.signature}`);
        }

        // --- Confirm ALL real trades on-chain (standalone=60s, sequence=180s) ---
        if (result.signature && result.signature !== 'PAPER_TRADE_SIM') {
          const confirmTimeout = isSequence ? (config.arb?.limitTimeoutMs || 180000) : 60000;
          log.info(`Confirming tx${seqLabel} leg ${i + 1} ${tradePair} | sig=${result.signature} | timeout=${confirmTimeout / 1000}s...`);
          const confirmation = await confirmTransaction(
            result.signature,
            confirmTimeout,   // standalone=60s, sequence=180s
            5000,             // poll every 5s
          );
          log.debug(`Confirmation result: confirmed=${confirmation.confirmed} status=${confirmation.status} err=${JSON.stringify(confirmation.err||null)}`);

          if (!confirmation.confirmed) {
            const errReason = confirmation.status === 'failed'
              ? `tx_failed_onchain: ${JSON.stringify(confirmation.err)}`
              : 'tx_confirmation_timeout';

            // Resolve position as failed/timeout
            if (posId) {
              resolvePosition(posId, confirmation.status === 'failed' ? 'failed' : 'timeout', errReason);
            }

            // Update the pending row to cancelled (already inserted above)
            updatePendingTrade(result.signature, 'cancelled', errReason);

            // Update riskManager internal state (skip duplicate store write)
            riskManager.recordTrade({
              ...trade,
              signature: result.signature,
              paperTrade: false,
              pnlSol: 0,
              reason: trade.reason || '',
              inputPriceUsd: inputPrice || 0,
              outputPriceUsd: outputPrice,
              status: 'cancelled',
              cancelReason: errReason,
              skipDb: true,
            });

            failedLeg = {
              leg: i + 1,
              pair: tradePair,
              dex: trade.dex || 'best-route',
              amountSol: trade.amountSol,
              error: errReason,
              reason: trade.reason,
              ...classifyError(errReason),
            };
            appendEvent(`TX_UNCONFIRMED${seqLabel} — leg ${i + 1} ${tradePair} | sig=${result.signature} | ${errReason}`);
            log.warn(`TX not confirmed${seqLabel} at leg ${i + 1} (${errReason}) — cancelling remaining legs`);

            // Record remaining legs as cancelled in runtime store + position tracker
            for (let j = i + 1; j < groupTrades.length; j++) {
              const ct = groupTrades[j];
              const cInput = mintToSymbol[ct.inputMint] || '?';
              const cOutput = mintToSymbol[ct.outputMint] || '?';
              cancelled.push({
                leg: j + 1,
                pair: `${cInput}→${cOutput}`,
                dex: ct.dex || 'best-route',
                amountSol: ct.amountSol,
              });
              riskManager.recordTrade({
                ...ct,
                signature: null,
                paperTrade: false,
                pnlSol: 0,
                reason: ct.reason || '',
                inputPriceUsd: 0,
                outputPriceUsd: 0,
                status: 'cancelled',
                cancelReason: `prior leg ${i + 1} unconfirmed (${errReason})`,
              });
              appendEvent(`SEQ_CANCEL — group=${gid} | leg ${j + 1} ${ct.reason} (prior leg unconfirmed)`);
            }
            break;
          }

          // TX confirmed on-chain — update pending row in runtime store
          if (posId) confirmPosition(posId, confirmation.status);
          updatePendingTrade(result.signature, 'confirmed');
          log.info(`TX confirmed${seqLabel} leg ${i + 1} ${tradePair} — status=${confirmation.status}`);
        }

        // Record trade in riskManager (skip duplicate store insert for real trades)
        riskManager.recordTrade({
          ...trade,
          signature: result.signature,
          paperTrade: isPaper,
          pnlSol: 0,
          reason: trade.reason || '',
          inputPriceUsd: inputPrice || 0,
          outputPriceUsd: outputPrice,
          skipDb: !isPaper,  // real trades already in runtime store; paper trades need addTrade()
        });
        completed.push({
          leg: i + 1,
          pair: tradePair,
          dex: trade.dex || 'best-route',
          amountSol: trade.amountSol,
          sig: result.signature,
        });
        appendEvent(
          `TRADE${seqLabel} — ${trade.strategy} ${trade.type}${dexLabel}: ${trade.reason} | sig=${result.signature} | paper=${isPaper}`
        );
      } else {
        const failPair = `${inputSymbol || '?'}→${mintToSymbol[trade.outputMint] || '?'}`;
        const outputSymbol = mintToSymbol[trade.outputMint] || '?';
        const isLimitTimeout = result.error === 'limit_timeout';

        if (isLimitTimeout) {
          // Track as limit_timeout position
          const failPosId = openPosition({
            signature: null,
            inputToken: inputSymbol || '?',
            outputToken: outputSymbol,
            inputMint: trade.inputMint,
            outputMint: trade.outputMint,
            amountSol: trade.amountSol,
            dex: trade.dex || '',
            strategy: trade.strategy,
            type: trade.type,
            reason: trade.reason || '',
            sequenceGroup: gid,
            leg: i + 1,
            isSequence,
          });
          resolvePosition(failPosId, 'limit_timeout', `need ≥${result.minOutAmount}, got ${result.lastOutAmount}`);

          failedLeg = {
            leg: i + 1,
            pair: failPair,
            dex: trade.dex || 'best-route',
            amountSol: trade.amountSol,
            error: 'limit_timeout',
            minOut: result.minOutAmount || 0,
            lastQuoteOut: result.lastOutAmount || 0,
            reason: trade.reason,
            ...classifyError('limit_timeout'),
          };
          // Record the timed-out leg in runtime store
          riskManager.recordTrade({
            ...trade,
            signature: null,
            paperTrade: false,
            pnlSol: 0,
            reason: trade.reason || '',
            inputPriceUsd: inputPrice || 0,
            outputPriceUsd: (state.lastPrices?.[outputSymbol]) || 0,
            status: 'cancelled',
            cancelReason: `limit_timeout: need ≥${result.minOutAmount}, got ${result.lastOutAmount}`,
          });
          appendEvent(`LIMIT_TIMEOUT${seqLabel} — ${trade.reason} | need ≥${result.minOutAmount}, got ${result.lastOutAmount}`);
          log.warn(`Limit timeout${seqLabel} at leg ${i + 1} — cancelling remaining`);
        } else {
          // Track as failed position
          const failPosId = openPosition({
            signature: result.signature || null,
            inputToken: inputSymbol || '?',
            outputToken: outputSymbol,
            inputMint: trade.inputMint,
            outputMint: trade.outputMint,
            amountSol: trade.amountSol,
            dex: trade.dex || '',
            strategy: trade.strategy,
            type: trade.type,
            reason: trade.reason || '',
            sequenceGroup: gid,
            leg: i + 1,
            isSequence,
          });
          resolvePosition(failPosId, 'failed', result.error || 'swap failed');

          failedLeg = {
            leg: i + 1,
            pair: failPair,
            dex: trade.dex || 'best-route',
            amountSol: trade.amountSol,
            error: result.error,
            reason: trade.reason,
            ...classifyError(result.error),
          };
          // Record the failed leg in runtime store
          riskManager.recordTrade({
            ...trade,
            signature: null,
            paperTrade: false,
            pnlSol: 0,
            reason: trade.reason || '',
            inputPriceUsd: inputPrice || 0,
            outputPriceUsd: (state.lastPrices?.[outputSymbol]) || 0,
            status: 'failed',
            cancelReason: result.error || 'swap failed',
          });
          // Record this dex+pair as rejected so AI avoids it
          if (trade.dex) {
            recordRejectedCombo(trade.dex, failPair, result.error?.slice(0, 80) || 'swap failed');
          }
          appendEvent(`TRADE_FAIL${seqLabel} — ${trade.reason} | error=${result.error}`);
          log.warn(`Trade failed${seqLabel} at leg ${i + 1} — cancelling remaining`);
        }

        // Record remaining legs as cancelled in runtime store
        for (let j = i + 1; j < groupTrades.length; j++) {
          const ct = groupTrades[j];
          const cInput = mintToSymbol[ct.inputMint] || '?';
          const cOutput = mintToSymbol[ct.outputMint] || '?';
          cancelled.push({
            leg: j + 1,
            pair: `${cInput}→${cOutput}`,
            dex: ct.dex || 'best-route',
            amountSol: ct.amountSol,
          });
          riskManager.recordTrade({
            ...ct,
            signature: null,
            paperTrade: false,
            pnlSol: 0,
            reason: ct.reason || '',
            inputPriceUsd: 0,
            outputPriceUsd: 0,
            status: 'cancelled',
            cancelReason: `prior leg ${i + 1} ${isLimitTimeout ? 'limit timeout' : 'failed'}: ${result.error || 'unknown'}`,
          });
          appendEvent(`SEQ_CANCEL — group=${gid} | leg ${j + 1} ${ct.reason} (${isLimitTimeout ? 'limit timeout' : 'prior leg failed'})`);
        }
        break;
      }
    }

    // Record failed/timed-out sequence info for AI on next tick
    if (failedLeg && isSequence) {
      if (failedLeg.error === 'limit_timeout') {
        state.lastLimitCancelled.push({
          group: gid,
          completed,
          timedOut: failedLeg,
          cancelled,
          ts: new Date().toISOString(),
        });
        if (state.lastLimitCancelled.length > 5) {
          state.lastLimitCancelled = state.lastLimitCancelled.slice(-5);
        }
      } else {
        state.lastFailedSequences.push({
          group: gid,
          completed,
          failed: failedLeg,
          cancelled,
          ts: new Date().toISOString(),
        });
        if (state.lastFailedSequences.length > 5) {
          state.lastFailedSequences = state.lastFailedSequences.slice(-5);
        }
      }
    }
  }
}

// ─── Error classification (5.2) ─────────────────────────────────────────────

/**
 * Classify a swap/execution error into a category and suggested action.
 * @param {string} error — raw error string
 * @returns {{cat: string, act: string}}
 */
function classifyError(error) {
  const e = (error || '').toLowerCase();
  if (e.includes('slippage') || e.includes('slippagetolerance'))
    return { cat: 'slippage', act: 'retry_with_lower_size' };
  if (e.includes('liquidity') || e.includes('no route') || e.includes('no quotes'))
    return { cat: 'liquidity', act: 'avoid_dex' };
  if (e.includes('timeout') || e.includes('econnrefused') || e.includes('etimedout') || e.includes('fetch failed') || e.includes('network'))
    return { cat: 'network', act: 'retry_next_tick' };
  if (e.includes('insufficient') || e.includes('balance'))
    return { cat: 'balance', act: 'no_retry' };
  if (e === 'limit_timeout')
    return { cat: 'limit', act: 'retry_next_tick' };
  if (e.includes('tx_failed_onchain'))
    return { cat: 'network', act: 'retry_next_tick' };
  if (e.includes('tx_confirmation_timeout'))
    return { cat: 'network', act: 'retry_next_tick' };
  return { cat: 'unknown', act: 'avoid_dex' };
}

// ─── Rejected combo tracker ────────────────────────────────────────────────

/**
 * Record a dex+pair combination that was rejected (whitelist or swap failure).
 * Keeps the last 15 entries. Entries expire after 2 hours so the AI can retry later.
 */
function recordRejectedCombo(dex, pair, reason) {
  state.rejectedCombos.push({ dex, pair, reason, ts: Date.now() });
  // Deduplicate: keep only latest entry per dex+pair
  const seen = new Map();
  for (const c of state.rejectedCombos) seen.set(`${c.dex}|${c.pair}`, c);
  state.rejectedCombos = [...seen.values()];
  // Cap at 15
  if (state.rejectedCombos.length > 15) state.rejectedCombos = state.rejectedCombos.slice(-15);
  log.info(`Rejected combo recorded: ${dex} + ${pair} — ${reason}`);
}

/**
 * Get non-expired rejected combos (2h TTL).
 */
export function getActiveRejectedCombos() {
  const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
  state.rejectedCombos = state.rejectedCombos.filter(c => c.ts >= twoHoursAgo);
  return state.rejectedCombos;
}

// ─── Stale Position Cleanup ────────────────────────────────────────────────

/**
 * Cron job: every 30 min.
 * 1) Check in-memory pending positions older than 30 min.
 * 2) Query pending trades older than 30 min but younger than 24h from runtime store.
 * Re-check each on-chain with a short timeout. Cancel if still unconfirmed.
 */
async function stalePositionCheck() {
  let totalChecked = 0;

  // ── Phase 1: In-memory stale positions (>30 min old) ──
  const stale = getStalePendingPositions(30 * 60 * 1000);
  if (stale.length) {
    log.info(`Stale check: ${stale.length} in-memory pending position(s) >30 min`);
    for (const pos of stale) {
      totalChecked++;
      log.info(`Checking stale position: ${pos.id} | ${pos.inputToken}→${pos.outputToken} | sig=${pos.signature} | age=${Math.round((Date.now() - new Date(pos.openedAt).getTime()) / 1000)}s`);

      if (!pos.signature) {
        resolvePosition(pos.id, 'cancelled', 'stale: no signature (tx never sent)');
        appendEvent(`STALE_CANCEL — ${pos.id} | ${pos.inputToken}→${pos.outputToken} | no signature`);
        continue;
      }

      try {
        const confirmation = await confirmTransaction(pos.signature, 30_000, 5000);
        log.debug(`Stale re-check: ${pos.id} confirmed=${confirmation.confirmed} status=${confirmation.status}`);

        if (confirmation.confirmed) {
          confirmPosition(pos.id, confirmation.status);
          updatePendingTrade(pos.signature, 'confirmed');
          appendEvent(`STALE_RESOLVED — ${pos.id} | ${pos.inputToken}→${pos.outputToken} | confirmed=${confirmation.status}`);
        } else if (confirmation.status === 'failed') {
          resolvePosition(pos.id, 'failed', `stale: tx failed on-chain: ${JSON.stringify(confirmation.err)}`);
          updatePendingTrade(pos.signature, 'failed', `tx failed: ${JSON.stringify(confirmation.err)}`);
          appendEvent(`STALE_FAILED — ${pos.id} | ${pos.inputToken}→${pos.outputToken} | tx failed`);
        } else {
          resolvePosition(pos.id, 'cancelled', 'stale: unconfirmed >30min');
          updatePendingTrade(pos.signature, 'cancelled', 'stale: unconfirmed >30min');
          appendEvent(`STALE_CANCEL — ${pos.id} | ${pos.inputToken}→${pos.outputToken} | unconfirmed >30min`);
        }
      } catch (err) {
        log.error(`Stale check error for ${pos.id}: ${err.message}`);
        resolvePosition(pos.id, 'cancelled', `stale: check error: ${err.message}`);
        updatePendingTrade(pos.signature, 'cancelled', `check error: ${err.message}`);
      }
    }
  }

  // ── Phase 2: Runtime pending trades (>30 min, <24h) ──
  const pendingTrades = getPendingTradesByAge(1800, 86400); // 30 min to 24h
  if (pendingTrades.length) {
    // Filter out ones already handled in Phase 1 (by signature)
    const handledSigs = new Set(stale.map(p => p.signature).filter(Boolean));
    const runtimeOnly = pendingTrades.filter(t => t.signature && !handledSigs.has(t.signature));

    if (runtimeOnly.length) {
      log.info(`Stale check: ${runtimeOnly.length} pending trade(s) in runtime store >30 min (not in memory)`);
      for (const trade of runtimeOnly) {
        totalChecked++;
        const pair = `${trade.inputToken || trade.inputMint || '?'}→${trade.outputToken || trade.outputMint || '?'}`;
        log.info(`Checking runtime pending trade: sig=${trade.signature} | ${pair} | strategy=${trade.strategy}`);

        try {
          const confirmation = await confirmTransaction(trade.signature, 30_000, 5000);
          log.debug(`Runtime stale re-check: sig=${trade.signature} confirmed=${confirmation.confirmed} status=${confirmation.status}`);

          if (confirmation.confirmed) {
            updatePendingTrade(trade.signature, 'confirmed');
            appendEvent(`RUNTIME_STALE_RESOLVED — sig=${trade.signature} | ${pair} | confirmed=${confirmation.status}`);
          } else if (confirmation.status === 'failed') {
            updatePendingTrade(trade.signature, 'failed', `tx failed: ${JSON.stringify(confirmation.err)}`);
            appendEvent(`RUNTIME_STALE_FAILED — sig=${trade.signature} | ${pair} | tx failed`);
          } else {
            updatePendingTrade(trade.signature, 'cancelled', 'stale: unconfirmed >30min (runtime check)');
            appendEvent(`RUNTIME_STALE_CANCEL — sig=${trade.signature} | ${pair} | unconfirmed >30min`);
          }
        } catch (err) {
          log.error(`Runtime stale check error for sig=${trade.signature}: ${err.message}`);
          updatePendingTrade(trade.signature, 'cancelled', `runtime check error: ${err.message}`);
        }
      }
    }
  }

  // Prune old resolved entries to cap memory
  pruneHistory();
  if (totalChecked > 0) {
    log.info(`Stale position check complete: ${totalChecked} checked. In-memory pending: ${getPendingPositions().length}`);
  } else {
    log.debug('Stale position check: nothing to check');
  }
}

// ─── News Digest (scan + AI analysis combined) ─────────────────────────────

// newsDigestJob removed — news scanning moved into trading loop (step 6)

// ─── Portfolio Snapshot ─────────────────────────────────────────────────────

async function portfolioSnapshot() {
  if (!state.initialized) { log.warn('Init not done, skipping portfolio'); return; }
  try {
    state.lastWallet = await getWalletBalances();
    riskManager.updateBalance(state.lastWallet.totalValueSol);
    appendEvent(`PORTFOLIO — ${state.lastWallet.totalValueSol} SOL ($${state.lastWallet.totalValueUsd}) | SOL balance: ${state.lastWallet.solBalance}`);
  } catch (err) {
    log.error(`Portfolio snapshot error: ${err.message}`);
  }
}

// ─── Memory Flush ───────────────────────────────────────────────────────────

async function memoryFlush() {
  if (!state.initialized) return;
  try {
    const summary = riskManager.getDailySummary();
    if (summary.tradeCount > 0) {
      appendLongTermMemory(`Trades: ${summary.tradeCount} | PnL: $${summary.dailyPnl} (${summary.dailyPnlPct}%)`);
    }
    log.info('Memory flush complete');
  } catch (err) {
    log.error(`Memory flush error: ${err.message}`);
  }
}

// ─── Daily Report ───────────────────────────────────────────────────────────

async function dailyReport() {
  if (!state.initialized) return;
  try {
    const context = {
      summary: riskManager.getDailySummary(),
      todayLog: readTodayEvents(),
      wallet: state.lastWallet,
      prices: state.lastPrices,
    };
    const report = await generateDailyReport(context);
    appendEvent(`DAILY_REPORT —\n${report}`);

    // Reset risk manager for next day
    if (state.lastWallet) {
      riskManager.setBalance(state.lastWallet.totalValueSol);
    }
    log.info('Daily report generated');
  } catch (err) {
    log.error(`Daily report error: ${err.message}`);
  }
}

// ─── Start All Crons ────────────────────────────────────────────────────────

const jobs = [];

const DEFAULT_CRON = {
  tradingLoop: '10 * * * *',
  portfolioSnapshot: '*/15 * * * *',
  memoryFlush: '0 */2 * * *',
  dailyReport: '53 23 * * *',
  stalePositionCheck: '*/30 * * * *',
};

function createCronJobWithValidation(name, expr, fallbackExpr, onTick) {
  try {
    const job = new CronJob(expr, onTick, null, true, 'UTC');
    log.info(`Cron: ${name} — ${expr} (UTC)`);
    return job;
  } catch (err) {
    log.warn(`Cron expression invalid for ${name}: "${expr}" (${err.message}) — using fallback "${fallbackExpr}"`);
    const fallbackJob = new CronJob(fallbackExpr, onTick, null, true, 'UTC');
    log.info(`Cron: ${name} — ${fallbackExpr} (UTC, fallback)`);
    return fallbackJob;
  }
}

export function startScheduler() {
  // Cron timing: offset AI-calling jobs so no two fire in the same minute.
  // All cron jobs check state.initialized and skip if init hasn't finished.

  // Trading loop — every hour at :10 (calls OpenAI, offset from news@:05)
  jobs.push(createCronJobWithValidation('Trading loop', config.cron.tradingLoop, DEFAULT_CRON.tradingLoop, tradingLoop));

  // (news digest cron removed — RSS + tweet scanning moved into trading loop)

  // Portfolio snapshot — every 15 minutes (no OpenAI)
  jobs.push(createCronJobWithValidation('Portfolio snapshot', config.cron.portfolioSnapshot, DEFAULT_CRON.portfolioSnapshot, portfolioSnapshot));

  // Memory flush — every 2 hours (no OpenAI)
  jobs.push(createCronJobWithValidation('Memory flush', config.cron.memoryFlush, DEFAULT_CRON.memoryFlush, memoryFlush));

  // Daily report — 23:53 UTC (calls OpenAI, offset from trading)
  jobs.push(createCronJobWithValidation('Daily report', config.cron.dailyReport, DEFAULT_CRON.dailyReport, dailyReport));

  // Stale position cleanup — every 30 minutes (no OpenAI, checks on-chain)
  jobs.push(createCronJobWithValidation('Stale position check', config.cron.stalePositionCheck, DEFAULT_CRON.stalePositionCheck, stalePositionCheck));

  // ── Initial scan sequence (crons are blocked until this completes) ──
  setTimeout(async () => {
    log.info('Running initial scan sequence (crons blocked until done)...');
    try { state.lastWallet = await getWalletBalances(); riskManager.updateBalance(state.lastWallet.totalValueSol); if (riskManager.initialBalance === 0) riskManager.setBalance(state.lastWallet.totalValueSol); log.info('Init: portfolio OK'); } catch (e) { log.error(`Init portfolio: ${e.message}`); }
    try { state.lastPrices = await getPrices(); log.info('Init: prices OK'); } catch (e) { log.error(`Init prices: ${e.message}`); }
    try { state.lastPriceChanges = await getAllPriceChanges(); log.info('Init: priceChanges OK'); } catch (e) { log.error(`Init priceChanges: ${e.message}`); }
    state.initialized = true;
    log.info('═══ INIT COMPLETE — crons now active ═══');

    // First trading tick
    await tradingLoop();
  }, 5_000);
}

export function stopScheduler() {
  for (const j of jobs) j.stop();
  jobs.length = 0;
  log.info('Scheduler stopped');
}

// Allow manual trigger
export { tradingLoop, portfolioSnapshot, memoryFlush, dailyReport, stalePositionCheck };
export { getAllPositions } from './positionTracker.js';
