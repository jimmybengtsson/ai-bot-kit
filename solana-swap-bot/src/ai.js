// src/ai.js — OpenAI Responses API integration for trade reasoning
//
// Uses prompt caching (prompt_cache_key + instructions parameter) to cut
// input token costs by up to 90%.  Static instructions go into the top-level
// `instructions` field so they (+ schema) form the cached prefix.  Dynamic
// data goes into `input` as a plain string.
//
// Two AI channels, each with its own cache key:
//   trading      — analyzeAndDecide()
//   daily-report — generateDailyReport()

import OpenAI from 'openai';
import { config, getStrategyHardMaxSol } from './config.js';
import { createLogger } from './logger.js';
import {
  saveConversation,
  pruneConversation,
  setResponseIdForChannel,
  getResponseIdForChannel,
} from './runtimeStore.js';

const log = createLogger('ai');

const client = new OpenAI({ apiKey: config.openaiApiKey });

/* ═══════════════════════════════════════════════════════════════════
   Cache-key constants — one per channel so OpenAI routes each
   channel's requests to the same machine for prefix reuse.
   ═══════════════════════════════════════════════════════════════════ */
const CACHE_KEY_TRADING          = 'solana-swap-bot-trading-v1';
const CACHE_KEY_TRADING_ANALYSIS = 'solana-swap-bot-trading-analysis-v1';
const CACHE_KEY_VALIDATOR        = 'solana-swap-bot-validator-v1';
const CACHE_KEY_DAILY_REPORT     = 'solana-swap-bot-daily-report-v1';

const DEGEN_SHARE_PCT = Math.round(config.risk.degenShare * 100);
const GUARDIAN_SHARE_PCT = Math.round(config.risk.guardianShare * 100);
const DEGEN_ACTIVE = config.risk.degenEnabled;
const GUARDIAN_ACTIVE = config.risk.guardianEnabled;
const COMBINED_ACTIVE = DEGEN_ACTIVE && GUARDIAN_ACTIVE;

/* ═══════════════════════════════════════════════════════════════════
   Shared data-fields reference — included in Phase 1 analysis,
   Phase 2 decision, and validator instructions so every AI channel
   understands the compact field abbreviations.
   ═══════════════════════════════════════════════════════════════════ */
const DATA_FIELDS_GUIDE = `## Data Fields
- **W** = Wallet snapshot. Object with keys: t=totalSol (total portfolio in SOL-equivalent notional), s=solBalance (native SOL for fees), h=holdings (map of SYM→{sol=solValue, amt=tokenAmount, usd=usdValue} for each non-trivial position including USDC cash). If a token is NOT in h, you do NOT hold it and CANNOT sell it.
- **P** = Current prices in USD for all watched tokens, rounded to 4 significant figures.
- **Δ** = Multi-timeframe price changes. Object per token: {m5=5min%, m10=10min%, m30=30min%, h1=1hour%, h6=6hour%, h24=24hour%, flag?=trend alert}. m5/h1/h6/h24 from DexScreener; m10/m30 computed from our own price history snapshots. Zero values omitted. flag: DOWN=sustained downtrend (h1/h6/h24 all negative — avoid buying), BOUNCE=dead cat bounce suspect (m5 positive but h6/h24 negative — avoid). Flagged tokens should not be bought unless corroborated social signals (TW) justify overriding.
- **A** = 2-leg arbitrage opportunities. Array of objects: {p=pair, s=netSpread%, b=buyDex, x=sellDex}. These are PRE-VALIDATED with fees and slippage already deducted. If entries exist, they represent real profit opportunities.
- **TA** = 3-leg triangular arbitrage opportunities. Array: {path="A→B→C→A", s=netSpread%, l1={p=pair,d=dex}, l2={p,d}, l3={p,d}}. PRE-VALIDATED. Execute all 3 legs in one sequenceGroup.
- **TW** = Recent tweets from Twitter/X (last 2h). Array: {t=text, a=author, k=matchedKeywords}. Raw social signals — use to gauge community sentiment and breaking developments. Cross-reference with Δ trends. High volume of tweets about a token suggests something is happening. Do not trade solely on tweets — use as a confirming signal.
- **T** = Recent trade history (last 30). Standalone trades: {s=strategy (d=degen/g=guardian), ty=type, p=pair, sol=amountSol, pnl=pnlSol, dex=dex, r=reason (AI's original reasoning for this trade), ip=inputTokenPriceUsd, op=outputTokenPriceUsd}. Arb sequence trades are grouped: {seq=groupId, ty=type, s=strategy, legs:[{p=pair, sol, pnl, dex, r=reason, ip, op}, ...]}. Review to avoid repeating failed patterns, learn from your previous reasoning (r field), and check consecutive loss streaks.
- **F** = Failed sequences from prior ticks. Array: {ok=[completed legs], fail={l=leg#, p=pair, d=dex, e=error, cat=errorCategory, act=suggestedAction}, skip=[cancelled legs]}. cat values: slippage/liquidity/network/balance/limit/unknown. act values: retry_with_lower_size/avoid_dex/retry_next_tick/no_retry. Follow the suggestedAction: avoid_dex means don't use that dex+pair combo again; retry_next_tick means conditions may improve; no_retry means the error is terminal.
- **LC** = Limit-cancelled arbitrage sequences. Array: {ok=[completed legs], to={l=leg#, p=pair, d=dex, cat=errorCategory, act=suggestedAction}, skip=[cancelled legs]}. These timed out because the market moved and the quote degraded below the limit price. You CAN retry from the timed-out leg onward if the spread still looks good in A/TA data. Completed legs already executed — do not re-do them.
- **DV** = Divergence pairs — tokens moving in opposite directions. Array: {u=upToken, d=downToken, uh1=up%h1, dh1=down%h1, g1=gapH1%, uh24=up%h24, dh24=down%h24, g24=gapH24%, sig=signal(weak/medium/strong)}. These are mean-reversion swap candidates: sell the 'up' token to buy the 'down' token. Stronger signals (larger gaps, both h1 and h24 diverging) are more reliable. Always cross-reference with long-term Δ trends before acting — avoid catching a falling knife.
- **X** = Rejected dex+pair combos. Array: {d=dex, p=pair, r=reason}. These are banned for 2 hours. Do not use these combinations.
- **SELLOFF** = Token-limit sell directive. When present: {token, held, count}. You must sell the specified token (or pick the weakest if token=null) to USDC. No new positions while over the 8-token limit.
- **MEMO** = Your own working memory from the previous tick. Use this to maintain continuity: track tokens you're watching, note emerging patterns across ticks, record cooldown status, or anything you want to remember. Write a new memo each tick in the output — it will be fed back to you next tick. Keep it concise (~200 tokens max).
- **LTO** = Last Tick Outcome — unrealized PnL feedback for trades you made last tick. Array: {p=pair, s=strategy, ty=type, sol=amountSol, entry=entryPriceUsd, now=currentPriceUsd, pnl=unrealizedPnl%}. Use this to evaluate whether your recent entries were well-timed. Positive pnl% = good entry; negative = reassess your thesis. Adjust future decisions based on these outcomes.
- **TP** = Historical per-token performance. Object: {SYM: {t=tradeCount, w=winRate% (of rated trades), avg=avgPnl%, last=lastTraded}}. Shows how each token has performed historically. Prefer tokens with higher win rates and positive avg PnL. Avoid tokens with poor track records unless strong current signals justify it. Only includes tokens with trade history.
- **PAPER** = Trading mode (true=paper/simulated, false=live). DMAX/GMAX = per-strategy soft caps in SOL-equivalent notional. CMAX = combined cap (DMAX+GMAX) for merged trades.
- **C** = Pre-execution constraints bundle. Object: {dMax=degen budget SOL-notional, gMax=guardian budget SOL-notional, cMax=combined budget SOL-notional, dBase/gBase=base caps before adaptive scaling, dHard/gHard/cHard=absolute hard caps for this tick after env+share+pct limits, rg=regime, vol=volatility band, dMul/gMul/cMul=adaptive cap multipliers, dOn=degen strategy active, gOn=guardian strategy active, dPct=degen share %, gPct=guardian share %, dCool=degen cooldown ticks remaining (0=available), gCool=guardian cooldown ticks remaining, maxT=max trades per tick, usdcBal=wallet USDC balance, usdcReserve=minimum USDC reserve, sellOff=true if over token limit, banned=count of banned dex+pair combos in X}. Respect these hard limits — trades exceeding them will be rejected server-side.
- **RG** = Regime diagnostics from market internals. Object: {mode=risk-on|chop|risk-off, vol=low|medium|high, breadthH1=fraction of tokens up on h1, avgH24=average h24 move, rvH1=average absolute h1 move}. Use this for volatility-targeted sizing and aggressiveness.
- **FOCUS** = Tick strategy focus directive. Values: "sell-only" (must reduce positions — over token limit, only propose sells), "arb-priority" (validated arb opportunities in A/TA — prioritize arb execution, still allow other high-confidence trades), "open" (all strategies available, no special focus). Respect the focus: sell-only means ONLY sell trades; arb-priority means review A/TA data first and prefer arb trades.`;

