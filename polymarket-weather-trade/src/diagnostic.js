// Diagnostic: test balance retrieval from Polymarket CLOB API
// Checks CLOB balance + on-chain USDC.e balance for both EOA and FUNDER
import 'dotenv/config';
import { Wallet, ethers } from 'ethers';
import { ClobClient } from '@polymarket/clob-client';
import axios from 'axios';

const CLOB_HOST = 'https://clob.polymarket.com';
const CHAIN_ID = 137;
// Multiple RPC endpoints for reliability
const POLYGON_RPCS = [
  'https://polygon-bor-rpc.publicnode.com',
  'https://polygon-rpc.com',
  'https://rpc.ankr.com/polygon',
];
// USDC.e (bridged USDC) on Polygon — this is what Polymarket uses as collateral
const USDC_E_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
// Native USDC on Polygon (Circle)
const USDC_NATIVE_ADDRESS = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
const ERC20_ABI = ['function balanceOf(address) view returns (uint256)'];

async function getProvider() {
  for (const rpc of POLYGON_RPCS) {
    try {
      const p = new ethers.providers.JsonRpcProvider(rpc);
      await p.getBlockNumber(); // quick connectivity test
      console.log(`Using RPC: ${rpc}`);
      return p;
    } catch {
      console.log(`  RPC ${rpc} failed, trying next...`);
    }
  }
  console.log('  ⚠️  All Polygon RPCs failed — skipping on-chain checks');
  return null;
}

async function checkOnChainBalance(provider, tokenAddress, tokenName, walletAddress, label) {
  try {
    const contract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
    const raw = await contract.balanceOf(walletAddress);
    const human = ethers.utils.formatUnits(raw, 6);
    console.log(`  ${label} ${tokenName}: $${human} (raw: ${raw.toString()})`);
    return parseFloat(human);
  } catch (e) {
    console.log(`  ${label} ${tokenName}: ❌ ${e.message}`);
    return 0;
  }
}

