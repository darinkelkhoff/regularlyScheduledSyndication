import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDateTime, formatDate, calendarDate } from '../src/client/date-format.ts';
test('weekday and displayed clock use the same timezone, including date rollover', () => {
  const instant = '2026-10-28T01:00:00Z';
  assert.match(formatDateTime(instant, 'America/Chicago', 'en-US'), /^Tue, Oct 27, 2026, 8:00 PM$/);
  assert.match(formatDateTime(instant, 'UTC', 'en-US'), /^Wed, Oct 28, 2026, 1:00 AM$/);
});
test('original publication dates include weekday and year', () => {
  assert.equal(formatDate('2024-01-02T12:00:00Z', 'UTC', 'en-US'), 'Tue, Jan 2, 2024');
});
test('interval starting dates use the selected calendar rather than UTC', () => {
  assert.equal(calendarDate('2026-10-28T01:00:00Z', 'America/Chicago'), '2026-10-27');
  assert.equal(calendarDate('2026-10-28T01:00:00Z', 'Asia/Tokyo'), '2026-10-28');
});