const STRATEGY_ALLOCATION_TEXT = `## Strategy Allocation
- Degen share: ${DEGEN_SHARE_PCT}%
- Guardian share: ${GUARDIAN_SHARE_PCT}%
- Active strategies: ${COMBINED_ACTIVE ? 'degen + guardian' : (DEGEN_ACTIVE ? 'degen only' : 'guardian only')}`;

const DEGEN_STRATEGY_TEXT = DEGEN_ACTIVE
  ? `### Degen Strategy (${DEGEN_SHARE_PCT}% of portfolio budget, max ${config.risk.degenMaxPct}% per trade)
Aggressive, momentum-driven strategy. Targets breakout patterns, major news events, and high-confidence arbitrage opportunities.
- Enter on strong signals: rapid price moves (check Δ h1/h6 for momentum), confirmed news catalysts, or validated arb spreads.
- Never exceed DMAX (soft cap shown in each tick's data). DMAX is 90% of the hard max to leave buffer.
- Best for: arbitrage execution, breakout momentum, high-confidence news plays.`
  : `### Degen Strategy (DISABLED)
RISK_DEGEN_SHARE_PCT is set to 0, so degen trades are not allowed this run.`;

const GUARDIAN_STRATEGY_TEXT = GUARDIAN_ACTIVE
  ? `### Guardian Strategy (${GUARDIAN_SHARE_PCT}% of portfolio budget, max ${config.risk.guardianMaxPct}% per trade)
Conservative, capital-preservation strategy. Focuses on buying dips in strong uptrends and protecting unrealized gains.
- Enter on: confirmed trend reversals (h1 negative but h6/h24 strongly positive = dip buy), DCA into high-conviction positions, or defensive sells to lock in profits.
- Never exceed GMAX (soft cap).
- Best for: dip buying, profit taking, DCA accumulation, risk reduction.`
  : `### Guardian Strategy (DISABLED)
RISK_DEGEN_SHARE_PCT is set to 100, so guardian trades are not allowed this run.`;

const STRATEGY_CONFLICT_TEXT = COMBINED_ACTIVE
  ? `- If Guardian and Degen target the same token in the same tick, Guardian's view takes priority (e.g., Guardian says "sell to protect gains" overrides Degen's "buy the breakout").`
  : '- Only one strategy is active; do not propose trades for the disabled strategy.';

const COMBINED_STRATEGY_TEXT = COMBINED_ACTIVE
  ? '- When using strategy="combined", the max amount is CMAX (DMAX + GMAX). The server enforces this cap.'
  : '- strategy="combined" is disabled when only one strategy is active.';

/* ═══════════════════════════════════════════════════════════════════
   Static instructions — placed FIRST in input[] as developer messages
   so they form the cached prefix.  Because cached input tokens are
   50-90 % cheaper, these can be much more detailed than before.
   ═══════════════════════════════════════════════════════════════════ */

