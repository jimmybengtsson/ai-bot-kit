// src/config.js — Central configuration loaded from .env
import 'dotenv/config';
import { accessSync, constants as fsConstants } from 'fs';

function parseBool(value, fallback) {
  if (value == null || value === '') return fallback;
  const v = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  return fallback;
}

function parseNumber(value, fallback, { min = -Infinity, max = Infinity } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function parseInteger(value, fallback, { min = -Infinity, max = Infinity } = {}) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function parseCsv(value, fallback) {
  if (!value || !String(value).trim()) return fallback;
  const items = String(value)
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  return items.length ? items : fallback;
}

function parseJsonObject(value, fallback) {
  if (!value || !String(value).trim()) return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

const DEFAULT_WATCHED_TOKENS = {
  SOL:      'So11111111111111111111111111111111111111112',
  USDC:     'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  JUP:      'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
  BONK:     'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
  WIF:      'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
  RAY:      '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R',
  ORCA:     'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE',
  PYTH:     'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3',
  JTO:      'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL',
  PUMP:     'pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn',
  TRUMP:    '6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN',
  RENDER:   'rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof',
  PENGU:    '2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv',
  HNT:      'hntyVP6YFm1Hg25TN9WGLqM12b8TQmcknKrdu1oxWux',
  FARTCOIN: '9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump',
  GRASS:    'Grass7B4RdKfBCjTKgSqnXkqjwiGvQyFbuSCUJr3XXjs',
  W:        '85VBFQZC9TZkfaptBWjvUw7YbZjy52A6mjtPGjstQAmQ',
  KMNO:     'KMNo3nJsBXfcpJTVhZcXLW7RmTwTt4GVFE7suUBo9sS',
  MET:      'METvsvVRapdj9cFLzq4Tr43xK4tAjQfwX76z3n6mWQL',
};

const DEFAULT_TOKEN_DECIMALS = {
  So11111111111111111111111111111111111111112: 9,
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 6,
  JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN: 6,
  DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263: 5,
  EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm: 6,
  '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R': 6,
  orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE: 6,
  HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3: 6,
  jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL: 9,
  pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn: 6,
  '6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN': 6,
  rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof: 8,
  '2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv': 6,
  hntyVP6YFm1Hg25TN9WGLqM12b8TQmcknKrdu1oxWux: 8,
  '9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump': 6,
  Grass7B4RdKfBCjTKgSqnXkqjwiGvQyFbuSCUJr3XXjs: 9,
  '85VBFQZC9TZkfaptBWjvUw7YbZjy52A6mjtPGjstQAmQ': 6,
  KMNo3nJsBXfcpJTVhZcXLW7RmTwTt4GVFE7suUBo9sS: 6,
  METvsvVRapdj9cFLzq4Tr43xK4tAjQfwX76z3n6mWQL: 6,
};

const DEFAULT_COMPARE_DEXES = [
  'Orca', 'HumidiFi', 'Meteora', 'Raydium CLMM', 'Manifest', 'PancakeSwap',
  'Raydium', 'PumpSwap', 'Stabble Stable Swap', 'Stabble Weighted Swap',
  'Stabble CLMM', 'Byreal', 'Meteora DAMM v2', 'Whirlpool',
];

const DEFAULT_SOLANA_KEYWORDS = [
  'solana', 'sol', 'jupiter', 'jup', 'raydium', 'orca', 'bonk', 'wif', 'jito', 'pyth',
  'marinade', 'drift', 'phantom', 'backpack', 'tensor', 'pump.fun', 'trump', 'render',
  'pengu', 'helium', 'hnt', 'fartcoin', 'grass', 'wormhole', 'kamino', 'meteora',
];

const watchedTokens = parseJsonObject(process.env.WATCHED_TOKENS_JSON, DEFAULT_WATCHED_TOKENS);
const tokenDecimalsRaw = parseJsonObject(process.env.TOKEN_DECIMALS_JSON, DEFAULT_TOKEN_DECIMALS);
const tokenDecimals = Object.fromEntries(
  Object.entries(tokenDecimalsRaw).map(([mint, dec]) => [mint, parseInteger(dec, 6, { min: 0, max: 18 })])
);

const hasDegenShareEnv = process.env.RISK_DEGEN_SHARE_PCT != null && String(process.env.RISK_DEGEN_SHARE_PCT).trim() !== '';
const hasGuardianShareEnv = process.env.RISK_GUARDIAN_SHARE_PCT != null && String(process.env.RISK_GUARDIAN_SHARE_PCT).trim() !== '';
const degenSharePct = hasDegenShareEnv
  ? parseNumber(process.env.RISK_DEGEN_SHARE_PCT, 60, { min: 0, max: 100 })
  : hasGuardianShareEnv
    ? (100 - parseNumber(process.env.RISK_GUARDIAN_SHARE_PCT, 40, { min: 0, max: 100 }))
    : 60;
const guardianSharePct = 100 - degenSharePct;
const degenShare = degenSharePct / 100;
const guardianShare = guardianSharePct / 100;

const solReserve = parseNumber(process.env.SOL_RESERVE, 0.05, { min: 0.001, max: 10 });
const usdcReserve = parseNumber(process.env.USDC_RESERVE, 25, { min: 0, max: 1000000 });
const degenMaxSolCap = parseNumber(process.env.RISK_DEGEN_MAX_SOL, 0, { min: 0, max: 100000 });
const guardianMaxSolCap = parseNumber(process.env.RISK_GUARDIAN_MAX_SOL, 0, { min: 0, max: 100000 });

export const config = {
  // Solana
  solanaRpcUrl: process.env.SOLANA_RPC_URL,
  heliusApiKey: process.env.HELIUS_API_KEY,
  walletPath:   process.env.WALLET_PATH,

  // Jupiter
  jupiterApiKey:   process.env.JUPITER_API_KEY || '',
  jupiterPriceApi: process.env.JUPITER_PRICE_API || 'https://api.jup.ag/price/v3',
  jupiterQuoteApi: process.env.JUPITER_QUOTE_API || 'https://api.jup.ag/swap/v1/quote',
  jupiterSwapApi:  process.env.JUPITER_SWAP_API || 'https://api.jup.ag/swap/v1/swap',

  // OpenAI
  openaiApiKey: process.env.OPENAI_API_KEY,
  openaiModel:  process.env.OPENAI_MODEL || 'gpt-5-nano',          // default / fallback
  openaiModels: {
    trading:          process.env.OPENAI_MODEL_TRADING          || process.env.OPENAI_MODEL || 'gpt-5-nano',
    tradingAnalysis:  process.env.OPENAI_MODEL_TRADING_ANALYSIS  || 'gpt-5-nano',
    validator:        process.env.OPENAI_MODEL_VALIDATOR         || 'gpt-5-nano',
    dailyReport:      process.env.OPENAI_MODEL_DAILY_REPORT      || process.env.OPENAI_MODEL || 'gpt-5-nano',
  },

  // Trading
  paperTrade: () => parseBool(process.env.PAPER_TRADE, true),
  logLevel:   process.env.LOG_LEVEL || 'info',

  // Server
  port: parseInteger(process.env.PORT, 3000, { min: 1, max: 65535 }),
  serverAdminApiKey: (process.env.SERVER_ADMIN_API_KEY || '').trim(),
  httpTimeoutMs: parseInteger(process.env.HTTP_TIMEOUT_MS, 15000, { min: 1000, max: 120000 }),
  scraperServerAddress: (process.env.SCRAPER_SERVER_ADDRESS || '').trim(),
  scraperServerApiKey: (process.env.SCRAPER_SERVER_API_KEY || '').trim(),
  cron: {
    tradingLoop: process.env.CRON_TRADING_LOOP || '10 * * * *',
    portfolioSnapshot: process.env.CRON_PORTFOLIO_SNAPSHOT || '*/15 * * * *',
    memoryFlush: process.env.CRON_MEMORY_FLUSH || '0 */2 * * *',
    dailyReport: process.env.CRON_DAILY_REPORT || '53 23 * * *',
    stalePositionCheck: process.env.CRON_STALE_POSITION_CHECK || '*/30 * * * *',
  },

  // Watched tokens  { symbol → mint }  — top 20 Solana ecosystem by market cap (2026-03-06)
  watchedTokens,

  // Token decimals (for converting USD → base units)
  tokenDecimals,

  // Risk parameters
  risk: {
    dailyLossLimitPct:   parseNumber(process.env.RISK_DAILY_LOSS_LIMIT_PCT, 5.0, { min: 0.1, max: 100 }),
    dailyTargetPct:      parseNumber(process.env.RISK_DAILY_TARGET_PCT, 10.0, { min: 0.1, max: 200 }),
    cooldownAfterLosses: parseInteger(process.env.RISK_COOLDOWN_AFTER_LOSSES, 3, { min: 1, max: 20 }),
    degenMaxPct:         parseNumber(process.env.RISK_DEGEN_MAX_PCT, 25.0, { min: 0, max: 100 }),
    guardianMaxPct:      parseNumber(process.env.RISK_GUARDIAN_MAX_PCT, 15.0, { min: 0, max: 100 }),
    degenMaxSol:         degenMaxSolCap,
    guardianMaxSol:      guardianMaxSolCap,
    degenSharePct,
    guardianSharePct,
    degenShare,
    guardianShare,
    degenEnabled: degenSharePct > 0,
    guardianEnabled: guardianSharePct > 0,
    maxHeldTokens:      parseInteger(process.env.RISK_MAX_HELD_TOKENS, 8, { min: 1, max: 50 }),
    maxTradesPerTick:   parseInteger(process.env.RISK_MAX_TRADES_PER_TICK, 2, { min: 1, max: 20 }),
  },

  // Arbitrage tuning
  arb: {
    slippageBps:         parseInteger(process.env.ARB_SLIPPAGE_BPS, 30, { min: 1, max: 1000 }),
    gasFeeSol:           parseNumber(process.env.ARB_GAS_FEE_SOL, 0.000005, { min: 0, max: 0.01 }),
    minSpreadPct2Leg:    parseNumber(process.env.ARB_MIN_SPREAD_PCT_2LEG, 2.0, { min: 0, max: 100 }),
    minSpreadPct3Leg:    parseNumber(process.env.ARB_MIN_SPREAD_PCT_3LEG, 3.0, { min: 0, max: 100 }),
    limitTimeoutMs:      parseInteger(process.env.ARB_LIMIT_TIMEOUT_MS, 180000, { min: 1000, max: 1800000 }),
    limitRetryMs:        parseInteger(process.env.ARB_LIMIT_RETRY_MS, 5000, { min: 500, max: 60000 }),
    autoArbMinSpreadPct: parseNumber(process.env.ARB_AUTO_MIN_SPREAD_PCT, 5.0, { min: 0, max: 100 }),
  },

  // Always keep this much SOL in wallet for transaction fees
  solReserveLamports: solReserve * 1e9,
  solReserve,
  // Main cash reserve for trading/take-profit anchor
  usdcReserve,

  // DEXs to compare for arb — curated shortlist (2026-03-06)
  compareDexes: parseCsv(process.env.COMPARE_DEXES_CSV, DEFAULT_COMPARE_DEXES),

  // Social keyword set for tweet scanning
  solanaKeywords: parseCsv(process.env.SOLANA_KEYWORDS_CSV, DEFAULT_SOLANA_KEYWORDS),

};

function getSingleStrategyHardMax(balanceSol, strategy) {
  const isGuardian = strategy === 'guardian';
  const share = isGuardian ? config.risk.guardianShare : config.risk.degenShare;
  const maxPct = isGuardian ? config.risk.guardianMaxPct : config.risk.degenMaxPct;
  const pctCap = balanceSol * share * (maxPct / 100);
  const solCap = isGuardian ? config.risk.guardianMaxSol : config.risk.degenMaxSol;
  return solCap > 0 ? Math.min(pctCap, solCap) : pctCap;
}

export function getStrategyHardMaxSol(balanceSol, strategy = 'degen') {
  if (!Number.isFinite(balanceSol) || balanceSol <= 0) return 0;
  if (strategy === 'combined') {
    return getSingleStrategyHardMax(balanceSol, 'degen') + getSingleStrategyHardMax(balanceSol, 'guardian');
  }
  return getSingleStrategyHardMax(balanceSol, strategy === 'guardian' ? 'guardian' : 'degen');
}

export function validateStartupConfig() {
  const errors = [];
  const warnings = [];
  const liveMode = !config.paperTrade();

  const required = [
    ['SOLANA_RPC_URL', config.solanaRpcUrl],
    ['HELIUS_API_KEY', config.heliusApiKey],
    ['WALLET_PATH', config.walletPath],
    ['OPENAI_API_KEY', config.openaiApiKey],
  ];

  if (liveMode) {
    required.push(['JUPITER_API_KEY', config.jupiterApiKey]);
  }

  for (const [name, value] of required) {
    if (!String(value || '').trim()) {
      errors.push(`${name} is required${liveMode ? ' in live mode' : ''}.`);
    }
  }

  if (config.walletPath) {
    try {
      accessSync(config.walletPath, fsConstants.R_OK);
    } catch {
      errors.push(`WALLET_PATH is not readable: ${config.walletPath}`);
    }
  }

  if (liveMode && !config.serverAdminApiKey) {
    warnings.push('SERVER_ADMIN_API_KEY is not set; /trigger endpoints will stay disabled.');
  }

  if (config.httpTimeoutMs < 3000) {
    warnings.push(`HTTP_TIMEOUT_MS=${config.httpTimeoutMs}ms is very low and may cause frequent upstream timeouts.`);
  }

  return {
    ok: errors.length === 0,
    mode: liveMode ? 'live' : 'paper',
    errors,
    warnings,
  };
}
