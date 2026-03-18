// src/skills/arbitrageFinder.js — Cross-DEX & cross-pair arbitrage detection via Jupiter
//
// Efficient four-phase pipeline designed to stay under Jupiter's rate limits:
//
//   Phase 1 — Screening:  ONE best-route quote per pair (no DEX filter).
//             Jupiter's routePlan reveals which DEX won → builds a DEX map.
//             ~300 requests total (vs ~4200 previously).
//
//   Phase 2 — Deep scan:  Per-DEX quotes ONLY for "interesting" pairs where
//             2+ DEXes have routes. Rate-limited + spread across ticks.
//
//   Phase 3 — Analysis:   2-leg round-trip arb + 3-leg triangular arb.
//
//   Phase 4 — Verification: Re-quote any discovered opportunities with fresh
//             per-DEX quotes to confirm the spread is real before sending to AI.
//
// Rate control:
//   - Token-bucket limiter at ~8 req/sec (under Jupiter 600/min limit)
//   - Exponential backoff on 429 responses (1s, 2s, 4s, then skip)
//   - Cross-tick DEX cache persists known-good DEXes per pair

import { config } from '../config.js';
import { createLogger } from '../logger.js';
import { fetchWithTimeout } from '../http.js';

const log = createLogger('arbitrage');

const mintToSymbol = Object.fromEntries(
  Object.entries(config.watchedTokens).map(([sym, mint]) => [mint, sym])
);

const whitelistSet = new Set(config.compareDexes);

/* ── Rate-limited request pool ──────────────────────────────────── */

/**
 * Token-bucket rate limiter. Allows `rate` requests per second.
 */
class RateLimiter {
  constructor(rate) {
    this.interval = 1000 / rate;   // ms between tokens
    this.lastTick = 0;
  }
  async acquire() {
    const now = Date.now();
    const wait = Math.max(0, this.lastTick + this.interval - now);
    this.lastTick = now + wait;
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
  }
}

const limiter = new RateLimiter(8); // 8 req/sec = 480/min (safely under 600/min)

/**
 * Run tasks with rate limiting + concurrency cap.
 * Unlike the old runPool, this paces requests to avoid 429s.
 */
async function runRateLimited(tasks, concurrency = 6) {
  const results = new Array(tasks.length);
  let idx = 0;
  let ok = 0;
  let fail = 0;

  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      await limiter.acquire();
      try {
        results[i] = await tasks[i]();
        if (results[i]) ok++; else fail++;
      } catch {
        results[i] = null;
        fail++;
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker()),
  );
  return { results, ok, fail };
}

/* ── DEX route cache (persists across scans) ────────────────────── */
const _dexCache = new Map();   // pairKey → Set<dexName>
let _scanCount = 0;
const FULL_SCAN_EVERY = 5;     // every 5th scan, do full per-DEX deep scan

/* ── Quote helper ───────────────────────────────────────────────── */

const BACKOFF_DELAYS = [1000, 2000, 4000]; // ms

/**
 * Get a Jupiter quote — optionally restricted to a single DEX.
 * If `dex` is null/undefined, queries best-route (all DEXes).
 * Includes retry with exponential backoff on 429.
 */
async function getQuote(inputMint, outputMint, amount, dex = null) {
  const params = new URLSearchParams({
    inputMint,
    outputMint,
    amount,
    slippageBps: String(config.arb?.slippageBps ?? 30),
  });
  if (dex) params.set('dexes', dex);

  const url = `${config.jupiterQuoteApi}?${params}`;
  const headers = { 'x-api-key': config.jupiterApiKey };

  for (let attempt = 0; attempt <= BACKOFF_DELAYS.length; attempt++) {
    try {
      const resp = await fetchWithTimeout(url, {
        headers,
        timeoutMs: config.httpTimeoutMs,
      });

      if (resp.status === 429) {
        if (attempt < BACKOFF_DELAYS.length) {
          log.debug(`429 rate-limited, backoff ${BACKOFF_DELAYS[attempt]}ms (attempt ${attempt + 1})`);
          await new Promise(r => setTimeout(r, BACKOFF_DELAYS[attempt]));
          continue;
        }
        return null; // exhausted retries
      }

      const data = await resp.json();
      if (data.outAmount) {
        // Extract DEX names from routePlan
        const routeDexes = (data.routePlan || [])
          .map(r => r.swapInfo?.label)
          .filter(Boolean);
        return {
          dex: dex || routeDexes[0] || 'unknown',
          outAmount: parseInt(data.outAmount, 10),
          routeDexes,
          route: data.routePlan || [],
        };
      }
    } catch { /* network error — fall through */ }

    if (attempt < BACKOFF_DELAYS.length) {
      await new Promise(r => setTimeout(r, BACKOFF_DELAYS[attempt]));
    }
  }
  return null;
}

