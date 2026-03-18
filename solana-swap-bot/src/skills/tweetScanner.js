// src/skills/tweetScanner.js — Twitter/X signal fetcher via external scraper server
// Uses SCRAPER_SERVER_ADDRESS and calls the scraper server endpoint: GET /x

import { config } from '../config.js';
import { createLogger } from '../logger.js';
import { fetchWithTimeout } from '../http.js';

const log = createLogger('tweetScanner');

function normalizeBaseUrl(value) {
  const raw = String(value || '').trim();
  return raw.replace(/\/+$/, '');
}

function toTweetResult(item, matchedKeywords) {
  const text = String(
    item?.text || item?.content || item?.snippet || item?.title || ''
  ).trim();
  if (!text) return null;

  const author = String(
    item?.author || item?.username || item?.user || item?.handle || 'unknown'
  ).trim();

  const published = String(
    item?.published || item?.date || item?.timestamp || item?.time || 'unknown'
  ).trim();

  const url = String(item?.url || item?.link || '').trim();

  return {
    text: text.slice(0, 280),
    author,
    published,
    url,
    keywords: matchedKeywords,
  };
}

/**
 * Scan Twitter/X for tweets matching Solana keywords from the last `maxAgeMinutes`.
 * Fetches recent tweets from curated crypto/Solana accounts and filters by keywords.
 * Falls back to searchTweets if available (often broken due to Twitter API changes).
 * @param {number} [maxAgeMinutes=120] — only include tweets from this window
 * @param {number} [maxResults=20] — cap total tweet count
 * @param {string[]} [searchTerms=[]] - explicit X search terms; when provided, each term triggers one /x request
 * @returns {Array<{text: string, author: string, published: string, url: string, keywords: string[]}>}
 */
export async function scanTweets(maxAgeMinutes = 120, maxResults = 20, searchTerms = []) {
  const baseUrl = normalizeBaseUrl(config.scraperServerAddress);
  if (!baseUrl) {
    log.info('Tweet scan disabled: SCRAPER_SERVER_ADDRESS is not set');
    return [];
  }

  const apiKey = String(config.scraperServerApiKey || '').trim();
  const headers = apiKey
    ? {
        'x-api-key': apiKey,
        Authorization: `Bearer ${apiKey}`,
      }
    : {};

  const keywords = (config.solanaKeywords || []).slice(0, 10);
  if (!keywords.length && (!Array.isArray(searchTerms) || !searchTerms.length)) {
    log.warn('No solanaKeywords configured — skipping tweet scan');
    return [];
  }

  const providedTerms = Array.isArray(searchTerms)
    ? searchTerms.map(s => String(s || '').trim()).filter(Boolean)
    : [];
  const searches = providedTerms.length ? providedTerms.slice(0, 3) : keywords.slice(0, 3);
  if (!searches.length) return [];

  const cutoff = new Date(Date.now() - maxAgeMinutes * 60_000);
  const perSearch = Math.max(1, Math.ceil(maxResults / searches.length));
  const results = [];
  const seen = new Set();

  log.info(`Tweet scan via scraper server ${baseUrl} — searches=${searches.join(' | ')} maxResults=${maxResults} auth=${apiKey ? 'on' : 'off'}`);

  for (const search of searches) {
    if (results.length >= maxResults) break;
    const url = new URL('/x', baseUrl);
    url.searchParams.set('search', search);
    url.searchParams.set('results', String(perSearch));

    try {
      const resp = await fetchWithTimeout(url, {
        headers,
        timeoutMs: config.httpTimeoutMs,
      });
      if (!resp.ok) {
        log.warn(`Scraper /x failed for "${search}": HTTP ${resp.status}`);
        continue;
      }

      const payload = await resp.json();
      const rows = Array.isArray(payload?.results) ? payload.results : [];

      for (const row of rows) {
        if (results.length >= maxResults) break;
        const text = String(row?.text || row?.content || row?.snippet || '').toLowerCase();
        const matched = keywords.filter(kw => text.includes(kw.toLowerCase()));

        const normalized = toTweetResult(row, matched.length ? matched : [search]);
        if (!normalized) continue;

        const key = normalized.url || `${normalized.author}|${normalized.text}`;
        if (seen.has(key)) continue;
        seen.add(key);

        // Optional time filter when published is parseable.
        const publishedMs = Date.parse(normalized.published);
        if (Number.isFinite(publishedMs) && publishedMs < cutoff.getTime()) continue;

        results.push(normalized);
      }
    } catch (err) {
      log.warn(`Scraper request failed for "${search}": ${err.message}`);
    }
  }

  log.info(`Tweet scan complete via scraper server: ${results.length} tweet(s)`);
  return results;
}
