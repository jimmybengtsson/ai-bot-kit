import test from 'node:test';
import assert from 'node:assert/strict';

import { scoreLiquidityQualitySnapshot } from '../../src/adapters/clob.js';

test('liquidity score is high for tight spread and deep book', () => {
  const out = scoreLiquidityQualitySnapshot({
    bestBid: 0.49,
    bestAsk: 0.50,
    bids: [{ size: 150 }, { size: 120 }, { size: 80 }],
    asks: [{ size: 140 }, { size: 100 }, { size: 90 }],
    observedAtMs: Date.now(),
  }, {
    maxSpreadPct: 0.08,
    freshMs: 90_000,
  });

  assert.equal(out.ok, true);
  assert.ok(out.score > 70);
});

test('liquidity score is low for wide spread and no depth', () => {
  const out = scoreLiquidityQualitySnapshot({
    bestBid: 0.30,
    bestAsk: 0.60,
    bids: [{ size: 1 }],
    asks: [{ size: 1 }],
    observedAtMs: Date.now() - 10 * 60_000,
  }, {
    maxSpreadPct: 0.08,
    freshMs: 90_000,
  });

  assert.equal(out.ok, true);
  assert.ok(out.score < 20);
});
