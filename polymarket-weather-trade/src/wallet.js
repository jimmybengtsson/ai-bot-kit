// src/wallet.js — Polygon wallet management using ethers v5 + Polymarket CLOB client
import { Wallet } from 'ethers';
import { ClobClient } from '@polymarket/clob-client';
import axios from 'axios';
import { config } from './config.js';
import { createLogger, logDetailedError } from './logger.js';

const log = createLogger('wallet');

let _signer = null;
let _clobClient = null;
let _apiCreds = null;
let _interceptorsInstalled = false;

// ─── Axios Interceptors — log only Polymarket HTTP errors ────────────────────

function installAxiosInterceptors() {
  if (_interceptorsInstalled) return;
  _interceptorsInstalled = true;

  // Request interceptor — only log errors
  axios.interceptors.request.use((req) => req, (err) => {
    logDetailedError(log, 'HTTP request error', err);
    return Promise.reject(err);
  });

  // Response interceptor — only log errors
  axios.interceptors.response.use((res) => res, (err) => {
    if (err.config?.url && err.config.url.includes('polymarket')) {
        const status = err?.response?.status;
        const data = err?.response?.data;
        const method = (err?.config?.method || 'GET').toUpperCase();
        const url = err?.config?.url || '';
        const isNoOrderbook404 = status === 404
          && String(url).includes('/price')
          && String(data?.error || data?.message || '').toLowerCase().includes('no orderbook exists');

        if (isNoOrderbook404) {
          log.debug(`[POLYMARKET HTTP] ${method} ${url} -> 404 no orderbook`);
        } else {
          log.error(`[POLYMARKET HTTP] ${method} ${url} -> ${status || 'NO_STATUS'} ${JSON.stringify(data || {})}`);
        }
    }
    return Promise.reject(err);
  });

  log.debug('Axios HTTP interceptors installed — logging Polymarket API errors only');
}

// ─── Signer ─────────────────────────────────────────────────────────────────

/**
 * Get ethers Wallet signer from the private key.
 */
export function getSigner() {
  if (!_signer) {
    if (!config.polygonPrivateKey) {
      throw new Error('POLYGON_PRIVATE_KEY not set in .env');
    }
    const pk = config.polygonPrivateKey.startsWith('0x')
      ? config.polygonPrivateKey
      : `0x${config.polygonPrivateKey}`;
    _signer = new Wallet(pk);
    log.info(`Wallet loaded: ${_signer.address}`);
  }
  return _signer;
}

/**
 * Get the wallet address.
 */
export function getAddress() {
  return getSigner().address;
}

// ─── CLOB Client ────────────────────────────────────────────────────────────

/**
 * Get API credentials (from .env or derive new ones).
 */
export async function getApiCreds() {
  if (_apiCreds) return _apiCreds;

  // If credentials are in .env, use them
  if (config.polyApiKey && config.polyApiSecret && config.polyPassphrase) {
    _apiCreds = {
      key: config.polyApiKey,
      secret: config.polyApiSecret,
      passphrase: config.polyPassphrase,
    };
    log.info('Using API credentials from .env');
    return _apiCreds;
  }

  // Otherwise, derive them from the private key
  log.info('Deriving Polymarket API credentials from private key...');
  const tempClient = new ClobClient(config.clobHost, config.chainId, getSigner());
  _apiCreds = await tempClient.createOrDeriveApiKey();
  log.info(`API credentials derived — apiKey: ${_apiCreds.key || _apiCreds.apiKey}`);

  // Normalize key names (SDK sometimes returns apiKey vs key)
  if (_apiCreds.apiKey && !_apiCreds.key) {
    _apiCreds.key = _apiCreds.apiKey;
  }

  return _apiCreds;
}

/**
 * Get initialized ClobClient with L2 authentication.
 */
export async function getClobClient() {
  if (_clobClient) return _clobClient;

  // Install interceptors before any requests go out
  installAxiosInterceptors();

  const signer = getSigner();
  const creds = await getApiCreds();

  log.debug(`Initializing CLOB client: host=${config.clobHost}, chainId=${config.chainId}, sigType=${config.signatureType}`);
  log.debug(`Wallet address: ${signer.address}`);
  log.debug(`Funder address: ${config.funderAddress || signer.address}`);
  log.debug(`API key present: ${!!creds?.key}, secret present: ${!!creds?.secret}, passphrase present: ${!!creds?.passphrase}`);

  _clobClient = new ClobClient(
    config.clobHost,
    config.chainId,
    signer,
    creds,
    config.signatureType,
    config.funderAddress || signer.address,
  );

  log.info('CLOB client initialized with L2 auth');
  return _clobClient;
}

/**
 * Ensure exchange contract allowances are set.
 * Must be called once before trading so the exchange can spend USDC.e.
 * Only updates COLLATERAL — CONDITIONAL requires a specific token_id.
 * Cached: only runs once per process lifetime since allowances persist on-chain.
 */
let _allowancesSet = false;
export async function ensureAllowances() {
  if (_allowancesSet) return;
  try {
    const client = await getClobClient();
    log.info('Calling updateBalanceAllowance to refresh/set exchange allowances (one-time)...');
    await client.updateBalanceAllowance({ asset_type: 'COLLATERAL' });
    log.info('updateBalanceAllowance(COLLATERAL) completed');
    _allowancesSet = true;
  } catch (err) {
    log.warn(`updateBalanceAllowance failed (may be okay if already set): ${err.message}`);
    // Mark as set anyway — if allowances are already on-chain, the error is harmless
    _allowancesSet = true;
  }
}

/**
 * Get USDC balance on Polymarket.
 * Uses the CLOB client's getBalanceAllowance for COLLATERAL.
 */
export async function getBalance() {
  try {
    const client = await getClobClient();
    log.debug('Fetching balance from Polymarket CLOB API...');

    const result = await client.getBalanceAllowance({ asset_type: 'COLLATERAL' });
    log.debug(`Raw balance API response: ${JSON.stringify(result)}`);
    // CLOB returns balance in raw atomic units (6 decimals for USDC.e)
    const rawBalance = parseFloat(result?.balance ?? '0');
    const balance = rawBalance / 1e6;
    log.debug(`Parsed Polymarket balance: $${balance.toFixed(6)} (raw: ${rawBalance})`);
    return balance;
  } catch (err) {
    logDetailedError(log, 'Failed to get balance via SDK', err);

    // Fallback: try direct REST call to understand the issue
    try {
      log.info('Attempting direct REST balance check...');
      const signer = getSigner();
      const address = signer.address;
      log.info(`Wallet address: ${address}`);

      // Try the data-api for positions/collateral as a diagnostic
      const url = `${config.clobHost}/balance-allowance?asset_type=COLLATERAL&signature_type=${config.signatureType}`;
      log.info(`Direct URL: ${url}`);
    } catch (innerErr) {
      logDetailedError(log, 'Fallback balance check also failed', innerErr);
    }
    return 0;
  }
}

/**
 * Check if ClobClient is healthy / reachable.
 */
export async function checkClobHealth() {
  try {
    const client = new ClobClient(config.clobHost, config.chainId);
    const ok = await client.getOk();
    return !!ok;
  } catch {
    return false;
  }
}
