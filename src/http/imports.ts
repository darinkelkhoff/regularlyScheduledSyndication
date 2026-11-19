import { Hono } from 'hono';
import type { Env } from './app.ts';
import { AuthError } from '../auth/store.ts';
import { fromBase64 } from '../auth/tokens.ts';
import { SourceVault } from '../security/source-vault.ts';
import { ImportService } from '../importer/service.ts';
import { FeedError } from '../importer/types.ts';
import { Catalog } from '../db/catalog.ts';
import { Subscriptions } from '../db/subscriptions.ts';
import { schedule, selection, input } from './podcasts.ts';
function importer(env: Env['Bindings']) {
  if (!env.SOURCE_SECRET || !env.FEED_TRANSPORT) throw new AuthError('import_unavailable', 409);
  return SourceVault.create(fromBase64(env.SOURCE_SECRET)).then(vault => new ImportService(env.DB, vault, env.FEED_TRANSPORT!));
}
export const importRoutes = new Hono<Env>();
importRoutes.use('*', async (c, next) => { if (!await c.get('auth').me(c.get('token'))) throw new AuthError('authentication_required'); await next(); });
importRoutes.post('/sources/preview', async c => {
  const data = await input(c.req.raw); if (typeof data.url !== 'string') throw new AuthError('invalid_request', 400);
  const owner = (await c.get('auth').me(c.get('token')))!.id;
  return c.json(await (await importer(c.env)).preview(owner, data.url));
});
importRoutes.post('/podcasts', async c => {
  const data = await input(c.req.raw); const owner = (await c.get('auth').me(c.get('token')))!.id;
  if (typeof data.sourceId !== 'string' || typeof data.live !== 'boolean' || !['now', 'next'].includes(String(data.choice))) throw new AuthError('invalid_request', 400);
  const parsedSchedule = schedule(data.schedule); const parsedSelection = selection(data.selection);
  const source = await (await importer(c.env)).summary(owner, data.sourceId);
  if (!source.lastSuccessAt || !source.episodes.length) throw new FeedError('source_unavailable');
  if (parsedSelection.mode === 'before' && data.live) throw new AuthError('invalid_selection', 400);
  if (await c.env.DB.withSession('first-primary').prepare('SELECT id FROM subscriptions WHERE user_id = ? AND source_id = ?').bind(owner, data.sourceId).first()) throw new AuthError('podcast_already_added', 409);
  const repository = new Subscriptions(c.env.DB);
  let id: string;
  try { id = await repository.create(owner, data.sourceId, { schedule: parsedSchedule, selection: parsedSelection, live: data.live, choice: data.choice as 'now' | 'next' }, new Date().toISOString()); }
  catch (error) { if (error instanceof RangeError) throw new AuthError('invalid_selection', 400); throw new AuthError('podcast_already_added', 409); }
  if (data.choice === 'now') await repository.process(owner, id, 0, new Date().toISOString());
  try { await c.env.FEED_PUBLISHER?.publish(owner, id); } catch { /* Pending work remains durable. */ }
  return c.json({ id }, 201);
});
importRoutes.post('/podcasts/:id/refresh', async c => {
  await input(c.req.raw); const owner = (await c.get('auth').me(c.get('token')))!.id;
  const subscription = await new Subscriptions(c.env.DB).load(owner, c.req.param('id'));
  if (!subscription) return c.json({ error: 'not_found' }, 404);
  const service = await importer(c.env); await service.refresh(owner, subscription.sourceId);
  try { await c.env.FEED_PUBLISHER?.publish(owner, subscription.id); } catch { /* Pending work remains durable. */ }
  return c.json(await service.summary(owner, subscription.sourceId));
});
importRoutes.post('/podcasts/:id/source-url', async c => {
  await input(c.req.raw); const owner = (await c.get('auth').me(c.get('token')))!.id;
  const subscription = await new Subscriptions(c.env.DB).load(owner, c.req.param('id'));
  if (!subscription || !c.env.SOURCE_SECRET) return c.json({ error: 'not_found' }, 404);
  const vault = await SourceVault.create(fromBase64(c.env.SOURCE_SECRET));
  return c.json({ url: await new Catalog(c.env.DB, vault).sourceUrl(owner, subscription.sourceId) });
});
