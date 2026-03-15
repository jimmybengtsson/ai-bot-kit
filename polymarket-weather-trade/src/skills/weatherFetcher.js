// src/skills/weatherFetcher.js — OpenWeatherMap 5-day / 3-hour forecast helper
import { config } from '../config.js';
import { createLogger } from '../logger.js';
import { retryWithBackoff, shouldRetryNetworkError } from '../retry.js';

const log = createLogger('weather');
const OWM_FORECAST_URL = 'https://api.openweathermap.org/data/2.5/forecast';
const OWM_CURRENT_URL = 'https://api.openweathermap.org/data/2.5/weather';

function redactOwmUrl(urlObj) {
  const u = new URL(urlObj.toString());
  if (u.searchParams.has('appid')) u.searchParams.set('appid', '***REDACTED***');
  return u.toString();
}

async function owmFetchForecast(locationQuery) {
  const url = new URL(OWM_FORECAST_URL);
  url.searchParams.set('q', locationQuery);
  url.searchParams.set('appid', config.owmApiKey);
  url.searchParams.set('units', 'metric');

  return retryWithBackoff(
    async () => {
      log.debug(`OWM request: GET ${redactOwmUrl(url)}`);
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      log.debug(`OWM response status: ${res.status} ${res.statusText}`);
      if (res.status === 401) throw new Error('OpenWeatherMap API key invalid or missing');
      if (res.status === 404) throw new Error(`Location not found in OpenWeatherMap: ${locationQuery}`);
      if (res.status === 429) throw new Error('OpenWeatherMap rate limit exceeded');
      if (!res.ok) throw new Error(`OpenWeatherMap API ${res.status} ${res.statusText}`);
      const payload = await res.json();
      const pointCount = Array.isArray(payload?.list) ? payload.list.length : 0;
      const first = payload?.list?.[0];
      const firstSummary = first
        ? `${first.dt_txt} temp=${first?.main?.temp ?? 'n/a'}C weather=${first?.weather?.[0]?.description || first?.weather?.[0]?.main || 'n/a'} pop=${first?.pop ?? 'n/a'}`
        : 'none';
      log.info(`OWM forecast loaded: city=${payload?.city?.name || locationQuery}${payload?.city?.country ? `,${payload.city.country}` : ''} points=${pointCount}`);
      log.debug(`OWM first period: ${firstSummary}`);
      return payload;
    },
    {
      maxRetries: 3,
      baseDelayMs: 1500,
      label: `OWM forecast ${locationQuery}`,
      shouldRetry: shouldRetryNetworkError,
    },
  );
}

async function owmFetchCurrent(locationQuery) {
  const url = new URL(OWM_CURRENT_URL);
  url.searchParams.set('q', locationQuery);
  url.searchParams.set('appid', config.owmApiKey);
  url.searchParams.set('units', 'metric');

  return retryWithBackoff(
    async () => {
      log.debug(`OWM current request: GET ${redactOwmUrl(url)}`);
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      log.debug(`OWM current response status: ${res.status} ${res.statusText}`);
      if (res.status === 401) throw new Error('OpenWeatherMap API key invalid or missing');
      if (res.status === 404) throw new Error(`Location not found in OpenWeatherMap: ${locationQuery}`);
      if (res.status === 429) throw new Error('OpenWeatherMap rate limit exceeded');
      if (!res.ok) throw new Error(`OpenWeatherMap current API ${res.status} ${res.statusText}`);
      const payload = await res.json();
      const summary = `${payload?.weather?.[0]?.description || payload?.weather?.[0]?.main || 'n/a'} temp=${payload?.main?.temp ?? 'n/a'}C hum=${payload?.main?.humidity ?? 'n/a'}% wind=${payload?.wind?.speed ?? 'n/a'}m/s`;
      log.info(`OWM current loaded: city=${payload?.name || locationQuery}${payload?.sys?.country ? `,${payload.sys.country}` : ''}`);
      log.debug(`OWM current snapshot: ${summary}`);
      return payload;
    },
    {
      maxRetries: 3,
      baseDelayMs: 1500,
      label: `OWM current ${locationQuery}`,
      shouldRetry: shouldRetryNetworkError,
    },
  );
}

/**
 * Fetch weather forecast using the location extracted from Polymarket event tags/title.
 * @param {string} locationName
 * @returns {Promise<object>}
 */
