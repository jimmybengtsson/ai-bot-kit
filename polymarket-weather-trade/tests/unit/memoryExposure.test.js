import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getDailyUniqueExposureCount,
  getEventExposureSnapshot,
  getEventVolatilitySummary,
  recordOddsSnapshot,
} from '../../src/memory.js';

test('event exposure snapshot detects in-flight intents', () => {
  const snapshot = getEventExposureSnapshot({
    eventId: 'evt-42',
    eventTokenIds: ['tok-A', 'tok-B'],
    inFlightIntents: [
      {
        eventId: 'evt-42',
        tokenId: 'tok-Z',
        key: 'entry:evt-42:tok-Z:buy:YES',
        state: 'submit_started',
      },
    ],
  });

  assert.equal(snapshot.hasExposure, true);
  assert.ok(snapshot.reasons.includes('in_flight_intent'));
});

test('daily unique exposure count deduplicates identical event/token pairs', () => {
  const today = new Date().toISOString().slice(0, 10);
  const count = getDailyUniqueExposureCount({
    date: today,
    inFlightIntents: [
      { eventId: 'evt-1', tokenId: 'tok-1', createdAt: new Date().toISOString() },
      { eventId: 'evt-1', tokenId: 'tok-1', createdAt: new Date().toISOString() },
      { eventId: 'evt-2', tokenId: 'tok-2', createdAt: new Date().toISOString() },
      { eventId: 'evt-2', tokenId: 'tok-3', createdAt: new Date(Date.now() - 2 * 24 * 3600_000).toISOString() },
    ],
  });

  assert.equal(count, 2);
});

test('event volatility summary reports recent max move pct', () => {
  const eventId = `evt-vol-${Date.now()}`;
  recordOddsSnapshot(eventId, [{ outcome: 'YES', tokenId: 'tok-yes', price: 0.42 }]);
  recordOddsSnapshot(eventId, [{ outcome: 'YES', tokenId: 'tok-yes', price: 0.50 }]);

  const summary = getEventVolatilitySummary(eventId, [{ outcome: 'YES', price: 0.50 }]);
  assert.ok(summary.eventVolatilityPct > 0);
  assert.ok(summary.sampledOutcomes >= 1);
});
