// src/adapters/clob.js — Polymarket CLOB trading operations
// Infrastructure layer: handles SDK calls, retry, paper trade simulation.
// Domain logic (take-profit decisions, status checking) stays in skills/betExecutor.js.
import { config } from '../config.js';
import { createLogger, logDetailedError } from '../logger.js';
import { getClobClient } from '../wallet.js';
import { fetchMarketMetaByTokenId } from './gamma.js';
import { retryWithBackoff, shouldRetryNetworkError } from '../retry.js';
import { makeRuntimeId } from '../utils/runtimeId.js';

const log = createLogger('clob');

const NO_ORDERBOOK_COOLDOWN_MS = 30 * 60_000;
const noOrderbookUntilByToken = new Map();
const sellCooldownUntilByToken = new Map();

function hasNoOrderbookRecently(tokenId) {
  if (!tokenId) return false;
  const until = noOrderbookUntilByToken.get(tokenId);
  if (!until) return false;
  if (Date.now() <= until) return true;
  noOrderbookUntilByToken.delete(tokenId);
  return false;
}

function markNoOrderbook(tokenId) {
  if (!tokenId) return;
  noOrderbookUntilByToken.set(tokenId, Date.now() + NO_ORDERBOOK_COOLDOWN_MS);
}

function hasNoOrderbookError(payload) {
  const text = String(
    payload?.error
    || payload?.message
    || payload?.errorMsg
    || payload?.response?.data?.error
    || payload?.response?.data?.message
    || '',
  ).toLowerCase();
  return text.includes('no orderbook exists');
}

export function isNoOrderbookCoolingDown(tokenId) {
  return hasNoOrderbookRecently(tokenId);
}

function hasSellCooldown(tokenId) {
  if (!tokenId) return false;
  const until = sellCooldownUntilByToken.get(tokenId);
  if (!until) return false;
  if (Date.now() <= until) return true;
  sellCooldownUntilByToken.delete(tokenId);
  return false;
}

function setSellCooldown(tokenId, ms) {
  if (!tokenId || !Number.isFinite(ms) || ms <= 0) return;
  sellCooldownUntilByToken.set(tokenId, Date.now() + ms);
}

function isSellCoolingDown(tokenId) {
  return hasSellCooldown(tokenId);
}

async function getLatestExecutablePrice(client, tokenId, side) {
  const quote = await retryWithBackoff(
    () => client.getPrice(tokenId, side),
    { maxRetries: 2, baseDelayMs: 700, label: `quote ${side} ${tokenId.slice(0, 12)}`, shouldRetry: shouldRetryNetworkError },
  );
  const px = quote?.price ? parseFloat(quote.price) : null;
  if (!Number.isFinite(px) || px <= 0) {
    throw new Error(`No valid ${side} quote for token ${tokenId}`);
  }
  return px;
}

function getTickDecimals(tickSize) {
  const text = String(tickSize || '0.01');
  const [, decimals = ''] = text.split('.');
  const trimmed = decimals.replace(/0+$/, '');
  return Math.max(2, trimmed.length);
}

function normalizeTickSize(rawTickSize, fallback = '0.01') {
  const raw = Number(rawTickSize);
  const fallbackNum = Number(fallback);
  const tickNum = Number.isFinite(raw) && raw > 0
    ? raw
    : (Number.isFinite(fallbackNum) && fallbackNum > 0 ? fallbackNum : 0.01);
  const decimals = getTickDecimals(String(tickNum));
  return Number(tickNum.toFixed(decimals)).toString();
}

function quantizePriceToTick(rawPrice, tickSize, mode = 'nearest') {
  const tick = Math.max(0.0001, parseFloat(tickSize || '0.01'));
  const bounded = Math.max(0.01, Math.min(0.99, Number(rawPrice)));
  const snapped = toTick(bounded, tick, mode);
  const clamped = Math.max(0.01, Math.min(0.99, snapped));
  const decimals = getTickDecimals(tickSize);
  return Number(clamped.toFixed(decimals));
}

function parseMidpointValue(payload) {
  if (payload === null || payload === undefined) return null;
  if (typeof payload === 'number') {
    return Number.isFinite(payload) && payload > 0 ? payload : null;
  }
  if (typeof payload === 'string') {
    const val = Number(payload);
    return Number.isFinite(val) && val > 0 ? val : null;
  }
  const candidates = [
    payload?.midpoint,
    payload?.mid,
    payload?.price,
    payload?.data?.midpoint,
    payload?.data?.mid,
    payload?.data?.price,
  ];
  for (const c of candidates) {
    const val = Number(c);
    if (Number.isFinite(val) && val > 0) return val;
  }
  return null;
}

