// src/setup.js — Setup utility: derive Polymarket API credentials
// Usage:
//   node src/setup.js          — derive/create API key
//   node src/setup.js --reset  — delete current key, then create a fresh one
import 'dotenv/config';
import { Wallet } from 'ethers';
import { ClobClient } from '@polymarket/clob-client';

const HOST = 'https://clob.polymarket.com';
const CHAIN_ID = 137;
const doReset = process.argv.includes('--reset');

async function main() {
  console.log('═══════════════════════════════════════════');
  console.log('  polymarket-weather-trade — Polymarket API Key Setup');
  console.log('═══════════════════════════════════════════');
  console.log();

  const pk = process.env.POLYGON_PRIVATE_KEY;
  if (!pk) {
    console.error('ERROR: POLYGON_PRIVATE_KEY not set in .env');
    console.error('Create a .env file from .env.example and set your private key.');
    process.exit(1);
  }

  const sigType = parseInt(process.env.SIGNATURE_TYPE || '1', 10);
  const funder = process.env.FUNDER_ADDRESS;
  const key = pk.startsWith('0x') ? pk : `0x${pk}`;
  const signer = new Wallet(key);

  console.log(`EOA address (from private key): ${signer.address}`);
  console.log(`FUNDER_ADDRESS: ${funder || '(not set)'}`);
  console.log(`SIGNATURE_TYPE: ${sigType}`);
  console.log();

  // ─── Step 0: Reset (delete old key) if --reset flag ─────────────────────
  if (doReset) {
    const existingKey = process.env.POLY_API_KEY;
    const existingSecret = process.env.POLY_API_SECRET;
    const existingPass = process.env.POLY_PASSPHRASE;

    if (existingKey && existingSecret && existingPass) {
      console.log('--reset: Deleting existing API key...');
      try {
        const oldClient = new ClobClient(
          HOST, CHAIN_ID, signer,
          { key: existingKey, secret: existingSecret, passphrase: existingPass },
          sigType, funder || signer.address,
        );
        await oldClient.deleteApiKey();
        console.log('  ✅ Old API key deleted.');
      } catch (e) {
        console.log(`  ⚠️  Could not delete old key: ${e.message}`);
        console.log('  (Continuing — will create/derive a new one anyway)');
      }
    } else {
      console.log('--reset: No existing credentials in .env to delete.');
    }
    console.log();
  }

  // ─── Step 1: Create or derive API key ───────────────────────────────────
  const client = new ClobClient(HOST, CHAIN_ID, signer);

  try {
    console.log('Step 1: Attempting to create a new API key...');
    let creds;
    let method = 'created';
    try {
      creds = await client.createApiKey();
      if (!creds?.key && !creds?.apiKey) {
        throw new Error('No key in create response');
      }
    } catch (createErr) {
      console.log(`  Create returned: ${createErr.message}`);
      console.log('  (Normal if a key already exists — deriving existing one)');
      console.log();
      console.log('Step 2: Deriving existing API key from wallet signature...');
      creds = await client.deriveApiKey();
      method = 'derived';
    }

    const apiKey = creds.apiKey || creds.key;
    if (!apiKey) {
      console.error('❌ No API key returned. Unexpected response:');
      console.error(JSON.stringify(creds, null, 2));
      process.exit(1);
    }

    console.log();
    console.log(`✅ API credentials ${method} successfully!`);
    console.log();
    console.log('Add these to your .env file:');
    console.log('─────────────────────────────────────────');
    console.log(`POLY_API_KEY=${apiKey}`);
    console.log(`POLY_API_SECRET=${creds.secret}`);
    console.log(`POLY_PASSPHRASE=${creds.passphrase}`);
    console.log('─────────────────────────────────────────');
    console.log();

    // Verify: do these match what's on the website?
    console.log('IMPORTANT: Compare the POLY_API_KEY above with what you see on');
    console.log('polymarket.com → Settings → API Keys. They MUST match.');
    console.log();
    console.log('If they DO NOT match:');
    console.log('  1. Copy the key/secret/passphrase from polymarket.com directly');
    console.log('     and paste them into your .env file manually.');
    console.log('  2. Or run: node src/setup.js --reset');
    console.log('     This deletes the old key and creates a fresh one.');
    console.log();
    console.log('⚠️  Keep these values secret!');
  } catch (err) {
    console.error(`\n❌ Failed to get API credentials: ${err.message}`);
    console.error('Possible causes:');
    console.error('  - No POL (gas) on your Polygon wallet');
    console.error('  - Invalid private key');
    console.error('  - Polymarket CLOB API is down');
    process.exit(1);
  }
}

main();
