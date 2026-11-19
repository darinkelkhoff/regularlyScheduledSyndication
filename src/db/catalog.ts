import type { D1Database } from '@cloudflare/workers-types';
import { Temporal } from '@js-temporal/polyfill';
import type { Episode } from '../domain/selection.ts';
import type { SourceVault } from '../security/source-vault.ts';

export type ImportedEpisode = Episode & { title: string; episodeNumber?: string | null };
export class Catalog {
  #db: D1Database;
  #vault: SourceVault;
  constructor(db: D1Database, vault: SourceVault) { this.#db = db; this.#vault = vault; }

  async addSource(owner: string, inputUrl: string): Promise<string> {
    let url: URL;
    try { url = new URL(inputUrl); } catch { throw new RangeError('Invalid source URL'); }
    if (!['http:', 'https:'].includes(url.protocol)) throw new RangeError('Unsupported source URL protocol');
    url.hash = '';
    const canonical = url.href;
    const fingerprint = await this.#vault.fingerprint(owner, canonical);
    await this.#db.prepare(`INSERT INTO sources (id, user_id, url_ciphertext, url_fingerprint, draft_expires_at)
      SELECT ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM sources WHERE user_id = ?) < 25 ON CONFLICT (user_id, url_fingerprint) DO NOTHING`)
      .bind(crypto.randomUUID(), owner, await this.#vault.seal(owner, canonical), fingerprint, Date.now() + 30 * 60_000, owner).run();
    const row = await this.#db.withSession('first-primary').prepare('SELECT id FROM sources WHERE user_id = ? AND url_fingerprint = ?')
      .bind(owner, fingerprint).first<{ id: string }>();
    if (!row) throw new Error('Source unavailable');
    return row.id;
  }

  /** Only explicit reveal/polling flows should call this method; never log it. */
  async sourceUrl(owner: string, sourceId: string): Promise<string> {
    const row = await this.#db.withSession('first-primary').prepare('SELECT url_ciphertext FROM sources WHERE id = ? AND user_id = ?')
      .bind(sourceId, owner).first<{ url_ciphertext: string }>();
    if (!row) throw new Error('Source unavailable');
    return this.#vault.open(owner, row.url_ciphertext);
  }

  /** Import bounded batches; omission by the publisher never deletes old rows. */
  async importEpisodes(owner: string, sourceId: string, episodes: readonly ImportedEpisode[]): Promise<void> {
    if (episodes.length > 100) throw new RangeError('Import at most 100 episodes per batch');
    const source = await this.#db.withSession('first-primary').prepare('SELECT id FROM sources WHERE id = ? AND user_id = ?')
      .bind(sourceId, owner).first();
    if (!source) throw new Error('Source unavailable');
    const seen = new Set<string>();
    const statements = episodes.map(episode => {
      if (!episode.id || seen.has(episode.id)) throw new RangeError('Episode identities must be unique and nonempty');
      seen.add(episode.id);
      const publishedAt = Temporal.Instant.from(episode.publishedAt).toString();
      return this.#db.prepare(`INSERT INTO episodes (source_id, identity, published_at, title)
        SELECT id, ?, ?, ? FROM sources WHERE id = ? AND user_id = ?
        ON CONFLICT (source_id, identity) DO UPDATE SET published_at = excluded.published_at, title = excluded.title`)
        .bind(episode.id, publishedAt, episode.title, sourceId, owner);
    });
    if (statements.length) await this.#db.batch(statements);
  }
}
