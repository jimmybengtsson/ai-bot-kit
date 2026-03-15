import { Wallet } from 'ethers';
import { ClobClient } from '@polymarket/clob-client';
import axios from 'axios';
import { config } from './config.js';
import { createLogger } from './logger.js';

const log = createLogger('wallet');

let signer = null;
let clobClient = null;
let apiCreds = null;
let interceptorsInstalled = false;
let allowancesSet = false;

function installAxiosInterceptors() {
  if (interceptorsInstalled) return;
  interceptorsInstalled = true;

  axios.interceptors.request.use((req) => req, (err) => Promise.reject(err));
  axios.interceptors.response.use((res) => res, (err) => {
    if (err.config?.url && err.config.url.includes('polymarket')) {
      log.error(`HTTP ${err.response?.status || '?'} ${err.config.method?.toUpperCase()} ${err.config.url}`);
    }
    return Promise.reject(err);
  });
}

export function getSigner() {
  if (signer) return signer;
  if (!config.polygonPrivateKey) throw new Error('POLYGON_PRIVATE_KEY not set');
  const pk = config.polygonPrivateKey.startsWith('0x') ? config.polygonPrivateKey : `0x${config.polygonPrivateKey}`;
  signer = new Wallet(pk);
  return signer;
}

export function getAddress() {
  return getSigner().address;
}

async function getApiCreds() {
  if (apiCreds) return apiCreds;

  if (config.polyApiKey && config.polyApiSecret && config.polyPassphrase) {
    apiCreds = { key: config.polyApiKey, secret: config.polyApiSecret, passphrase: config.polyPassphrase };
    return apiCreds;
  }

  const tempClient = new ClobClient(config.clobHost, config.chainId, getSigner());
  apiCreds = await tempClient.createOrDeriveApiKey();
  if (apiCreds.apiKey && !apiCreds.key) apiCreds.key = apiCreds.apiKey;
  return apiCreds;
}

export async function getClobClient() {
  if (clobClient) return clobClient;

  installAxiosInterceptors();
  const creds = await getApiCreds();
  const s = getSigner();

  clobClient = new ClobClient(
    config.clobHost,
    config.chainId,
    s,
    creds,
    config.signatureType,
    config.funderAddress || s.address,
  );
  return clobClient;
}

export async function ensureAllowances() {
  if (allowancesSet || config.paperTrade()) return;
  try {
    const client = await getClobClient();
    await client.updateBalanceAllowance({ asset_type: 'COLLATERAL' });
  } catch (err) {
    log.warn(`Allowance update warning: ${err.message}`);
  }
  allowancesSet = true;
}

export async function getBalance() {
  try {
    const client = await getClobClient();
    const result = await client.getBalanceAllowance({ asset_type: 'COLLATERAL' });
    const raw = parseFloat(result?.balance ?? '0');
    return raw / 1e6;
  } catch (err) {
    log.warn(`Balance fetch failed: ${err.message}`);
    return 0;
  }
}
