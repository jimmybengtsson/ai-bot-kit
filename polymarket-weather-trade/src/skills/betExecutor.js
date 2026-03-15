// src/skills/betExecutor.js — Bet execution, status monitoring, and take-profit for polymarket-weather-trade
// Re-exports core trading functions from clob adapter and adds bet status monitoring.
import { config } from '../config.js';
import { createLogger, logDetailedError } from '../logger.js';
import * as clob from '../adapters/clob.js';

const log = createLogger('betExecutor');

// Re-export core trading functions from CLOB adapter
export const placeBet = clob.placeBet;
export const getPriceHistory = clob.getPriceHistory;
export const getPolymarketOpenOrders = clob.getPolymarketOpenOrders;
export const getPolymarketPositions = clob.getPolymarketPositions;
export const getCurrentExitPrice = clob.getCurrentExitPrice;
export const getCurrentEntryPrice = clob.getCurrentEntryPrice;

const lastSeenPriceByBetKey = new Map();
const PRICE_CHANGE_EPSILON = 0.0005;

function extractOrderTokenId(order) {
  return String(order?.tokenId || order?.token_id || order?.asset_id || order?.asset || '').trim();
}

function hasOpenSellOrderForToken(openOrders, tokenId) {
  const target = String(tokenId || '');
  if (!target || !Array.isArray(openOrders) || openOrders.length === 0) return false;
  return openOrders.some((o) => {
    const side = String(o?.side || o?.order_side || '').toUpperCase();
    if (side !== 'SELL') return false;
    return extractOrderTokenId(o) === target;
  });
}

function resolveEntryPrice(bet) {
  const direct = Number(bet?.odds_at_bet);
  if (Number.isFinite(direct) && direct > 0) return direct;

  const amount = Number(bet?.amount_usd);
  const shares = Number(bet?.shares);
  if (Number.isFinite(amount) && Number.isFinite(shares) && shares > 0) {
    const derived = amount / shares;
    if (Number.isFinite(derived) && derived > 0) return derived;
  }

  return 0;
}

function getBetPriceKey(bet) {
  const token = String(bet?.token_id || '').trim();
  if (token) return `token:${token}`;
  return `bet:${String(bet?.id || '')}`;
}

function getMinutesUntilEventEnd(bet) {
  const raw = bet?.event_end;
  if (!raw) return null;
  const endMs = new Date(raw).getTime();
  if (!Number.isFinite(endMs)) return null;
  return (endMs - Date.now()) / 60_000;
}

function getMarketClosedFlag(bet) {
  const raw = bet?.market_closed ?? bet?.closed ?? bet?.is_closed;
  if (raw === true || raw === false) return raw;
  const text = String(raw ?? '').trim().toLowerCase();
  if (!text) return null;
  if (text === 'true' || text === '1' || text === 'yes') return true;
  if (text === 'false' || text === '0' || text === 'no') return false;
  return null;
}

function isTakeProfitLockoutActive(bet, lockoutMinutes) {
  const marketClosed = getMarketClosedFlag(bet);
  if (marketClosed === true) return true;

  const minsToEnd = getMinutesUntilEventEnd(bet);
  if (!Number.isFinite(minsToEnd)) return false;

  // Signed offset semantics relative to event end:
  // - positive N: TP lockout starts N minutes BEFORE end.
  // - negative N: TP lockout starts |N| minutes AFTER end.
  return minsToEnd <= lockoutMinutes;
}

function formatTakeProfitPauseReason(bet, lockoutMinutes, minsToEnd, lockoutActive) {
  if (!lockoutActive) return '';

  const marketClosed = getMarketClosedFlag(bet);
  if (marketClosed === true) return '(TP paused, market closed=true) ';

  if (!Number.isFinite(minsToEnd)) return '(TP paused, lockout active) ';

  if (lockoutMinutes >= 0) {
    if (minsToEnd > 0) return `(TP paused, ${Math.max(0, Math.ceil(minsToEnd))}m to end) `;
    return '(TP paused, after event end) ';
  }

  const minsAfterEnd = Math.max(0, Math.ceil(-minsToEnd));
  return `(TP paused, ${minsAfterEnd}m after end window) `;
}

function formatTimeLeftHm(minutesToEnd) {
  if (!Number.isFinite(minutesToEnd)) return 'n/a';
  if (minutesToEnd <= 0) return '0h 0m';
  const total = Math.floor(minutesToEnd);
  const hours = Math.floor(total / 60);
  const mins = total % 60;
  return `${hours}h ${mins}m`;
}

