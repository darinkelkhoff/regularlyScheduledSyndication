import type { D1Database } from '@cloudflare/workers-types';
import type { SourceVault } from '../security/source-vault.ts';
import type { EpisodeMetadata, ShowMetadata } from '../importer/types.ts';
import { renderRss } from './rss.ts';

/** Read committed history and metadata in one consistent, owner-scoped snapshot. */
export async function rssPreview(db: D1Database, vault: SourceVault, owner: string, subscriptionId: string): Promise<string | null> {
  const session = db.withSession('first-primary');
  const results = await session.batch([
    session.prepare(`SELECT src.id, src.title, src.metadata_ciphertext FROM sources src JOIN subscriptions s ON s.source_id = src.id WHERE s.id = ? AND s.user_id = ?`).bind(subscriptionId, owner),
    session.prepare(`SELECT e.identity, e.title, e.published_at, e.metadata_ciphertext, r.output_guid, r.delivered_at
      FROM releases r JOIN subscriptions s ON s.id = r.subscription_id JOIN episodes e ON e.source_id = r.source_id AND e.identity = r.episode_identity
      WHERE s.id = ? AND s.user_id = ? ORDER BY r.sequence DESC`).bind(subscriptionId, owner),
  ]);
  const source = results[0]!.results[0] as { id: string; title: string; metadata_ciphertext: string | null } | undefined;
  if (!source || !source.metadata_ciphertext) return null;
  const metadata = JSON.parse(await vault.open(`${owner}:show:${source.id}`, source.metadata_ciphertext)) as ShowMetadata;
  const episodes = await Promise.all(results[1]!.results.map(async raw => {
    const row = raw as { identity: string; title: string; published_at: string; metadata_ciphertext: string; output_guid: string; delivered_at: string };
    return { title: row.title, publishedAt: row.published_at, guid: row.output_guid, deliveredAt: row.delivered_at,
      metadata: JSON.parse(await vault.open(`${owner}:episode:${source.id}:${row.identity}`, row.metadata_ciphertext)) as EpisodeMetadata };
  }));
  return renderRss({ title: source.title, metadata }, episodes);
}
