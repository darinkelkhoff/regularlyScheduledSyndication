import { LocalPublisher } from '../src/publishing/local-publisher.ts';
import { runBackground } from '../src/jobs/background.ts';
import { ImportService } from '../src/importer/service.ts';
import { SourceVault } from '../src/security/source-vault.ts';
import { fromBase64 } from '../src/auth/tokens.ts';
import { fetchFeed } from './feed-transport.ts';
import type { FeedTransport } from '../src/importer/types.ts';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { localDatabase } from './local-database.ts';
import { app, type AppBindings } from '../src/http/app.ts';
import { randomToken } from '../src/auth/tokens.ts';

export async function startLocalServer(feedTransport: FeedTransport = fetchFeed) {
const port = Number(process.env.REGSCHED_PORT ?? '8787');
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid REGSCHED_PORT');
const directory = resolve(process.env.REGSCHED_DATA_DIR ?? '.local');
await mkdir(directory, { recursive: true, mode: 0o700 });
const configPath = resolve(directory, 'dev-config.json');
try {
  await writeFile(configPath, JSON.stringify({ adminSetupSecret: randomToken() }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
} catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
const config = JSON.parse(await readFile(configPath, 'utf8')) as { adminSetupSecret: string; sourceSecret?: string };
if (typeof config.adminSetupSecret !== 'string' || config.adminSetupSecret.length < 32) throw new Error('Invalid local setup secret');
if (!config.sourceSecret) { config.sourceSecret = randomToken(); await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 }); }
const { runtime, db, bucket } = await localDatabase(resolve(directory, 'd1'));
const vault = await SourceVault.create(fromBase64(config.sourceSecret));
const publisher = new LocalPublisher(db, vault, bucket);
const bindings: AppBindings = {
  DB: db, ORIGIN: `http://localhost:${port}`, RP_ID: 'localhost', RP_NAME: 'RegSched',
  FEED_PUBLISHER: publisher, BACKGROUND_PROCESSING: '1', FEED_TRANSPORT: feedTransport, ADMIN_SETUP_SECRET: config.adminSetupSecret, LOCAL_PREVIEW: '1', SOURCE_SECRET: config.sourceSecret,
  ASSETS: { async fetch(request) {
    const path = new URL(request.url).pathname;
    if (!['/assets/app.js', '/assets/app.css', '/assets/favicon.png'].includes(path) && !/^\/assets\/regsched-hourglass-[A-Z0-9]+\.png$/.test(path)) return new Response('Not found', { status: 404 });
    try { const contents = await readFile(resolve('dist/public' + path)); return new Response(contents, { headers: { 'Content-Type': path.endsWith('.png') ? 'image/png' : path.endsWith('.css') ? 'text/css' : 'text/javascript', 'Cache-Control': 'no-cache' } }); }
    catch { return new Response('Not found', { status: 404 }); }
  } },
};
const server = serve({ hostname: '127.0.0.1', port, fetch: request => app.fetch(request, bindings) }, () => {
  console.log(`RegSched API: http://localhost:${port}`);
  console.log('Local data and the one-time administrator setup secret are in .local/.');
});
const importer = new ImportService(db, vault, feedTransport);
let active: Promise<void> | null = null;
function tick() {
  if (active) return;
  active = runBackground(db, importer).then(() => publisher.flush()).catch(() => { console.warn('Local background processing failed; will retry.'); }).finally(() => { active = null; });
}
const timer = setInterval(tick, 60_000); timer.unref(); tick();
async function stop() { clearInterval(timer); server.close(); await active; await runtime.dispose(); process.exit(0); }
process.once('SIGINT', stop); process.once('SIGTERM', stop);

return { server, runtime };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await startLocalServer();
