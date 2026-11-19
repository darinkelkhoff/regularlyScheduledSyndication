import { test } from 'node:test';
import assert from 'node:assert/strict';
import { database } from './helpers/d1.ts';
import { Authenticator } from './helpers/authenticator.ts';
import { app, type AppBindings } from '../src/http/app.ts';
const origin = 'http://localhost:8787';
async function setup(t: Parameters<typeof database>[0]) {
  const env: AppBindings = { DB: await database(t), ORIGIN: origin, RP_ID: 'localhost', RP_NAME: 'RegSched', ADMIN_SETUP_SECRET: 'test-admin-setup-secret-at-least-32-characters' };
  let cookies = '';
  async function request(path: string, body?: unknown, extra: Record<string, string> = {}) {
    const response = await app.request(origin + path, { method: body === undefined ? 'GET' : 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: cookies, ...extra },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }, env);
    const jar = new Map(cookies.split('; ').filter(Boolean).map(part => { const i = part.indexOf('='); return [part.slice(0, i), part.slice(i + 1)]; }));
    for (const header of response.headers.getSetCookie()) { const pair = header.split(';')[0]!; const i = pair.indexOf('='); jar.set(pair.slice(0, i), pair.slice(i + 1)); }
    cookies = [...jar.entries()].map(([key, value]) => `${key}=${value}`).join('; ');
    return response;
  }
  return { request, env };
}
test('HTTP passkey signup/login uses private cookies and exposes no raw session token', async t => {
  const { request } = await setup(t);
  assert.equal((await request('/api/health')).status, 200);
  assert.deepEqual(await (await request('/api/auth/me')).json(), { user: null });
  const options = await (await request('/api/auth/register/options', { displayName: 'HTTP user' })).json() as { challengeId: string; options: { challenge: string } };
  const key = new Authenticator();
  const response = await request('/api/auth/register/verify', { challengeId: options.challengeId, response: key.register(options.options.challenge) });
  assert.equal(response.status, 200);
  const body = await response.json() as { user: { id: string }; recoveryCode: string; token?: string };
  assert.ok(body.recoveryCode); assert.equal(body.token, undefined);
  assert.match(response.headers.get('Set-Cookie')!, /HttpOnly/);
  assert.match(response.headers.get('Set-Cookie')!, /SameSite=Strict/);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal((await request('/api/account/credentials')).status, 200);
  assert.equal((await request('/api/admin/users')).status, 403);
  await request('/api/auth/logout', {});
  assert.deepEqual(await (await request('/api/auth/me')).json(), { user: null });
  const login = await (await request('/api/auth/login/options', {})).json() as typeof options;
  assert.equal((await request('/api/auth/login/verify', { challengeId: login.challengeId, response: key.authenticate(login.options.challenge) })).status, 200);
});
test('HTTP rejects cross-origin writes, malformed JSON, oversized bodies and missing authentication', async t => {
  const { request, env } = await setup(t);
  assert.equal((await request('/api/auth/login/options', {}, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await request('/api/account/recovery-code', {})).status, 401);
  assert.equal((await app.request(origin + '/api/auth/register/options', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{' }, env)).status, 400);
  assert.equal((await request('/api/auth/register/options', { displayName: 'a'.repeat(40_000) })).status, 413);
  assert.equal((await request('/api/auth/register/verify', { challengeId: 'missing', response: {} })).status, 400);
});
test('authentication throttling is durable across request instances', async t => {
  const { request } = await setup(t);
  for (let i = 0; i < 30; i++) assert.equal((await request('/api/auth/login/options', {})).status, 200);
  assert.equal((await request('/api/auth/login/options', {})).status, 429);
});
