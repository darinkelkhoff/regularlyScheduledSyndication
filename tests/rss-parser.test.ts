import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parsePodcast } from '../src/importer/parse.ts';
const fixture = await readFile(new URL('./fixtures/podcast.xml', import.meta.url), 'utf8');
test('parses namespaced podcast metadata, sanitizes HTML and preserves original episode numbers', async () => {
  const feed = await parsePodcast(fixture);
  assert.equal(feed.title, 'Signal Paths');
  assert.equal(feed.episodes.length, 2);
  assert.equal(feed.episodes[0]?.metadata.episode, '42');
  assert.equal(feed.episodes[0]?.metadata.enclosure.url, 'https://audio.example/two.mp3?token=private');
  assert.equal(feed.episodes[0]?.metadata.enclosure.length, '12345');
  assert.equal(feed.episodes[0]?.metadata.duration, '01:02:03');
  assert.ok(!feed.episodes[0]?.metadata.description.includes('<script'));
  assert.ok(!feed.episodes[0]?.metadata.description.includes('onerror'));
  assert.ok(!feed.episodes[1]?.metadata.description.includes('javascript:'));
});
test('GUID identity survives metadata edits; enclosure fallback ignores publication dates', async () => {
  const first = await parsePodcast(fixture);
  const edited = await parsePodcast(fixture.replace('The second connection', 'Updated title').replace('09 Jan 2024', '10 Jan 2024'));
  assert.equal(first.episodes[0]?.id, edited.episodes[0]?.id);
  const noGuid = fixture.replace(/<guid[^>]*>.*?<\/guid>/g, '');
  assert.equal((await parsePodcast(noGuid)).episodes[0]?.id, (await parsePodcast(noGuid.replace('09 Jan 2024', '11 Jan 2024'))).episodes[0]?.id);
});
test('rejects unsafe XML and unusable feeds without echoing source content', async () => {
  for (const xml of [
    '<!DOCTYPE rss [<!ENTITY x SYSTEM "file:///etc/passwd">]><rss><channel><title>&x;</title></channel></rss>',
    '<rss><channel><title>broken</channel></rss>', '<html><body>Not RSS</body></html>',
    '<rss><channel>' + '<x>'.repeat(40) + '</x>'.repeat(40) + '</channel></rss>',
    fixture.replace('episode-one', 'episode-two'), fixture.replace('https://audio.example/one.mp3', 'javascript:alert(1)'),
  ]) await assert.rejects(parsePodcast(xml));
  await assert.rejects(parsePodcast('x'.repeat(8 * 1024 * 1024 + 1)));
});
test('missing original dates are deterministic and do not use import time', async () => {
  const feed = await parsePodcast(fixture.replace(/<pubDate>.*?<\/pubDate>/g, ''));
  assert.equal(feed.episodes[0]?.publishedAt, '1970-01-01T00:00:00.000Z');
  assert.equal(feed.episodes[0]?.metadata.undated, true);
});
test('decoded title entities remain human-readable plain text', async () => {
  const feed = await parsePodcast(fixture.replace('Signal Paths', 'Rock &amp; Roll'));
  assert.equal(feed.title, 'Rock & Roll');
});
test('accepts 2000 episodes and rejects feeds above that limit', async () => {
  const feed = (count: number) => `<rss version="2.0"><channel><title>Large archive</title>${Array.from({ length: count }, (_, i) => `<item><guid>episode-${i}</guid><title>Episode ${i}</title><enclosure url="https://audio.example/${i}.mp3" type="audio/mpeg" length="10"/></item>`).join('')}</channel></rss>`;
  assert.equal((await parsePodcast(feed(2000), 'https://podcast.example/feed')).episodes.length, 2000);
  await assert.rejects(parsePodcast(feed(2001), 'https://podcast.example/feed'), { code: 'too_many_episodes' });
});

test('relative media never inherits source authentication and explicit media credentials are rejected', async () => {
  const xml = `<rss xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"><channel><title>Relative media</title><link>/show</link><itunes:image href="/cover.png"/><item><title>One</title><enclosure url="/one.mp3"/><link>/one</link><itunes:image href="/one.png"/></item></channel></rss>`;
  const feed = await parsePodcast(xml, 'https://source-user:source-password@example.com/feed?secret=source');
  assert.equal(feed.metadata.image, 'https://example.com/cover.png');
  assert.equal(feed.metadata.link, 'https://example.com/show');
  assert.equal(feed.episodes[0]!.metadata.enclosure.url, 'https://example.com/one.mp3');
  assert.equal(feed.episodes[0]!.metadata.link, 'https://example.com/one');
  assert.equal(feed.episodes[0]!.metadata.image, 'https://example.com/one.png');
  await assert.rejects(parsePodcast(xml.replace('/one.mp3', 'https://user:password@example.com/one.mp3')), { code: 'invalid_media_url' });
});
