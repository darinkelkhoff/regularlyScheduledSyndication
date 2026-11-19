import { adminAccountReport } from './admin-users.ts';
import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import {
  generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse,
  type RegistrationResponseJSON, type AuthenticationResponseJSON, type WebAuthnCredential,
} from '@simplewebauthn/server';
import { AuthStore, AuthError, FRESH_MS, SESSION_MS, type Challenge, type Session, type User } from './store.ts';
import { randomToken, hashToken, toBase64, fromBase64 } from './tokens.ts';

export type AuthConfig = { origin: string; rpID: string; rpName: string; setupSecret?: string; restrictInitialSignup?: boolean };
export type AuthResult = { token: string; user: User; recoveryCode?: string };
export class AuthService {
  #store: AuthStore;
  #config: AuthConfig;
  #now: () => number;
  constructor(db: D1Database, config: AuthConfig, now = Date.now) {
    const origin = new URL(config.origin);
    if (origin.origin !== config.origin || origin.hostname !== config.rpID ||
      (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && origin.hostname === 'localhost'))) {
      throw new Error('Invalid relying-party configuration');
    }
    this.#store = new AuthStore(db); this.#config = config; this.#now = now;
  }
  async me(token: string): Promise<User | null> { return (await this.#store.session(token, this.#now()))?.user ?? null; }
  async logout(token: string): Promise<void> {
    await this.#store.db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await hashToken(token)).run();
  }
  async status() {
    const row = await this.#store.db.withSession('first-primary').prepare('SELECT signup_open, bootstrap_closed FROM auth_settings WHERE id = 1')
      .first<{ signup_open: number; bootstrap_closed: number }>();
    return { signupOpen: Boolean(row?.signup_open), bootstrapClosed: Boolean(row?.bootstrap_closed) };
  }
  async signupOptions(displayName: string, browserHash: string, setupSecret?: string) {
    const name = this.#name(displayName);
    const status = await this.status();
    if (!status.signupOpen) throw new AuthError('signup_closed', 403);
    const wantsAdmin = setupSecret !== undefined;
    if (this.#config.restrictInitialSignup && !status.bootstrapClosed && !wantsAdmin) throw new AuthError('bootstrap_unavailable', 403);
    if (wantsAdmin && (!this.#config.setupSecret || this.#config.setupSecret.length < 32 ||
      await hashToken(setupSecret) !== await hashToken(this.#config.setupSecret) || status.bootstrapClosed)) {
      throw new AuthError('bootstrap_unavailable', 403);
    }
    return this.#registrationOptions('signup', crypto.randomUUID(), name, browserHash, { wants_admin: Number(wantsAdmin) });
  }
  async addOptions(token: string, name: string, browserHash: string) {
    const session = await this.#store.requireSession(token, this.#now(), true);
    return this.#registrationOptions('add', session.user.id, session.user.displayName, browserHash,
      { session_hash: session.tokenHash, user_epoch: session.epoch, credential_name: this.#name(name) });
  }
  async recoveryOptions(code: string, browserHash: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(code)) throw new AuthError('invalid_recovery_code');
    const recoveryHash = await hashToken(code);
    const user = await this.#store.db.withSession('first-primary').prepare('SELECT id, display_name, auth_epoch FROM users WHERE recovery_hash = ? AND disabled = 0')
      .bind(recoveryHash).first<{ id: string; display_name: string; auth_epoch: number }>();
    if (!user) throw new AuthError('invalid_recovery_code');
    return this.#registrationOptions('recover', user.id, user.display_name, browserHash, { recovery_hash: recoveryHash, user_epoch: user.auth_epoch });
  }
  async #registrationOptions(kind: 'signup' | 'add' | 'recover', userId: string, displayName: string, browserHash: string, extras: Partial<Challenge>) {
    const existing = kind === 'signup' ? [] : await this.#store.db.withSession('first-primary').prepare('SELECT id FROM credentials WHERE user_id = ?').bind(userId).all<{ id: string }>();
    const options = await generateRegistrationOptions({
      rpName: this.#config.rpName, rpID: this.#config.rpID, userID: new TextEncoder().encode(userId),
      userName: displayName, userDisplayName: displayName, attestationType: 'none',
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      excludeCredentials: Array.isArray(existing) ? [] : existing.results.map(row => ({ id: row.id })),
    });
    const challengeId = crypto.randomUUID();
    await this.#store.saveChallenge({
      id: challengeId, kind, challenge: options.challenge, browser_hash: browserHash,
      user_id: userId, display_name: displayName, credential_name: 'Passkey', session_hash: null,
      recovery_hash: null, user_epoch: null, wants_admin: 0, ...extras,
    }, this.#now());
    return { challengeId, options };
  }
  async register(id: string, response: RegistrationResponseJSON, browserHash: string, sessionToken?: string): Promise<AuthResult> {
    const challenge = await this.#store.challenge(id, browserHash, this.#now());
    if (!['signup', 'add', 'recover'].includes(challenge.kind) || !challenge.user_id) throw new AuthError('invalid_challenge');
    if (challenge.kind === 'add') {
      const session = await this.#store.requireSession(sessionToken ?? '', this.#now(), true);
      if (session.tokenHash !== challenge.session_hash || session.user.id !== challenge.user_id) throw new AuthError('invalid_challenge');
    }
    let verified;
    try {
      verified = await verifyRegistrationResponse({ response, expectedChallenge: challenge.challenge,
        expectedOrigin: this.#config.origin, expectedRPID: this.#config.rpID, requireUserVerification: true });
    } catch { throw new AuthError('registration_not_verified'); }
    if (!verified.verified || !verified.registrationInfo) throw new AuthError('registration_not_verified');
    const credential = verified.registrationInfo.credential;
    const mutation = randomToken();
    const token = randomToken();
    const recoveryCode = randomToken();
    const recoveryHash = await hashToken(recoveryCode);
    const now = this.#now();
    const db = this.#store.db;
    const gate = 'EXISTS (SELECT 1 FROM auth_challenges WHERE id = ? AND claim_token = ?)';
    const statements: D1PreparedStatement[] = [this.#store.claim(challenge, mutation, now)];
    if (challenge.kind === 'signup') {
      statements.push(db.prepare(`INSERT INTO users (id, display_name, is_admin, recovery_hash, auth_mutation, created_at, last_login_at)
        SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${gate} AND EXISTS
        (SELECT 1 FROM auth_settings WHERE id = 1 AND signup_open = 1 AND (? = 0 OR bootstrap_closed = 0))`)
        .bind(challenge.user_id, challenge.display_name, challenge.wants_admin, recoveryHash, mutation, now, now, id, mutation, challenge.wants_admin));
      statements.push(db.prepare(`UPDATE auth_settings SET bootstrap_closed = 1, bootstrap_owner = ?, signup_open = CASE WHEN ? THEN 0 ELSE signup_open END
        WHERE id = 1 AND bootstrap_closed = 0 AND EXISTS (SELECT 1 FROM users WHERE id = ? AND is_admin = 1 AND auth_mutation = ?)`)
        .bind(challenge.user_id, Number(!!this.#config.restrictInitialSignup), challenge.user_id, mutation));
    } else if (challenge.kind === 'recover') {
      statements.push(db.prepare(`UPDATE users SET recovery_hash = ?, auth_epoch = auth_epoch + 1, auth_mutation = ?, last_login_at = MAX(COALESCE(last_login_at, 0), ?)
        WHERE id = ? AND recovery_hash = ? AND auth_epoch = ? AND disabled = 0 AND ${gate}`)
        .bind(recoveryHash, mutation, now, challenge.user_id, challenge.recovery_hash, challenge.user_epoch, id, mutation));
      statements.push(db.prepare('DELETE FROM sessions WHERE user_id = ? AND EXISTS (SELECT 1 FROM users WHERE id = ? AND auth_mutation = ?)')
        .bind(challenge.user_id, challenge.user_id, mutation));
    }
    const guard = challenge.kind === 'add' ? `auth_epoch = ? AND ${gate}` : 'auth_mutation = ?';
    const guardArgs = challenge.kind === 'add' ? [challenge.user_epoch, id, mutation] : [mutation];
    statements.push(db.prepare(`INSERT INTO credentials (id, user_id, name, public_key, counter, transports_json, mutation_id)
      SELECT ?, id, ?, ?, ?, ?, ? FROM users WHERE id = ? AND disabled = 0 AND ${guard}`)
      .bind(credential.id, challenge.credential_name, toBase64(credential.publicKey), credential.counter,
        JSON.stringify(credential.transports ?? []), mutation, challenge.user_id, ...guardArgs));
    if (challenge.kind !== 'add') {
      statements.push(db.prepare(`INSERT INTO sessions (token_hash, user_id, credential_id, auth_epoch, authenticated_at, expires_at)
        SELECT ?, u.id, c.id, u.auth_epoch, ?, ? FROM users u JOIN credentials c ON c.user_id = u.id
        WHERE u.id = ? AND u.auth_mutation = ? AND c.id = ? AND c.mutation_id = ? AND u.disabled = 0`)
        .bind(await hashToken(token), now, now + SESSION_MS, challenge.user_id, mutation, credential.id, mutation));
    }
    let rows;
    try { rows = await db.batch(statements); } catch { throw new AuthError('registration_conflict', 409); }
    if (rows.at(-1)!.meta.changes !== 1) throw new AuthError('registration_unavailable', 409);
    const finalToken = challenge.kind === 'add' ? sessionToken! : token;
    const user = await this.me(finalToken);
    if (!user) throw new AuthError('authentication_required');
    return { token: finalToken, user, ...(challenge.kind === 'add' ? {} : { recoveryCode }) };
  }
  async loginOptions(browserHash: string, sessionToken?: string) {
    const session = sessionToken ? await this.#store.requireSession(sessionToken, this.#now()) : null;
    const options = await generateAuthenticationOptions({ rpID: this.#config.rpID, userVerification: 'required' });
    const challengeId = crypto.randomUUID();
    await this.#store.saveChallenge({
      id: challengeId, kind: session ? 'reauth' : 'login', challenge: options.challenge, browser_hash: browserHash,
      user_id: session?.user.id ?? null, display_name: null, credential_name: null,
      session_hash: session?.tokenHash ?? null, recovery_hash: null, user_epoch: session?.epoch ?? null, wants_admin: 0,
    }, this.#now());
    return { challengeId, options };
  }
  async login(id: string, response: AuthenticationResponseJSON, browserHash: string, sessionToken?: string): Promise<AuthResult> {
    const challenge = await this.#store.challenge(id, browserHash, this.#now());
    if (!['login', 'reauth'].includes(challenge.kind)) throw new AuthError('invalid_challenge');
    const credential = await this.#store.credential(response.id);
    if (!credential || credential.disabled || (challenge.user_id && credential.user_id !== challenge.user_id)) throw new AuthError('authentication_not_verified');
    if (challenge.kind === 'reauth' && await hashToken(sessionToken ?? '') !== challenge.session_hash) throw new AuthError('invalid_challenge');
    let verified;
    try {
      verified = await verifyAuthenticationResponse({ response, expectedChallenge: challenge.challenge,
        expectedOrigin: this.#config.origin, expectedRPID: this.#config.rpID, requireUserVerification: true,
        credential: { id: credential.id, publicKey: fromBase64(credential.public_key), counter: credential.counter,
          transports: JSON.parse(credential.transports_json) } as WebAuthnCredential });
    } catch { throw new AuthError('authentication_not_verified'); }
    if (!verified.verified) throw new AuthError('authentication_not_verified');
    const now = this.#now(); const mutation = randomToken(); const token = randomToken(); const db = this.#store.db;
    const credentialUpdate = db.prepare(`UPDATE credentials SET counter = ?, mutation_id = ? WHERE id = ? AND counter = ?
      AND EXISTS (SELECT 1 FROM users WHERE id = credentials.user_id AND auth_epoch = ? AND disabled = 0)
      AND EXISTS (SELECT 1 FROM auth_challenges WHERE id = ? AND claim_token = ?)`)
      .bind(verified.authenticationInfo.newCounter, mutation, credential.id, credential.counter, credential.auth_epoch, id, mutation);
    const sessionUpdate = challenge.kind === 'reauth'
      ? db.prepare(`UPDATE sessions SET authenticated_at = ? WHERE token_hash = ? AND expires_at > ?
          AND EXISTS (SELECT 1 FROM credentials WHERE id = ? AND mutation_id = ?)`)
        .bind(now, challenge.session_hash, now, credential.id, mutation)
      : db.prepare(`INSERT INTO sessions (token_hash, user_id, credential_id, auth_epoch, authenticated_at, expires_at)
          SELECT ?, u.id, c.id, u.auth_epoch, ?, ? FROM users u JOIN credentials c ON c.user_id = u.id
          WHERE c.id = ? AND c.mutation_id = ? AND u.disabled = 0`)
        .bind(await hashToken(token), now, now + SESSION_MS, credential.id, mutation);
    const recordSignin = challenge.kind === 'login' ? [db.prepare(`UPDATE users
      SET last_login_at = MAX(COALESCE(last_login_at, 0), ?) WHERE id = ? AND disabled = 0
      AND EXISTS (SELECT 1 FROM sessions s WHERE s.token_hash = ? AND s.user_id = users.id
        AND s.auth_epoch = users.auth_epoch AND s.expires_at > ?)`)
      .bind(now, credential.user_id, await hashToken(token), now)] : [];
    const result = await db.batch([this.#store.claim(challenge, mutation, now), credentialUpdate, sessionUpdate, ...recordSignin]);
    if (result[2]!.meta.changes !== 1) throw new AuthError('authentication_conflict', 409);
    const finalToken = challenge.kind === 'reauth' ? sessionToken! : token;
    const user = await this.me(finalToken);
    if (!user) throw new AuthError('authentication_required');
    return { token: finalToken, user };
  }
  async renameAccount(token: string, value: string): Promise<User> {
    const session = await this.#store.requireSession(token, this.#now());
    const name = this.#name(value); const now = this.#now();
    const result = await this.#store.db.prepare(`UPDATE users SET display_name = ? WHERE id = ? AND disabled = 0
      AND EXISTS (SELECT 1 FROM sessions s WHERE s.token_hash = ? AND s.user_id = users.id
        AND s.auth_epoch = users.auth_epoch AND s.expires_at > ?)`)
      .bind(name, session.user.id, session.tokenHash, now).run();
    if (result.meta.changes !== 1) throw new AuthError('authentication_required');
    const user = await this.me(token);
    if (!user) throw new AuthError('authentication_required');
    return user;
  }
  async credentials(token: string) {
    const session = await this.#store.requireSession(token, this.#now());
    return (await this.#store.db.withSession('first-primary').prepare('SELECT id, name FROM credentials WHERE user_id = ?').bind(session.user.id).all<{ id: string; name: string }>()).results;
  }
  #freshGuard() {
    return `EXISTS (SELECT 1 FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.user_id = ? AND s.auth_epoch = u.auth_epoch AND u.disabled = 0
      AND s.expires_at > ? AND s.authenticated_at >= ?)`;
  }
  #freshArgs(session: Session, now: number) { return [session.tokenHash, session.user.id, now, now - FRESH_MS]; }
  async removeCredential(token: string, credentialId: string): Promise<void> {
    const now = this.#now(); const session = await this.#store.requireSession(token, now, true);
    let result;
    try {
      result = await this.#store.db.prepare(`DELETE FROM credentials WHERE id = ? AND user_id = ? AND ${this.#freshGuard()} RETURNING id`)
        .bind(credentialId, session.user.id, ...this.#freshArgs(session, now)).all<{ id: string }>();
    } catch { throw new AuthError('retain_access_method', 409); }
    if (result.results.length !== 1) throw new AuthError('credential_unavailable', 409);
  }
  async rotateRecovery(token: string): Promise<string> {
    const now = this.#now(); const session = await this.#store.requireSession(token, now, true);
    const code = randomToken();
    const result = await this.#store.db.prepare(`UPDATE users SET recovery_hash = ? WHERE id = ? AND ${this.#freshGuard()}`)
      .bind(await hashToken(code), session.user.id, ...this.#freshArgs(session, now)).run();
    if (result.meta.changes !== 1) throw new AuthError('authentication_conflict', 409);
    return code;
  }
  async #admin(token: string): Promise<Session> {
    const session = await this.#store.requireSession(token, this.#now(), true);
    if (!session.user.isAdmin) throw new AuthError('administrator_required', 403);
    return session;
  }
  async setSignup(token: string, open: boolean): Promise<void> {
    const session = await this.#admin(token); const now = this.#now();
    const result = await this.#store.db.prepare(`UPDATE auth_settings SET signup_open = ? WHERE id = 1
      AND ${this.#freshGuard()} AND EXISTS (SELECT 1 FROM users WHERE id = ? AND is_admin = 1)`)
      .bind(Number(open), ...this.#freshArgs(session, now), session.user.id).run();
    if (result.meta.changes !== 1) throw new AuthError('administrator_required', 403);
  }
  async adminUsers(token: string) {
    const session = await this.#store.requireSession(token, this.#now());
    if (!session.user.isAdmin) throw new AuthError('administrator_required', 403);
    return adminAccountReport(this.#store.db);
  }
  async setDisabled(token: string, userId: string, disabled: boolean): Promise<void> {
    const session = await this.#admin(token); const now = this.#now();
    if (session.user.id === userId) throw new AuthError('cannot_disable_current_administrator', 409);
    const mutation = randomToken(); const db = this.#store.db;
    const result = await db.batch([
      db.prepare(`UPDATE users SET disabled = ?, auth_epoch = auth_epoch + 1, auth_mutation = ?
        WHERE id = ? AND ${this.#freshGuard()} AND EXISTS (SELECT 1 FROM users WHERE id = ? AND is_admin = 1)`)
        .bind(Number(disabled), mutation, userId, ...this.#freshArgs(session, now), session.user.id),
      db.prepare('DELETE FROM sessions WHERE user_id = ? AND EXISTS (SELECT 1 FROM users WHERE id = ? AND auth_mutation = ?)')
        .bind(userId, userId, mutation),
    ]);
    if (result[0]!.meta.changes !== 1) throw new AuthError('account_unavailable', 409);
  }
  async throttle(key: string) { return this.#store.throttle(key, this.#now()); }
  #name(value: string): string {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > 80) throw new AuthError('invalid_name', 400);
    return value.trim();
  }
}
