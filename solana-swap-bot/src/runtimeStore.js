// src/runtimeStore.js — In-memory bounded runtime state for stateless mode

const LIMITS = {
  eventLog: 2000,
  longTermMemory: 500,
  trades: 1500,
  tickMetrics: 1000,
  conversations: 120,
};

const store = {
  eventLog: [],
  longTermMemory: [],
  trades: [],
  pendingTrades: new Map(), // signature -> trade object
  aiMemo: null,
  tickMetrics: [],
  responseIds: new Map(), // channel -> response id
  conversations: new Map(), // channel -> [{role, content}]
};

function trimArray(arr, keep) {
  if (arr.length > keep) arr.splice(0, arr.length - keep);
}

function parseTs(value) {
  const t = value ? new Date(value).getTime() : Date.now();
  return Number.isFinite(t) ? t : Date.now();
}

function nowIso() {
  return new Date().toISOString();
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function timeNow() {
  return new Date().toISOString().slice(11, 16);
}

export function appendEvent(message) {
  store.eventLog.push({ date: today(), time: timeNow(), message, created_at: nowIso() });
  trimArray(store.eventLog, LIMITS.eventLog);
}

export function readTodayEvents() {
  const d = today();
  return store.eventLog
    .filter(e => e.date === d)
    .map(e => `${e.time} — ${e.message}`)
    .join('\n');
}

export function appendLongTermMemory(fact) {
  store.longTermMemory.push({ date: today(), fact, created_at: nowIso() });
  trimArray(store.longTermMemory, LIMITS.longTermMemory);
}

export function readLongTermMemory() {
  return store.longTermMemory.map(r => `- [${r.date}] ${r.fact}`).join('\n');
}

export function addTrade(trade) {
  const normalized = {
    ...trade,
    timestamp: trade.timestamp || nowIso(),
    status: trade.status || 'confirmed',
  };
  store.trades.push(normalized);
  trimArray(store.trades, LIMITS.trades);

  if (normalized.signature && normalized.status === 'pending') {
    store.pendingTrades.set(normalized.signature, normalized);
  }
}

export function updatePendingTrade(signature, newStatus, cancelReason = '') {
  if (!signature) return;

  const pending = store.pendingTrades.get(signature);
  if (pending) {
    pending.status = newStatus;
    if (cancelReason) pending.cancelReason = cancelReason;
    if (newStatus !== 'pending') {
      store.pendingTrades.delete(signature);
    }
  }

  for (let i = store.trades.length - 1; i >= 0; i--) {
    const t = store.trades[i];
    if (t.signature === signature) {
      t.status = newStatus;
      if (cancelReason) t.cancelReason = cancelReason;
      break;
    }
  }
}

export function getPendingTradesByAge(minAgeSec = 1800, maxAgeSec = 86400) {
  const now = Date.now();
  const minMs = minAgeSec * 1000;
  const maxMs = maxAgeSec * 1000;
  const result = [];

  for (const t of store.pendingTrades.values()) {
    const age = now - parseTs(t.timestamp);
    if (age >= minMs && age <= maxMs) result.push({ ...t });
  }

  result.sort((a, b) => parseTs(a.timestamp) - parseTs(b.timestamp));
  return result;
}

export function getRecentTrades(count = 10) {
  if (count <= 0) return [];
  return store.trades.slice(-count).map(t => ({ ...t }));
}

export function setAiMemo(memo) {
  store.aiMemo = memo || null;
}

export function getAiMemo() {
  return store.aiMemo;
}

export function addTickMetric(metric) {
  const normalized = {
    tick_ts: metric.tickTs || nowIso(),
    action: metric.action || 'hold',
    trade_count: metric.tradeCount || 0,
    arb_available: metric.arbAvailable || 0,
    arb_taken: metric.arbTaken || 0,
    hold_streak: metric.holdStreak || 0,
    latency_ms: metric.latencyMs || 0,
    data: metric.data || null,
    created_at: nowIso(),
  };

  store.tickMetrics.push(normalized);
  trimArray(store.tickMetrics, LIMITS.tickMetrics);
}

export function getLastHoldStreakValue() {
  return store.tickMetrics.length ? (store.tickMetrics[store.tickMetrics.length - 1].hold_streak || 0) : 0;
}

export function getRecentTickMetrics(count = 50) {
  if (count <= 0) return [];
  return store.tickMetrics.slice(-count).map(r => ({ ...r }));
}

export function setResponseIdForChannel(channel, responseId) {
  if (!channel || !responseId) return;
  store.responseIds.set(channel, responseId);
}

export function getResponseIdForChannel(channel) {
  return store.responseIds.get(channel) || null;
}

export function saveConversation(channel, role, content) {
  if (!channel) return;
  if (!store.conversations.has(channel)) store.conversations.set(channel, []);
  const arr = store.conversations.get(channel);
  arr.push({ role, content, created_at: nowIso() });
  trimArray(arr, LIMITS.conversations);
}

export function getConversation(channel, maxMessages = 20) {
  const arr = store.conversations.get(channel) || [];
  if (maxMessages <= 0) return [];
  return arr.slice(-maxMessages).map(m => ({ role: m.role, content: m.content }));
}

export function pruneConversation(channel, keep = 40) {
  const arr = store.conversations.get(channel);
  if (!arr) return;
  trimArray(arr, keep);
}

export function getTokenPerformanceRuntime() {
  const byMint = new Map();

  for (const t of store.trades) {
    if (t.status !== 'confirmed') continue;
    if (!t.outputMint) continue;

    if (!byMint.has(t.outputMint)) {
      byMint.set(t.outputMint, {
        output_mint: t.outputMint,
        cnt: 0,
        wins: 0,
        rated: 0,
        pnlSumPct: 0,
        pnlCount: 0,
        last_ts: null,
      });
    }

    const row = byMint.get(t.outputMint);
    const amount = Number(t.amountSol || 0);
    const pnl = Number(t.pnlSol || 0);

    row.cnt += 1;
    if (pnl > 0) row.wins += 1;

    if (pnl !== 0) row.rated += 1;
    if (amount > 0 && pnl !== 0) {
      row.pnlSumPct += (pnl / amount) * 100;
      row.pnlCount += 1;
    }

    if (!row.last_ts || parseTs(t.timestamp) > parseTs(row.last_ts)) {
      row.last_ts = t.timestamp || nowIso();
    }
  }

  const out = [];
  for (const row of byMint.values()) {
    out.push({
      output_mint: row.output_mint,
      cnt: row.cnt,
      wins: row.wins,
      rated: row.rated,
      avg_pnl_pct: row.pnlCount > 0 ? Math.round((row.pnlSumPct / row.pnlCount) * 100) / 100 : null,
      last_ts: row.last_ts,
    });
  }

  return out;
}
