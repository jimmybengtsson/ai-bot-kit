import 'dotenv/config';
import { getEffectiveSetting } from './settingsStore.js';

function asInt(value, fallback) {
  const n = parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) ? n : fallback;
}

function asFloat(value, fallback) {
  const n = parseFloat(String(value ?? ''));
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  polygonPrivateKey: process.env.POLYGON_PRIVATE_KEY,
  get signatureType() { return asInt(getEffectiveSetting('SIGNATURE_TYPE', process.env.SIGNATURE_TYPE || '2'), 2); },
  get funderAddress() { return getEffectiveSetting('FUNDER_ADDRESS', process.env.FUNDER_ADDRESS || ''); },
  get polyApiKey() { return getEffectiveSetting('POLY_API_KEY', process.env.POLY_API_KEY || ''); },
  get polyApiSecret() { return getEffectiveSetting('POLY_API_SECRET', process.env.POLY_API_SECRET || ''); },
  get polyPassphrase() { return getEffectiveSetting('POLY_PASSPHRASE', process.env.POLY_PASSPHRASE || ''); },

  clobHost: 'https://clob.polymarket.com',
  gammaHost: 'https://gamma-api.polymarket.com',
  dataHost: 'https://data-api.polymarket.com',
  chainId: 137,

  get openaiApiKey() { return getEffectiveSetting('OPENAI_API_KEY', process.env.OPENAI_API_KEY || ''); },
  get openaiModel() { return getEffectiveSetting('OPENAI_MODEL', process.env.OPENAI_MODEL || 'gpt-5-nano'); },

  get owmApiKey() { return getEffectiveSetting('OWM_API_KEY', process.env.OWM_API_KEY || ''); },
  get noaaCdoToken() { return getEffectiveSetting('NOAA_CDO_TOKEN', process.env.NOAA_CDO_TOKEN || ''); },

  get port() { return asInt(getEffectiveSetting('PORT', process.env.PORT || '3010'), 3010); },
  get logLevel() { return getEffectiveSetting('LOG_LEVEL', process.env.LOG_LEVEL || 'info'); },
  paperTrade: () => String(getEffectiveSetting('PAPER_TRADE', process.env.PAPER_TRADE || 'true')).toLowerCase() === 'true',

  get dailyBetSlots() { return asInt(getEffectiveSetting('DAILY_BET_SLOTS', process.env.DAILY_BET_SLOTS || '5'), 5); },
  get dailyScanCron() { return getEffectiveSetting('DAILY_SCAN_CRON', process.env.DAILY_SCAN_CRON || '0 16 * * *'); },
  get scanWindowMinHours() { return asInt(getEffectiveSetting('SCAN_WINDOW_MIN_HOURS', process.env.SCAN_WINDOW_MIN_HOURS || '12'), 12); },
  get scanWindowMaxHours() { return asInt(getEffectiveSetting('SCAN_WINDOW_MAX_HOURS', process.env.SCAN_WINDOW_MAX_HOURS || '36'), 36); },
  get yesPriceMax() { return asFloat(getEffectiveSetting('YES_PRICE_MAX', process.env.YES_PRICE_MAX || '0.30'), 0.3); },
  get yesPriceMin() { return asFloat(getEffectiveSetting('YES_PRICE_MIN', process.env.YES_PRICE_MIN || '0.05'), 0.05); },
  get fixedShares() { return asFloat(getEffectiveSetting('FIXED_SHARES', process.env.FIXED_SHARES || '5'), 5); },
  get orderExpiryMinutes() { return asInt(getEffectiveSetting('ORDER_EXPIRY_MINUTES', process.env.ORDER_EXPIRY_MINUTES || '60'), 60); },
};

export function validateConfig() {
  const errors = [];
  const warnings = [];

  if (!config.polygonPrivateKey) errors.push('POLYGON_PRIVATE_KEY is required');
  if (!config.openaiApiKey) errors.push('OPENAI_API_KEY is required');
  if (!config.owmApiKey) errors.push('OWM_API_KEY is required');
  if (!config.noaaCdoToken) errors.push('NOAA_CDO_TOKEN is required');
  if (config.dailyBetSlots <= 0) errors.push('DAILY_BET_SLOTS must be > 0');
  if (config.scanWindowMinHours < 0 || config.scanWindowMaxHours <= config.scanWindowMinHours) {
    errors.push('Invalid scan window: ensure SCAN_WINDOW_MAX_HOURS > SCAN_WINDOW_MIN_HOURS');
  }
  if (config.yesPriceMax <= 0 || config.yesPriceMax > 1) errors.push('YES_PRICE_MAX must be in (0,1]');
  if (config.yesPriceMin < 0 || config.yesPriceMin > 1) {
    errors.push('YES_PRICE_MIN must be in [0,1]');
  }
  if (config.yesPriceMin > config.yesPriceMax) {
    errors.push('YES_PRICE_MIN must be <= YES_PRICE_MAX');
  }
  if (config.orderExpiryMinutes <= 0) {
    errors.push('ORDER_EXPIRY_MINUTES must be > 0');
  }

  if (!config.funderAddress) warnings.push('FUNDER_ADDRESS not set; wallet address will be used as funder');
  if (!config.polyApiKey || !config.polyApiSecret || !config.polyPassphrase) {
    warnings.push('Polymarket API credentials not fully set — will derive from private key');
  }

  return { valid: errors.length === 0, errors, warnings };
}
