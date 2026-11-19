import { deletePodcast } from '../db/delete-podcast.ts';
import { rssPreview } from '../publishing/preview.ts';
import { Hono } from 'hono';
import type { Env } from './app.ts';
import { AuthError, AuthStore } from '../auth/store.ts';
import { Catalog } from '../db/catalog.ts';
import { Subscriptions, type Change } from '../db/subscriptions.ts';
import { SourceVault } from '../security/source-vault.ts';
import { fromBase64 } from '../auth/tokens.ts';
import { previewSlots, type Schedule } from '../domain/schedule.ts';
import { selectEpisodes, type Selection } from '../domain/selection.ts';
async function artwork(env: Env['Bindings'], owner: string, sourceId: string): Promise<string | null> {
  const source = await env.DB.withSession('first-primary').prepare('SELECT metadata_ciphertext FROM sources WHERE id = ? AND user_id = ?').bind(sourceId, owner).first<{ metadata_ciphertext: string | null }>();
  if (!source?.metadata_ciphertext || !env.SOURCE_SECRET) return null;
  const vault = await SourceVault.create(fromBase64(env.SOURCE_SECRET));
  return JSON.parse(await vault.open(`${owner}:show:${sourceId}`, source.metadata_ciphertext)).image ?? null;
}
const titles = ['The art of starting small', 'A question worth asking', 'How ideas find their feet', 'The quiet work of noticing', 'A little room for wonder', 'Finding your own rhythm', 'What we keep coming back to', 'The long way home', 'Making space for good things', 'The stories we carry', 'A change of perspective', 'Here, at your own pace'];
export const sampleEpisodes = titles.map((title, i) => ({ id: `sample-${i + 1}`, title, publishedAt: new Date(Date.UTC(2024, 0, 1 + i * 7)).toISOString() }));
export function schedule(input: unknown): Schedule {
  if (!input || typeof input !== 'object') throw new AuthError('invalid_schedule', 400);
  const s = input as Schedule;
  if (typeof s.timeZone !== 'string' || !Number.isInteger(s.hour) ||
    (s.kind === 'weekly' && !Array.isArray(s.weekdays)) ||
    (s.kind === 'interval' && typeof s.startDate !== 'string')) throw new AuthError('invalid_schedule', 400);
  try { previewSlots(s, new Date().toISOString(), 1); } catch { throw new AuthError('invalid_schedule', 400); }
  return s;
}
export function selection(input: unknown): Selection {
  if (!input || typeof input !== 'object') throw new AuthError('invalid_selection', 400);
  const s = input as Selection;
  if (s.mode === 'all') return { mode: 'all' };
  if ((s.mode === 'before' || s.mode === 'after') && typeof s.boundaryId === 'string') return { mode: s.mode, boundaryId: s.boundaryId };
  if (s.mode === 'choose' && Array.isArray(s.ids) && s.ids.every(id => typeof id === 'string')) return { mode: 'choose', ids: s.ids };
  throw new AuthError('invalid_selection', 400);
}
export async function input(request: Request): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:;|$)/i.test(request.headers.get('Content-Type') ?? '')) throw new AuthError('json_required', 400);
  try { const value: unknown = await request.json(); if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>; } catch { /* Invalid JSON is handled below. */ }
  throw new AuthError('invalid_request', 400);
}
export const podcastRoutes = new Hono<Env>();
podcastRoutes.use('*', async (c, next) => { if (!await c.get('auth').me(c.get('token'))) throw new AuthError('authentication_required'); await next(); });
podcastRoutes.post('/calendar/preview', async c => { const data = await input(c.req.raw); return c.json({ slots: previewSlots(schedule(data.schedule), new Date().toISOString(), 5) }); });
podcastRoutes.get('/podcasts', async c => {
  const owner = (await c.get('auth').me(c.get('token')))!.id;
  const rows = (await c.env.DB.withSession('first-primary').prepare('SELECT s.id, src.title, src.metadata_hash, src.metadata_ciphertext, src.last_error_code FROM subscriptions s JOIN sources src ON src.id = s.source_id WHERE s.user_id = ? ORDER BY s.id LIMIT 100').bind(owner).all<{ id: string; title: string; metadata_hash: string | null; metadata_ciphertext: string | null; last_error_code: string | null }>()).results;
  const repository = new Subscriptions(c.env.DB);
  const vault = c.env.SOURCE_SECRET ? await SourceVault.create(fromBase64(c.env.SOURCE_SECRET)) : null;
  const podcasts = await Promise.all(rows.map(async row => {
    const snapshot = (await repository.load(owner, row.id))!;
    const queue = selectEpisodes(snapshot.episodes, snapshot.selection, snapshot.state.releases.map(r => r.episodeId));
    const upcoming = queue.length;
    const nextEpisode = queue[0] ? { id: queue[0].id, title: queue[0].title, episodeNumber: queue[0].episodeNumber ?? null } : null;
    return { artworkUrl: row.metadata_ciphertext && vault ? JSON.parse(await vault.open(`${owner}:show:${snapshot.sourceId}`, row.metadata_ciphertext)).image ?? null : null, id: row.id, title: row.title, isSample: !row.metadata_hash, lastError: row.last_error_code, nextSlot: snapshot.state.nextSlot, timeZone: snapshot.state.schedule.timeZone, nextEpisode, upcoming, delivered: snapshot.state.releases.length, status: snapshot.state.paused ? 'Paused' : upcoming ? 'Active' : snapshot.live ? 'Waiting' : 'Finished' };
  }));
  return c.json({ podcasts, backgroundProcessing: c.env.BACKGROUND_PROCESSING === '1', localPreview: c.env.LOCAL_PREVIEW === '1' });
});
podcastRoutes.get('/podcasts/sample-preview', c => c.env.LOCAL_PREVIEW === '1' ? c.json({ title: 'Small Hours', episodes: sampleEpisodes }) : c.json({ error: 'not_found' }, 404));
podcastRoutes.post('/podcasts/sample', async c => {
  if (c.env.LOCAL_PREVIEW !== '1' || !c.env.SOURCE_SECRET) return c.json({ error: 'not_found' }, 404);
  const data = await input(c.req.raw); const owner = (await c.get('auth').me(c.get('token')))!.id;
  const parsedSchedule = schedule(data.schedule); const parsedSelection = selection(data.selection);
  if (typeof data.live !== 'boolean' || !['now', 'next'].includes(String(data.choice))) throw new AuthError('invalid_request', 400);
  const catalog = new Catalog(c.env.DB, await SourceVault.create(fromBase64(c.env.SOURCE_SECRET)));
  const source = await catalog.addSource(owner, 'https://example.invalid/regsched-local-sample');
  if (await c.env.DB.withSession('first-primary').prepare('SELECT id FROM subscriptions WHERE user_id = ? AND source_id = ?').bind(owner, source).first()) throw new AuthError('podcast_already_added', 409);
  try { selectEpisodes(sampleEpisodes, parsedSelection); } catch { throw new AuthError('invalid_selection', 400); }
  await catalog.importEpisodes(owner, source, sampleEpisodes);
  await c.env.DB.prepare('UPDATE sources SET title = ? WHERE id = ? AND user_id = ?').bind('Small Hours', source, owner).run();
  const repository = new Subscriptions(c.env.DB);
  let id: string;
  try { id = await repository.create(owner, source, { schedule: parsedSchedule, selection: parsedSelection, live: data.live, choice: data.choice as 'now' | 'next' }, new Date().toISOString()); }
  catch { throw new AuthError('podcast_already_added', 409); }
  if (data.choice === 'now') await repository.process(owner, id, 0, new Date().toISOString());
  return c.json({ id }, 201);
});
podcastRoutes.get('/podcasts/:id', async c => {
  const owner = (await c.get('auth').me(c.get('token')))!.id;
  const snapshot = await new Subscriptions(c.env.DB).load(owner, c.req.param('id'));
  if (!snapshot) return c.json({ error: 'not_found' }, 404);
  const source = await c.env.DB.withSession('first-primary').prepare('SELECT title, metadata_hash, last_success_at, last_checked_at, last_error_code FROM sources WHERE id = ? AND user_id = ?').bind(snapshot.sourceId, owner).first<{ title: string; metadata_hash: string | null; last_success_at: string | null; last_checked_at: string | null; last_error_code: string | null }>();
  return c.json({ ...snapshot, publishingAvailable: !!c.env.FEED_PUBLISHER && !!source!.metadata_hash, feedStatus: c.env.FEED_PUBLISHER ? await c.env.FEED_PUBLISHER.status(owner, snapshot.id) : null, backgroundProcessing: c.env.BACKGROUND_PROCESSING === '1', canPreviewRss: (c.env.LOCAL_PREVIEW === '1' || c.env.RSS_PREVIEW === '1') && !!source!.metadata_hash, artworkUrl: await artwork(c.env, owner, snapshot.sourceId), title: source!.title, isSample: !source!.metadata_hash, lastSuccessAt: source!.last_success_at, lastCheckedAt: source!.last_checked_at, lastError: source!.last_error_code });
});
podcastRoutes.post('/podcasts/:id/feed', async c => {
  const data = await input(c.req.raw);
  if (!c.env.FEED_PUBLISHER) return c.json({ error: 'not_found' }, 404);
  if (!['publish', 'reveal', 'reset'].includes(String(data.action))) throw new AuthError('invalid_request', 400);
  const owner = (await c.get('auth').me(c.get('token')))!.id; const id = c.req.param('id');
  const snapshot = await new Subscriptions(c.env.DB).load(owner, id);
  if (!snapshot) return c.json({ error: 'not_found' }, 404);
  if (data.action === 'publish') await new AuthStore(c.env.DB).throttle(`feed-publish:${owner}`, Date.now());
  if (data.action === 'publish' && !await c.env.FEED_PUBLISHER.publish(owner, id)) return c.json({ error: 'publication_pending' }, 409);
  const token = data.action === 'reset' ? await c.env.FEED_PUBLISHER.reset(owner, id) : await c.env.FEED_PUBLISHER.token(owner, id);
  if (!token) return c.json({ error: 'not_found' }, 404);
  return c.json({ url: `${c.env.ORIGIN}/feeds/${token}/rss.xml` });
});
podcastRoutes.get('/podcasts/:id/rss-preview', async c => {
  if ((c.env.LOCAL_PREVIEW !== '1' && c.env.RSS_PREVIEW !== '1') || !c.env.SOURCE_SECRET) return c.json({ error: 'not_found' }, 404);
  const owner = (await c.get('auth').me(c.get('token')))!.id;
  const vault = await SourceVault.create(fromBase64(c.env.SOURCE_SECRET));
  const xml = await rssPreview(c.env.DB, vault, owner, c.req.param('id'));
  if (xml === null) return c.json({ error: 'not_found' }, 404);
  c.header('Cache-Control', 'no-store');
  c.header('Content-Type', 'application/rss+xml; charset=utf-8');
  c.header('Content-Disposition', 'attachment; filename="podcast-preview.xml"');
  return c.body(xml);
});
podcastRoutes.post('/podcasts/:id/delete', async c => {
  const data = await input(c.req.raw);
  if (!Number.isSafeInteger(data.revision)) throw new AuthError('invalid_request', 400);
  const owner = (await c.get('auth').me(c.get('token')))!.id; const id = c.req.param('id');
  if (!await new Subscriptions(c.env.DB).load(owner, id)) return c.json({ error: 'not_found' }, 404);
  if (!await deletePodcast(c.env.DB, owner, id, data.revision as number)) throw new AuthError('subscription_changed', 409);
  try { await c.env.FEED_PUBLISHER?.cleanupDeleted(); } catch { /* Cleanup is durable and retried by the publisher. */ }
  return c.json({ ok: true });
});
podcastRoutes.post('/podcasts/:id/change', async c => {
  const data = await input(c.req.raw); const owner = (await c.get('auth').me(c.get('token')))!.id;
  if (!Number.isSafeInteger(data.revision) || !data.change || typeof data.change !== 'object') throw new AuthError('invalid_request', 400);
  const raw = data.change as Change; let change: Change;
  switch (raw.kind) {
    case 'pause': change = { kind: 'pause' }; break;
    case 'resume': if (!['now', 'next'].includes(raw.choice)) throw new AuthError('invalid_request', 400); change = { kind: 'resume', choice: raw.choice }; break;
    case 'schedule': change = { kind: 'schedule', schedule: schedule(raw.schedule) }; break;
    case 'selection': if (typeof raw.live !== 'boolean') throw new AuthError('invalid_request', 400); change = { kind: 'selection', selection: selection(raw.selection), live: raw.live }; break;
    default: throw new AuthError('invalid_request', 400);
  }
  try {
    const saved = await new Subscriptions(c.env.DB).change(owner, c.req.param('id'), data.revision as number, change, new Date().toISOString());
    if (!saved) throw new AuthError('subscription_changed', 409);
    if (change.kind === 'resume' && change.choice === 'now') {
      await new Subscriptions(c.env.DB).process(owner, c.req.param('id'), (data.revision as number) + 1, new Date().toISOString());
    }
  } catch (error) { if (error instanceof RangeError) throw new AuthError('invalid_selection', 400); throw error; }
  try { await c.env.FEED_PUBLISHER?.publish(owner, c.req.param('id')); } catch { /* Pending work is retried by the local publisher. */ }
  return c.json({ ok: true });
});
