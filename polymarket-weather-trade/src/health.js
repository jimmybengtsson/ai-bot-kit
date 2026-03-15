// src/health.js — Health checks for Polymarket API, wallet, disk
import { checkClobHealth, getBalance, getAddress } from './wallet.js';
import { createLogger } from './logger.js';
import { config } from './config.js';
import { execSync } from 'child_process';

const log = createLogger('health');

/**
 * Run all health checks. Returns { healthy, checks: [...] }.
 */
export async function runHealthChecks() {
  const checks = [];

  // 1. Polymarket CLOB API reachable
  try {
    const ok = await checkClobHealth();
    checks.push({ name: 'polymarket_clob', ok, detail: ok ? 'reachable' : 'unreachable' });
  } catch (err) {
    checks.push({ name: 'polymarket_clob', ok: false, detail: err.message });
  }

  // 2. Wallet configured
  try {
    const addr = getAddress();
    checks.push({ name: 'wallet', ok: !!addr, detail: addr || 'not configured' });
  } catch (err) {
    checks.push({ name: 'wallet', ok: false, detail: err.message });
  }

  // 3. Polymarket balance
  try {
    const bal = await getBalance();
    const ok = bal >= config.minBalanceStop;
    const warn = bal < config.minBalanceWarn;
    checks.push({
      name: 'balance',
      ok,
      detail: `$${bal.toFixed(2)} USDC.e${warn ? ' (LOW!)' : ''}`,
    });
  } catch (err) {
    checks.push({ name: 'balance', ok: false, detail: err.message });
  }

  // 4. OpenAI API key set
  try {
    const ok = !!(config.openaiApiKey && config.openaiApiKey.startsWith('sk-'));
    checks.push({ name: 'openai', ok, detail: ok ? 'configured' : 'missing or invalid' });
  } catch (err) {
    checks.push({ name: 'openai', ok: false, detail: err.message });
  }

  // 5. Disk space
  try {
    const output = execSync('df -h / | tail -1').toString();
    const parts = output.trim().split(/\s+/);
    const avail = parts[3] || 'unknown';
    const num = parseFloat(avail);
    const unit = avail.replace(/[0-9.]/g, '').toUpperCase();
    const mb = unit === 'G' ? num * 1024 : unit === 'T' ? num * 1024 * 1024 : num;
    const ok = mb > 500;
    checks.push({ name: 'disk', ok, detail: `${avail} available` });
  } catch (err) {
    checks.push({ name: 'disk', ok: false, detail: err.message });
  }

  const healthy = checks.every(c => c.ok);
  if (!healthy) {
    log.warn(`Health check failed: ${checks.filter(c => !c.ok).map(c => c.name).join(', ')}`);
  } else {
    log.debug('All health checks passed');
  }

  return { healthy, checks };
}
