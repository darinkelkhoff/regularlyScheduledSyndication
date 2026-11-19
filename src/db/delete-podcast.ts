import type { D1Database } from '@cloudflare/workers-types';
import { randomToken } from '../auth/tokens.ts';

/** Only an explicit, revision-checked deletion may remove immutable delivery history. */
export async function deletePodcast(db: D1Database, owner: string, id: string, revision: number): Promise<boolean> {
  const mutation = randomToken();
  const gate = 'EXISTS (SELECT 1 FROM podcast_deletions d WHERE d.subscription_id = ? AND d.user_id = ? AND d.mutation_id = ?)';
  const source = '(SELECT source_id FROM podcast_deletions WHERE subscription_id = ? AND user_id = ? AND mutation_id = ?)';
  const args = [id, owner, mutation];
  const results = await db.batch([
    db.prepare(`INSERT INTO podcast_deletions (subscription_id, user_id, source_id, mutation_id, xml_object_key, requested_at)
      SELECT s.id, s.user_id, s.source_id, ?, f.xml_object_key, ? FROM subscriptions s JOIN users u ON u.id = s.user_id
      LEFT JOIN local_feeds f ON f.subscription_id = s.id
      WHERE s.id = ? AND s.user_id = ? AND s.revision = ? AND u.disabled = 0 ON CONFLICT(subscription_id) DO NOTHING`)
      .bind(mutation, Date.now(), id, owner, revision),
    db.prepare(`DELETE FROM local_feeds WHERE subscription_id = ? AND ${gate}`).bind(id, ...args),
    db.prepare(`DELETE FROM publication_outbox WHERE subscription_id = ? AND ${gate}`).bind(id, ...args),
    db.prepare(`DELETE FROM releases WHERE subscription_id = ? AND ${gate}`).bind(id, ...args),
    db.prepare(`DELETE FROM subscriptions WHERE id = ? AND user_id = ? AND ${gate}`).bind(id, owner, ...args),
    db.prepare(`DELETE FROM episodes WHERE source_id = ${source} AND NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.source_id = episodes.source_id)`).bind(...args),
    db.prepare(`DELETE FROM sources WHERE id = ${source} AND NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.source_id = sources.id)`).bind(...args),
  ]);
  return results[4]!.meta.changes === 1;
}
