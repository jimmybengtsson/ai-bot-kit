import test from 'node:test';
import assert from 'node:assert/strict';
import { finishStatusTick, requestStatusTick } from '../../src/statusTickQueue.js';

test('status tick queue replays websocket-triggered pending checks', () => {
  const state = {
    statusTickRunning: false,
    statusTickPending: false,
    statusTickPendingForceRefresh: false,
    statusTickPendingReasons: new Set(),
    statusTickQueuedCount: 0,
  };

  const first = requestStatusTick(state, { forceRefresh: false, reason: 'fallback_cron' });
  assert.equal(first.runNow, true);
  assert.equal(state.statusTickRunning, true);

  const realtimeQueued = requestStatusTick(state, { forceRefresh: true, reason: 'realtime:user_ws_update' });
  assert.equal(realtimeQueued.runNow, false);
  assert.equal(state.statusTickPending, true);
  assert.equal(state.statusTickPendingForceRefresh, true);

  const replay = finishStatusTick(state);
  assert.ok(replay);
  assert.equal(replay.forceRefresh, true);
  assert.match(replay.reason, /^queued:/);
  assert.equal(state.statusTickRunning, false);
  assert.equal(state.statusTickPending, false);
});
