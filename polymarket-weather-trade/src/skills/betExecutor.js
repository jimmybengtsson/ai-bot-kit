// src/skills/betExecutor.js — Bet execution, status monitoring, and take-profit for polymarket-weather-trade
// Re-exports core trading functions from clob adapter and adds bet status monitoring.
import { config } from '../config.js';
import { createLogger, logDetailedError } from '../logger.js';
import * as clob from '../adapters/clob.js';
import { fetchTokenResolutionStateByTokenId } from '../adapters/gamma.js';
import { getTradingMode, isExecutionEnabled } from '../tradingMode.js';
import { incrementMetric, recordMetricEvent } from '../telemetryStore.js';
import { recordAuditEvent } from '../auditStore.js';
import {
  beginExecution,
  buildExecutionKey,
  canExecuteInScope,
  markExecutionFailed,
  markExecutionFilled,
  markExecutionPartialFill,
  markExecutionSubmitted,
  recordExecutionFailure,
  recordExecutionSuccess,
  recordIncident,
} from '../executionStore.js';

const log = createLogger('betExecutor');

// Re-export core trading functions from CLOB adapter
export const placeBet = clob.placeBet;
export const getPriceHistory = clob.getPriceHistory;
export const getPolymarketOpenOrders = clob.getPolymarketOpenOrders;
export const getPolymarketPositions = clob.getPolymarketPositions;
export const getCurrentExitPrice = clob.getCurrentExitPrice;
export const getCurrentEntryPrice = clob.getCurrentEntryPrice;
export const getLiquidityQuality = clob.getLiquidityQuality;

const lastSeenPriceByBetKey = new Map();
const closedObservedAtByBetKey = new Map();
const PRICE_CHANGE_EPSILON = 0.0005;
const REDEEMED_WIN_MIN_PRICE = 0.999;
const REDEEMED_LOSS_MAX_PRICE = 0.001;

function getResolutionGraceMinutes() {
  const configured = Number(config.resolutionGraceMinutes);
  if (!Number.isFinite(configured)) return 120;
  return Math.max(0, Math.round(configured));
}

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

function toDateMs(value) {
  if (!value) return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1e12 ? value : value * 1000;
  }
  const n = Number(value);
  if (Number.isFinite(n)) return n > 1e12 ? n : n * 1000;
  const ts = new Date(String(value)).getTime();
  if (Number.isFinite(ts)) return ts;
  const tsZ = new Date(`${String(value)}Z`).getTime();
  return Number.isFinite(tsZ) ? tsZ : null;
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

function observeClosedState(bet) {
  const key = getBetPriceKey(bet);
  const closed = getMarketClosedFlag(bet) === true;
  if (!closed) {
    closedObservedAtByBetKey.delete(key);
    return { key, closed: false, minutesSinceClosed: null };
  }

  let observedAtMs = closedObservedAtByBetKey.get(key);
  if (!Number.isFinite(observedAtMs)) {
    const seeded = toDateMs(
      bet?.market_closed_at
      || bet?.closed_at
      || bet?.resolution_at
      || bet?.resolved_at,
    );
    observedAtMs = Number.isFinite(seeded) ? seeded : Date.now();
    closedObservedAtByBetKey.set(key, observedAtMs);
  }

  return {
    key,
    closed: true,
    observedAtMs,
    minutesSinceClosed: (Date.now() - observedAtMs) / 60_000,
  };
}

function evaluateSettlementAction(bet, currentPrice, closedState = observeClosedState(bet)) {
  const decision = decideResolutionAction({
    marketClosed: closedState.closed,
    minutesSinceClosed: closedState.minutesSinceClosed,
    currentPrice,
    graceMinutes: getResolutionGraceMinutes(),
  });
  return { ...decision, closedState };
}

