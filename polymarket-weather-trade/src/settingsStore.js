// src/settingsStore.js — Runtime settings overrides with disk persistence + in-memory cache
import fs from 'fs';
import path from 'path';

const SETTINGS_FILE = path.resolve(process.cwd(), 'data', 'settings-overrides.json');
const ENV_EXAMPLE_FILE = path.resolve(process.cwd(), '.env.example');

const PRIVATE_KEYS = new Set(['POLYGON_PRIVATE_KEY']);

const RESTART_REQUIRED_KEYS = new Set([
  'POLYGON_PRIVATE_KEY',
  'SIGNATURE_TYPE',
  'FUNDER_ADDRESS',
  'POLY_API_KEY',
  'POLY_API_SECRET',
  'POLY_PASSPHRASE',
  'OPENAI_API_KEY',
  'PORT',
]);

let initialized = false;
let watcherInitialized = false;
let metadata = [];
let metadataKeySet = new Set();
let overrideCache = {};
let envExampleMtimeMs = null;

const LOG_LEVELS = new Set(['error', 'warn', 'info', 'debug']);

function parseNumber(value, { integer = false } = {}) {
  const n = integer ? Number.parseInt(value, 10) : Number.parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

function inRange(n, { min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY, minInclusive = true, maxInclusive = true } = {}) {
  if (n == null) return false;
  const lower = minInclusive ? n >= min : n > min;
  const upper = maxInclusive ? n <= max : n < max;
  return lower && upper;
}

function isBooleanString(v) {
  const s = String(v).toLowerCase();
  return s === 'true' || s === 'false';
}

function isWsUrl(v) {
  const s = String(v || '').trim();
  return s.startsWith('ws://') || s.startsWith('wss://');
}

function isHexAddress(v) {
  return /^0x[a-fA-F0-9]{40}$/.test(String(v || '').trim());
}

function validateSettingValue(name, value) {
  const v = String(value).trim();
  if (v === '') return null; // Empty means reset to env default.

  switch (name) {
    case 'SIGNATURE_TYPE': {
      const n = parseNumber(v, { integer: true });
      if (n == null || ![0, 1, 2].includes(n)) return 'Must be one of 0, 1, or 2';
      return null;
    }
    case 'FUNDER_ADDRESS':
      return isHexAddress(v) ? null : 'Must be a valid 0x-prefixed 40-hex Ethereum address';
    case 'REALTIME_MONITORING':
    case 'PAPER_TRADE':
      return isBooleanString(v) ? null : 'Must be true or false';
    case 'MARKET_WS_URL':
    case 'USER_WS_URL':
      return isWsUrl(v) ? null : 'Must start with ws:// or wss://';
    case 'PORT': {
      const n = parseNumber(v, { integer: true });
      if (!inRange(n, { min: 1, max: 65535 })) return 'Must be an integer between 1 and 65535';
      return null;
    }
    case 'LOG_LEVEL':
      return LOG_LEVELS.has(v.toLowerCase()) ? null : 'Must be one of: error, warn, info, debug';
    case 'BET_AMOUNT_USD': {
      const n = parseNumber(v);
      return inRange(n, { min: 1 }) ? null : 'Must be a number >= 1';
    }
    case 'BET_SIZE': {
      const n = parseNumber(v);
      return inRange(n, { min: 0, minInclusive: false }) ? null : 'Must be a number > 0';
    }
    case 'MAX_ACTIVE_BETS':
    case 'MAX_DAILY_BETS':
    case 'MAX_DAILY_TOKENS': {
      const n = parseNumber(v, { integer: true });
      return inRange(n, { min: 1 }) ? null : 'Must be an integer >= 1';
    }
    case 'MIN_BALANCE_WARN_USD':
    case 'MIN_BALANCE_STOP_USD': {
      const n = parseNumber(v);
      return inRange(n, { min: 0 }) ? null : 'Must be a number >= 0';
    }
    case 'MIN_ODDS_VALUE': {
      const n = parseNumber(v);
      return inRange(n, { min: 0, max: 1, maxInclusive: false }) ? null : 'Must be in range [0, 1)';
    }
    case 'MAX_ODDS_VALUE': {
      const n = parseNumber(v);
      return inRange(n, { min: 0, max: 1, minInclusive: false }) ? null : 'Must be in range (0, 1]';
    }
    case 'MIN_CONFIDENCE': {
      const n = parseNumber(v);
      return inRange(n, { min: 0, max: 100 }) ? null : 'Must be in range [0, 100]';
    }
    case 'MIN_EDGE': {
      const n = parseNumber(v);
      return inRange(n, { min: 0, max: 1 }) ? null : 'Must be in range [0, 1]';
    }
    case 'MAX_BET_SIZE': {
      const n = parseNumber(v);
      return inRange(n, { min: 0, minInclusive: false }) ? null : 'Must be a number > 0';
    }
    case 'NOAA_RECENT_DAYS_START': {
      const n = parseNumber(v, { integer: true });
      return inRange(n, { min: 1, max: 30 }) ? null : 'Must be an integer in [1, 30]';
    }
    case 'NOAA_RECENT_DAYS_COUNT': {
      const n = parseNumber(v, { integer: true });
      return inRange(n, { min: 1, max: 30 }) ? null : 'Must be an integer in [1, 30]';
    }
    case 'NOAA_SAME_DAY_YEARS_BACK_COUNT': {
      const n = parseNumber(v, { integer: true });
      return inRange(n, { min: 1, max: 20 }) ? null : 'Must be an integer in [1, 20]';
    }
    case 'LOW_BET_TAKE_PROFIT':
    case 'HIGH_BET_TAKE_PROFIT': {
      const n = parseNumber(v);
      return inRange(n, { min: 0, minInclusive: false }) ? null : 'Must be a number > 0 (percentage units)';
    }
    case 'TAKE_PROFIT_DISABLE_BEFORE_END_MINUTES': {
      const n = parseNumber(v, { integer: true });
      return Number.isInteger(n) ? null : 'Must be an integer (can be positive or negative)';
    }
    case 'STOP_LOSS_TCP': {
      const n = parseNumber(v);
      return inRange(n, { min: 0, max: 1, minInclusive: false, maxInclusive: false }) ? null : 'Must be in range (0, 1)';
    }
    default:
      return null;
  }
}

function computeEffectiveWithIncoming(name, incoming, currentEffective, envDefault) {
  const v = normalizeValue(incoming);
  if (v === '' || v === envDefault) return envDefault;
  return v;
}

export function validatePublicSettings(values = {}) {
  ensureInitialized();

  const allowed = new Set(metadata.filter((m) => !m.private).map((m) => m.name));
  const fieldErrors = [];

  for (const [name, raw] of Object.entries(values || {})) {
    if (!allowed.has(name)) continue;
    const msg = validateSettingValue(name, raw);
    if (msg) fieldErrors.push({ name, message: msg });
  }

  // Cross-field consistency checks using effective post-save values.
  const incomingMap = values || {};
  const minOddsCurrent = effectiveValueFor('MIN_ODDS_VALUE');
  const maxOddsCurrent = effectiveValueFor('MAX_ODDS_VALUE');
  const minOddsEnv = envDefaultFor('MIN_ODDS_VALUE');
  const maxOddsEnv = envDefaultFor('MAX_ODDS_VALUE');

  const minOddsEffective = computeEffectiveWithIncoming('MIN_ODDS_VALUE', incomingMap.MIN_ODDS_VALUE, minOddsCurrent, minOddsEnv);
  const maxOddsEffective = computeEffectiveWithIncoming('MAX_ODDS_VALUE', incomingMap.MAX_ODDS_VALUE, maxOddsCurrent, maxOddsEnv);

  const minOddsNum = parseNumber(minOddsEffective);
  const maxOddsNum = parseNumber(maxOddsEffective);
  if (minOddsNum != null && maxOddsNum != null && minOddsNum > maxOddsNum) {
    fieldErrors.push({
      name: 'MIN_ODDS_VALUE',
      message: 'Must be <= MAX_ODDS_VALUE after applying all changes',
    });
  }

  return {
    valid: fieldErrors.length === 0,
    fieldErrors,
  };
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function normalizeValue(value) {
  if (value == null) return '';
  return String(value).trim();
}

function isPrivateKey(name) {
  return PRIVATE_KEYS.has(name) || name.includes('PRIVATE_KEY');
}

function parseEnvExampleMetadata() {
  const text = fs.readFileSync(ENV_EXAMPLE_FILE, 'utf8');
  const lines = text.split(/\r?\n/);
  const out = [];
  let commentBuffer = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      commentBuffer = [];
      continue;
    }

    if (line.startsWith('#')) {
      const cleaned = line.replace(/^#\s?/, '').trim();
      if (cleaned) commentBuffer.push(cleaned);
      continue;
    }

    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) {
      commentBuffer = [];
      continue;
    }

    const [, name, exampleDefaultRaw] = m;
    const exampleDefault = String(exampleDefaultRaw || '').trim();
    const description = commentBuffer.join(' ');
    commentBuffer = [];

    out.push({
      name,
      description,
      exampleDefault,
      private: isPrivateKey(name),
      restartRequired: RESTART_REQUIRED_KEYS.has(name),
    });
  }

  // Keep first occurrence only.
  const seen = new Set();
  return out.filter((item) => {
    if (seen.has(item.name)) return false;
    seen.add(item.name);
    return true;
  });
}

