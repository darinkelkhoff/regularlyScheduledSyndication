import { test } from 'node:test';
import assert from 'node:assert/strict';
import { database } from './helpers/d1.ts';
import { Authenticator } from './helpers/authenticator.ts';
import { AuthService } from '../src/auth/service.ts';
import { app, type AppBindings } from '../src/http/app.ts';
test('browser podcast routes persist sample setup and reject stale or unowned edits', async t => {
  const env: AppBindings = { DB: await database(t), ORIGIN: 'http://localhost:8787', RP_ID: 'localhost', RP_NAME: 'RegSched', LOCAL_PREVIEW: '1', SOURCE_SECRET: Buffer.alloc(32, 5).toString('base64url') };
  const auth = new AuthService(env.DB, { origin: env.ORIGIN, rpID: env.RP_ID, rpName: env.RP_NAME });
  const key = new Authenticator(); const options = await auth.signupOptions('UI user', 'browser');
  const user = await auth.register(options.challengeId, key.register(options.options.challenge), 'browser');
  const request = (path: string, body?: unknown, token = user.token) => app.request(env.ORIGIN + path, {
    method: body === undefined ? 'GET' : 'POST', headers: { Origin: env.ORIGIN, 'Content-Type': 'application/json', Cookie: `regsched_session=${token}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, env);
  assert.equal((await request('/api/podcasts', undefined, '')).status, 401);
  const schedule = { kind: 'weekly', weekdays: [1, 4], hour: 12, timeZone: 'America/Chicago' };
  assert.equal((await request('/api/calendar/preview', { schedule })).status, 200);
  const created = await request('/api/podcasts/sample', { schedule, selection: { mode: 'all' }, live: false, choice: 'next' });
  assert.equal(created.status, 201);
  const { id } = await created.json() as { id: string };
  assert.equal((await (await request('/api/podcasts')).json() as { podcasts: unknown[] }).podcasts.length, 1);
  assert.equal((await request(`/api/podcasts/${id}/change`, { revision: 0, change: { kind: 'pause' } })).status, 200);
  assert.equal((await request(`/api/podcasts/${id}/change`, { revision: 0, change: { kind: 'resume', choice: 'now' } })).status, 409);
  assert.equal((await request('/api/calendar/preview', { schedule: { kind: 'weekly', weekdays: [] } })).status, 400);
  const otherKey = new Authenticator(); const other = await auth.signupOptions('Other', 'other');
  const otherUser = await auth.register(other.challengeId, otherKey.register(other.options.challenge), 'other');
  assert.equal((await request(`/api/podcasts/${id}`, undefined, otherUser.token)).status, 404);
  env.LOCAL_PREVIEW = undefined;
  assert.equal((await request('/api/podcasts/sample', { schedule, selection: { mode: 'all' }, live: false, choice: 'next' })).status, 404);
});