/**
 * Check statuses of active bets and decide actions (take profit, stop loss, win, loss, hold).
 * Weather events resolve when the market closes — no in-play concept.
 *
 * @param {object[]} bets - Active bet rows from DB
 * @param {Function} updateBetStatus - DB function to update bet status
 * @param {Function} appendDailyLog - DB function to log daily activity
 * @param {Function} incrementSellAttempts - DB function to track sell attempts
 * @returns {object[]} Array of action results
 */
export async function checkBetStatuses(bets, updateBetStatus, appendDailyLog, incrementSellAttempts, openOrders = []) {
  const actions = [];

  const snapshots = [];
  const positionCheckRows = [];
  let anyPriceChanged = false;

  for (const bet of bets) {
    try {
      const currentPrice = await clob.getCurrentExitPrice(bet.token_id);
      if (currentPrice === null) {
        if (clob.isNoOrderbookCoolingDown?.(bet.token_id)) {
          log.debug(`No orderbook for bet #${bet.id} (token ${bet.token_id?.slice(0, 12)}) — skipping until cooldown`);
        } else {
          log.warn(`Could not fetch price for bet #${bet.id} (token ${bet.token_id?.slice(0, 12)})`);
        }
        continue;
      }

      const key = getBetPriceKey(bet);
      const prev = lastSeenPriceByBetKey.get(key);
      if (Number.isFinite(prev) && Math.abs(currentPrice - prev) >= PRICE_CHANGE_EPSILON) {
        anyPriceChanged = true;
      }
      if (!Number.isFinite(prev)) {
        // First observed price snapshot should emit a baseline log.
        anyPriceChanged = true;
      }
      lastSeenPriceByBetKey.set(key, currentPrice);

      snapshots.push({ bet, currentPrice });
    } catch (err) {
      logDetailedError(log, `Error fetching price for bet #${bet.id}`, err, {
        eventTitle: bet?.event_title || null,
        tokenId: bet?.token_id || null,
      });
    }
  }

  for (const { bet, currentPrice } of snapshots) {
    try {
      const buyPrice = resolveEntryPrice(bet);
      const shares = parseFloat(bet.shares || 1);
      const action = decideBetAction(bet, currentPrice, buyPrice);

      const tpPct = getDynamicTakeProfitPct(buyPrice);
      const slPct = config.stopLossPct ?? 0.25;
      const tpPrice = buyPrice > 0 ? buyPrice * (1 + tpPct) : Number.POSITIVE_INFINITY;
      const slPrice = buyPrice > 0 ? buyPrice * (1 - slPct) : Number.NEGATIVE_INFINITY;
      const tpLockoutMinutes = Number(config.takeProfitDisableBeforeEndMinutes || 0);
      const minsToEnd = getMinutesUntilEventEnd(bet);
      const tpLockoutActive = isTakeProfitLockoutActive(bet, tpLockoutMinutes);
      const shouldLogPositionCheck = anyPriceChanged;
      if (shouldLogPositionCheck) {
        const title = String(bet.event_title || 'Event').slice(0, 70);
        const pctChange = buyPrice > 0 ? ((currentPrice - buyPrice) / buyPrice) * 100 : null;
        const tpPauseText = formatTakeProfitPauseReason(bet, tpLockoutMinutes, minsToEnd, tpLockoutActive);
        positionCheckRows.push({
          pctChangeSort: Number.isFinite(pctChange) ? pctChange : Number.NEGATIVE_INFINITY,
          line:
            `Bet #${bet.id} "${title}" check: px=${currentPrice.toFixed(3)} buy=${buyPrice.toFixed(3)} `
            + `left=${formatTimeLeftHm(minsToEnd)} `
            + `chg=${Number.isFinite(pctChange) ? `${pctChange.toFixed(1)}%` : 'n/a'} `
            + `TP=${tpPrice.toFixed(3)} (${(tpPct * 100).toFixed(1)}%) `
            + `SL=${slPrice.toFixed(3)} (-${(slPct * 100).toFixed(1)}%) `
            + tpPauseText
            + `-> ${action}`,
        });
      }

      if (action === 'hold') continue;

      if ((action === 'take_profit' || action === 'stop_loss' || action === 'lost') && hasOpenSellOrderForToken(openOrders, bet.token_id)) {
        log.info(`Bet #${bet.id}: existing live SELL order found on token ${String(bet.token_id).slice(0, 12)}..., skipping duplicate ${action} sell`);
        continue;
      }

      if (action === 'take_profit') {
        const sellResult = await clob.sellShares({
          tokenId: bet.token_id,
          price: currentPrice,
          shares,
          negRisk: !!bet.neg_risk,
          tickSize: bet.tick_size || '0.01',
        });

        if (sellResult.success) {
          const exitPrice = Number.isFinite(Number(sellResult.executedPrice))
            ? Number(sellResult.executedPrice)
            : currentPrice;
          const pnl = (exitPrice - buyPrice) * shares;
          updateBetStatus(bet.id, 'won', 'take_profit', pnl);
          appendDailyLog(`TAKE PROFIT: "${bet.event_title?.slice(0, 40)}" — sold ${shares} shares at ${exitPrice.toFixed(3)} (buy ${buyPrice.toFixed(3)}), P&L: $${pnl.toFixed(4)}`);
          actions.push({ betId: bet.id, action: 'take_profit', eventTitle: bet.event_title, predictedOutcome: bet.predicted_outcome, buyPrice, sellPrice: exitPrice, pnl, shares });
        } else {
          const err = String(sellResult.error || '');
          if (err.includes('size_below_minimum') || err.includes('not enough balance / allowance') || err.includes('sell_cooldown_active')) {
            log.info(`Sell skipped for bet #${bet.id}: ${err}`);
          } else {
            incrementSellAttempts(bet.id);
            log.warn(`Sell failed for bet #${bet.id}: ${sellResult.error}`);
          }
        }
      } else if (action === 'stop_loss') {
        const sellResult = await clob.sellShares({
          tokenId: bet.token_id,
          price: currentPrice,
          shares,
          negRisk: !!bet.neg_risk,
          tickSize: bet.tick_size || '0.01',
          sellMode: 'stop_loss',
        });

        if (sellResult.success) {
          const exitPrice = Number.isFinite(Number(sellResult.executedPrice))
            ? Number(sellResult.executedPrice)
            : currentPrice;
          const pnl = (exitPrice - buyPrice) * shares;
          updateBetStatus(bet.id, 'lost', 'stop_loss', pnl);
          appendDailyLog(`STOP LOSS: "${bet.event_title?.slice(0, 40)}" — sold ${shares} shares at ${exitPrice.toFixed(3)} (buy ${buyPrice.toFixed(3)}), P&L: $${pnl.toFixed(4)}`);
          actions.push({ betId: bet.id, action: 'stop_loss', eventTitle: bet.event_title, predictedOutcome: bet.predicted_outcome, buyPrice, sellPrice: exitPrice, pnl, shares });
        } else {
          const err = String(sellResult.error || '');
          if (err.includes('size_below_minimum') || err.includes('not enough balance / allowance') || err.includes('sell_cooldown_active')) {
            log.info(`Stop-loss sell skipped for bet #${bet.id}: ${err}`);
          } else {
            incrementSellAttempts(bet.id);
            log.warn(`Stop-loss sell failed for bet #${bet.id}: ${sellResult.error}`);
          }
        }
      } else if (action === 'redeemed') {
        const pnl = (1 - buyPrice) * shares;
        updateBetStatus(bet.id, 'won', 'redeemed', pnl);
        appendDailyLog(`WIN: "${bet.event_title?.slice(0, 40)}" — redeemed at $1.00 (buy ${buyPrice.toFixed(3)}), P&L: $${pnl.toFixed(4)}`);
        actions.push({ betId: bet.id, action: 'redeemed', eventTitle: bet.event_title, predictedOutcome: bet.predicted_outcome, buyPrice, sellPrice: 1.0, pnl, shares });
      } else if (action === 'lost') {
        // Attempt to close the position on Polymarket so it no longer appears in active lists.
        const sellResult = await clob.sellShares({
          tokenId: bet.token_id,
          price: currentPrice,
          shares,
          negRisk: !!bet.neg_risk,
          tickSize: bet.tick_size || '0.01',
        });

        if (sellResult.success) {
          const exitPrice = Number.isFinite(Number(sellResult.executedPrice))
            ? Number(sellResult.executedPrice)
            : currentPrice;
          const pnl = (exitPrice - buyPrice) * shares;
          updateBetStatus(bet.id, 'lost', 'lost', pnl);
          appendDailyLog(`LOST EXIT: "${bet.event_title?.slice(0, 40)}" — sold ${shares} shares at ${exitPrice.toFixed(3)} (buy ${buyPrice.toFixed(3)}), P&L: $${pnl.toFixed(4)}`);
          actions.push({ betId: bet.id, action: 'lost', eventTitle: bet.event_title, predictedOutcome: bet.predicted_outcome, buyPrice, sellPrice: exitPrice, pnl, shares });
        } else {
          const err = String(sellResult.error || '');
          if (err.includes('size_below_minimum') || err.includes('not enough balance / allowance') || err.includes('sell_cooldown_active')) {
            log.info(`Loss-exit sell skipped for bet #${bet.id}: ${err}`);
          } else {
            incrementSellAttempts(bet.id);
            log.warn(`Loss-exit sell failed for bet #${bet.id}: ${sellResult.error}`);
          }
        }
      } else if (action === 'expired') {
        updateBetStatus(bet.id, 'expired', 'expired', 0);
        appendDailyLog(`EXPIRED: "${bet.event_title?.slice(0, 40)}" — event ended`);
        actions.push({ betId: bet.id, action: 'expired', eventTitle: bet.event_title, predictedOutcome: bet.predicted_outcome, buyPrice, sellPrice: currentPrice, pnl: 0, shares });
      }
    } catch (err) {
      logDetailedError(log, `Error checking bet #${bet.id}`, err, {
        eventTitle: bet?.event_title || null,
        tokenId: bet?.token_id || null,
      });
    }
  }

  if (anyPriceChanged && positionCheckRows.length > 0) {
    positionCheckRows
      .sort((a, b) => b.pctChangeSort - a.pctChangeSort)
      .forEach((row) => log.info(row.line));
  }

  return actions;
}