export function decideResolutionAction({ marketClosed, minutesSinceClosed, currentPrice, graceMinutes = 120 }) {
  if (!marketClosed) return { action: null, reason: 'market_open' };

  if (!Number.isFinite(minutesSinceClosed) || minutesSinceClosed < Math.max(0, Number(graceMinutes) || 0)) {
    return { action: null, reason: 'grace_window' };
  }

  if (!Number.isFinite(currentPrice)) {
    return { action: null, reason: 'no_terminal_price' };
  }

  if (currentPrice >= REDEEMED_WIN_MIN_PRICE) {
    return { action: 'redeemed', reason: 'terminal_win_price' };
  }
  if (currentPrice <= REDEEMED_LOSS_MAX_PRICE) {
    return { action: 'resolved_lost', reason: 'terminal_loss_price' };
  }

  return { action: null, reason: 'not_terminal_value' };
}

function computeDynamicTakeProfitLockoutMinutes(buyPrice, currentPrice) {
  // Data-driven lockout window (minutes before event end) based on risk profile:
  // - Lower entry prices imply higher variance and benefit from earlier de-risk lockout.
  // - Larger unrealized gains increase lockout to avoid late-window whipsaw exits.
  let minutes = 45;
  const safeBuy = Number.isFinite(buyPrice) ? buyPrice : 0;
  const safeNow = Number.isFinite(currentPrice) ? currentPrice : safeBuy;

  if (safeBuy > 0 && safeBuy <= 0.20) minutes += 30;
  if (safeBuy > 0 && safeBuy <= 0.08) minutes += 45;

  const pnlPct = safeBuy > 0 ? ((safeNow - safeBuy) / safeBuy) * 100 : 0;
  if (pnlPct >= 150) minutes += 90;
  else if (pnlPct >= 80) minutes += 60;
  else if (pnlPct >= 40) minutes += 30;

  if (safeNow >= 0.90 || safeNow <= 0.10) minutes += 15;

  return Math.max(15, Math.min(240, Math.round(minutes)));
}

function evaluateTakeProfitLockout(bet, buyPrice, currentPrice) {
  const marketClosed = getMarketClosedFlag(bet);
  if (marketClosed === true) {
    return {
      active: true,
      minsToEnd: getMinutesUntilEventEnd(bet),
      lockoutMinutes: null,
      reason: 'market_closed',
    };
  }

  const minsToEnd = getMinutesUntilEventEnd(bet);
  if (!Number.isFinite(minsToEnd)) {
    return {
      active: false,
      minsToEnd,
      lockoutMinutes: null,
      reason: 'no_event_end',
    };
  }

  // Event end time can drift from actual market closure. If event_end has passed
  // but the market is still open, avoid hard-pausing TP based on event_end alone.
  if (minsToEnd <= 0) {
    return {
      active: false,
      minsToEnd,
      lockoutMinutes: null,
      reason: 'event_end_passed_market_open',
    };
  }

  const lockoutMinutes = computeDynamicTakeProfitLockoutMinutes(buyPrice, currentPrice);
  return {
    active: minsToEnd <= lockoutMinutes,
    minsToEnd,
    lockoutMinutes,
    reason: minsToEnd <= lockoutMinutes ? 'dynamic_window' : 'outside_window',
  };
}

