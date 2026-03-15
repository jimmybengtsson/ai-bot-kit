// src/adapters/gamma.js — Gamma API client for Polymarket event data
import { config } from '../config.js';
import { createLogger } from '../logger.js';
import { retryWithBackoff, shouldRetryNetworkError } from '../retry.js';

const log = createLogger('gamma');

const CACHE_TTL_MS = 30 * 60_000;
const gammaCache = new Map();

export function getCachedGamma(key) {
  const entry = gammaCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) {
    gammaCache.delete(key);
    return null;
  }
  return entry.data;
}

export function setCachedGamma(key, data) {
  gammaCache.set(key, { data, fetchedAt: Date.now() });
}

export function clearGammaCache() {
  gammaCache.clear();
  log.info('Gamma API cache cleared');
}

function normalizeMarketQuestion(market) {
  if (!market || typeof market !== 'object') return null;
  const question = String(market?.question || '').trim();
  if (question) return question;
  const eventTitle = String(market?.events?.[0]?.title || '').trim();
  if (eventTitle) return eventTitle;
  return null;
}

function sameText(a, b) {
  return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
}

async function fetchMarketsByConditionId(conditionId) {
  const cid = String(conditionId || '').trim();
  if (!cid) return [];

  const cacheKey = `market_by_condition:${cid}`;
  const cached = getCachedGamma(cacheKey);
  if (cached) return cached;

  const paramsToTry = ['condition_ids', 'condition_id', 'conditionId'];
  for (const paramName of paramsToTry) {
    const url = new URL(`${config.gammaHost}/markets`);
    url.searchParams.set('limit', '50');
    url.searchParams.set(paramName, cid);

    const rows = await retryWithBackoff(
      async () => {
        const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
        if (!res.ok) throw new Error(`Gamma markets-by-condition ${res.status} ${res.statusText}`);
        const data = await res.json();
        return Array.isArray(data) ? data : [];
      },
      {
        maxRetries: 1,
        baseDelayMs: 800,
        label: `Gamma markets by condition ${cid.slice(0, 18)} (${paramName})`,
        shouldRetry: shouldRetryNetworkError,
      },
    ).catch(() => []);

    const matched = rows.filter((m) => sameText(m?.conditionId || m?.condition_id, cid));
    if (matched.length > 0) {
      setCachedGamma(cacheKey, matched);
      return matched;
    }
  }

  setCachedGamma(cacheKey, []);
  return [];
}

/**
 * Fetch market question/title from Gamma by market id.
 * @param {string|number} marketId
 * @returns {Promise<string|null>}
 */
export async function fetchMarketQuestionById(marketId) {
  if (marketId === null || marketId === undefined || marketId === '') return null;
  const marketIdStr = String(marketId).trim();
  // Gamma /markets/{id} expects a Gamma market id; CLOB order `market` often carries
  // condition ids like 0x..., which return 422. Skip those to avoid retry noise.
  if (!/^\d+$/.test(marketIdStr)) return null;
  const key = `market_question:id:${marketIdStr}`;
  const cached = getCachedGamma(key);
  if (cached !== null && cached !== undefined) return cached;

  const url = `${config.gammaHost}/markets/${encodeURIComponent(marketIdStr)}`;
  const market = await retryWithBackoff(
    async () => {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`Gamma market-by-id ${res.status} ${res.statusText}`);
      return res.json();
    },
    {
      maxRetries: 2,
      baseDelayMs: 900,
      label: `Gamma market by id ${marketIdStr.slice(0, 18)}`,
      shouldRetry: shouldRetryNetworkError,
    },
  );

  const question = normalizeMarketQuestion(market);
  setCachedGamma(key, question);
  return question;
}

/**
 * Fetch market question/title from Gamma using a CLOB token id.
 * @param {string} tokenId
 * @returns {Promise<string|null>}
 */
export async function fetchMarketQuestionByTokenId(tokenId) {
  if (!tokenId) return null;
  const key = `market_question:token:${String(tokenId)}`;
  const cached = getCachedGamma(key);
  if (cached !== null && cached !== undefined) return cached;

  const url = new URL(`${config.gammaHost}/markets`);
  url.searchParams.set('active', 'true');
  url.searchParams.set('closed', 'false');
  url.searchParams.set('limit', '1');
  url.searchParams.set('clob_token_ids', String(tokenId));

  const rows = await retryWithBackoff(
    async () => {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`Gamma market-by-token ${res.status} ${res.statusText}`);
      const data = await res.json();
      return Array.isArray(data) ? data : [];
    },
    {
      maxRetries: 2,
      baseDelayMs: 900,
      label: `Gamma market by token ${String(tokenId).slice(0, 18)}`,
      shouldRetry: shouldRetryNetworkError,
    },
  );

  const question = normalizeMarketQuestion(rows[0] || null);
  setCachedGamma(key, question);
  return question;
}

/**
 * Resolve market question/title from user-order references.
 * Priority: token id -> condition id (hex) -> numeric market id.
 * @param {object} refs
 * @param {string} [refs.tokenId]
 * @param {string|number} [refs.marketId]
 * @returns {Promise<string|null>}
 */
