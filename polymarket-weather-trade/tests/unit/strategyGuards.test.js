import test from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluateBoundaryNoTrade,
  extractNearestEventTempC,
  shouldRunAiValidator,
} from '../../src/strategyGuards.js';

test('extractNearestEventTempC prefers <<<EVENT marker', () => {
  const weatherText = [
    '2026-03-17 09:00:00 | temp=8.4C',
    '2026-03-17 12:00:00 <<<EVENT | temp=9.1C',
  ].join('\n');

  assert.equal(extractNearestEventTempC(weatherText), 9.1);
});

test('boundary no-trade blocks near threshold without override', () => {
  const weatherText = '2026-03-17 12:00:00 <<<EVENT | temp=9.12C';
  const out = evaluateBoundaryNoTrade({
    weatherText,
    predictedOutcome: 'Will temp be between 9 and 10 C?',
    bandDegrees: 0.2,
    confidence: 70,
    edge: 0.04,
    overrideConfidence: 82,
    overrideEdge: 0.08,
  });

  assert.equal(out.blocked, true);
  assert.equal(out.reason, 'boundary_no_trade_band');
});

test('boundary no-trade allows near threshold with strong override', () => {
  const weatherText = '2026-03-17 12:00:00 <<<EVENT | temp=9.12C';
  const out = evaluateBoundaryNoTrade({
    weatherText,
    predictedOutcome: 'Will temp be between 9 and 10 C?',
    bandDegrees: 0.2,
    confidence: 90,
    edge: 0.11,
    overrideConfidence: 82,
    overrideEdge: 0.08,
  });

  assert.equal(out.blocked, false);
  assert.equal(out.reason, 'override_threshold_met');
});

test('shouldRunAiValidator triggers on borderline confidence or edge', () => {
  assert.equal(
    shouldRunAiValidator({ enabled: true, confidence: 70, edge: 0.09, confidenceMax: 74, edgeMax: 0.06 }),
    true,
  );
  assert.equal(
    shouldRunAiValidator({ enabled: true, confidence: 90, edge: 0.04, confidenceMax: 74, edgeMax: 0.06 }),
    true,
  );
  assert.equal(
    shouldRunAiValidator({ enabled: true, confidence: 90, edge: 0.10, confidenceMax: 74, edgeMax: 0.06 }),
    false,
  );
});
