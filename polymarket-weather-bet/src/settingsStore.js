import { existsSync, mkdirSync, readFileSync, watch } from 'fs';
import { writeFile } from 'fs/promises';
import path from 'path';

const SETTINGS_DIR = path.join(process.cwd(), 'data');
const SETTINGS_FILE = path.join(SETTINGS_DIR, 'settings.json');

export class SettingsValidationError extends Error {
  constructor(errors) {
    super('Settings validation failed');
    this.name = 'SettingsValidationError';
    this.statusCode = 400;
    this.errors = errors;
  }
}

const SETTINGS_SCHEMA = [
  {
    key: 'SIGNATURE_TYPE',
    type: 'number',
    integer: true,
    min: 0,
    max: 2,
    applyMode: 'restart',
    description: 'CLOB signature version.',
  },
  {
    key: 'FUNDER_ADDRESS',
    type: 'string',
    pattern: '^0x[a-fA-F0-9]{40}$',
    patternHelp: 'Must be a 0x-prefixed 40-hex-character address.',
    allowEmpty: true,
    applyMode: 'restart',
    description: 'Polymarket proxy/funder wallet address.',
  },
  { key: 'POLY_API_KEY', type: 'string', applyMode: 'restart', description: 'Optional explicit Polymarket API key.' },
  { key: 'POLY_API_SECRET', type: 'string', applyMode: 'restart', description: 'Optional explicit Polymarket API secret.' },
  { key: 'POLY_PASSPHRASE', type: 'string', applyMode: 'restart', description: 'Optional explicit Polymarket API passphrase.' },
  { key: 'OPENAI_API_KEY', type: 'string', minLength: 10, applyMode: 'restart', description: 'OpenAI API key for AI pick/validation calls.' },
  { key: 'OPENAI_MODEL', type: 'string', minLength: 1, applyMode: 'realtime', description: 'OpenAI model name.' },
  { key: 'OWM_API_KEY', type: 'string', applyMode: 'realtime', description: 'OpenWeatherMap API key.' },
  { key: 'NOAA_CDO_TOKEN', type: 'string', applyMode: 'realtime', description: 'NOAA CDO API token.' },
  { key: 'PORT', type: 'number', integer: true, min: 1, max: 65535, applyMode: 'restart', description: 'Express server port.' },
  {
    key: 'LOG_LEVEL',
    type: 'string',
    enum: ['error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly'],
    applyMode: 'restart',
    description: 'Winston log level.',
  },
  { key: 'PAPER_TRADE', type: 'boolean', applyMode: 'realtime', description: 'Simulate orders instead of posting live orders.' },
  { key: 'DAILY_BET_SLOTS', type: 'number', integer: true, min: 1, max: 100, applyMode: 'realtime', description: 'Maximum weather positions to hold in daily flow.' },
  {
    key: 'DAILY_SCAN_CRON',
    type: 'string',
    validator: 'cron5',
    validatorHelp: 'Use a 5-field cron expression, for example: 0 16 * * *',
    applyMode: 'realtime',
    description: 'UTC cron expression for scheduled daily run.',
  },
  { key: 'SCAN_WINDOW_MIN_HOURS', type: 'number', integer: true, min: 0, max: 240, applyMode: 'realtime', description: 'Minimum hours ahead for eligible events.' },
  { key: 'SCAN_WINDOW_MAX_HOURS', type: 'number', integer: true, min: 1, max: 240, applyMode: 'realtime', description: 'Maximum hours ahead for eligible events.' },
  { key: 'YES_PRICE_MAX', type: 'number', minExclusive: 0, max: 1, step: 0.01, applyMode: 'realtime', description: 'Upper YES ask threshold.' },
  { key: 'YES_PRICE_MIN', type: 'number', min: 0, max: 1, step: 0.01, applyMode: 'realtime', description: 'Lower YES ask threshold.' },
  { key: 'FIXED_SHARES', type: 'number', minExclusive: 0, max: 1000, step: 0.1, applyMode: 'realtime', description: 'Share size for each YES buy order.' },
  { key: 'ORDER_EXPIRY_MINUTES', type: 'number', integer: true, min: 1, max: 10080, applyMode: 'realtime', description: 'Limit order expiry in minutes (posted as GTD).' },
];

const KEY_SET = new Set(SETTINGS_SCHEMA.map((s) => s.key));

let loaded = false;
let cache = {};
let watcher = null;

function loadFromDiskSync() {
  if (!existsSync(SETTINGS_FILE)) return {};
  try {
    const raw = readFileSync(SETTINGS_FILE, 'utf8');
    const data = JSON.parse(raw || '{}');
    if (!data || typeof data !== 'object' || Array.isArray(data)) return {};

    const filtered = {};
    for (const [key, value] of Object.entries(data)) {
      if (KEY_SET.has(key) && typeof value === 'string') filtered[key] = value;
    }
    return filtered;
  } catch {
    return {};
  }
}

function ensureLoaded() {
  if (loaded) return;
  cache = loadFromDiskSync();
  loaded = true;
}

function coerceToString(value, type) {
  if (value == null) return '';
  return String(value).trim();
}

function externalDefaultFor(key) {
  return process.env[key] ?? '';
}

function startWatcher() {
  if (watcher) return;
  mkdirSync(SETTINGS_DIR, { recursive: true });
  watcher = watch(SETTINGS_DIR, (_eventType, filename) => {
    if (filename !== 'settings.json') return;
    cache = loadFromDiskSync();
    loaded = true;
  });
}

