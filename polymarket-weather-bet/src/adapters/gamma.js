import { config } from '../config.js';
import { createLogger } from '../logger.js';
import { retryWithBackoff, shouldRetryNetworkError } from '../retry.js';

const log = createLogger('gamma');

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

  return retryWithBackoff(
    async () => {
      const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`Gamma API ${res.status} ${res.statusText}`);
      const data = await res.json();
      return Array.isArray(data) ? data : [];
    },
    { maxRetries: 3, baseDelayMs: 1500, label: `Gamma tag=${tagSlug} offset=${offset}`, shouldRetry: shouldRetryNetworkError }
  );
}

export async function fetchAllActiveEvents(limit = 200, offset = 0) {
  const url = new URL(`${config.gammaHost}/events`);
  url.searchParams.set('active', 'true');
  url.searchParams.set('closed', 'false');
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('offset', String(offset));
  url.searchParams.set('order', 'startTime');
  url.searchParams.set('ascending', 'true');
  url.searchParams.set('end_date_min', new Date().toISOString());

  return retryWithBackoff(
    async () => {
      const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`Gamma API ${res.status} ${res.statusText}`);
      const data = await res.json();
      return Array.isArray(data) ? data : [];
    },
    { maxRetries: 3, baseDelayMs: 1500, label: `Gamma all offset=${offset}`, shouldRetry: shouldRetryNetworkError }
  );
}

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

  log.debug(`Gamma markets fetch: ${url}`);
  return retryWithBackoff(
    async () => {
      const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`Gamma API ${res.status} ${res.statusText}`);
      const data = await res.json();
      return Array.isArray(data) ? data : [];
    },
    { maxRetries: 3, baseDelayMs: 1500, label: `Gamma markets offset=${offset}`, shouldRetry: shouldRetryNetworkError }
  );
}
