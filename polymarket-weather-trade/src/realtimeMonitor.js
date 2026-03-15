// src/realtimeMonitor.js — Polymarket WebSocket monitor for real-time bet status triggers
import WebSocket from 'ws';
import { config } from './config.js';
import { createLogger } from './logger.js';
import { getApiCreds } from './wallet.js';

const log = createLogger('realtime');

const HEARTBEAT_MS = 10_000;
const SYNC_INTERVAL_MS = 15_000;
const SIGNAL_DEBOUNCE_MS = 800;

const state = {
  running: false,
  getTrackedSnapshot: null,
  onSignal: null,

  marketWs: null,
  userWs: null,
  marketHeartbeat: null,
  userHeartbeat: null,

  syncTimer: null,
  signalTimer: null,
  queuedReasons: new Set(),
  queuedForceRefresh: false,

  marketReconnectAttempts: 0,
  userReconnectAttempts: 0,
  marketReconnectTimer: null,
  userReconnectTimer: null,

  desired: {
    assetIds: new Set(),
    marketIds: new Set(),
  },
  subscribed: {
    assetIds: new Set(),
    marketIds: new Set(),
  },
};

function normalizeStringSet(values) {
  const out = new Set();
  for (const v of values || []) {
    const s = String(v || '').trim();
    if (s) out.add(s);
  }
  return out;
}

function normalizeMarketIdSet(values) {
  const out = new Set();
  for (const v of values || []) {
    const s = String(v || '').trim();
    if (!s) continue;
    // User channel expects condition IDs, which are hex strings.
    if (!s.startsWith('0x')) continue;
    out.add(s);
  }
  return out;
}

function toArray(setLike) {
  return Array.from(setLike || []);
}

function setDiff(nextSet, prevSet) {
  const added = [];
  const removed = [];

  for (const v of nextSet) {
    if (!prevSet.has(v)) added.push(v);
  }
  for (const v of prevSet) {
    if (!nextSet.has(v)) removed.push(v);
  }

  return { added, removed };
}

function sendJson(ws, payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(payload));
  return true;
}

function clearTimer(timerId) {
  if (timerId) clearInterval(timerId);
}

function clearTimeoutSafe(timerId) {
  if (timerId) clearTimeout(timerId);
}

function scheduleSignal(reason, forceRefresh = false) {
  if (!state.running || !state.onSignal) return;

  if (reason) state.queuedReasons.add(String(reason));
  state.queuedForceRefresh = state.queuedForceRefresh || !!forceRefresh;

  if (state.signalTimer) return;
  state.signalTimer = setTimeout(async () => {
    state.signalTimer = null;
    const reasons = toArray(state.queuedReasons);
    const joinedReason = reasons.length > 0 ? reasons.join(', ') : 'ws_signal';
    const force = state.queuedForceRefresh;
    state.queuedReasons.clear();
    state.queuedForceRefresh = false;

    try {
      await state.onSignal({ reason: joinedReason, forceRefresh: force });
    } catch (err) {
      log.warn(`Realtime signal handler failed: ${err.message}`);
    }
  }, SIGNAL_DEBOUNCE_MS);
}

function startHeartbeat(channel) {
  const isUser = channel === 'user';
  const ws = isUser ? state.userWs : state.marketWs;
  if (!ws) return;

  const timer = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send('PING');
  }, HEARTBEAT_MS);

  if (isUser) state.userHeartbeat = timer;
  else state.marketHeartbeat = timer;
}

function stopHeartbeat(channel) {
  const isUser = channel === 'user';
  const timer = isUser ? state.userHeartbeat : state.marketHeartbeat;
  clearTimer(timer);
  if (isUser) state.userHeartbeat = null;
  else state.marketHeartbeat = null;
}

function reconnectDelayMs(attempt) {
  return Math.min(30_000, 1_000 * (2 ** Math.max(0, attempt)));
}

function scheduleReconnect(channel) {
  if (!state.running) return;

  if (channel === 'market') {
    if (state.marketReconnectTimer) return;
    const delay = reconnectDelayMs(state.marketReconnectAttempts++);
    state.marketReconnectTimer = setTimeout(() => {
      state.marketReconnectTimer = null;
      connectMarketSocket().catch((err) => log.warn(`Market WS reconnect failed: ${err.message}`));
    }, delay);
    return;
  }

  if (state.userReconnectTimer) return;
  const delay = reconnectDelayMs(state.userReconnectAttempts++);
  state.userReconnectTimer = setTimeout(() => {
    state.userReconnectTimer = null;
    connectUserSocket().catch((err) => log.warn(`User WS reconnect failed: ${err.message}`));
  }, delay);
}

