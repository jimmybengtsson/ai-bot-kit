// src/statusTickQueue.js — status tick queue/replay state transitions

export function requestStatusTick(queueState, { forceRefresh = false, reason = 'scheduled' } = {}) {
  if (queueState.statusTickRunning) {
    queueState.statusTickPending = true;
    queueState.statusTickPendingForceRefresh = queueState.statusTickPendingForceRefresh || !!forceRefresh;
    queueState.statusTickPendingReasons.add(String(reason || 'queued'));
    queueState.statusTickQueuedCount += 1;
    return { runNow: false };
  }

  queueState.statusTickRunning = true;
  return { runNow: true };
}

export function finishStatusTick(queueState) {
  queueState.statusTickRunning = false;

  if (!queueState.statusTickPending) return null;

  const queuedForceRefresh = queueState.statusTickPendingForceRefresh;
  const queuedReasons = Array.from(queueState.statusTickPendingReasons);
  const queuedCount = queueState.statusTickQueuedCount;

  queueState.statusTickPending = false;
  queueState.statusTickPendingForceRefresh = false;
  queueState.statusTickPendingReasons.clear();
  queueState.statusTickQueuedCount = 0;

  const reason = queuedReasons.length > 0
    ? `queued:${queuedReasons.join(',')}`
    : 'queued:realtime';

  return {
    forceRefresh: queuedForceRefresh,
    reason,
    queuedCount: queuedCount || 1,
  };
}