export async function fetchWeatherData(locationName) {
  if (!locationName) {
    return { location: '', city: null, forecasts: [], lat: null, lon: null };
  }

  const query = String(locationName).trim();
  log.debug(`Fetching OWM forecast for "${query}"`);

  const [forecastPayload, currentPayload] = await Promise.all([
    owmFetchForecast(query),
    owmFetchCurrent(query),
  ]);

  const city = forecastPayload.city || null;
  const current = currentPayload ? {
    dt: currentPayload.dt ?? null,
    temp: currentPayload.main?.temp ?? null,
    feelsLike: currentPayload.main?.feels_like ?? null,
    tempMin: currentPayload.main?.temp_min ?? null,
    tempMax: currentPayload.main?.temp_max ?? null,
    humidity: currentPayload.main?.humidity ?? null,
    pressure: currentPayload.main?.pressure ?? null,
    weather: currentPayload.weather?.[0]?.main || '',
    weatherDesc: currentPayload.weather?.[0]?.description || '',
    windSpeed: currentPayload.wind?.speed ?? null,
    windGust: currentPayload.wind?.gust ?? null,
    windDeg: currentPayload.wind?.deg ?? null,
    clouds: currentPayload.clouds?.all ?? null,
    visibility: currentPayload.visibility ?? null,
    rain1h: currentPayload.rain?.['1h'] ?? 0,
    snow1h: currentPayload.snow?.['1h'] ?? 0,
    sunrise: currentPayload.sys?.sunrise ?? null,
    sunset: currentPayload.sys?.sunset ?? null,
  } : null;

  const forecasts = Array.isArray(forecastPayload.list) ? forecastPayload.list.map((item) => ({
    dt: item.dt,
    dtTxt: item.dt_txt,
    temp: item.main?.temp ?? null,
    tempMin: item.main?.temp_min ?? null,
    tempMax: item.main?.temp_max ?? null,
    feelsLike: item.main?.feels_like ?? null,
    humidity: item.main?.humidity ?? null,
    pressure: item.main?.pressure ?? null,
    weather: item.weather?.[0]?.main || '',
    weatherDesc: item.weather?.[0]?.description || '',
    windSpeed: item.wind?.speed ?? null,
    windGust: item.wind?.gust ?? null,
    windDeg: item.wind?.deg ?? null,
    clouds: item.clouds?.all ?? null,
    pop: item.pop ?? null,
    rain3h: item.rain?.['3h'] ?? 0,
    snow3h: item.snow?.['3h'] ?? 0,
    visibility: item.visibility ?? null,
  })) : [];

  return {
    location: query,
    city,
    current,
    lat: city?.coord?.lat ?? null,
    lon: city?.coord?.lon ?? null,
    forecasts,
  };
}

/**
 * Build concise OWM text focused around Polymarket event resolution time.
 * @param {object} data
 * @param {string} eventEndTime ISO timestamp
 * @returns {string}
 */
