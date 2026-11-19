import { rm, readFile, copyFile } from 'node:fs/promises';
import { build } from 'esbuild';
await rm('.local/browser-tests', { recursive: true, force: true });
await build({ entryPoints: ['src/client/main.tsx'], loader: { '.svg': 'dataurl', '.png': 'file' }, publicPath: '/assets', assetNames: '[name]-[hash]', bundle: true, outfile: 'dist/public/assets/app.js', format: 'esm', platform: 'browser', target: 'es2023', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, minify: true });
await copyFile('src/client/assets/regsched-hourglass.png', 'dist/public/assets/favicon.png');
process.env.REGSCHED_PORT = '8788';
process.env.REGSCHED_DATA_DIR = '.local/browser-tests';
const { startLocalServer } = await import('./dev.ts');
const { sampleEpisodes } = await import('../src/http/podcasts.ts');
const selectionXml = `<rss version="2.0"><channel><title>Small Hours</title><link>https://selection.example</link><description>Browser selection fixture</description>${sampleEpisodes.map((episode, i) => `<item><guid>${episode.id}</guid><title>${episode.title}</title><pubDate>${new Date(episode.publishedAt).toUTCString()}</pubDate><enclosure url="https://selection.example/${i}.mp3" type="audio/mpeg" length="1000"/></item>`).join('')}</channel></rss>`;
const xml = await readFile(new URL('../tests/fixtures/podcast.xml', import.meta.url), 'utf8').then(xml => xml.replace('<channel>', '<channel><image><url>https://cdn.example/cover.svg</url></image>'));
await startLocalServer(async url => {
  if (url === 'https://selection.example/feed') return { status: 200, xml: selectionXml, etag: 'selection-fixture' };
  if (url !== 'https://podcast.example/feed') throw new Error('Unknown browser test fixture');
  return { status: 200, xml, etag: 'browser-fixture' };
});