const TRADING_INSTRUCTIONS = `You are solana-swap-bot, an autonomous Solana trading bot running on a Raspberry Pi. You receive fresh market data every hour and must decide whether to trade or hold. Your goal is to grow the portfolio while managing risk carefully.

## Denomination & Wallet Management
- Trade sizing fields (amountSol, DMAX/GMAX/CMAX) are SOL-equivalent notional units used by the execution engine.
- USDC is the main cash reserve and take-profit anchor. Prefer USDC as the source for new buys and as the destination for risk reduction / profit taking.
- Always maintain at least 0.05 SOL for transaction fees, but do not treat SOL as the main reserve asset.
- Respect USDC reserve in C.usdcReserve. Avoid proposing trades that would materially deplete USDC below this floor.

## Strategies (shared wallet)

${STRATEGY_ALLOCATION_TEXT}

${DEGEN_STRATEGY_TEXT}

${GUARDIAN_STRATEGY_TEXT}

${STRATEGY_CONFLICT_TEXT}

## Trade Types
- **momentum** — Trend following and breakout trades. Use multi-timeframe data (Δ) to confirm: look for alignment across m5, h1, h6, h24. A token pumping on m5/h1 but negative on h6/h24 is likely a short squeeze, not a sustainable trend.
  Example: JUP m5:+2.1%, h1:+4.8%, h6:+7.3%, h24:+11.0% with no DOWN/BOUNCE flag -> type="momentum".
- **arbitrage** — Cross-DEX spread capture using A/TA data. Requires sequenceGroup > 0. Detailed rules included when arb opportunities exist.
  Example: A shows USDC→JUP buy@Meteora and JUP→USDC sell@Orca with +3.6% net spread -> type="arbitrage" for both legs in one sequenceGroup.
- **news** — Trade based on high-confidence social/news-like signals inferred from TW + price action alignment (Δ).
  Example: repeated credible bearish social reports for token X while Δ h1/h6 are negative -> type="news" sell/reduce.
- **dca** — Dollar-cost-average into conviction positions. Use when a token shows strong fundamentals (positive h6/h24 trends) but short-term weakness (negative m5/h1).
  Example: JUP h24:+9.0%, h6:+3.2%, but m5:-1.4% and h1:-0.8% after a pullback -> type="dca" using USDC as input.
- **divergence** — Mean-reversion trades between tokens moving in opposite directions using DV data. Detailed rules included when divergence data is present.
  Example: DV shows JUP strongly up and BONK sharply down with strong gap signal -> type="divergence" by selling JUP to buy BONK (only if BONK not flagged DOWN crash).

Trade type selection rule (must follow):
- If the trade is directly sourced from A or TA spread data, use type="arbitrage" only.
- If the primary trigger is a social/news catalyst from TW, use type="news".
- If the primary trigger is pure price-trend continuation, use type="momentum".
- If the primary trigger is pullback accumulation in a strong long trend, use type="dca".
- If the primary trigger is cross-token opposite moves from DV, use type="divergence".
- Never label the same trade as a different type just to justify size. Type must match the dominant trigger.

## Trend Analysis Using Multi-Timeframe Data (Δ)
The Δ field contains price changes across 6 timeframes for each token: m5 (5 min), m10 (10 min), m30 (30 min), h1 (1 hour), h6 (6 hours), h24 (24 hours).
m10 and m30 are computed from our own price snapshots taken each tick — they show very recent momentum.
Use these to identify trend strength and direction:
- **Strong uptrend**: h1 > 0, h6 > 0, h24 > 0. Good for momentum buys or DCA entries.
- **Strong downtrend**: h1 < 0, h6 < 0, h24 < 0. Avoid buying; consider selling held positions.
- **Dip in uptrend**: m5/m10 negative but h1/h6 positive. Potential Guardian dip buy if the longer trend is intact.
- **Short squeeze / dead cat bounce**: m5/m10 positive but h6/h24 negative. Avoid — likely unsustainable.
- **Momentum acceleration**: m5 >> m10 >> m30 >> h1. Token is accelerating — good Degen momentum entry if confirmed by volume or news.
- **Micro trend**: m10/m30 show what happened in the last 10-30 min. Use to detect very recent moves between ticks.
- **Trend reversal signal**: h1 flips sign vs h6/h24. Watch closely — could be early reversal.
Use Δ data to validate every trade decision. Never trade against the dominant trend without strong justification (e.g., high-confidence news).

${DATA_FIELDS_GUIDE}
- **ANALYSIS** = Pre-computed market analysis from Phase 1. When present, use this as your starting context — it already contains trend assessment, opportunity identification, and risk analysis. Build your marketAnalysis and decisions on top of it rather than re-analyzing from scratch.

## Output Format
- **marketAnalysis** — Write your overall market read FIRST: summarize key observations from the data (trends, arb opportunities, news signals, concerns). This forces you to think before deciding.
- Use token SYMBOLS (e.g., "SOL", "USDC", "JUP") for inputToken and outputToken fields — never mint addresses. Only whitelisted token symbols are accepted.
- Set dex="" for best-route (Jupiter auto-routing). Only specify a DEX name when doing targeted arb trades.
- sequenceGroup: use 0 for standalone trades, use a positive integer (1, 2, 3...) for arb sequence legs (max 3 legs per group).
- The memo field is your working memory — write observations, patterns, and notes you want to carry forward to the next tick. Keep it under ~200 tokens.
- Output valid JSON matching the schema. The reasoning field should explain your analysis concisely.

## Trade Count Discipline — CRITICAL
- Default target: at most one high-conviction trade per active strategy per tick.
- If both degen and guardian are active: prefer either (a) one combined trade sized near CMAX, or (b) exactly two trades total (one degen + one guardian).
- Do not spray 3+ standalone swaps unless it is a strict arbitrage sequence from A/TA.
- Respect C.maxT as a hard ceiling for total proposed trades.

## Fee Optimization — CRITICAL: No Duplicate Pairs
Solana charges per-transaction fees. NEVER propose two trades with the same inputToken→outputToken pair in the same tick — even across different strategies. Always combine them:
- **Same pair = ONE trade**: If both degen and guardian want e.g. USDC→JUP, submit exactly ONE trade with strategy="combined" and amountSol up to CMAX. Two trades for the same pair wastes fees and is ALWAYS wrong.
- **Same pair + same DEX = definitely ONE trade**: This is the most wasteful case. The server will merge them, but you should never propose this.
- **Chain collapse**: If two trades form a chain (e.g. USDC→JUP + JUP→BONK), submit ONE direct swap USDC→BONK instead. Only 3 coins involved = 1 trade saves a fee.
- **Single strategy is fine**: You do NOT need to propose trades for both strategies. One combined trade using the full CMAX budget is preferred over two smaller trades for the same or chained pair.
${COMBINED_STRATEGY_TEXT}

## Token Limit (max 8 held tokens excluding USDC)
When the SELLOFF field is present, you are over the 8-token holding limit. Your priority is to reduce: sell the specified token (or pick the weakest performer based on Δ data if token is null) to USDC. Do NOT open new positions while over the limit. This persists across ticks until the position is fully liquidated.

## Dust Cleanup Rule
- Avoid leaving tiny residual token balances.
- When selling a token and the remaining value would be small (roughly < 20 USDC equivalent or < 10% of that token position), prefer a full exit by sizing the sell close to the full held amount.
- This rule applies especially during SELLOFF and risk reduction trades.

## CRITICAL: Wallet Holdings Enforcement
- You can BUY (outputToken) ANY token in the whitelist — you are NOT limited to tokens already in your wallet.
- You may ONLY SELL (use as inputToken) tokens that appear in W.h or SOL from W.s. If a token is not in your wallet, you CANNOT sell it.
- Prefer USDC as the inputToken for buy entries and USDC as the outputToken for take-profit / deleveraging exits.
- Trade amounts must not exceed what you hold. Check W.h[SYM].amt for token amounts, W.s for SOL fee buffer.
- For arb sequences: leg 1 inputToken must be in your wallet. Subsequent legs use output from prior legs.
- For divergence trades: you must hold the "up" token you plan to sell. Do not propose selling tokens you don't own.
- Before every trade proposal, verify: (1) inputToken is in W.h or is SOL, (2) amountSol does not exceed the SOL-equivalent of your holdings for that token, (3) USDC-input trades keep cash above C.usdcReserve unless a strong exception is justified.
- Max 8 tokens held simultaneously (excluding USDC). If already at 8, only sell existing tokens or swap between held tokens — do NOT buy new tokens until you free a slot.

## Decision Rules
- No clear signal → HOLD. It is perfectly fine to hold and wait for better opportunities.
- If daily cumulative loss exceeds 5%, HALT all trading for the day (output hold).
- Only trade when supported by data: price trends (Δ), arb spreads (A/TA), divergence pairs (DV), or tweets (TW).
- Consider recent trade history (T) to avoid repeating mistakes. If the last 3 trades lost money, be more conservative.
- Prefer higher-confidence setups over marginal ones.

## Trade Sizing — Bias High Toward Caps
Use C.dMax/C.gMax/C.cMax as the primary sizing targets for approved trades.
- For a qualified trade, size aggressively near the cap (typically 80-100% of that strategy cap).
- Only size below 80% when data is clearly mixed, liquidity is thin, or volatility is extreme.
- Avoid tiny exploratory trades unless in explicit uncertainty or test-entry scenarios.
- Prefer one larger, high-conviction trade over multiple small trades.

Volatility targeting rules:
- In RG.vol="high", downsize relative to normal (prefer lower end of each size band).
- In RG.mode="risk-off", prioritize defense: smaller buys, faster profit-taking, and stricter selectivity.
- In RG.mode="risk-on" with RG.vol!="high", you may size toward the upper end for high-conviction setups.
- Always treat C.dMax/C.gMax/C.cMax as authoritative adaptive caps for this tick.

Respond with JSON output matching the schema only. No markdown, no explanations outside the JSON.`;

