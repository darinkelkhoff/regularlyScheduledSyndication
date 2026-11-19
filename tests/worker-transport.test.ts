import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workerTransport } from '../src/importer/worker-transport.ts';
function transport(handler: (url: URL, init: RequestInit) => Promise<Response> | Response, addresses = ['93.184.216.34'], timeoutMs = 1000) {
  return workerTransport((async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === 'cloudflare-dns.com') return Response.json({ Status: 0, Answer: addresses.map(data => ({ type: data.includes(':') ? 28 : 1, data })) });
    return handler(url, init!);
  }) as typeof fetch, timeoutMs);
}
test('Worker transport validates DNS, bounds redirects, and drops credentials and validators across origins', async () => {
  const calls: { url: URL; headers: Headers }[] = [];
  const fetchFeed = transport((url, init) => {
    calls.push({ url, headers: new Headers(init.headers) });
    if (calls.length === 1) return new Response(null, { status: 302, headers: { location: 'https://cdn.example/feed' } });
    return new Response('<rss/>', { headers: { etag: 'new' } });
  });
  assert.equal((await fetchFeed('https://user:secret@podcast.example/rss', { etag: 'old' })).xml, '<rss/>');
  assert.ok(calls[0]!.headers.get('authorization'));
  assert.equal(calls[0]!.url.username, '');
  assert.equal(calls[0]!.headers.get('if-none-match'), 'old');
  assert.equal(calls[1]!.headers.get('authorization'), null);
  assert.equal(calls[1]!.headers.get('if-none-match'), null);
});
test('Worker transport blocks private, mapped-private, empty DNS and private redirect destinations', async () => {
  for (const addresses of [['127.0.0.1'], ['::ffff:127.0.0.1'], [], ['93.184.216.34', '10.0.0.1']]) {
    let called = false;
    await assert.rejects(transport(() => { called = true; return new Response(''); }, addresses)('https://podcast.example/feed'), { code: 'blocked_feed_address' });
    assert.equal(called, false);
  }
  await assert.rejects(transport(() => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/' } }))('https://podcast.example/feed'), { code: 'blocked_feed_address' });
  await assert.rejects(transport(() => new Response(null, { status: 302, headers: { location: 'http://podcast.example/' } }))('https://podcast.example/feed'), { code: 'unsafe_feed_redirect' });
});
test('Worker transport handles not-modified, rejects excessive bodies and stops redirect loops', async () => {
  assert.equal((await transport(() => new Response(null, { status: 304 }))('https://podcast.example/rss')).status, 304);
  await assert.rejects(transport(() => new Response('x', { headers: { 'content-length': '9000000' } }))('https://podcast.example/rss'), { code: 'feed_too_large' });
  await assert.rejects(transport(() => new Response('x'.repeat(8 * 1024 * 1024 + 1)))('https://podcast.example/rss'), { code: 'feed_too_large' });
  let calls = 0;
  await assert.rejects(transport(() => { calls++; return new Response(null, { status: 302, headers: { location: '/rss' } }); })('https://podcast.example/rss'), { code: 'too_many_redirects' });
  assert.equal(calls, 6);
});
test('Worker transport times out stalled requests without forwarding error details', async () => {
  await assert.rejects(transport((_url, init) => new Promise((_resolve, reject) => {
    init.signal!.addEventListener('abort', () => reject(new Error('upstream secret')), { once: true });
  }), undefined, 10)('https://podcast.example/rss'), { code: 'feed_timeout', message: 'feed_timeout' });
});
