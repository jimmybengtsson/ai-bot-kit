// src/skills/climateFetcher.js — NOAA CDO v2 climate observations helper
import { config } from '../config.js';
import { createLogger } from '../logger.js';
import { retryWithBackoff, shouldRetryNetworkError } from '../retry.js';

const log = createLogger('climate');
const NOAA_BASE = 'https://www.ncei.noaa.gov/cdo-web/api/v2';
const NOAA_REQUEST_PAUSE_MS = 350;
const stationCache = new Map();

function recentDayOffsets() {
  const start = config.noaaRecentDaysStart;
  const count = config.noaaRecentDaysCount;
  return Array.from({ length: count }, (_, i) => start + i);
}

function yearlyOffsets() {
  const count = config.noaaSameDayYearsBackCount;
  return Array.from({ length: count }, (_, i) => i + 1);
}

function formatRecentOffsetsForLog(offsets) {
  return offsets.map((d) => `D-${d}`).join(', ');
}

function toIsoDayUtc(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())).toISOString().slice(0, 10);
}

async function noaaFetch(path, params = {}) {
  const url = new URL(`${NOAA_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) {
      for (const item of v) url.searchParams.append(k, String(item));
    } else if (v != null && v !== '') {
      url.searchParams.set(k, String(v));
    }
  }

  return retryWithBackoff(
    async () => {
      log.debug(`NOAA request: GET ${url.toString()} headers={token:***REDACTED***}`);
      const res = await fetch(url, {
        signal: AbortSignal.timeout(20000),
        headers: { token: config.noaaCdoToken },
      });
      log.debug(`NOAA response status: ${res.status} ${res.statusText} (${path})`);

      if (res.status === 401 || res.status === 403) {
        throw new Error('NOAA token invalid or missing');
      }
      if (res.status === 429) {
        throw new Error('NOAA CDO rate limit exceeded');
      }
      if (!res.ok) {
        throw new Error(`NOAA CDO API ${res.status} ${res.statusText}`);
      }
      const payload = await res.json();
      const resultCount = Array.isArray(payload?.results) ? payload.results.length : 0;
      if (path === '/stations') {
        const first = payload?.results?.[0];
        const firstStation = first ? `${first.id} (${first.name || 'unknown'})` : 'none';
        log.debug(`NOAA result (/stations): count=${resultCount} first=${firstStation}`);
      } else if (path === '/data') {
        const first = payload?.results?.[0];
        const firstData = first
          ? `${first.date} ${first.datatype}=${first.value} station=${first.station}`
          : 'none';
        log.debug(`NOAA result (/data): count=${resultCount} first=${firstData}`);
      } else {
        log.debug(`NOAA result (${path}): count=${resultCount}`);
      }
      return payload;
    },
    {
      maxRetries: 3,
      baseDelayMs: 1500,
      label: `NOAA ${path}`,
      shouldRetry: shouldRetryNetworkError,
    },
  );
}

function toDateOnly(value) {
  return new Date(value).toISOString().slice(0, 10);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function shiftYears(date, yearsBack) {
  const d = new Date(date);
  d.setUTCFullYear(d.getUTCFullYear() - yearsBack);
  return d;
}

function shiftDays(date, daysBack) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() - daysBack);
  return d;
}

function extractTargetHourUtc(date) {
  return new Date(date).getUTCHours();
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos((lat1 * Math.PI) / 180)
    * Math.cos((lat2 * Math.PI) / 180)
    * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function stationSupportsDate(station, dateStr) {
  const min = Date.parse(station?.mindate || '');
  const max = Date.parse(station?.maxdate || '');
  const target = Date.parse(dateStr);
  if (!Number.isFinite(min) || !Number.isFinite(max) || !Number.isFinite(target)) {
    return true;
  }
  return target >= min && target <= max;
}

function closestRecordToHour(records, targetHourUtc) {
  if (!Array.isArray(records) || records.length === 0) return null;

  let best = null;
  let bestDelta = Infinity;
  for (const r of records) {
    const ts = new Date(r.date || 0).getTime();
    if (Number.isNaN(ts)) continue;
    const hour = new Date(ts).getUTCHours();
    const delta = Math.abs(hour - targetHourUtc);
    if (delta < bestDelta) {
      best = r;
      bestDelta = delta;
    }
  }

  return best;
}

function buildExtent(lat, lon, delta = 0.6) {
  const minLat = Math.max(-90, lat - delta).toFixed(4);
  const minLon = Math.max(-180, lon - delta).toFixed(4);
  const maxLat = Math.min(90, lat + delta).toFixed(4);
  const maxLon = Math.min(180, lon + delta).toFixed(4);
  return `${minLat},${minLon},${maxLat},${maxLon}`;
}

async function findNearestStation(lat, lon) {
  const cacheKey = `${Number(lat).toFixed(2)},${Number(lon).toFixed(2)}`;
  if (stationCache.has(cacheKey)) {
    return stationCache.get(cacheKey);
  }

  const stations = await noaaFetch('/stations', {
    datasetid: 'GHCND',
    extent: buildExtent(lat, lon),
    limit: 25,
    sortfield: 'datacoverage',
    sortorder: 'desc',
  });

  const list = Array.isArray(stations.results) ? stations.results : [];
  if (list.length === 0) return null;

  const ranked = list
    .filter((s) => Number.isFinite(Number(s.latitude)) && Number.isFinite(Number(s.longitude)))
    .map((s) => {
      const sLat = Number(s.latitude);
      const sLon = Number(s.longitude);
      const distanceKm = haversineKm(lat, lon, sLat, sLon);
      const dataCoverage = Number(s.datacoverage) || 0;
      return { station: s, distanceKm, dataCoverage };
    })
    .sort((a, b) => {
      // Prefer closer stations first, then better coverage as tiebreaker.
      if (a.distanceKm !== b.distanceKm) return a.distanceKm - b.distanceKm;
      return b.dataCoverage - a.dataCoverage;
    });

  const best = ranked[0]?.station || list[0];
  const bestInfo = ranked[0];
  if (bestInfo) {
    log.info(`NOAA station candidate selected by distance: ${best.id} distance_km=${bestInfo.distanceKm.toFixed(1)} datacoverage=${bestInfo.dataCoverage}`);
  }

  stationCache.set(cacheKey, best);
  return best;
}

/**
 * Fetch NOAA observations with configurable low-request strategy:
 * - N recent daily points at event-end aligned timing (starting from D-start)
 * - M historical daily points at same date/time in prior years
 *
 * Calls are intentionally sequential to avoid request bursts.
 *
 * @param {object} params
 * @param {string} params.locationName
 * @param {number|null} params.lat
 * @param {number|null} params.lon
 */
export async function fetchClimateData({ locationName, lat, lon, eventEndTime }) {
  if (!lat || !lon) {
    throw new Error(`Cannot fetch NOAA data without coordinates for ${locationName || 'unknown location'}`);
  }

  const now = new Date();
  const parsedEventTime = eventEndTime ? new Date(eventEndTime) : now;
  const eventTime = Number.isNaN(parsedEventTime.getTime()) ? now : parsedEventTime;
  const sampleAnchor = eventTime;
  const targetHourUtc = extractTargetHourUtc(eventTime);
  const recentDaysBack = recentDayOffsets();
  const yearlyBack = yearlyOffsets();

  const station = await findNearestStation(lat, lon);
  if (!station?.id) {
    throw new Error(`No NOAA station found near ${locationName || `${lat},${lon}`}`);
  }

  log.info(`NOAA station selected: ${station.id} (${station.name || 'unknown'})`);
  log.info(`NOAA sampling anchor: event=${eventTime.toISOString()} sample_anchor=${sampleAnchor.toISOString()} now=${now.toISOString()}`);
  log.info(`NOAA request plan: 1 station lookup + ${recentDaysBack.length + yearlyBack.length} sequential /data calls (${formatRecentOffsetsForLog(recentDaysBack)} and years -1..-${yearlyBack.length})`);

  const datatypeIds = ['TMAX', 'TMIN', 'TAVG', 'PRCP', 'SNOW', 'SNWD'];

  async function fetchSingleDateSample(dateObj) {
    const day = toDateOnly(dateObj);
    let payload = await noaaFetch('/data', {
      datasetid: 'GHCND',
      stationid: station.id,
      startdate: day,
      enddate: day,
      units: 'metric',
      limit: 200,
      datatypeid: datatypeIds,
    });

    // Some stations do not expose all requested datatypes; retry unfiltered once.
    if (!Array.isArray(payload?.results) || payload.results.length === 0) {
      log.info(`NOAA /data fallback: retrying ${day} without datatype filters for station ${station.id}`);
      payload = await noaaFetch('/data', {
        datasetid: 'GHCND',
        stationid: station.id,
        startdate: day,
        enddate: day,
        units: 'metric',
        limit: 200,
      });
    }

    const records = Array.isArray(payload.results)
      ? payload.results.map((r) => ({
        date: r.date,
        datatype: r.datatype,
        value: safeNum(r.value),
        station: r.station,
        attributes: r.attributes || '',
      }))
      : [];

    return {
      date: day,
      records,
      closestRecord: closestRecordToHour(records, targetHourUtc),
    };
  }

  const recentSamples = [];
  for (const daysBack of recentDaysBack) {
    const d = shiftDays(sampleAnchor, daysBack);
    const sampleDay = toIsoDayUtc(d);
    if (!stationSupportsDate(station, sampleDay)) {
      recentSamples.push({
        daysBack,
        date: sampleDay,
        records: [],
        closestRecord: null,
        error: `station date range does not include ${sampleDay}`,
      });
      continue;
    }
    try {
      log.debug(`NOAA /data recent sample request: ${toDateOnly(d)} (D-${daysBack})`);
      const sample = await fetchSingleDateSample(d);
      recentSamples.push({ daysBack, ...sample });
    } catch (err) {
      log.warn(`NOAA recent sample failed (${daysBack}d back): ${err.message}`);
      recentSamples.push({
        daysBack,
        date: toDateOnly(d),
        records: [],
        closestRecord: null,
        error: err.message,
      });
    }
    await sleep(NOAA_REQUEST_PAUSE_MS);
  }

  const yearlyComparisons = [];
  for (const yearsBack of yearlyBack) {
    const d = shiftYears(eventTime, yearsBack);
    const sampleDay = toIsoDayUtc(d);
    if (!stationSupportsDate(station, sampleDay)) {
      yearlyComparisons.push({
        yearsBack,
        date: sampleDay,
        records: [],
        closestRecord: null,
        error: `station date range does not include ${sampleDay}`,
      });
      continue;
    }
    try {
      log.debug(`NOAA /data yearly sample request: ${toDateOnly(d)} (${yearsBack}y ago)`);
      const sample = await fetchSingleDateSample(d);
      yearlyComparisons.push({ yearsBack, ...sample });
    } catch (err) {
      log.warn(`NOAA yearly sample failed (${yearsBack}y back): ${err.message}`);
      yearlyComparisons.push({
        yearsBack,
        date: toDateOnly(d),
        records: [],
        closestRecord: null,
        error: err.message,
      });
    }
    await sleep(NOAA_REQUEST_PAUSE_MS);
  }

  log.info(`NOAA sampling complete: recent=${recentSamples.length}, yearly=${yearlyComparisons.length}, total_data_requests=${recentDaysBack.length + yearlyBack.length}`);

  return {
    locationName,
    lat,
    lon,
    station,
    requestedWindow: {
      strategy: `${recentDaysBack.length} recent daily samples (start D-${recentDaysBack[0]}) + ${yearlyBack.length} yearly daily samples (sequential)`,
      eventEndTime: eventTime.toISOString(),
      targetHourUtc,
      requestedAt: now.toISOString(),
      recentDaysBack,
      yearlyBack,
    },
    records: recentSamples.flatMap((s) => s.records || []),
    recentSamples,
    yearlyComparisons,
  };
}

function selectSamplePoints(records, maxPoints = 5) {
  if (!Array.isArray(records) || records.length === 0) return [];

  const sorted = [...records].sort((a, b) => {
    const at = new Date(a.date || 0).getTime();
    const bt = new Date(b.date || 0).getTime();
    return at - bt;
  });

  if (sorted.length <= maxPoints) return sorted;

  const selected = [];
  for (let i = 0; i < maxPoints; i++) {
    const idx = Math.round((i * (sorted.length - 1)) / (maxPoints - 1));
    selected.push(sorted[idx]);
  }
  return selected;
}

function summarizeRecords(records) {
  const vals = {
    TAVG: [],
    TMIN: [],
    TMAX: [],
    PRCP: [],
    SNOW: [],
  };
  for (const r of records) {
    if (r?.datatype in vals && typeof r.value === 'number') {
      vals[r.datatype].push(r.value);
    }
  }
  const avg = (arr) => arr.length ? (arr.reduce((a, b) => a + b, 0) / arr.length) : null;
  const sum = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) : null;
  return {
    tavg: avg(vals.TAVG),
    tmin: avg(vals.TMIN),
    tmax: avg(vals.TMAX),
    prcp: sum(vals.PRCP),
    snow: sum(vals.SNOW),
  };
}

/**
 * Format NOAA records for AI context.
 */
export function formatClimateDataForAI(data) {
  if (!data) return '';

  const lines = [];
  lines.push(`=== NOAA CLIMATE OBSERVATIONS (CDO v2): ${data.locationName || 'unknown'} ===`);
  lines.push(`Requested strategy: ${data.requestedWindow?.strategy || 'daily samples'}`);
  lines.push(`Event end reference: ${data.requestedWindow?.eventEndTime || '?'} | Target hour (UTC): ${data.requestedWindow?.targetHourUtc ?? '?'}`);
  lines.push(`Station: ${data.station?.id || 'unknown'} | ${data.station?.name || 'unknown'}`);

  const recent = Array.isArray(data.recentSamples) ? data.recentSamples : [];
  const yearly = Array.isArray(data.yearlyComparisons) ? data.yearlyComparisons : [];

  if (recent.length === 0 && yearly.length === 0) {
    lines.push('No NOAA records returned (station or datatype coverage may be limited).');
    return lines.join('\n');
  }

  lines.push('');
  const recentWindow = Array.isArray(data?.requestedWindow?.recentDaysBack)
    ? data.requestedWindow.recentDaysBack.map((d) => `D-${d}`).join(', ')
    : 'D-1, D-2';
  const yearlyCount = Array.isArray(data?.requestedWindow?.yearlyBack)
    ? data.requestedWindow.yearlyBack.length
    : 5;

  lines.push(`--- RECENT DAILY OBSERVATIONS (${recentWindow}) --- [TMAX/TMIN are full-day values]`);
  for (const sample of recent.sort((a, b) => a.daysBack - b.daysBack)) {
    if (sample.error) {
      lines.push(`${sample.daysBack}d ago (${sample.date}) | ERROR: ${sample.error}`);
      continue;
    }
    if (!sample.records || sample.records.length === 0) {
      lines.push(`${sample.daysBack}d ago (${sample.date}) | no records`);
      continue;
    }

    const s = summarizeRecords(sample.records);
    const fmt = (n) => (typeof n === 'number' ? n.toFixed(1) : 'n/a');
    const closest = sample.closestRecord;
    lines.push(
      `${sample.daysBack}d ago (${sample.date}) | ` +
      `TAVG=${fmt(s.tavg)}C TMIN=${fmt(s.tmin)}C TMAX=${fmt(s.tmax)}C PRCP=${fmt(s.prcp)}mm SNOW=${fmt(s.snow)}mm` +
      `${closest ? ` | closest-hour sample: ${closest.datatype}=${closest.value ?? 'n/a'} @ ${closest.date}` : ''}`
    );
  }

  lines.push('');
  lines.push(`--- SAME DATE DAILY OBSERVATIONS: LAST ${yearlyCount} YEARS --- [TMAX/TMIN are full-day values]`);
  if (yearly.length === 0) {
    lines.push('No yearly comparison windows available.');
  } else {
    for (const y of yearly.sort((a, b) => a.yearsBack - b.yearsBack)) {
      if (y.error) {
        lines.push(`${y.yearsBack}y ago (${y.date}) | ERROR: ${y.error}`);
        continue;
      }
      if (!y.records || y.records.length === 0) {
        lines.push(`${y.yearsBack}y ago (${y.date}) | no records`);
        continue;
      }
      const s = summarizeRecords(y.records);
      const fmt = (n) => (typeof n === 'number' ? n.toFixed(1) : 'n/a');
      const closest = y.closestRecord;
      lines.push(
        `${y.yearsBack}y ago (${y.date}) | ` +
        `TAVG=${fmt(s.tavg)}C TMIN=${fmt(s.tmin)}C TMAX=${fmt(s.tmax)}C PRCP=${fmt(s.prcp)}mm SNOW=${fmt(s.snow)}mm` +
        `${closest ? ` | closest-hour sample: ${closest.datatype}=${closest.value ?? 'n/a'} @ ${closest.date}` : ''}`
      );
    }
  }

  return lines.join('\n');
}
