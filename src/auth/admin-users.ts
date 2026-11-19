import type { D1Database } from '@cloudflare/workers-types';
export type AdminAccount = {
  id: string; displayName: string; isAdmin: number; disabled: number;
  createdAt: number | null; lastLoginAt: number | null; feedCount: number; activeFeedCount: number;
};
export async function adminAccountReport(db: D1Database) {
  ////////////////////////////////////////////////////////////////////////////////////////
  // Keep the summary global while bounding the detailed rows and database round trips. //
  ////////////////////////////////////////////////////////////////////////////////////////
  const results = await db.withSession('first-primary').batch([
    db.prepare('SELECT COUNT(*) AS totalUsers, COALESCE(SUM(disabled = 0), 0) AS activeUsers FROM users'),
    db.prepare(`SELECT u.id, u.display_name AS displayName, u.is_admin AS isAdmin, u.disabled,
      u.created_at AS createdAt, u.last_login_at AS lastLoginAt,
      (SELECT COUNT(*) FROM subscriptions s WHERE s.user_id = u.id) AS feedCount,
      (SELECT COUNT(*) FROM subscriptions s WHERE s.user_id = u.id AND u.disabled = 0 AND s.paused = 0
        AND (s.live = 1 OR EXISTS (
          SELECT 1 FROM episodes e LEFT JOIN episodes b ON b.source_id = s.source_id
            AND b.identity = json_extract(s.selection_json, '$.boundaryId')
          WHERE e.source_id = s.source_id
            AND NOT EXISTS (SELECT 1 FROM releases r WHERE r.subscription_id = s.id AND r.episode_identity = e.identity)
            AND (json_extract(s.selection_json, '$.mode') = 'all'
              OR (json_extract(s.selection_json, '$.mode') = 'choose'
                AND e.identity IN (SELECT value FROM json_each(s.selection_json, '$.ids')))
              OR (json_extract(s.selection_json, '$.mode') = 'before'
                AND (julianday(e.published_at) < julianday(b.published_at)
                  OR (julianday(e.published_at) = julianday(b.published_at) AND e.identity < b.identity)))
              OR (json_extract(s.selection_json, '$.mode') = 'after'
                AND (julianday(e.published_at) > julianday(b.published_at)
                  OR (julianday(e.published_at) = julianday(b.published_at) AND e.identity > b.identity))))
        ))) AS activeFeedCount
      FROM users u ORDER BY u.created_at DESC, u.display_name COLLATE NOCASE, u.id LIMIT 100`),
  ]);
  const summary = results[0]!.results[0] as { totalUsers: number; activeUsers: number };
  return { ...summary, users: results[1]!.results as AdminAccount[] };
}
