import { test } from 'node:test';
import assert from 'node:assert/strict';
import { database } from './helpers/d1.ts';
import { SourceVault } from '../src/security/source-vault.ts';
import { Catalog } from '../src/db/catalog.ts';
import { Subscriptions } from '../src/db/subscriptions.ts';
import type { Schedule } from '../src/domain/schedule.ts';
const now = '2026-10-27T00:00:00Z';
const due = '2026-10-27T17:00:00Z';
const schedule: Schedule = { kind: 'daily', hour: 12, timeZone: 'America/Chicago' };
async function setup(t: Parameters<typeof database>[0]) {
  const db = await database(t);
  const catalog = new Catalog(db, await SourceVault.create(new Uint8Array(32).fill(9)));
  const source = await catalog.addSource('alice', 'https://member:secret@example.com/feed?token=private');
  await catalog.importEpisodes('alice', source, [
    { id: 'b', publishedAt: '2020-01-02T00:00:00Z', title: 'Second' },
    { id: 'a', publishedAt: '2020-01-01T00:00:00Z', title: 'First' },
  ]);
  const subscriptions = new Subscriptions(db);
  const id = await subscriptions.create('alice', source, { schedule, selection: { mode: 'all' }, live: true, choice: 'next' }, now);
  return { db, catalog, source, subscriptions, id };
}
test('private sources are owner-isolated, deduplicated and encrypted at rest', async t => {
  const { db, catalog, source, subscriptions, id } = await setup(t);
  assert.equal(await catalog.addSource('alice', 'https://member:secret@example.com/feed?token=private'), source);
  const bob = await catalog.addSource('bob', 'https://member:secret@example.com/feed?token=private');
  assert.notEqual(source, bob);
  const stored = JSON.stringify((await db.prepare('SELECT * FROM sources').all()).results);
  assert.ok(!stored.includes('example.com'));
  assert.ok(!stored.includes('member:secret'));
  assert.equal(await catalog.sourceUrl('alice', source), 'https://member:secret@example.com/feed?token=private');
  await assert.rejects(catalog.sourceUrl('bob', source));
  await assert.rejects(catalog.importEpisodes('bob', source, [{ id: 'z', publishedAt: now, title: 'No' }]));
  assert.equal(await subscriptions.load('bob', id), null);
  await assert.rejects(subscriptions.create('bob', source, { schedule, selection: { mode: 'all' }, live: false, choice: 'next' }, now));
  await assert.rejects(subscriptions.create('alice', source, { schedule, selection: { mode: 'all' }, live: false, choice: 'next' }, now));
});
test('episode upserts preserve stable identities and retain omitted episodes', async t => {
  const { catalog, source, subscriptions, id } = await setup(t);
  await catalog.importEpisodes('alice', source, [{ id: 'a', publishedAt: '2020-01-01T00:00:00Z', title: 'Renamed' }]);
  const snapshot = (await subscriptions.load('alice', id))!;
  assert.equal(snapshot.episodes.length, 2);
  assert.equal(snapshot.episodes.find(e => e.id === 'a')?.title, 'Renamed');
});
test('two jobs using the same revision commit exactly one release and outbox update', async t => {
  const { db, subscriptions, id } = await setup(t);
  const first = (await subscriptions.load('alice', id))!;
  const second = (await subscriptions.load('alice', id))!;
  let arrived = 0;
  const revisions: number[] = [];
  let unblock!: () => void;
  const barrier = new Promise<void>(resolve => { unblock = resolve; });
  class CoordinatedSubscriptions extends Subscriptions {
    override async load(owner: string, subscriptionId: string) {
      const snapshot = await super.load(owner, subscriptionId);
      revisions.push(snapshot!.revision);
      if (++arrived === 2) unblock();
      await barrier;
      return snapshot;
    }
  }
  const concurrent = new CoordinatedSubscriptions(db);
  const results = await Promise.all([
    concurrent.process('alice', id, first.revision, due),
    concurrent.process('alice', id, second.revision, due),
  ]);
  assert.deepEqual(revisions, [0, 0]);
  assert.deepEqual(results.sort(), [false, true]);
  const saved = (await subscriptions.load('alice', id))!;
  assert.deepEqual(saved.state.releases.map(r => r.episodeId), ['a']);
  assert.equal(saved.state.publicationVersion, 1);
  assert.equal(saved.revision, 1);
  assert.equal((await db.prepare('SELECT desired_version FROM publication_outbox WHERE subscription_id = ?').bind(id).first())?.desired_version, 1);
  assert.equal(await subscriptions.process('alice', id, first.revision, due), false);
  assert.equal(await subscriptions.process('alice', id, saved.revision, due), true);
  assert.equal((await subscriptions.load('alice', id))!.state.releases.length, 1);
});
test('a failed delivery batch rolls state and publication work back together', async t => {
  const { db, subscriptions, id } = await setup(t);
  await db.exec("CREATE TRIGGER fail_publication BEFORE UPDATE ON publication_outbox BEGIN SELECT RAISE(ABORT, 'injected publication failure'); END;");
  await assert.rejects(subscriptions.process('alice', id, 0, due));
  const saved = (await subscriptions.load('alice', id))!;
  assert.equal(saved.revision, 0);
  assert.equal(saved.state.releases.length, 0);
  assert.equal(saved.state.publicationVersion, 0);
  await db.exec('DROP TRIGGER fail_publication;');
  assert.equal(await subscriptions.process('alice', id, 0, due), true);
});
test('pause and edits invalidate stale processors and keep paused subscriptions paused', async t => {
  const { subscriptions, id } = await setup(t);
  assert.equal(await subscriptions.change('alice', id, 0, { kind: 'pause' }, due), true);
  assert.equal(await subscriptions.process('alice', id, 0, due), false);
  assert.equal(await subscriptions.change('alice', id, 0, { kind: 'resume', choice: 'now' }, due), false);
  assert.equal(await subscriptions.change('alice', id, 1, { kind: 'schedule', schedule: { ...schedule, hour: 9 } }, due), true);
  const paused = (await subscriptions.load('alice', id))!;
  assert.equal(paused.state.paused, true);
  assert.equal(await subscriptions.change('bob', id, 2, { kind: 'resume', choice: 'now' }, due), false);
  assert.equal(await subscriptions.change('alice', id, 2, { kind: 'resume', choice: 'now' }, due), true);
  assert.equal(await subscriptions.process('alice', id, 3, due), true);
  assert.equal((await subscriptions.load('alice', id))!.state.releases.length, 1);
});
test('release GUIDs survive metadata edits and database history is append-only', async t => {
  const { db, catalog, source, subscriptions, id } = await setup(t);
  await subscriptions.process('alice', id, 0, due);
  const first = await db.prepare('SELECT * FROM releases WHERE subscription_id = ?').bind(id).first();
  await catalog.importEpisodes('alice', source, [{ id: 'a', publishedAt: '2020-01-01T00:00:00Z', title: 'Changed' }]);
  assert.equal((await db.prepare('SELECT output_guid FROM releases WHERE subscription_id = ?').bind(id).first())?.output_guid, first?.output_guid);
  await assert.rejects(db.prepare('UPDATE releases SET delivered_at = ? WHERE subscription_id = ?').bind(now, id).run());
  await assert.rejects(db.prepare('DELETE FROM releases WHERE subscription_id = ?').bind(id).run());
});
test('live before-boundary subscriptions are rejected', async t => {
  const { catalog, subscriptions } = await setup(t);
  const source = await catalog.addSource('alice', 'https://example.com/other');
  await catalog.importEpisodes('alice', source, [{ id: 'boundary', title: 'Boundary', publishedAt: now }]);
  await assert.rejects(subscriptions.create('alice', source, { schedule, selection: { mode: 'before', boundaryId: 'boundary' }, live: true, choice: 'next' }, now));
});
test('source discoveries invalidate an in-flight release decision', async t => {
  const { db, catalog, source, id } = await setup(t);
  class RacingSubscriptions extends Subscriptions {
    override async load(owner: string, subscriptionId: string) {
      const snapshot = await super.load(owner, subscriptionId);
      await catalog.importEpisodes('alice', source, [{ id: 'older', title: 'Older', publishedAt: '2019-01-01T00:00:00Z' }]);
      return snapshot;
    }
  }
  assert.equal(await new RacingSubscriptions(db).process('alice', id, 0, due), false);
  const subscriptions = new Subscriptions(db);
  assert.equal((await subscriptions.load('alice', id))!.state.releases.length, 0);
  assert.equal(await subscriptions.process('alice', id, 0, due), true);
  assert.equal((await subscriptions.load('alice', id))!.state.releases[0]?.episodeId, 'older');
});
test('curated selection edits persist and consume exactly one empty opportunity', async t => {
  const { subscriptions, id } = await setup(t);
  await subscriptions.change('alice', id, 0, { kind: 'selection', selection: { mode: 'choose', ids: [] }, live: true }, now);
  await subscriptions.process('alice', id, 1, due);
  assert.equal((await subscriptions.load('alice', id))!.state.waiting, true);
  await subscriptions.change('alice', id, 2, { kind: 'selection', selection: { mode: 'choose', ids: ['b'] }, live: true }, due);
  await subscriptions.process('alice', id, 3, '2026-10-27T18:00:00Z');
  assert.deepEqual((await subscriptions.load('alice', id))!.state.releases.map(r => r.episodeId), ['b']);
  await subscriptions.change('alice', id, 4, { kind: 'selection', selection: { mode: 'all' }, live: true }, due);
  await subscriptions.process('alice', id, 5, '2026-10-28T17:00:00Z');
  assert.deepEqual((await subscriptions.load('alice', id))!.state.releases.map(r => r.episodeId), ['b', 'a']);
});
test('metadata changes on delivered episodes invalidate publication without a new release', async t => {
  const { db, catalog, source, subscriptions, id } = await setup(t);
  await subscriptions.process('alice', id, 0, due);
  await catalog.importEpisodes('alice', source, [{ id: 'a', publishedAt: '2020-01-01T00:00:00Z', title: 'Corrected title' }]);
  const state = (await subscriptions.load('alice', id))!;
  assert.equal(state.state.publicationVersion, 2);
  assert.equal(state.state.releases.length, 1);
  assert.equal((await db.prepare('SELECT desired_version FROM publication_outbox WHERE subscription_id = ?').bind(id).first())?.desired_version, 2);
});
test('database foreign keys prevent cross-owner and cross-source relationships', async t => {
  const { db, catalog, source, id } = await setup(t);
  const other = await catalog.addSource('bob', 'https://example.com/bob');
  await catalog.importEpisodes('bob', other, [{ id: 'a', title: 'Other user episode', publishedAt: now }]);
  await assert.rejects(db.prepare(`INSERT INTO subscriptions
    (id, user_id, source_id, schedule_json, selection_json, live, next_slot)
    SELECT 'invalid-owner', 'bob', ?, schedule_json, selection_json, live, next_slot FROM subscriptions WHERE id = ?`)
    .bind(source, id).run());
  await assert.rejects(db.prepare(`INSERT INTO releases
    (subscription_id, source_id, episode_identity, delivered_at, sequence, output_guid)
    VALUES (?, ?, 'a', ?, 1, ?)`)
    .bind(id, other, due, crypto.randomUUID()).run());
});
test('INSERT OR REPLACE cannot rewrite committed delivery history', async t => {
  const { db, subscriptions, id } = await setup(t);
  await subscriptions.process('alice', id, 0, due);
  const original = await db.prepare('SELECT * FROM releases WHERE subscription_id = ?').bind(id).first();
  await assert.rejects(db.prepare(`INSERT OR REPLACE INTO releases
    (subscription_id, source_id, episode_identity, delivered_at, sequence, output_guid)
    SELECT subscription_id, source_id, episode_identity, ?, sequence, ? FROM releases WHERE subscription_id = ?`)
    .bind('2030-01-01T00:00:00Z', crypto.randomUUID(), id).run());
  assert.deepEqual(await db.prepare('SELECT * FROM releases WHERE subscription_id = ?').bind(id).first(), original);
});
