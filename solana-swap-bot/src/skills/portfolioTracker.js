// src/skills/portfolioTracker.js — Wallet balance & portfolio valuation
import { config, getStrategyHardMaxSol } from '../config.js';
import { createLogger } from '../logger.js';
import { fetchWithTimeout } from '../http.js';

const log = createLogger('portfolio');
import { getPublicKey, getSolBalance } from '../wallet.js';

/**
 * Get full wallet balances with USD valuations.
 * @returns {object} — { solBalance, solPriceUsd, solValueUsd, tokens, totalValueUsd }
 */
export async function getWalletBalances() {
  const pubkey = getPublicKey();
  const headers = { 'x-api-key': config.jupiterApiKey };

  // SOL balance
  const solBalance = await getSolBalance();

  // Token balances via Helius
  const heliusUrl = `https://api.helius.xyz/v0/addresses/${pubkey}/balances?api-key=${config.heliusApiKey}`;
  const heliusResp = await fetchWithTimeout(heliusUrl, { timeoutMs: config.httpTimeoutMs });
  const heliusData = await heliusResp.json();

  const tokens = {};
  for (const t of (heliusData.tokens || [])) {
    const amount = (t.amount || 0) / (10 ** (t.decimals || 0));
    if (amount > 0) {
      tokens[t.mint] = { amount, decimals: t.decimals };
    }
  }

  // Ensure all watchedTokens have entries (even if not held) so AI sees the full universe
  const solMint = config.watchedTokens.SOL;
  for (const [sym, mint] of Object.entries(config.watchedTokens)) {
    if (mint === solMint) continue; // SOL handled separately
    if (!tokens[mint]) {
      tokens[mint] = { amount: 0, decimals: config.tokenDecimals[mint] || 6 };
    }
  }

  // Price all watched tokens via Jupiter (single batch request)
  let totalUsd = 0;
  const allMints = Object.keys(tokens);
  if (allMints.length) {
    const mintsCsv = allMints.join(',');
    const priceResp = await fetchWithTimeout(`${config.jupiterPriceApi}?ids=${mintsCsv}`, {
      headers,
      timeoutMs: config.httpTimeoutMs,
    });
    const prices = await priceResp.json();

    for (const [mint, info] of Object.entries(tokens)) {
      const price = prices[mint]?.usdPrice || 0;
      info.priceUsd = price;
      info.valueUsd = price * info.amount;
      totalUsd += info.valueUsd;
    }
  }

  // SOL price
  const solPriceResp = await fetchWithTimeout(`${config.jupiterPriceApi}?ids=${solMint}`, {
    headers,
    timeoutMs: config.httpTimeoutMs,
  });
  const solPriceData = await solPriceResp.json();
  const solPrice = solPriceData[solMint]?.usdPrice || 0;
  const solValue = solBalance * solPrice;
  totalUsd += solValue;

  const result = {
    solBalance,
    solPriceUsd: solPrice,
    solValueUsd: Math.round(solValue * 100) / 100,
    tokens,
    totalValueUsd: Math.round(totalUsd * 100) / 100,
    totalValueSol: solPrice > 0 ? Math.round((totalUsd / solPrice) * 10000) / 10000 : 0,
    degenBudget: Math.round(totalUsd * config.risk.degenShare * 100) / 100,
    guardianBudget: Math.round(totalUsd * config.risk.guardianShare * 100) / 100,
    degenMaxPerTrade: Math.round(getStrategyHardMaxSol(solPrice > 0 ? (totalUsd / solPrice) : 0, 'degen') * solPrice * 100) / 100,
    guardianMaxPerTrade: Math.round(getStrategyHardMaxSol(solPrice > 0 ? (totalUsd / solPrice) : 0, 'guardian') * solPrice * 100) / 100,
  };

  log.info(`Portfolio: $${result.totalValueUsd} (${result.totalValueSol} SOL) | SOL: ${solBalance} ($${result.solValueUsd})`);
  return result;
}