function parseMessageData(data) {
  try {
    if (typeof data === 'string') return data;
    return JSON.parse(String(data));
  } catch {
    return null;
  }
}

function extractAssetIds(payload) {
  if (!payload || typeof payload !== 'object') return [];

  const candidates = [
    payload.asset_id,
    payload.asset,
    payload.assetId,
    payload.token_id,
    payload.tokenId,
    payload.maker_asset_id,
    payload.taker_asset_id,
  ];

  const out = [];
  for (const c of candidates) {
    const s = String(c || '').trim();
    if (s) out.push(s);
  }
  return out;
}

function onMarketMessage(raw) {
  const payload = parseMessageData(raw);
  if (!payload) return;

  if (payload === 'PONG') return;
  if (payload === 'PING') {
    if (state.marketWs?.readyState === WebSocket.OPEN) state.marketWs.send('PONG');
    return;
  }

  const items = Array.isArray(payload) ? payload : [payload];
  let shouldSignal = false;

  for (const item of items) {
    const eventType = String(item?.event_type || item?.type || '').toLowerCase();
    const affectsAll = eventType === 'market_resolved' || eventType === 'new_market';
    const assetIds = extractAssetIds(item);
    // Messages arrive on a subscription-scoped socket, but payload id fields can vary.
    // If we cannot reliably extract an asset id, still treat known market events as relevant.
    const hasTrackedAsset = affectsAll
      || assetIds.length === 0
      || assetIds.some((id) => state.desired.assetIds.has(id));

    if (!hasTrackedAsset) continue;

    if (
      eventType === 'book'
      || eventType === 'price_change'
      || eventType === 'last_trade_price'
      || eventType === 'best_bid_ask'
      || eventType === 'tick_size_change'
      || eventType === 'market_resolved'
      || eventType === 'new_market'
    ) {
      shouldSignal = true;
    }
  }

  if (shouldSignal) {
    scheduleSignal('market_ws_update', false);
  }
}

function onUserMessage(raw) {
  const payload = parseMessageData(raw);
  if (!payload) return;

  if (payload === 'PONG') return;
  if (payload === 'PING') {
    if (state.userWs?.readyState === WebSocket.OPEN) state.userWs.send('PONG');
    return;
  }

  const items = Array.isArray(payload) ? payload : [payload];
  let shouldSignal = false;
  for (const item of items) {
    const eventType = String(item?.event_type || item?.type || '').toLowerCase();
    if (eventType === 'order' || eventType === 'trade' || !eventType) {
      shouldSignal = true;
      break;
    }
  }

  if (shouldSignal) {
    // User/order updates should force fresh exchange state for max correctness.
    scheduleSignal('user_ws_update', true);
  }
}

function attachCommonHandlers(channel, ws) {
  ws.on('message', (data) => {
    if (channel === 'market') onMarketMessage(data);
    else onUserMessage(data);
  });

  ws.on('error', (err) => {
    log.warn(`${channel} WS error: ${err.message}`);
  });

  ws.on('close', (code, reasonBuffer) => {
    const reason = String(reasonBuffer || '').trim();
    log.warn(`${channel} WS closed (code=${code}${reason ? `, reason=${reason}` : ''})`);

    stopHeartbeat(channel);

    if (channel === 'market') {
      state.marketWs = null;
      state.subscribed.assetIds.clear();
      if (state.desired.assetIds.size === 0) return;
      scheduleReconnect('market');
      return;
    }

    state.userWs = null;
    state.subscribed.marketIds.clear();
    if (state.desired.marketIds.size === 0) return;
    scheduleReconnect('user');
  });
}

async function connectMarketSocket() {
  if (!state.running) return;

  if (state.desired.assetIds.size === 0) return;

  const current = state.marketWs;
  if (current && (current.readyState === WebSocket.OPEN || current.readyState === WebSocket.CONNECTING)) return;

  const ws = new WebSocket(config.marketWsUrl);
  state.marketWs = ws;

  ws.on('open', () => {
    state.marketReconnectAttempts = 0;
    log.info(`Connected market WS (${config.marketWsUrl})`);

    sendJson(ws, {
      type: 'market',
      assets_ids: toArray(state.desired.assetIds),
      custom_feature_enabled: true,
    });
    state.subscribed.assetIds = new Set(state.desired.assetIds);

    startHeartbeat('market');
  });

  attachCommonHandlers('market', ws);
}

