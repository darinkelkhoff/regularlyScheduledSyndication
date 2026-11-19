import type { D1Database } from '@cloudflare/workers-types';

export type PendingPublication = { desiredVersion: number; publishedVersion: number; attempts: number };

/** Tracks database publication intent; R2 write serialization and purge retries are separate. */
export class PublicationOutbox {
  #db: D1Database;
  constructor(db: D1Database) { this.#db = db; }

  async pending(owner: string, subscriptionId: string): Promise<PendingPublication | null> {
    return this.#db.withSession('first-primary').prepare(`SELECT desired_version AS desiredVersion,
      published_version AS publishedVersion, attempts FROM publication_outbox
      WHERE subscription_id = ? AND desired_version > published_version
      AND EXISTS (SELECT 1 FROM subscriptions WHERE id = subscription_id AND user_id = ?)`)
      .bind(subscriptionId, owner).first<PendingPublication>();
  }

  /** Call only after the matching snapshot and its cache purge have succeeded. */
  async acknowledge(owner: string, subscriptionId: string, version: number): Promise<boolean> {
    const result = await this.#db.prepare(`UPDATE publication_outbox SET published_version = ?, attempts = 0
      WHERE subscription_id = ? AND desired_version = ? AND published_version < ?
      AND EXISTS (SELECT 1 FROM subscriptions WHERE id = subscription_id AND user_id = ?)`)
      .bind(version, subscriptionId, version, version, owner).run();
    return result.meta.changes === 1;
  }

  /** Store attempt counts only: exception messages may contain private URLs. */
  async recordFailure(owner: string, subscriptionId: string, version: number): Promise<boolean> {
    const result = await this.#db.prepare(`UPDATE publication_outbox SET attempts = attempts + 1
      WHERE subscription_id = ? AND desired_version = ? AND published_version < ?
      AND EXISTS (SELECT 1 FROM subscriptions WHERE id = subscription_id AND user_id = ?)`)
      .bind(subscriptionId, version, version, owner).run();
    return result.meta.changes === 1;
  }
}