// Extended arb instructions — appended only when A/TA data present (2.1)
const TRADING_ARB_RULES = `

## Arbitrage Execution Details
- **arbitrage** — Cross-DEX spread capture. Two variants:
  - 2-leg (buy on cheap DEX, sell on expensive DEX): minimum 3% net spread (already fee-adjusted in A data).
  - 3-leg triangular (A→B→C→A): minimum 5% net spread (already fee-adjusted in TA data).
  All legs must share the same sequenceGroup (positive integer).

## Arbitrage Rules (IMPORTANT)
- All legs in an arb trade share the same sequenceGroup (a positive integer). Each leg executes sequentially.
- No same-family DEX pairs within a sequence (e.g., "Raydium" and "Raydium CLMM" are the same family).
- Strategies can be mixed within a sequenceGroup — each leg is individually risk-checked against its own strategy's max.
- 2-leg arb: The A data already shows fee+slippage-adjusted net spreads. If an entry exists in A, it's profitable — execute it.
- 3-leg arb: The TA data provides the complete path with all three legs. Execute all 3 legs in order within one sequenceGroup.
- **Limit price protection**: Each arb leg enforces a minimum output amount (99.9% of the arb finder's discovered rate — 0.1% dust tolerance). If the market moves against the trade and the limit isn't met within 3 minutes, the leg times out and remaining legs are cancelled. Check the LC field for recently timed-out arb sequences — you can retry from the failed leg onward if conditions still look favorable.

## DEX Names — CRITICAL
Always copy the EXACT dex string from the A or TA data fields. Never rename, append suffixes, or abbreviate DEX names.
- "Meteora" must stay "Meteora" (never write "Meteora DLMM" or "Meteora v2").
- "Raydium CLMM" must stay exactly "Raydium CLMM".
- For non-arb trades (momentum, news, dca, divergence), always use dex="" — Jupiter will automatically find the best route across all 60+ DEXes. Only specify a dex name for arbitrage trades where the spread depends on a specific DEX.`;

// Extended divergence instructions — appended only when DV data present (2.1)
const TRADING_DIV_RULES = `

## Divergence Trading Details
Trade between tokens moving in opposite directions. The DV data shows pairs where one token is rising and another is falling. Strategy: swap the strong (up) token for the weak (down) token expecting mean reversion. Best when the down token has strong longer-term fundamentals but short-term weakness. Example: if SOL is up +8% h24 and BONK is down -12% h24, swapping SOL for BONK bets on BONK catching up. Use Guardian strategy for conservative divergence plays, Degen for aggressive ones. Verify with Δ data that the down token isn't in a sustained crash (check h6/h24 alignment). Prefer 'strong' signal pairs from DV data.`;

// Phase 1 analysis instructions — used for two-phase reasoning (3.1)
const TRADING_ANALYSIS_INSTRUCTIONS = `You are solana-swap-bot's market analyst for Solana tokens. Analyze the provided market data and produce a comprehensive assessment.

${DATA_FIELDS_GUIDE}

Produce clear, data-backed analysis covering:
1. Overall market direction and sentiment
2. Social catalyst assessment: which tweets are material? Which tokens are affected? Bullish or bearish?
3. Top 2-3 opportunities with specific tokens, percentages, and timeframes
4. Risk factors and concerns (trend flags, low USDC reserve, low SOL fee buffer, loss streaks)
5. Strategy recommendations (degen vs guardian focus, position sizing)

Be specific — cite exact tokens, percentages, and timeframes. Keep analysis under 400 tokens.`;

