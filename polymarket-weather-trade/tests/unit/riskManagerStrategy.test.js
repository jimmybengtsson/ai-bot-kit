import test from 'node:test';
import assert from 'node:assert/strict';

import { riskManager } from '../../src/skills/riskManager.js';
import { config } from '../../src/config.js';

test('dynamic confidence floor increases under high volatility', () => {
  const base = Number(config.minConfidence || 60);
  const dynamic = riskManager.getDynamicMinConfidence({ eventVolatilityPct: Number(config.volatilityHighPct || 18) + 1 });
  assert.ok(dynamic > base);
});

test('unique daily exposure budget gate rejects at configured cap', () => {
  const limit = Number(config.maxDailyUniqueExposures || 12);
  const out = riskManager.checkUniqueDailyExposureBudget(limit);
  assert.equal(out.allowed, false);
  assert.match(out.reason, /budget reached/i);
});
