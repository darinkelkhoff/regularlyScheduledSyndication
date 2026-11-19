import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectEpisodes, type Episode } from '../src/domain/selection.ts';
import { activate, processRelease } from '../src/domain/release.ts';
import { previewSlots, type Schedule } from '../src/domain/schedule.ts';
const schedule: Schedule = { kind: 'daily', hour: 12, timeZone: 'America/Chicago' };
const archive: Episode[] = [
  { id: '1', publishedAt: '2020-01-01T00:00:00Z' },
  { id: '2', publishedAt: '2020-01-02T00:00:00Z' },
  { id: '3', publishedAt: '2020-01-03T00:00:00Z' },
];
test('complete archive replay exhausts once and leaves history stable', () => {
  let state = activate(schedule, '2026-10-27T00:00:00Z', 'next');
  for (const slot of previewSlots(schedule, '2026-10-27T00:00:00Z', 5)) {
    state = processRelease(state, selectEpisodes(archive, { mode: 'all' }), slot);
  }
  assert.deepEqual(state.releases.map(r => r.episodeId), ['1', '2', '3']);
  assert.equal(state.publicationVersion, 3);
});
test('before-boundary replay remains finite despite later discoveries', () => {
  let state = activate(schedule, '2026-10-27T00:00:00Z', 'next');
  for (const slot of previewSlots(schedule, '2026-10-27T00:00:00Z', 5)) {
    state = processRelease(state, selectEpisodes(archive, { mode: 'before', boundaryId: '3' }), slot);
  }
  assert.deepEqual(state.releases.map(r => r.episodeId), ['1', '2']);
});
test('after-boundary live replay paces discoveries without a burst', () => {
  let state = activate(schedule, '2026-10-27T00:00:00Z', 'next');
  state = processRelease(state, selectEpisodes(archive.slice(0, 2), { mode: 'after', boundaryId: '2' }), '2026-10-27T17:00:00Z');
  state = processRelease(state, selectEpisodes(archive, { mode: 'after', boundaryId: '2' }), '2026-10-27T18:00:00Z');
  assert.deepEqual(state.releases.map(r => r.episodeId), ['3']);
  assert.equal(state.nextSlot, '2026-10-28T17:00:00Z');
});
test('curated discoveries wait for explicit selection before using an empty opportunity', () => {
  let state = activate(schedule, '2026-10-27T00:00:00Z', 'next');
  state = processRelease(state, selectEpisodes(archive, { mode: 'choose', ids: [] }), '2026-10-27T17:00:00Z');
  assert.equal(state.releases.length, 0);
  state = processRelease(state, selectEpisodes(archive, { mode: 'choose', ids: ['2', '3'] }), '2026-10-27T18:00:00Z');
  assert.deepEqual(state.releases.map(r => r.episodeId), ['2']);
});
