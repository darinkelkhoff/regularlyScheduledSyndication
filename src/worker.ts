import type { D1Database, R2Bucket, ExecutionContext, ScheduledController } from '@cloudflare/workers-types';
import { app, type AppBindings } from './http/app.ts';
import { SourceVault } from './security/source-vault.ts';
import { fromBase64 } from './auth/tokens.ts';
import { LocalPublisher } from './publishing/local-publisher.ts';
import { workerTransport } from './importer/worker-transport.ts';
import { ImportService } from './importer/service.ts';
import { runBackground } from './jobs/background.ts';

export type WorkerBindings = {
  DB: D1Database; FEEDS: R2Bucket; ASSETS: AppBindings['ASSETS'];
  ORIGIN: string; RP_ID: string; SOURCE_SECRET: string; ADMIN_SETUP_SECRET: string;
  APP_ENV?: 'staging' | 'production'; MAINTENANCE?: string;
  MIGRATION_MODE?: 'freeze' | 'redirect'; MIGRATION_TARGET?: string;
};
export async function workerServices(env: WorkerBindings): Promise<AppBindings> {
  const vault = await SourceVault.create(fromBase64(env.SOURCE_SECRET));
  return {
    ...env, RP_NAME: env.APP_ENV === 'production' ? 'RegSched' : 'RegSched staging', APP_ENV: env.APP_ENV ?? 'staging', RSS_PREVIEW: '1', BACKGROUND_PROCESSING: '1',
    FEED_TRANSPORT: workerTransport(), FEED_PUBLISHER: new LocalPublisher(env.DB, vault, env.FEEDS),
  };
}
export default {
  async fetch(request: Request, env: WorkerBindings) {
    /////////////////////////////////////////////////////////////////////////////////////////////////////
    // Never derive the relying-party identity or generated feed origin from an untrusted Host header. //
    /////////////////////////////////////////////////////////////////////////////////////////////////////
    if (new URL(request.url).origin !== env.ORIGIN) return new Response('Not found', { status: 404 });
    const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Retry-After': '60' };
    if (env.MAINTENANCE === '1') return new Response('RegSched is completing a migration. Please try again shortly.', { status: 503, headers });
    if (env.MIGRATION_MODE === 'redirect') {
      const target = new URL(env.MIGRATION_TARGET ?? '');
      if (target.protocol !== 'https:' || target.origin !== env.MIGRATION_TARGET) throw new Error('Invalid migration target');
      if (!['GET', 'HEAD'].includes(request.method)) return Response.json({ error: 'site_moved', url: target.origin }, { status: 409, headers });
      const source = new URL(request.url);
      return new Response(null, { status: 307, headers: { ...headers, Location: target.origin + source.pathname + source.search } });
    }
    if (env.MIGRATION_MODE === 'freeze' && !['GET', 'HEAD'].includes(request.method)) return Response.json({ error: 'maintenance' }, { status: 503, headers });
    return app.fetch(request, await workerServices(env));
  },
  async scheduled(_controller: ScheduledController, env: WorkerBindings, ctx: ExecutionContext) {
    if (env.MAINTENANCE === '1' || env.MIGRATION_MODE) return;
    ctx.waitUntil((async () => {
      const services = await workerServices(env);
      const vault = await SourceVault.create(fromBase64(env.SOURCE_SECRET));
      const importer = new ImportService(env.DB, vault, services.FEED_TRANSPORT!);
      const result = await runBackground(env.DB, importer, new Date().toISOString(), { sources: 1, subscriptions: 1 });
      if (!result.skipped) await services.FEED_PUBLISHER!.flush(1);
    })());
  },
};
