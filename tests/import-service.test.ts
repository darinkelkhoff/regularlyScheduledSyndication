import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { database } from './helpers/d1.ts';
import { SourceVault } from '../src/security/source-vault.ts';
import { ImportService } from '../src/importer/service.ts';
import { Subscriptions } from '../src/db/subscriptions.ts';
import { FeedError, type FeedTransport } from '../src/importer/types.ts';
const xml = await readFile(new URL('./fixtures/podcast.xml', import.meta.url), 'utf8');
async function setup(t: Parameters<typeof database>[0], transport: FeedTransport) {
  const db = await database(t); const vault = await SourceVault.create(new Uint8Array(32).fill(4));
  return { db, vault, importer: new ImportService(db, vault, transport) };
}
test('imports private source metadata, retains omitted episodes and supports conditional refresh', async t => {
  let request = 0;
  const { db, vault, importer } = await setup(t, async (_url, validators) => {
    request++; if (request === 2) { assert.equal(validators?.etag, 'secret-validator'); return { status: 304 }; }
    return { status: 200, xml: request === 3 ? xml.replace(/<item><guid>episode-one<\/guid>.*?<\/item>/s, '') : xml, etag: 'secret-validator' };
  });
  const source = await importer.preview('alice', 'https://member:password@podcast.example/feed?token=private');
  assert.equal(source.title, 'Signal Paths'); assert.equal(source.episodes.length, 2);
  const stored = JSON.stringify((await db.prepare('SELECT * FROM sources').all()).results) + JSON.stringify((await db.prepare('SELECT * FROM episodes').all()).results);
  for (const secret of ['member:password', 'token=private', 'secret-validator', 'audio.example']) assert.ok(!stored.includes(secret));
  const before = (await db.prepare('SELECT revision FROM sources WHERE id = ?').bind(source.sourceId).first())!.revision;
  await importer.refresh('alice', source.sourceId);
  assert.equal((await db.prepare('SELECT revision FROM sources WHERE id = ?').bind(source.sourceId).first())?.revision, before);
  await importer.refresh('alice', source.sourceId);
  assert.equal((await importer.summary('alice', source.sourceId)).episodes.length, 2);
  const row = await db.prepare('SELECT identity, metadata_ciphertext FROM episodes WHERE source_id = ? LIMIT 1').bind(source.sourceId).first<{ identity: string; metadata_ciphertext: string }>();
  assert.ok((await vault.open(`alice:episode:${source.sourceId}:${row!.identity}`, row!.metadata_ciphertext)).includes('enclosure'));
  await assert.rejects(importer.summary('bob', source.sourceId));
  await assert.rejects(importer.refresh('bob', source.sourceId));
});
test('poll failures keep prior episodes and record only safe error codes with backoff', async t => {
  let fail = false;
  const { db, importer } = await setup(t, async () => { if (fail) throw new Error('https://member:private@host.example'); return { status: 200, xml }; });
  const source = await importer.preview('alice', 'https://podcast.example/feed'); fail = true;
  await assert.rejects(importer.refresh('alice', source.sourceId));
  const summary = await importer.summary('alice', source.sourceId);
  assert.equal(summary.episodes.length, 2); assert.ok(summary.lastSuccessAt); assert.equal(summary.lastError, 'feed_fetch_failed');
  const row = await db.prepare('SELECT * FROM sources WHERE id = ?').bind(source.sourceId).first();
  assert.ok(!JSON.stringify(row).includes('member:private')); assert.ok(Number(row?.next_check_at) > Date.now());
});
test('a durable poll lease rejects concurrent refreshes and does not duplicate episodes', async t => {
  let release!: () => void; let started!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; }); const ready = new Promise<void>(resolve => { started = resolve; });
  let hold = false;
  const { db, importer } = await setup(t, async () => { if (hold) { started(); await pending; } return { status: 200, xml }; });
  const source = await importer.preview('alice', 'https://podcast.example/feed'); hold = true;
  const first = importer.refresh('alice', source.sourceId); await ready;
  await assert.rejects(importer.refresh('alice', source.sourceId), (error: unknown) => error instanceof FeedError && error.code === 'source_busy');
  release(); await first;
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM episodes WHERE source_id = ?').bind(source.sourceId).first())?.n, 2);
});
test('refresh changes dirty committed publication history without adding a delivery', async t => {
  let edited = false;
  const { db, importer } = await setup(t, async () => ({ status: 200, xml: edited ? xml.replace('two.mp3?token=private', 'two-updated.mp3?token=new') : xml }));
  const source = await importer.preview('alice', 'https://podcast.example/feed');
  const subscriptions = new Subscriptions(db); const now = new Date().toISOString();
  const id = await subscriptions.create('alice', source.sourceId, { schedule: { kind: 'daily', hour: 12, timeZone: 'UTC' }, selection: { mode: 'choose', ids: [source.episodes.find(e => e.episodeNumber === '42')!.id] }, live: true, choice: 'now' }, now);
  await subscriptions.process('alice', id, 0, now); edited = true;
  await importer.refresh('alice', source.sourceId);
  const saved = (await subscriptions.load('alice', id))!;
  assert.equal(saved.state.releases.length, 1); assert.equal(saved.state.publicationVersion, 2);
});
test('failed URLs and expired abandoned previews do not permanently consume source quota', async t => {
  let fail = true;
  const { db, importer } = await setup(t, async () => { if (fail) throw new Error('unavailable'); return { status: 200, xml }; });
  for (let i = 0; i < 25; i++) await assert.rejects(importer.preview('alice', `https://podcast.example/bad-${i}`));
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM sources WHERE user_id = ?').bind('alice').first())?.n, 0);
  fail = false;
  const abandoned = await importer.preview('alice', 'https://podcast.example/abandoned');
  await db.prepare('UPDATE sources SET draft_expires_at = 0 WHERE id = ?').bind(abandoned.sourceId).run();
  const good = await importer.preview('alice', 'https://podcast.example/valid');
  assert.equal(good.episodes.length, 2);
  assert.equal(await db.prepare('SELECT id FROM sources WHERE id = ?').bind(abandoned.sourceId).first(), null);
});
test('relative enclosures use the final feed URL after redirects', async t => {
  const { db, vault, importer } = await setup(t, async () => ({ status: 200, xml: xml.replace('https://audio.example/one.mp3', 'audio.mp3'), finalUrl: 'https://podcast.example/shows/feed.xml' }));
  const source = await importer.preview('alice', 'https://podcast.example/start');
  const row = await db.prepare("SELECT identity, metadata_ciphertext FROM episodes WHERE source_id = ? AND episode_number = '41'").bind(source.sourceId).first<{ identity: string; metadata_ciphertext: string }>();
  const metadata = JSON.parse(await vault.open(`alice:episode:${source.sourceId}:${row!.identity}`, row!.metadata_ciphertext));
  assert.equal(metadata.enclosure.url, 'https://podcast.example/shows/audio.mp3');
});
test('concurrent previews cannot exceed the atomic per-owner source limit', async t => {
  const { db, vault, importer } = await setup(t, async () => ({ status: 200, xml }));
  const { Catalog } = await import('../src/db/catalog.ts');
  const catalog = new Catalog(db, vault);
  for (let i = 0; i < 24; i++) await catalog.addSource('alice', `https://podcast.example/saved-${i}`);
  const results = await Promise.allSettled([
    importer.preview('alice', 'https://podcast.example/first'), importer.preview('alice', 'https://podcast.example/second'),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM sources WHERE user_id = ?').bind('alice').first())?.n, 25);
});
test('an expired polling claimant cannot overwrite a newer successful refresh', async t => {
  let release!: () => void; let start!: () => void; let hold = false; let replacement = false;
  const pending = new Promise<void>(resolve => { release = resolve; }); const ready = new Promise<void>(resolve => { start = resolve; });
  const { db, importer } = await setup(t, async () => {
    const result = replacement ? xml.replace('Signal Paths', 'Updated show') : xml;
    if (hold) { start(); await pending; }
    return { status: 200, xml: result };
  });
  const source = await importer.preview('alice', 'https://podcast.example/feed'); hold = true;
  const old = importer.refresh('alice', source.sourceId); await ready;
  await db.prepare('UPDATE sources SET poll_lease_until = 0 WHERE id = ?').bind(source.sourceId).run();
  hold = false; replacement = true; await importer.refresh('alice', source.sourceId);
  const assertion = assert.rejects(old, /source_busy/); release(); await assertion;
  const saved = await importer.summary('alice', source.sourceId);
  assert.equal(saved.title, 'Updated show'); assert.equal(saved.lastError, null);
});
test('imports a full 2000-episode archive into the saved catalog', async t => {
  const large = `<rss version="2.0"><channel><title>Large archive</title>${Array.from({ length: 2000 }, (_, i) => `<item><guid>archive-${i}</guid><title>Episode ${i}</title><enclosure url="https://audio.example/${i}.mp3" type="audio/mpeg" length="10"/></item>`).join('')}</channel></rss>`;
  const { db, importer } = await setup(t, async () => ({ status: 200, xml: large }));
  const source = await importer.preview('alice', 'https://podcast.example/large-feed');
  assert.equal(source.episodes.length, 2000);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM episodes WHERE source_id = ?').bind(source.sourceId).first())!.n, 2000);
  const repository = new Subscriptions(db);
  const id = await repository.create('alice', source.sourceId, { schedule: { kind: 'daily', hour: 12, timeZone: 'UTC' }, selection: { mode: 'all' }, live: false, choice: 'now' }, new Date().toISOString());
  assert.equal(await repository.process('alice', id, 0, new Date().toISOString()), true);
  assert.equal((await repository.load('alice', id))!.state.releases.length, 1);
});
