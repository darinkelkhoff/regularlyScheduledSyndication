import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scheduleLabel } from '../src/client/schedule-label.ts';

const clock = { hour: 10, timeZone: 'America/Chicago' };
test('describes weekly release days in plain language', () => {
  assert.equal(scheduleLabel({ ...clock, kind: 'weekly', weekdays: [7] }), 'Every Sunday at 10 AM');
  assert.equal(scheduleLabel({ ...clock, kind: 'weekly', weekdays: [1, 4] }), 'Every Monday and Thursday at 10 AM');
});
test('describes daily releases at midnight and noon', () => {
  assert.equal(scheduleLabel({ ...clock, kind: 'daily', hour: 0 }), 'Every day at 12 AM');
  assert.equal(scheduleLabel({ ...clock, kind: 'daily', hour: 12 }), 'Every day at 12 PM');
});
test('describes the interval and weekday', () => {
  assert.equal(scheduleLabel({ ...clock, kind: 'interval', weeks: 2, weekday: 7, startDate: '2026-11-01' }), 'Every 2 weeks on Sunday at 10 AM');
  assert.equal(scheduleLabel({ ...clock, kind: 'interval', weeks: 1, weekday: 2, startDate: '2026-11-03', hour: 22 }), 'Every week on Tuesday at 10 PM');
});
