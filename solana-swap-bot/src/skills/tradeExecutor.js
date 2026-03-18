// src/skills/tradeExecutor.js — Execute swaps via Jupiter (or paper-trade)
import { config } from '../config.js';
import { createLogger } from '../logger.js';
import { fetchWithTimeout } from '../http.js';

const log = createLogger('tradeExecutor');
import { getPublicKey, signAndSend } from '../wallet.js';

/**
 * Execute a token swap through Jupiter.
 * @param {object} params
 * @param {string} params.inputMint
 * @param {string} params.outputMint
 * @param {number} params.amount      — in smallest unit (lamports / token base units)
 * @param {number} [params.slippageBps=50]
 * @returns {object} — { success, signature?, paper_trade?, error?, … }
 */
export async function executeSwap({ inputMint, outputMint, amount, slippageBps = 50, dex = '', minOutAmount = 0, limitTimeoutMs = 0 }) {
  // Validate amount before hitting Jupiter
  if (!amount || !Number.isFinite(amount) || amount <= 0) {
    log.error(`Invalid swap amount: ${amount}`);
    return { success: false, error: `Invalid amount: ${amount}` };
  }

  const headers = { 'x-api-key': config.jupiterApiKey, 'Content-Type': 'application/json' };
  const pubkey = getPublicKey();

  // Step 1: Quote
  const quoteParams = new URLSearchParams({
    inputMint,
    outputMint,
    amount: String(amount),
    slippageBps: String(slippageBps),
  });
  // Restrict routing to a specific DEX when specified (e.g. for arbitrage legs)
  if (dex) {
    quoteParams.set('dexes', dex);
    log.info(`Routing via DEX: ${dex}`);
  }
  const quoteResp = await fetchWithTimeout(`${config.jupiterQuoteApi}?${quoteParams}`, {
    headers,
    timeoutMs: config.httpTimeoutMs,
  });
  let quote = await quoteResp.json();

  if (quote.error) {
    log.error(`Quote error: ${quote.error}`);
    return { success: false, error: quote.error };
  }

  // Limit price check — poll until quote meets minimum output or timeout
  if (minOutAmount > 0 && limitTimeoutMs > 0) {
    const deadline = Date.now() + limitTimeoutMs;
    const retryMs = config.arb?.limitRetryMs || 15000;

    while (parseInt(quote.outAmount || '0', 10) < minOutAmount) {
      if (Date.now() >= deadline) {
        const got = parseInt(quote.outAmount || '0', 10);
        log.warn(`Limit timeout: needed ≥${minOutAmount}, best quote ${got} after ${limitTimeoutMs}ms`);
        return { success: false, error: 'limit_timeout', lastOutAmount: got, minOutAmount };
      }
      const got = parseInt(quote.outAmount || '0', 10);
      log.info(`Limit check: outAmount=${got}, need ≥${minOutAmount} — retry in ${retryMs}ms`);
      await new Promise(r => setTimeout(r, retryMs));

      // Re-quote
      const retryResp = await fetchWithTimeout(`${config.jupiterQuoteApi}?${quoteParams}`, {
        headers,
        timeoutMs: config.httpTimeoutMs,
      });
      const retryQuote = await retryResp.json();
      if (!retryQuote.error && retryQuote.outAmount) {
        quote = retryQuote;
      }
    }
    log.info(`Limit check passed: outAmount=${quote.outAmount} ≥ ${minOutAmount}`);
  }

  // Paper trade — simulate
  if (config.paperTrade()) {
    log.info(`[PAPER] Swap ${amount} ${inputMint} → ${outputMint} | out=${quote.outAmount}`);
    return {
      success: true,
      paperTrade: true,
      signature: 'PAPER_TRADE_SIM',
      inputAmount: amount,
      outputAmount: quote.outAmount,
      priceImpactPct: quote.priceImpactPct,
    };
  }

  // Step 2: Swap transaction
  const swapResp = await fetchWithTimeout(config.jupiterSwapApi, {
    method: 'POST',
    headers,
    timeoutMs: config.httpTimeoutMs,
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: pubkey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 'auto',
    }),
  });
  const swapData = await swapResp.json();

  if (!swapData.swapTransaction) {
    log.error('No swap transaction returned');
    return { success: false, error: 'No swap transaction returned' };
  }

  // Step 3: Sign and send
  try {
    const sig = await signAndSend(swapData.swapTransaction);
    log.info(`Swap executed: ${sig}`);
    return {
      success: true,
      paperTrade: false,
      signature: sig,
      inputAmount: amount,
      outputAmount: quote.outAmount,
      priceImpactPct: quote.priceImpactPct,
    };
  } catch (err) {
    log.error(`TX send error: ${err.message}`);
    return { success: false, error: err.message };
  }
}
