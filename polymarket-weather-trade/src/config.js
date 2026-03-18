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

function looksLikeCronExpression(value) {
  // We use 5-field cron expressions in UTC for all scheduler jobs.
  return /^\s*\S+\s+\S+\s+\S+\s+\S+\s+\S+\s*$/.test(String(value || ''));
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
    resolutionGraceMinutes: asInt('RESOLUTION_GRACE_MINUTES', 120),
    lowBetTakeProfit: asFloat('LOW_BET_TAKE_PROFIT', 300),
    highBetTakeProfit: asFloat('HIGH_BET_TAKE_PROFIT', 5),
    stopLossPct: getStopLossPct(),
  };
}

function getTradingModeRaw() {
  return asString('TRADING_MODE', '').trim().toLowerCase();
}

export const config = {
  // Polygon / Polymarket
  get polygonPrivateKey() { return asString('POLYGON_PRIVATE_KEY', ''); },
  get signatureType() { return asInt('SIGNATURE_TYPE', 2); },
  get funderAddress() { return asString('FUNDER_ADDRESS', ''); },
  get polyApiKey() { return asString('POLY_API_KEY', ''); },
  get polyApiSecret() { return asString('POLY_API_SECRET', ''); },
  get polyPassphrase() { return asString('POLY_PASSPHRASE', ''); },
  get opsApiToken() { return asString('OPS_API_TOKEN', ''); },
  get publicReadEndpointsEnabled() { return asBoolTrueUnlessFalse('PUBLIC_READ_ENDPOINTS_ENABLED', true); },

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
  paperTrade:       () => config.tradingMode === 'paper',
  get tradingMode() {
    const mode = getTradingModeRaw();
    if (mode === 'off' || mode === 'shadow' || mode === 'paper' || mode === 'live') return mode;
    return 'paper';
  },

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
  get resolutionGraceMinutes() { return getRiskConfig().resolutionGraceMinutes; },
  get lowBetTakeProfit() { return getRiskConfig().lowBetTakeProfit; },
  get highBetTakeProfit() { return getRiskConfig().highBetTakeProfit; },
  get stopLossPct() { return getRiskConfig().stopLossPct; },

  // Backward-compatible grouped risk object
  get risk() { return getRiskConfig(); },

  // Daily AI token budget
  get maxDailyTokens() { return asInt('MAX_DAILY_TOKENS', 500000); },
  get maxDailyUniqueExposures() { return asInt('MAX_DAILY_UNIQUE_EXPOSURES', asInt('MAX_DAILY_BETS', 12)); },
  get aiValidatorEnabled() { return asBoolTrueUnlessFalse('AI_VALIDATOR_ENABLED', true); },
  get aiValidatorConfidenceMax() { return asFloat('AI_VALIDATOR_CONFIDENCE_MAX', 74); },
  get aiValidatorEdgeMax() { return asFloat('AI_VALIDATOR_EDGE_MAX', 0.06); },
  get boundaryNoTradeBandDeg() { return asFloat('BOUNDARY_NO_TRADE_BAND_DEG', 0.35); },
  get boundaryOverrideConfidence() { return asFloat('BOUNDARY_OVERRIDE_CONFIDENCE', 82); },
  get boundaryOverrideEdge() { return asFloat('BOUNDARY_OVERRIDE_EDGE', 0.08); },
  get volatilityConfidenceEnabled() { return asBoolTrueUnlessFalse('VOLATILITY_CONFIDENCE_ENABLED', true); },
  get volatilityLowPct() { return asFloat('VOLATILITY_LOW_PCT', 8); },
  get volatilityHighPct() { return asFloat('VOLATILITY_HIGH_PCT', 18); },
  get volatilityConfidenceBumpLow() { return asFloat('VOLATILITY_CONFIDENCE_BUMP_LOW', 3); },
  get volatilityConfidenceBumpHigh() { return asFloat('VOLATILITY_CONFIDENCE_BUMP_HIGH', 7); },
  get liquidityMinScore() { return asFloat('LIQUIDITY_MIN_SCORE', 55); },
  get liquidityFreshMs() { return asInt('LIQUIDITY_FRESH_MS', 90000); },
  get liquidityMaxSpreadPct() { return asFloat('LIQUIDITY_MAX_SPREAD_PCT', 0.08); },
  get circuitBreakerFailureThreshold() { return asInt('CIRCUIT_BREAKER_FAILURE_THRESHOLD', 3); },
  get circuitBreakerCooldownMs() { return asInt('CIRCUIT_BREAKER_COOLDOWN_MS', 300000); },
  get expectedFillStaleMs() { return asInt('EXPECTED_FILL_STALE_MS', 180000); },
  get reconciliationToleranceSize() { return asFloat('RECONCILIATION_TOLERANCE_SIZE', 0.25); },
  get reconciliationTolerancePricePct() { return asFloat('RECONCILIATION_TOLERANCE_PRICE_PCT', 0.15); },
  get exchangeRefreshMinIntervalMs() { return asInt('EXCHANGE_REFRESH_MIN_INTERVAL_MS', 12000); },
  get stalePlacedGraceMinutes() { return asInt('STALE_PLACED_GRACE_MINUTES', 15); },

  // ─── Schedule ───────────────────────────────────────────────────────────
  get scanCron() { return asString('SCAN_CRON', '0 */2 * * *'); },
  get dailyReportCron() { return asString('DAILY_REPORT_CRON', '50 23 * * *'); },
  get staleOrderCancelCron() { return asString('STALE_ORDER_CANCEL_CRON', '* * * * *'); },
  get statusFallbackCron() { return asString('STATUS_FALLBACK_CRON', '*/10 * * * *'); },
  get maxEventsPerScan() { return asInt('MAX_EVENTS_PER_SCAN', 30); },
  get scanWindowMinHours() { return asInt('SCAN_WINDOW_MIN_HOURS', 12); },
  get scanWindowMaxHours() { return asInt('SCAN_WINDOW_MAX_HOURS', 48); },
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
  if (!['off', 'shadow', 'paper', 'live'].includes(config.tradingMode)) {
    errors.push(`TRADING_MODE must be one of off|shadow|paper|live, got ${config.tradingMode}`);
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
  if (config.maxDailyBets <= 0) {
    errors.push(`maxDailyBets must be > 0, got ${config.maxDailyBets}`);
  }
  if (!Number.isInteger(config.maxEventsPerScan) || config.maxEventsPerScan <= 0) {
    errors.push(`MAX_EVENTS_PER_SCAN must be an integer > 0, got ${config.maxEventsPerScan}`);
  }
  if (!Number.isInteger(config.scanWindowMinHours) || config.scanWindowMinHours < 0) {
    errors.push(`SCAN_WINDOW_MIN_HOURS must be an integer >= 0, got ${config.scanWindowMinHours}`);
  }
  if (!Number.isInteger(config.scanWindowMaxHours) || config.scanWindowMaxHours <= 0) {
    errors.push(`SCAN_WINDOW_MAX_HOURS must be an integer > 0, got ${config.scanWindowMaxHours}`);
  }
  if (Number.isInteger(config.scanWindowMinHours) && Number.isInteger(config.scanWindowMaxHours)
    && config.scanWindowMinHours > config.scanWindowMaxHours) {
    errors.push(`SCAN_WINDOW_MIN_HOURS must be <= SCAN_WINDOW_MAX_HOURS (${config.scanWindowMinHours} > ${config.scanWindowMaxHours})`);
  }
  if (!looksLikeCronExpression(config.scanCron)) {
    errors.push(`SCAN_CRON must be a 5-field cron expression, got "${config.scanCron}"`);
  }
  if (!looksLikeCronExpression(config.dailyReportCron)) {
    errors.push(`DAILY_REPORT_CRON must be a 5-field cron expression, got "${config.dailyReportCron}"`);
  }
  if (!looksLikeCronExpression(config.staleOrderCancelCron)) {
    errors.push(`STALE_ORDER_CANCEL_CRON must be a 5-field cron expression, got "${config.staleOrderCancelCron}"`);
  }
  if (!looksLikeCronExpression(config.statusFallbackCron)) {
    errors.push(`STATUS_FALLBACK_CRON must be a 5-field cron expression, got "${config.statusFallbackCron}"`);
  }
  if (!Number.isFinite(config.resolutionGraceMinutes) || config.resolutionGraceMinutes < 0) {
    errors.push(`RESOLUTION_GRACE_MINUTES must be a finite integer >= 0, got ${config.resolutionGraceMinutes}`);
  }
  if (config.aiValidatorConfidenceMax < 0 || config.aiValidatorConfidenceMax > 100) {
    errors.push(`AI_VALIDATOR_CONFIDENCE_MAX must be in [0, 100], got ${config.aiValidatorConfidenceMax}`);
  }
  if (config.aiValidatorEdgeMax < 0 || config.aiValidatorEdgeMax > 1) {
    errors.push(`AI_VALIDATOR_EDGE_MAX must be in [0, 1], got ${config.aiValidatorEdgeMax}`);
  }
  if (config.boundaryNoTradeBandDeg < 0 || config.boundaryNoTradeBandDeg > 5) {
    errors.push(`BOUNDARY_NO_TRADE_BAND_DEG must be in [0, 5], got ${config.boundaryNoTradeBandDeg}`);
  }
  if (config.boundaryOverrideConfidence < 0 || config.boundaryOverrideConfidence > 100) {
    errors.push(`BOUNDARY_OVERRIDE_CONFIDENCE must be in [0, 100], got ${config.boundaryOverrideConfidence}`);
  }
  if (config.boundaryOverrideEdge < 0 || config.boundaryOverrideEdge > 1) {
    errors.push(`BOUNDARY_OVERRIDE_EDGE must be in [0, 1], got ${config.boundaryOverrideEdge}`);
  }
  if (config.maxDailyUniqueExposures <= 0) {
    errors.push(`MAX_DAILY_UNIQUE_EXPOSURES must be > 0, got ${config.maxDailyUniqueExposures}`);
  }
  if (config.volatilityLowPct < 0 || config.volatilityLowPct > 100) {
    errors.push(`VOLATILITY_LOW_PCT must be in [0, 100], got ${config.volatilityLowPct}`);
  }
  if (config.volatilityHighPct < 0 || config.volatilityHighPct > 100) {
    errors.push(`VOLATILITY_HIGH_PCT must be in [0, 100], got ${config.volatilityHighPct}`);
  }
  if (config.volatilityLowPct > config.volatilityHighPct) {
    errors.push(`VOLATILITY_LOW_PCT must be <= VOLATILITY_HIGH_PCT (${config.volatilityLowPct} > ${config.volatilityHighPct})`);
  }
  if (config.volatilityConfidenceBumpLow < 0 || config.volatilityConfidenceBumpLow > 30) {
    errors.push(`VOLATILITY_CONFIDENCE_BUMP_LOW must be in [0, 30], got ${config.volatilityConfidenceBumpLow}`);
  }
  if (config.volatilityConfidenceBumpHigh < 0 || config.volatilityConfidenceBumpHigh > 30) {
    errors.push(`VOLATILITY_CONFIDENCE_BUMP_HIGH must be in [0, 30], got ${config.volatilityConfidenceBumpHigh}`);
  }
  if (config.liquidityMinScore < 0 || config.liquidityMinScore > 100) {
    errors.push(`LIQUIDITY_MIN_SCORE must be in [0, 100], got ${config.liquidityMinScore}`);
  }
  if (config.liquidityFreshMs < 1000) {
    errors.push(`LIQUIDITY_FRESH_MS must be >= 1000, got ${config.liquidityFreshMs}`);
  }
  if (config.liquidityMaxSpreadPct <= 0 || config.liquidityMaxSpreadPct > 1) {
    errors.push(`LIQUIDITY_MAX_SPREAD_PCT must be in (0, 1], got ${config.liquidityMaxSpreadPct}`);
  }
  if (config.circuitBreakerFailureThreshold <= 0) {
    errors.push(`CIRCUIT_BREAKER_FAILURE_THRESHOLD must be > 0, got ${config.circuitBreakerFailureThreshold}`);
  }
  if (config.circuitBreakerCooldownMs < 30000) {
    errors.push(`CIRCUIT_BREAKER_COOLDOWN_MS must be >= 30000, got ${config.circuitBreakerCooldownMs}`);
  }
  if (config.expectedFillStaleMs < 30000) {
    errors.push(`EXPECTED_FILL_STALE_MS must be >= 30000, got ${config.expectedFillStaleMs}`);
  }
  if (config.reconciliationToleranceSize < 0) {
    errors.push(`RECONCILIATION_TOLERANCE_SIZE must be >= 0, got ${config.reconciliationToleranceSize}`);
  }
  if (config.reconciliationTolerancePricePct < 0 || config.reconciliationTolerancePricePct > 1) {
    errors.push(`RECONCILIATION_TOLERANCE_PRICE_PCT must be in [0, 1], got ${config.reconciliationTolerancePricePct}`);
  }
  if (config.exchangeRefreshMinIntervalMs < 1000) {
    errors.push(`EXCHANGE_REFRESH_MIN_INTERVAL_MS must be >= 1000, got ${config.exchangeRefreshMinIntervalMs}`);
  }
  if (config.stalePlacedGraceMinutes < 1) {
    errors.push(`STALE_PLACED_GRACE_MINUTES must be >= 1, got ${config.stalePlacedGraceMinutes}`);
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
  if (getSetting('STOP_LOSS_TCP', '') === '') {
    warnings.push('STOP_LOSS_TCP not set — using default 0.25');
  }

  return { valid: errors.length === 0, errors, warnings };
}