function getEnvExampleMtimeMs() {
  try {
    return fs.statSync(ENV_EXAMPLE_FILE).mtimeMs;
  } catch {
    return 0;
  }
}

function syncMetadataFromEnvExample(force = false) {
  const nextMtime = getEnvExampleMtimeMs();
  const shouldRefresh = force || !initialized || envExampleMtimeMs == null || nextMtime !== envExampleMtimeMs;
  if (!shouldRefresh) return;

  metadata = parseEnvExampleMetadata();
  metadataKeySet = new Set(metadata.map((m) => m.name));
  envExampleMtimeMs = nextMtime;
}

function readOverridesFromDisk() {
  if (!fs.existsSync(SETTINGS_FILE)) {
    overrideCache = {};
    return;
  }

  try {
    const raw = fs.readFileSync(SETTINGS_FILE, 'utf8');
    const parsed = JSON.parse(raw || '{}');
    const map = parsed && typeof parsed === 'object'
      ? (parsed.overrides && typeof parsed.overrides === 'object' ? parsed.overrides : parsed)
      : {};

    const next = {};
    for (const [key, value] of Object.entries(map)) {
      next[key] = normalizeValue(value);
    }
    overrideCache = next;
  } catch {
    overrideCache = {};
  }
}

function ensureInitialized() {
  if (!initialized) {
    syncMetadataFromEnvExample(true);
    readOverridesFromDisk();
    initialized = true;
  } else {
    syncMetadataFromEnvExample(false);
  }

  if (!watcherInitialized) {
    watcherInitialized = true;
    fs.watchFile(SETTINGS_FILE, { interval: 1500 }, () => {
      readOverridesFromDisk();
    });
  }
}

