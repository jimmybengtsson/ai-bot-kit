import test from 'node:test';
import assert from 'node:assert/strict';
import { formatClimateDataForAI } from '../../src/skills/climateFetcher.js';

test('climate formatter keeps recent/yearly sampleType separation', () => {
  const text = formatClimateDataForAI({
    station: { id: 'GHCND:TEST', name: 'Test Station' },
    sampleAnchor: '2026-03-17T12:00:00.000Z',
    recentSamples: [
      {
        sampleType: 'recent',
        daysBack: 1,
        date: '2026-03-16',
        records: [{ sampleType: 'recent', datatype: 'TMAX', value: 21.5 }],
      },
    ],
    yearlyComparisons: [
      {
        sampleType: 'yearly',
        yearsBack: 1,
        date: '2025-03-17',
        records: [{ sampleType: 'yearly', datatype: 'TMAX', value: 18.2 }],
      },
    ],
  });

  assert.match(text, /RECENT DAILY OBSERVATIONS/i);
  assert.match(text, /SAME DATE DAILY OBSERVATIONS/i);
  assert.match(text, /2026-03-16/);
  assert.match(text, /2025-03-17/);
});