/**
 * Decide what action to take for a single bet based on current price.
 * Weather events: no in-play concept, relies purely on price movement.
 */
/**
 * Compute a dynamic take-profit percentage based on buy-in price.
 * Cheap shares (0.01) use LOW_BET_TAKE_PROFIT; expensive shares (0.99) use HIGH_BET_TAKE_PROFIT.
 * The curve is piecewise-linear: 4/5 of the range is consumed between 0.01-0.50,
 * and the remaining 1/5 between 0.50-0.99.
 */
export function getDynamicTakeProfitPct(buyPrice) {
  const low = (config.lowBetTakeProfit ?? 300) / 100;   // e.g. 300 → 3.00
  const high = (config.highBetTakeProfit ?? 5) / 100;   // e.g. 5   → 0.05
  const range = low - high;                              // positive when low > high

  const clamped = Math.max(0.01, Math.min(0.99, buyPrice));
  const midpoint = 0.50;

  if (clamped <= midpoint) {
    // 0.01-0.50: consume 4/5 of range (steep drop)
    const t = (clamped - 0.01) / (midpoint - 0.01);     // 0→1
    return low - (4 / 5) * range * t;
  }
  // 0.50-0.99: consume remaining 1/5 of range (gentle drop)
  const t = (clamped - midpoint) / (0.99 - midpoint);   // 0→1
  return low - (4 / 5) * range - (1 / 5) * range * t;
}

function decideBetAction(bet, currentPrice, buyPrice) {
  const takeProfitPct = getDynamicTakeProfitPct(buyPrice);
  const stopLossPct = config.stopLossPct ?? 0.25;
  const takeProfitDisableBeforeEndMinutes = Number(config.takeProfitDisableBeforeEndMinutes || 0);

  const takeProfitPrice = buyPrice > 0 ? buyPrice * (1 + takeProfitPct) : Number.POSITIVE_INFINITY;
  const stopLossPrice = buyPrice > 0 ? buyPrice * (1 - stopLossPct) : Number.NEGATIVE_INFINITY;

  // Apply signed lockout relative to event end.
  const tpLockoutActive = isTakeProfitLockoutActive(bet, takeProfitDisableBeforeEndMinutes);
  if (!tpLockoutActive && currentPrice >= takeProfitPrice && currentPrice > buyPrice) {
    return 'take_profit';
  }

  // Stop loss if price drops below configured threshold from entry
  if (currentPrice <= stopLossPrice && currentPrice < buyPrice) return 'stop_loss';

  return 'hold';
}
