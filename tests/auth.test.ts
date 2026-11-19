import { test } from 'node:test';
import assert from 'node:assert/strict';
import { database } from './helpers/d1.ts';
import { Authenticator } from './helpers/authenticator.ts';
import { AuthService } from '../src/auth/service.ts';
const browser = 'test-browser-hash';
const config = { origin: 'http://localhost:8787', rpID: 'localhost', rpName: 'RegSched', setupSecret: 'local-setup-secret-with-at-least-32-characters' };
async function setup(t: Parameters<typeof database>[0]) {
  const db = await database(t);
  let now = Date.parse('2026-10-27T12:00:00Z');
  const auth = new AuthService(db, config, () => now);
  const advance = (ms: number) => { now += ms; };
  async function signup(name: string, admin = false) {
    const key = new Authenticator();
    const options = await auth.signupOptions(name, browser, admin ? config.setupSecret : undefined);
    const result = await auth.register(options.challengeId, key.register(options.options.challenge), browser);
    return { ...result, key };
  }
  return { db, auth, signup, advance };
}
test('real passkey signup stores hashed secrets, logs in, and rejects replay', async t => {
  const { db, auth } = await setup(t);
  const key = new Authenticator();
  const options = await auth.signupOptions('New user', browser);
  const response = key.register(options.options.challenge);
  const result = await auth.register(options.challengeId, response, browser);
  assert.equal((await auth.me(result.token))?.displayName, 'New user');
  const stored = JSON.stringify((await db.prepare('SELECT * FROM sessions').all()).results) + JSON.stringify((await db.prepare('SELECT recovery_hash FROM users').all()).results);
  assert.ok(!stored.includes(result.token)); assert.ok(!stored.includes(result.recoveryCode!));
  await assert.rejects(auth.register(options.challengeId, response, browser));
  const login = await auth.loginOptions(browser);
  const assertion = key.authenticate(login.options.challenge);
  const signedIn = await auth.login(login.challengeId, assertion, browser);
  assert.equal(signedIn.user.id, result.user.id);
  await assert.rejects(auth.login(login.challengeId, assertion, browser));
  await auth.logout(signedIn.token);
  assert.equal(await auth.me(signedIn.token), null);
});
test('bootstrap is atomic and cannot reopen after the administrator is disabled', async t => {
  const { db, auth } = await setup(t);
  const a = new Authenticator(); const b = new Authenticator();
  const oa = await auth.signupOptions('Admin A', browser, config.setupSecret);
  const ob = await auth.signupOptions('Admin B', browser, config.setupSecret);
  const results = await Promise.allSettled([
    auth.register(oa.challengeId, a.register(oa.options.challenge), browser),
    auth.register(ob.challengeId, b.register(ob.options.challenge), browser),
  ]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1').first())?.n, 1);
  await db.prepare('UPDATE users SET disabled = 1 WHERE is_admin = 1').run();
  await assert.rejects(auth.signupOptions('Admin C', browser, config.setupSecret));
  await assert.rejects(db.prepare('UPDATE auth_settings SET bootstrap_closed = 0 WHERE id = 1').run());
});
test('closing signup blocks both initiation and already-issued completion', async t => {
  const { auth, signup } = await setup(t);
  const admin = await signup('Owner', true);
  const key = new Authenticator();
  const options = await auth.signupOptions('Pending', browser);
  await auth.setSignup(admin.token, false);
  await assert.rejects(auth.signupOptions('Blocked', browser));
  await assert.rejects(auth.register(options.challengeId, key.register(options.options.challenge), browser));
  const login = await auth.loginOptions(browser);
  assert.equal((await auth.login(login.challengeId, admin.key.authenticate(login.options.challenge), browser)).user.id, admin.user.id);
});
test('origin, RP, challenge, browser binding, verification and signatures are enforced', async t => {
  const { auth } = await setup(t);
  const key = new Authenticator();
  for (const make of [
    (challenge: string) => key.register(challenge, 'https://evil.example'),
    (challenge: string) => key.register(challenge, config.origin, 'evil.example'),
    (_challenge: string) => key.register('wrong-challenge'),
    (challenge: string) => key.register(challenge, config.origin, config.rpID, false),
  ]) {
    const options = await auth.signupOptions('Invalid', browser);
    await assert.rejects(auth.register(options.challengeId, make(options.options.challenge), browser));
  }
  const options = await auth.signupOptions('Valid', browser);
  await assert.rejects(auth.register(options.challengeId, key.register(options.options.challenge), 'different-browser'));
  const user = await auth.register(options.challengeId, key.register(options.options.challenge), browser);
  const login = await auth.loginOptions(browser);
  const bad = key.authenticate(login.options.challenge);
  bad.response.signature = Buffer.alloc(70).toString('base64url');
  await assert.rejects(auth.login(login.challengeId, bad, browser));
  assert.ok(await auth.me(user.token));
});
test('expired challenges/sessions and disabled accounts cannot authenticate', async t => {
  const { auth, signup, advance, db } = await setup(t);
  const user = await signup('Expiry');
  const login = await auth.loginOptions(browser);
  advance(11 * 60_000);
  await assert.rejects(auth.login(login.challengeId, user.key.authenticate(login.options.challenge), browser));
  await db.prepare('UPDATE users SET disabled = 1 WHERE id = ?').bind(user.user.id).run();
  assert.equal(await auth.me(user.token), null);
  await db.prepare('UPDATE users SET disabled = 0 WHERE id = ?').bind(user.user.id).run();
  advance(31 * 86_400_000);
  assert.equal(await auth.me(user.token), null);
});
test('fresh authentication gates credential management and recovery-code rotation', async t => {
  const { auth, signup, advance } = await setup(t);
  const user = await signup('Credentials');
  advance(6 * 60_000);
  await assert.rejects(auth.addOptions(user.token, 'Second', browser));
  await assert.rejects(auth.rotateRecovery(user.token));
  await assert.rejects(auth.removeCredential(user.token, Buffer.from(user.key.id).toString('base64url')));
  const reauth = await auth.loginOptions(browser, user.token);
  await auth.login(reauth.challengeId, user.key.authenticate(reauth.options.challenge), browser, user.token);
  const second = new Authenticator();
  const options = await auth.addOptions(user.token, 'Second passkey', browser);
  await auth.register(options.challengeId, second.register(options.options.challenge), browser, user.token);
  assert.equal((await auth.credentials(user.token)).length, 2);
  const replacement = await auth.rotateRecovery(user.token);
  await assert.rejects(auth.recoveryOptions(user.recoveryCode!, browser));
  assert.ok(await auth.recoveryOptions(replacement, browser));
  await auth.removeCredential(user.token, Buffer.from(second.id).toString('base64url'));
  assert.equal((await auth.credentials(user.token)).length, 1);
});
test('recovery is restricted, single-use, replaces the code and invalidates old sessions', async t => {
  const { auth, signup } = await setup(t);
  const user = await signup('Recovery');
  const newKey = new Authenticator();
  const one = await auth.recoveryOptions(user.recoveryCode!, browser);
  const two = await auth.recoveryOptions(user.recoveryCode!, browser);
  const recovered = await auth.register(one.challengeId, newKey.register(one.options.challenge), browser);
  await assert.rejects(auth.register(two.challengeId, new Authenticator().register(two.options.challenge), browser));
  await assert.rejects(auth.recoveryOptions(user.recoveryCode!, browser));
  assert.equal(await auth.me(user.token), null);
  assert.ok(await auth.me(recovered.token));
  assert.notEqual(recovered.recoveryCode, user.recoveryCode);
  assert.ok(await auth.recoveryOptions(recovered.recoveryCode!, browser));
  assert.equal((await auth.credentials(recovered.token)).length, 2);
});
test('freshness is checked again when finishing passkey addition', async t => {
  const { auth, signup, advance } = await setup(t);
  const user = await signup('Stale add');
  const options = await auth.addOptions(user.token, 'Later key', browser);
  advance(6 * 60_000);
  await assert.rejects(auth.register(options.challengeId, new Authenticator().register(options.options.challenge), browser, user.token));
  assert.equal((await auth.credentials(user.token)).length, 1);
});
test('last passkey removal requires another access method and revokes its sessions', async t => {
  const { auth, signup, db } = await setup(t);
  const user = await signup('Last key');
  const credentialId = Buffer.from(user.key.id).toString('base64url');
  await db.prepare('UPDATE users SET recovery_hash = NULL WHERE id = ?').bind(user.user.id).run();
  await assert.rejects(auth.removeCredential(user.token, credentialId));
  const code = await auth.rotateRecovery(user.token);
  await auth.removeCredential(user.token, credentialId);
  assert.equal(await auth.me(user.token), null);
  assert.ok(await auth.recoveryOptions(code, browser));
});
test('disabling accounts revokes sessions permanently and requires an administrator', async t => {
  const { auth, signup } = await setup(t);
  const admin = await signup('Manager', true);
  const user = await signup('Member');
  await assert.rejects(auth.setSignup(user.token, false));
  await assert.rejects(auth.setDisabled(admin.token, admin.user.id, true));
  await auth.setDisabled(admin.token, user.user.id, true);
  assert.equal(await auth.me(user.token), null);
  await assert.rejects(auth.recoveryOptions(user.recoveryCode!, browser));
  await auth.setDisabled(admin.token, user.user.id, false);
  assert.equal(await auth.me(user.token), null);
});
test('a throttled client is allowed again after its time window expires', async t => {
  const { auth, advance } = await setup(t);
  for (let i = 0; i < 30; i++) await auth.throttle('test-key');
  await assert.rejects(auth.throttle('test-key'));
  advance(10 * 60_000);
  await auth.throttle('test-key');
});
test('concurrent recovery completions consume one code exactly once', async t => {
  const { auth, signup } = await setup(t);
  const user = await signup('Recovery race');
  const one = await auth.recoveryOptions(user.recoveryCode!, browser);
  const two = await auth.recoveryOptions(user.recoveryCode!, browser);
  const results = await Promise.allSettled([
    auth.register(one.challengeId, new Authenticator().register(one.options.challenge), browser),
    auth.register(two.challengeId, new Authenticator().register(two.options.challenge), browser),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(await auth.me(user.token), null);
});
test('throttle expiry works even when cleanup leaves more than 100 old buckets', async t => {
  const { auth, advance, db } = await setup(t);
  for (let i = 0; i < 30; i++) await auth.throttle('busy-table-key');
  await assert.rejects(auth.throttle('busy-table-key'));
  await db.exec("WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 110) INSERT INTO auth_limits (key_hash, count, reset_at) SELECT 'expired-' || x, 1, 0 FROM n;");
  advance(10 * 60_000);
  await auth.throttle('busy-table-key');
});

test('admin viewing needs a session while changes reuse recent verification', async t => {
  const { auth, signup, advance } = await setup(t);
  const admin = await signup('Manager', true);
  const member = await signup('Member');
  await auth.setSignup(admin.token, false);
  await auth.setSignup(admin.token, true);
  advance(6 * 60_000);
  assert.ok((await auth.adminUsers(admin.token)).users.some(user => user.id === member.user.id));
  await assert.rejects(auth.adminUsers(member.token), { message: 'administrator_required' });
  await assert.rejects(auth.setSignup(admin.token, false), { message: 'fresh_authentication_required' });
  const challenge = await auth.loginOptions(browser, admin.token);
  await auth.login(challenge.challengeId, admin.key.authenticate(challenge.options.challenge), browser, admin.token);
  await auth.setSignup(admin.token, false);
  await auth.setSignup(admin.token, true);
});

test('account name can be changed by its owner without affecting identity or other accounts', async t => {
  const { auth, signup, advance } = await setup(t);
  const owner = await signup('Original'); const other = await signup('Other');
  advance(6 * 60_000);
  const user = await auth.renameAccount(owner.token, '  New account name  ');
  assert.equal(user.id, owner.user.id); assert.equal(user.displayName, 'New account name');
  assert.equal((await auth.me(owner.token))?.displayName, 'New account name');
  assert.equal((await auth.me(other.token))?.displayName, 'Other');
  await assert.rejects(auth.renameAccount(owner.token, '  '), { message: 'invalid_name' });
  await assert.rejects(auth.renameAccount(owner.token, 'x'.repeat(81)), { message: 'invalid_name' });
  await assert.rejects(auth.renameAccount('missing', 'Unauthorized'), { message: 'authentication_required' });
  await auth.logout(owner.token);
  await assert.rejects(auth.renameAccount(owner.token, 'After logout'), { message: 'authentication_required' });
});
