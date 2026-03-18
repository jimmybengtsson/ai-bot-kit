// src/executionStore.js — Durable idempotency, execution lifecycle, and circuit breakers
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { createLogger } from './logger.js';
import { config } from './config.js';
import { recordAuditEvent, recordReconciliation, getReconciliationEvents } from './auditStore.js';
import { incrementMetric, recordMetricEvent } from './telemetryStore.js';
import { nowIso } from './utils/runtimeTime.js';

const log = createLogger('executionStore');
const STATE_FILE = process.env.EXECUTION_STATE_FILE
  ? path.resolve(process.cwd(), process.env.EXECUTION_STATE_FILE)
  : path.resolve(process.cwd(), 'data', 'execution-state.json');

const TERMINAL_STATES = new Set(['completed', 'failed']);
const ALLOWED_TRANSITIONS = {
  idle: new Set(['submit_started', 'failed']),
  submit_started: new Set(['submitted', 'failed']),
  submitted: new Set(['ack_wait', 'partial_fill', 'filled', 'failed']),
  ack_wait: new Set(['partial_fill', 'filled', 'failed']),
  partial_fill: new Set(['cancel_started', 'unwind_started', 'filled', 'failed']),
  cancel_started: new Set(['unwind_started', 'failed', 'completed']),
  unwind_started: new Set(['completed', 'failed']),
  filled: new Set(['completed', 'failed']),
  failed: new Set([]),
  completed: new Set([]),
};

const state = {
  records: new Map(),
  breakers: new Map(),
  expectedFills: new Map(),
  incidents: [],
  reconciliations: [],
  loaded: false,
};

function ensureLoaded() {
  if (state.loaded) return;
  state.loaded = true;

  if (!existsSync(STATE_FILE)) return;

  try {
    const raw = JSON.parse(readFileSync(STATE_FILE, 'utf8') || '{}');
    for (const row of raw?.records || []) {
      if (!row?.key) continue;
      state.records.set(String(row.key), row);
    }
    for (const row of raw?.breakers || []) {
      if (!row?.scope) continue;
      state.breakers.set(String(row.scope), row);
    }
    for (const row of raw?.expectedFills || []) {
      if (!row?.key) continue;
      state.expectedFills.set(String(row.key), row);
    }
    state.incidents = Array.isArray(raw?.incidents) ? raw.incidents.slice(-500) : [];
    state.reconciliations = Array.isArray(raw?.reconciliations) ? raw.reconciliations.slice(-2000) : [];
  } catch (err) {
    log.warn(`Failed loading execution store: ${err.message}`);
  }
}

function persist() {
  mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  const payload = {
    updatedAt: nowIso(),
    records: Array.from(state.records.values()).slice(-3000),
    breakers: Array.from(state.breakers.values()),
    expectedFills: Array.from(state.expectedFills.values()).slice(-3000),
    incidents: state.incidents.slice(-500),
    reconciliations: state.reconciliations.slice(-2000),
  };
  writeFileSync(STATE_FILE, JSON.stringify(payload, null, 2), 'utf8');
}

function extractTokenIdFromKey(key) {
  const parts = String(key || '').split(':');
  return String(parts[2] || '').trim();
}

function buildExpectedFillFromRecord(record, meta = {}) {
  const staleMs = Math.max(30_000, Number(config.expectedFillStaleMs || 180_000));
  const createdAt = nowIso();
  return {
    key: String(record.key || ''),
    orderId: String(meta.orderId || '').trim() || null,
    kind: String(record.kind || 'unknown'),
    scope: String(record.scope || 'global'),
    tokenId: String(meta.tokenId || record.payload?.tokenId || extractTokenIdFromKey(record.key) || ''),
    expectedPrice: Number(meta.expectedPrice ?? record.payload?.price ?? record.payload?.currentPrice ?? 0),
    expectedShares: Number(meta.expectedShares ?? meta.sharesRequested ?? record.payload?.shares ?? 0),
    submittedAt: createdAt,
    staleAfterMs: staleMs,
    state: 'pending',
    observedPrice: null,
    observedShares: null,
    mismatchReason: null,
    updatedAt: createdAt,
  };
}