async function fetchMinimumTickSize(tokenId, fallbackTickSize = '0.01') {
  const normalizedFallback = normalizeTickSize(fallbackTickSize, '0.01');
  if (!tokenId) return normalizedFallback;

  const urls = [
    `${config.clobHost}/tick-size?token_id=${encodeURIComponent(String(tokenId))}`,
    `${config.clobHost}/tick-size/${encodeURIComponent(String(tokenId))}`,
  ];

  for (const url of urls) {
    try {
      const tick = await retryWithBackoff(
        async () => {
          const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
          if (!res.ok) throw new Error(`Tick size API ${res.status} ${res.statusText}`);
          const data = await res.json();
          const raw = Number(data?.minimum_tick_size ?? data?.min_tick_size ?? data?.tick_size);
          if (!Number.isFinite(raw) || raw <= 0) {
            throw new Error('Tick size API returned invalid minimum_tick_size');
          }
          return raw;
        },
        {
          maxRetries: 1,
          baseDelayMs: 700,
          label: `tick-size ${String(tokenId).slice(0, 12)}`,
          shouldRetry: shouldRetryNetworkError,
        },
      );
      return normalizeTickSize(tick, normalizedFallback);
    } catch {
      // Try the next endpoint shape.
    }
  }

  log.warn(`Tick size lookup failed for token ${String(tokenId).slice(0, 12)}..., falling back to ${normalizedFallback}`);
  return normalizedFallback;
}

async function fetchMidpointPrice(client, tokenId) {
  if (!client || !tokenId) return null;

  const sdkCalls = [
    () => (typeof client.getMidpoint === 'function' ? client.getMidpoint(tokenId) : null),
    () => (typeof client.getMidPrice === 'function' ? client.getMidPrice(tokenId) : null),
  ];

  for (const call of sdkCalls) {
    try {
      const raw = await retryWithBackoff(
        async () => call(),
        {
          maxRetries: 1,
          baseDelayMs: 600,
          label: `midpoint-sdk ${String(tokenId).slice(0, 12)}`,
          shouldRetry: shouldRetryNetworkError,
        },
      );
      const midpoint = parseMidpointValue(raw);
      if (Number.isFinite(midpoint) && midpoint > 0) return midpoint;
    } catch {
      // Fallback to HTTP endpoint.
    }
  }

  const urls = [
    `${config.clobHost}/midpoint?token_id=${encodeURIComponent(String(tokenId))}`,
    `${config.clobHost}/midpoint/${encodeURIComponent(String(tokenId))}`,
  ];

  for (const url of urls) {
    try {
      const midpoint = await retryWithBackoff(
        async () => {
          const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
          if (!res.ok) throw new Error(`Midpoint API ${res.status} ${res.statusText}`);
          const data = await res.json();
          const val = parseMidpointValue(data);
          if (!Number.isFinite(val) || val <= 0) throw new Error('Midpoint API returned invalid value');
          return val;
        },
        {
          maxRetries: 1,
          baseDelayMs: 700,
          label: `midpoint-http ${String(tokenId).slice(0, 12)}`,
          shouldRetry: shouldRetryNetworkError,
        },
      );
      return midpoint;
    } catch {
      // Try the next endpoint shape.
    }
  }

  return null;
}

function toTick(value, tickSize, mode = 'nearest') {
  const tick = Math.max(0.0001, parseFloat(tickSize || '0.01'));
  const scaled = value / tick;
  if (mode === 'up') return Math.ceil(scaled) * tick;
  if (mode === 'down') return Math.floor(scaled) * tick;
  return Math.round(scaled) * tick;
}

function toFiniteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function sumTopDepth(levels, maxLevels = 3) {
  if (!Array.isArray(levels) || levels.length === 0) return 0;
  let total = 0;
  for (const level of levels.slice(0, maxLevels)) {
    const size = toFiniteNumber(level?.size ?? level?.amount ?? level?.qty ?? level?.quantity ?? level?.[1]);
    if (Number.isFinite(size) && size > 0) total += size;
  }
  return total;
}

export function scoreLiquidityQualitySnapshot(snapshot = {}, {
  maxSpreadPct = 0.08,
  freshMs = 90_000,
  targetDepthShares = 400,
} = {}) {
  const bid = toFiniteNumber(snapshot?.bestBid);
  const ask = toFiniteNumber(snapshot?.bestAsk);
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0 || ask < bid) {
    return {
      ok: false,
      score: 0,
      reason: 'missing_top_of_book',
      spreadPct: null,
      bestBid: bid,
      bestAsk: ask,
      depthShares: 0,
      freshnessMs: null,
    };
  }

  const mid = (bid + ask) / 2;
  const spreadPct = mid > 0 ? (ask - bid) / mid : 1;
  const boundedSpreadTarget = Math.max(0.005, Number(maxSpreadPct || 0.08));
  const spreadScore = Math.max(0, Math.min(1, 1 - (spreadPct / boundedSpreadTarget))) * 60;

  const bidsDepth = sumTopDepth(snapshot?.bids);
  const asksDepth = sumTopDepth(snapshot?.asks);
  const depthShares = bidsDepth + asksDepth;
  const depthTarget = Math.max(50, Number(targetDepthShares || 400));
  const depthScore = Math.max(0, Math.min(1, depthShares / depthTarget)) * 30;

  const observedAtMs = toFiniteNumber(snapshot?.observedAtMs) || Date.now();
  const freshnessMs = Math.max(0, Date.now() - observedAtMs);
  const freshnessTarget = Math.max(1000, Number(freshMs || 90_000));
  const freshnessScore = Math.max(0, Math.min(1, 1 - (freshnessMs / freshnessTarget))) * 10;

  const score = Number((spreadScore + depthScore + freshnessScore).toFixed(2));
  const ok = score > 0;
  return {
    ok,
    score,
    reason: ok ? 'ok' : 'insufficient_liquidity',
    spreadPct,
    bestBid: bid,
    bestAsk: ask,
    depthShares,
    freshnessMs,
  };
}

