import { config } from '../config.js';
import { createLogger } from '../logger.js';
import { retryWithBackoff, shouldRetryNetworkError } from '../retry.js';

const log = createLogger('climate');
const NOAA_BASE = 'https://www.ncei.noaa.gov/cdo-web/api/v2';
const NOAA_PAUSE_MS = 300;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toDateOnly(v) {
  return new Date(v).toISOString().slice(0, 10);
}

function shiftDays(date, daysBack) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() - daysBack);
  return d;
}

function shiftYears(date, yearsBack) {
  const d = new Date(date);
  d.setUTCFullYear(d.getUTCFullYear() - yearsBack);
  return d;
}

function safeNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizeTmaxCelsius(v) {
  if (v == null) return null;
  // Some NOAA feeds expose tenths of degrees; clamp obvious outliers.
  return Math.abs(v) > 80 ? v / 10 : v;
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

function buildExtent(lat, lon, delta = 0.6) {
  const minLat = Math.max(-90, lat - delta).toFixed(4);
  const minLon = Math.max(-180, lon - delta).toFixed(4);
  const maxLat = Math.min(90, lat + delta).toFixed(4);
  const maxLon = Math.min(180, lon + delta).toFixed(4);
  return `${minLat},${minLon},${maxLat},${maxLon}`;
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
      const res = await fetch(url, {
        signal: AbortSignal.timeout(20000),
        headers: { token: config.noaaCdoToken },
      });
      if (!res.ok) throw new Error(`NOAA API ${res.status} ${res.statusText}`);
      return res.json();
    },
    { maxRetries: 3, baseDelayMs: 1500, label: `NOAA ${path}`, shouldRetry: shouldRetryNetworkError },
  );
}

async function findNearestStations(lat, lon) {
  const stations = await noaaFetch('/stations', {
    datasetid: 'GHCND',
    extent: buildExtent(lat, lon),
    limit: 50,
    sortfield: 'datacoverage',
    sortorder: 'desc',
  });

  const list = Array.isArray(stations.results) ? stations.results : [];
  if (list.length === 0) return [];

  return list
    .filter((s) => Number.isFinite(Number(s.latitude)) && Number.isFinite(Number(s.longitude)))
    .map((s) => ({
      station: s,
      distanceKm: haversineKm(lat, lon, Number(s.latitude), Number(s.longitude)),
      coverage: Number(s.datacoverage) || 0,
    }))
    .sort((a, b) => (a.distanceKm - b.distanceKm) || (b.coverage - a.coverage));
}

async function fetchDailyTmax(stationId, dateObj) {
  const day = toDateOnly(dateObj);
  const payload = await noaaFetch('/data', {
    datasetid: 'GHCND',
    stationid: stationId,
    startdate: day,
    enddate: day,
    units: 'metric',
    limit: 50,
    datatypeid: ['TMAX'],
  });

  const rows = Array.isArray(payload.results) ? payload.results : [];
  const tmaxVals = rows
    .filter((r) => r.datatype === 'TMAX')
    .map((r) => normalizeTmaxCelsius(safeNum(r.value)))
    .filter((n) => n != null);
  const tmax = tmaxVals.length ? Math.max(...tmaxVals) : null;
  return { day, tmax };
}

async function chooseStationWithData(lat, lon, probeDates) {
  const ranked = await findNearestStations(lat, lon);
  if (ranked.length === 0) return null;

  const stationCandidates = ranked.slice(0, 8);
  for (const candidate of stationCandidates) {
    for (const dateObj of probeDates) {
      try {
        const probe = await fetchDailyTmax(candidate.station.id, dateObj);
        if (probe.tmax != null) return candidate.station;
      } catch {
        // Keep probing nearby stations/dates.
      }
      await sleep(NOAA_PAUSE_MS);
    }
  }

  return stationCandidates[0].station;
}

export async function fetchClimateTemperatureContext({ lat, lon, eventEndTime, searchTime = new Date() }) {
  if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lon))) {
    return { text: 'NOAA unavailable: missing coordinates', recent: [], yearly: [], stationId: null };
  }

  const eventDate = new Date(eventEndTime);
  const station = await chooseStationWithData(Number(lat), Number(lon), [
    shiftDays(searchTime, 2),
    eventDate,
    shiftYears(eventDate, 1),
  ]);
  if (!station?.id) {
    return { text: 'NOAA unavailable: no station found', recent: [], yearly: [], stationId: null };
  }

  const recentDaysBack = [2, 3, 4];
  const yearlyBack = [1, 2, 3, 4, 5];

  const recent = [];
  for (const d of recentDaysBack) {
    try {
      recent.push(await fetchDailyTmax(station.id, shiftDays(searchTime, d)));
    } catch {
      recent.push({ day: toDateOnly(shiftDays(searchTime, d)), tmax: null });
    }
    await sleep(NOAA_PAUSE_MS);
  }

  const yearly = [];
  for (const y of yearlyBack) {
    try {
      yearly.push(await fetchDailyTmax(station.id, shiftYears(eventDate, y)));
    } catch {
      yearly.push({ day: toDateOnly(shiftYears(eventDate, y)), tmax: null });
    }
    await sleep(NOAA_PAUSE_MS);
  }

  const lines = [];
  lines.push(`NOAA station: ${station.id} (${station.name || 'unknown'})`);
  lines.push('NOAA recent TMAX (search-date minus 2/3/4 days):');
  for (const r of recent) lines.push(`- ${r.day}: TMAX=${r.tmax == null ? 'n/a' : `${r.tmax.toFixed(1)}C`}`);
  lines.push('NOAA same-date TMAX last 5 years (event date anchor):');
  for (const y of yearly) lines.push(`- ${y.day}: TMAX=${y.tmax == null ? 'n/a' : `${y.tmax.toFixed(1)}C`}`);

  log.info(`NOAA parsed: station=${station.id} recent=${recent.length} yearly=${yearly.length}`);
  return {
    stationId: station.id,
    recent,
    yearly,
    text: lines.join('\n'),
  };
}