function pctDiff(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return null;
  return Math.abs((a - b) / b);
}

function transitionExecution(key, nextState, patch = {}) {
  ensureLoaded();
  const current = state.records.get(key);
  if (!current) return null;

  const from = String(current.state || 'idle');
  const allowed = ALLOWED_TRANSITIONS[from] || new Set();
  if (from !== nextState && !allowed.has(nextState)) {
    recordIncident('execution_invalid_transition', {
      key,
      from,
      to: nextState,
    });
    return current;
  }

  const updated = {
    ...current,
    ...patch,
    state: nextState,
    updatedAt: nowIso(),
    terminal: TERMINAL_STATES.has(nextState),
  };
  state.records.set(key, updated);
  persist();
  return updated;
}

export function buildExecutionKey(parts = {}) {
  const kind = String(parts.kind || 'unknown').trim();
  const tokenId = String(parts.tokenId || '').trim();
  const eventId = String(parts.eventId || '').trim();
  const action = String(parts.action || '').trim();
  const side = String(parts.side || '').trim().toUpperCase();
  const scope = String(parts.scope || '').trim();
  const suffix = String(parts.suffix || '').trim();
  return [kind, eventId, tokenId, action, side, scope, suffix].filter(Boolean).join(':');
}

export function beginExecution({ key, kind, scope, payload = {} }) {
  ensureLoaded();
  const now = nowIso();
  const existing = state.records.get(key);

  if (existing?.terminal) {
    return { ok: false, reason: 'terminal_duplicate', record: existing };
  }

  if (existing && !existing.terminal) {
    return { ok: false, reason: 'already_in_flight', record: existing };
  }

  const next = {
    key,
    kind: String(kind || 'unknown'),
    scope: String(scope || ''),
    payload,
    state: 'submit_started',
    attempts: (existing?.attempts || 0) + 1,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    terminal: false,
    orderId: existing?.orderId || null,
    error: null,
  };
  state.records.set(key, next);
  persist();
  return { ok: true, record: next };
}

export function markExecutionSubmitted(key, meta = {}) {
  const cur = state.records.get(key);
  if (!cur) return null;
  const afterSubmitted = transitionExecution(key, 'submitted', {
    orderId: meta.orderId || cur.orderId || null,
    submitMeta: { ...(cur.submitMeta || {}), ...meta },
  });
  const ack = transitionExecution(key, 'ack_wait', {
    orderId: meta.orderId || afterSubmitted?.orderId || null,
  });

  const expected = buildExpectedFillFromRecord(cur, meta);
  state.expectedFills.set(String(key), expected);
  recordAuditEvent('order_submit', {
    key,
    orderId: expected.orderId,
    tokenId: expected.tokenId,
    expectedPrice: expected.expectedPrice,
    expectedShares: expected.expectedShares,
  }, 'executionStore');
  incrementMetric('order_submit', 1, { kind: cur.kind || 'unknown' });
  persist();
  return ack;
}

export function markExecutionPartialFill(key, meta = {}) {
  return transitionExecution(key, 'partial_fill', {
    partialFill: {
      ...(state.records.get(key)?.partialFill || {}),
      ...meta,
      at: nowIso(),
    },
  });
}

export function markExecutionFilled(key, meta = {}) {
  const filled = transitionExecution(key, 'filled', {
    fillMeta: {
      ...(state.records.get(key)?.fillMeta || {}),
      ...meta,
      at: nowIso(),
    },
  });
  if (!filled) return null;
  const completed = transitionExecution(key, 'completed', {
    completedReason: 'filled',
  });

  const expected = state.expectedFills.get(String(key));
  if (expected) {
    expected.state = 'observed_filled';
    expected.updatedAt = nowIso();
    state.expectedFills.set(String(key), expected);
  }

  incrementMetric('fill', 1, { kind: filled.kind || 'unknown' });
  recordAuditEvent('fill', {
    key,
    orderId: meta.orderId || filled.orderId || null,
    status: meta.status || null,
  }, 'executionStore');
  persist();
  return completed;
}

