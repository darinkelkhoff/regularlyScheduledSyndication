import ipaddr from 'ipaddr.js';
import { FeedError } from './types.ts';
export function publicAddress(address: string): boolean {
  try { return ipaddr.process(address).range() === 'unicast'; } catch { return false; }
}
export function assertPublicUrl(input: string): URL {
  let url: URL;
  try { url = new URL(input); } catch { throw new FeedError('invalid_feed_url'); }
  if (input.length > 8192 || !['http:', 'https:'].includes(url.protocol) || (url.port && !['80', '443'].includes(url.port))) throw new FeedError('unsupported_feed_url');
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (ipaddr.isValid(host)) { if (!publicAddress(host)) throw new FeedError('blocked_feed_address'); }
  else if (!host.includes('.') || /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(host) || host.endsWith('.home.arpa')) throw new FeedError('blocked_feed_address');
  url.hash = '';
  return url;
}