export async function fetchMarketQuestionByOrderRefs({ tokenId, marketId }) {
  const t = String(tokenId || '').trim();
  const m = String(marketId || '').trim();

  if (t) {
    const qByToken = await fetchMarketQuestionByTokenId(t).catch(() => null);
    if (qByToken) return qByToken;
  }

  if (m) {
    // CLOB order.market commonly carries conditionId (hex), not Gamma numeric id.
    if (m.startsWith('0x')) {
      const rows = await fetchMarketsByConditionId(m).catch(() => []);
      const qByCondition = normalizeMarketQuestion(rows[0] || null);
      if (qByCondition) return qByCondition;
    }

    if (/^\d+$/.test(m)) {
      const qById = await fetchMarketQuestionById(m).catch(() => null);
      if (qById) return qById;
    }
  }

  return null;
}

/**
 * Fetch a single market by token id from Gamma and return metadata useful for order signing.
 * @param {string} tokenId
 * @returns {Promise<{negRisk:boolean, tickSize:string}|null>}
 */
export async function fetchMarketMetaByTokenId(tokenId) {
  if (!tokenId) return null;
  const cacheKey = `market_meta:${tokenId}`;
  const cached = getCachedGamma(cacheKey);
  if (cached) return cached;

  const url = new URL(`${config.gammaHost}/markets`);
  url.searchParams.set('active', 'true');
  url.searchParams.set('closed', 'false');
  url.searchParams.set('limit', '1');
  url.searchParams.set('clob_token_ids', String(tokenId));

  const rows = await retryWithBackoff(
    async () => {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`Gamma API ${res.status} ${res.statusText}`);
      const data = await res.json();
      return Array.isArray(data) ? data : [];
    },
    { maxRetries: 2, baseDelayMs: 1000, label: `Gamma market meta ${String(tokenId).slice(0, 12)}`, shouldRetry: shouldRetryNetworkError },
  );

  if (!rows.length) return null;
  const m = rows[0];
  const result = {
    negRisk: Boolean(m?.negRisk ?? m?.neg_risk ?? false),
    tickSize: String(m?.orderPriceMinTickSize ?? m?.minimum_tick_size ?? m?.min_tick_size ?? '0.01'),
    minSize: Number(m?.orderMinSize ?? m?.order_min_size ?? m?.minSize ?? 0) || 0,
  };
  setCachedGamma(cacheKey, result);
  return result;
}

/**
 * Fetch active weather events from Gamma API (tag_slug=weather).
 */
export async function fetchWeatherEvents(limit = 200, offset = 0) {
  return fetchTaggedEvents('weather', limit, offset);
}

/**
 * Fetch active events by a specific tag slug.
 */
export async function fetchTaggedEvents(tagSlug, limit = 200, offset = 0) {
  const url = new URL(`${config.gammaHost}/events`);
  url.searchParams.set('active', 'true');
  url.searchParams.set('closed', 'false');
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('offset', String(offset));
  url.searchParams.set('order', 'startTime');
  url.searchParams.set('ascending', 'true');
  url.searchParams.set('end_date_min', new Date().toISOString());
  if (tagSlug) url.searchParams.set('tag_slug', String(tagSlug));

  log.debug(`Fetching Gamma tagged events (${tagSlug || 'none'}): ${url}`);
  return retryWithBackoff(
    async () => {
      const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`Gamma API ${res.status} ${res.statusText}`);
      const data = await res.json();
      return Array.isArray(data) ? data : [];
    },
    { maxRetries: 3, baseDelayMs: 2000, label: `Gamma tag=${tagSlug} offset=${offset}`, shouldRetry: shouldRetryNetworkError },
  );
}

/**
 * Fetch ALL active events (no tag filter) — fallback for untagged weather events.
 */
export async function fetchAllActiveEvents(limit = 200, offset = 0) {
  const url = new URL(`${config.gammaHost}/events`);
  url.searchParams.set('active', 'true');
  url.searchParams.set('closed', 'false');
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('offset', String(offset));
  url.searchParams.set('order', 'startTime');
  url.searchParams.set('ascending', 'true');
  url.searchParams.set('end_date_min', new Date().toISOString());

  log.debug(`Fetching all Gamma events: ${url}`);
  return retryWithBackoff(
    async () => {
      const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`Gamma API ${res.status} ${res.statusText}`);
      const data = await res.json();
      return Array.isArray(data) ? data : [];
    },
    { maxRetries: 3, baseDelayMs: 2000, label: `Gamma all offset=${offset}`, shouldRetry: shouldRetryNetworkError },
  );
}

/**
 * Fetch active markets from Gamma API (market-level fallback source).
 * Supports end-date window filters so we can avoid scanning far-future markets.
 */
export async function fetchActiveMarkets(limit = 200, offset = 0, { endDateMin, endDateMax, tagSlug } = {}) {
  const url = new URL(`${config.gammaHost}/markets`);
  url.searchParams.set('active', 'true');
  url.searchParams.set('closed', 'false');
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('offset', String(offset));
  url.searchParams.set('order', 'endDate');
  url.searchParams.set('ascending', 'true');
  if (endDateMin) url.searchParams.set('end_date_min', endDateMin);
  if (endDateMax) url.searchParams.set('end_date_max', endDateMax);
  if (tagSlug) url.searchParams.set('tag_slug', String(tagSlug));

  log.debug(`Fetching Gamma active markets: ${url}`);
  return retryWithBackoff(
    async () => {
      const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`Gamma API ${res.status} ${res.statusText}`);
      const data = await res.json();
      return Array.isArray(data) ? data : [];
    },
    { maxRetries: 3, baseDelayMs: 2000, label: `Gamma markets offset=${offset}`, shouldRetry: shouldRetryNetworkError },
  );
}
