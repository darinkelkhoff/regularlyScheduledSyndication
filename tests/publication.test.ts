import { test } from 'node:test';
import assert from 'node:assert/strict';
import { database } from './helpers/d1.ts';
import { SourceVault } from '../src/security/source-vault.ts';
import { Catalog } from '../src/db/catalog.ts';
import { Subscriptions } from '../src/db/subscriptions.ts';
import { PublicationOutbox } from '../src/db/publication-outbox.ts';

test('publication acknowledgement is owner-scoped and fenced by desired version', async t => {
  const db = await database(t);
  const catalog = new Catalog(db, await SourceVault.create(new Uint8Array(32).fill(1)));
  const source = await catalog.addSource('alice', 'https://example.com/feed');
  await catalog.importEpisodes('alice', source, [{ id: 'a', title: 'A', publishedAt: '2020-01-01T00:00:00Z' }]);
  const subscriptions = new Subscriptions(db);
  const id = await subscriptions.create('alice', source, {
    schedule: { kind: 'daily', hour: 12, timeZone: 'UTC' }, selection: { mode: 'all' }, live: false, choice: 'next',
  }, '2026-10-27T00:00:00Z');
  const outbox = new PublicationOutbox(db);
  assert.deepEqual(await outbox.pending('alice', id), { desiredVersion: 0, publishedVersion: -1, attempts: 0 });
  assert.equal(await outbox.pending('bob', id), null);
  assert.equal(await outbox.acknowledge('bob', id, 0), false);
  assert.equal(await outbox.acknowledge('alice', id, 0), true);
  assert.equal(await outbox.pending('alice', id), null);
  await subscriptions.process('alice', id, 0, '2026-10-27T12:00:00Z');
  assert.equal(await outbox.recordFailure('alice', id, 1), true);
  assert.equal((await outbox.pending('alice', id))?.attempts, 1);
  await catalog.importEpisodes('alice', source, [{ id: 'a', title: 'Corrected', publishedAt: '2020-01-01T00:00:00Z' }]);
  assert.equal(await outbox.acknowledge('alice', id, 1), false);
  assert.equal(await outbox.recordFailure('alice', id, 1), false);
  assert.equal((await outbox.pending('alice', id))?.desiredVersion, 2);
  assert.equal(await outbox.acknowledge('alice', id, 2), true);
  assert.equal(await outbox.acknowledge('alice', id, 2), false);
  assert.equal(await outbox.pending('alice', id), null);
  assert.equal((await subscriptions.load('alice', id))!.state.releases.length, 1);
});