async function fetchOrderBookSnapshot(client, tokenId) {
  const candidates = [
    () => (typeof client.getOrderBook === 'function' ? client.getOrderBook(tokenId) : null),
    () => (typeof client.getBook === 'function' ? client.getBook(tokenId) : null),
  ];

  for (const fn of candidates) {
    try {
      const data = await fn();
      if (!data) continue;
      return {
        bids: Array.isArray(data?.bids) ? data.bids : [],
        asks: Array.isArray(data?.asks) ? data.asks : [],
        observedAtMs: Date.now(),
      };
    } catch {
      // Try alternate SDK method.
    }
  }

  return {
    bids: [],
    asks: [],
    observedAtMs: Date.now(),
  };
}

export async function getLiquidityQuality(tokenId, options = {}) {
  if (!tokenId) {
    return {
      ok: false,
      score: 0,
      reason: 'missing_token_id',
      spreadPct: null,
      bestBid: null,
      bestAsk: null,
      depthShares: 0,
      freshnessMs: null,
    };
  }

  try {
    const client = await getClobClient();
    const [book, buyQuote, sellQuote] = await Promise.all([
      fetchOrderBookSnapshot(client, tokenId),
      getLatestExecutablePrice(client, tokenId, 'BUY').catch(() => null),
      getLatestExecutablePrice(client, tokenId, 'SELL').catch(() => null),
    ]);

    const bestBid = Number.isFinite(sellQuote) ? sellQuote : null;
    const bestAsk = Number.isFinite(buyQuote) ? buyQuote : null;
    const snapshot = {
      ...book,
      bestBid,
      bestAsk,
      observedAtMs: Date.now(),
    };

    return scoreLiquidityQualitySnapshot(snapshot, options);
  } catch (err) {
    log.warn(`Liquidity quality fetch failed for ${String(tokenId).slice(0, 12)}: ${err.message}`);
    return {
      ok: false,
      score: 0,
      reason: 'liquidity_fetch_error',
      spreadPct: null,
      bestBid: null,
      bestAsk: null,
      depthShares: 0,
      freshnessMs: null,
    };
  }
}

function extractOrderError(responseLike) {
  return responseLike?.errorMsg || responseLike?.error || responseLike?.message || 'Unknown order error';
}

function isMinSizeRejection(messageLike) {
  const text = String(messageLike || '').toLowerCase();
  return text.includes('lower than the minimum') || text.includes('size') && text.includes('minimum');
}

/**
 * Place a bet on Polymarket for a specific outcome.
 *
 * Default behavior uses configured USD amount. Optional explicit shares override is supported.
 *
 * @param {object} params
 * @param {string} params.tokenId - The outcome token ID to buy
 * @param {number} params.price - Current market price (0-1)
 * @param {boolean} params.negRisk - Whether the market uses negative risk
 * @param {string} params.tickSize - Market tick size (e.g., "0.01")
 * @param {number} [params.shares] - Optional explicit number of shares to buy
 * @returns {object} { success, orderId, status, amountUsd, shares, error }
 */
