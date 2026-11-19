import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SaxesParser } from 'saxes';
import { renderRss } from '../src/publishing/rss.ts';
const show = { title: 'A & B', metadata: { description: '<p>A show</p>', image: 'https://example.com/cover.jpg' } };
const episode = { title: 'One < two', guid: 'saved-guid', deliveredAt: '2026-10-27T12:00:00Z', publishedAt: '2020-01-01T00:00:00Z', metadata: { description: '<p>Hello & goodbye</p>', enclosure: { url: 'https://example.com/audio?x=1&y=2', type: 'audio/mpeg', length: '100' }, episode: '41', season: '2', duration: '01:02:03' } };
test('RSS preserves artwork, audio metadata and committed release identity and time', () => {
  const xml = renderRss(show, [episode]);
  new SaxesParser({ xmlns: true }).write(xml).close();
  assert.ok(xml.includes('<title>A &amp; B</title>'));
  assert.ok(xml.includes('<title>One &lt; two</title>'));
  assert.ok(xml.includes('<guid isPermaLink="false">saved-guid</guid>'));
  assert.ok(xml.includes('<pubDate>Tue, 27 Oct 2026 12:00:00 GMT</pubDate>'));
  assert.ok(xml.includes('x=1&amp;y=2'));
  assert.ok(xml.includes('<itunes:episode>41</itunes:episode>'));
  assert.ok(xml.includes('https://example.com/cover.jpg'));
  assert.ok(xml.includes('Originally published: 2020-01-01'));
  assert.equal(renderRss(show, [episode]), xml);
});
test('an empty delivery history produces a valid empty feed', () => {
  const xml = renderRss(show, []);
  new SaxesParser({ xmlns: true }).write(xml).close();
  assert.ok(!xml.includes('<item>'));
});
test('untrusted text cannot introduce XML elements or invalid control characters', () => {
  const xml = renderRss({ title: 'Bad\u0000 title </title><script/>', metadata: { description: ']]>' } }, []);
  new SaxesParser({ xmlns: true }).write(xml).close();
  assert.ok(!xml.includes('<script/>'));
  assert.ok(!xml.includes('\u0000'));
});