export function markExecutionFailed(key, error, meta = {}) {
  const failed = transitionExecution(key, 'failed', {
    error: String(error || 'unknown_error'),
    failMeta: {
      ...(state.records.get(key)?.failMeta || {}),
      ...meta,
      at: nowIso(),
    },
  });

  const expected = state.expectedFills.get(String(key));
  if (expected) {
    expected.state = 'failed';
    expected.mismatchReason = String(error || 'unknown_error');
    expected.updatedAt = nowIso();
    state.expectedFills.set(String(key), expected);
  }

  incrementMetric('api_error', 1, { source: 'execution', error: String(error || 'unknown_error') });
  recordMetricEvent('api_error', { source: 'execution', key, error: String(error || 'unknown_error') }, { severity: 'warn' });
  recordAuditEvent('order_failed', { key, error: String(error || 'unknown_error') }, 'executionStore');
  persist();
  return failed;
}

function normalizeScope(scope) {
  return String(scope || '').trim() || 'global';
}

export function canExecuteInScope(scope) {
  ensureLoaded();
  const key = normalizeScope(scope);
  const b = state.breakers.get(key);
  if (!b) return { allowed: true, state: 'closed' };

  const now = Date.now();
  const openUntil = Number(b.openUntilMs || 0);

  if (b.state === 'open' && openUntil > now) {
    return { allowed: false, state: 'open', openUntilMs: openUntil, failures: b.consecutiveFailures || 0 };
  }

  if (b.state === 'open' && openUntil <= now) {
    const next = { ...b, state: 'half_open', updatedAt: nowIso() };
    state.breakers.set(key, next);
    persist();
    return { allowed: true, state: 'half_open', failures: next.consecutiveFailures || 0 };
  }

  return { allowed: true, state: b.state || 'closed', failures: b.consecutiveFailures || 0 };
}

export function recordExecutionSuccess(scope) {
  ensureLoaded();
  const key = normalizeScope(scope);
  const prev = state.breakers.get(key) || { scope: key, state: 'closed', consecutiveFailures: 0 };
  const next = {
    ...prev,
    state: 'closed',
    consecutiveFailures: 0,
    lastSuccessAt: nowIso(),
    openUntilMs: 0,
    updatedAt: nowIso(),
  };
  state.breakers.set(key, next);
  persist();
}

export function recordExecutionFailure(scope, reason = 'execution_failure') {
  ensureLoaded();
  const key = normalizeScope(scope);
  const prev = state.breakers.get(key) || { scope: key, state: 'closed', consecutiveFailures: 0 };
  const failures = Number(prev.consecutiveFailures || 0) + 1;
  const threshold = Math.max(1, Number(config.circuitBreakerFailureThreshold || 3));
  const cooldownMs = Math.max(30_000, Number(config.circuitBreakerCooldownMs || 300_000));

  let nextState = prev.state || 'closed';
  let openUntilMs = Number(prev.openUntilMs || 0);
  if (failures >= threshold) {
    nextState = 'open';
    openUntilMs = Date.now() + cooldownMs;
  }

  const next = {
    ...prev,
    scope: key,
    state: nextState,
    consecutiveFailures: failures,
    lastFailureAt: nowIso(),
    lastFailureReason: String(reason || 'execution_failure'),
    openUntilMs,
    updatedAt: nowIso(),
  };

  state.breakers.set(key, next);
  if (nextState === 'open') {
    recordIncident('circuit_breaker_opened', {
      scope: key,
      failures,
      threshold,
      openUntilMs,
      reason,
    });
  }
  persist();
}