/* ── Pair builder ───────────────────────────────────────────────── */

// Hub tokens have deep liquidity pools on almost every DEX.
// Pairs through hubs produce the most actionable arb quotes.
const HUB_SYMBOLS = new Set(['SOL', 'USDC']);

// Major tokens that also have direct cross-pair pools on Raydium/Orca/Meteora.
const MAJOR_SYMBOLS = new Set(['JUP', 'RAY', 'BONK', 'WIF', 'ORCA', 'PYTH', 'JTO', 'RENDER']);

function buildTradePairs() {
  const mints = Object.entries(config.watchedTokens);
  const pairSet = new Set();
  const pairs = [];

  function addPair(symA, mintA, symB, mintB) {
    const key = `${symA}→${symB}`;
    if (pairSet.has(key)) return;
    pairSet.add(key);
    pairs.push({ inputMint: mintA, outputMint: mintB, inputSymbol: symA, outputSymbol: symB });
  }

  for (const [symA, mintA] of mints) {
    for (const [symB, mintB] of mints) {
      if (symA === symB) continue;

      // Tier 1: Every token ↔ every hub (SOL, USDC) — both directions
      if (HUB_SYMBOLS.has(symA) || HUB_SYMBOLS.has(symB)) {
        addPair(symA, mintA, symB, mintB);
        continue;
      }

      // Tier 2: Major ↔ Major cross-pairs (e.g. JUP↔RAY, BONK↔WIF)
      if (MAJOR_SYMBOLS.has(symA) && MAJOR_SYMBOLS.has(symB)) {
        addPair(symA, mintA, symB, mintB);
        continue;
      }

      // Tier 3: Major ↔ any token  (one side must be major)
      if (MAJOR_SYMBOLS.has(symA) || MAJOR_SYMBOLS.has(symB)) {
        addPair(symA, mintA, symB, mintB);
        continue;
      }

      // Skip: two small-cap tokens with no direct pools (e.g. FARTCOIN→KMNO)
    }
  }

  return pairs;
}

// Also export the hub check for Phase 3 triangle optimization
function isHubOrMajor(sym) { return HUB_SYMBOLS.has(sym) || MAJOR_SYMBOLS.has(sym); }

/* ── Main scan ──────────────────────────────────────────────────── */

