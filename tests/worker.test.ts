import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { randomToken } from '../src/auth/tokens.ts';
import { Authenticator } from './helpers/authenticator.ts';

test('bundled API registers and authenticates a passkey inside the local Workers runtime', async t => {
  const bundle = await build({ entryPoints: [fileURLToPath(new URL('../src/worker.ts', import.meta.url))], bundle: true,
    write: false, format: 'esm', platform: 'browser', target: 'es2023', external: ['node:*'] });
  const runtime = new Miniflare({ unsafeTriggerHandlers: true, modules: true, script: bundle.outputFiles[0]!.text,
    compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat', 'global_fetch_strictly_public'], host: '127.0.0.1', port: 0,
    r2Buckets: ['FEEDS'], d1Databases: ['DB'], bindings: { ORIGIN: 'http://localhost:8787', RP_ID: 'localhost', RP_NAME: 'RegSched', SOURCE_SECRET: randomToken(), ADMIN_SETUP_SECRET: 'worker-bootstrap-secret-at-least-32-characters' } });
  t.after(() => runtime.dispose());
  const db = await runtime.getD1Database('DB');
  const migrations = new URL('../migrations/', import.meta.url);
  for (const name of (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort()) await db.exec(await readFile(new URL(name, migrations), 'utf8'));
  const origin = 'http://localhost:8787';
  const optionsResponse = await runtime.dispatchFetch(origin + '/api/auth/register/options', { method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ displayName: 'Worker user', setupSecret: 'worker-bootstrap-secret-at-least-32-characters' }) });
  assert.equal(optionsResponse.status, 200);
  const cookie = optionsResponse.headers.get('Set-Cookie')!.split(';')[0]!;
  const options = await optionsResponse.json() as { challengeId: string; options: { challenge: string } };
  const key = new Authenticator();
  const registered = await runtime.dispatchFetch(origin + '/api/auth/register/verify', { method: 'POST',
    headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ challengeId: options.challengeId, response: key.register(options.options.challenge) }) });
  assert.equal(registered.status, 200);
  const user = await registered.json() as { user: { id: string } };
  const loginResponse = await runtime.dispatchFetch(origin + '/api/auth/login/options', { method: 'POST',
    headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}' });
  const login = await loginResponse.json() as typeof options;
  const authenticated = await runtime.dispatchFetch(origin + '/api/auth/login/verify', { method: 'POST',
    headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ challengeId: login.challengeId, response: key.authenticate(login.options.challenge) }) });
  assert.equal(authenticated.status, 200);
  assert.equal((await authenticated.json() as typeof user).user.id, user.user.id);
  const scheduled = await runtime.dispatchFetch(origin + '/cdn-cgi/handler/scheduled?cron=*+*+*+*+*');
  assert.equal(scheduled.status, 200);
  await scheduled.text();
  const lease = await db.prepare('SELECT claim, lease_until FROM background_job WHERE id = 1').first();
  assert.equal(lease?.claim, null);
  assert.equal(lease?.lease_until, 0);
});
