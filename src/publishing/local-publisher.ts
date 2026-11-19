import type { D1Database } from '@cloudflare/workers-types';
import type { SourceVault } from '../security/source-vault.ts';
import { hashToken, randomToken } from '../auth/tokens.ts';
import { PublicationOutbox } from '../db/publication-outbox.ts';
import { rssPreview } from './preview.ts';

export type FeedStore = {
  put(key: string, value: string): Promise<unknown>;
  get(key: string): Promise<{ text(): Promise<string> } | null>;
  delete(key: string): Promise<unknown>;
};

/** Encrypted saved-XML adapter. A single database commit fences version and URL changes. */
export class LocalPublisher {
  private db: D1Database; private vault: SourceVault; private render: typeof rssPreview; private store: FeedStore;
  constructor(db: D1Database, vault: SourceVault, store: FeedStore, render: typeof rssPreview = rssPreview) { this.db = db; this.vault = vault; this.render = render; this.store = store; }
  async publish(owner: string, id: string): Promise<boolean> {
    const row = await this.db.withSession('first-primary').prepare(`SELECT s.publication_version, f.token_hash, f.token_ciphertext, f.xml_object_key, f.version
      FROM subscriptions s JOIN sources src ON src.id = s.source_id JOIN users u ON u.id = s.user_id
      LEFT JOIN local_feeds f ON f.subscription_id = s.id
      WHERE s.id = ? AND s.user_id = ? AND u.disabled = 0 AND src.metadata_hash IS NOT NULL`)
      .bind(id, owner).first<{ publication_version: number; token_hash: string | null; token_ciphertext: string | null; xml_object_key: string | null; version: number | null }>();
    if (!row) return false;
    if (row.xml_object_key && row.version === row.publication_version) return true;
    await this.db.prepare(`UPDATE publication_outbox SET attempted_at = ? WHERE subscription_id = ?`).bind(Date.now(), id).run();
    const objectKey = `snapshots/${crypto.randomUUID()}`;
    try {
      const xml = await this.render(this.db, this.vault, owner, id);
      if (xml === null) return false;
      const token = row.token_ciphertext ? await this.vault.open(`${owner}:feed-token:${id}`, row.token_ciphertext) : randomToken();
      const tokenHash = row.token_hash ?? await hashToken(token); const mutation = randomToken();
      await this.store.put(objectKey, await this.vault.seal(`${owner}:feed:${id}`, xml));
      const result = await this.db.batch([
        this.db.prepare(`INSERT INTO local_feeds (subscription_id, token_hash, token_ciphertext, xml_object_key, version, mutation_id)
          SELECT s.id, ?, ?, ?, ?, ? FROM subscriptions s JOIN users u ON u.id = s.user_id
          WHERE s.id = ? AND s.user_id = ? AND s.publication_version = ? AND u.disabled = 0
          ON CONFLICT(subscription_id) DO UPDATE SET xml_object_key = excluded.xml_object_key, version = excluded.version, mutation_id = excluded.mutation_id
          WHERE local_feeds.token_hash = ? AND local_feeds.version < excluded.version AND local_feeds.xml_object_key = ?`)
          .bind(tokenHash, row.token_ciphertext ?? await this.vault.seal(`${owner}:feed-token:${id}`, token),
            objectKey, row.publication_version, mutation, id, owner, row.publication_version, tokenHash, row.xml_object_key),
        this.db.prepare(`UPDATE publication_outbox SET published_version = ?, attempts = 0 WHERE subscription_id = ? AND desired_version = ?
          AND EXISTS (SELECT 1 FROM local_feeds WHERE subscription_id = ? AND mutation_id = ?)`)
          .bind(row.publication_version, id, row.publication_version, id, mutation),
      ]);
      const committed = result[0]!.meta.changes === 1;
      const obsolete = committed ? row.xml_object_key : objectKey;
      if (obsolete) { try { await this.store.delete(obsolete); } catch { /* Snapshot cleanup does not invalidate a committed publication. */ } }
      return committed;
    } catch {
      ///////////////////////////////////////////////////////////////////////////////////////////
      // A failed database response may follow a committed write; retain the immutable object. //
      ///////////////////////////////////////////////////////////////////////////////////////////
      await new PublicationOutbox(this.db).recordFailure(owner, id, row.publication_version);
      return false;
    }
  }
  async token(owner: string, id: string): Promise<string | null> {
    const row = await this.db.withSession('first-primary').prepare(`SELECT f.token_ciphertext FROM local_feeds f JOIN subscriptions s ON s.id = f.subscription_id
      JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.user_id = ? AND u.disabled = 0`).bind(id, owner).first<{ token_ciphertext: string }>();
    return row ? this.vault.open(`${owner}:feed-token:${id}`, row.token_ciphertext) : null;
  }
  async reset(owner: string, id: string): Promise<string | null> {
    const old = await this.token(owner, id); if (!old) return null;
    const token = randomToken();
    const result = await this.db.prepare(`UPDATE local_feeds SET token_hash = ?, token_ciphertext = ? WHERE subscription_id = ? AND token_hash = ?
      AND EXISTS (SELECT 1 FROM subscriptions s JOIN users u ON u.id = s.user_id WHERE s.id = subscription_id AND s.user_id = ? AND u.disabled = 0)`)
      .bind(await hashToken(token), await this.vault.seal(`${owner}:feed-token:${id}`, token), id, await hashToken(old), owner).run();
    return result.meta.changes === 1 ? token : null;
  }
  async read(token: string): Promise<string | null> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const tokenHash = await hashToken(token);
    for (let attempt = 0; attempt < 2; attempt++) {
      const row = await this.db.withSession('first-primary').prepare(`SELECT f.xml_object_key, s.id, s.user_id FROM local_feeds f
        JOIN subscriptions s ON s.id = f.subscription_id JOIN users u ON u.id = s.user_id WHERE f.token_hash = ? AND u.disabled = 0`)
        .bind(tokenHash).first<{ xml_object_key: string; id: string; user_id: string }>();
      if (!row) return null;
      const object = await this.store.get(row.xml_object_key);
      if (object) return this.vault.open(`${row.user_id}:feed:${row.id}`, await object.text());
    }
    return null;
  }
  async status(owner: string, id: string) {
    return this.db.withSession('first-primary').prepare(`SELECT o.desired_version AS desiredVersion, o.published_version AS publishedVersion,
      o.attempts, (f.subscription_id IS NOT NULL) AS available FROM publication_outbox o JOIN subscriptions s ON s.id = o.subscription_id
      LEFT JOIN local_feeds f ON f.subscription_id = s.id WHERE s.id = ? AND s.user_id = ?`).bind(id, owner)
      .first<{ desiredVersion: number; publishedVersion: number; attempts: number; available: number }>();
  }
  async cleanupDeleted(limit = 25): Promise<void> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 25) throw new RangeError('Invalid cleanup limit');
    const rows = (await this.db.withSession('first-primary').prepare(`SELECT subscription_id, xml_object_key FROM podcast_deletions
      WHERE xml_object_key IS NOT NULL ORDER BY cleanup_attempted_at, requested_at LIMIT ?`).bind(limit).all<{ subscription_id: string; xml_object_key: string }>()).results;
    for (const row of rows) {
      try {
        await this.db.prepare('UPDATE podcast_deletions SET cleanup_attempted_at = ? WHERE subscription_id = ?').bind(Date.now(), row.subscription_id).run();
        await this.store.delete(row.xml_object_key);
        await this.db.prepare('UPDATE podcast_deletions SET xml_object_key = NULL WHERE subscription_id = ? AND xml_object_key = ?').bind(row.subscription_id, row.xml_object_key).run();
      } catch { /* The revoked URL stays unavailable while object cleanup retries. */ }
    }
  }
  async flush(limit = 25): Promise<void> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 25) throw new RangeError('Invalid publication limit');
    await this.cleanupDeleted(limit);
    const rows = (await this.db.withSession('first-primary').prepare(`SELECT s.id, s.user_id FROM publication_outbox o
      JOIN subscriptions s ON s.id = o.subscription_id JOIN sources src ON src.id = s.source_id JOIN users u ON u.id = s.user_id
      WHERE o.desired_version > o.published_version AND src.metadata_hash IS NOT NULL AND u.disabled = 0
      ORDER BY o.attempted_at, s.id LIMIT ?`).bind(limit).all<{ id: string; user_id: string }>()).results;
    for (const row of rows) { try { await this.publish(row.user_id, row.id); } catch { /* Retain pending work for the next bounded pass. */ } }
  }
}
