// src/skills/riskManager.js — Trade validation & circuit breakers
import { config, getStrategyHardMaxSol } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('riskManager');
import { addTrade, getRecentTrades } from '../runtimeStore.js';

class RiskManager {
  constructor() {
    this.initialBalance = 0;   // SOL-denominated
    this.currentBalance = 0;   // SOL-denominated
    this.consecutiveLosses = 0;
    this.degenConsecutiveLosses = 0;
    this.guardianConsecutiveLosses = 0;
    this.degenCooldownTicks = 0;    // ticks remaining in degen cooldown
    this.guardianCooldownTicks = 0; // ticks remaining in guardian cooldown
    this.halted = false;
    this.dailyTrades = [];
  }

  /** Set today's starting balance in SOL. Called once at start of each day / on init. */
  setBalance(balanceSol) {
    this.initialBalance = balanceSol;
    this.currentBalance = balanceSol;
    this.consecutiveLosses = 0;
    this.degenConsecutiveLosses = 0;
    this.guardianConsecutiveLosses = 0;
    this.degenCooldownTicks = 0;
    this.guardianCooldownTicks = 0;
    this.halted = false;
    this.dailyTrades = [];
    log.info(`Risk manager initialized: ${balanceSol} SOL`);
  }

  /** Update current balance in SOL (e.g. after portfolio refresh). */
  updateBalance(balanceSol) {
    this.currentBalance = balanceSol;
  }

  /**
   * Check if daily loss limit or profit target is already reached.
   * Use this early in the trading loop to skip expensive API calls.
   * @returns {{ limitReached: boolean, reason?: string }}
   */
  isDailyLimitReached() {
    if (this.halted) {
      return { limitReached: true, reason: 'Trading halted — daily loss limit hit' };
    }
    if (this.initialBalance <= 0) {
      return { limitReached: false }; // not initialized yet, let the loop proceed
    }
    const dailyPnlPct = ((this.currentBalance - this.initialBalance) / this.initialBalance) * 100;
    if (dailyPnlPct <= -config.risk.dailyLossLimitPct) {
      this.halted = true;
      return { limitReached: true, reason: `Daily loss limit ${config.risk.dailyLossLimitPct}% reached (${dailyPnlPct.toFixed(2)}%)` };
    }
    if (dailyPnlPct >= config.risk.dailyTargetPct) {
      return { limitReached: true, reason: `Daily target ${config.risk.dailyTargetPct}% reached (${dailyPnlPct.toFixed(2)}%) — taking profit` };
    }
    return { limitReached: false };
  }

  /**
   * Validate a trade proposal.
   * @param {object} proposal — { amountSol, strategy: 'degen'|'guardian' }
   * @returns {object} — { approved: boolean, reason?: string }
   */
  checkTrade(proposal) {
    if (this.halted) {
      return { approved: false, reason: 'Trading halted — daily loss limit hit' };
    }

    if (this.initialBalance <= 0) {
      return { approved: false, reason: 'Initial balance not set' };
    }

    const dailyPnlPct = ((this.currentBalance - this.initialBalance) / this.initialBalance) * 100;

    if (dailyPnlPct <= -config.risk.dailyLossLimitPct) {
      this.halted = true;
      return { approved: false, reason: `Daily loss limit ${config.risk.dailyLossLimitPct}% reached (${dailyPnlPct.toFixed(2)}% in SOL)` };
    }

    if (dailyPnlPct >= config.risk.dailyTargetPct) {
      return { approved: false, reason: `Daily target ${config.risk.dailyTargetPct}% reached (${dailyPnlPct.toFixed(2)}% in SOL) — taking profit` };
    }

    if (this.consecutiveLosses >= config.risk.cooldownAfterLosses) {
      return { approved: false, reason: `${config.risk.cooldownAfterLosses} consecutive losses — cooldown active` };
    }

    const amount = proposal.amountSol || 0;
    const strategy = proposal.strategy || 'degen';

    if (strategy === 'degen' && !config.risk.degenEnabled) {
      return { approved: false, reason: 'Degen strategy disabled (RISK_DEGEN_SHARE_PCT=0)' };
    }
    if (strategy === 'guardian' && !config.risk.guardianEnabled) {
      return { approved: false, reason: 'Guardian strategy disabled (RISK_DEGEN_SHARE_PCT=100)' };
    }
    if (strategy === 'combined' && (!config.risk.degenEnabled || !config.risk.guardianEnabled)) {
      return { approved: false, reason: 'Combined strategy requires both degen and guardian to be active' };
    }

    // Per-strategy cooldown enforcement (Proposal 4.1)
    if (strategy === 'degen' && this.degenCooldownTicks > 0) {
      return { approved: false, reason: `Degen cooldown active (${this.degenCooldownTicks} ticks remaining after ${config.risk.cooldownAfterLosses} consecutive degen losses)` };
    }
    if (strategy === 'guardian' && this.guardianCooldownTicks > 0) {
      return { approved: false, reason: `Guardian cooldown active (${this.guardianCooldownTicks} ticks remaining after ${config.risk.cooldownAfterLosses} consecutive guardian losses)` };
    }
    let maxPosition;
    let share;
    let maxPct;
    if (strategy === 'combined') {
      maxPosition = getStrategyHardMaxSol(this.currentBalance, 'combined');
    } else {
      share = strategy === 'guardian' ? config.risk.guardianShare : config.risk.degenShare;
      maxPct = strategy === 'guardian' ? config.risk.guardianMaxPct : config.risk.degenMaxPct;
      maxPosition = getStrategyHardMaxSol(this.currentBalance, strategy);
    }

    if (amount > maxPosition) {
      if (strategy === 'combined') {
        return { approved: false, reason: `${amount.toFixed(4)} SOL exceeds combined max ${maxPosition.toFixed(4)} SOL` };
      }
      return { approved: false, reason: `${amount.toFixed(4)} SOL exceeds ${strategy} max ${maxPosition.toFixed(4)} SOL (${maxPct}% of ${(share * 100)}% share)` };
    }

    return { approved: true };
  }