function formatTakeProfitPauseReason(lockoutState) {
  if (!lockoutState?.active) return '';
  if (lockoutState.reason === 'market_closed') return '(TP paused, market closed=true) ';
  if (!Number.isFinite(lockoutState.minsToEnd)) return '(TP paused, lockout active) ';

  if (lockoutState.minsToEnd > 0) {
    return `(TP paused, ${Math.max(0, Math.ceil(lockoutState.minsToEnd))}m to end <= dynamic ${lockoutState.lockoutMinutes}m window) `;
  }
  return '(TP paused, after event end) ';
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
 * Settlement is conservative: closed markets must pass grace window and terminal
 * payout-like prices before automatic won/lost resolution.
 *
 * @param {object[]} bets - Active bet rows from DB
 * @param {Function} updateBetStatus - DB function to update bet status
 * @param {Function} appendDailyLog - DB function to log daily activity
 * @param {Function} incrementSellAttempts - DB function to track sell attempts
 * @returns {object[]} Array of action results
 */
export async function checkBetStatuses(bets, updateBetStatus, appendDailyLog, incrementSellAttempts, openOrders = []) {
  const actions = [];
  const resolutionGraceMinutes = getResolutionGraceMinutes();

  async function executeManagedSell({ bet, currentPrice, shares, buyPrice, action, sellMode = 'default' }) {
    const mode = getTradingMode();
    if (!isExecutionEnabled(mode)) {
      const reason = `Trading mode ${mode} blocks exit execution`;
      incrementMetric('gate_rejection', 1, { source: 'exit_mode', mode, action });
      appendDailyLog(`SKIP EXIT: "${bet.event_title?.slice(0, 40)}" — ${reason}`);
      return { skipped: true, reason };
    }

    const scope = `${String(bet.event_id || bet.market_id || 'unknown')}::${String(bet.token_id || '').slice(0, 16)}`;
    const breaker = canExecuteInScope(scope);
    if (!breaker.allowed) {
      const untilIso = breaker.openUntilMs ? new Date(breaker.openUntilMs).toISOString() : 'n/a';
      const reason = `Circuit breaker open until ${untilIso}`;
      incrementMetric('gate_rejection', 1, { source: 'exit_breaker', action, scope });
      appendDailyLog(`SKIP EXIT: "${bet.event_title?.slice(0, 40)}" — ${reason}`);
      return { skipped: true, reason };
    }

    const key = buildExecutionKey({
      kind: 'exit',
      eventId: bet.event_id,
      tokenId: bet.token_id,
      action,
      side: 'SELL',
      suffix: 'v1',
    });

    const started = beginExecution({
      key,
      kind: 'exit',
      scope,
      payload: {
        betId: bet.id,
        eventTitle: bet.event_title,
        predictedOutcome: bet.predicted_outcome,
        action,
        currentPrice,
        buyPrice,
        shares,
      },
    });
    if (!started.ok) {
      incrementMetric('gate_rejection', 1, { source: 'exit_idempotency', action, reason: started.reason || 'already_started' });
      return { skipped: true, reason: started.reason, duplicate: true };
    }

    incrementMetric('order_attempt', 1, { source: 'exit', action });
    recordAuditEvent('exit_order_attempt', {
      key,
      action,
      tokenId: bet.token_id,
      betId: bet.id,
      expectedPrice: currentPrice,
      expectedShares: shares,
    }, 'betExecutor');

    let sellResult;
    try {
      sellResult = await clob.sellShares({
        tokenId: bet.token_id,
        price: currentPrice,
        shares,
        negRisk: !!bet.neg_risk,
        tickSize: bet.tick_size || '0.01',
        sellMode,
      });
    } catch (err) {
      markExecutionFailed(key, err.message, { stage: 'submit_exception' });
      recordExecutionFailure(scope, err.message);
      recordIncident('exit_submit_exception', {
        key,
        scope,
        betId: bet.id,
        error: err.message,
      });
      return { success: false, error: err.message };
    }

    if (sellResult?.success) {
      markExecutionSubmitted(key, {
        orderId: sellResult.orderId,
        status: sellResult.status,
        tokenId: bet.token_id,
        expectedPrice: currentPrice,
        expectedShares: shares,
        sharesRequested: shares,
      });

      const statusText = String(sellResult.status || '').toLowerCase();
      if (statusText.includes('partial')) {
        markExecutionPartialFill(key, {
          orderId: sellResult.orderId,
          shares,
          mode: action,
        });
        recordIncident('partial_fill', {
          key,
          scope,
          betId: bet.id,
          action,
        });
      }

      markExecutionFilled(key, {
        orderId: sellResult.orderId,
        status: sellResult.status,
      });
      recordExecutionSuccess(scope);
      incrementMetric('fill', 1, { source: 'exit', action });
      recordAuditEvent('exit_order_result', {
        key,
        action,
        betId: bet.id,
        status: 'filled',
        orderId: sellResult.orderId,
        shares,
      }, 'betExecutor');
      return sellResult;
    }

    markExecutionFailed(key, sellResult?.error || 'sell_failed', {
      stage: 'submit_response',
      status: sellResult?.status,
    });
    recordExecutionFailure(scope, sellResult?.error || 'sell_failed');
    return sellResult;
  }

  const snapshots = [];
  const positionCheckRows = [];
  let anyPriceChanged = false;

  for (const bet of bets) {
    const closedState = observeClosedState(bet);
    try {
      let currentPrice = await clob.getCurrentExitPrice(bet.token_id);
      let settlementPrice = currentPrice;

      let resolutionState = null;
      if (closedState.closed) {
        resolutionState = await fetchTokenResolutionStateByTokenId(bet.token_id).catch(() => null);
        if (resolutionState?.closed === true && Number.isFinite(resolutionState.closedAtMs)) {
          const key = getBetPriceKey(bet);
          const existing = closedObservedAtByBetKey.get(key);
          const externalClosedAt = resolutionState.closedAtMs;
          if (!Number.isFinite(existing) || externalClosedAt < existing) {
            closedObservedAtByBetKey.set(key, externalClosedAt);
            closedState.observedAtMs = externalClosedAt;
            closedState.minutesSinceClosed = (Date.now() - externalClosedAt) / 60_000;
          }
        }

        if (!Number.isFinite(settlementPrice) && Number.isFinite(resolutionState?.terminalPrice)) {
          settlementPrice = Number(resolutionState.terminalPrice);
        }
      }

      if (currentPrice === null) {
        incrementMetric('no_orderbook', 1, { tokenId: String(bet.token_id || '') });
        recordMetricEvent('no_orderbook', {
          betId: bet.id,
          tokenId: String(bet.token_id || ''),
          cooldown: !!clob.isNoOrderbookCoolingDown?.(bet.token_id),
        }, { severity: 'warn' });
        if (clob.isNoOrderbookCoolingDown?.(bet.token_id)) {
          log.debug(`No orderbook for bet #${bet.id} (token ${bet.token_id?.slice(0, 12)}) — skipping until cooldown`);
        } else {
          log.warn(`Could not fetch price for bet #${bet.id} (token ${bet.token_id?.slice(0, 12)})`);
        }

        if (closedState.closed) {
          const fallbackDecision = decideResolutionAction({
            marketClosed: true,
            minutesSinceClosed: closedState.minutesSinceClosed,
            currentPrice: settlementPrice,
            graceMinutes: resolutionGraceMinutes,
          });

          if (fallbackDecision.action) {
            const buyPrice = resolveEntryPrice(bet);
            const shares = parseFloat(bet.shares || 1);
            if (fallbackDecision.action === 'redeemed') {
              const pnl = (1 - buyPrice) * shares;
              updateBetStatus(bet.id, 'won', 'redeemed', pnl);
              appendDailyLog(`WIN: "${bet.event_title?.slice(0, 40)}" — resolved via Gamma terminal state at $1.00 (buy ${buyPrice.toFixed(3)}), P&L: $${pnl.toFixed(4)}`);
              actions.push({ betId: bet.id, action: 'redeemed', eventTitle: bet.event_title, predictedOutcome: bet.predicted_outcome, buyPrice, sellPrice: 1.0, pnl, shares });
            } else if (fallbackDecision.action === 'resolved_lost') {
              const pnl = (0 - buyPrice) * shares;
              updateBetStatus(bet.id, 'lost', 'redeemed_lost', pnl);
              appendDailyLog(`LOSS: "${bet.event_title?.slice(0, 40)}" — resolved via Gamma terminal state at $0.00 (buy ${buyPrice.toFixed(3)}), P&L: $${pnl.toFixed(4)}`);
              actions.push({ betId: bet.id, action: 'resolved_lost', eventTitle: bet.event_title, predictedOutcome: bet.predicted_outcome, buyPrice, sellPrice: 0.0, pnl, shares });
            }
            continue;
          }

          if (closedState.minutesSinceClosed >= resolutionGraceMinutes) {
            log.info(
              `Bet #${bet.id} market closed ${Math.floor(closedState.minutesSinceClosed)}m ago but no executable/gamma terminal price yet; deferring auto-resolution`,
            );
          } else {
            log.debug(
              `Bet #${bet.id} market closed ${Math.floor(closedState.minutesSinceClosed)}m ago; waiting ${resolutionGraceMinutes}m grace before settlement checks`,
            );
          }
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

      snapshots.push({ bet, currentPrice, settlementPrice, closedState });
    } catch (err) {
      logDetailedError(log, `Error fetching price for bet #${bet.id}`, err, {
        eventTitle: bet?.event_title || null,
        tokenId: bet?.token_id || null,
      });
    }
  }

  for (const { bet, currentPrice, settlementPrice, closedState } of snapshots) {
    try {
      const buyPrice = resolveEntryPrice(bet);
      const shares = parseFloat(bet.shares || 1);
      const settlement = evaluateSettlementAction(bet, settlementPrice, closedState);
      const action = settlement.action || decideBetAction(bet, currentPrice, buyPrice);

      const tpPct = getDynamicTakeProfitPct(buyPrice);
      const slPct = config.stopLossPct ?? 0.25;
      const tpPrice = buyPrice > 0 ? buyPrice * (1 + tpPct) : Number.POSITIVE_INFINITY;
      const slPrice = buyPrice > 0 ? buyPrice * (1 - slPct) : Number.NEGATIVE_INFINITY;
      const tpLockout = evaluateTakeProfitLockout(bet, buyPrice, currentPrice);
      const shouldLogPositionCheck = anyPriceChanged;
      if (shouldLogPositionCheck) {
        const title = String(bet.event_title || 'Event').slice(0, 70);
        const pctChange = buyPrice > 0 ? ((currentPrice - buyPrice) / buyPrice) * 100 : null;
        const tpPauseText = formatTakeProfitPauseReason(tpLockout);
        positionCheckRows.push({
          pctChangeSort: Number.isFinite(pctChange) ? pctChange : Number.NEGATIVE_INFINITY,
          line:
            `Bet #${bet.id} "${title}" check: px=${currentPrice.toFixed(3)} buy=${buyPrice.toFixed(3)} `
            + `left=${formatTimeLeftHm(tpLockout.minsToEnd)} `
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
        incrementMetric('take_profit_triggered', 1, { betId: bet.id });
        const sellResult = await executeManagedSell({ bet, currentPrice, shares, buyPrice, action: 'take_profit' });

        if (sellResult.success) {
          const exitPrice = Number.isFinite(Number(sellResult.executedPrice))
            ? Number(sellResult.executedPrice)
            : currentPrice;
          const pnl = (exitPrice - buyPrice) * shares;
          updateBetStatus(bet.id, 'won', 'take_profit', pnl);
          appendDailyLog(`TAKE PROFIT: "${bet.event_title?.slice(0, 40)}" — sold ${shares} shares at ${exitPrice.toFixed(3)} (buy ${buyPrice.toFixed(3)}), P&L: $${pnl.toFixed(4)}`);
          actions.push({ betId: bet.id, action: 'take_profit', eventTitle: bet.event_title, predictedOutcome: bet.predicted_outcome, buyPrice, sellPrice: exitPrice, pnl, shares });
        } else {
          if (sellResult?.skipped) {
            log.info(`Sell skipped for bet #${bet.id}: ${sellResult.reason || 'managed skip'}`);
            continue;
          }
          const err = String(sellResult.error || '');
          if (err.includes('size_below_minimum') || err.includes('not enough balance / allowance') || err.includes('sell_cooldown_active')) {
            log.info(`Sell skipped for bet #${bet.id}: ${err}`);
          } else {
            incrementSellAttempts(bet.id);
            log.warn(`Sell failed for bet #${bet.id}: ${sellResult.error}`);
          }
        }
      } else if (action === 'stop_loss') {
        incrementMetric('stop_loss_triggered', 1, { betId: bet.id });
        const sellResult = await executeManagedSell({ bet, currentPrice, shares, buyPrice, action: 'stop_loss', sellMode: 'stop_loss' });

        if (sellResult.success) {
          const exitPrice = Number.isFinite(Number(sellResult.executedPrice))
            ? Number(sellResult.executedPrice)
            : currentPrice;
          const pnl = (exitPrice - buyPrice) * shares;
          updateBetStatus(bet.id, 'lost', 'stop_loss', pnl);
          appendDailyLog(`STOP LOSS: "${bet.event_title?.slice(0, 40)}" — sold ${shares} shares at ${exitPrice.toFixed(3)} (buy ${buyPrice.toFixed(3)}), P&L: $${pnl.toFixed(4)}`);
          actions.push({ betId: bet.id, action: 'stop_loss', eventTitle: bet.event_title, predictedOutcome: bet.predicted_outcome, buyPrice, sellPrice: exitPrice, pnl, shares });
        } else {
          if (sellResult?.skipped) {
            log.info(`Stop-loss sell skipped for bet #${bet.id}: ${sellResult.reason || 'managed skip'}`);
            continue;
          }
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
        appendDailyLog(`WIN: "${bet.event_title?.slice(0, 40)}" — redeemed at terminal value $1.00 (buy ${buyPrice.toFixed(3)}), P&L: $${pnl.toFixed(4)}`);
        actions.push({ betId: bet.id, action: 'redeemed', eventTitle: bet.event_title, predictedOutcome: bet.predicted_outcome, buyPrice, sellPrice: 1.0, pnl, shares });
      } else if (action === 'resolved_lost') {
        const pnl = (0 - buyPrice) * shares;
        updateBetStatus(bet.id, 'lost', 'redeemed_lost', pnl);
        appendDailyLog(`LOSS: "${bet.event_title?.slice(0, 40)}" — resolved at terminal value $0.00 (buy ${buyPrice.toFixed(3)}), P&L: $${pnl.toFixed(4)}`);
        actions.push({ betId: bet.id, action: 'resolved_lost', eventTitle: bet.event_title, predictedOutcome: bet.predicted_outcome, buyPrice, sellPrice: 0.0, pnl, shares });
      } else if (action === 'lost') {
        // Attempt to close the position on Polymarket so it no longer appears in active lists.
        const sellResult = await executeManagedSell({ bet, currentPrice, shares, buyPrice, action: 'lost' });

        if (sellResult.success) {
          const exitPrice = Number.isFinite(Number(sellResult.executedPrice))
            ? Number(sellResult.executedPrice)
            : currentPrice;
          const pnl = (exitPrice - buyPrice) * shares;
          updateBetStatus(bet.id, 'lost', 'lost', pnl);
          appendDailyLog(`LOST EXIT: "${bet.event_title?.slice(0, 40)}" — sold ${shares} shares at ${exitPrice.toFixed(3)} (buy ${buyPrice.toFixed(3)}), P&L: $${pnl.toFixed(4)}`);
          actions.push({ betId: bet.id, action: 'lost', eventTitle: bet.event_title, predictedOutcome: bet.predicted_outcome, buyPrice, sellPrice: exitPrice, pnl, shares });
        } else {
          if (sellResult?.skipped) {
            log.info(`Loss-exit sell skipped for bet #${bet.id}: ${sellResult.reason || 'managed skip'}`);
            continue;
          }
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

export function decideBetAction(bet, currentPrice, buyPrice) {
  const takeProfitPct = getDynamicTakeProfitPct(buyPrice);
  const stopLossPct = config.stopLossPct ?? 0.25;

  const takeProfitPrice = buyPrice > 0 ? buyPrice * (1 + takeProfitPct) : Number.POSITIVE_INFINITY;
  const stopLossPrice = buyPrice > 0 ? buyPrice * (1 - stopLossPct) : Number.NEGATIVE_INFINITY;

  const tpLockoutActive = evaluateTakeProfitLockout(bet, buyPrice, currentPrice).active;
  if (!tpLockoutActive && currentPrice >= takeProfitPrice && currentPrice > buyPrice) {
    return 'take_profit';
  }

  // Stop loss if price drops below configured threshold from entry
  if (currentPrice <= stopLossPrice && currentPrice < buyPrice) return 'stop_loss';

  return 'hold';
}