export function startSettingsStore() {
  ensureLoaded();
  startWatcher();
}

export function getSettingOverride(key) {
  ensureLoaded();
  return cache[key];
}

export function getEffectiveSetting(key, fallback = '') {
  ensureLoaded();
  if (Object.hasOwn(cache, key)) return cache[key];
  return fallback;
}

export function getSettingsSchema() {
  return SETTINGS_SCHEMA.map((item) => ({ ...item }));
}

function parseBoolean(raw) {
  const v = String(raw || '').toLowerCase();
  if (v === 'true') return true;
  if (v === 'false') return false;
  return null;
}

function buildEffectiveRawValues(nextOverrides) {
  const out = {};
  for (const item of SETTINGS_SCHEMA) {
    const fromOverride = nextOverrides[item.key];
    if (typeof fromOverride === 'string') {
      out[item.key] = fromOverride;
      continue;
    }
    out[item.key] = externalDefaultFor(item.key);
  }
  return out;
}

function validateSingleValue(item, rawValue) {
  const errors = [];
  const value = String(rawValue ?? '').trim();

  if (value === '') {
    if (item.allowEmpty === false) errors.push(`${item.key} cannot be empty`);
    return errors;
  }

  if (item.type === 'boolean') {
    if (parseBoolean(value) == null) errors.push(`${item.key} must be true or false`);
    return errors;
  }

  if (item.type === 'number') {
    const n = Number(value);
    if (!Number.isFinite(n)) {
      errors.push(`${item.key} must be a valid number`);
      return errors;
    }
    if (item.integer && !Number.isInteger(n)) errors.push(`${item.key} must be an integer`);
    if (typeof item.min === 'number' && n < item.min) errors.push(`${item.key} must be >= ${item.min}`);
    if (typeof item.max === 'number' && n > item.max) errors.push(`${item.key} must be <= ${item.max}`);
    if (typeof item.minExclusive === 'number' && n <= item.minExclusive) errors.push(`${item.key} must be > ${item.minExclusive}`);
    return errors;
  }

  if (item.type === 'string') {
    if (typeof item.minLength === 'number' && value.length < item.minLength) {
      errors.push(`${item.key} must be at least ${item.minLength} characters`);
    }
    if (Array.isArray(item.enum) && item.enum.length > 0 && !item.enum.includes(value.toLowerCase())) {
      errors.push(`${item.key} must be one of: ${item.enum.join(', ')}`);
    }
    if (item.pattern) {
      const re = new RegExp(item.pattern);
      if (!re.test(value)) errors.push(item.patternHelp || `${item.key} format is invalid`);
    }
    if (item.validator === 'cron5') {
      const parts = value.split(/\s+/).filter(Boolean);
      if (parts.length !== 5) errors.push(item.validatorHelp || `${item.key} must be a 5-field cron expression`);
    }
  }

  return errors;
}

function validateCrossField(rawValues) {
  const errors = [];

  const scanMin = Number(rawValues.SCAN_WINDOW_MIN_HOURS || '');
  const scanMax = Number(rawValues.SCAN_WINDOW_MAX_HOURS || '');
  if (Number.isFinite(scanMin) && Number.isFinite(scanMax) && scanMax <= scanMin) {
    errors.push('SCAN_WINDOW_MAX_HOURS must be > SCAN_WINDOW_MIN_HOURS');
  }

  const yesMin = Number(rawValues.YES_PRICE_MIN || '');
  const yesMax = Number(rawValues.YES_PRICE_MAX || '');
  if (Number.isFinite(yesMin) && Number.isFinite(yesMax) && yesMin > yesMax) {
    errors.push('YES_PRICE_MIN must be <= YES_PRICE_MAX');
  }

  return errors;
}

function validateCandidate(nextOverrides) {
  const errors = [];
  const rawValues = buildEffectiveRawValues(nextOverrides);

  for (const item of SETTINGS_SCHEMA) {
    const valueErrors = validateSingleValue(item, rawValues[item.key]);
    errors.push(...valueErrors);
  }
  errors.push(...validateCrossField(rawValues));

  if (errors.length) throw new SettingsValidationError(errors);
}

export function getSettingsPayload() {
  ensureLoaded();
  const settings = SETTINGS_SCHEMA.map((item) => {
    const override = getSettingOverride(item.key);
    const defaultValue = externalDefaultFor(item.key);
    const value = override ?? defaultValue;
    return {
      ...item,
      defaultValue,
      value,
      source: override == null ? 'env' : 'override',
    };
  });

  const restartRequired = settings.filter((s) => s.applyMode === 'restart').map((s) => s.key);
  const realtime = settings.filter((s) => s.applyMode === 'realtime').map((s) => s.key);

  return {
    settings,
    summary: {
      restartRequired,
      realtime,
    },
  };
}

export async function saveSettingsPatch(patch) {
  ensureLoaded();

  const next = { ...cache };
  for (const item of SETTINGS_SCHEMA) {
    if (!Object.hasOwn(patch, item.key)) continue;
    const raw = coerceToString(patch[item.key], item.type);
    if (raw === '') {
      delete next[item.key];
      continue;
    }
    next[item.key] = raw;
  }

  validateCandidate(next);

  mkdirSync(SETTINGS_DIR, { recursive: true });
  await writeFile(SETTINGS_FILE, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  cache = next;
  loaded = true;
  return getSettingsPayload();
}

export function getSettingsFilePath() {
  return SETTINGS_FILE;
}
