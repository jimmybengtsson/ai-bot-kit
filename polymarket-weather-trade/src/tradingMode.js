// src/tradingMode.js — Runtime trading mode source of truth
import { getSetting } from './settingsStore.js';

const ALLOWED = new Set(['off', 'shadow', 'paper', 'live']);

function normalize(raw) {
  const mode = String(raw || '').trim().toLowerCase();
  return ALLOWED.has(mode) ? mode : '';
}

export function getTradingMode() {
  const explicit = normalize(getSetting('TRADING_MODE', ''));
  if (explicit) return explicit;
  return 'paper';
}

export function isExecutionEnabled(mode = getTradingMode()) {
  return mode === 'paper' || mode === 'live';
}

export function isOffMode(mode = getTradingMode()) {
  return mode === 'off';
}

export function describeTradingMode(mode = getTradingMode()) {
  if (mode === 'off') return 'Execution disabled (no new orders)';
  if (mode === 'shadow') return 'Decision-only mode (analyze but do not place orders)';
  if (mode === 'paper') return 'Paper mode (simulated orders)';
  return 'Live mode (real orders)';
}

export function parseAndValidateMode(rawMode) {
  const mode = normalize(rawMode);
  if (!mode) {
    return {
      valid: false,
      mode: null,
      allowed: Array.from(ALLOWED),
      error: 'Mode must be one of: off, shadow, paper, live',
    };
  }

  return { valid: true, mode };
}
