import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';
import { nodeExchange, fetchFeed } from '../scripts/feed-transport.ts';
import { MAX_FEED_BYTES } from '../src/importer/types.ts';
test('node adapter uses the pinned address while retaining the intended HTTP host', async t => {
  let host = '';
  const server = createServer((request, response) => { host = request.headers.host ?? ''; response.setHeader('Content-Type', 'application/rss+xml'); response.end('<rss/>'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const port = (server.address() as { port: number }).port;
  const result = await nodeExchange(new URL(`http://unresolvable.podcast.example:${port}/feed`), { address: '127.0.0.1', family: 4 }, {}, AbortSignal.timeout(1000));
  assert.equal(result.xml, '<rss/>'); assert.equal(host, `unresolvable.podcast.example:${port}`);
  await assert.rejects(fetchFeed(`http://127.0.0.1:${port}/feed`));
});
test('node adapter bounds decompressed data and aborts stalled responses', async t => {
  const compressed = gzipSync(Buffer.alloc(MAX_FEED_BYTES + 1, 120));
  const server = createServer((request, response) => { if (request.url === '/slow') return; response.setHeader('Content-Encoding', 'gzip'); response.end(compressed); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const port = (server.address() as { port: number }).port;
  await assert.rejects(nodeExchange(new URL(`http://podcast.example:${port}/large`), { address: '127.0.0.1', family: 4 }, {}, AbortSignal.timeout(2000)), /feed_too_large/);
  await assert.rejects(nodeExchange(new URL(`http://podcast.example:${port}/slow`), { address: '127.0.0.1', family: 4 }, {}, AbortSignal.timeout(50)), /feed_timeout/);
});
