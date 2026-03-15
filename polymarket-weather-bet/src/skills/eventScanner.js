import { config } from '../config.js';
import { createLogger } from '../logger.js';
import { fetchTaggedEvents, fetchAllActiveEvents, fetchActiveMarkets } from '../adapters/gamma.js';

const log = createLogger('eventScanner');

const NON_LOCATION_TAGS = new Set([
  'weather', 'recurring', 'hide-from-new', 'daily-temperature',
  'temperature', 'climate', 'precipitation', 'snow', 'wind',
]);

function extractLocationFromTags(tags) {
  if (!Array.isArray(tags)) return null;
  for (const tag of tags) {
    const slug = (typeof tag === 'string' ? tag : tag.slug || '').toLowerCase();
    if (!slug || NON_LOCATION_TAGS.has(slug)) continue;
    const label = typeof tag === 'string' ? tag : tag.label || '';
    if (label && !NON_LOCATION_TAGS.has(label.toLowerCase())) return label;
  }
  return null;
}

function extractLocationFromTitle(title) {
  const inMatch = String(title || '').match(/\bin\s+([A-Z][A-Za-z\s.'-]+?)(?:\s+on\s|\s*\?)/);
  if (inMatch) return inMatch[1].trim();
  return null;
}

function parseEventEndTime(event) {
  const candidates = [
    event.endDate,
    ...(event.markets || []).map((m) => m.endDate || m.end_date),
  ].filter(Boolean);

  for (const c of candidates) {
    const d = new Date(c);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return null;
}

function getMarketParentKey(market) {
  const parentEvent = market.events?.[0] || {};
  return String(
    parentEvent.id
      || parentEvent.slug
      || parentEvent.title
      || market.event_id
      || market.eventId
      || market.id
      || market.slug
      || market.question
      || Math.random(),
  );
}

function normalizeMarketGroupToEventLike(parentEvent, markets, key) {
  const first = markets[0] || {};
  return {
    id: String(parentEvent.id || key),
    title: parentEvent.title || first.question || first.title || '',
    description: parentEvent.description || first.description || '',
    tags: parentEvent.tags || [],
    markets,
  };
}

function extractOutcomes(event) {
  const outcomes = [];
  const markets = event.markets || [event];

  for (const market of markets) {
    let tokenIds = market.clobTokenIds || market.clob_token_ids || [];
    let outcomePrices = market.outcomePrices || market.outcome_prices || [];

    if (typeof tokenIds === 'string') {
      try { tokenIds = JSON.parse(tokenIds); } catch { tokenIds = []; }
    }
    if (typeof outcomePrices === 'string') {
      try { outcomePrices = JSON.parse(outcomePrices); } catch { outcomePrices = []; }
    }

    if (tokenIds.length < 1) continue;

    const label = market.groupItemTitle || market.question || market.title || 'Unknown';
    outcomes.push({
      outcome: market.question || market.title || label,
      label,
      tokenId: tokenIds[0],
      noTokenId: tokenIds[1] || null,
      price: outcomePrices.length > 0 ? parseFloat(outcomePrices[0]) : null,
      noPrice: outcomePrices.length > 1 ? parseFloat(outcomePrices[1]) : null,
      marketId: market.id || market.condition_id || market.conditionId || '',
      conditionId: market.condition_id || market.conditionId || '',
      negRisk: market.neg_risk || market.negRisk || false,
      tickSize: market.orderPriceMinTickSize || market.minimum_tick_size || market.min_tick_size || '0.01',
    });
  }

  return outcomes;
}

function isTemperatureEventLike(event) {
  const title = String(event.title || event.question || '').toLowerCase();
  const description = String(event.description || '').toLowerCase();
  const tags = (event.tags || []).map((t) => (typeof t === 'string' ? t : t.slug || t.label || '').toLowerCase());
  const combined = `${title} ${description} ${tags.join(' ')}`;

  return /(temperature|degrees|celsius|fahrenheit|record high|record low|daily-temperature|highest temperature)/i.test(combined);
}

function shuffle(arr) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

export async function scanForTemperatureEvents({ windowMinMinutes, windowMaxMinutes } = {}) {
  const now = Date.now();
  const minMinutes = windowMinMinutes ?? (config.scanWindowMinHours * 60);
  const maxMinutes = windowMaxMinutes ?? (config.scanWindowMaxHours * 60);
  const earliest = new Date(now + minMinutes * 60_000);
  const cutoff = new Date(now + maxMinutes * 60_000);

  const eventsById = new Map();
  const seenRawEvents = new Set();
  const marketGroups = new Map();
  const seenMarketRows = new Set();

  function upsertEvent(candidate) {
    const key = String(candidate.eventId || candidate.title || Math.random());
    const existing = eventsById.get(key);
    if (!existing || (candidate.outcomes?.length || 0) > (existing.outcomes?.length || 0)) {
      eventsById.set(key, candidate);
    }
  }

  const sources = [
    { fetch: (limit, offset) => fetchTaggedEvents('temperature', limit, offset), isMarketSource: false },
    { fetch: (limit, offset) => fetchTaggedEvents('weather', limit, offset), isMarketSource: false },
    { fetch: fetchAllActiveEvents, isMarketSource: false },
    {
      fetch: (limit, offset) => fetchActiveMarkets(limit, offset, {
        endDateMin: earliest.toISOString(),
        endDateMax: cutoff.toISOString(),
      }),
      isMarketSource: true,
    },
  ];

  for (const source of sources) {
    let offset = 0;
    let pages = 0;

    while (pages < 4) {
      const chunk = await source.fetch(200, offset);
      if (!Array.isArray(chunk) || chunk.length === 0) break;

      if (source.isMarketSource) {
        for (const market of chunk) {
          const marketRowKey = String(market.id || market.condition_id || market.conditionId || market.slug || Math.random());
          if (seenMarketRows.has(marketRowKey)) continue;
          seenMarketRows.add(marketRowKey);

          const parentEvent = market.events?.[0] || {};
          const groupKey = getMarketParentKey(market);
          if (!marketGroups.has(groupKey)) {
            marketGroups.set(groupKey, { parentEvent, markets: [] });
          }
          marketGroups.get(groupKey).markets.push(market);
        }

        offset += chunk.length;
        pages += 1;
        if (chunk.length < 200) break;
        continue;
      }

      for (const raw of chunk) {
        const event = raw;
        const key = String(event.id || event.slug || event.title || Math.random());
        if (seenRawEvents.has(key)) continue;
        seenRawEvents.add(key);
        if (!isTemperatureEventLike(event)) continue;

        const end = parseEventEndTime(event);
        if (!end || end < earliest || end > cutoff) continue;

        const outcomes = extractOutcomes(event);
        if (outcomes.length === 0) continue;

        const location = extractLocationFromTags(event.tags) || extractLocationFromTitle(event.title);
        upsertEvent({
          eventId: String(event.id || key),
          title: event.title || event.question || 'Temperature event',
          description: event.description || '',
          category: 'temperature',
          location: location || '',
          endTime: end.toISOString(),
          outcomes,
        });
      }

      offset += chunk.length;
      pages += 1;
      if (chunk.length < 200) break;
    }
  }

  for (const [groupKey, grouped] of marketGroups.entries()) {
    const event = normalizeMarketGroupToEventLike(grouped.parentEvent, grouped.markets, groupKey);
    const key = String(event.id || groupKey);
    if (!isTemperatureEventLike(event)) continue;

    const end = parseEventEndTime(event);
    if (!end || end < earliest || end > cutoff) continue;

    const outcomes = extractOutcomes(event);
    if (outcomes.length === 0) continue;

    const location = extractLocationFromTags(event.tags) || extractLocationFromTitle(event.title);
    upsertEvent({
      eventId: String(event.id || key),
      title: event.title || event.question || 'Temperature event',
      description: event.description || '',
      category: 'temperature',
      location: location || '',
      endTime: end.toISOString(),
      outcomes,
    });
  }

  const events = Array.from(eventsById.values());

  log.info(`Temperature scan found ${events.length} event(s), randomized for processing`);
  return shuffle(events);
}
