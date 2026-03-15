import { config } from '../config.js';
import { createLogger } from '../logger.js';
import { retryWithBackoff, shouldRetryNetworkError } from '../retry.js';

const log = createLogger('weather');
const OWM_FORECAST_URL = 'https://api.openweathermap.org/data/2.5/forecast';
const OWM_CURRENT_URL = 'https://api.openweathermap.org/data/2.5/weather';

async function owmFetchForecast(locationQuery) {
  const url = new URL(OWM_FORECAST_URL);
  url.searchParams.set('q', locationQuery);
  url.searchParams.set('appid', config.owmApiKey);
  url.searchParams.set('units', 'metric');

  return retryWithBackoff(
    async () => {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`OWM API ${res.status} ${res.statusText}`);
      return res.json();
    },
    { maxRetries: 3, baseDelayMs: 1200, label: `OWM ${locationQuery}`, shouldRetry: shouldRetryNetworkError },
  );
}

async function owmFetchCurrent(locationQuery) {
  const url = new URL(OWM_CURRENT_URL);
  url.searchParams.set('q', locationQuery);
  url.searchParams.set('appid', config.owmApiKey);
  url.searchParams.set('units', 'metric');

  return retryWithBackoff(
    async () => {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`OWM current API ${res.status} ${res.statusText}`);
      return res.json();
    },
    { maxRetries: 3, baseDelayMs: 1200, label: `OWM current ${locationQuery}`, shouldRetry: shouldRetryNetworkError },
  );
}

function dailyStatsFromForecast(forecasts) {
  const map = new Map();
  for (const f of forecasts) {
    const day = f.dtTxt.slice(0, 10);
    if (!map.has(day)) map.set(day, { high: -Infinity, low: Infinity, periods: 0 });
    const row = map.get(day);

    const values = [f.temp, f.tempMax, f.tempMin].filter((n) => typeof n === 'number');
    for (const v of values) {
      if (v > row.high) row.high = v;
      if (v < row.low) row.low = v;
    }
    row.periods += 1;
  }
  return map;
}

export async function fetchTemperatureForecastContext(locationName, eventEndTime) {
  if (!locationName) throw new Error('Missing location for OWM fetch');

  const locationQuery = String(locationName).trim();
  const data = await owmFetchForecast(locationQuery);
  let current = null;
  try {
    current = await owmFetchCurrent(locationQuery);
  } catch (err) {
    log.warn(`OWM current fetch failed for ${locationQuery}: ${err.message}`);
  }

  const city = data.city || null;
  const forecasts = Array.isArray(data.list)
    ? data.list.map((item) => ({
      dtTxt: item.dt_txt,
      temp: item.main?.temp ?? null,
      tempMin: item.main?.temp_min ?? null,
      tempMax: item.main?.temp_max ?? null,
      weatherDesc: item.weather?.[0]?.description || item.weather?.[0]?.main || '',
    }))
    : [];

  const dayMap = dailyStatsFromForecast(forecasts);
  const eventDay = new Date(eventEndTime).toISOString().slice(0, 10);
  const eventStats = dayMap.get(eventDay) || null;

  const lines = [];
  lines.push(`OWM location: ${city?.name || locationName}${city?.country ? `, ${city.country}` : ''}`);
  lines.push(`Event date (UTC): ${eventDay}`);
  if (current?.main) {
    const currentTimeIso = current.dt ? new Date(current.dt * 1000).toISOString() : 'n/a';
    const currentDesc = current.weather?.[0]?.description || current.weather?.[0]?.main || 'n/a';
    const wind = typeof current.wind?.speed === 'number' ? `${current.wind.speed} m/s` : 'n/a';
    lines.push('OWM current conditions:');
    lines.push(`- observedAt=${currentTimeIso} temp=${current.main.temp ?? 'n/a'}C feelsLike=${current.main.feels_like ?? 'n/a'}C humidity=${current.main.humidity ?? 'n/a'}% pressure=${current.main.pressure ?? 'n/a'}hPa wind=${wind} cond=${currentDesc}`);
  } else {
    lines.push('OWM current conditions: unavailable');
  }
  lines.push('OWM daily highs/lows:');
  for (const [day, s] of [...dayMap.entries()].sort()) {
    const tag = day === eventDay ? ' <<<EVENT DAY' : '';
    const high = Number.isFinite(s.high) ? s.high.toFixed(1) : 'n/a';
    const low = Number.isFinite(s.low) ? s.low.toFixed(1) : 'n/a';
    lines.push(`- ${day}${tag}: HIGH=${high}C LOW=${low}C (${s.periods} periods)`);
  }

  const eventPeriods = forecasts.filter((f) => f.dtTxt.startsWith(eventDay));
  if (eventPeriods.length > 0) {
    lines.push('OWM event-day periods:');
    for (const p of eventPeriods) {
      lines.push(`- ${p.dtTxt} temp=${p.temp}C (min=${p.tempMin}, max=${p.tempMax}) cond=${p.weatherDesc || 'n/a'}`);
    }
  }

  log.info(`OWM parsed for ${locationName}: periods=${forecasts.length} eventDay=${eventDay} eventHigh=${eventStats?.high ?? 'n/a'}`);

  return {
    location: locationName,
    lat: city?.coord?.lat ?? null,
    lon: city?.coord?.lon ?? null,
    current,
    eventDay,
    eventDayHighC: eventStats?.high ?? null,
    text: lines.join('\n'),
  };
}
