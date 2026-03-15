// src/skills/eventScanner.js — Scan Polymarket for weather event markets
// Domain layer: weather event classification, location extraction, outcome extraction.
// API infrastructure lives in adapters/gamma.js.
import { config } from '../config.js';
import { createLogger } from '../logger.js';
import {
  fetchWeatherEvents, fetchTaggedEvents, fetchAllActiveEvents, fetchActiveMarkets,
  getCachedGamma, setCachedGamma, clearGammaCache,
} from '../adapters/gamma.js';

export { clearGammaCache } from '../adapters/gamma.js';

const log = createLogger('eventScanner');

// Tags that indicate metadata, not locations
const NON_LOCATION_TAGS = new Set([
  'weather', 'recurring', 'hide-from-new', 'daily-temperature',
  'temperature', 'climate', 'precipitation', 'snow', 'wind',
]);

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function phraseRegex(phrase) {
  const normalized = String(phrase || '').trim().toLowerCase();
  if (!normalized) return null;
  const escaped = escapeRegex(normalized).replace(/\s+/g, '\\s+');
  return new RegExp(`\\b${escaped}\\b`, 'i');
}

function hasWeatherKeyword(text) {
  return config.weatherKeywords.some((kw) => {
    const re = phraseRegex(kw);
    return re ? re.test(text) : false;
  });
}

/**
 * Classify whether a Polymarket event is a weather event and extract details.
 * @param {object} event - Gamma event
 * @returns {{ isWeather: boolean, category: string|null, location: string|null, locationSource: string|null, description: string|null }}
 */
function classifyWeatherEvent(event) {
  const title = (event.title || event.question || '').trim();
  const titleLower = title.toLowerCase();
  const desc = (event.description || '').toLowerCase();
  const tags = (event.tags || []).map(t => (typeof t === 'string' ? t : t.slug || t.label || '').toLowerCase());
  const combined = `${titleLower} ${desc} ${tags.join(' ')}`;

  // Check if tagged as weather
  const isTaggedWeather = tags.some(t => t === 'weather' || t === 'climate' || t === 'temperature');

  // Strict word/phrase matching against weather keywords to avoid substring false positives
  const keywordMatch = hasWeatherKeyword(combined);

  if (!isTaggedWeather && !keywordMatch) {
    return { isWeather: false, category: null, location: null, locationSource: null, description: null };
  }

  // Determine weather category
  let category = 'general';
  if (/\btemperature\b|\bdegrees\b|\bfahrenheit\b|\bcelsius\b|°[fc]|\bbelow zero\b|\brecord (high|low)\b|\bheat index\b|\bwind chill\b|\bcold\b|\bhot\b|\bwarm\b|\bfreeze\b|\bfrost\b/i.test(combined)) {
    category = 'temperature';
  } else if (/\brain\b|\bprecipitation\b|\binches.*rain\b|\brainfall\b/i.test(combined)) {
    category = 'precipitation';
  } else if (/\bsnow\b|\bblizzard\b|\bice storm\b|\bsnowfall\b|\binches.*snow\b/i.test(combined)) {
    category = 'snow';
  } else if (/\bhurricane\b|\btropical storm\b|\bcyclone\b|\btyphoon\b/i.test(combined)) {
    category = 'tropical';
  } else if (/\btornado\b|\bsevere.*storm\b|\bhail\b/i.test(combined)) {
    category = 'severe';
  } else if (/\bhumidity\b|\bdew point\b/i.test(combined)) {
    category = 'humidity';
  } else if (/\bwind\b|\bgusts?\b|\bmph\b.*\bwind\b/i.test(combined)) {
    category = 'wind';
  } else if (/\bflood\b|\bdrought\b/i.test(combined)) {
    category = 'flooding';
  }

  // Extract location — try tags first (Polymarket tags include city names), then title
  const tagLocation = extractLocationFromTags(event.tags);
  const titleLocation = tagLocation ? null : extractLocationFromTitle(title);
  const location = tagLocation || titleLocation;
  const locationSource = tagLocation ? 'tag' : (titleLocation ? 'title' : null);

  return {
    isWeather: true,
    category,
    location,
    locationSource,
    description: title,
  };
}

/**
 * Extract location from Polymarket event tags.
 * Real API tags include city-specific tags like {label: 'London', slug: 'london'}.
 * @param {Array} tags - Raw tags array from API
 * @returns {string|null}
 */
