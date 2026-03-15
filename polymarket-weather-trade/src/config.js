// src/config.js — Central configuration for polymarket-weather-trade
import 'dotenv/config';
import { getSetting } from './settingsStore.js';

function asInt(name, fallback) {
  return parseInt(getSetting(name, String(fallback)), 10);
}

function asFloat(name, fallback) {
  return parseFloat(getSetting(name, String(fallback)));
}

function asString(name, fallback = '') {
  return getSetting(name, fallback);
}

function asBoolTrueUnlessFalse(name, fallback = true) {
  const raw = getSetting(name, String(fallback));
  return String(raw).toLowerCase() !== 'false';
}

function asBoolTrueOnly(name, fallback = false) {
  const raw = getSetting(name, String(fallback));
  return String(raw).toLowerCase() === 'true';
}

function getStopLossPct() {
  const primary = getSetting('STOP_LOSS_TCP', '');
  if (primary !== '') return parseFloat(primary);
  return 0.25;
}

function getRiskConfig() {
  return {
    maxDailyBets: asInt('MAX_DAILY_BETS', 12),
    minOddsValue: asFloat('MIN_ODDS_VALUE', 0.05),
    maxOddsValue: asFloat('MAX_ODDS_VALUE', 0.70),
    minConfidence: asFloat('MIN_CONFIDENCE', 60),
    minEdge: asFloat('MIN_EDGE', 0.03),
    maxBetSize: asFloat('MAX_BET_SIZE', 2),
    lowBetTakeProfit: asFloat('LOW_BET_TAKE_PROFIT', 300),
    highBetTakeProfit: asFloat('HIGH_BET_TAKE_PROFIT', 5),
    takeProfitDisableBeforeEndMinutes: asInt('TAKE_PROFIT_DISABLE_BEFORE_END_MINUTES', 0),
    stopLossPct: getStopLossPct(),
  };
}

export const config = {
  // Polygon / Polymarket
  get polygonPrivateKey() { return asString('POLYGON_PRIVATE_KEY', ''); },
  get signatureType() { return asInt('SIGNATURE_TYPE', 2); },
  get funderAddress() { return asString('FUNDER_ADDRESS', ''); },
  get polyApiKey() { return asString('POLY_API_KEY', ''); },
  get polyApiSecret() { return asString('POLY_API_SECRET', ''); },
  get polyPassphrase() { return asString('POLY_PASSPHRASE', ''); },

  // Polymarket endpoints
  clobHost:  'https://clob.polymarket.com',
  gammaHost: 'https://gamma-api.polymarket.com',
  dataHost:  'https://data-api.polymarket.com',
  get marketWsUrl() { return asString('MARKET_WS_URL', 'wss://ws-subscriptions-clob.polymarket.com/ws/market'); },
  get userWsUrl() { return asString('USER_WS_URL', 'wss://ws-subscriptions-clob.polymarket.com/ws/user'); },
  get realtimeMonitoringEnabled() { return asBoolTrueUnlessFalse('REALTIME_MONITORING', true); },
  chainId:   137,

  // OpenAI
  get openaiApiKey() { return asString('OPENAI_API_KEY', ''); },
  get openaiModel() { return asString('OPENAI_MODEL', 'gpt-5-nano'); },

  // OpenWeatherMap API (5-day / 3-hour forecast)
  get owmApiKey() { return asString('OWM_API_KEY', ''); },

  // NOAA Climate Data Online API v2 token
  get noaaCdoToken() { return asString('NOAA_CDO_TOKEN', ''); },
  get noaaRecentDaysStart() { return asInt('NOAA_RECENT_DAYS_START', 1); },
  get noaaRecentDaysCount() { return asInt('NOAA_RECENT_DAYS_COUNT', 2); },
  get noaaSameDayYearsBackCount() { return asInt('NOAA_SAME_DAY_YEARS_BACK_COUNT', 5); },


  // Telegram Bot (notifications & commands)
  get telegramBotToken() { return asString('TELEGRAM_BOT_TOKEN', ''); },
  get telegramChatId() { return asString('TELEGRAM_CHAT_ID', ''); },

  // Betting — $1 minimum per bet on Polymarket
  get betAmountUsd() { return asFloat('BET_AMOUNT_USD', 1); },
  get maxActiveBets() { return asInt('MAX_ACTIVE_BETS', 8); },
  get minBalanceWarn() { return asFloat('MIN_BALANCE_WARN_USD', 20); },
  get minBalanceStop() { return asFloat('MIN_BALANCE_STOP_USD', 3); },
  get betSize() {
    const explicit = getSetting('BET_SIZE', '');
    if (explicit !== '') return parseFloat(explicit);
    return asFloat('BET_AMOUNT_USD', 1);
  },
  paperTrade:       () => asBoolTrueOnly('PAPER_TRADE', true),

  // Server
  get port() { return asInt('PORT', 3001); },
  get logLevel() { return asString('LOG_LEVEL', 'info'); },

  // ─── Weather Keywords ───────────────────────────────────────────────────
  // Used to classify Polymarket events as weather-related
  weatherKeywords: [
    'temperature', 'degrees', 'fahrenheit', 'celsius', 'weather',
    'rain', 'rainfall', 'precipitation', 'inches of rain',
    'snow', 'snowfall', 'blizzard', 'ice storm', 'inches of snow',
    'hurricane', 'tropical storm', 'cyclone', 'typhoon',
    'tornado', 'severe storm', 'hail',
    'wind', 'wind speed', 'gust', 'mph wind',
    'humidity', 'dew point',
    'flood', 'flooding', 'drought',
    'heat wave', 'cold snap', 'frost', 'freeze',
    'record high', 'record low', 'below zero', 'wind chill', 'heat index',
    'NWS', 'national weather service',
    'climate', 'el nino', 'la nina',
  ],



  // ─── Risk / Safety (top-level) ─────────────────────────────────────────
  get maxDailyBets() { return getRiskConfig().maxDailyBets; },
  get minOddsValue() { return getRiskConfig().minOddsValue; },
  get maxOddsValue() { return getRiskConfig().maxOddsValue; },
  get minConfidence() { return getRiskConfig().minConfidence; },
  get minEdge() { return getRiskConfig().minEdge; },
  get maxBetSize() { return getRiskConfig().maxBetSize; },
  get lowBetTakeProfit() { return getRiskConfig().lowBetTakeProfit; },
  get highBetTakeProfit() { return getRiskConfig().highBetTakeProfit; },
  get takeProfitDisableBeforeEndMinutes() { return getRiskConfig().takeProfitDisableBeforeEndMinutes; },
  get stopLossPct() { return getRiskConfig().stopLossPct; },

  // Backward-compatible grouped risk object
  get risk() { return getRiskConfig(); },

  // Daily AI token budget
  get maxDailyTokens() { return asInt('MAX_DAILY_TOKENS', 500000); },

  // ─── Schedule ───────────────────────────────────────────────────────────
  // Scan every 2 hours
  scanCron: '0 */2 * * *',
  maxEventsPerScan: 30,               // max weather events to analyze per scan
  scanWindowMinHours: 12,              // earliest: skip events resolving within 12h to avoid last-minute volatility
  scanWindowMaxHours: 48,             // latest: look up to 48h ahead for event resolution
};

