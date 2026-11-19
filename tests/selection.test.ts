import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectEpisodes, type Episode } from '../src/domain/selection.ts';
const episodes: Episode[] = [
  { id: 'c', publishedAt: '2020-01-03T00:00:00Z' },
  { id: 'b', publishedAt: '2020-01-02T00:00:00Z' },
  { id: 'a', publishedAt: '2020-01-02T00:00:00Z' },
];
test('complete archive sorts by original instant then stable identity without mutation', () => {
  assert.deepEqual(selectEpisodes(episodes, { mode: 'all' }).map(e => e.id), ['a', 'b', 'c']);
  assert.equal(episodes[0]?.id, 'c');
});
test('boundaries are strict and include identity ordering for timestamp ties', () => {
  assert.deepEqual(selectEpisodes(episodes, { mode: 'before', boundaryId: 'b' }).map(e => e.id), ['a']);
  assert.deepEqual(selectEpisodes(episodes, { mode: 'after', boundaryId: 'a' }).map(e => e.id), ['b', 'c']);
  assert.throws(() => selectEpisodes(episodes, { mode: 'before', boundaryId: 'missing' }));
});
test('curated discoveries require selection and delivered episodes stay excluded', () => {
  assert.deepEqual(selectEpisodes(episodes, { mode: 'choose', ids: ['a', 'c'] }, ['c']).map(e => e.id), ['a']);
  assert.deepEqual(selectEpisodes(episodes, { mode: 'choose', ids: [] }), []);
});
test('adding an older selection never inserts it into delivered history', () => {
  assert.deepEqual(selectEpisodes(episodes, { mode: 'all' }, ['b', 'c']).map(e => e.id), ['a']);
});
test('orders equivalent offset timestamps by identity and rejects corrupt identities/dates', () => {
  assert.deepEqual(selectEpisodes([
    { id: 'z', publishedAt: '2020-01-01T00:00:00Z' },
    { id: 'a', publishedAt: '2019-12-31T18:00:00-06:00' },
  ], { mode: 'all' }).map(e => e.id), ['a', 'z']);
  assert.throws(() => selectEpisodes([...episodes, episodes[0]!], { mode: 'all' }));
  assert.throws(() => selectEpisodes([{ id: 'a', publishedAt: 'invalid' }], { mode: 'all' }));
});
