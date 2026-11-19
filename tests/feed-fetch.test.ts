import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertPublicUrl, publicAddress } from '../src/importer/url-policy.ts';
import { createFeedTransport } from '../src/importer/fetch.ts';
test('rejects private, encoded, mapped, reserved and non-HTTP destinations', () => {
  for (const value of ['http://localhost/feed', 'http://127.1/', 'http://0x7f000001/', 'http://2130706433/', 'http://[::1]/', 'http://[::ffff:192.168.1.1]/', 'http://169.254.169.254/', 'http://10.0.0.1/', 'http://100.64.0.1/', 'https://host.internal/', 'file:///etc/passwd', 'https://public.example:22/']) assert.throws(() => assertPublicUrl(value));
  for (const address of ['192.168.0.1', '172.16.0.1', '0.0.0.0', '198.51.100.1', '224.0.0.1', 'fc00::1', 'fe80::1', '2001:db8::1', '::ffff:127.0.0.1']) assert.equal(publicAddress(address), false);
  assert.equal(publicAddress('93.184.216.34'), true);
  assert.equal(assertPublicUrl('https://member:secret@podcast.example/feed').hostname, 'podcast.example');
});
test('rejects private DNS answers and revalidates redirects before any second request', async () => {
  let requests = 0;
  const mixed = createFeedTransport(async () => [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }], async () => { requests++; return { status: 200, headers: {}, xml: '<rss/>' }; });
  await assert.rejects(mixed('https://podcast.example/feed')); assert.equal(requests, 0);
  const redirected = createFeedTransport(async () => [{ address: '93.184.216.34', family: 4 }], async () => { requests++; return { status: 302, headers: { location: 'http://127.0.0.1/internal' }, xml: '' }; });
  await assert.rejects(redirected('https://podcast.example/feed')); assert.equal(requests, 1);
});
test('pins validated DNS results, strips validators across origins and bounds redirects', async () => {
  const calls: { hostname: string; address: string; etag?: string }[] = [];
  const fetch = createFeedTransport(async () => [{ address: '93.184.216.34', family: 4 }], async (url, address, headers) => {
    calls.push({ hostname: url.hostname, address: address.address, etag: headers['if-none-match'] });
    return calls.length === 1 ? { status: 301, headers: { location: 'https://cdn.example/feed' }, xml: '' } : { status: 200, headers: { etag: 'new' }, xml: '<rss/>' };
  });
  assert.equal((await fetch('https://podcast.example/feed', { etag: 'private-validator' })).etag, 'new');
  assert.deepEqual(calls, [{ hostname: 'podcast.example', address: '93.184.216.34', etag: 'private-validator' }, { hostname: 'cdn.example', address: '93.184.216.34', etag: undefined }]);
  let count = 0;
  const loop = createFeedTransport(async () => [{ address: '93.184.216.34', family: 4 }], async () => { count++; return { status: 302, headers: { location: '/again' }, xml: '' }; });
  await assert.rejects(loop('https://podcast.example/feed')); assert.equal(count, 6);
});
test('rejects downgrade redirects and private DNS on later hops', async () => {
  for (const destination of ['http://podcast.example/feed', 'https://private.example/feed']) {
    let count = 0;
    const fetch = createFeedTransport(async host => [{ address: host === 'private.example' ? '10.0.0.1' : '93.184.216.34', family: 4 }], async () => { count++; return { status: 302, headers: { location: destination }, xml: '' }; });
    await assert.rejects(fetch('https://podcast.example/feed')); assert.equal(count, 1);
  }
});
