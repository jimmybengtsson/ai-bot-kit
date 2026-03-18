// src/skills/priceScanner.js — Fetch token prices from Jupiter + DexScreener
import { config } from '../config.js';
import { createLogger } from '../logger.js';
import { fetchWithTimeout } from '../http.js';

const log = createLogger('priceScanner');

function jupHeaders() {
  return { 'x-api-key': config.jupiterApiKey };
}

/**
 * Fetch current USD prices for watched tokens via Jupiter Price API v3.
 * @param {string[]} [symbols] — token symbols to fetch (default: all watched)
 * @returns {Record<string, number>} — { SOL: 142.3, JUP: 1.05, … }
 */
export async function getPrices(symbols) {
  const tokens = config.watchedTokens;
  const syms = symbols || Object.keys(tokens);
  const mints = syms.map(s => tokens[s]).filter(Boolean);

  log.info(`Fetching prices for ${syms.length} tokens: ${syms.join(', ')}`);
  const url = `${config.jupiterPriceApi}?ids=${mints.join(',')}`;
  const start = Date.now();
  const resp = await fetchWithTimeout(url, {
    headers: jupHeaders(),
    timeoutMs: config.httpTimeoutMs,
  });
  const data = await resp.json();
  log.debug(`Jupiter price API responded in ${Date.now() - start}ms, status=${resp.status}, keys=${Object.keys(data).length}`);

  const prices = {};
  let missing = 0;
  for (const sym of syms) {
    const mint = tokens[sym];
    if (mint && data[mint]) {
      prices[sym] = data[mint].usdPrice;
    } else {
      missing++;
      log.warn(`No price data for ${sym} (${mint})`);
    }
  }
  log.info(`Prices: ${Object.entries(prices).map(([s, p]) => `${s}=$${p}`).join(', ')}${missing ? ` (${missing} missing)` : ''}`);
  return prices;
}

/**
 * Get multi-timeframe percentage price changes for a single token via DexScreener.
 * Returns { m5, h1, h6, h24 } or null on failure.
 * @param {string} symbol
 * @returns {Promise<{m5:number, h1:number, h6:number, h24:number}|null>}
 */
export async function getPriceChanges(symbol) {
  const mint = config.watchedTokens[symbol];
  if (!mint) return null;

  try {
    const start = Date.now();
    const resp = await fetchWithTimeout(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {
      timeoutMs: config.httpTimeoutMs,
    });
    const data = await resp.json();
    const pairs = data.pairs || [];
    log.debug(`DexScreener ${symbol}: ${pairs.length} pairs in ${Date.now() - start}ms`);
    if (!pairs.length) {
      log.debug(`DexScreener ${symbol}: no pairs found`);
      return null;
    }

    const best = pairs.reduce((a, b) =>
      parseFloat(a.liquidity?.usd || 0) >= parseFloat(b.liquidity?.usd || 0) ? a : b
    );
    const pc = best.priceChange || {};
    const result = {
      m5:  parseFloat(pc.m5  || 0),
      h1:  parseFloat(pc.h1  || 0),
      h6:  parseFloat(pc.h6  || 0),
      h24: parseFloat(pc.h24 || 0),
    };
    log.debug(`DexScreener ${symbol}: m5=${result.m5}%, h1=${result.h1}%, h6=${result.h6}%, h24=${result.h24}%, liq=$${best.liquidity?.usd || 0}`);
    return result;
  } catch (err) {
    log.warn(`DexScreener error for ${symbol}: ${err.message}`);
    return null;
  }
}

/**
 * Get percentage price change over a window via DexScreener.
 * @param {string} symbol
 * @param {number} [windowMinutes=5]
 * @returns {number|null}
 */
export async function getPriceChange(symbol, windowMinutes = 5) {
  const result = await getPriceChanges(symbol);
  if (!result) return null;
  if (windowMinutes <= 5) return result.m5;
  if (windowMinutes <= 60) return result.h1;
  if (windowMinutes <= 360) return result.h6;
  return result.h24;
}

/**
 * Get multi-timeframe price changes for all watched tokens.
 * Returns { SOL: { m5, h1, h6, h24 }, JUP: { ... }, ... }
 */
