import { config } from '../config.js';
import { createLogger } from '../logger.js';
import { getClobClient } from '../wallet.js';
import { retryWithBackoff, shouldRetryNetworkError } from '../retry.js';
import { OrderType } from '@polymarket/clob-client';

const log = createLogger('clob');

function parseTickSizeValue(payload, fallback = '0.01') {
  const raw = payload?.minimum_tick_size
    || payload?.min_tick_size
    || payload?.tick_size
    || payload?.tickSize
    || payload;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return String(fallback || '0.01');
  return String(raw);
}

function decimalsFromTickSize(tickSize) {
  const s = String(tickSize || '0.01');
  if (!s.includes('.')) return 0;
  return s.split('.')[1].length;
}

function alignPriceToTick(price, tickSize) {
  const step = Number(tickSize);
  if (!Number.isFinite(step) || step <= 0) return price;
  const decimals = decimalsFromTickSize(tickSize);
  const aligned = Math.round(price / step) * step;
  return Number(aligned.toFixed(decimals));
}

async function resolveLiveTickSize(client, tokenId, fallbackTickSize) {
  try {
    const payload = await retryWithBackoff(
      () => client.getTickSize(tokenId),
      { maxRetries: 2, baseDelayMs: 700, label: `tickSize ${String(tokenId).slice(0, 12)}`, shouldRetry: shouldRetryNetworkError },
    );
    return parseTickSizeValue(payload, fallbackTickSize || '0.01');
  } catch (err) {
    log.warn(`Tick size fetch failed for token ${String(tokenId).slice(0, 12)}: ${err.message}`);
    return String(fallbackTickSize || '0.01');
  }
}

export async function getPolymarketPositions(userAddress) {
  if (!userAddress) return [];

  try {
    const url = new URL(`${config.dataHost}/positions`);
    url.searchParams.set('user', userAddress);

    return retryWithBackoff(
      async () => {
        const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
        if (!res.ok) throw new Error(`Positions API ${res.status} ${res.statusText}`);
        const data = await res.json();
        return Array.isArray(data) ? data : [];
      },
      { maxRetries: 2, baseDelayMs: 1000, label: 'positions', shouldRetry: shouldRetryNetworkError },
    );
  } catch (err) {
    log.warn(`Failed to fetch positions: ${err.message}`);
    return [];
  }
}

export async function getYesAskPrice(tokenId, fallbackPrice = null) {
  if (!tokenId) return fallbackPrice;

  try {
    const client = await getClobClient();
    const quote = await retryWithBackoff(
      () => client.getPrice(tokenId, 'BUY'),
      { maxRetries: 2, baseDelayMs: 700, label: `ask ${tokenId.slice(0, 12)}`, shouldRetry: shouldRetryNetworkError },
    );
    const px = quote?.price ? parseFloat(quote.price) : null;
    return Number.isFinite(px) && px > 0 ? px : fallbackPrice;
  } catch (err) {
    log.warn(`Failed ask quote for token ${tokenId.slice(0, 12)}: ${err.message}`);
    return fallbackPrice;
  }
}

export async function getOpenOrders(makerAddress) {
  try {
    const client = await getClobClient();
    return retryWithBackoff(
      () => (makerAddress
        ? client.getOpenOrders({ maker_address: makerAddress })
        : client.getOpenOrders()),
      { maxRetries: 2, baseDelayMs: 1000, label: 'openOrders', shouldRetry: shouldRetryNetworkError },
    );
  } catch (err) {
    log.warn(`Failed to fetch open orders: ${err.message}`);
    return [];
  }
}

export async function placeYesOrder({ tokenId, askPrice, shares, negRisk = false, tickSize = '0.01' }) {
  if (config.paperTrade()) {
    const notional = parseFloat((askPrice * shares).toFixed(4));
    log.info(`[PAPER] BUY ${shares} @${askPrice} token=${tokenId.slice(0, 12)}... notional=$${notional}`);
    return {
      success: true,
      paperTrade: true,
      orderId: `paper_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      shares,
      askPrice,
      notional,
    };
  }

  try {
    const client = await getClobClient();
    const liveTickSize = await resolveLiveTickSize(client, tokenId, tickSize);
    const alignedPrice = alignPriceToTick(askPrice, liveTickSize);
    const expirySeconds = Math.max(1, config.orderExpiryMinutes) * 60;
    const expiration = Math.floor(Date.now() / 1000) + expirySeconds;
    const response = await retryWithBackoff(
      () => client.createAndPostOrder(
        {
          tokenID: tokenId,
          price: alignedPrice,
          size: shares,
          side: 'BUY',
          expiration,
        },
        { tickSize: liveTickSize, negRisk },
        OrderType.GTD,
      ),
      { maxRetries: 2, baseDelayMs: 1200, label: `placeYes ${tokenId.slice(0, 12)}`, shouldRetry: shouldRetryNetworkError },
    );

    if (response?.success) {
      log.info(`Order placed: orderId=${response.orderID} BUY ${shares} @${alignedPrice} tick=${liveTickSize} expiresIn=${config.orderExpiryMinutes}m`);
      return { success: true, orderId: response.orderID, status: response.status, shares, askPrice: alignedPrice, tickSize: liveTickSize };
    }

    const errMsg = response?.errorMsg || response?.error || 'Unknown order error';
    log.warn(`Order rejected: ${errMsg}`);
    return { success: false, error: errMsg };
  } catch (err) {
    const msg = err.response?.data?.error || err.response?.data?.errorMsg || err.message;
    log.warn(`Order failed: ${msg}`);
    return { success: false, error: msg };
  }
}