function defaultRemediationForType(type) {
  if (type === 'circuit_breaker_opened') return 'Investigate venue/API errors and retry after cooldown.';
  if (type === 'reconciliation_mismatch') return 'Compare expected fill to open orders and positions, then reconcile manually.';
  if (type === 'stale_expected_fill') return 'Check order status on CLOB and cancel/replace if still pending.';
  if (type === 'order_submit_exception') return 'Inspect API credentials, order payload, and venue availability.';
  return 'Inspect structured details and execution history for this scope.';
}

export function recordIncident(type, details = {}) {
  ensureLoaded();
  const entry = {
    at: nowIso(),
    type: String(type || 'incident'),
    reason: String(details?.reason || details?.error || type || 'incident'),
    scope: details?.scope ? String(details.scope) : null,
    remediation: String(details?.remediation || defaultRemediationForType(type)),
    details,
  };
  state.incidents.push(entry);
  if (state.incidents.length > 500) {
    state.incidents = state.incidents.slice(-500);
  }
  incrementMetric('incident', 1, { type: entry.type, scope: entry.scope || 'global' });
  recordAuditEvent('incident', entry, 'executionStore');
  persist();
}

export function reconcileExpectedFills({ openOrders = [], activeBets = [] } = {}) {
  ensureLoaded();
  const now = Date.now();
  const orderIds = new Set(
    (Array.isArray(openOrders) ? openOrders : [])
      .map((o) => String(o?.id || o?.orderID || o?.orderId || o?.order_id || '').trim())
      .filter(Boolean),
  );

  const betsByToken = new Map();
  for (const bet of (Array.isArray(activeBets) ? activeBets : [])) {
    const token = String(bet?.token_id || '').trim();
    if (!token) continue;
    if (!betsByToken.has(token)) betsByToken.set(token, bet);
  }

  const priceTol = Math.max(0, Number(config.reconciliationTolerancePricePct || 0.15));
  const sizeTol = Math.max(0, Number(config.reconciliationToleranceSize || 0.25));

  let changed = 0;
  for (const [key, row] of state.expectedFills.entries()) {
    if (!row || row.state === 'observed_filled' || row.state === 'failed' || row.state === 'stale_missing' || row.state === 'stale_pending_order' || row.state === 'mismatch_tolerance') continue;

    const submittedMs = new Date(row.submittedAt || row.updatedAt || nowIso()).getTime();
    const staleAfter = Number(row.staleAfterMs || config.expectedFillStaleMs || 180_000);
    const ageMs = Number.isFinite(submittedMs) ? (now - submittedMs) : 0;
    const open = row.orderId ? orderIds.has(String(row.orderId)) : false;
    const observedBet = row.tokenId ? betsByToken.get(String(row.tokenId)) : null;

    if (observedBet && !open) {
      const observedPrice = Number(observedBet?.odds_at_bet);
      const observedShares = Number(observedBet?.shares);
      const priceMismatch = pctDiff(observedPrice, Number(row.expectedPrice || 0));
      const shareMismatch = Number.isFinite(observedShares) && Number.isFinite(row.expectedShares)
        ? Math.abs(observedShares - row.expectedShares)
        : null;

      row.observedPrice = Number.isFinite(observedPrice) ? observedPrice : null;
      row.observedShares = Number.isFinite(observedShares) ? observedShares : null;
      row.updatedAt = nowIso();

      if ((priceMismatch !== null && priceMismatch > priceTol) || (shareMismatch !== null && shareMismatch > sizeTol)) {
        row.state = 'mismatch_tolerance';
        row.mismatchReason = 'observed fill outside tolerance';
        recordIncident('reconciliation_mismatch', {
          key,
          scope: row.scope,
          reason: row.mismatchReason,
          expectedPrice: row.expectedPrice,
          observedPrice: row.observedPrice,
          expectedShares: row.expectedShares,
          observedShares: row.observedShares,
          remediation: 'Validate exchange fill details and adjust local records if needed.',
        });
      } else {
        row.state = 'observed_filled';
      }

      state.expectedFills.set(key, row);
      state.reconciliations.push({
        at: nowIso(),
        key,
        scope: row.scope,
        state: row.state,
        orderId: row.orderId,
      });
      recordReconciliation({
        key,
        scope: row.scope,
        state: row.state,
        orderId: row.orderId,
        expectedPrice: row.expectedPrice,
        observedPrice: row.observedPrice,
        expectedShares: row.expectedShares,
        observedShares: row.observedShares,
      });
      changed += 1;
      continue;
    }

    if (ageMs > staleAfter) {
      row.state = open ? 'stale_pending_order' : 'stale_missing';
      row.mismatchReason = open
        ? 'order still open past stale window'
        : 'no open order and no observed fill past stale window';
      row.updatedAt = nowIso();
      state.expectedFills.set(key, row);
      recordIncident('stale_expected_fill', {
        key,
        scope: row.scope,
        reason: row.mismatchReason,
        orderId: row.orderId,
        remediation: open
          ? 'Cancel/replace stale order or widen execution parameters.'
          : 'Reconcile with venue fills and backfill execution result.',
      });
      state.reconciliations.push({
        at: nowIso(),
        key,
        scope: row.scope,
        state: row.state,
        orderId: row.orderId,
      });
      recordReconciliation({
        key,
        scope: row.scope,
        state: row.state,
        orderId: row.orderId,
        mismatchReason: row.mismatchReason,
      });
      changed += 1;
    }
  }

  if (state.reconciliations.length > 2000) {
    state.reconciliations = state.reconciliations.slice(-2000);
  }
  if (changed > 0) persist();
  return { changed };
}

