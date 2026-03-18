import test from 'node:test';
import assert from 'node:assert/strict';
import { matchOutcome } from '../../src/outcomeMatcher.js';

test('matches side-prefixed AI outcome to market label', () => {
  const outcomes = [
    { outcome: 'YES', label: 'Will NYC hit 90F?' },
    { outcome: 'NO', label: 'Will NYC hit 90F?' },
  ];

  const hit = matchOutcome('YES - Will NYC hit 90F?', outcomes);
  assert.ok(hit);
  assert.equal(hit.outcome, 'YES');
});

test('matches YES/NO aliases', () => {
  const outcomes = [
    { outcome: 'YES', label: 'Above 1 inch rain' },
    { outcome: 'NO', label: 'Above 1 inch rain' },
  ];

  assert.equal(matchOutcome('above', outcomes)?.outcome, 'YES');
  assert.equal(matchOutcome('under', outcomes)?.outcome, 'NO');
});