/**
 * Validate configuration at startup.
 * @returns {{ valid: boolean, errors: string[], warnings: string[] }}
 */
export function validateConfig() {
  const errors = [];
  const warnings = [];

  if (!config.polygonPrivateKey) {
    errors.push('POLYGON_PRIVATE_KEY is required but not set');
  }
  if (!config.openaiApiKey) {
    errors.push('OPENAI_API_KEY is required but not set');
  }

  if (config.betAmountUsd < 1) {
    errors.push(`BET_AMOUNT_USD must be >= 1 (Polymarket minimum), got ${config.betAmountUsd}`);
  }
  if (config.maxActiveBets <= 0) {
    errors.push(`MAX_ACTIVE_BETS must be > 0, got ${config.maxActiveBets}`);
  }
  if (config.stopLossPct <= 0) {
    errors.push(`stopLossPct must be > 0, got ${config.stopLossPct}`);
  }
  if (config.stopLossPct >= 1) {
    errors.push(`stopLossPct must be < 1, got ${config.stopLossPct}`);
  }
  if (!Number.isFinite(config.takeProfitDisableBeforeEndMinutes)) {
    errors.push(`TAKE_PROFIT_DISABLE_BEFORE_END_MINUTES must be a finite integer (can be positive or negative), got ${config.takeProfitDisableBeforeEndMinutes}`);
  }
  if (config.maxDailyBets <= 0) {
    errors.push(`maxDailyBets must be > 0, got ${config.maxDailyBets}`);
  }
  if (config.minOddsValue < 0 || config.minOddsValue >= 1) {
    errors.push(`minOddsValue must be in [0, 1), got ${config.minOddsValue}`);
  }
  if (config.maxOddsValue <= 0 || config.maxOddsValue > 1) {
    errors.push(`maxOddsValue must be in (0, 1], got ${config.maxOddsValue}`);
  }
  if (!config.funderAddress) {
    warnings.push('FUNDER_ADDRESS not set — using wallet address as funder');
  }
  if (!config.polyApiKey || !config.polyApiSecret || !config.polyPassphrase) {
    warnings.push('Polymarket API credentials not fully set — will derive from private key');
  }
  if (!config.owmApiKey) {
    errors.push('OWM_API_KEY is required — get a free key at https://home.openweathermap.org/api_keys');
  }
  if (!config.noaaCdoToken) {
    errors.push('NOAA_CDO_TOKEN is required — request a token at https://www.ncdc.noaa.gov/cdo-web/token');
  }
  if (config.noaaRecentDaysStart < 1 || config.noaaRecentDaysStart > 30) {
    errors.push(`NOAA_RECENT_DAYS_START must be in [1,30], got ${config.noaaRecentDaysStart}`);
  }
  if (config.noaaRecentDaysCount < 1 || config.noaaRecentDaysCount > 30) {
    errors.push(`NOAA_RECENT_DAYS_COUNT must be in [1,30], got ${config.noaaRecentDaysCount}`);
  }
  if (config.noaaSameDayYearsBackCount < 1 || config.noaaSameDayYearsBackCount > 20) {
    errors.push(`NOAA_SAME_DAY_YEARS_BACK_COUNT must be in [1,20], got ${config.noaaSameDayYearsBackCount}`);
  }
  if (getSetting('TAKE_PROFIT_PCT', '') === '') {
    warnings.push('TAKE_PROFIT_PCT not set — using default 0.40');
  }
  if (getSetting('STOP_LOSS_TCP', '') === '') {
    warnings.push('STOP_LOSS_TCP not set — using default 0.25');
  }

  return { valid: errors.length === 0, errors, warnings };
}