const DAILY_REPORT_INSTRUCTIONS = `solana-swap-bot daily reporter. Concise end-of-day summary for the operator.

Include: trade count, total PnL (SOL-equivalent), win/loss ratio, best/worst trades, strategy performance, most active tokens, and cash posture (USDC reserve trend). Compare to prior days if history available. Flag concerns: excessive losses, repeated failures, imbalances. Under 300 words, bullet points.`;

// Trade decision validator instructions — second AI review before execution (1.1)
const VALIDATOR_INSTRUCTIONS = `You are solana-swap-bot's trade validator. You receive proposed trades from the trading AI along with the market data that informed them. Your job is to catch mistakes before capital is committed.

${DATA_FIELDS_GUIDE}

Review each proposed trade and check for:
1. **Contradictions**: Does the trade direction conflict with the market data? E.g., buying a token whose Δ shows sustained downtrend (h1/h6/h24 all negative), or selling a token that's clearly in a strong uptrend.
2. **Size reasonableness**: Is the trade size proportional to signal strength? Large size should be near strategy caps for high-conviction setups (validated arb, strong social catalyst + trend alignment).
3. **Sell-off compliance**: If SELLOFF is present, the AI must only sell — no new buys allowed. Flag any buy trades during sell-off.
4. **Repeated failures**: Check recent trade history (T) for the same token/direction that recently lost money. If the last 2+ trades on a token lost, buying more is suspicious.
5. **Wallet enforcement**: Verify inputToken is held (in W.h or SOL from W.s). Verify amountSol doesn't exceed holdings.
6. **Constraint compliance**: Check trades against C constraints (budget caps, cooldowns, max trades per tick).
7. **Trade-count discipline**: Prefer one trade per active strategy (or one combined trade). Flag proposals with unnecessary 3+ standalone swaps.
8. **Dust cleanup**: When selling and a tiny remainder would be left, prefer near-full exits.
9. **USDC-first policy**: Prefer USDC as base quote and take-profit destination; flag avoidable non-USDC exits during sell-off/risk reduction.

Output your verdict:
- **approve**: All trades pass validation. Minor concerns can be noted but don't block.
- **reject**: One or more trades have critical issues (contradictions, sell-off violations, wallet violations). Fall back to hold.

Be strict on contradictions and sell-off compliance. Be lenient on size — only flag extreme mismatches.
Keep reasoning concise. JSON output matching schema only.`;

// JSON schema for validator verdict (1.1)
const VALIDATOR_SCHEMA = {
  type: 'json_schema',
  name: 'trade_validation',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      verdict:   { type: 'string', enum: ['approve', 'reject'], description: 'Whether to approve or reject the proposed trades' },
      reasoning: { type: 'string', description: 'Brief explanation of the validation result' },
      flags: {
        type: 'array',
        description: 'Issues found in individual trades. Empty if all trades pass.',
        items: {
          type: 'object',
          properties: {
            trade:  { type: 'string', description: 'Trade description (e.g. "USDC→JUP 0.5 SOL-notional degen momentum")' },
            issue:  { type: 'string', description: 'What is wrong with this trade' },
            severity: { type: 'string', enum: ['critical', 'warning'], description: 'Critical = must reject, Warning = note but allow' },
          },
          required: ['trade', 'issue', 'severity'],
          additionalProperties: false,
        },
      },
    },
    required: ['verdict', 'reasoning', 'flags'],
    additionalProperties: false,
  },
};

// Token enum generated from config — prevents AI from hallucinating symbols (10.1)
const TOKEN_ENUM = Object.keys(config.watchedTokens);

function getStrategyEnum() {
  const strategyEnum = [];
  if (DEGEN_ACTIVE) strategyEnum.push('degen');
  if (GUARDIAN_ACTIVE) strategyEnum.push('guardian');
  if (COMBINED_ACTIVE) strategyEnum.push('combined');
  return strategyEnum.length ? strategyEnum : ['guardian'];
}

// JSON schema for structured trading decisions (10.2: amountSol min/max set dynamically)
function buildTradingSchema(maxSol, maxTrades) {
  const strategyEnum = getStrategyEnum();
  return {
    type: 'json_schema',
    name: 'trading_decision',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        marketAnalysis: { type: 'string', description: 'Overall market read: key observations, trends, arb opportunities, concerns. Write this FIRST to structure your thinking before deciding.' },
        action: { type: 'string', enum: ['trade', 'hold'], description: 'Whether to execute trades or hold' },
        trades: {
          type: 'array',
          description: 'Array of trades to execute. Empty array for hold.',
          maxItems: maxTrades,
          items: {
            type: 'object',
            properties: {
              strategy:      { type: 'string', enum: strategyEnum, description: 'Which strategy budget to use based on active strategy allocation for this run.' },
              type:          { type: 'string', enum: ['momentum', 'arbitrage', 'news', 'dca', 'divergence'], description: 'Trade type classification' },
              inputToken:    { type: 'string', enum: TOKEN_ENUM, description: 'Token symbol to sell' },
              outputToken:   { type: 'string', enum: TOKEN_ENUM, description: 'Token symbol to buy' },
              amountSol:     { type: 'number', minimum: 0.001, maximum: maxSol, description: `Trade size in SOL-equivalent notional (min 0.001, max ${maxSol})` },
              reason:        { type: 'string', description: 'Brief explanation of why this trade' },
              slippageBps:   { type: 'number', description: 'Slippage tolerance in basis points (e.g. 30 = 0.3%)' },
              dex:           { type: 'string', description: 'DEX name from R data, or empty string for best-route' },
              sequenceGroup: { type: 'number', description: '0 for standalone, positive int for arb sequence legs' },
            },
            required: ['strategy', 'type', 'inputToken', 'outputToken', 'amountSol', 'reason', 'slippageBps', 'dex', 'sequenceGroup'],
            additionalProperties: false,
          },
        },
        reasoning: { type: 'string', description: 'Overall analysis explaining the decision' },
        memo: { type: 'string', description: 'Working memory note (max ~200 tokens) to carry forward to the next tick. Record observations, token watch notes, cooldown status, or anything you want to remember.' },
      },
      required: ['marketAnalysis', 'action', 'trades', 'reasoning', 'memo'],
      additionalProperties: false,
    },
  };
}

