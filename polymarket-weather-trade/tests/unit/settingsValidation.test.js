import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePublicSettings } from '../../src/settingsStore.js';

test('settings validation rejects invalid trading mode', () => {
  const out = validatePublicSettings({ TRADING_MODE: 'all-in' });
  assert.equal(out.valid, false);
  assert.ok(out.fieldErrors.some((e) => e.name === 'TRADING_MODE'));
});

test('settings validation enforces min/max odds cross-field consistency', () => {
  const out = validatePublicSettings({ MIN_ODDS_VALUE: '0.8', MAX_ODDS_VALUE: '0.2' });
  assert.equal(out.valid, false);
  assert.ok(out.fieldErrors.some((e) => e.name === 'MIN_ODDS_VALUE'));
});
