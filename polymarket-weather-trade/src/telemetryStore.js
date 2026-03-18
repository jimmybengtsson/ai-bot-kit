// src/telemetryStore.js — Durable telemetry counters/events/latency snapshots for ops APIs.
// Stores bounded JSON state and exposes metrics/slo-friendly aggregates.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { nowIso } from './utils/runtimeTime.js';

const STATE_FILE = process.env.TELEMETRY_STATE_FILE
  ? path.resolve(process.cwd(), process.env.TELEMETRY_STATE_FILE)
  : path.resolve(process.cwd(), 'data', 'telemetry-state.json');
const MAX_EVENTS = 5000;
const MAX_LATENCY_SAMPLES = 5000;

const state = {
  loaded: false,
  countersByDay: new Map(),
  events: [],
  latencySamples: [],
  availability: {
    total: 0,
    failed: 0,
    lastAt: null,
  },
};

function dayKey(iso = nowIso()) {
  return String(iso).slice(0, 10);
}

function ensureLoaded() {
  if (state.loaded) return;
  state.loaded = true;

  if (!existsSync(STATE_FILE)) return;
  try {
    const raw = JSON.parse(readFileSync(STATE_FILE, 'utf8') || '{}');

    const daily = raw?.countersByDay || {};
    for (const [d, counters] of Object.entries(daily)) {
      state.countersByDay.set(String(d), { ...(counters || {}) });
    }

    state.events = Array.isArray(raw?.events) ? raw.events.slice(-MAX_EVENTS) : [];
    state.latencySamples = Array.isArray(raw?.latencySamples)
      ? raw.latencySamples.slice(-MAX_LATENCY_SAMPLES)
      : [];

    const availability = raw?.availability || {};
    state.availability = {
      total: Number(availability.total || 0),
      failed: Number(availability.failed || 0),
      lastAt: availability.lastAt || null,
    };
  } catch {
    // Keep empty in-memory state on parse errors.
  }
}

function persist() {
  mkdirSync(path.dirname(STATE_FILE), { recursive: true });

  const countersByDay = {};
  for (const [d, counters] of state.countersByDay.entries()) {
    countersByDay[d] = counters;
  }

  const payload = {
    updatedAt: nowIso(),
    countersByDay,
    events: state.events.slice(-MAX_EVENTS),
    latencySamples: state.latencySamples.slice(-MAX_LATENCY_SAMPLES),
    availability: state.availability,
  };
  writeFileSync(STATE_FILE, JSON.stringify(payload, null, 2), 'utf8');
}

function bumpCounter(day, name, delta = 1) {
  const d = String(day || dayKey());
  const key = String(name || '').trim();
  if (!key) return;

  const row = state.countersByDay.get(d) || {};
  row[key] = Number(row[key] || 0) + Number(delta || 0);
  state.countersByDay.set(d, row);
}

export function recordMetricEvent(name, data = {}, { severity = 'info' } = {}) {
  ensureLoaded();
  const at = nowIso();
  const event = {
    at,
    name: String(name || 'event'),
    severity: String(severity || 'info'),
    data: data && typeof data === 'object' ? data : {},
  };

  state.events.push(event);
  if (state.events.length > MAX_EVENTS) {
    state.events = state.events.slice(-MAX_EVENTS);
  }

  bumpCounter(dayKey(at), event.name, 1);
  persist();
}

export function incrementMetric(name, delta = 1, data = null) {
  ensureLoaded();
  const at = nowIso();
  bumpCounter(dayKey(at), name, delta);
  if (data && typeof data === 'object') {
    state.events.push({ at, name: String(name || 'counter'), severity: 'info', data });
    if (state.events.length > MAX_EVENTS) {
      state.events = state.events.slice(-MAX_EVENTS);
    }
  }
  persist();
}

export function recordLatencySample(name, ms, ok = true, data = {}) {
  ensureLoaded();
  const sample = {
    at: nowIso(),
    name: String(name || 'latency'),
    ms: Number(ms || 0),
    ok: !!ok,
    data: data && typeof data === 'object' ? data : {},
  };
  state.latencySamples.push(sample);
  if (state.latencySamples.length > MAX_LATENCY_SAMPLES) {
    state.latencySamples = state.latencySamples.slice(-MAX_LATENCY_SAMPLES);
  }

  bumpCounter(dayKey(sample.at), ok ? `${sample.name}_ok` : `${sample.name}_error`, 1);
  persist();
}

export function recordAvailabilityTick(ok, data = {}) {
  ensureLoaded();
  state.availability.total += 1;
  if (!ok) state.availability.failed += 1;
  state.availability.lastAt = nowIso();

  bumpCounter(dayKey(state.availability.lastAt), ok ? 'availability_ok' : 'availability_error', 1);
  if (!ok) {
    state.events.push({
      at: state.availability.lastAt,
      name: 'availability_error',
      severity: 'warn',
      data: data && typeof data === 'object' ? data : {},
    });
    if (state.events.length > MAX_EVENTS) {
      state.events = state.events.slice(-MAX_EVENTS);
    }
  }

  persist();
}

function percentile(sortedValues, pct) {
  if (!Array.isArray(sortedValues) || sortedValues.length === 0) return null;
  const idx = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil((pct / 100) * sortedValues.length) - 1));
  return sortedValues[idx];
}

export function getMetricsSnapshot({ day = null, limit = 200 } = {}) {
  ensureLoaded();
  const d = day || dayKey();
  const counters = { ...(state.countersByDay.get(String(d)) || {}) };
  const n = Math.max(1, Math.min(5000, Number(limit || 200)));

  return {
    day: String(d),
    counters,
    events: state.events.slice(-n).reverse(),
    availability: { ...state.availability },
  };
}

export function getSloSnapshot({ windowHours = 24 } = {}) {
  ensureLoaded();
  const hours = Math.max(1, Math.min(168, Number(windowHours || 24)));
  const cutoff = Date.now() - (hours * 3600_000);

  const lat = state.latencySamples.filter((s) => {
    const ts = new Date(s.at).getTime();
    return Number.isFinite(ts) && ts >= cutoff;
  });

  const byName = {};
  for (const s of lat) {
    if (!byName[s.name]) byName[s.name] = [];
    byName[s.name].push(Number(s.ms || 0));
  }

  const latency = {};
  for (const [name, values] of Object.entries(byName)) {
    const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
    const sum = sorted.reduce((acc, v) => acc + v, 0);
    latency[name] = {
      count: sorted.length,
      avgMs: sorted.length ? (sum / sorted.length) : null,
      p50Ms: percentile(sorted, 50),
      p95Ms: percentile(sorted, 95),
      p99Ms: percentile(sorted, 99),
    };
  }

  const availabilityTotal = Number(state.availability.total || 0);
  const availabilityFailed = Number(state.availability.failed || 0);
  const availabilityPct = availabilityTotal > 0
    ? ((availabilityTotal - availabilityFailed) / availabilityTotal) * 100
    : 100;

  return {
    windowHours: hours,
    generatedAt: nowIso(),
    availability: {
      totalChecks: availabilityTotal,
      failedChecks: availabilityFailed,
      availabilityPct,
      lastAt: state.availability.lastAt,
    },
    latency,
    eventVolume: {
      totalEvents: state.events.length,
      withinWindow: state.events.filter((e) => {
        const ts = new Date(e.at).getTime();
        return Number.isFinite(ts) && ts >= cutoff;
      }).length,
    },
  };
}
