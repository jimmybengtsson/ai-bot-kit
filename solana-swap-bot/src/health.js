// src/health.js — Health checks for RPC, wallet, disk
import { getSolBalance, getConnection } from './wallet.js';
import { createLogger } from './logger.js';

const log = createLogger('health');
import { execSync } from 'child_process';

/**
 * Run all health checks. Returns { healthy, checks: [...] }.
 */
export async function runHealthChecks() {
  const checks = [];

  // 1. RPC reachable
  try {
    const conn = getConnection();
    const slot = await conn.getSlot();
    checks.push({ name: 'rpc', ok: true, detail: `slot ${slot}` });
  } catch (err) {
    checks.push({ name: 'rpc', ok: false, detail: err.message });
  }

  // 2. Wallet balance (enough for fees)
  try {
    const bal = await getSolBalance();
    const ok = bal > 0.01;
    checks.push({ name: 'wallet', ok, detail: `${bal.toFixed(4)} SOL` });
  } catch (err) {
    checks.push({ name: 'wallet', ok: false, detail: err.message });
  }

  // 3. Disk space
  try {
    const output = execSync('df -h / | tail -1').toString();
    const parts = output.trim().split(/\s+/);
    const avail = parts[3] || 'unknown';
    // Parse available — e.g. "12G", "500M"
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
  }
  return { healthy, checks };
}
