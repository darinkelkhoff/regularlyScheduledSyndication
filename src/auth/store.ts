import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import { hashToken } from './tokens.ts';
export const FRESH_MS = 5 * 60_000;
export const SESSION_MS = 30 * 86_400_000;
export type ChallengeKind = 'signup' | 'login' | 'reauth' | 'add' | 'recover';
export type Challenge = {
  id: string; kind: ChallengeKind; challenge: string; browser_hash: string; user_id: string | null;
  display_name: string | null; credential_name: string | null; session_hash: string | null;
  recovery_hash: string | null; user_epoch: number | null; wants_admin: number; expires_at: number;
};
export type User = { id: string; displayName: string; isAdmin: boolean };
export type Session = { user: User; tokenHash: string; epoch: number; authenticatedAt: number };
export type Credential = { id: string; user_id: string; name: string; public_key: string; counter: number; transports_json: string; auth_epoch: number; disabled: number };
export class AuthError extends Error {
  status: 400 | 401 | 403 | 409 | 429;
  constructor(code: string, status: AuthError['status'] = 401) { super(code); this.status = status; }
}
export class AuthStore {
  db: D1Database;
  constructor(db: D1Database) { this.db = db; }
  async session(token: string, now: number): Promise<Session | null> {
    const tokenHash = await hashToken(token);
    const row = await this.db.withSession('first-primary').prepare(`SELECT u.id, u.display_name, u.is_admin,
      s.authenticated_at, u.auth_epoch FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ? AND u.disabled = 0 AND s.auth_epoch = u.auth_epoch`)
      .bind(tokenHash, now).first<{ id: string; display_name: string; is_admin: number; authenticated_at: number; auth_epoch: number }>();
    return row ? { user: { id: row.id, displayName: row.display_name, isAdmin: Boolean(row.is_admin) }, tokenHash, epoch: row.auth_epoch, authenticatedAt: row.authenticated_at } : null;
  }
  async requireSession(token: string, now: number, fresh = false): Promise<Session> {
    const session = await this.session(token, now);
    if (!session) throw new AuthError('authentication_required');
    if (fresh && session.authenticatedAt < now - FRESH_MS) throw new AuthError('fresh_authentication_required', 403);
    return session;
  }
  async challenge(id: string, browserHash: string, now: number): Promise<Challenge> {
    const row = await this.db.withSession('first-primary').prepare(`SELECT * FROM auth_challenges
      WHERE id = ? AND browser_hash = ? AND expires_at > ? AND claim_token IS NULL`).bind(id, browserHash, now).first<Challenge>();
    if (!row) throw new AuthError('invalid_challenge');
    return row;
  }
  async credential(id: string): Promise<Credential | null> {
    return this.db.withSession('first-primary').prepare('SELECT c.*, u.auth_epoch, u.disabled FROM credentials c JOIN users u ON u.id = c.user_id WHERE c.id = ?').bind(id).first<Credential>();
  }
  async saveChallenge(input: Omit<Challenge, 'expires_at'>, now: number): Promise<void> {
    await this.db.batch([
      this.db.prepare('DELETE FROM auth_challenges WHERE id IN (SELECT id FROM auth_challenges WHERE expires_at <= ? LIMIT 100)').bind(now),
      this.db.prepare(`INSERT INTO auth_challenges
        (id, kind, challenge, browser_hash, user_id, display_name, credential_name, session_hash, recovery_hash, user_epoch, wants_admin, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(input.id, input.kind, input.challenge, input.browser_hash, input.user_id, input.display_name, input.credential_name, input.session_hash, input.recovery_hash, input.user_epoch, input.wants_admin, now + 10 * 60_000),
    ]);
  }
  claim(challenge: Challenge, mutation: string, now: number): D1PreparedStatement {
    return this.db.prepare(`UPDATE auth_challenges SET claim_token = ? WHERE id = ? AND claim_token IS NULL
      AND expires_at > ? AND browser_hash = ?
      AND (kind IN ('signup', 'login') OR EXISTS (SELECT 1 FROM users u WHERE u.id = auth_challenges.user_id
        AND u.disabled = 0 AND u.auth_epoch = auth_challenges.user_epoch))
      AND (kind <> 'recover' OR EXISTS (SELECT 1 FROM users u WHERE u.id = auth_challenges.user_id AND u.recovery_hash = auth_challenges.recovery_hash))
      AND (session_hash IS NULL OR EXISTS (SELECT 1 FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = auth_challenges.session_hash AND s.user_id = auth_challenges.user_id
        AND s.auth_epoch = u.auth_epoch AND s.expires_at > ? AND (kind = 'reauth' OR s.authenticated_at >= ?)))`)
      .bind(mutation, challenge.id, now, challenge.browser_hash, now, now - FRESH_MS);
  }
  async throttle(key: string, now: number): Promise<void> {
    const rows = await this.db.batch([
      this.db.prepare('DELETE FROM auth_limits WHERE key_hash IN (SELECT key_hash FROM auth_limits WHERE reset_at <= ? LIMIT 100)').bind(now),
      this.db.prepare(`INSERT INTO auth_limits (key_hash, count, reset_at) VALUES (?, 1, ?)
        ON CONFLICT (key_hash) DO UPDATE SET
        count = CASE WHEN reset_at <= ? THEN 1 ELSE count + 1 END,
        reset_at = CASE WHEN reset_at <= ? THEN excluded.reset_at ELSE reset_at END
        RETURNING count`).bind(await hashToken(key), now + 10 * 60_000, now, now),
    ]);
    if (Number((rows[1]?.results[0] as { count: number } | undefined)?.count) > 30) throw new AuthError('rate_limited', 429);
  }
}
