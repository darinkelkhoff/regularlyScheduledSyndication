import { MemoryFeedStore } from './helpers/feed-store.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { database } from './helpers/d1.ts';
import { SourceVault } from '../src/security/source-vault.ts';
import { ImportService } from '../src/importer/service.ts';
import { Subscriptions } from '../src/db/subscriptions.ts';
import { LocalPublisher } from '../src/publishing/local-publisher.ts';
import { rssPreview } from '../src/publishing/preview.ts';
const xml = await readFile(new URL('./fixtures/podcast.xml', import.meta.url), 'utf8');
async function setup(t: Parameters<typeof database>[0]) {
  const db = await database(t); const vault = await SourceVault.create(new Uint8Array(32).fill(8));
  const source = await new ImportService(db, vault, async () => ({ status: 200, xml })).preview('alice', 'https://example.com/feed');
  const repository = new Subscriptions(db);
  const id = await repository.create('alice', source.sourceId, { schedule: { kind: 'daily', hour: 12, timeZone: 'UTC' }, selection: { mode: 'all' }, live: false, choice: 'now' }, '2026-10-27T10:00:00Z');
  const store = new MemoryFeedStore(); const publisher = new LocalPublisher(db, vault, store);
  return { db, vault, repository, id, publisher, store };
}
test('publishes an empty feed, then updates the same private URL from committed history', async t => {
  const { db, repository, id, publisher, store } = await setup(t);
  assert.equal(await publisher.publish('alice', id), true);
  const token = await publisher.token('alice', id); assert.ok(token);
  assert.ok(!(await publisher.read(token!))!.includes('<item>'));
  await repository.process('alice', id, 0, '2026-10-27T10:00:00Z');
  assert.equal(await publisher.publish('alice', id), true);
  const published = (await publisher.read(token!))!;
  assert.ok(published.includes('The first connection')); assert.ok(!published.includes('The second connection'));
  assert.equal(await publisher.token('alice', id), token);
  await publisher.publish('alice', id);
  assert.equal(await publisher.read(token!), published);
  assert.equal((await repository.load('alice', id))!.state.releases.length, 1);
  const stored = JSON.stringify((await db.prepare('SELECT * FROM local_feeds').all()).results);
  assert.ok(!stored.includes(token!)); assert.ok(!stored.includes('audio.example'));
  assert.ok(![...store.values.values()].join('').includes('audio.example'));
  assert.equal(store.values.size, 1);
  assert.equal((await db.prepare('SELECT published_version FROM publication_outbox WHERE subscription_id = ?').bind(id).first())!.published_version, 1);
});
test('reset revokes the old token without changing XML or delivery GUIDs; other owners cannot reveal or reset', async t => {
  const { publisher, id } = await setup(t); await publisher.publish('alice', id);
  const old = (await publisher.token('alice', id))!; const before = await publisher.read(old);
  assert.equal(await publisher.token('bob', id), null);
  assert.equal(await publisher.reset('bob', id), null);
  const replacement = await publisher.reset('alice', id); assert.ok(replacement); assert.notEqual(replacement, old);
  assert.equal(await publisher.read(old), null); assert.equal(await publisher.read(replacement!), before);
});
test('stale publishers cannot overwrite newer releases or restore a revoked token', async t => {
  const { db, vault, publisher, repository, id, store } = await setup(t);
  await publisher.publish('alice', id); const old = (await publisher.token('alice', id))!;
  await db.prepare('UPDATE subscriptions SET publication_version = publication_version + 1 WHERE id = ?').bind(id).run();
  const stale = new LocalPublisher(db, vault, store, async (...args) => {
    const snapshot = await rssPreview(...args);
    await repository.process('alice', id, 0, '2026-10-27T10:00:00Z');
    await publisher.publish('alice', id); await publisher.reset('alice', id);
    return snapshot;
  });
  assert.equal(await stale.publish('alice', id), false);
  assert.equal(await publisher.read(old), null);
  assert.ok((await publisher.read((await publisher.token('alice', id))!))!.includes('The first connection'));
});
test('publication failure retains last good XML and never releases another episode', async t => {
  const { db, vault, publisher, repository, id, store } = await setup(t); await publisher.publish('alice', id);
  const token = (await publisher.token('alice', id))!; const previous = await publisher.read(token);
  await repository.process('alice', id, 0, '2026-10-27T10:00:00Z');
  const broken = new LocalPublisher(db, vault, store, async () => { throw new Error('private upstream detail'); });
  assert.equal(await broken.publish('alice', id), false);
  assert.equal(await publisher.read(token), previous);
  assert.equal((await repository.load('alice', id))!.state.releases.length, 1);
  assert.equal((await db.prepare('SELECT attempts FROM publication_outbox WHERE subscription_id = ?').bind(id).first())!.attempts, 1);
  await publisher.flush(); assert.ok((await publisher.read(token))!.includes('The first connection'));
});

test('failed object writes preserve the current snapshot and pending publication', async t => {
  const { db, vault, publisher, repository, id, store } = await setup(t);
  await publisher.publish('alice', id); const token = (await publisher.token('alice', id))!; const previous = await publisher.read(token);
  await repository.process('alice', id, 0, '2026-10-27T10:00:00Z');
  const broken = new LocalPublisher(db, vault, { get: store.get.bind(store), delete: store.delete.bind(store), async put() { throw new Error('Storage unavailable'); } });
  assert.equal(await broken.publish('alice', id), false);
  assert.equal(await publisher.read(token), previous);
  assert.equal((await publisher.status('alice', id))!.publishedVersion, 0);
  await publisher.flush(); assert.equal((await publisher.status('alice', id))!.publishedVersion, 1);
});

test('unchanged publication skips rendering and competing publishers retain only the winning snapshot', async t => {
  const { db, vault, publisher, id, store, repository } = await setup(t);
  await publisher.publish('alice', id);
  const unchanged = new LocalPublisher(db, vault, store, async () => { throw new Error('Must not render unchanged feed'); });
  assert.equal(await unchanged.publish('alice', id), true);
  await repository.process('alice', id, 0, '2026-10-27T10:00:00Z');
  let renders = 0; let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const competing = new LocalPublisher(db, vault, store, async (...args) => {
    const xml = await rssPreview(...args);
    if (++renders === 2) release();
    await held;
    return xml;
  });
  const results = await Promise.all([competing.publish('alice', id), competing.publish('alice', id)]);
  assert.deepEqual(results.sort(), [false, true]);
  assert.equal(store.values.size, 1);
  assert.ok((await publisher.read((await publisher.token('alice', id))!))!.includes('The first connection'));
});