export async function placeBet({ tokenId, price, negRisk = false, tickSize = '0.01', shares: requestedShares = null }) {
  const BET_AMOUNT = parseFloat(config.betAmountUsd || 1);
  const MIN_MARKETABLE_BUY_USD = 1;
  let orderPrice = Number(price) || 0;
  let shares = Number.isFinite(requestedShares) && requestedShares > 0
    ? parseFloat(Number(requestedShares).toFixed(2))
    : 0;

  // Paper trade mode — simulate the bet
  if (config.paperTrade()) {
    shares = Number.isFinite(requestedShares) && requestedShares > 0
      ? parseFloat(Number(requestedShares).toFixed(2))
      : parseFloat((BET_AMOUNT / price).toFixed(2));
    const amountUsd = parseFloat((shares * price).toFixed(4));

    log.info(`Placing bet: $${amountUsd} (${shares} share(s) @ ${price}) on token ${tokenId} (negRisk=${negRisk}, tickSize=${tickSize})`);
    log.info(`[PAPER TRADE] Simulated bet: $${amountUsd} for ${shares} share(s) at price ${price}`);
    return {
      success: true,
      orderId: makeRuntimeId('paper'),
      status: 'matched',
      paperTrade: true,
      amountUsd,
      shares,
    };
  }

  try {
    const client = await getClobClient();
    const verifiedTickSize = await fetchMinimumTickSize(tokenId, tickSize);
    const midpoint = await fetchMidpointPrice(client, tokenId);

    if (!Number.isFinite(midpoint) || midpoint <= 0) {
      throw new Error(`No valid midpoint from Polymarket for token ${tokenId}`);
    }

    orderPrice = quantizePriceToTick(midpoint, verifiedTickSize, 'nearest');
    if (!Number.isFinite(orderPrice) || orderPrice <= 0) {
      throw new Error(`Unable to compute valid BUY order price for token ${tokenId}`);
    }

    log.info(
      `BUY pricing metrics: midpoint=${midpoint.toFixed(4)} tick_size=${verifiedTickSize} `
      + `order=${orderPrice.toFixed(4)} requested=${Number.isFinite(Number(price)) ? Number(price).toFixed(4) : 'n/a'}`,
    );

    shares = Number.isFinite(requestedShares) && requestedShares > 0
      ? parseFloat(Number(requestedShares).toFixed(2))
      : parseFloat((BET_AMOUNT / orderPrice).toFixed(2));

    let amountUsd = parseFloat((shares * orderPrice).toFixed(4));

    if (amountUsd < MIN_MARKETABLE_BUY_USD) {
      const minShares = parseFloat((Math.ceil((MIN_MARKETABLE_BUY_USD / orderPrice) * 100) / 100).toFixed(2));
      if (minShares > shares) {
        log.info(
          `BUY min-size adjustment: notional $${amountUsd.toFixed(4)} < $${MIN_MARKETABLE_BUY_USD.toFixed(2)}; `
          + `shares ${shares} -> ${minShares}`,
        );
        shares = minShares;
        amountUsd = parseFloat((shares * orderPrice).toFixed(4));
      }
    }

    log.info(`Placing bet: $${amountUsd} (${shares} share(s) @ ${orderPrice}) on token ${tokenId} (negRisk=${negRisk}, tickSize=${tickSize})`);
    log.info(`BUY quote refresh: requested=${price} using_midpoint=${midpoint} using_order=${orderPrice} verified_tick_size=${verifiedTickSize}`);

    let response;
    try {
      response = await retryWithBackoff(
        () => client.createAndPostOrder(
          {
            tokenID: tokenId,
            price: orderPrice,
            size: shares,
            side: 'BUY',
          },
          {
            tickSize: verifiedTickSize,
            negRisk: negRisk,
          },
        ),
        { maxRetries: 2, baseDelayMs: 2000, label: `placeBet ${tokenId.slice(0, 12)}`, shouldRetry: shouldRetryNetworkError },
      );
    } catch (orderErr) {
      const errMsg = orderErr?.response?.data?.error || orderErr?.response?.data?.errorMsg || orderErr?.message || 'Unknown order error';

      if (!isMinSizeRejection(errMsg)) {
        throw orderErr;
      }

      // Market fallback requested by user: if limit BUY is rejected for min shares,
      // retry once as market BUY with configured max USD amount (e.g. $1).
      log.warn(`BUY limit rejected for min size (${errMsg}) — retrying market BUY for $${BET_AMOUNT.toFixed(2)} max`);

      const marketResponse = await retryWithBackoff(
        () => client.createAndPostMarketOrder(
          {
            tokenID: tokenId,
            amount: BET_AMOUNT,
            side: 'BUY',
            orderType: 'FAK',
          },
          {
            tickSize: verifiedTickSize,
            negRisk: negRisk,
          },
          'FAK',
          false,
        ),
        { maxRetries: 1, baseDelayMs: 1200, label: `placeBetMarketFallback ${tokenId.slice(0, 12)}`, shouldRetry: shouldRetryNetworkError },
      );

      if (marketResponse?.success) {
        const rawTaking = Number(marketResponse?.takingAmount);
        const rawMaking = Number(marketResponse?.makingAmount);
        const filledShares = Number.isFinite(rawTaking) && rawTaking > 0
          ? parseFloat((rawTaking / 1e6).toFixed(2))
          : parseFloat((BET_AMOUNT / Math.max(orderPrice, 0.0001)).toFixed(2));
        const spentUsd = Number.isFinite(rawMaking) && rawMaking > 0
          ? parseFloat((rawMaking / 1e6).toFixed(4))
          : BET_AMOUNT;

        log.info(`Bet placed via market BUY fallback: orderId=${marketResponse.orderID}, status=${marketResponse.status}, $${spentUsd} for ${filledShares} share(s)`);
        return {
          success: true,
          orderId: marketResponse.orderID,
          status: marketResponse.status,
          transactionHashes: marketResponse.transactionsHashes || [],
          amountUsd: spentUsd,
          shares: filledShares,
        };
      }

      const fallbackErr = extractOrderError(marketResponse) || errMsg;
      log.error(`Market BUY fallback failed: ${fallbackErr}`);
      return {
        success: false,
        orderId: null,
        status: 'failed',
        error: fallbackErr,
      };
    }

    if (response.success) {
      log.info(`Bet placed successfully: orderId=${response.orderID}, status=${response.status}, $${amountUsd} for ${shares} share(s)`);
      return {
        success: true,
        orderId: response.orderID,
        status: response.status,
        transactionHashes: response.transactionsHashes || [],
        amountUsd,
        shares,
      };
    } else {
      const errMsg = response.errorMsg || response.error || 'Unknown order error';
      log.error(`Bet failed: ${errMsg}`);
      return {
        success: false,
        orderId: null,
        status: 'failed',
        error: errMsg,
      };
    }
  } catch (err) {
    // Extract meaningful error from axios/CLOB response
    const respError = err.response?.data?.error || err.response?.data?.errorMsg;
    const errMsg = respError || err.message || 'Unknown error';
    const status = err.response?.status;

    // 400/404 = order rejected (e.g. below minimum size) — warn and skip, don't log as ERROR
    if (status === 400 || status === 404) {
      log.warn(`Bet rejected (HTTP ${status}): ${errMsg}`);
    } else {
      logDetailedError(log, 'Bet execution error', err, {
        tokenId,
        requestedPrice: price,
        finalPrice: orderPrice,
        shares,
      });
    }
    return {
      success: false,
      orderId: null,
      status: 'error',
      error: errMsg,
    };
  }
}

