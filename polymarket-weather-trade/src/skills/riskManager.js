// src/skills/riskManager.js — Risk manager for polymarket-weather-trade
import { config } from '../config.js';
import { createLogger } from '../logger.js';
import * as memory from '../memory.js';

const log = createLogger('riskManager');

class RiskManager {
  constructor() {
    this.currentBalance = null;
  }

  setBalance(balance) {
    this.currentBalance = balance;
  }

  getDynamicMinConfidence({ eventVolatilityPct = 0 } = {}) {
    const base = Number(config.minConfidence ?? 60);
    if (!config.volatilityConfidenceEnabled) return base;

    const volatility = Number(eventVolatilityPct || 0);
    const highThreshold = Number(config.volatilityHighPct || 18);
    const lowThreshold = Number(config.volatilityLowPct || 8);

    if (volatility >= highThreshold) {
      return base + Number(config.volatilityConfidenceBumpHigh || 7);
    }
    if (volatility >= lowThreshold) {
      return base + Number(config.volatilityConfidenceBumpLow || 3);
    }
    return base;
  }

  checkUniqueDailyExposureBudget(currentUniqueExposureCount) {
    const limit = config.maxDailyUniqueExposures ?? config.maxDailyBets ?? 12;
    const current = Number(currentUniqueExposureCount || 0);
    if (current >= limit) {
      return { allowed: false, reason: `Daily unique exposure budget reached (${current}/${limit})` };
    }
    return { allowed: true };
  }

  checkBetAllowed(decision, options = {}) {
    const activeCount = memory.getActiveBetCount();
    const maxActive = config.maxActiveBets ?? 5;
    if (activeCount >= maxActive) {
      return { allowed: false, reason: `Max active bets reached (${activeCount}/${maxActive})` };
    }

    const minConfidence = Number(options.minConfidenceOverride ?? config.minConfidence ?? 60);
    if (decision.confidence < minConfidence) {
      return {
        allowed: false,
        reason: `Confidence too low: ${decision.confidence}% < required ${minConfidence.toFixed(0)}%`,
      };
    }

    if ((decision.edge ?? 0) < (config.minEdge ?? 0.03)) {
      return { allowed: false, reason: `Edge too low: ${((decision.edge || 0) * 100).toFixed(1)}%` };
    }

    return { allowed: true };
  }

  canPlaceBet() {
    const activeCount = memory.getActiveBetCount();
    const maxActive = config.maxActiveBets ?? 5;
    if (activeCount >= maxActive) {
      return { allowed: false, reason: `Max active bets reached (${activeCount}/${maxActive})` };
    }

    if (this.currentBalance != null && this.currentBalance < (config.minBalanceStop ?? 1)) {
      return { allowed: false, reason: `Balance too low: $${this.currentBalance.toFixed(2)}` };
    }

    return { allowed: true };
  }

  validateOdds(price) {
    // Configured env bounds take precedence; defaults apply when env is unset.
    const minOdds = config.minOddsValue ?? 0.05;
    const maxOdds = config.maxOddsValue ?? 0.70;
    if (price < minOdds) return { valid: false, reason: `Price ${price} below min ${minOdds}` };
    if (price > maxOdds) return { valid: false, reason: `Price ${price} above max ${maxOdds}` };
    return { valid: true };
  }

  allSlotsFull() {
    const activeCount = memory.getActiveBetCount();
    const maxActive = config.maxActiveBets ?? 5;
    return activeCount >= maxActive;
  }

  calculateBetSize(decision) {
    const base = config.betSize ?? 2;
    const confidence = decision.confidence || 60;
    const edge = decision.edge || 0.03;

    let multiplier = 1.0;
    if (confidence >= 85 && edge >= 0.10) multiplier = 1.5;
    else if (confidence >= 75 && edge >= 0.07) multiplier = 1.25;
    else if (confidence < 65) multiplier = 0.75;

    const size = Math.round(base * multiplier * 100) / 100;
    const maxSize = (config.maxBetSize ?? base * 2);
    return Math.min(size, maxSize);
  }

  getStatus() {
    const activeCount = memory.getActiveBetCount();
    const counts = memory.getActiveCategoryCounts();
    const todayStats = memory.getTodayStats();
    const lowBalance = this.currentBalance != null && this.currentBalance < (config.minBalanceWarn ?? 20);
    return {
      activeBets: activeCount,
      maxActive: config.maxActiveBets ?? 5,
      balance: this.currentBalance,
      lowBalance,
      todayBetsPlaced: Number(todayStats?.bets_placed || 0),
      maxDailyUniqueExposures: Number(config.maxDailyUniqueExposures ?? config.maxDailyBets ?? 12),
      byCategory: counts,
    };
  }

  getSummary() {
    return this.getStatus();
  }
}

export const riskManager = new RiskManager();