async function connectUserSocket() {
  if (!state.running) return;

  if (state.desired.marketIds.size === 0) return;

  const current = state.userWs;
  if (current && (current.readyState === WebSocket.OPEN || current.readyState === WebSocket.CONNECTING)) return;

  const creds = await getApiCreds();
  const apiKey = creds?.key || creds?.apiKey;
  const secret = creds?.secret;
  const passphrase = creds?.passphrase;

  if (!apiKey || !secret || !passphrase) {
    log.warn('User WS disabled: missing Polymarket API credentials');
    return;
  }

  const ws = new WebSocket(config.userWsUrl);
  state.userWs = ws;

  ws.on('open', () => {
    state.userReconnectAttempts = 0;
    log.info(`Connected user WS (${config.userWsUrl})`);

    sendJson(ws, {
      type: 'user',
      auth: { apiKey, secret, passphrase },
      markets: toArray(state.desired.marketIds),
    });
    state.subscribed.marketIds = new Set(state.desired.marketIds);

    startHeartbeat('user');
  });

  attachCommonHandlers('user', ws);
}

function closeSocket(channel) {
  const isUser = channel === 'user';
  const ws = isUser ? state.userWs : state.marketWs;
  if (!ws) return;

  stopHeartbeat(channel);

  if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
    try {
      ws.close(1000, 'subscription_empty');
    } catch {
      // Ignore close races.
    }
  }

  if (isUser) {
    state.userWs = null;
    state.subscribed.marketIds.clear();
  } else {
    state.marketWs = null;
    state.subscribed.assetIds.clear();
  }
}

function maybeSendDynamicSubscriptions() {
  // Market channel deltas
  if (state.marketWs?.readyState === WebSocket.OPEN) {
    const marketDiff = setDiff(state.desired.assetIds, state.subscribed.assetIds);

    if (marketDiff.added.length > 0) {
      sendJson(state.marketWs, {
        operation: 'subscribe',
        assets_ids: marketDiff.added,
        custom_feature_enabled: true,
      });
    }

    if (marketDiff.removed.length > 0) {
      sendJson(state.marketWs, {
        operation: 'unsubscribe',
        assets_ids: marketDiff.removed,
      });
    }

    state.subscribed.assetIds = new Set(state.desired.assetIds);
  }

  // User channel deltas
  if (state.userWs?.readyState === WebSocket.OPEN) {
    const userDiff = setDiff(state.desired.marketIds, state.subscribed.marketIds);

    if (userDiff.added.length > 0) {
      sendJson(state.userWs, {
        operation: 'subscribe',
        markets: userDiff.added,
      });
    }

    if (userDiff.removed.length > 0) {
      sendJson(state.userWs, {
        operation: 'unsubscribe',
        markets: userDiff.removed,
      });
    }

    state.subscribed.marketIds = new Set(state.desired.marketIds);
  }
}

export async function syncRealtimeSubscriptions() {
  if (!state.running || !state.getTrackedSnapshot) return;

  let snapshot;
  try {
    snapshot = await state.getTrackedSnapshot();
  } catch (err) {
    log.warn(`Realtime subscription snapshot failed: ${err.message}`);
    return;
  }

  const nextAssets = normalizeStringSet(snapshot?.assetIds || []);
  const nextMarkets = normalizeMarketIdSet(snapshot?.marketIds || []);

  state.desired.assetIds = nextAssets;
  state.desired.marketIds = nextMarkets;

  if (nextAssets.size === 0) closeSocket('market');
  else await connectMarketSocket();

  if (nextMarkets.size === 0) closeSocket('user');
  else await connectUserSocket();

  maybeSendDynamicSubscriptions();
}

export async function startRealtimeMonitor({ getTrackedSnapshot, onSignal }) {
  if (state.running) return;

  if (!config.realtimeMonitoringEnabled) {
    log.info('Realtime monitor disabled by config (REALTIME_MONITORING=false)');
    return;
  }

  state.running = true;
  state.getTrackedSnapshot = getTrackedSnapshot;
  state.onSignal = onSignal;

  await syncRealtimeSubscriptions();

  state.syncTimer = setInterval(() => {
    syncRealtimeSubscriptions().catch((err) => {
      log.warn(`Realtime subscription sync failed: ${err.message}`);
    });
  }, SYNC_INTERVAL_MS);

  log.info('Realtime monitor started');
}

export function stopRealtimeMonitor() {
  if (!state.running) return;

  state.running = false;

  clearTimer(state.syncTimer);
  state.syncTimer = null;

  clearTimeoutSafe(state.signalTimer);
  state.signalTimer = null;
  state.queuedReasons.clear();
  state.queuedForceRefresh = false;

  clearTimeoutSafe(state.marketReconnectTimer);
  clearTimeoutSafe(state.userReconnectTimer);
  state.marketReconnectTimer = null;
  state.userReconnectTimer = null;
  state.marketReconnectAttempts = 0;
  state.userReconnectAttempts = 0;

  closeSocket('market');
  closeSocket('user');

  state.getTrackedSnapshot = null;
  state.onSignal = null;

  log.info('Realtime monitor stopped');
}
