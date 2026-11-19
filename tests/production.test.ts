import { test } from 'node:test';
import assert from 'node:assert/strict';
import { database } from './helpers/d1.ts';
import { randomToken } from '../src/auth/tokens.ts';
import worker, { workerServices, type WorkerBindings } from '../src/worker.ts';
import type { R2Bucket, ExecutionContext, ScheduledController } from '@cloudflare/workers-types';
const staging = 'https://regsched-staging.example';
const production = 'https://regsched.com';
async function env(t: Parameters<typeof database>[0]): Promise<WorkerBindings> {
  return { DB: await database(t), FEEDS: {} as R2Bucket, ASSETS: { fetch: async () => new Response('asset') },
    ORIGIN: production, RP_ID: 'regsched.com', APP_ENV: 'production', SOURCE_SECRET: randomToken(), ADMIN_SETUP_SECRET: randomToken() };
}
test('production renders production identity and retains exact origin and RP checks', async t => {
  const bindings = await env(t); const services = await workerServices(bindings);
  assert.equal(services.APP_ENV, 'production'); assert.equal(services.RP_NAME, 'RegSched');
  const response = await worker.fetch(new Request(production), bindings);
  assert.match(await response.text(), /data-environment="production"/);
  assert.equal((await worker.fetch(new Request(staging), bindings)).status, 404);
});
test('frozen staging retains reads but rejects writes and never invokes its scheduled handler', async t => {
  const bindings = { ...await env(t), ORIGIN: staging, RP_ID: 'regsched-staging.example', MIGRATION_MODE: 'freeze' as const };
  assert.equal((await worker.fetch(new Request(staging + '/api/health'), bindings)).status, 200);
  const response = await worker.fetch(new Request(staging + '/api/podcasts', { method: 'POST' }), bindings);
  assert.equal(response.status, 503); assert.equal(response.headers.get('cache-control'), 'no-store');
  let scheduled = false;
  await worker.scheduled({} as ScheduledController, bindings, { waitUntil() { scheduled = true; } } as unknown as ExecutionContext);
  assert.equal(scheduled, false);
});
test('staging redirects existing feed tokens to the same production path without caching', async t => {
  const bindings = { ...await env(t), ORIGIN: staging, MIGRATION_MODE: 'redirect' as const, MIGRATION_TARGET: production };
  const path = '/feeds/' + randomToken() + '/rss.xml';
  const response = await worker.fetch(new Request(staging + path), bindings);
  assert.equal(response.status, 307); assert.equal(response.headers.get('location'), production + path);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal((await worker.fetch(new Request(staging + '/api/auth/login/verify', { method: 'POST' }), bindings)).status, 409);
});
test('production maintenance refuses all traffic and does not start scheduled writes', async t => {
  const bindings = { ...await env(t), MAINTENANCE: '1' };
  assert.equal((await worker.fetch(new Request(production), bindings)).status, 503);
  let scheduled = false;
  await worker.scheduled({} as ScheduledController, bindings, { waitUntil() { scheduled = true; } } as unknown as ExecutionContext);
  assert.equal(scheduled, false);
});
