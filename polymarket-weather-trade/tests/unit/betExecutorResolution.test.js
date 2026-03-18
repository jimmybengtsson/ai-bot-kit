import test from 'node:test';
import assert from 'node:assert/strict';

import { decideBetAction, decideResolutionAction } from '../../src/skills/betExecutor.js';

test('resolved market marks win only after close grace with terminal value', () => {
  const out = decideResolutionAction({
    marketClosed: true,
    minutesSinceClosed: 180,
    currentPrice: 1.0,
  });

  assert.equal(out.action, 'redeemed');
  assert.equal(out.reason, 'terminal_win_price');
});

test('resolved market marks loss only after close grace with terminal zero value', () => {
  const out = decideResolutionAction({
    marketClosed: true,
    minutesSinceClosed: 240,
    currentPrice: 0.0,
  });

  assert.equal(out.action, 'resolved_lost');
  assert.equal(out.reason, 'terminal_loss_price');
});

test('closed=true inside grace window does not auto-resolve yet', () => {
  const out = decideResolutionAction({
    marketClosed: true,
    minutesSinceClosed: 30,
    currentPrice: 1.0,
  });

  assert.equal(out.action, null);
  assert.equal(out.reason, 'grace_window');
});

test('dynamic TP lockout does not freeze forever after event_end when market is still open', () => {
  const bet = {
    event_end: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    market_closed: false,
  };

  const action = decideBetAction(bet, 0.85, 0.25);
  assert.equal(action, 'take_profit');
});