/* ═══════════════════════════════════════════════════════════════════
   Helper — log prompt cache stats from the response usage object
   ═══════════════════════════════════════════════════════════════════ */
function logCacheStats(channel, usage) {
  if (!usage) return;
  const total   = usage.input_tokens ?? 0;
  const cached  = usage.input_tokens_details?.cached_tokens ?? 0;
  const output  = usage.output_tokens ?? 0;
  const pct     = total > 0 ? ((cached / total) * 100).toFixed(1) : '0.0';
  log.info(`[${channel}] tokens — input: ${total} (cached: ${cached}, ${pct}%), output: ${output}, total: ${usage.total_tokens ?? 0}`);
}

/* ═══════════════════════════════════════════════════════════════════
   analyzeAndDecide() — Trading Loop AI
   ═══════════════════════════════════════════════════════════════════ */

/**
 * Ask the AI to analyze market data and decide on trades.
 */
export async function analyzeAndDecide(context) {
  const walletSol = context.wallet?.totalValueSol || 0;
  const degenMaxTradeSol    = Math.floor(getStrategyHardMaxSol(walletSol, 'degen') * 10000) / 10000;
  const guardianMaxTradeSol = Math.floor(getStrategyHardMaxSol(walletSol, 'guardian') * 10000) / 10000;
  const degenSoftMax    = Math.floor(degenMaxTradeSol * 9000) / 10000;
  const guardianSoftMax = Math.floor(guardianMaxTradeSol * 9000) / 10000;
  const combinedSoftMax = Math.floor((degenSoftMax + guardianSoftMax) * 10000) / 10000;

  // ── Compact data ──
  const mintToSym = Object.fromEntries(
    Object.entries(config.watchedTokens).map(([s, m]) => [m, s])
  );
  const solPrice = context.prices?.SOL || 1;
  const walletCompact = {
    t: +(context.wallet?.totalValueSol || 0).toFixed(4),
    s: +(context.wallet?.solBalance || 0).toFixed(4),
    h: {},  // SYM → { sol: solValue, amt: tokenAmount, usd: usdValue }
  };
  for (const [mint, info] of Object.entries(context.wallet?.tokens || {})) {
    const sym = mintToSym[mint];
    if (!sym || sym === 'SOL') continue; // SOL is in .s field, skip unknown mints
    walletCompact.h[sym] = {
      sol: +((info.valueUsd || 0) / solPrice).toFixed(4),
      amt: +(info.amount || 0).toPrecision(6),
      usd: +((info.valueUsd || 0)).toFixed(2),
    };
  }

  // Round prices to 4 significant figures
  const pricesCompact = {};
  for (const [sym, p] of Object.entries(context.prices || {})) {
    pricesCompact[sym] = +Number(p).toPrecision(4);
  }

  // Multi-timeframe price changes from DexScreener: { SYM: { m5, h1, h6, h24 } }
  const trendData = {};
  for (const [sym, c] of Object.entries(context.priceChanges || {})) {
    if (!c) continue;
    const entry = {};
    if (c.m5  != null && c.m5  !== 0) entry.m5  = +Number(c.m5).toFixed(1);
    if (c.m10 != null && c.m10 !== 0) entry.m10 = +Number(c.m10).toFixed(1);
    if (c.m30 != null && c.m30 !== 0) entry.m30 = +Number(c.m30).toFixed(1);
    if (c.h1  != null && c.h1  !== 0) entry.h1  = +Number(c.h1).toFixed(1);
    if (c.h6  != null && c.h6  !== 0) entry.h6  = +Number(c.h6).toFixed(1);
    if (c.h24 != null && c.h24 !== 0) entry.h24 = +Number(c.h24).toFixed(1);
    // Trend alignment flags (4.2) — server-side pre-classification
    const h1v = c.h1 || 0, h6v = c.h6 || 0, h24v = c.h24 || 0, m5v = c.m5 || 0;
    if (h1v < 0 && h6v < 0 && h24v < 0) entry.flag = 'DOWN';
    else if (m5v > 0 && h6v < 0 && h24v < 0) entry.flag = 'BOUNCE';
    if (Object.keys(entry).length > 0) trendData[sym] = entry;
  }

  // Arb opportunities are ALREADY whitelist-filtered by arbitrageFinder (3 levels).
  // No redundant filter here — just compact and send to AI.
  const arbCompact = (context.arbitrage || [])
    .slice(0, 8)
    .map(a => ({ p: a.pair, s: a.spreadPct, b: a.buyDex, x: a.sellDex }));
  // 3-leg triangular arb opportunities
  const triArbCompact = (context.triangularArbitrage || [])
    .slice(0, 5)
    .map(a => ({
      path: a.path, s: a.spreadPct,
      l1: { p: a.leg1.pair, d: a.leg1.dex },
      l2: { p: a.leg2.pair, d: a.leg2.dex },
      l3: { p: a.leg3.pair, d: a.leg3.dex },
    }));

  if (context.arbitrage?.length || context.triangularArbitrage?.length) {
    log.info(`Arb data for AI: ${context.arbitrage?.length || 0} 2-leg + ${context.triangularArbitrage?.length || 0} 3-leg`);
  }

  const whitelistSet = new Set(config.compareDexes);

  // Compact tweets for TW field (raw social signals)
  const tweetsCompact = (context.tweets || []).slice(0, 10).map(tw => ({
    t: tw.text?.slice(0, 140),
    a: tw.author,
    k: tw.keywords,
  }));

  const tradesRaw = (context.recentTrades || []).slice(0, 30);

  // Group arb sequence trades together, keep standalone trades as-is
  const tradesCompact = [];
  const seqGroups = new Map(); // sequenceGroup → [trades]
  for (const t of tradesRaw) {
    const sg = t.sequenceGroup || 0;
    if (sg > 0) {
      if (!seqGroups.has(sg)) seqGroups.set(sg, []);
      seqGroups.get(sg).push(t);
    } else {
      tradesCompact.push({
        s: t.strategy?.[0], ty: t.type,
        p: `${mintToSym[t.inputMint] || '?'}→${mintToSym[t.outputMint] || '?'}`,
        sol: t.amountSol || 0, pnl: t.pnlSol || 0,
        dex: t.dex || '',
        r: t.reason || undefined,
        ip: t.inputPriceUsd || undefined,
        op: t.outputPriceUsd || undefined,
      });
    }
  }
  // Append grouped arb sequences
  for (const [sg, legs] of seqGroups) {
    tradesCompact.push({
      seq: sg,
      ty: legs[0]?.type || 'arbitrage',
      s: legs[0]?.strategy?.[0] || '?',
      legs: legs.map(t => ({
        p: `${mintToSym[t.inputMint] || '?'}→${mintToSym[t.outputMint] || '?'}`,
        sol: t.amountSol || 0, pnl: t.pnlSol || 0,
        dex: t.dex || '',
        r: t.reason || undefined,
        ip: t.inputPriceUsd || undefined,
        op: t.outputPriceUsd || undefined,
      })),
    });
  }

  const failedSeqCompact = (context.failedSequences || []).map(f => ({
    ok: f.completed.map(c => ({ l: c.leg, p: c.pair, d: c.dex })),
    fail: { l: f.failed.leg, p: f.failed.pair, d: f.failed.dex, e: f.failed.error?.slice(0, 60), cat: f.failed.cat, act: f.failed.act },
    skip: f.cancelled.map(c => ({ l: c.leg, p: c.pair, d: c.dex })),
  }));

  const rejectedCombos = (context.rejectedCombos || []).map(c => ({
    d: c.dex, p: c.pair, r: c.reason?.slice(0, 40),
  }));

  const limitCancelledCompact = (context.limitCancelled || []).map(lc => ({
    ok: lc.completed.map(c => ({ l: c.leg, p: c.pair, d: c.dex })),
    to: { l: lc.timedOut.leg, p: lc.timedOut.pair, d: lc.timedOut.dex, cat: lc.timedOut.cat, act: lc.timedOut.act },
    skip: lc.cancelled.map(c => ({ l: c.leg, p: c.pair, d: c.dex })),
  }));

  const solBal = context.wallet?.solBalance || 0;
  const solAlert = solBal < 0.1 ? `\nSOL_LOW_ALERT: SOL=${solBal.toFixed(4)}. Prioritize buying SOL with other tokens.` : '';
  const usdcBal = context.wallet?.tokens?.[config.watchedTokens.USDC]?.amount || 0;
  const usdcAlert = (context.constraints?.usdcReserve != null && usdcBal < context.constraints.usdcReserve)
    ? `\nUSDC_LOW_ALERT: USDC=${usdcBal.toFixed(2)} below reserve ${context.constraints.usdcReserve}. Prioritize raising USDC.`
    : '';

  // Divergence pairs — tokens moving in opposite directions
  const divPairs = (context.divergence?.pairs || []).slice(0, 10).map(d => ({
    u: d.up, d: d.down,
    uh1: d.upH1, dh1: d.downH1, g1: d.gapH1,
    uh24: d.upH24, dh24: d.downH24, g24: d.gapH24,
    sig: d.signal,
  }));

  // Build tiered instructions — core always, extensions when relevant data exists (2.1)
  const hasArb = arbCompact.length > 0 || triArbCompact.length > 0;
  const hasDiv = divPairs.length > 0;
  const tradingInstructions = TRADING_INSTRUCTIONS + (hasArb ? TRADING_ARB_RULES : '') + (hasDiv ? TRADING_DIV_RULES : '');
  if (hasArb || hasDiv) {
    log.info(`Instruction tiers: core${hasArb ? ' +arb' : ''}${hasDiv ? ' +div' : ''}`);
  }

  // 8.2 — Compute tick focus directive
  const tickFocus = context.sellOff
    ? 'sell-only'
    : (hasArb ? 'arb-priority' : 'open');

  // Dynamic data — sent as input (instructions are in the dedicated top-level field)
  const userContent = `W:${JSON.stringify(walletCompact)}
P:${JSON.stringify(pricesCompact)}
Δ:${JSON.stringify(trendData)}${arbCompact.length ? `\nA:${JSON.stringify(arbCompact)}` : ''}${triArbCompact.length ? `\nTA:${JSON.stringify(triArbCompact)}` : ''}${divPairs.length ? `\nDV:${JSON.stringify(divPairs)}` : ''}${tweetsCompact.length ? `\nTW:${JSON.stringify(tweetsCompact)}` : ''}
T:${JSON.stringify(tradesCompact)}${failedSeqCompact.length ? `\nF:${JSON.stringify(failedSeqCompact)}` : ''}${limitCancelledCompact.length ? `\nLC:${JSON.stringify(limitCancelledCompact)}` : ''}${rejectedCombos.length ? `\nX:${JSON.stringify(rejectedCombos)}` : ''}${context.sellOff ? `\nSELLOFF:${JSON.stringify(context.sellOff)}` : ''}
FOCUS:${tickFocus}
  PAPER:${config.paperTrade()} DMAX:${degenSoftMax} GMAX:${guardianSoftMax} CMAX:${combinedSoftMax}${solAlert}${usdcAlert}${context.constraints ? `\nC:${JSON.stringify(context.constraints)}` : ''}${context.regime ? `\nRG:${JSON.stringify(context.regime)}` : ''}${context.memo ? `\nMEMO:${context.memo}` : ''}${context.lto?.length ? `\nLTO:${JSON.stringify(context.lto)}` : ''}${context.tokenPerf && Object.keys(context.tokenPerf).length ? `\nTP:${JSON.stringify(context.tokenPerf)}` : ''}`;

  try {
    // ── Phase 1: Analysis (3.1) — cheap model, free-text analysis ──
    let analysisText = '';
    const analysisModel = config.openaiModels?.tradingAnalysis || 'gpt-5-nano';
    try {
      log.info(`Trading AI Phase 1 — model: ${analysisModel}, cache_key: ${CACHE_KEY_TRADING_ANALYSIS}`);
      const analysisResp = await client.responses.create({
        model: analysisModel,
        instructions: TRADING_ANALYSIS_INSTRUCTIONS,
        input: userContent,
        store: false, // Don't store analysis response to save space, it's intermediate reasoning not a final decision
        prompt_cache_key: CACHE_KEY_TRADING_ANALYSIS,
      });
      logCacheStats('trading-p1', analysisResp.usage);
      analysisText = analysisResp.output_text || '';
      log.info(`Phase 1 analysis (${analysisText.length} chars): ${analysisText.slice(0, 200)}${analysisText.length > 200 ? '…' : ''}`);
    } catch (p1err) {
      log.warn(`Phase 1 analysis failed, proceeding without: ${p1err.message}`);
    }

    // ── Phase 2: Decision — main model, structured JSON ──
    const phase2Input = analysisText
      ? `ANALYSIS:${analysisText}\n${userContent}`
      : userContent;

    const model = config.openaiModels?.trading || config.openaiModel;
    log.info(`Trading AI Phase 2 — model: ${model}, cache_key: ${CACHE_KEY_TRADING}`);
    log.info(`Trading AI Phase 2 — input length: ${phase2Input.length} chars`);

    // 10.2: Dynamic amountSol max = CMAX + 10% safety margin (server clamps to hard max anyway)
    const schemaMaxSol = Math.ceil(combinedSoftMax * 1.1 * 100) / 100 || 10;
    const tradingSchema = buildTradingSchema(schemaMaxSol, Math.max(1, config.risk.maxTradesPerTick || 2));

    const resp = await client.responses.create({
      model,
      instructions: tradingInstructions,
      input: phase2Input,
      text: { format: tradingSchema },
      store: false, // Store only the final decision, not the analysis phase response
      prompt_cache_key: CACHE_KEY_TRADING,
    });

    logCacheStats('trading-p2', resp.usage);
    const text = resp.output_text || '{}';
    const decision = JSON.parse(text);
    log.info(`AI decision: ${decision.action} — ${decision.reasoning || ''}`);

    setResponseIdForChannel('trading', resp.id);
    saveConversation('trading', 'user', phase2Input);
    saveConversation('trading', 'assistant', text);
    pruneConversation('trading', 10);

    // Attach compact market data for validator (1.1) — not part of schema, stripped before logging
    decision._marketData = userContent;

    return decision;
  } catch (err) {
    log.error(`OpenAI error: ${err.message}`);
    return { action: 'hold', trades: [], reasoning: `AI error: ${err.message}` };
  }
}

