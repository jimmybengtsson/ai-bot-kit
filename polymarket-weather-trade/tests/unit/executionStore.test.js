import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const tmpDir = path.resolve(process.cwd(), 'tmp-tests');
fs.mkdirSync(tmpDir, { recursive: true });
process.env.EXECUTION_STATE_FILE = 'tmp-tests/execution-state.test.json';
process.env.AUDIT_STORE_FILE = 'tmp-tests/audit-store.test.json';
process.env.TELEMETRY_STATE_FILE = 'tmp-tests/telemetry-state.test.json';

for (const rel of [
  process.env.EXECUTION_STATE_FILE,
  process.env.AUDIT_STORE_FILE,
  process.env.TELEMETRY_STATE_FILE,
]) {
  const full = path.resolve(process.cwd(), rel);
  if (fs.existsSync(full)) fs.rmSync(full, { force: true });
}

const {
  beginExecution,
  buildExecutionKey,
  markExecutionSubmitted,
  markExecutionFilled,
} = await import('../../src/executionStore.js');

test('idempotency blocks duplicate in-flight and terminal submissions', () => {
  const key = buildExecutionKey({
    kind: 'entry',
    eventId: 'event-1',
    tokenId: 'token-1',
    action: 'buy',
    side: 'YES',
  });

  const first = beginExecution({ key, kind: 'entry', scope: 'event-1::token-1', payload: { price: 0.45, shares: 2 } });
  assert.equal(first.ok, true);

  const second = beginExecution({ key, kind: 'entry', scope: 'event-1::token-1', payload: { price: 0.45, shares: 2 } });
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'already_in_flight');

  markExecutionSubmitted(key, {
    orderId: 'order-1',
    status: 'submitted',
    tokenId: 'token-1',
    expectedPrice: 0.45,
    expectedShares: 2,
  });
  markExecutionFilled(key, { orderId: 'order-1', status: 'filled' });

  const third = beginExecution({ key, kind: 'entry', scope: 'event-1::token-1', payload: { price: 0.45, shares: 2 } });
  assert.equal(third.ok, false);
  assert.equal(third.reason, 'terminal_duplicate');
});
