import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { database } from './helpers/d1.ts';
import { SourceVault } from '../src/security/source-vault.ts';
import { Catalog } from '../src/db/catalog.ts';
import { Subscriptions } from '../src/db/subscriptions.ts';
import { ImportService } from '../src/importer/service.ts';
import { runBackground } from '../src/jobs/background.ts';
const xml = await readFile(new URL('./fixtures/podcast.xml', import.meta.url), 'utf8');
const old = '2020-01-01T00:00:00Z';
test('background releases at most one episode after downtime; pause and disabled accounts stay untouched', async t => {
  const db = await database(t); const vault = await SourceVault.create(new Uint8Array(32).fill(6));
  const catalog = new Catalog(db, vault); const repository = new Subscriptions(db);
  const create = async (owner: string, path: string) => {
    const source = await catalog.addSource(owner, `https://example.com/${path}`);
    await catalog.importEpisodes(owner, source, [{ id: 'one', title: 'One', publishedAt: old }, { id: 'two', title: 'Two', publishedAt: old }]);
    return repository.create(owner, source, { schedule: { kind: 'daily', hour: 12, timeZone: 'UTC' }, selection: { mode: 'all' }, live: false, choice: 'next' }, old);
  };
  const active = await create('alice', 'active'); const paused = await create('alice', 'paused'); const disabled = await create('bob', 'disabled');
  await repository.change('alice', paused, 0, { kind: 'pause' }, old);
  await db.prepare('UPDATE users SET disabled = 1 WHERE id = ?').bind('bob').run();
  assert.equal(await repository.process('bob', disabled, 0, '2026-10-27T12:00:00Z'), false);
  const importer = new ImportService(db, vault, async () => { throw new Error('Finite sources should not poll'); });
  await runBackground(db, importer, '2026-10-27T12:00:00Z');
  await runBackground(db, importer, '2026-10-27T12:00:00Z');
  assert.equal((await repository.load('alice', active))!.state.releases.length, 1);
  assert.equal((await repository.load('alice', paused))!.state.releases.length, 0);
  assert.equal((await repository.load('bob', disabled))!.state.releases.length, 0);
});
test('live polling respects next-check time and discovers before processing waiting releases', async t => {
  const db = await database(t); const vault = await SourceVault.create(new Uint8Array(32).fill(6)); let requests = 0;
  const importer = new ImportService(db, vault, async () => { requests++; return { status: 200, xml }; });
  const source = await importer.preview('alice', 'https://example.com/feed');
  const repository = new Subscriptions(db);
  const id = await repository.create('alice', source.sourceId, { schedule: { kind: 'daily', hour: 12, timeZone: 'UTC' }, selection: { mode: 'all' }, live: true, choice: 'now' }, old);
  await runBackground(db, importer); assert.equal(requests, 1);
  await db.prepare('UPDATE sources SET next_check_at = 0').run();
  await runBackground(db, importer); assert.equal(requests, 2);
  assert.equal((await repository.load('alice', id))!.state.releases.length, 1);
});
test('background batches are bounded and failed polls do not starve other sources', async t => {
  const db = await database(t); const vault = await SourceVault.create(new Uint8Array(32).fill(6)); let fail = false; let requests = 0;
  const importer = new ImportService(db, vault, async () => { if (fail) { requests++; throw new Error('private upstream error'); } return { status: 200, xml }; });
  const repository = new Subscriptions(db);
  for (let i = 0; i < 4; i++) {
    const source = await importer.preview('alice', `https://example.com/feed-${i}`);
    await repository.create('alice', source.sourceId, { schedule: { kind: 'daily', hour: 12, timeZone: 'UTC' }, selection: { mode: 'all' }, live: true, choice: 'next' }, new Date().toISOString());
  }
  await db.prepare('UPDATE sources SET next_check_at = 0').run(); fail = true;
  const first = await runBackground(db, importer); assert.equal(first.failures, 3); assert.equal(requests, 3);
  const second = await runBackground(db, importer); assert.equal(second.failures, 1); assert.equal(requests, 4);
  const stored = JSON.stringify((await db.prepare('SELECT last_error_code FROM sources').all()).results);
  assert.ok(!stored.includes('private upstream'));
});
test('a concurrent job skips an active lease and an expired lease can be recovered', async t => {
  const db = await database(t); const vault = await SourceVault.create(new Uint8Array(32).fill(6));
  let block = false; let entered!: () => void; let unblock!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { unblock = resolve; });
  const importer = new ImportService(db, vault, async () => { if (block) { entered(); await blocked; } return { status: 200, xml }; });
  const source = await importer.preview('alice', 'https://example.com/feed');
  await new Subscriptions(db).create('alice', source.sourceId, { schedule: { kind: 'daily', hour: 12, timeZone: 'UTC' }, selection: { mode: 'all' }, live: true, choice: 'next' }, old);
  await db.prepare('UPDATE sources SET next_check_at = 0').run(); block = true;
  const first = runBackground(db, importer); await started;
  assert.equal((await runBackground(db, importer)).skipped, true);
  await db.prepare("UPDATE users SET disabled = 1 WHERE id = 'alice'").run();
  unblock(); await first;
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM releases').first())!.n, 0);
  await assert.rejects(importer.refresh('alice', source.sourceId, false));
  await db.prepare("UPDATE users SET disabled = 0 WHERE id = 'alice'").run();
  await db.prepare("UPDATE background_job SET claim = 'abandoned', lease_until = 0").run();
  assert.equal((await runBackground(db, importer)).skipped, false);
});