function envDefaultFor(name) {
  if (process.env[name] == null) return '';
  return String(process.env[name]);
}

function effectiveValueFor(name) {
  ensureInitialized();
  // Only apply persisted overrides for keys currently present in .env.example.
  // If a variable was removed from .env.example, treat stale file value as inactive.
  if (metadataKeySet.has(name) && hasOwn(overrideCache, name)) return overrideCache[name];
  return envDefaultFor(name);
}

export function getSetting(name, fallback = '') {
  const value = effectiveValueFor(name);
  if (value === '') return String(fallback ?? '');
  return value;
}

export function initSettingsStore() {
  ensureInitialized();
}

export function getSettingsFilePath() {
  return SETTINGS_FILE;
}

export function getSettingsMetadata() {
  ensureInitialized();
  return metadata.map((m) => ({ ...m }));
}

export function getPublicSettingsView() {
  ensureInitialized();

  return metadata
    .filter((m) => !m.private)
    .map((m) => {
      const envDefault = envDefaultFor(m.name);
      const hasOverride = hasOwn(overrideCache, m.name);
      const effectiveValue = hasOverride ? overrideCache[m.name] : envDefault;

      return {
        name: m.name,
        description: m.description,
        restartRequired: m.restartRequired,
        applies: m.restartRequired ? 'restart' : 'realtime',
        envDefault,
        currentValue: effectiveValue,
        source: hasOverride ? 'settings-file' : 'env',
      };
    });
}

export function savePublicSettings(values = {}) {
  ensureInitialized();

  const validation = validatePublicSettings(values);
  if (!validation.valid) {
    const err = new Error('Validation failed');
    err.code = 'VALIDATION_FAILED';
    err.fieldErrors = validation.fieldErrors;
    throw err;
  }

  const allowed = new Set(metadata.filter((m) => !m.private).map((m) => m.name));
  const nextOverrides = { ...overrideCache };
  const changed = [];

  for (const [name, raw] of Object.entries(values || {})) {
    if (!allowed.has(name)) continue;

    const incoming = normalizeValue(raw);
    const envDefault = envDefaultFor(name);
    const before = hasOwn(overrideCache, name) ? overrideCache[name] : envDefault;

    if (incoming === envDefault || incoming === '') {
      delete nextOverrides[name];
    } else {
      nextOverrides[name] = incoming;
    }

    const after = hasOwn(nextOverrides, name) ? nextOverrides[name] : envDefault;
    if (before !== after) changed.push(name);
  }

  overrideCache = nextOverrides;

  const fileExists = fs.existsSync(SETTINGS_FILE);
  if (changed.length === 0 && !fileExists) {
    return {
      changed,
      changedCount: 0,
      restartRequired: [],
      realtime: [],
      settingsFile: SETTINGS_FILE,
      hasChanges: false,
    };
  }

  const dataDir = path.dirname(SETTINGS_FILE);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    SETTINGS_FILE,
    JSON.stringify({ updatedAt: new Date().toISOString(), overrides: nextOverrides }, null, 2),
    'utf8',
  );

  const changedSet = new Set(changed);
  const restartRequired = changed.filter((k) => RESTART_REQUIRED_KEYS.has(k));
  const realtime = changed.filter((k) => !RESTART_REQUIRED_KEYS.has(k));

  return {
    changed,
    changedCount: changed.length,
    restartRequired,
    realtime,
    settingsFile: SETTINGS_FILE,
    hasChanges: changedSet.size > 0,
  };
}
