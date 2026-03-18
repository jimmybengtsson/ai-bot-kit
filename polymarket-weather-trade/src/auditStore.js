// src/auditStore.js — Durable append-only audit and reconciliation event storage.
// Keeps bounded JSON history for ops endpoints and incident forensics.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { nowIso } from './utils/runtimeTime.js';
import { makeRuntimeId } from './utils/runtimeId.js';

const AUDIT_FILE = process.env.AUDIT_STORE_FILE
  ? path.resolve(process.cwd(), process.env.AUDIT_STORE_FILE)
  : path.resolve(process.cwd(), 'data', 'audit-store.json');
const MAX_AUDIT_EVENTS = 20000;
const MAX_RECONCILIATIONS = 10000;

const state = {
  loaded: false,
  events: [],
  reconciliations: [],
};

function ensureLoaded() {
  if (state.loaded) return;
  state.loaded = true;

  if (!existsSync(AUDIT_FILE)) return;
  try {
    const raw = JSON.parse(readFileSync(AUDIT_FILE, 'utf8') || '{}');
    state.events = Array.isArray(raw?.events) ? raw.events.slice(-MAX_AUDIT_EVENTS) : [];
    state.reconciliations = Array.isArray(raw?.reconciliations)
      ? raw.reconciliations.slice(-MAX_RECONCILIATIONS)
      : [];
  } catch {
    state.events = [];
    state.reconciliations = [];
  }
}

function persist() {
  mkdirSync(path.dirname(AUDIT_FILE), { recursive: true });
  const payload = {
    updatedAt: nowIso(),
    events: state.events.slice(-MAX_AUDIT_EVENTS),
    reconciliations: state.reconciliations.slice(-MAX_RECONCILIATIONS),
  };
  writeFileSync(AUDIT_FILE, JSON.stringify(payload, null, 2), 'utf8');
}

export function recordAuditEvent(type, payload = {}, source = 'runtime') {
  ensureLoaded();
  state.events.push({
    id: makeRuntimeId('audit'),
    at: nowIso(),
    type: String(type || 'audit_event'),
    source: String(source || 'runtime'),
    payload: payload && typeof payload === 'object' ? payload : {},
  });
  if (state.events.length > MAX_AUDIT_EVENTS) {
    state.events = state.events.slice(-MAX_AUDIT_EVENTS);
  }
  persist();
}

export function recordReconciliation(record = {}) {
  ensureLoaded();
  state.reconciliations.push({
    id: makeRuntimeId('recon'),
    at: nowIso(),
    ...record,
  });
  if (state.reconciliations.length > MAX_RECONCILIATIONS) {
    state.reconciliations = state.reconciliations.slice(-MAX_RECONCILIATIONS);
  }
  persist();
}

export function getAuditEvents({ limit = 200, type = null } = {}) {
  ensureLoaded();
  const n = Math.max(1, Math.min(5000, Number(limit || 200)));
  const typed = type ? String(type) : null;
  const rows = typed
    ? state.events.filter((e) => e.type === typed)
    : state.events;
  return rows.slice(-n).reverse();
}

export function getReconciliationEvents({ limit = 200 } = {}) {
  ensureLoaded();
  const n = Math.max(1, Math.min(5000, Number(limit || 200)));
  return state.reconciliations.slice(-n).reverse();
}
