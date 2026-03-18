// src/wallet.js — Solana wallet management using @solana/web3.js v1
import { readFileSync } from 'fs';
import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import { config } from './config.js';
import { createLogger } from './logger.js';

const log = createLogger('wallet');

let _keypair = null;
let _connection = null;

/** Load keypair from the JSON wallet file (same format as Solana CLI). */
export function getKeypair() {
  if (!_keypair) {
    const secret = JSON.parse(readFileSync(config.walletPath, 'utf-8'));
    _keypair = Keypair.fromSecretKey(Uint8Array.from(secret));
    log.info(`Wallet loaded: ${_keypair.publicKey.toBase58()}`);
  }
  return _keypair;
}

/** Get public key string. */
export function getPublicKey() {
  return getKeypair().publicKey.toBase58();
}

/** Shared RPC connection. */
export function getConnection() {
  if (!_connection) {
    _connection = new Connection(config.solanaRpcUrl, 'confirmed');
  }
  return _connection;
}

/** Get SOL balance in SOL (not lamports). */
export async function getSolBalance() {
  const conn = getConnection();
  const lamports = await conn.getBalance(getKeypair().publicKey);
  return lamports / 1e9;
}

/** Sign and send a base64-encoded versioned transaction. Returns signature string. */
export async function signAndSend(base64Tx) {
  const conn = getConnection();
  const kp = getKeypair();
  const txBuf = Buffer.from(base64Tx, 'base64');
  const tx = VersionedTransaction.deserialize(txBuf);
  tx.sign([kp]);
  const sig = await conn.sendRawTransaction(tx.serialize(), {
    skipPreflight: true,
    maxRetries: 3,
  });
  log.info(`TX sent: ${sig}`);
  return sig;
}

/**
 * Poll for on-chain transaction confirmation.
 * @param {string} signature — transaction signature to monitor
 * @param {number} [timeoutMs=180000] — max wait time (default 3 min)
 * @param {number} [pollMs=5000]      — poll interval (default 5s)
 * @returns {{ confirmed: boolean, status?: string, err?: any }}
 */
export async function confirmTransaction(signature, timeoutMs = 180000, pollMs = 5000) {
  const conn = getConnection();
  const deadline = Date.now() + timeoutMs;
  log.info(`Awaiting confirmation for ${signature} (timeout ${timeoutMs / 1000}s, poll ${pollMs / 1000}s)`);

  while (Date.now() < deadline) {
    try {
      const resp = await conn.getSignatureStatus(signature, { searchTransactionHistory: false });
      const status = resp?.value;
      if (status) {
        if (status.err) {
          log.warn(`TX ${signature} failed on-chain: ${JSON.stringify(status.err)}`);
          return { confirmed: false, status: 'failed', err: status.err };
        }
        if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
          log.info(`TX ${signature} confirmed (${status.confirmationStatus})`);
          return { confirmed: true, status: status.confirmationStatus };
        }
        log.info(`TX ${signature} status: ${status.confirmationStatus || 'processing'} — waiting...`);
      } else {
        log.info(`TX ${signature} not found yet — waiting...`);
      }
    } catch (err) {
      log.warn(`Error checking TX status: ${err.message}`);
    }
    await new Promise(r => setTimeout(r, pollMs));
  }

  log.warn(`TX ${signature} confirmation timed out after ${timeoutMs / 1000}s`);
  return { confirmed: false, status: 'timeout' };
}