/* ═══════════════════════════════════════════════════════════════════
   validateDecision() — Trade Decision Validator (1.1)
   Second AI call to review proposed trades before execution.
   If rejected, caller should fall back to hold.
   ═══════════════════════════════════════════════════════════════════ */

/**
 * Validate a trade decision using a second (cheap) AI model.
 * @param {string} marketData — the compact market data string sent to the trading AI
 * @param {object} decision — the parsed trading decision from analyzeAndDecide()
 * @returns {{ verdict: 'approve'|'reject', reasoning: string, flags: Array }}
 */
export async function validateDecision(marketData, decision) {
  const tradesSummary = (decision.trades || []).map(t =>
    `${t.strategy} ${t.type}: ${t.inputToken}→${t.outputToken} ${t.amountSol} SOL-notional` +
    (t.dex ? ` on ${t.dex}` : '') +
    (t.sequenceGroup ? ` seq=${t.sequenceGroup}` : '') +
    ` — ${t.reason || ''}`
  ).join('\n');

  const validatorInput = `PROPOSED TRADES:\n${tradesSummary}\n\nAI REASONING: ${decision.reasoning || ''}\nAI ANALYSIS: ${decision.marketAnalysis || ''}\n\nMARKET DATA:\n${marketData}`;

  try {
    const model = config.openaiModels?.validator || 'gpt-5-nano';
    log.info(`Validator AI — model: ${model}, cache_key: ${CACHE_KEY_VALIDATOR}, ${decision.trades?.length || 0} trades`);

    const resp = await client.responses.create({
      model,
      instructions: VALIDATOR_INSTRUCTIONS,
      input: validatorInput,
      text: { format: VALIDATOR_SCHEMA },
      store: false, // Store only the final decision, not the validation phase response
      prompt_cache_key: CACHE_KEY_VALIDATOR,
    });

    logCacheStats('validator', resp.usage);
    const text = resp.output_text || '{}';
    const result = JSON.parse(text);

    if (result.verdict === 'reject') {
      log.warn(`Validator REJECTED: ${result.reasoning}`);
      for (const f of result.flags || []) {
        log.warn(`  [${f.severity}] ${f.trade}: ${f.issue}`);
      }
    } else {
      const warnings = (result.flags || []).filter(f => f.severity === 'warning');
      if (warnings.length) {
        log.info(`Validator approved with ${warnings.length} warning(s): ${warnings.map(w => w.issue).join('; ')}`);
      } else {
        log.info(`Validator approved: ${result.reasoning}`);
      }
    }

    return result;
  } catch (err) {
    log.warn(`Validator AI error (proceeding with trades): ${err.message}`);
    return { verdict: 'approve', reasoning: `Validator error: ${err.message}`, flags: [] };
  }
}