export function formatWeatherDataForAI(data, eventEndTime) {
  if (!data || !Array.isArray(data.forecasts) || data.forecasts.length === 0) {
    return 'No OWM forecast data available.';
  }

  const lines = [];
  const endTs = eventEndTime ? new Date(eventEndTime).getTime() : null;

  lines.push(`=== OPENWEATHERMAP FORECAST: ${data.location} ===`);
  if (data.city) {
    const name = data.city.name || data.location;
    const country = data.city.country || '';
    lines.push(`City: ${name}${country ? `, ${country}` : ''}`);
    if (typeof data.city.sunrise === 'number' && typeof data.city.sunset === 'number') {
      lines.push(`Sunrise: ${new Date(data.city.sunrise * 1000).toISOString()} | Sunset: ${new Date(data.city.sunset * 1000).toISOString()}`);
    }
  }
  if (data.current) {
    const c = data.current;
    lines.push('');
    lines.push('--- CURRENT CONDITIONS (OBSERVED) ---');
    lines.push(
      `Observed: ${c.dt ? new Date(c.dt * 1000).toISOString() : 'n/a'} | ` +
      `temp=${c.temp ?? 'n/a'}C feels=${c.feelsLike ?? 'n/a'}C ` +
      `(min=${c.tempMin ?? 'n/a'} max=${c.tempMax ?? 'n/a'}) | ` +
      `cond=${c.weatherDesc || c.weather || 'n/a'} | ` +
      `hum=${c.humidity ?? 'n/a'}% pres=${c.pressure ?? 'n/a'}hPa | ` +
      `wind=${c.windSpeed ?? 'n/a'}m/s gust=${c.windGust ?? 'n/a'} | ` +
      `clouds=${c.clouds ?? 'n/a'}% vis=${c.visibility ?? 'n/a'}m | ` +
      `rain1h=${c.rain1h ?? 0}mm snow1h=${c.snow1h ?? 0}mm`
    );
  }
  if (endTs) lines.push(`Event resolution time (UTC): ${new Date(endTs).toISOString()}`);

  const sorted = [...data.forecasts].sort((a, b) => {
    const at = new Date(a.dtTxt).getTime();
    const bt = new Date(b.dtTxt).getTime();
    return at - bt;
  });

  // Compute daily max/min summaries across ALL forecast periods grouped by date.
  const dailyStats = new Map();
  for (const f of sorted) {
    const day = f.dtTxt?.slice(0, 10);
    if (!day) continue;
    if (!dailyStats.has(day)) dailyStats.set(day, { maxTemp: -Infinity, minTemp: Infinity, maxWind: -Infinity, totalRain: 0, totalSnow: 0, count: 0 });
    const ds = dailyStats.get(day);
    if (typeof f.temp === 'number') {
      if (f.temp > ds.maxTemp) ds.maxTemp = f.temp;
      if (f.temp < ds.minTemp) ds.minTemp = f.temp;
    }
    if (typeof f.tempMax === 'number' && f.tempMax > ds.maxTemp) ds.maxTemp = f.tempMax;
    if (typeof f.tempMin === 'number' && f.tempMin < ds.minTemp) ds.minTemp = f.tempMin;
    if (typeof f.windSpeed === 'number' && f.windSpeed > ds.maxWind) ds.maxWind = f.windSpeed;
    ds.totalRain += f.rain3h ?? 0;
    ds.totalSnow += f.snow3h ?? 0;
    ds.count++;
  }

  // Show daily summaries (highlights daily highs/lows that might be missed at event hour).
  if (dailyStats.size > 0) {
    lines.push('');
    lines.push('--- DAILY SUMMARY (ALL PERIODS) ---');
    for (const [day, ds] of [...dailyStats.entries()].sort()) {
      const isEventDay = endTs && day === new Date(endTs).toISOString().slice(0, 10);
      const tag = isEventDay ? ' <<<EVENT DAY' : '';
      const maxT = ds.maxTemp > -Infinity ? ds.maxTemp.toFixed(1) : 'n/a';
      const minT = ds.minTemp < Infinity ? ds.minTemp.toFixed(1) : 'n/a';
      const maxW = ds.maxWind > -Infinity ? ds.maxWind.toFixed(1) : 'n/a';
      lines.push(
        `${day}${tag} | HIGH=${maxT}C LOW=${minT}C | max_wind=${maxW}m/s | rain=${ds.totalRain.toFixed(1)}mm snow=${ds.totalSnow.toFixed(1)}mm (${ds.count} periods)`
      );
    }
  }

  let focus = sorted;
  if (endTs) {
    // Keep entries within +/- 12h of resolution where possible.
    const windowStart = endTs - 12 * 3600 * 1000;
    const windowEnd = endTs + 12 * 3600 * 1000;
    const around = sorted.filter((f) => {
      const t = new Date(f.dtTxt).getTime();
      return t >= windowStart && t <= windowEnd;
    });
    if (around.length > 0) focus = around;
  }

  lines.push('');
  lines.push('--- FORECAST PERIODS (3H) ---');

  let closestIdx = -1;
  if (endTs) {
    let bestDiff = Number.POSITIVE_INFINITY;
    for (let i = 0; i < focus.length; i++) {
      const t = new Date(focus[i].dtTxt).getTime();
      const diff = Math.abs(t - endTs);
      if (diff < bestDiff) {
        bestDiff = diff;
        closestIdx = i;
      }
    }
  }

  for (let i = 0; i < focus.length; i++) {
    const f = focus[i];
    const marker = i === closestIdx ? ' <<<EVENT' : '';
    const popPct = f.pop == null ? 'N/A' : `${Math.round(f.pop * 100)}%`;
    lines.push(
      `${f.dtTxt}${marker} | temp=${f.temp}C (min=${f.tempMin}, max=${f.tempMax}) | ` +
      `cond=${f.weatherDesc || f.weather || 'n/a'} | wind=${f.windSpeed ?? 'n/a'}m/s gust=${f.windGust ?? 'n/a'} | ` +
      `pop=${popPct} rain3h=${f.rain3h ?? 0}mm snow3h=${f.snow3h ?? 0}mm hum=${f.humidity ?? 'n/a'}%`
    );
  }

  return lines.join('\n');
}
