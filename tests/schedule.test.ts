import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextSlot, previewSlots, type Schedule } from '../src/domain/schedule.ts';
const daily: Schedule = { kind: 'daily', hour: 12, timeZone: 'America/Chicago' };
test('daily schedules follow local noon across spring DST', () => {
  assert.deepEqual(previewSlots(daily, '2026-03-07T17:59:00Z', 3), [
    '2026-03-07T18:00:00Z', '2026-03-08T17:00:00Z', '2026-03-09T17:00:00Z',
  ]);
});
test('weekly schedules use selected ISO weekdays and strictly future slots', () => {
  const s: Schedule = { ...daily, kind: 'weekly', weekdays: [2, 4] };
  assert.equal(nextSlot(s, '2026-10-27T17:00:00Z'), '2026-10-29T17:00:00Z');
});
test('every N weeks stays anchored and never precedes the start date', () => {
  const s: Schedule = { ...daily, kind: 'interval', weeks: 3, weekday: 7, startDate: '2026-10-28' };
  assert.deepEqual(previewSlots(s, '2026-10-01T00:00:00Z', 3), [
    '2026-11-01T18:00:00Z', '2026-11-22T18:00:00Z', '2026-12-13T18:00:00Z',
  ]);
  assert.equal(nextSlot(s, '2036-10-27T00:00:00Z'), '2036-11-02T18:00:00Z');
});
test('nonexistent hours advance and repeated hours occur only once', () => {
  assert.equal(nextSlot({ ...daily, hour: 2 }, '2026-03-08T00:00:00Z'), '2026-03-08T08:00:00Z');
  const fall = { ...daily, hour: 1 };
  assert.equal(nextSlot(fall, '2026-11-01T00:00:00Z'), '2026-11-01T06:00:00Z');
  assert.equal(nextSlot(fall, '2026-11-01T06:30:00Z'), '2026-11-02T07:00:00Z');
});
test('half-hour DST gaps move to the next valid whole hour', () => {
  assert.equal(nextSlot({ ...daily, hour: 2, timeZone: 'Australia/Lord_Howe' }, '2026-10-03T12:00:00Z'), '2026-10-03T16:00:00Z');
});
test('rejects invalid schedule values and excessive previews', () => {
  for (const s of [
    { ...daily, hour: 24 }, { ...daily, hour: 1.5 }, { ...daily, timeZone: '+02:00' },
    { ...daily, timeZone: 'No/Such_Zone' }, { ...daily, kind: 'weekly', weekdays: [] },
    { ...daily, kind: 'weekly', weekdays: [0] },
    { ...daily, kind: 'interval', weeks: 0, weekday: 7, startDate: '2026-10-28' },
  ]) assert.throws(() => nextSlot(s as Schedule, '2026-10-27T00:00:00Z'));
  assert.throws(() => previewSlots(daily, '2026-10-27T00:00:00Z', 1001));
});