export async function getAllPriceChanges() {
  const changes = {};
  const symbols = Object.keys(config.watchedTokens);
  log.info(`Fetching multi-timeframe price changes for ${symbols.length} tokens via DexScreener`);
  const start = Date.now();
  // Fan out in batches of 3 to avoid rate limits
  for (let i = 0; i < symbols.length; i += 3) {
    const batch = symbols.slice(i, i + 3);
    const results = await Promise.all(batch.map(s => getPriceChanges(s)));
    batch.forEach((sym, idx) => { changes[sym] = results[idx]; });
  }
  log.info(`Price changes in ${Date.now() - start}ms: ${Object.entries(changes).map(([s, c]) => c ? `${s}:h1=${c.h1}%,h24=${c.h24}%` : `${s}=?`).join(', ')}`);
  return changes;
}

/**
 * Find divergence pairs — tokens moving in opposite directions.
 * Returns pairs where one token dropped significantly while another rose,
 * creating potential mean-reversion / swap opportunities.
 *
 * @param {Record<string, {m5:number, h1:number, h6:number, h24:number}>} priceChanges
 * @param {{ minGapH1?: number, minGapH24?: number }} [opts]
 * @returns {{ pairs: Array<{up:string, down:string, upH1:number, downH1:number, gapH1:number, upH24:number, downH24:number, gapH24:number, signal:string}> }}
 */
export function findDivergencePairs(priceChanges, opts = {}) {
  const MIN_GAP_H1  = opts.minGapH1  ?? 3;   // minimum 3% h1 gap
  const MIN_GAP_H24 = opts.minGapH24 ?? 8;   // minimum 8% h24 gap

  const entries = Object.entries(priceChanges || {}).filter(([, c]) => c && c.h1 != null);
  const pairs = [];

  for (let i = 0; i < entries.length; i++) {
    const [symA, cA] = entries[i];
    for (let j = i + 1; j < entries.length; j++) {
      const [symB, cB] = entries[j];

      // Determine which is "up" and which is "down" on h1
      const diffH1 = (cA.h1 || 0) - (cB.h1 || 0);
      const diffH24 = (cA.h24 || 0) - (cB.h24 || 0);
      const absH1 = Math.abs(diffH1);
      const absH24 = Math.abs(diffH24);

      // Need meaningful gap on at least one timeframe, and tokens must move in opposite directions
      if (absH1 < MIN_GAP_H1 && absH24 < MIN_GAP_H24) continue;

      let up, down, upC, downC;
      if (diffH1 >= 0) {
        up = symA; down = symB; upC = cA; downC = cB;
      } else {
        up = symB; down = symA; upC = cB; downC = cA;
      }

      // Both must actually be diverging (one positive, one negative on at least one timeframe)
      const oppH1  = (upC.h1 || 0) > 0 && (downC.h1 || 0) < 0;
      const oppH24 = (upC.h24 || 0) > 0 && (downC.h24 || 0) < 0;
      if (!oppH1 && !oppH24) continue;

      // Classify signal strength
      let signal = 'weak';
      if (oppH1 && oppH24 && absH1 >= MIN_GAP_H1 && absH24 >= MIN_GAP_H24) signal = 'strong';
      else if (oppH24 && absH24 >= MIN_GAP_H24) signal = 'medium';
      else if (oppH1 && absH1 >= MIN_GAP_H1) signal = 'medium';
      else continue; // skip weak signals that don't meet minimums

      pairs.push({
        up, down,
        upH1:   +(upC.h1 || 0).toFixed(1),
        downH1: +(downC.h1 || 0).toFixed(1),
        gapH1:  +absH1.toFixed(1),
        upH24:  +(upC.h24 || 0).toFixed(1),
        downH24:+(downC.h24 || 0).toFixed(1),
        gapH24: +absH24.toFixed(1),
        signal,
      });
    }
  }

  // Sort by combined gap strength (h24 weighted 2x since it's a stronger signal)
  pairs.sort((a, b) => (b.gapH24 * 2 + b.gapH1) - (a.gapH24 * 2 + a.gapH1));

  if (pairs.length) {
    log.info(`Divergence pairs found: ${pairs.length} — top: ${pairs[0].up}↑ / ${pairs[0].down}↓ gap h1=${pairs[0].gapH1}% h24=${pairs[0].gapH24}% (${pairs[0].signal})`);
  } else {
    log.info('No divergence pairs found');
  }

  return { pairs: pairs.slice(0, 15) }; // cap at 15 to keep data compact
}