export function getExpectedFillsSnapshot(limit = 200) {
  ensureLoaded();
  const n = Math.max(1, Math.min(2000, Number(limit || 200)));
  const rows = Array.from(state.expectedFills.values());
  rows.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  return rows.slice(0, n);
}

export function getRecentReconciliation(limit = 100) {
  ensureLoaded();
  const n = Math.max(1, Math.min(2000, Number(limit || 100)));
  const local = state.reconciliations.slice(-n).reverse();
  const durable = getReconciliationEvents({ limit: n });
  return local.length >= durable.length ? local : durable;
}

export function getCircuitBreakersSnapshot() {
  ensureLoaded();
  return Array.from(state.breakers.values()).sort((a, b) => String(a.scope).localeCompare(String(b.scope)));
}

export function getRecentIncidents(limit = 100) {
  ensureLoaded();
  const n = Math.max(1, Math.min(500, Number(limit || 100)));
  return state.incidents.slice(-n).reverse();
}

export function getOpenEntryIntents(limit = 200) {
  ensureLoaded();
  const n = Math.max(1, Math.min(2000, Number(limit || 200)));
  const rows = [];

  for (const record of state.records.values()) {
    if (!record || record.terminal) continue;
    if (String(record.kind || '') !== 'entry') continue;

    const parts = String(record.key || '').split(':');
    const eventIdFromKey = String(parts[1] || '').trim();
    const tokenIdFromKey = String(parts[2] || '').trim();
    const tokenIdFromPayload = String(record?.payload?.tokenId || '').trim();

    rows.push({
      key: record.key,
      scope: record.scope,
      state: record.state,
      eventId: String(record?.payload?.eventId || eventIdFromKey || '').trim() || null,
      tokenId: tokenIdFromPayload || tokenIdFromKey || null,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });
  }

  rows.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  return rows.slice(0, n);
}

export function getRecentExecutions(limit = 200) {
  ensureLoaded();
  const n = Math.max(1, Math.min(2000, Number(limit || 200)));
  const rows = Array.from(state.records.values());
  rows.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  return rows.slice(0, n);
}
