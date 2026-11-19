import { assertPublicUrl, publicAddress } from './url-policy.ts';
import { FeedError, MAX_FEED_BYTES, type FeedTransport } from './types.ts';
export type Address = { address: string; family: number };
export type RawResponse = { status: number; headers: Record<string, string | undefined>; xml: string };
export type Resolve = (hostname: string) => Promise<Address[]>;
export type Exchange = (url: URL, address: Address, headers: Record<string, string>, signal: AbortSignal) => Promise<RawResponse>;
function bounded<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new FeedError('feed_timeout'));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
export function createFeedTransport(resolve: Resolve, exchange: Exchange, timeoutMs = 15_000): FeedTransport {
  return async (input, validators = {}) => {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const original = assertPublicUrl(input); let url = original;
      for (let redirects = 0; redirects <= 5; redirects++) {
        const addresses = await bounded(resolve(url.hostname.replace(/^\[|\]$/g, '')), controller.signal);
        if (!addresses.length || addresses.length > 32 || addresses.some(address => !publicAddress(address.address))) throw new FeedError('blocked_feed_address');
        const headers: Record<string, string> = { accept: 'application/rss+xml, application/xml, text/xml;q=0.9', 'accept-encoding': 'identity', 'user-agent': 'RegSched/1.0' };
        if (url.origin === original.origin) {
          if (validators.etag && validators.etag.length <= 2048) headers['if-none-match'] = validators.etag;
          if (validators.lastModified && validators.lastModified.length <= 2048) headers['if-modified-since'] = validators.lastModified;
        }
        const response = await bounded(exchange(url, addresses[0]!, headers, controller.signal), controller.signal);
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          if (redirects === 5 || !response.headers.location) throw new FeedError('too_many_redirects');
          const next = assertPublicUrl(new URL(response.headers.location, url).href);
          if ((url.protocol === 'https:' && next.protocol !== 'https:') || (next.origin !== url.origin && (next.username || next.password))) throw new FeedError('unsafe_feed_redirect');
          if (next.origin === url.origin && !next.username && !next.password) { next.username = url.username; next.password = url.password; }
          url = next; continue;
        }
        const etag = response.headers.etag?.slice(0, 2048); const lastModified = response.headers['last-modified']?.slice(0, 2048);
        if (response.status === 304) return { status: 304, etag, lastModified, finalUrl: url.href };
        if (response.status !== 200) throw new FeedError('feed_http_error');
        if (new TextEncoder().encode(response.xml).length > MAX_FEED_BYTES) throw new FeedError('feed_too_large');
        return { status: 200, xml: response.xml, etag, lastModified, finalUrl: url.href };
      }
      throw new FeedError('too_many_redirects');
    } catch (error) { throw error instanceof FeedError ? error : new FeedError(controller.signal.aborted ? 'feed_timeout' : 'feed_fetch_failed'); }
    finally { clearTimeout(timer); }
  };
}