/**
 * Sell shares for a bet (used for take-profit).
 *
 * @param {object} params
 * @param {string} params.tokenId - Outcome token ID to sell
 * @param {number} params.price - Current price to sell at
 * @param {number} params.shares - Number of shares to sell
 * @param {boolean} params.negRisk
 * @param {string} params.tickSize
 * @param {'default'|'stop_loss'} [params.sellMode] - Optional pricing mode for sell placement
 * @returns {object} { success, orderId, status, error }
 */
export async function sellShares({ tokenId, price, shares = 1, negRisk = false, tickSize = '0.01', sellMode = 'default' }) {
  log.info(`Selling ${shares} share(s) of token ${tokenId} at price ${price}`);

  if (hasSellCooldown(tokenId)) {
    return { success: false, orderId: null, status: 'skipped', error: 'sell_cooldown_active' };
  }

  if (config.paperTrade()) {
    const payout = shares * price;
    log.info(`[PAPER TRADE] Simulated sell: ${shares} shares @ ${price} = $${payout.toFixed(4)}`);
    return {
      success: true,
      orderId: makeRuntimeId('paper_sell'),
      status: 'matched',
      paperTrade: true,
      payout,
      executedPrice: price,
    };
  }

  try {
    const client = await getClobClient();
    const verifiedTickSize = await fetchMinimumTickSize(tokenId, tickSize);

    // Always refresh real-time quotes right before posting SELL.
    const sellQuote = await getLatestExecutablePrice(client, tokenId, 'SELL').catch(() => null);
    const buyQuote = await getLatestExecutablePrice(client, tokenId, 'BUY').catch(() => null);
    const quotes = [sellQuote, buyQuote].filter((v) => Number.isFinite(v) && v > 0);
    if (quotes.length === 0) {
      throw new Error(`No valid quote to place SELL for token ${tokenId}`);
    }
    const bestBid = Math.min(...quotes);
    const bestAsk = Math.max(...quotes);
    const tick = Math.max(0.0001, parseFloat(verifiedTickSize || '0.01'));
    const minAllowed = Math.max(0.01, tick);
    const maxAllowed = 0.99;
    let orderPrice = quantizePriceToTick(bestAsk, verifiedTickSize, 'nearest');

    if (sellMode === 'stop_loss' && Number.isFinite(buyQuote) && Number.isFinite(sellQuote) && bestAsk > bestBid) {
      const midpoint = (bestBid + bestAsk) / 2;
      // User requested max 2-decimal sell price granularity and round-down behavior.
      const stopLossTick = Math.max(0.01, parseFloat(verifiedTickSize || '0.01'));
      const midpointRoundedDown = Math.floor((midpoint / stopLossTick) + 1e-9) * stopLossTick;
      const boundedMid = Math.max(bestBid, Math.min(bestAsk, midpointRoundedDown));
      orderPrice = Math.max(minAllowed, Math.min(maxAllowed, boundedMid));
      log.info(
        `STOP_LOSS sell pricing: bid=${bestBid.toFixed(4)} ask=${bestAsk.toFixed(4)} `
        + `mid=${midpoint.toFixed(4)} -> order=${orderPrice.toFixed(4)} (rounded_down_tick=${stopLossTick.toFixed(3)})`,
      );
    }

    if (orderPrice !== bestAsk && sellMode !== 'stop_loss') {
      log.info(`SELL price adjusted to valid range: raw_ask=${bestAsk} -> order=${orderPrice} (min=${minAllowed}, max=${maxAllowed})`);
    }
    log.info(`SELL quote refresh: requested=${price} bid=${bestBid} ask=${bestAsk} using_${sellMode === 'stop_loss' ? 'mid_rounded_down' : 'ask'}=${orderPrice} verified_tick_size=${verifiedTickSize}`);

    const marketMeta = await fetchMarketMetaByTokenId(tokenId).catch(() => null);
    const preferredNegRisk = marketMeta?.negRisk;
    const preferredTickSize = marketMeta?.tickSize;

    if (marketMeta) {
      log.info(`SELL market metadata: negRisk=${preferredNegRisk} tickSize=${preferredTickSize}`);
    }

    const minOrderSize = Number(marketMeta?.minSize || 0);

    const combos = [];
    const comboSet = new Set();
    const pushCombo = (nr, ts) => {
      const key = `${nr ? '1' : '0'}:${String(ts)}`;
      if (comboSet.has(key)) return;
      comboSet.add(key);
      combos.push({ negRisk: nr, tickSize: String(ts) });
    };

    // Try token-resolved metadata first, then caller params, then common alternatives.
    if (typeof preferredNegRisk === 'boolean') {
      pushCombo(preferredNegRisk, verifiedTickSize);
    }
    pushCombo(!!negRisk, verifiedTickSize);
    pushCombo(!negRisk, verifiedTickSize);
    if (typeof preferredNegRisk === 'boolean' && preferredTickSize) {
      pushCombo(preferredNegRisk, preferredTickSize);
      pushCombo(preferredNegRisk, '0.01');
    }
    pushCombo(!!negRisk, tickSize || '0.01');
    pushCombo(!negRisk, tickSize || '0.01');
    pushCombo(!!negRisk, '0.01');
    pushCombo(!negRisk, '0.01');
    pushCombo(!!negRisk, '0.001');
    pushCombo(!negRisk, '0.001');

    let response = null;
    let lastErrMsg = 'Unknown order error';

    if (minOrderSize > 0 && shares < minOrderSize) {
      // Some venues reject marketable small sizes but may allow resting post-only orders.
      const highestSeen = Number.isFinite(buyQuote) && buyQuote > 0
        ? Math.max(bestBid, bestAsk)
        : bestAsk;
      const restingBase = highestSeen + tick;
      const restingPrice = Math.max(minAllowed, Math.min(maxAllowed, toTick(restingBase, verifiedTickSize, 'up')));

      for (let i = 0; i < combos.length; i++) {
        const combo = combos[i];
        const postOnlyLabel = `sellShares-postOnly ${tokenId.slice(0, 12)} p${i + 1}/${combos.length} nr=${combo.negRisk ? 1 : 0} tick=${combo.tickSize}`;
        response = await retryWithBackoff(
          () => client.createAndPostOrder(
            {
              tokenID: tokenId,
              price: restingPrice,
              size: shares,
              side: 'SELL',
            },
            {
              tickSize: combo.tickSize,
              negRisk: combo.negRisk,
            },
            'GTC',
            false,
            true,
          ),
          { maxRetries: 1, baseDelayMs: 900, label: postOnlyLabel, shouldRetry: shouldRetryNetworkError },
        );

        if (response?.success) {
          log.info(`Small-size SELL posted as postOnly: size=${shares} min=${minOrderSize} price=${restingPrice}`);
          return {
            success: true,
            orderId: response.orderID,
            status: response.status,
            payout: shares * restingPrice,
            executedPrice: restingPrice,
          };
        }

        lastErrMsg = extractOrderError(response);
        const isInvalidSignature = String(lastErrMsg).toLowerCase().includes('invalid signature');
        if (!isInvalidSignature) break;
      }

      // Backup path: try market-style SELL (FAK) for small sizes.
      for (let i = 0; i < combos.length; i++) {
        const combo = combos[i];
        const marketLabel = `sellShares-marketFAK ${tokenId.slice(0, 12)} p${i + 1}/${combos.length} nr=${combo.negRisk ? 1 : 0} tick=${combo.tickSize}`;
        response = await retryWithBackoff(
          () => client.createAndPostMarketOrder(
            {
              tokenID: tokenId,
              amount: shares,
              side: 'SELL',
              orderType: 'FAK',
            },
            {
              tickSize: combo.tickSize,
              negRisk: combo.negRisk,
            },
            'FAK',
            false,
          ),
          { maxRetries: 1, baseDelayMs: 900, label: marketLabel, shouldRetry: shouldRetryNetworkError },
        );

        if (response?.success) {
          const px = Number.isFinite(Number(response?.takingAmount)) && shares > 0
            ? Number(response.takingAmount) / 1e6 / shares
            : orderPrice;
          log.info(`Small-size SELL executed via market FAK: size=${shares} min=${minOrderSize}`);
          return {
            success: true,
            orderId: response.orderID,
            status: response.status,
            payout: shares * px,
            executedPrice: px,
          };
        }

        lastErrMsg = extractOrderError(response);
        const isInvalidSignature = String(lastErrMsg).toLowerCase().includes('invalid signature');
        if (!isInvalidSignature) break;
      }

      const errMsg = extractOrderError(response) || lastErrMsg || `size_below_minimum: ${shares} < ${minOrderSize}`;
      setSellCooldown(tokenId, 6 * 60_000);
      return { success: false, orderId: null, status: 'skipped', error: errMsg.includes('size') ? errMsg : `size_below_minimum: ${shares} < ${minOrderSize}` };
    }

    for (let i = 0; i < combos.length; i++) {
      const combo = combos[i];
      const attemptLabel = `sellShares ${tokenId.slice(0, 12)} p${i + 1}/${combos.length} nr=${combo.negRisk ? 1 : 0} tick=${combo.tickSize}`;

      response = await retryWithBackoff(
        () => client.createAndPostOrder(
          {
            tokenID: tokenId,
            price: orderPrice,
            size: shares,
            side: 'SELL',
          },
          {
            tickSize: combo.tickSize,
            negRisk: combo.negRisk,
          },
        ),
        { maxRetries: 2, baseDelayMs: 1200, label: attemptLabel, shouldRetry: shouldRetryNetworkError },
      );

      if (response?.success) {
        if (i > 0) {
          log.info(`SELL fallback succeeded with negRisk=${combo.negRisk} tickSize=${combo.tickSize}`);
        }
        break;
      }

      lastErrMsg = extractOrderError(response);
      const isInvalidSignature = String(lastErrMsg).toLowerCase().includes('invalid signature');
      if (!isInvalidSignature) {
        // Non-signature error won't be fixed by toggling params.
        break;
      }
      log.warn(`SELL attempt failed with invalid signature; trying fallback params (${i + 1}/${combos.length})`);
    }

    if (response?.success) {
      log.info(`Sell placed: orderId=${response.orderID}, status=${response.status}`);
      return {
        success: true,
        orderId: response.orderID,
        status: response.status,
        payout: shares * orderPrice,
        executedPrice: orderPrice,
      };
    } else {
      const errMsg = extractOrderError(response) || lastErrMsg;
      if (String(errMsg).toLowerCase().includes('not enough balance / allowance')) {
        setSellCooldown(tokenId, 10 * 60_000);
      }
      log.error(`Sell failed: ${errMsg}`);
      return { success: false, orderId: null, status: 'failed', error: errMsg };
    }
  } catch (err) {
    const errMsg = err?.response?.data?.error || err.message;
    if (String(errMsg).toLowerCase().includes('not enough balance / allowance')) {
      setSellCooldown(tokenId, 10 * 60_000);
    }
    logDetailedError(log, 'Sell execution error', err, {
      tokenId,
      requestedPrice: price,
      shares,
      negRisk,
      tickSize,
    });
    return { success: false, orderId: null, status: 'error', error: errMsg };
  }
}

