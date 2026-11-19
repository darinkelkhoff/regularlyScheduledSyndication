import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import { Catalog } from '../db/catalog.ts';
import { AuthStore } from '../auth/store.ts';
import { SourceVault } from '../security/source-vault.ts';
import { hashToken, randomToken } from '../auth/tokens.ts';
import { assertPublicUrl } from './url-policy.ts';
import { parsePodcast } from './parse.ts';
import { FeedError, type FeedTransport, type Validators } from './types.ts';
export type SourceSummary = {
  sourceId: string; title: string; artworkUrl: string | null; episodes: { id: string; title: string; publishedAt: string; episodeNumber: string | null }[];
  lastCheckedAt: string | null; lastSuccessAt: string | null; lastError: string | null;
};
export class ImportService {
  #db: D1Database; #vault: SourceVault; #transport: FeedTransport;
  constructor(db: D1Database, vault: SourceVault, transport: FeedTransport) { this.#db = db; this.#vault = vault; this.#transport = transport; }
  async preview(owner: string, inputUrl: string): Promise<SourceSummary> {
    const url = assertPublicUrl(inputUrl);
    await new AuthStore(this.#db).throttle(`feed-import:${owner}`, Date.now());
    await this.#expireDrafts(owner);
    const fingerprint = await this.#vault.fingerprint(owner, url.href);
    const rows = await this.#db.withSession('first-primary').batch([
      this.#db.prepare('SELECT id FROM sources WHERE user_id = ? AND url_fingerprint = ?').bind(owner, fingerprint),
      this.#db.prepare('SELECT COUNT(*) AS n FROM sources WHERE user_id = ?').bind(owner),
    ]);
    if (!rows[0]!.results.length && Number((rows[1]!.results[0] as { n: number }).n) >= 25) throw new FeedError('source_limit');
    let sourceId: string;
    try { sourceId = await new Catalog(this.#db, this.#vault).addSource(owner, url.href); }
    catch { throw new FeedError('source_limit'); }
    const subscription = await this.#db.withSession('first-primary').prepare('SELECT id FROM subscriptions WHERE user_id = ? AND source_id = ?').bind(owner, sourceId).first();
    if (subscription) throw new FeedError('podcast_already_added');
    try { await this.refresh(owner, sourceId, false); }
    catch (error) {
      await this.#db.prepare(`DELETE FROM sources WHERE id = ? AND user_id = ? AND last_success_at IS NULL AND poll_claim IS NULL
        AND NOT EXISTS (SELECT 1 FROM episodes WHERE source_id = sources.id)
        AND NOT EXISTS (SELECT 1 FROM subscriptions WHERE source_id = sources.id)`).bind(sourceId, owner).run();
      throw error;
    }
    return this.summary(owner, sourceId);
  }
  async #expireDrafts(owner: string): Promise<void> {
    const now = Date.now();
    const eligible = `user_id = ? AND draft_expires_at <= ? AND (poll_claim IS NULL OR poll_lease_until <= ?)
      AND NOT EXISTS (SELECT 1 FROM subscriptions WHERE source_id = sources.id)`;
    await this.#db.batch([
      this.#db.prepare(`DELETE FROM episodes WHERE source_id IN (SELECT id FROM sources WHERE ${eligible})`).bind(owner, now, now),
      this.#db.prepare(`DELETE FROM sources WHERE ${eligible}`).bind(owner, now, now),
    ]);
  }
  async summary(owner: string, sourceId: string): Promise<SourceSummary> {
    const session = this.#db.withSession('first-primary');
    const results = await session.batch([
      session.prepare('SELECT title, metadata_ciphertext, last_checked_at, last_success_at, last_error_code FROM sources WHERE id = ? AND user_id = ?').bind(sourceId, owner),
      session.prepare(`SELECT identity AS id, title, published_at AS publishedAt, episode_number AS episodeNumber
        FROM episodes WHERE source_id = ? AND EXISTS (SELECT 1 FROM sources WHERE id = ? AND user_id = ?)`)
        .bind(sourceId, sourceId, owner),
    ]);
    const source = results[0]!.results[0] as { title: string; metadata_ciphertext: string | null; last_checked_at: string | null; last_success_at: string | null; last_error_code: string | null } | undefined;
    if (!source) throw new FeedError('source_unavailable');
    const metadata = source.metadata_ciphertext ? JSON.parse(await this.#vault.open(`${owner}:show:${sourceId}`, source.metadata_ciphertext)) : {};
    return { sourceId, title: source.title, artworkUrl: metadata.image ?? null, episodes: results[1]!.results as SourceSummary['episodes'], lastCheckedAt: source.last_checked_at, lastSuccessAt: source.last_success_at, lastError: source.last_error_code };
  }
  async refresh(owner: string, sourceId: string, throttle = true): Promise<void> {
    if (throttle) await new AuthStore(this.#db).throttle(`feed-import:${owner}`, Date.now());
    const now = Date.now(); const claim = randomToken();
    const row = await this.#db.prepare(`UPDATE sources SET poll_claim = ?, poll_lease_until = ?
      WHERE id = ? AND user_id = ? AND (poll_claim IS NULL OR poll_lease_until <= ?)
      AND EXISTS (SELECT 1 FROM users WHERE users.id = sources.user_id AND disabled = 0)
      RETURNING url_ciphertext, validators_ciphertext, last_success_at, poll_failures`)
      .bind(claim, now + 60_000, sourceId, owner, now)
      .first<{ url_ciphertext: string; validators_ciphertext: string | null; last_success_at: string | null; poll_failures: number }>();
    if (!row) throw new FeedError('source_busy');
    try {
      const url = await this.#vault.open(owner, row.url_ciphertext);
      const validators: Validators = row.validators_ciphertext ? JSON.parse(await this.#vault.open(`${owner}:validators:${sourceId}`, row.validators_ciphertext)) as Validators : {};
      const response = await this.#transport(url, validators);
      const checkedAt = new Date().toISOString();
      const statements: D1PreparedStatement[] = [];
      const gate = 'id = ? AND user_id = ? AND poll_claim = ? AND poll_lease_until > ? AND EXISTS (SELECT 1 FROM users WHERE users.id = sources.user_id AND disabled = 0)';
      const commitTime = Date.now(); const gateArgs = [sourceId, owner, claim, commitTime];
      const nextValidators = { etag: response.etag ?? validators.etag, lastModified: response.lastModified ?? validators.lastModified };
      if (response.status === 304) {
        if (!row.last_success_at) throw new FeedError('invalid_not_modified');
        statements.push(this.#db.prepare(`UPDATE sources SET validators_ciphertext = ?, last_checked_at = ?, last_success_at = ?, last_error_code = NULL,
          poll_failures = 0, next_check_at = ?, poll_claim = NULL, poll_lease_until = NULL WHERE ${gate}`)
          .bind(await this.#vault.seal(`${owner}:validators:${sourceId}`, JSON.stringify(nextValidators)), checkedAt, checkedAt, commitTime + 3_600_000, ...gateArgs));
      } else {
        const feed = await parsePodcast(response.xml ?? '', response.finalUrl ?? url);
        for (const episode of feed.episodes) {
          const serialized = JSON.stringify(episode.metadata);
          statements.push(this.#db.prepare(`INSERT INTO episodes
            (source_id, identity, title, published_at, episode_number, metadata_ciphertext, metadata_hash)
            SELECT id, ?, ?, ?, ?, ?, ? FROM sources WHERE ${gate}
            ON CONFLICT (source_id, identity) DO UPDATE SET title = excluded.title, published_at = excluded.published_at,
              episode_number = excluded.episode_number, metadata_ciphertext = excluded.metadata_ciphertext, metadata_hash = excluded.metadata_hash
            WHERE episodes.title IS NOT excluded.title OR episodes.published_at IS NOT excluded.published_at OR episodes.metadata_hash IS NOT excluded.metadata_hash`)
            .bind(episode.id, episode.title, episode.publishedAt, episode.metadata.episode ?? null,
              await this.#vault.seal(`${owner}:episode:${sourceId}:${episode.id}`, serialized), await hashToken(serialized), ...gateArgs));
        }
        const metadata = JSON.stringify(feed.metadata);
        statements.push(this.#db.prepare(`UPDATE sources SET title = ?, metadata_ciphertext = ?, metadata_hash = ?, validators_ciphertext = ?,
          last_checked_at = ?, last_success_at = ?, last_error_code = NULL, poll_failures = 0, next_check_at = ?, poll_claim = NULL, poll_lease_until = NULL WHERE ${gate}`)
          .bind(feed.title, await this.#vault.seal(`${owner}:show:${sourceId}`, metadata), await hashToken(metadata),
            await this.#vault.seal(`${owner}:validators:${sourceId}`, JSON.stringify(response.etag || response.lastModified ? { etag: response.etag, lastModified: response.lastModified } : {})),
            checkedAt, checkedAt, commitTime + 3_600_000, ...gateArgs));
      }
      const results = await this.#db.batch(statements);
      //////////////////////////////////////////////////////////////////////////////////
      // Trigger updates can contribute to changes, so read RETURNING is unnecessary: //
      // a successful claim release always changes at least its own source row.       //
      //////////////////////////////////////////////////////////////////////////////////
      if (!results.at(-1)!.meta.changes) throw new FeedError('source_busy');
    } catch (error) {
      const code = error instanceof FeedError ? error.code : 'feed_fetch_failed';
      await this.#db.prepare(`UPDATE sources SET last_checked_at = ?, last_error_code = ?, poll_failures = poll_failures + 1,
        next_check_at = ?, poll_claim = NULL, poll_lease_until = NULL WHERE id = ? AND user_id = ? AND poll_claim = ?`)
        .bind(new Date().toISOString(), code, Date.now() + Math.min(24 * 3_600_000, 300_000 * 2 ** Math.min(row.poll_failures, 8)), sourceId, owner, claim).run();
      throw new FeedError(code);
    }
  }
}