export async function findArbitrageOpportunities(prices = {}, scanAmountUsd = 10) {
  const pairs = buildTradePairs();
  const opportunities = [];
  const triangularOpportunities = [];
  const routeMap = {};
  const SLIPPAGE_PCT_PER_LEG = (config.arb?.slippageBps ?? 30) / 100;
  const GAS_FEE_SOL          = config.arb?.gasFeeSol ?? 0.000005;
  const MIN_SPREAD_PCT       = config.arb?.minSpreadPct2Leg ?? 2.0;
  const MIN_TRI_SPREAD_PCT   = config.arb?.minSpreadPct3Leg ?? 3.0;

  const isFullScan = _scanCount % FULL_SCAN_EVERY === 0;
  _scanCount++;

  const scanStart = Date.now();
  log.info(
    `═══ Arb scan #${_scanCount} ═══  ${pairs.length} pairs, $${scanAmountUsd} scan, ` +
    `full=${isFullScan}, cache=${_dexCache.size} entries`,
  );

  // ── Pre-compute base-unit amounts ────────────────────────────────
  const pairData = pairs.map(p => {
    const price = prices[p.inputSymbol];
    const dec   = config.tokenDecimals[p.inputMint] ?? 9;
    const amt   = (price && price > 0)
      ? String(Math.round((scanAmountUsd / price) * 10 ** dec))
      : String(10 ** dec);
    return { ...p, amountBaseUnits: amt, pairKey: `${p.inputSymbol}→${p.outputSymbol}` };
  });

  // ═══════════════════════════════════════════════════════════════════
  // Phase 1: SCREENING — one best-route quote per pair (no DEX filter)
  // This is the cheapest way to discover which pairs have routes and
  // what the market rate is.  ~300 requests instead of ~4200.
  // ═══════════════════════════════════════════════════════════════════

  const screenJobs = pairData.map(p =>
    () => getQuote(p.inputMint, p.outputMint, p.amountBaseUnits)
  );
  log.info(`Phase 1: ${screenJobs.length} best-route screening quotes`);
  const screenRun = await runRateLimited(screenJobs, 6);
  const screenResults = screenRun.results;
  log.info(`Phase 1 done: ${screenRun.ok} ok, ${screenRun.fail} no-route/error`);

  // Process screening results: build DEX cache + detect pairs with multiple DEX routes
  const screenQuotes = new Map();  // pairKey → { outAmount, dex, routeDexes }
  for (let pi = 0; pi < pairData.length; pi++) {
    const q = screenResults[pi];
    const p = pairData[pi];
    if (!q) continue;

    screenQuotes.set(p.pairKey, q);
    routeMap[p.pairKey] = (q.routeDexes || []).filter(d => whitelistSet.has(d)).sort();

    // Update DEX cache from route plan — Jupiter's best-route tells us which DEXes have pools
    const dexesFound = new Set(
      (q.routeDexes || []).filter(d => whitelistSet.has(d))
    );
    // Also preserve cached DEXes from prior scans (they had routes before)
    const prior = _dexCache.get(p.pairKey);
    if (prior) {
      for (const d of prior) {
        if (whitelistSet.has(d)) dexesFound.add(d);
      }
    }
    if (dexesFound.size > 0) {
      _dexCache.set(p.pairKey, dexesFound);
    } else {
      _dexCache.delete(p.pairKey);
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // Phase 2: DEEP SCAN — per-DEX quotes for promising pairs
  //
  // Only scan pairs where the DEX cache shows 2+ different whitelisted DEXes.
  // On full scans, also try top DEXes for hub pairs.
  // This is the expensive part, so we limit it aggressively.
  // ═══════════════════════════════════════════════════════════════════

  const deepJobs = [];
  const deepMeta = [];  // { pi, dex }
  let deepPairCount = 0;

  for (let pi = 0; pi < pairData.length; pi++) {
    const p = pairData[pi];
    const cached = _dexCache.get(p.pairKey);

    // Skip pairs with 0-1 known DEXes (can't arb with only one DEX)
    if (!cached || cached.size < 2) continue;

    // On full scans for hub pairs, try the top 6 DEXes (most liquid)
    // On normal scans, only check cached DEXes
    let dexList;
    if (isFullScan && (HUB_SYMBOLS.has(p.inputSymbol) || HUB_SYMBOLS.has(p.outputSymbol))) {
      const topDexes = ['Raydium', 'Raydium CLMM', 'Orca', 'Meteora', 'Meteora DAMM v2', 'Whirlpool'];
      const merged = new Set([...cached, ...topDexes.filter(d => whitelistSet.has(d))]);
      dexList = [...merged];
    } else {
      dexList = [...cached];
    }

    deepPairCount++;
    for (const dex of dexList) {
      deepMeta.push({ pi, dex });
      deepJobs.push(() => getQuote(p.inputMint, p.outputMint, p.amountBaseUnits, dex));
    }
  }

  log.info(`Phase 2: ${deepJobs.length} per-DEX quotes for ${deepPairCount} multi-DEX pairs`);

  const deepRun = await runRateLimited(deepJobs, 6);
  const deepResults = deepRun.results;
  log.info(`Phase 2 done: ${deepRun.ok} ok, ${deepRun.fail} no-route/error`);

  // Count per-DEX stats
  const dexStats = {};
  for (let j = 0; j < deepResults.length; j++) {
    const dex = deepMeta[j].dex;
    if (!dexStats[dex]) dexStats[dex] = { ok: 0, fail: 0 };
    if (deepResults[j]) dexStats[dex].ok++; else dexStats[dex].fail++;
  }
  for (const [dex, s] of Object.entries(dexStats)) {
    log.info(`  ${dex}: ${s.ok} ok / ${s.fail} no-route`);
  }

  // Build grouped per-pair quote arrays (from deep scan)
  const grouped = pairData.map(() => []);
  for (let j = 0; j < deepResults.length; j++) {
    const q = deepResults[j];
    if (!q || !whitelistSet.has(q.dex)) continue;
    grouped[deepMeta[j].pi].push(q);
  }

  // Also inject screening quotes as a fallback for pairs that didn't get
  // deep-scanned (ensures we have data for triangular arb detection)
  for (let pi = 0; pi < pairData.length; pi++) {
    if (grouped[pi].length > 0) continue;
    const sq = screenQuotes.get(pairData[pi].pairKey);
    if (sq && sq.outAmount > 0) {
      const primaryDex = (sq.routeDexes || []).find(d => whitelistSet.has(d));
      if (primaryDex) {
        grouped[pi].push({ dex: primaryDex, outAmount: sq.outAmount, routeDexes: sq.routeDexes, route: sq.route });
      }
    }
  }

  // Update DEX cache from deep scan results
  for (let j = 0; j < deepResults.length; j++) {
    const q = deepResults[j];
    if (!q || !whitelistSet.has(q.dex)) continue;
    const pk = pairData[deepMeta[j].pi].pairKey;
    const cached = _dexCache.get(pk) || new Set();
    cached.add(q.dex);
    _dexCache.set(pk, cached);
  }

  // Build rate map from all quotes (deep + screening fallback)
  const rateMap = {};
  for (let pi = 0; pi < pairData.length; pi++) {
    const { inputMint, outputMint, amountBaseUnits } = pairData[pi];
    const inAmt = Number(amountBaseUnits);
    if (!inAmt || inAmt <= 0) continue;
    for (const q of grouped[pi]) {
      if (q.outAmount > 0) {
        rateMap[`${inputMint}|${outputMint}|${q.dex}`] = { inAmount: inAmt, outAmount: q.outAmount };
      }
    }
  }

  let pairsWithQuotes = 0;
  let pairsSkipped = 0;
  for (let pi = 0; pi < pairData.length; pi++) {
    if (grouped[pi].length > 0) pairsWithQuotes++;
    else pairsSkipped++;
  }

  // ═══════════════════════════════════════════════════════════════════
  // Phase 3: ANALYSIS — 2-leg round-trip + 3-leg triangular arb
  // ═══════════════════════════════════════════════════════════════════

  const pairIndex = new Map();
  for (let pi = 0; pi < pairData.length; pi++) {
    pairIndex.set(pairData[pi].pairKey, pi);
  }

  const solPriceUsd  = prices.SOL || 1;
  const gasPctPerLeg = (GAS_FEE_SOL * solPriceUsd / (scanAmountUsd || 1)) * 100;
  const overheadPct2 = (SLIPPAGE_PCT_PER_LEG * 2) + (gasPctPerLeg * 2);
  const checkedPairs = new Set();
  let roundTripsChecked = 0;

  // ── 2-leg round-trip arb ─────────────────────────────────────────
  for (let pi = 0; pi < pairData.length; pi++) {
    const fwd = pairData[pi];
    const revKey = `${fwd.outputSymbol}→${fwd.inputSymbol}`;
    const rpi = pairIndex.get(revKey);
    if (rpi === undefined) continue;

    const sortedKey = [fwd.inputSymbol, fwd.outputSymbol].sort().join('|');
    if (checkedPairs.has(sortedKey)) continue;
    checkedPairs.add(sortedKey);

    const fwdQuotes = grouped[pi];
    const revQuotes = grouped[rpi];
    if (!fwdQuotes.length || !revQuotes.length) continue;

    const fwdIn = Number(fwd.amountBaseUnits);
    const revIn = Number(pairData[rpi].amountBaseUnits);
    if (!fwdIn || !revIn) continue;

    roundTripsChecked++;

    let bestArb = null;
    for (const fq of fwdQuotes) {
      if (fq.outAmount <= 0) continue;
      for (const rq of revQuotes) {
        if (rq.outAmount <= 0) continue;
        if (fq.dex === rq.dex) continue;

        const roundTripRatio = (fq.outAmount / fwdIn) * (rq.outAmount / revIn);
        const rawSpreadPct = (roundTripRatio - 1) * 100;
        const netSpreadPct = rawSpreadPct - overheadPct2;

        if (netSpreadPct > MIN_SPREAD_PCT && (!bestArb || netSpreadPct > bestArb.net)) {
          bestArb = { fwdQ: fq, revQ: rq, raw: rawSpreadPct, net: netSpreadPct };
        }
      }
    }

    if (bestArb) {
      const { fwdQ, revQ, raw, net } = bestArb;
      if (!whitelistSet.has(fwdQ.dex) || !whitelistSet.has(revQ.dex)) continue;
      log.info(
        `✓ 2-leg candidate: ${fwd.inputSymbol}⇄${fwd.outputSymbol} net ${net.toFixed(2)}% ` +
        `— buy@${fwdQ.dex} sell@${revQ.dex}`,
      );
      opportunities.push({
        inputMint: fwd.inputMint, outputMint: fwd.outputMint,
        inputSymbol: fwd.inputSymbol, outputSymbol: fwd.outputSymbol,
        pair: fwd.pairKey,
        buyDex: fwdQ.dex, sellDex: revQ.dex,
        buyOutput: fwdQ.outAmount, sellOutput: revQ.outAmount,
        spreadPct: Math.round(net * 10000) / 10000,
        rawSpreadPct: Math.round(raw * 10000) / 10000,
        legs: 2, scanAmountUsd,
        allQuotes: fwdQuotes.sort((a, c) => c.outAmount - a.outAmount)
          .map(q => ({ dex: q.dex, outAmount: q.outAmount })),
      });
    }
  }

  log.info(`Phase 3a: ${roundTripsChecked} round-trips checked, ${opportunities.length} 2-leg candidates`);

  // ── 3-leg triangular arb ─────────────────────────────────────────
  const bestQuoteMap = new Map();
  for (let pi = 0; pi < pairData.length; pi++) {
    const { pairKey, inputMint, outputMint, inputSymbol, outputSymbol } = pairData[pi];
    const quotes = grouped[pi];
    if (!quotes.length) continue;
    const best = quotes.reduce((a, c) => a.outAmount >= c.outAmount ? a : c);
    if (best.outAmount > 0 && whitelistSet.has(best.dex)) {
      bestQuoteMap.set(pairKey, { dex: best.dex, outAmount: best.outAmount, inputMint, outputMint, inputSymbol, outputSymbol });
    }
  }

  const symbols = Object.keys(config.watchedTokens);
  const mints   = config.watchedTokens;
  let triChecked = 0;
  for (let ai = 0; ai < symbols.length; ai++) {
    const symA = symbols[ai];
    for (let bi = 0; bi < symbols.length; bi++) {
      if (bi === ai) continue;
      const symB = symbols[bi];
      if (!isHubOrMajor(symA) && !isHubOrMajor(symB)) continue;

      const leg1Key = `${symA}→${symB}`;
      const leg1 = bestQuoteMap.get(leg1Key);
      if (!leg1) continue;

      for (let ci = 0; ci < symbols.length; ci++) {
        if (ci === ai || ci === bi) continue;
        const symC = symbols[ci];
        const leg2Key = `${symB}→${symC}`;
        const leg3Key = `${symC}→${symA}`;
        const leg2 = bestQuoteMap.get(leg2Key);
        const leg3 = bestQuoteMap.get(leg3Key);
        if (!leg2 || !leg3) continue;

        triChecked++;
        if (leg1.dex === leg2.dex && leg2.dex === leg3.dex) continue;

        const pi1 = pairIndex.get(leg1Key);
        const pi2 = pairIndex.get(leg2Key);
        const pi3 = pairIndex.get(leg3Key);
        if (pi1 === undefined || pi2 === undefined || pi3 === undefined) continue;

        const in1 = Number(pairData[pi1].amountBaseUnits);
        const in2 = Number(pairData[pi2].amountBaseUnits);
        const in3 = Number(pairData[pi3].amountBaseUnits);
        if (!in1 || !in2 || !in3) continue;

        const ratio = (leg1.outAmount / in1) * (leg2.outAmount / in2) * (leg3.outAmount / in3);
        const rawTriSpread = (ratio - 1) * 100;
        const triOverhead  = (SLIPPAGE_PCT_PER_LEG * 3) + (gasPctPerLeg * 3);
        const netTriSpread = rawTriSpread - triOverhead;

        if (netTriSpread > MIN_TRI_SPREAD_PCT) {
          const triKey = `${symA}→${symB}→${symC}→${symA}`;
          log.info(`✓ 3-leg candidate: ${triKey} net ${netTriSpread.toFixed(2)}% — ${leg1.dex}/${leg2.dex}/${leg3.dex}`);
          triangularOpportunities.push({
            legs: 3, path: triKey,
            leg1: { pair: leg1Key, dex: leg1.dex, inputMint: leg1.inputMint, outputMint: leg1.outputMint },
            leg2: { pair: leg2Key, dex: leg2.dex, inputMint: leg2.inputMint, outputMint: leg2.outputMint },
            leg3: { pair: leg3Key, dex: leg3.dex, inputMint: leg3.inputMint, outputMint: leg3.outputMint },
            spreadPct: Math.round(netTriSpread * 10000) / 10000,
            rawSpreadPct: Math.round(rawTriSpread * 10000) / 10000,
            scanAmountUsd,
          });
        }
      }
    }
  }

  log.info(`Phase 3b: ${triChecked} triangles checked, ${triangularOpportunities.length} 3-leg candidates`);

  // ═══════════════════════════════════════════════════════════════════
  // Phase 4: VERIFICATION — re-quote candidates with fresh per-DEX quotes
  // to confirm the spread is real before sending to AI.
  // Only costs 2 extra quotes per 2-leg opp, 3 per 3-leg opp.
  // ═══════════════════════════════════════════════════════════════════

  const verified2Leg = [];
  if (opportunities.length > 0) {
    log.info(`Phase 4: Verifying ${opportunities.length} 2-leg opportunities...`);
    for (const opp of opportunities) {
      await limiter.acquire();
      const fwdCheck = await getQuote(opp.inputMint, opp.outputMint,
        pairData[pairIndex.get(opp.pair)]?.amountBaseUnits || '0', opp.buyDex);
      await limiter.acquire();
      const revPairKey = `${opp.outputSymbol}→${opp.inputSymbol}`;
      const revPi = pairIndex.get(revPairKey);
      const revCheck = revPi !== undefined
        ? await getQuote(opp.outputMint, opp.inputMint, pairData[revPi].amountBaseUnits, opp.sellDex)
        : null;

      if (fwdCheck && revCheck) {
        const fwdIn = Number(pairData[pairIndex.get(opp.pair)].amountBaseUnits);
        const revIn = Number(pairData[revPi].amountBaseUnits);
        const rt = (fwdCheck.outAmount / fwdIn) * (revCheck.outAmount / revIn);
        const rawPct = (rt - 1) * 100;
        const netPct = rawPct - overheadPct2;
        if (netPct > MIN_SPREAD_PCT) {
          opp.spreadPct = Math.round(netPct * 10000) / 10000;
          opp.rawSpreadPct = Math.round(rawPct * 10000) / 10000;
          opp.buyOutput = fwdCheck.outAmount;
          opp.sellOutput = revCheck.outAmount;
          opp.verified = true;
          verified2Leg.push(opp);
          log.info(`  ✓ Verified: ${opp.pair} net ${netPct.toFixed(2)}% — CONFIRMED`);

          // Update rateMap with fresh verified rates
          rateMap[`${opp.inputMint}|${opp.outputMint}|${opp.buyDex}`] = {
            inAmount: fwdIn, outAmount: fwdCheck.outAmount,
          };
          rateMap[`${opp.outputMint}|${opp.inputMint}|${opp.sellDex}`] = {
            inAmount: revIn, outAmount: revCheck.outAmount,
          };
        } else {
          log.info(`  ✗ Stale: ${opp.pair} was ${opp.spreadPct}% → now ${netPct.toFixed(2)}% (below ${MIN_SPREAD_PCT}%)`);
        }
      } else {
        log.info(`  ✗ Failed re-quote: ${opp.pair}`);
      }
    }
  }

  const verified3Leg = [];
  if (triangularOpportunities.length > 0) {
    log.info(`Phase 4: Verifying ${triangularOpportunities.length} 3-leg opportunities...`);
    for (const opp of triangularOpportunities) {
      const legs = [opp.leg1, opp.leg2, opp.leg3];
      const freshQuotes = [];
      let allOk = true;
      for (const leg of legs) {
        await limiter.acquire();
        const lpIndex = pairIndex.get(leg.pair);
        if (lpIndex === undefined) { allOk = false; break; }
        const q = await getQuote(leg.inputMint, leg.outputMint, pairData[lpIndex].amountBaseUnits, leg.dex);
        if (!q) { allOk = false; break; }
        freshQuotes.push({ q, pi: lpIndex });
      }
      if (allOk && freshQuotes.length === 3) {
        const in1 = Number(pairData[freshQuotes[0].pi].amountBaseUnits);
        const in2 = Number(pairData[freshQuotes[1].pi].amountBaseUnits);
        const in3 = Number(pairData[freshQuotes[2].pi].amountBaseUnits);
        if (in1 && in2 && in3) {
          const ratio = (freshQuotes[0].q.outAmount / in1) * (freshQuotes[1].q.outAmount / in2) * (freshQuotes[2].q.outAmount / in3);
          const rawPct = (ratio - 1) * 100;
          const triOverhead = (SLIPPAGE_PCT_PER_LEG * 3) + (gasPctPerLeg * 3);
          const netPct = rawPct - triOverhead;
          if (netPct > MIN_TRI_SPREAD_PCT) {
            opp.spreadPct = Math.round(netPct * 10000) / 10000;
            opp.rawSpreadPct = Math.round(rawPct * 10000) / 10000;
            opp.verified = true;
            verified3Leg.push(opp);
            log.info(`  ✓ Verified: ${opp.path} net ${netPct.toFixed(2)}% — CONFIRMED`);

            // Update rateMap
            for (let li = 0; li < 3; li++) {
              const leg = legs[li];
              const fq = freshQuotes[li];
              rateMap[`${leg.inputMint}|${leg.outputMint}|${leg.dex}`] = {
                inAmount: Number(pairData[fq.pi].amountBaseUnits),
                outAmount: fq.q.outAmount,
              };
            }
          } else {
            log.info(`  ✗ Stale: ${opp.path} was ${opp.spreadPct}% → now ${netPct.toFixed(2)}%`);
          }
        }
      } else {
        log.info(`  ✗ Failed re-quote: ${opp.path}`);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════

  const verifyRequests = (opportunities.length * 2) + (triangularOpportunities.length * 3);
  const totalRequests = screenJobs.length + deepJobs.length + verifyRequests;

  log.info(
    `═══ Scan done ${Date.now() - scanStart}ms ═══  ` +
    `${totalRequests} total API calls (screen=${screenJobs.length}, deep=${deepJobs.length}, verify=${verifyRequests}), ` +
    `${pairsWithQuotes} pairs with quotes, ${pairsSkipped} dead, ` +
    `${verified2Leg.length} verified 2-leg opps, ${verified3Leg.length} verified 3-leg opps, ` +
    `cache ${_dexCache.size} entries`,
  );
  if (verified2Leg.length > 0) {
    log.info(`2-leg opportunities:`);
    for (const o of verified2Leg) {
      log.info(`  ${o.pair}: net ${o.spreadPct}% (raw ${o.rawSpreadPct}%) buy@${o.buyDex} sell@${o.sellDex}`);
    }
  }
  if (verified3Leg.length > 0) {
    log.info(`3-leg opportunities:`);
    for (const o of verified3Leg) {
      log.info(`  ${o.path}: net ${o.spreadPct}% (raw ${o.rawSpreadPct}%)`);
    }
  }

  return {
    opportunities: verified2Leg.sort((a, c) => c.spreadPct - a.spreadPct),
    triangularOpportunities: verified3Leg.sort((a, c) => c.spreadPct - a.spreadPct),
    routeMap,
    rateMap,
  };
}