/**
 * Fetch open orders directly from Polymarket CLOB.
 * This catches manually placed bets (e.g. via the Polymarket website)
 * that are not tracked in the local DB.
 * @returns {object[]} Array of open order objects from the SDK
 */
export async function getPolymarketOpenOrders() {
  try {
    const client = await getClobClient();
    const orders = await client.getOpenOrders();
    return Array.isArray(orders) ? orders : [];
  } catch (err) {
    log.warn(`Failed to fetch open orders from Polymarket: ${err.message}`);
    return [];
  }
}

/**
 * Fetch open positions from Polymarket data API for a user/funder address.
 * @param {string} userAddress
 * @returns {Promise<object[]>}
 */
export async function getPolymarketPositions(userAddress) {
  if (!userAddress) return [];

  try {
    const url = new URL(`${config.dataHost}/positions`);
    url.searchParams.set('user', userAddress);

    const positions = await retryWithBackoff(
      async () => {
        const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
        if (!res.ok) throw new Error(`Positions API ${res.status} ${res.statusText}`);
        const data = await res.json();
        return Array.isArray(data) ? data : [];
      },
      { maxRetries: 2, baseDelayMs: 1000, label: `positions ${userAddress.slice(0, 8)}`, shouldRetry: shouldRetryNetworkError },
    );

    return positions;
  } catch (err) {
    log.warn(`Failed to fetch positions for ${userAddress.slice(0, 10)}...: ${err.message}`);
    return [];
  }
}

