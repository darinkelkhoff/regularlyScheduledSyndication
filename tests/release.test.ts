import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activate, pause, editSchedule, resume, processRelease } from '../src/domain/release.ts';
import type { Schedule } from '../src/domain/schedule.ts';
import type { Episode } from '../src/domain/selection.ts';
const schedule: Schedule = { kind: 'weekly', weekdays: [7], hour: 12, timeZone: 'America/Chicago' };
const sunday = '2026-10-25T17:00:00Z';
const monday = '2026-10-26T17:00:00Z';
const episodes: Episode[] = Array.from({ length: 5 }, (_, i) => ({ id: String(i), publishedAt: `2020-01-0${i + 1}T00:00:00Z` }));
const setup = (now = '2026-10-24T17:00:00Z', choice: 'now' | 'next' = 'next') => activate(schedule, now, choice);
test('activation either waits or creates one immediate opportunity', () => {
  assert.equal(processRelease(setup(), episodes, '2026-10-24T18:00:00Z').releases.length, 0);
  const immediate = processRelease(setup('2026-10-24T17:00:00Z', 'now'), episodes, '2026-10-24T17:00:00Z');
  assert.equal(immediate.releases.length, 1);
  assert.equal(immediate.nextSlot, sunday);
  assert.equal(immediate.publicationVersion, 1);
});
test('a due slot releases the oldest episode and records delivery time', () => {
  const state = processRelease(setup(), [...episodes].reverse(), sunday);
  assert.deepEqual(state.releases, [{ episodeId: '0', deliveredAt: sunday }]);
  assert.equal(state.nextSlot, '2026-11-01T18:00:00Z');
  assert.equal(state.waiting, false);
  assert.deepEqual(processRelease(state, episodes, sunday), state);
});
test('empty Sunday retains one opportunity for Monday discovery', () => {
  const empty = processRelease(setup(), [], sunday);
  assert.equal(empty.waiting, true);
  assert.equal(empty.publicationVersion, 0);
  const discovered = processRelease(empty, episodes, monday);
  assert.equal(discovered.releases.length, 1);
  assert.equal(discovered.releases[0]?.deliveredAt, monday);
  assert.equal(discovered.nextSlot, '2026-11-01T18:00:00Z');
});
test('several missed weeks and five discoveries yield only one release', () => {
  const missed = processRelease(setup(), [], '2026-11-16T18:00:00Z');
  const state = processRelease(missed, episodes, '2026-11-22T18:00:00Z');
  assert.equal(state.releases.length, 1);
  assert.equal(state.nextSlot, '2026-11-29T18:00:00Z');
  assert.deepEqual(processRelease(state, episodes, '2026-11-22T18:00:00Z'), state);
});
test('downtime with a full queue does not create a catch-up burst', () => {
  const state = processRelease(setup(), episodes, '2026-12-01T00:00:00Z');
  assert.equal(state.releases.length, 1);
  assert.equal(state.nextSlot, '2026-12-06T18:00:00Z');
});
test('late Saturday can be followed by the original Sunday slot', () => {
  const empty = processRelease(setup(), [], sunday);
  const saturday = processRelease(empty, episodes, '2026-10-31T17:00:00Z');
  const next = processRelease(saturday, episodes, '2026-11-01T18:00:00Z');
  assert.equal(next.releases.length, 2);
});
test('older selections deliver later without rewriting immutable history', () => {
  const first = processRelease(setup(), [episodes[4]!], sunday);
  const second = processRelease(first, episodes, '2026-11-01T18:00:00Z');
  assert.deepEqual(second.releases.map(r => r.episodeId), ['4', '0']);
  assert.deepEqual(second.releases[0], first.releases[0]);
  assert.equal(first.releases.length, 1);
});
test('pause preserves delivery history and resume discards missed opportunities', () => {
  const initial = processRelease(setup(), episodes, sunday);
  const paused = pause(initial);
  assert.deepEqual(processRelease(paused, episodes, '2026-12-01T00:00:00Z'), paused);
  const resumed = resume(paused, '2026-12-01T00:00:00Z', 'next');
  assert.equal(resumed.waiting, false);
  assert.equal(resumed.nextSlot, '2026-12-06T18:00:00Z');
  assert.deepEqual(processRelease(resumed, episodes, '2026-12-01T00:00:00Z').releases, initial.releases);
  const now = resume(paused, '2026-12-01T00:00:00Z', 'now');
  assert.equal(processRelease(now, episodes, '2026-12-01T00:00:00Z').releases.length, 2);
});
test('schedule/timezone edits clear waiting opportunities and preserve history', () => {
  const empty = processRelease(setup(), [], sunday);
  const edited = editSchedule(empty, { kind: 'daily', hour: 9, timeZone: 'Asia/Tokyo' }, monday);
  assert.equal(edited.waiting, false);
  assert.equal(edited.nextSlot, '2026-10-27T00:00:00Z');
  assert.equal(processRelease(edited, episodes, monday).releases.length, 0);
});
test('live curated selections consume the same waiting opportunity', () => {
  const empty = processRelease(setup(), [], sunday);
  const selected = processRelease(empty, [episodes[3]!], monday);
  assert.equal(selected.releases[0]?.episodeId, '3');
});
test('editing a paused subscription never resumes deliveries', () => {
  const paused = pause(processRelease(setup(), episodes, sunday));
  const edited = editSchedule(paused, { kind: 'daily', hour: 9, timeZone: 'UTC' }, monday);
  assert.equal(edited.paused, true);
  assert.deepEqual(processRelease(edited, episodes, '2026-10-27T09:00:00Z').releases, paused.releases);
});