function extractLocationFromTags(tags) {
  if (!Array.isArray(tags)) return null;

  for (const tag of tags) {
    const slug = (typeof tag === 'string' ? tag : tag.slug || '').toLowerCase();
    if (NON_LOCATION_TAGS.has(slug)) continue;
    // Skip generic/utility tags
    if (slug.includes('hide') || slug.includes('recurring')) continue;

    const label = typeof tag === 'string' ? tag : tag.label || '';
    if (label && !NON_LOCATION_TAGS.has(label.toLowerCase())) {
      return label;
    }
  }
  return null;
}

/**
 * Extract a city/location name from event title using common patterns.
 * Handles "temperature in London", "weather in NYC", etc.
 * @param {string} title
 * @returns {string|null}
 */
function extractLocationFromTitle(title) {
  // "... in <City> on <Date>?" or "... in <City>?"
  const inMatch = title.match(/\bin\s+([A-Z][A-Za-z\s.'-]+?)(?:\s+on\s|\s*\?)/);
  if (inMatch) return inMatch[1].trim();

  // "<City>, <State>" pattern
  const stateMatch = title.match(/\b([A-Z][a-z]+(?:\s[A-Z][a-z]+)*),?\s*([A-Z]{2})\b/);
  if (stateMatch) return stateMatch[1];

  return null;
}

/**
 * Parse the event resolution/end time.
 * @param {object} event
 * @returns {Date|null}
 */
function parseEventEndTime(event) {
  const candidates = [
    event.endDate,
    ...(event.markets || []).map(m => m.endDate || m.end_date),
    event.startTime,
  ].filter(Boolean);

  for (const timeStr of candidates) {
    const d = new Date(timeStr);
    if (!isNaN(d.getTime())) return d;
  }
  return null;
}

function normalizeMarketToEventLike(market) {
  const parentEvent = market.events?.[0] || {};
  return {
    ...market,
    id: `market_${market.id || market.slug || market.question || Date.now()}`,
    title: parentEvent.title || market.question || '',
    description: parentEvent.description || market.description || '',
    tags: parentEvent.tags || [],
    // Keep a markets array shape so downstream extraction remains consistent.
    markets: [market],
  };
}

/**
 * Extract market outcomes with their token IDs and current prices.
 * Real Polymarket weather events are neg-risk multi-outcome markets:
 * each market in the event represents one outcome (e.g., "13°C").
 * @param {object} event - Gamma event with markets array
 * @returns {object[]} Array of { outcome, tokenId, price, marketId, conditionId, ... }
 */
function extractOutcomes(event) {
  const outcomes = [];
  const markets = event.markets || [event];

  for (const market of markets) {
    const conditionId = market.condition_id || market.conditionId || '';
    const marketId = market.id || conditionId;

    let tokenIds = market.clobTokenIds || market.clob_token_ids || [];
    let outcomePrices = market.outcomePrices || market.outcome_prices || [];

    if (typeof tokenIds === 'string') {
      try { tokenIds = JSON.parse(tokenIds); } catch { tokenIds = []; }
    }
    if (typeof outcomePrices === 'string') {
      try { outcomePrices = JSON.parse(outcomePrices); } catch { outcomePrices = []; }
    }

    if (tokenIds.length >= 1) {
      // Prefer groupItemTitle (clean label like "13°C"), fall back to question
      const outcomeName = market.groupItemTitle || market.question || market.title || 'Unknown';

      outcomes.push({
        outcome: market.question || market.title || outcomeName,
        label: outcomeName,
        tokenId: tokenIds[0],
        noTokenId: tokenIds[1] || null,
        price: outcomePrices.length > 0 ? parseFloat(outcomePrices[0]) : null,
        noPrice: outcomePrices.length > 1 ? parseFloat(outcomePrices[1]) : null,
        marketId,
        conditionId,
        negRisk: market.neg_risk || market.negRisk || false,
        negRiskMarketID: market.negRiskMarketID || market.neg_risk_market_id || '',
        tickSize: market.orderPriceMinTickSize || market.minimum_tick_size || market.min_tick_size || '0.01',
        minSize: market.orderMinSize || 5,
        enableOrderBook: market.enable_order_book !== false && market.enableOrderBook !== false,
        acceptingOrders: market.acceptingOrders !== false,
        bestBid: market.bestBid ? parseFloat(market.bestBid) : null,
        bestAsk: market.bestAsk ? parseFloat(market.bestAsk) : null,
        spread: market.spread ? parseFloat(market.spread) : null,
      });
    }
  }

  return outcomes;
}

/**
 * Scan Polymarket for temperature weather events resolving within the configured window.
 *
 * @param {object} [opts]
 * @param {number} [opts.windowMinMinutes] - Min minutes from now
 * @param {number} [opts.windowMaxMinutes] - Max minutes from now
 * @returns {object[]} Array of weather event objects
 */
export async function scanForWeatherEvents({ windowMinMinutes, windowMaxMinutes } = {}) {
  const now = Date.now();
  const effectiveMinMinutes = windowMinMinutes ?? (config.scanWindowMinHours * 60);
  const effectiveMaxMinutes = windowMaxMinutes ?? (config.scanWindowMaxHours * 60);
  const minWindowMs = effectiveMinMinutes * 60_000;
  const maxWindowMs = effectiveMaxMinutes * 60_000;
  const earliest = new Date(now + minWindowMs);
  const cutoff = new Date(now + maxWindowMs);
  const cacheBucket = Math.floor(now / (5 * 60_000)); // refresh every 5 minutes
  const events = [];
  const seenIds = new Set();

  log.info(`Scanning for weather events resolving between ${earliest.toISOString()} and ${cutoff.toISOString()} (${effectiveMinMinutes}-${effectiveMaxMinutes}min window)`);

  // Try tagged weather events first, then fall back to all events
  const sources = [
    { fetch: fetchWeatherEvents, label: 'weather-tagged' },
    { fetch: (limit, offset) => fetchTaggedEvents('temperature', limit, offset), label: 'temperature-tagged' },
    { fetch: fetchAllActiveEvents, label: 'all-events' },
    {
      fetch: (limit, offset) => fetchActiveMarkets(limit, offset, {
        endDateMin: earliest.toISOString(),
        endDateMax: cutoff.toISOString(),
      }),
      label: 'all-markets',
      isMarketSource: true,
    },
  ];

  for (const source of sources) {
    let offset = 0;
    const PAGE_SIZE = 200;
    const MAX_PAGES = 5;

    for (let page = 0; page < MAX_PAGES; page++) {
      try {
        const cacheKey = `${source.label}:${effectiveMinMinutes}-${effectiveMaxMinutes}:${cacheBucket}:${offset}`;
        let rawEvents = getCachedGamma(cacheKey);
        if (rawEvents) {
          log.debug(`Page ${page + 1} (${source.label}): cache HIT`);
        } else {
          rawEvents = await source.fetch(PAGE_SIZE, offset);
          setCachedGamma(cacheKey, rawEvents);
        }

        if (rawEvents.length === 0) break;

        for (const raw of rawEvents) {
          const event = source.isMarketSource ? normalizeMarketToEventLike(raw) : raw;
          const eventId = event.id || event.slug || '';
          if (seenIds.has(eventId)) continue;

          const classification = classifyWeatherEvent(event);
          if (!classification.isWeather) continue;
          if (classification.category !== 'temperature') continue;

          const endTime = parseEventEndTime(event);
          if (!endTime) continue;

          // Must resolve within window [earliest, cutoff]
          if (endTime.getTime() < earliest.getTime()) continue;
          if (endTime.getTime() > cutoff.getTime()) continue;

          const outcomes = extractOutcomes(event);
          if (outcomes.length === 0) continue;

          seenIds.add(eventId);

          // Compute max spread between YES/NO prices across outcomes
          let maxSpread = 0;
          let cheapSide = null;
          for (const o of outcomes) {
            const yesPrice = o.price ?? 0.5;
            const noPrice = o.noPrice ?? (1 - yesPrice);
            const spread = Math.abs(yesPrice - noPrice);
            if (spread > maxSpread) {
              maxSpread = spread;
              cheapSide = yesPrice < noPrice ? { side: 'YES', price: yesPrice, outcome: o.outcome } : { side: 'NO', price: noPrice, outcome: o.outcome };
            }
          }

          const eventObj = {
            eventId,
            title: event.title || event.question || '',
            description: event.description || '',
            category: classification.category,
            location: classification.location,
            locationSource: classification.locationSource,
            endTime: endTime.toISOString(),
            outcomes,
            spread: Math.round(maxSpread * 1000) / 1000,
            cheapSide,
          };

          events.push(eventObj);
          log.info(`Found weather event: "${eventObj.title}" | category=${eventObj.category} | location=${eventObj.location || 'unknown'} (${eventObj.locationSource || 'none'}) | spread=${eventObj.spread} | cheap=${cheapSide?.side}@${cheapSide?.price?.toFixed(3) ?? '?'} | ends=${eventObj.endTime}`);
        }

        if (rawEvents.length < PAGE_SIZE) break;
        offset += PAGE_SIZE;
        await sleep(300);
      } catch (err) {
        log.warn(`Error fetching page ${page + 1} (${source.label}): ${err.message}`);
        break;
      }
    }
  }

  log.info(`Scan complete: ${events.length} weather events found within window`);
  return events;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