/**
 * Cancel a single open order by ID.
 * Tries multiple SDK method names for compatibility across clob-client versions.
 * @param {string} orderId
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function cancelPolymarketOrder(orderId) {
  if (!orderId) return { success: false, error: 'Missing orderId' };

  if (config.paperTrade()) {
    return { success: true };
  }

  try {
    const client = await getClobClient();

    // Keep call style flexible to match SDK API differences.
    // Try structured payload first (raw string payload produced 400 Invalid order payload in logs).
    const attempts = [
      () => (typeof client.cancelOrder === 'function' ? client.cancelOrder({ orderID: orderId }) : null),
      () => (typeof client.cancelOrder === 'function' ? client.cancelOrder({ orderId }) : null),
      () => (typeof client.cancelOrders === 'function' ? client.cancelOrders([orderId]) : null),
      () => (typeof client.cancel === 'function' ? client.cancel(orderId) : null),
      () => (typeof client.cancelOrder === 'function' ? client.cancelOrder(orderId) : null),
    ];

    let lastError = null;
    for (const invoke of attempts) {
      try {
        const response = await invoke();
        if (response === null || response === undefined) continue;

        if (response === true) {
          log.info(`Canceled open order ${orderId}`);
          return { success: true };
        }

        if (response?.error) {
          lastError = response.error;
          continue;
        }
        if (response?.success === false) {
          lastError = response.errorMsg || 'Cancellation failed';
          continue;
        }
        if (response?.success === true) {
          log.info(`Canceled open order ${orderId}`);
          return { success: true };
        }
        if (Array.isArray(response?.canceled) && response.canceled.map(String).includes(String(orderId))) {
          log.info(`Canceled open order ${orderId}`);
          return { success: true };
        }

        lastError = `Unexpected cancel response shape: ${JSON.stringify(response).slice(0, 220)}`;
        continue;
      } catch (err) {
        lastError = err.message;
      }
    }

    return { success: false, error: lastError || 'No compatible cancel method found on CLOB client' };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Get the current best price for a token.
 * @param {string} tokenId
 * @returns {number|null} Current price or null
 */