async function main() {
  console.log('=== polymarket-weather-trade Balance Diagnostic ===\n');

  // 1. Check env vars
  const pk = process.env.POLYGON_PRIVATE_KEY;
  const sigType = parseInt(process.env.SIGNATURE_TYPE || '2', 10);
  const funder = process.env.FUNDER_ADDRESS;
  const apiKey = process.env.POLY_API_KEY;
  const apiSecret = process.env.POLY_API_SECRET;
  const passphrase = process.env.POLY_PASSPHRASE;

  console.log('Environment:');
  console.log(`  POLYGON_PRIVATE_KEY: ${pk ? `set (${pk.length} chars)` : '❌ NOT SET'}`);
  console.log(`  SIGNATURE_TYPE: ${sigType} (${sigType === 0 ? 'EOA/standalone' : sigType === 1 ? 'POLY_PROXY (Magic Link)' : sigType === 2 ? 'GNOSIS_SAFE (MetaMask/browser)' : 'UNKNOWN'})`);
  console.log(`  FUNDER_ADDRESS: ${funder || '❌ NOT SET'}`);
  console.log(`  POLY_API_KEY: ${apiKey ? `set (${apiKey.length} chars)` : '❌ NOT SET'}`);
  console.log(`  POLY_API_SECRET: ${apiSecret ? 'set' : '❌ NOT SET'}`);
  console.log(`  POLY_PASSPHRASE: ${passphrase ? 'set' : '❌ NOT SET'}`);
  console.log('');

  if (!pk) {
    console.log('❌ POLYGON_PRIVATE_KEY is required.');
    process.exit(1);
  }

  // 2. Create signer
  const pkHex = pk.startsWith('0x') ? pk : `0x${pk}`;
  const signer = new Wallet(pkHex);
  const eoaAddr = signer.address;
  const funderAddr = funder || eoaAddr;
  const funderIsDifferent = funder && funder.toLowerCase() !== eoaAddr.toLowerCase();

  console.log(`EOA address (from private key): ${eoaAddr}`);
  console.log(`FUNDER_ADDRESS (from .env):     ${funderAddr}`);
  if (funderIsDifferent) {
    console.log(`  ⚠️  EOA ≠ FUNDER — these are different addresses!`);
  }
  console.log('');

  // ─── Step 1: On-chain balances ────────────────────────────────────────────
  console.log('─── Step 1: On-chain token balances (Polygon mainnet) ───');
  const provider = await getProvider();

  if (provider) {
    console.log(`\nEOA (${eoaAddr}):`);
    const eoaUsdce = await checkOnChainBalance(provider, USDC_E_ADDRESS, 'USDC.e', eoaAddr, ' ');
    const eoaUsdc = await checkOnChainBalance(provider, USDC_NATIVE_ADDRESS, 'USDC (native)', eoaAddr, ' ');
    try {
      const maticBal = await provider.getBalance(eoaAddr);
      console.log(`  POL/MATIC: ${ethers.utils.formatEther(maticBal)}`);
    } catch (e) {
      console.log(`  POL/MATIC: ❌ ${e.message}`);
    }
    console.log('');

    if (funderIsDifferent) {
      console.log(`FUNDER/Proxy (${funderAddr}):`);
      const funderUsdce = await checkOnChainBalance(provider, USDC_E_ADDRESS, 'USDC.e', funderAddr, ' ');
      const funderUsdc = await checkOnChainBalance(provider, USDC_NATIVE_ADDRESS, 'USDC (native)', funderAddr, ' ');
      console.log('');

      if (funderUsdce > 0 || funderUsdc > 0) {
        console.log('  ℹ️  Proxy has on-chain tokens — but Polymarket exchange balance is separate.');
      }
      if (funderUsdce === 0 && funderUsdc === 0 && eoaUsdce === 0 && eoaUsdc === 0) {
        console.log('  ✅ Both addresses show $0 on-chain — funds are likely deposited into');
        console.log('     Polymarket\'s exchange contracts (correct for CLOB trading).');
      }
    }
  } else {
    console.log('  Skipping on-chain checks (no working RPC).');
  }
  console.log('');

  // ─── Step 2: CLOB Health ──────────────────────────────────────────────────
  console.log('─── Step 2: CLOB Health ───');
  const basicClient = new ClobClient(CLOB_HOST, CHAIN_ID);
  try {
    const ok = await basicClient.getOk();
    console.log(`CLOB health: ${ok}\n`);
  } catch (e) {
    console.log(`CLOB health check failed: ${e.message}\n`);
  }

  // ─── Step 3: Get/use API creds ────────────────────────────────────────────
  let creds;
  let credsSource = '';
  if (apiKey && apiSecret && passphrase) {
    creds = { key: apiKey, secret: apiSecret, passphrase };
    credsSource = '.env';
    console.log('Using API credentials from .env');
  } else {
    console.log('No API creds in .env, deriving from private key...');
    try {
      const tempClient = new ClobClient(CLOB_HOST, CHAIN_ID, signer);
      creds = await tempClient.createOrDeriveApiKey();
      console.log(`Derived API key: ${creds.key || creds.apiKey}`);
      if (creds.apiKey && !creds.key) creds.key = creds.apiKey;
      credsSource = 'derived';
    } catch (e) {
      console.log(`❌ Failed to derive API key: ${e.message}`);
      process.exit(1);
    }
  }
  console.log('');

  // ─── Step 4: CLOB balance check ──────────────────────────────────────────
  console.log('─── Step 3: Update balance/allowances + check CLOB balance ───');
  let client = new ClobClient(
    CLOB_HOST, CHAIN_ID, signer, creds,
    sigType, funderAddr,
  );

  // Call updateBalanceAllowance first to ensure exchange approvals are set
  let clobBalance = 0;
  let authFailed = false;
  try {
    console.log('Calling updateBalanceAllowance(COLLATERAL) to set exchange approvals...');
    await client.updateBalanceAllowance({ asset_type: 'COLLATERAL' });
    console.log('  ✅ updateBalanceAllowance(COLLATERAL) succeeded');
  } catch (e) {
    const msg = e.message || '';
    if (msg.includes('401') || msg.includes('Unauthorized') || msg.includes('Invalid api key')) {
      authFailed = true;
      console.log(`  ❌ AUTH FAILED with ${credsSource} credentials: 401 Unauthorized`);
    } else {
      console.log(`  ⚠️  updateBalanceAllowance failed: ${msg}`);
      console.log('  (This is sometimes expected — continuing to check balance...)');
    }
  }
  console.log('');

  // Now check the balance
  if (!authFailed) {
    try {
      const result = await client.getBalanceAllowance({ asset_type: 'COLLATERAL' });
      if (result?.error || result?.status === 401) {
        throw new Error(`API returned: ${JSON.stringify(result)}`);
      }
      // CLOB returns balance in raw atomic units (6 decimals for USDC.e)
      const rawBalance = parseFloat(result?.balance ?? '0');
      clobBalance = rawBalance / 1e6;
      console.log(`CLOB balance (raw): ${rawBalance}`);
      console.log(`CLOB balance: $${clobBalance.toFixed(6)}`);
      console.log(`Allowances: ${JSON.stringify(result?.allowances || {})}`);
    } catch (e) {
      const msg = e.message || '';
      if (msg.includes('401') || msg.includes('Unauthorized') || msg.includes('Invalid api key')) {
        authFailed = true;
        console.log(`❌ AUTH FAILED with ${credsSource} credentials: 401 Unauthorized`);
      } else {
        console.log(`❌ getBalanceAllowance failed: ${msg}`);
      }
    }
  }
  console.log('');

  // ─── Step 4b: If .env creds failed, try freshly derived creds ─────────────
  if (authFailed && credsSource === '.env') {
    console.log('─── Step 3b: .env creds are INVALID — deriving fresh credentials ───');
    try {
      const tempClient = new ClobClient(CLOB_HOST, CHAIN_ID, signer);
      const freshCreds = await tempClient.createOrDeriveApiKey();
      if (freshCreds.apiKey && !freshCreds.key) freshCreds.key = freshCreds.apiKey;
      const freshKey = freshCreds.key || freshCreds.apiKey;

      console.log(`Freshly derived API key: ${freshKey}`);
      console.log(`  .env API key was:      ${apiKey}`);
      if (freshKey !== apiKey) {
        console.log('  🔴 KEYS DO NOT MATCH — your .env has wrong/stale API credentials!');
      } else {
        console.log('  Keys match but auth still fails — secret or passphrase may be wrong.');
      }
      console.log('');

      // Try balance with fresh creds
      const freshClient = new ClobClient(
        CLOB_HOST, CHAIN_ID, signer, freshCreds,
        sigType, funderAddr,
      );
      try {
        const result2 = await freshClient.getBalanceAllowance({ asset_type: 'COLLATERAL' });
        if (result2?.error || result2?.status === 401) {
          throw new Error(`API returned: ${JSON.stringify(result2)}`);
        }
        const rawBalance2 = parseFloat(result2?.balance ?? '0');
        clobBalance = rawBalance2 / 1e6;
        console.log(`✅ Fresh creds WORK! CLOB balance: $${clobBalance.toFixed(6)}`);
        console.log(`Allowances: ${JSON.stringify(result2?.allowances || {})}`);
        console.log('');
        console.log('Update your .env with these credentials:');
        console.log('─────────────────────────────────────────');
        console.log(`POLY_API_KEY=${freshKey}`);
        console.log(`POLY_API_SECRET=${freshCreds.secret}`);
        console.log(`POLY_PASSPHRASE=${freshCreds.passphrase}`);
        console.log('─────────────────────────────────────────');

        // Use fresh client for remaining checks
        client = freshClient;
        creds = freshCreds;
        authFailed = false;
      } catch (e2) {
        console.log(`❌ Fresh creds also failed: ${e2.message}`);
        console.log('  The wallet may not have API access configured on Polymarket.');
      }
    } catch (e) {
      console.log(`❌ Could not derive fresh creds: ${e.message}`);
    }
    console.log('');
  }

  // ─── Step 5: Check API keys to confirm which wallet they belong to ────────
  if (!authFailed) {
    console.log('─── Step 4: Verify API keys belong to this wallet ───');
    try {
      const keys = await client.getApiKeys();
      console.log(`API keys response: ${JSON.stringify(keys)}`);
    } catch (e) {
      console.log(`getApiKeys failed: ${e.message}`);
    }
    console.log('');
  }

  // ─── Step 6: Check open orders + positions ─────────────────────────────
  if (!authFailed) {
    console.log('─── Step 5: Check open orders via CLOB API ───');
    try {
      const openOrders = await client.getOpenOrders();
      if (Array.isArray(openOrders) && openOrders.length > 0) {
        console.log(`  Found ${openOrders.length} open order(s)!`);
        for (const o of openOrders.slice(0, 5)) {
          console.log(`  - ${o.asset_id?.slice(0, 12)}... side=${o.side} price=${o.price} size=${o.original_size}`);
        }
      } else {
        console.log('  No open orders found.');
      }
    } catch (e) {
      console.log(`  getOpenOrders failed: ${e.message}`);
    }
    console.log('');
  }

  // ─── Step 6: Check open positions ─────────────────────────────────────────
  console.log('─── Step 6: Check open positions on Polymarket ───');
  try {
    // Data API uses ?user= parameter (not ?address=)
    const posUrl = `https://data-api.polymarket.com/positions?user=${funderAddr}`;
    console.log(`GET ${posUrl}`);
    const posResp = await axios.get(posUrl, { timeout: 10000 });
    const positions = posResp.data;
    if (Array.isArray(positions) && positions.length > 0) {
      console.log(`  Found ${positions.length} position(s)!`);
      for (const pos of positions.slice(0, 5)) {
        console.log(`  - ${pos.title || pos.market_slug || 'unknown'}: size=${pos.size}, avgPrice=${pos.avg_price}`);
      }
    } else {
      console.log('  No open positions found.');
    }
  } catch (e) {
    console.log(`  Positions check failed: ${e.response?.status || ''} ${e.message}`);
  }
  console.log('');

  // ─── Final Diagnosis ──────────────────────────────────────────────────────
  console.log('═══════════════════════════════════════════');
  console.log('  DIAGNOSIS');
  console.log('═══════════════════════════════════════════');
  console.log('');
  console.log(`EOA (MetaMask):          ${eoaAddr}`);
  console.log(`Proxy (Polymarket):      ${funderAddr}`);
  console.log(`SIGNATURE_TYPE:          ${sigType}${sigType === 2 ? ' (GNOSIS_SAFE ✅)' : sigType === 1 ? ' (POLY_PROXY — only for Magic Link!)' : ' (EOA)'}`);
  console.log(`CLOB balance:            $${clobBalance.toFixed(6)}`);
  console.log(`Auth status:             ${authFailed ? '❌ FAILED (401)' : '✅ OK'}`);
  console.log('');

  if (authFailed) {
    console.log('🔴 API CREDENTIALS ARE INVALID');
    console.log('   The API key/secret/passphrase in .env are rejected by Polymarket.');
    console.log('');
    console.log('   FIX: Clear the API creds from .env (remove or blank out');
    console.log('   POLY_API_KEY, POLY_API_SECRET, POLY_PASSPHRASE) and re-run:');
    console.log('     node src/diagnostic.js');
    console.log('   This will derive fresh credentials and show them for you to save.');
    console.log('');
    console.log('   Or run: node src/setup.js --reset');
  } else if (clobBalance > 0) {
    console.log('✅ Balance found! Everything is working correctly.');
    console.log('   Your bot should now be able to trade.');
  } else {
    console.log('⚠️  Auth works but CLOB balance is $0.');
    console.log('');
    if (sigType === 1) {
      console.log('🔴 SIGNATURE_TYPE=1 (POLY_PROXY) is for Magic Link/email/Google users ONLY.');
      console.log('   If you use MetaMask (browser wallet), change to SIGNATURE_TYPE=2 in .env');
      console.log('   and re-run this diagnostic.');
    } else {
      console.log('Possible causes:');
      console.log('  A. USDC.e is on-chain in your proxy but not yet recognized by CLOB.');
      console.log('     The updateBalanceAllowance call above should fix this.');
      console.log('     If allowances are still "0", try placing a small trade on polymarket.com');
      console.log('     to trigger the approval flow, then re-run this diagnostic.');
      console.log('');
      console.log('  B. FUNDER_ADDRESS is wrong.');
      console.log('     Check polymarket.com → Profile for the correct proxy address.');
      console.log('');
      console.log('  C. Funds haven\'t been deposited on polymarket.com yet.');
      console.log('     Go to polymarket.com → Deposit to move funds into Polymarket.');
    }
  }
  console.log('\n=== Done ===');
}

main().catch(console.error);
