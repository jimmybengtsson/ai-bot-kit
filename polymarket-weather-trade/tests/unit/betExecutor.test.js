import test from 'node:test';
import assert from 'node:assert/strict';
import { decideBetAction } from '../../src/skills/betExecutor.js';

test('stop-loss strictness triggers only below threshold', () => {
  const bet = { event_end: null, market_closed: false };
  const buyPrice = 0.40;

  // Default stop loss in config is 25% => stop-loss threshold is 0.30.
  assert.equal(decideBetAction(bet, 0.29, buyPrice), 'stop_loss');
  assert.equal(decideBetAction(bet, 0.30, buyPrice), 'stop_loss');
  assert.equal(decideBetAction(bet, 0.31, buyPrice), 'hold');
});
