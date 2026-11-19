import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expectedReleases } from '../src/client/expected-releases.ts';
const state = { schedule: { kind: 'daily' as const, hour: 12, timeZone: 'America/Chicago' }, nextSlot: '2026-10-31T17:00:00Z', waiting: false, paused: false };
test('dates begin at the saved slot and follow daylight saving changes', () => {
  assert.deepEqual(expectedReleases(state, 3, '2026-10-30T12:00:00Z'), ['2026-10-31T17:00:00Z', '2026-11-01T18:00:00Z', '2026-11-02T18:00:00Z']);
});
test('paused queues have no promised dates', () => {
  assert.deepEqual(expectedReleases({ ...state, paused: true }, 2, '2026-10-30T12:00:00Z'), [null, null]);
});
test('waiting and overdue queues have one immediate opportunity without catch-up dates', () => {
  assert.deepEqual(expectedReleases({ ...state, waiting: true }, 2, '2026-10-30T12:00:00Z'), [null, state.nextSlot]);
  assert.deepEqual(expectedReleases(state, 2, '2026-11-03T20:00:00Z'), [null, '2026-11-04T18:00:00Z']);
  assert.deepEqual(expectedReleases({ ...state, waiting: true }, 0, '2026-10-30T12:00:00Z'), []);
});
