import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { database } from './helpers/d1.ts';
import { SourceVault } from '../src/security/source-vault.ts';
import { ImportService } from '../src/importer/service.ts';
import { Subscriptions } from '../src/db/subscriptions.ts';
import { LocalPublisher } from '../src/publishing/local-publisher.ts';
import { MemoryFeedStore } from './helpers/feed-store.ts';
import { deletePodcast } from '../src/db/delete-podcast.ts';
const xml = await readFile(new URL('./fixtures/podcast.xml', import.meta.url), 'utf8');
async function setup(t: Parameters<typeof database>[0]) {
  const db = await database(t); const vault = await SourceVault.create(new Uint8Array(32).fill(7));
  const source = await new ImportService(db, vault, async () => ({ status: 200, xml })).preview('alice', 'https://podcast.example/feed');
  const repository = new Subscriptions(db);
  const id = await repository.create('alice', source.sourceId, { schedule: { kind: 'daily', hour: 12, timeZone: 'UTC' }, selection: { mode: 'all' }, live: false, choice: 'now' }, new Date().toISOString());
  await repository.process('alice', id, 0, new Date().toISOString());
  const store = new MemoryFeedStore(); const publisher = new LocalPublisher(db, vault, store);
  await publisher.publish('alice', id); const token = (await publisher.token('alice', id))!;
  const revision = (await repository.load('alice', id))!.revision;
  return { db, vault, source, repository, id, store, publisher, token, revision };
}
test('deleting an owned podcast removes its records and immediately revokes its feed', async t => {
  const { db, repository, id, store, publisher, token, revision } = await setup(t);
  assert.equal(await deletePodcast(db, 'bob', id, revision), false);
  assert.equal(await deletePodcast(db, 'alice', id, revision - 1), false);
  assert.ok(await publisher.read(token));
  assert.equal(await deletePodcast(db, 'alice', id, revision), true);
  assert.equal(await repository.load('alice', id), null);
  assert.equal(await publisher.read(token), null);
  assert.equal(await publisher.publish('alice', id), false);
  for (const table of ['subscriptions', 'releases', 'episodes', 'sources', 'publication_outbox', 'local_feeds']) assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first())!.n, 0, table);
  await publisher.cleanupDeleted(); assert.equal(store.values.size, 0);
});

test('database failure rolls back deletion, revocation and history removal together', async t => {
  const { db, repository, publisher, token, id, revision } = await setup(t);
  await db.exec("CREATE TRIGGER fail_podcast_cleanup BEFORE DELETE ON episodes BEGIN SELECT RAISE(ABORT, 'Simulated cleanup failure'); END;");
  await assert.rejects(deletePodcast(db, 'alice', id, revision));
  assert.equal((await repository.load('alice', id))!.state.releases.length, 1);
  assert.ok(await publisher.read(token));
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM podcast_deletions').first())!.n, 0);
  await assert.rejects(db.prepare('DELETE FROM releases WHERE subscription_id = ?').bind(id).run());
});
test('a publisher already rendering cannot resurrect a deleted podcast or feed', async t => {
  const { db, vault, id, revision, publisher, token, store } = await setup(t);
  await db.prepare('UPDATE subscriptions SET publication_version = publication_version + 1 WHERE id = ?').bind(id).run();
  const stale = new LocalPublisher(db, vault, store, async () => {
    const xml = await publisher.read(token);
    assert.equal(await deletePodcast(db, 'alice', id, revision), true);
    await publisher.cleanupDeleted();
    return xml;
  });
  assert.equal(await stale.publish('alice', id), false);
  assert.equal(await publisher.read(token), null);
  assert.equal(store.values.size, 0);
});
test('failed object cleanup stays retryable while deleted feed access remains revoked', async t => {
  const { db, vault, id, revision, publisher, token, store } = await setup(t);
  assert.equal(await deletePodcast(db, 'alice', id, revision), true);
  const unavailable = new LocalPublisher(db, vault, { put: store.put.bind(store), get: store.get.bind(store), async delete() { throw new Error('Storage unavailable'); } });
  await unavailable.cleanupDeleted();
  assert.equal(await unavailable.read(token), null);
  assert.equal(store.values.size, 1);
  await publisher.cleanupDeleted(); assert.equal(store.values.size, 0);
});
