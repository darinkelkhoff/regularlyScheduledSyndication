import type { LocalPublisher } from '../publishing/local-publisher.ts';
import { importRoutes } from './imports.ts';
import { FeedError, type FeedTransport } from '../importer/types.ts';
import { shell } from './shell.ts';
import { podcastRoutes } from './podcasts.ts';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { getCookie, setCookie } from 'hono/cookie';
import type { D1Database } from '@cloudflare/workers-types';
import type { RegistrationResponseJSON, AuthenticationResponseJSON } from '@simplewebauthn/server';
import { AuthService, type AuthResult } from '../auth/service.ts';
import { AuthError } from '../auth/store.ts';
import { hashToken, randomToken } from '../auth/tokens.ts';

export type AppBindings = { DB: D1Database; ORIGIN: string; RP_ID: string; RP_NAME: string; ADMIN_SETUP_SECRET?: string; LOCAL_PREVIEW?: string; RSS_PREVIEW?: string; APP_ENV?: string; BACKGROUND_PROCESSING?: string; FEED_PUBLISHER?: LocalPublisher; SOURCE_SECRET?: string; FEED_TRANSPORT?: FeedTransport; ASSETS?: { fetch(request: Request): Promise<Response> } };
export type Env = { Bindings: AppBindings; Variables: { auth: AuthService; browserHash: string; token: string } };
type Ctx = Context<Env>;
export const app = new Hono<Env>();
const cookieName = (c: Ctx, kind: string) => `${c.env.ORIGIN.startsWith('https:') ? '__Host-' : ''}regsched_${kind}`;
function cookie(c: Ctx, kind: string, value: string, maxAge: number) {
  setCookie(c, cookieName(c, kind), value, { httpOnly: true, secure: c.env.ORIGIN.startsWith('https:'), sameSite: 'Strict', path: '/', maxAge });
}
const string = (body: Record<string, unknown>, field: string, max = 4096): string => {
  const value = body[field];
  if (typeof value !== 'string' || !value || value.length > max) throw new AuthError('invalid_request', 400);
  return value;
};
async function body(c: Ctx): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:;|$)/i.test(c.req.header('Content-Type') ?? '')) throw new AuthError('json_required', 400);
  let parsed: unknown;
  try { parsed = await c.req.json(); } catch { throw new AuthError('invalid_json', 400); }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new AuthError('invalid_request', 400);
  return parsed as Record<string, unknown>;
}
function credentialBody(value: unknown): RegistrationResponseJSON | AuthenticationResponseJSON {
  if (!value || typeof value !== 'object') throw new AuthError('invalid_credential', 400);
  const obj = value as Record<string, unknown>;
  string(obj, 'id', 2048);
  if (obj.type !== 'public-key' || !obj.response || typeof obj.response !== 'object') throw new AuthError('invalid_credential', 400);
  return value as RegistrationResponseJSON | AuthenticationResponseJSON;
}
function signedIn(c: Ctx, result: AuthResult) {
  cookie(c, 'session', result.token, 30 * 86_400);
  return c.json({ user: result.user, ...(result.recoveryCode ? { recoveryCode: result.recoveryCode } : {}) });
}
app.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store'); c.header('Referrer-Policy', 'no-referrer');
  c.header('X-Content-Type-Options', 'nosniff'); c.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https: http:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  if (!['GET', 'HEAD'].includes(c.req.method)) {
    if (c.req.header('Origin') !== c.env.ORIGIN || c.req.header('Sec-Fetch-Site') === 'cross-site') return c.json({ error: 'origin_rejected' }, 403);
  }
  await next();
});
app.use('/api/*', (c, next) => {
  const selectionRequest = c.req.method === 'POST' && /^\/api\/podcasts(?:\/[^/]+\/change)?$/.test(c.req.path);
  return bodyLimit({ maxSize: selectionRequest ? 262_144 : 32_768, onError: c => c.json({ error: 'request_too_large' }, 413) })(c, next);
});
app.get('/feeds/:token/rss.xml', async c => {
  if (!c.env.FEED_PUBLISHER) return c.notFound();
  const xml = await c.env.FEED_PUBLISHER.read(c.req.param('token'));
  c.header('X-Robots-Tag', 'noindex, nofollow, noarchive');
  if (xml === null) return c.notFound();
  c.header('Content-Type', 'application/rss+xml; charset=utf-8');
  return c.body(xml);
});
app.get('/api/health', c => c.json({ app: 'RegSched', ok: true }));
app.get('/', c => c.html(shell.replace('<html lang="en">', `<html lang="en" data-environment="${c.env.APP_ENV === 'production' ? 'production' : c.env.APP_ENV === 'staging' ? 'staging' : 'local'}">`)));
app.get('/assets/*', c => c.env.ASSETS ? c.env.ASSETS.fetch(c.req.raw) : c.notFound());
app.use('/api/*', async (c, next) => {
  const auth = new AuthService(c.env.DB, { origin: c.env.ORIGIN, rpID: c.env.RP_ID, rpName: c.env.RP_NAME, setupSecret: c.env.ADMIN_SETUP_SECRET, restrictInitialSignup: c.env.APP_ENV === 'staging' || c.env.APP_ENV === 'production' });
  c.set('auth', auth);
  const rawSession = getCookie(c, cookieName(c, 'session')) ?? '';
  c.set('token', /^[A-Za-z0-9_-]{43}$/.test(rawSession) ? rawSession : '');
  let flow = getCookie(c, cookieName(c, 'flow'));
  if (!flow || !/^[A-Za-z0-9_-]{43}$/.test(flow)) { flow = randomToken(); cookie(c, 'flow', flow, 3600); }
  c.set('browserHash', await hashToken(flow));
  if (c.req.method === 'POST' && c.req.path.startsWith('/api/auth/')) {
    await auth.throttle(`auth-ip:${c.req.header('CF-Connecting-IP') ?? 'local'}`);
  }
  await next();
});
app.get('/api/auth/status', async c => c.json(await c.get('auth').status()));
app.get('/api/auth/me', async c => c.json({ user: await c.get('auth').me(c.get('token')) }));
app.post('/api/auth/register/options', async c => {
  const input = await body(c);
  return c.json(await c.get('auth').signupOptions(string(input, 'displayName', 80), c.get('browserHash'),
    input.setupSecret === undefined ? undefined : string(input, 'setupSecret')));
});
app.post('/api/auth/register/verify', async c => {
  const input = await body(c);
  return signedIn(c, await c.get('auth').register(string(input, 'challengeId', 64), credentialBody(input.response) as RegistrationResponseJSON, c.get('browserHash'), c.get('token')));
});
app.post('/api/auth/login/options', async c => { await body(c); return c.json(await c.get('auth').loginOptions(c.get('browserHash'))); });
app.post('/api/auth/reauth/options', async c => { await body(c); return c.json(await c.get('auth').loginOptions(c.get('browserHash'), c.get('token') || 'missing')); });
for (const path of ['/api/auth/login/verify', '/api/auth/reauth/verify']) {
  app.post(path, async c => {
    const input = await body(c);
    return signedIn(c, await c.get('auth').login(string(input, 'challengeId', 64), credentialBody(input.response) as AuthenticationResponseJSON, c.get('browserHash'), c.get('token')));
  });
}
app.post('/api/auth/recovery/options', async c => {
  const input = await body(c);
  return c.json(await c.get('auth').recoveryOptions(string(input, 'recoveryCode', 43), c.get('browserHash')));
});
app.post('/api/auth/logout', async c => { await body(c); await c.get('auth').logout(c.get('token')); cookie(c, 'session', '', 0); return c.json({ ok: true }); });
app.post('/api/account/name', async c => {
  const input = await body(c);
  return c.json({ user: await c.get('auth').renameAccount(c.get('token'), string(input, 'displayName', 80)) });
});
app.get('/api/account/credentials', async c => c.json({ credentials: await c.get('auth').credentials(c.get('token')) }));
app.post('/api/account/credentials/options', async c => {
  const input = await body(c);
  return c.json(await c.get('auth').addOptions(c.get('token'), string(input, 'name', 80), c.get('browserHash')));
});
app.post('/api/account/credentials/remove', async c => {
  const input = await body(c); await c.get('auth').removeCredential(c.get('token'), string(input, 'credentialId', 2048)); return c.json({ ok: true });
});
app.post('/api/account/recovery-code', async c => { await body(c); return c.json({ recoveryCode: await c.get('auth').rotateRecovery(c.get('token')) }); });
app.get('/api/admin/users', async c => c.json(await c.get('auth').adminUsers(c.get('token'))));
app.post('/api/admin/signup', async c => {
  const input = await body(c); if (typeof input.open !== 'boolean') throw new AuthError('invalid_request', 400);
  await c.get('auth').setSignup(c.get('token'), input.open); return c.json({ ok: true });
});
app.post('/api/admin/accounts/disable', async c => {
  const input = await body(c); if (typeof input.disabled !== 'boolean') throw new AuthError('invalid_request', 400);
  await c.get('auth').setDisabled(c.get('token'), string(input, 'userId', 64), input.disabled); return c.json({ ok: true });
});
app.route('/api', podcastRoutes);
app.route('/api', importRoutes);
app.onError((error, c) => error instanceof FeedError ? c.json({ error: error.code }, ['source_busy', 'source_limit', 'podcast_already_added'].includes(error.code) ? 409 : 400) : error instanceof AuthError
  ? c.json({ error: error.message }, error.status)
  : c.json({ error: 'internal_error' }, 500));
app.notFound(c => c.json({ error: 'not_found' }, 404));
