import type { EpisodeMetadata, ShowMetadata } from '../importer/types.ts';
export type FeedEpisode = { title: string; guid: string; deliveredAt: string; publishedAt: string; metadata: EpisodeMetadata };
function escape(value: string): string {
  return value.replace(/[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu, '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}
const tag = (name: string, value: string | undefined) => value ? `<${name}>${escape(value)}</${name}>` : '';
export function renderRss(show: { title: string; metadata: ShowMetadata }, episodes: readonly FeedEpisode[]): string {
  const metadata = show.metadata;
  const items = episodes.map(episode => {
    const m = episode.metadata;
    const original = new Date(episode.publishedAt).getTime() === 0 ? 'Original publication date unavailable.' : `Originally published: ${episode.publishedAt.slice(0, 10)}`;
    return `<item>${tag('title', episode.title)}<guid isPermaLink="false">${escape(episode.guid)}</guid>${tag('pubDate', new Date(episode.deliveredAt).toUTCString())}${tag('description', `${m.description}\n<p>${original}</p>`)}<enclosure url="${escape(m.enclosure.url)}" type="${escape(m.enclosure.type)}" length="${escape(m.enclosure.length)}"/>${tag('link', m.link)}${tag('itunes:episode', m.episode)}${tag('itunes:season', m.season)}${tag('itunes:duration', m.duration)}${tag('itunes:explicit', m.explicit)}${m.image ? `<itunes:image href="${escape(m.image)}"/>` : ''}</item>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"><channel>${tag('title', show.title)}${tag('link', metadata.link ?? 'https://regsched.com/')}${tag('description', metadata.description || show.title)}${tag('itunes:author', metadata.author)}${tag('itunes:explicit', metadata.explicit)}${metadata.image ? `<itunes:image href="${escape(metadata.image)}"/>` : ''}\n${items}\n</channel></rss>`;
}