  /**
  * Record a completed trade result to update state + persist to runtime store.
   * @param {object} result — { pnlSol, amountSol, ... }
   */
  /**
   * Decrement per-strategy cooldown ticks. Call once at the start of each trading tick.
   */
  tickCooldowns() {
    if (this.degenCooldownTicks > 0) {
      this.degenCooldownTicks--;
      log.info(`Degen cooldown: ${this.degenCooldownTicks} ticks remaining`);
    }
    if (this.guardianCooldownTicks > 0) {
      this.guardianCooldownTicks--;
      log.info(`Guardian cooldown: ${this.guardianCooldownTicks} ticks remaining`);
    }
  }

  recordTrade(result) {
    const pnl = result.pnlSol || 0;
    this.currentBalance += pnl;

    if (pnl < 0) {
      this.consecutiveLosses++;
    } else {
      this.consecutiveLosses = 0;
    }

    // Per-strategy consecutive loss tracking
    const strategy = result.strategy || 'degen';
    if (strategy === 'degen' || strategy === 'combined') {
      if (pnl < 0) {
        this.degenConsecutiveLosses++;
        if (this.degenConsecutiveLosses >= config.risk.cooldownAfterLosses && this.degenCooldownTicks === 0) {
          this.degenCooldownTicks = 2;
          log.warn(`Degen cooldown triggered: ${this.degenConsecutiveLosses} consecutive losses → 2 tick cooldown`);
        }
      } else {
        this.degenConsecutiveLosses = 0;
      }
    }
    if (strategy === 'guardian' || strategy === 'combined') {
      if (pnl < 0) {
        this.guardianConsecutiveLosses++;
        if (this.guardianConsecutiveLosses >= config.risk.cooldownAfterLosses && this.guardianCooldownTicks === 0) {
          this.guardianCooldownTicks = 2;
          log.warn(`Guardian cooldown triggered: ${this.guardianConsecutiveLosses} consecutive losses → 2 tick cooldown`);
        }
      } else {
        this.guardianConsecutiveLosses = 0;
      }
    }

    const entry = {
      ...result,
      timestamp: new Date().toISOString(),
      balanceAfter: this.currentBalance,
    };
    this.dailyTrades.push(entry);

    // Persist in runtime store (skip if already recorded as pending and will be updated separately)
    if (!result.skipDb) addTrade(entry);
  }

  /** Get summary stats for daily report (SOL-denominated). */
  getDailySummary() {
    return {
      initialBalance: this.initialBalance,
      currentBalance: this.currentBalance,
      dailyPnl: Math.round((this.currentBalance - this.initialBalance) * 10000) / 10000,
      dailyPnlPct: this.initialBalance > 0
        ? Math.round(((this.currentBalance - this.initialBalance) / this.initialBalance) * 10000) / 100
        : 0,
      unit: 'SOL',
      tradeCount: this.dailyTrades.length,
      consecutiveLosses: this.consecutiveLosses,
      degenConsecutiveLosses: this.degenConsecutiveLosses,
      guardianConsecutiveLosses: this.guardianConsecutiveLosses,
      degenCooldownTicks: this.degenCooldownTicks,
      guardianCooldownTicks: this.guardianCooldownTicks,
      halted: this.halted,
    };
  }

  /** Load recent trades from runtime store (for AI context). */
  getRecentTrades(count = 10) {
    return getRecentTrades(count);
  }
}

// Singleton
export const riskManager = new RiskManager();
