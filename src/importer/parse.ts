import { decodeHTML } from 'entities';
import { SaxesParser } from 'saxes';
import sanitizeHtml from 'sanitize-html';
import { hashToken } from '../auth/tokens.ts';
import { FeedError, MAX_FEED_BYTES, MAX_EPISODES, type ParsedPodcast, type EpisodeMetadata } from './types.ts';
type Node = { name: string; uri: string; text: string; attributes: Record<string, string>; children: Node[] };
const ITUNES = 'http://www.itunes.com/dtds/podcast-1.0.dtd';
const CONTENT = 'http://purl.org/rss/1.0/modules/content/';
const child = (node: Node, name: string, uri = '') => node.children.find(n => n.name === name && n.uri === uri);
const text = (node?: Node): string => node ? node.text + node.children.map(text).join('') : '';
const field = (node: Node, name: string, uri = '') => text(child(node, name, uri)).trim();
const plain = (value: string) => decodeHTML(sanitizeHtml(value, { allowedTags: [], allowedAttributes: {} })).trim();
const html = (value: string) => sanitizeHtml(value, { allowedTags: ['p', 'br', 'em', 'strong', 'a', 'ul', 'ol', 'li', 'blockquote', 'code', 'pre'], allowedAttributes: { a: ['href', 'title'] }, allowedSchemes: ['http', 'https', 'mailto'], allowProtocolRelative: false });
function mediaUrl(value: string, base?: string): string | undefined {
  if (!value) return undefined;
  try {
    const resolutionBase = base ? new URL(base) : undefined;
    if (resolutionBase) { resolutionBase.username = ''; resolutionBase.password = ''; }
    const url = new URL(value, resolutionBase);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error();
    return url.href;
  }
  catch { throw new FeedError('invalid_media_url'); }
}
export async function parsePodcast(xml: string, base?: string): Promise<ParsedPodcast> {
  if (new TextEncoder().encode(xml).length > MAX_FEED_BYTES) throw new FeedError('feed_too_large');
  const stack: Node[] = []; let root: Node | undefined; let nodes = 0;
  const parser = new SaxesParser({ xmlns: true });
  parser.on('doctype', () => { throw new FeedError('unsafe_xml'); });
  parser.on('error', () => { throw new FeedError('invalid_xml'); });
  parser.on('opentag', tag => {
    if (stack.length >= 32 || ++nodes > 150_000) throw new FeedError('xml_too_complex');
    const attributes: Record<string, string> = {};
    for (const attr of Object.values(tag.attributes)) { if (attr.value.length > 16_384) throw new FeedError('xml_too_complex'); if (!attr.uri) attributes[attr.local] = attr.value; }
    const node: Node = { name: tag.local, uri: tag.uri, attributes, children: [], text: '' };
    if (stack.length) stack.at(-1)!.children.push(node); else root = node;
    stack.push(node);
  });
  const append = (value: string) => { if (stack.length) { const node = stack.at(-1)!; node.text += value; if (node.text.length > 512_000) throw new FeedError('xml_too_complex'); } };
  parser.on('text', append); parser.on('cdata', append); parser.on('closetag', () => { stack.pop(); });
  try { parser.write(xml).close(); } catch (error) { throw error instanceof FeedError ? error : new FeedError('invalid_xml'); }
  if (!root || root.name !== 'rss' || root.uri) throw new FeedError('unsupported_feed');
  const channel = child(root, 'channel');
  if (!channel || !field(channel, 'title')) throw new FeedError('invalid_feed');
  const items = channel.children.filter(node => node.name === 'item' && !node.uri);
  if (!items.length) throw new FeedError('no_episodes');
  if (items.length > MAX_EPISODES) throw new FeedError('too_many_episodes');
  const identities = new Set<string>();
  const episodes = await Promise.all(items.map(async item => {
    const title = plain(field(item, 'title')) || 'Untitled episode';
    const enclosure = child(item, 'enclosure');
    if (!enclosure?.attributes.url) throw new FeedError('missing_enclosure');
    const url = mediaUrl(enclosure.attributes.url, base)!;
    const rawDate = field(item, 'pubDate');
    const milliseconds = rawDate ? Date.parse(rawDate) : 0;
    if (!Number.isFinite(milliseconds)) throw new FeedError('invalid_episode_date');
    const publishedAt = new Date(milliseconds).toISOString();
    const guid = field(item, 'guid'); const link = mediaUrl(field(item, 'link'), base);
    const identity = guid ? ['guid', guid] : ['enclosure', url];
    const id = identity[0] + ':' + await hashToken(JSON.stringify(identity.slice(1)));
    if (identities.has(id)) throw new FeedError('duplicate_episode_identity');
    identities.add(id);
    const length = enclosure.attributes.length ?? '0';
    if (!/^\d{1,20}$/.test(length)) throw new FeedError('invalid_enclosure');
    const type = enclosure.attributes.type || 'audio/mpeg';
    if (!/^[\w.+-]+\/[\w.+-]+$/.test(type)) throw new FeedError('invalid_enclosure');
    const metadata: EpisodeMetadata = {
      description: html(field(item, 'encoded', CONTENT) || field(item, 'description')),
      enclosure: { url, type, length },
      ...(rawDate ? {} : { undated: true }), ...(link ? { link } : {}),
    };
    for (const key of ['episode', 'season', 'duration', 'explicit'] as const) { const value = field(item, key, ITUNES); if (value) metadata[key] = plain(value); }
    const image = mediaUrl(child(item, 'image', ITUNES)?.attributes.href ?? '', base); if (image) metadata.image = image;
    return { id, title, publishedAt, metadata };
  }));
  const image = mediaUrl(child(channel, 'image', ITUNES)?.attributes.href || (child(channel, 'image') ? field(child(channel, 'image')!, 'url') : ''), base);
  const link = mediaUrl(field(channel, 'link'), base);
  return { title: plain(field(channel, 'title')).slice(0, 300), metadata: { description: html(field(channel, 'description')), author: plain(field(channel, 'author', ITUNES)), explicit: plain(field(channel, 'explicit', ITUNES)), ...(image ? { image } : {}), ...(link ? { link } : {}) }, episodes };
}
