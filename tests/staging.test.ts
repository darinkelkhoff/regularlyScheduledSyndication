import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import type { R2Bucket } from '@cloudflare/workers-types';
import { database } from './helpers/d1.ts';
import { Authenticator } from './helpers/authenticator.ts';
import worker, { workerServices, type WorkerBindings } from '../src/worker.ts';
import { app } from '../src/http/app.ts';
import { randomToken } from '../src/auth/tokens.ts';
import { ImportService } from '../src/importer/service.ts';
import { SourceVault } from '../src/security/source-vault.ts';
import { fromBase64 } from '../src/auth/tokens.ts';
import { Subscriptions } from '../src/db/subscriptions.ts';
const origin = 'https://regsched-staging.example';
async function setup(t: Parameters<typeof database>[0]) {
  const objects = new Map<string, string>();
  const env: WorkerBindings = { DB: await database(t), FEEDS: {
    async put(key: string, value: string) { objects.set(key, value); },
    async get(key: string) { return objects.has(key) ? { text: async () => objects.get(key)! } : null; },
    async delete(key: string) { objects.delete(key); },
  } as unknown as R2Bucket, ASSETS: { fetch: async () => new Response('asset') }, ORIGIN: origin,
    RP_ID: 'regsched-staging.example', SOURCE_SECRET: randomToken(), ADMIN_SETUP_SECRET: randomToken() };
  return { env, services: await workerServices(env), objects };
}
test('staging registration requires initial setup secret and closes public signup after bootstrap', async t => {
  const { services } = await setup(t); let cookie = '';
  async function request(path: string, body?: unknown) {
    const response = await app.request(origin + path, { method: body === undefined ? 'GET' : 'POST', headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, services);
    const additions = response.headers.getSetCookie().map(header => header.split(';')[0]);
    if (additions.length) cookie = [...cookie.split('; ').filter(Boolean), ...additions].join('; ');
    return response;
  }
  assert.equal((await request('/api/auth/register/options', { displayName: 'Unexpected visitor' })).status, 403);
  const options = await (await request('/api/auth/register/options', { displayName: 'Staging admin', setupSecret: services.ADMIN_SETUP_SECRET })).json() as { challengeId: string; options: { challenge: string } };
  const key = new Authenticator();
  const response = await request('/api/auth/register/verify', { challengeId: options.challengeId, response: key.register(options.options.challenge, origin, 'regsched-staging.example') });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('set-cookie')!, /__Host-regsched_session/);
  assert.match(response.headers.get('set-cookie')!, /Secure/);
  assert.deepEqual(await (await request('/api/auth/status')).json(), { signupOpen: false, bootstrapClosed: true });
  assert.equal((await request('/api/podcasts/sample-preview')).status, 404);
  assert.equal((await request('/api/podcasts/sample', {})).status, 404);
});
test('staging serves published RSS without local sample mode and reset revokes old URLs', async t => {
  const { env, services, objects } = await setup(t);
  const xml = await readFile(new URL('./fixtures/podcast.xml', import.meta.url), 'utf8');
  const vault = await SourceVault.create(fromBase64(env.SOURCE_SECRET));
  const importer = new ImportService(env.DB, vault, async () => ({ status: 200, xml }));
  const source = await importer.preview('alice', 'https://podcast.example/feed');
  const repository = new Subscriptions(env.DB);
  const id = await repository.create('alice', source.sourceId, { schedule: { kind: 'daily', hour: 10, timeZone: 'UTC' }, selection: { mode: 'all' }, live: false, choice: 'now' }, new Date().toISOString());
  await repository.process('alice', id, 0, new Date().toISOString());
  assert.equal(await services.FEED_PUBLISHER!.publish('alice', id), true);
  const token = await services.FEED_PUBLISHER!.token('alice', id);
  const response = await worker.fetch(new Request(`${origin}/feeds/${token}/rss.xml`), env);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type')!, /application\/rss\+xml/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(await response.text(), /<rss/);
  assert.ok([...objects.values()].every(value => !value.includes('<rss')));
  const replacement = await services.FEED_PUBLISHER!.reset('alice', id);
  assert.equal((await worker.fetch(new Request(`${origin}/feeds/${token}/rss.xml`), env)).status, 404);
  assert.equal((await worker.fetch(new Request(`${origin}/feeds/${replacement}/rss.xml`), env)).status, 200);
  assert.equal((await worker.fetch(new Request('https://other.example/api/health'), env)).status, 404);
  const html = await (await worker.fetch(new Request(origin), env)).text();
  assert.match(html, /data-environment="staging"/);
});