export async function getCurrentPrice(tokenId) {
  if (hasNoOrderbookRecently(tokenId)) {
    return null;
  }

  try {
    const client = await getClobClient();
    const result = await retryWithBackoff(
      // Use SELL side first for exit decisions (take-profit / stop-loss), then fall back to BUY if needed.
      async () => {
        const sell = await client.getPrice(tokenId, 'SELL');
        if (hasNoOrderbookError(sell)) {
          markNoOrderbook(tokenId);
          return null;
        }
        if (sell?.price) return sell;
        const buy = await client.getPrice(tokenId, 'BUY');
        if (hasNoOrderbookError(buy)) {
          markNoOrderbook(tokenId);
          return null;
        }
        return buy;
      },
      { maxRetries: 2, baseDelayMs: 1000, label: `getPrice ${tokenId.slice(0, 12)}`, shouldRetry: shouldRetryNetworkError },
    );
    if (hasNoOrderbookError(result)) {
      markNoOrderbook(tokenId);
      return null;
    }
    return result?.price ? parseFloat(result.price) : null;
  } catch (err) {
    if (hasNoOrderbookError(err)) {
      markNoOrderbook(tokenId);
      return null;
    }
    log.warn(`Failed to get price for ${tokenId}: ${err.message}`);
    return null;
  }
}

/**
 * Get current executable SELL-side price for exit decisions.
 * Unlike getCurrentPrice, this does not fall back to BUY-side quote.
 * @param {string} tokenId
 * @returns {number|null}
 */
export async function getCurrentExitPrice(tokenId) {
  if (hasNoOrderbookRecently(tokenId)) {
    return null;
  }

  try {
    const client = await getClobClient();
    const result = await retryWithBackoff(
      () => client.getPrice(tokenId, 'SELL'),
      { maxRetries: 2, baseDelayMs: 1000, label: `getExitPrice ${tokenId.slice(0, 12)}`, shouldRetry: shouldRetryNetworkError },
    );
    if (hasNoOrderbookError(result)) {
      markNoOrderbook(tokenId);
      return null;
    }
    return result?.price ? parseFloat(result.price) : null;
  } catch (err) {
    if (hasNoOrderbookError(err)) {
      markNoOrderbook(tokenId);
      return null;
    }
    log.warn(`Failed to get exit price for ${tokenId}: ${err.message}`);
    return null;
  }
}

/**
 * Get current executable BUY-side price for entry decisions.
 * Unlike getCurrentPrice, this does not fall back to SELL-side quote.
 * @param {string} tokenId
 * @returns {number|null}
 */
export async function getCurrentEntryPrice(tokenId) {
  if (hasNoOrderbookRecently(tokenId)) {
    return null;
  }

  try {
    const client = await getClobClient();
    const result = await retryWithBackoff(
      () => client.getPrice(tokenId, 'BUY'),
      { maxRetries: 2, baseDelayMs: 1000, label: `getEntryPrice ${tokenId.slice(0, 12)}`, shouldRetry: shouldRetryNetworkError },
    );
    if (hasNoOrderbookError(result)) {
      markNoOrderbook(tokenId);
      return null;
    }
    return result?.price ? parseFloat(result.price) : null;
  } catch (err) {
    if (hasNoOrderbookError(err)) {
      markNoOrderbook(tokenId);
      return null;
    }
    log.warn(`Failed to get entry price for ${tokenId}: ${err.message}`);
    return null;
  }
}

/**
 * Fetch price history for a token at multiple time windows.
 * Uses the CLOB midpoint prices and stores snapshots.
 *
 * @param {string} tokenId
 * @returns {{ current: number|null, change24h: number|null, change6h: number|null, change1h: number|null, change10m: number|null }}
 */
export async function getPriceHistory(tokenId) {
  try {
    const client = await getClobClient();

    // Fetch current price
    const current = await getCurrentPrice(tokenId);
    if (current === null) return { current: null, change24h: null, change6h: null, change1h: null, change10m: null };

    // Use the Gamma timeseries/prices endpoint for historical data
    // GET /prices?market=<tokenId>&interval=max&fidelity=60 gives us hourly data points
    const intervals = [
      { label: 'change24h', seconds: 86400 },
      { label: 'change6h',  seconds: 21600 },
      { label: 'change1h',  seconds: 3600 },
      { label: 'change10m', seconds: 600 },
    ];

    const result = { current };

    // Use the SDK's getPricesHistory method (correct per docs)
    try {
      const history = await client.getPricesHistory({
        market: tokenId,
        interval: '1d',
        fidelity: 1,
      });
      // SDK returns MarketPrice[] directly: [{t, p}, ...]
      const points = Array.isArray(history) ? history : [];
      const now = Math.floor(Date.now() / 1000);

      for (const { label, seconds } of intervals) {
        const targetTs = now - seconds;
        let closest = null;
        let closestDiff = Infinity;
        for (const point of points) {
          const ts = point.t || 0;
          const diff = Math.abs(ts - targetTs);
          if (diff < closestDiff) {
            closestDiff = diff;
            closest = point;
          }
        }
        if (closest && closestDiff < seconds * 0.5) {
          const oldPrice = parseFloat(closest.p || '0');
          result[label] = oldPrice > 0 ? (current - oldPrice) / oldPrice : null;
        } else {
          result[label] = null;
        }
      }
    } catch {
      for (const { label } of intervals) result[label] = null;
    }

    return result;
  } catch (err) {
    log.warn(`Failed to get price history for ${tokenId}: ${err.message}`);
    return { current: null, change24h: null, change6h: null, change1h: null, change10m: null };
  }
}
