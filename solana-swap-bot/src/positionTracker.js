// src/positionTracker.js — Track open/pending positions and their lifecycle
import { createLogger } from './logger.js';

const log = createLogger('positions');

/**
 * Position states:
 *   pending     — tx sent, awaiting on-chain confirmation
 *   confirmed   — tx confirmed on-chain
 *   failed      — tx failed on-chain (error in status)
 *   timeout     — confirmation polling timed out (3 min)
 *   cancelled   — cancelled by stale-position cron or sequence cascade
 *   limit_timeout — limit price never met during quote polling
 */

// In-memory position store
const positions = [];     // all positions (active + resolved)
const MAX_HISTORY = 200;  // keep last N resolved positions

/**
 * Open a new pending position.
 * @returns {string} positionId
 */
export function openPosition({ signature, inputToken, outputToken, inputMint, outputMint,
  amountSol, dex, strategy, type, reason, sequenceGroup, leg, isSequence }) {
  const id = `pos_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const pos = {
    id,
    signature,
    inputToken,
    outputToken,
    inputMint,
    outputMint,
    amountSol,
    dex: dex || '',
    strategy,
    type,
    reason: reason || '',
    sequenceGroup: sequenceGroup || 0,
    leg: leg || 0,
    isSequence: !!isSequence,
    status: 'pending',
    cancelReason: null,
    openedAt: new Date().toISOString(),
    resolvedAt: null,
    confirmationStatus: null,  // 'confirmed' | 'finalized' | null
  };
  positions.push(pos);
  log.info(`[OPEN] ${id} | ${inputToken}→${outputToken} | ${amountSol} SOL | sig=${signature} | dex=${dex || 'auto'} | seq=${sequenceGroup || 0} leg=${leg || 0}`);
  log.debug(`[OPEN] Full position: ${JSON.stringify(pos)}`);
  return id;
}

/**
 * Mark a position as confirmed on-chain.
 */
export function confirmPosition(positionId, confirmationStatus = 'confirmed') {
  const pos = positions.find(p => p.id === positionId);
  if (!pos) { log.warn(`[CONFIRM] Position not found: ${positionId}`); return; }
  pos.status = 'confirmed';
  pos.confirmationStatus = confirmationStatus;
  pos.resolvedAt = new Date().toISOString();
  log.info(`[CONFIRMED] ${positionId} | ${pos.inputToken}→${pos.outputToken} | status=${confirmationStatus} | age=${ageMs(pos)}ms`);
}

/**
 * Mark a position as failed/cancelled/timed out.
 */
export function resolvePosition(positionId, status, cancelReason = '') {
  const pos = positions.find(p => p.id === positionId);
  if (!pos) { log.warn(`[RESOLVE] Position not found: ${positionId}`); return; }
  pos.status = status;
  pos.cancelReason = cancelReason;
  pos.resolvedAt = new Date().toISOString();
  log.info(`[${status.toUpperCase()}] ${positionId} | ${pos.inputToken}→${pos.outputToken} | reason=${cancelReason} | age=${ageMs(pos)}ms`);
}

/**
 * Find a pending position by signature.
 */
export function findPendingBySignature(signature) {
  return positions.find(p => p.signature === signature && p.status === 'pending');
}

/**
 * Get all currently pending (unresolved) positions.
 */
export function getPendingPositions() {
  return positions.filter(p => p.status === 'pending');
}

/**
 * Get all active positions (pending).
 */
export function getActivePositions() {
  return positions.filter(p => p.status === 'pending');
}

/**
 * Get resolved positions (confirmed, failed, cancelled, timeout).
 */
export function getResolvedPositions(limit = 50) {
  return positions
    .filter(p => p.status !== 'pending')
    .slice(-limit);
}

/**
 * Get ALL positions for the API endpoint.
 */
export function getAllPositions() {
  return {
    active: getActivePositions(),
    resolved: getResolvedPositions(100),
    totalTracked: positions.length,
  };
}

/**
 * Get stale pending positions (older than given ms).
 */
export function getStalePendingPositions(maxAgeMs = 30 * 60 * 1000) {
  const cutoff = Date.now() - maxAgeMs;
  return positions.filter(p =>
    p.status === 'pending' && new Date(p.openedAt).getTime() < cutoff
  );
}

/**
 * Prune old resolved positions to cap memory usage.
 */
export function pruneHistory() {
  const resolved = positions.filter(p => p.status !== 'pending');
  if (resolved.length > MAX_HISTORY) {
    const toRemove = resolved.length - MAX_HISTORY;
    let removed = 0;
    for (let i = 0; i < positions.length && removed < toRemove; i++) {
      if (positions[i].status !== 'pending') {
        positions.splice(i, 1);
        removed++;
        i--;
      }
    }
    log.debug(`[PRUNE] Removed ${removed} old resolved positions, ${positions.length} remaining`);
  }
}

/** Helper: age of a position in ms */
function ageMs(pos) {
  return Date.now() - new Date(pos.openedAt).getTime();
}