/* ═══════════════════════════════════════════════════════════════════
   generateDailyReport() — Daily Report AI
   ═══════════════════════════════════════════════════════════════════ */

export async function generateDailyReport(context) {
  const userContent = `Daily report data:\n${JSON.stringify(context)}`;

  try {
    const previousResponseId = getResponseIdForChannel('daily-report');
    const model = config.openaiModels?.dailyReport || config.openaiModel;
    log.info(`Daily report AI — model: ${model}, cache_key: ${CACHE_KEY_DAILY_REPORT}`);

    const resp = await client.responses.create({
      model,
      instructions: DAILY_REPORT_INSTRUCTIONS,
      input: userContent,
      store: false,
      prompt_cache_key: CACHE_KEY_DAILY_REPORT,
      ...(previousResponseId && { previous_response_id: previousResponseId }),
    });

    logCacheStats('daily-report', resp.usage);
    const text = resp.output_text || 'No report generated.';

    setResponseIdForChannel('daily-report', resp.id);
    saveConversation('daily-report', 'user', userContent);
    saveConversation('daily-report', 'assistant', text);
    pruneConversation('daily-report', 20);

    return text;
  } catch (err) {
    log.error(`Daily report AI error: ${err.message}`);
    return `Report error: ${err.message}`;
  }
}

