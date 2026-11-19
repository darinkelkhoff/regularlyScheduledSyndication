import type { D1Database } from '@cloudflare/workers-types';
import type { ImportService } from '../importer/service.ts';
import { Subscriptions } from '../db/subscriptions.ts';
import { randomToken } from '../auth/tokens.ts';

/** Bounded local orchestration. Existing import leases and release revisions fence individual writes. */
export async function runBackground(db: D1Database, importer: ImportService, now = new Date().toISOString(), limits = { sources: 3, subscriptions: 25 }) {
  if (![limits.sources, limits.subscriptions].every(limit => Number.isInteger(limit) && limit >= 1 && limit <= 25)) throw new RangeError('Invalid job limits');
  if (!Number.isFinite(Date.parse(now))) throw new RangeError('Invalid processing instant');
  const claim = randomToken(); const started = Date.now();
  const acquired = await db.prepare(`UPDATE background_job SET claim = ?, lease_until = ?
    WHERE id = 1 AND (claim IS NULL OR lease_until <= ?)`).bind(claim, started + 120_000, started).run();
  const result = { skipped: acquired.meta.changes !== 1, checked: 0, processed: 0, failures: 0 };
  if (result.skipped) return result;
  const ownsLease = async () => !!await db.prepare('SELECT id FROM background_job WHERE id = 1 AND claim = ? AND lease_until > ?').bind(claim, Date.now()).first();
  try {
    const sources = (await db.prepare(`SELECT src.id, src.user_id FROM sources src JOIN users u ON u.id = src.user_id
      WHERE u.disabled = 0 AND src.metadata_hash IS NOT NULL AND src.next_check_at <= ?
      AND (src.poll_claim IS NULL OR src.poll_lease_until <= ?)
      AND EXISTS (SELECT 1 FROM subscriptions s WHERE s.source_id = src.id AND s.live = 1)
      ORDER BY src.background_checked_at, src.id LIMIT ?`).bind(started, started, limits.sources).all<{ id: string; user_id: string }>()).results;
    for (const source of sources) {
      if (!await ownsLease()) break;
      await db.prepare('UPDATE sources SET background_checked_at = ? WHERE id = ?').bind(Date.now(), source.id).run();
      try { await importer.refresh(source.user_id, source.id, false); result.checked++; }
      catch { result.failures++; }
    }
    const subscriptions = (await db.prepare(`SELECT s.id, s.user_id FROM subscriptions s JOIN users u ON u.id = s.user_id
      WHERE u.disabled = 0 AND s.paused = 0 AND (s.waiting = 1 OR julianday(s.next_slot) <= julianday(?))
      ORDER BY s.background_processed_at, s.id LIMIT ?`).bind(now, limits.subscriptions).all<{ id: string; user_id: string }>()).results;
    const repository = new Subscriptions(db);
    for (const subscription of subscriptions) {
      if (!await ownsLease()) break;
      await db.prepare('UPDATE subscriptions SET background_processed_at = ? WHERE id = ?').bind(Date.now(), subscription.id).run();
      try {
        const snapshot = await repository.load(subscription.user_id, subscription.id);
        if (snapshot && await repository.process(subscription.user_id, subscription.id, snapshot.revision, now)) result.processed++;
      } catch { result.failures++; }
    }
    return result;
  } finally {
    await db.prepare('UPDATE background_job SET claim = NULL, lease_until = 0 WHERE id = 1 AND claim = ?').bind(claim).run();
  }
}
