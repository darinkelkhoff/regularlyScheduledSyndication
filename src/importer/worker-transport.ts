import { assertPublicUrl, publicAddress } from './url-policy.ts';
import { FeedError, MAX_FEED_BYTES, type FeedTransport, type Validators } from './types.ts';

type Fetch = typeof fetch;
/** Cloudflare public-egress adapter. DNS inspection is defense in depth, not socket pinning. */
export function workerTransport(fetcher: Fetch = fetch, timeoutMs = 15_000): FeedTransport {
  return async (input: string, validators: Validators = {}) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const request = (url: string, init: RequestInit) => fetcher(url, { ...init, signal: controller.signal, redirect: 'manual' });
    try {
      const original = assertPublicUrl(input); let url = original;
      for (let redirects = 0; redirects <= 5; redirects++) {
        const host = url.hostname.replace(/^\[|\]$/g, '');
        /////////////////////////////////////////////////////////////////////////////////////////////////
        // Public DNS answers are checked on every hop; the Workers public fetch layer resolves again. //
        /////////////////////////////////////////////////////////////////////////////////////////////////
        if (!/^\d+\.\d+\.\d+\.\d+$/.test(host) && !host.includes(':')) {
          let addresses = 0;
          for (const type of ['A', 'AAAA']) {
            const dnsUrl = new URL('https://cloudflare-dns.com/dns-query');
            dnsUrl.searchParams.set('name', host); dnsUrl.searchParams.set('type', type);
            const dns = await request(dnsUrl.href, { headers: { accept: 'application/dns-json' } });
            if (!dns.ok) throw new FeedError('feed_fetch_failed');
            const data = await dns.json() as { Status?: number; Answer?: { type: number; data: string }[] };
            if (data.Status !== 0 || (data.Answer?.length ?? 0) > 32) throw new FeedError('blocked_feed_address');
            for (const answer of data.Answer ?? []) if ([1, 28].includes(answer.type)) { addresses++; if (!publicAddress(answer.data)) throw new FeedError('blocked_feed_address'); }
          }
          if (!addresses) throw new FeedError('blocked_feed_address');
        }
        const headers: Record<string, string> = { accept: 'application/rss+xml,application/xml,text/xml;q=0.9', 'accept-encoding': 'identity', 'user-agent': 'RegSched/1.0' };
        if (url.origin === original.origin) {
          if (validators.etag && validators.etag.length <= 2048) headers['if-none-match'] = validators.etag;
          if (validators.lastModified && validators.lastModified.length <= 2048) headers['if-modified-since'] = validators.lastModified;
        }
        const target = new URL(url);
        if (target.username || target.password) {
          headers.authorization = 'Basic ' + btoa(decodeURIComponent(target.username) + ':' + decodeURIComponent(target.password));
          target.username = ''; target.password = '';
        }
        const response = await request(target.href, { headers, cache: 'no-store' });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          await response.body?.cancel();
          const location = response.headers.get('location');
          if (!location || redirects === 5) throw new FeedError('too_many_redirects');
          const next = assertPublicUrl(new URL(location, url).href);
          if (url.protocol === 'https:' && next.protocol !== 'https:') throw new FeedError('unsafe_feed_redirect');
          if (next.origin !== url.origin && (next.username || next.password)) throw new FeedError('unsafe_feed_redirect');
          if (next.origin === url.origin && !next.username && !next.password) { next.username = url.username; next.password = url.password; }
          url = next; continue;
        }
        const etag = response.headers.get('etag')?.slice(0, 2048); const lastModified = response.headers.get('last-modified')?.slice(0, 2048);
        if (response.status === 304) { await response.body?.cancel(); return { status: 304, etag, lastModified, finalUrl: url.href }; }
        if (response.status !== 200) { await response.body?.cancel(); throw new FeedError('feed_http_error'); }
        if (Number(response.headers.get('content-length')) > MAX_FEED_BYTES) { await response.body?.cancel(); throw new FeedError('feed_too_large'); }
        const reader = response.body?.getReader();
        if (!reader) throw new FeedError('no_episodes');
        const chunks: Uint8Array[] = []; let length = 0;
        try {
          while (true) {
            const { done, value } = await reader.read(); if (done) break;
            length += value.byteLength;
            if (length > MAX_FEED_BYTES) throw new FeedError('feed_too_large');
            chunks.push(value);
          }
        } finally { await reader.cancel().catch(() => {}); }
        const bytes = new Uint8Array(length); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        const declaration = new TextDecoder().decode(bytes.subarray(0, 200)).match(/encoding=["']([^"']+)/i)?.[1];
        const charset = response.headers.get('content-type')?.match(/charset=["']?([^;"'\s]+)/i)?.[1] ?? declaration ?? 'utf-8';
        let xml: string;
        try { xml = new TextDecoder(charset, { fatal: true }).decode(bytes); } catch { throw new FeedError('unsupported_feed_encoding'); }
        return { status: 200, xml, etag, lastModified, finalUrl: url.href };
      }
      throw new FeedError('too_many_redirects');
    } catch (error) { throw error instanceof FeedError ? error : new FeedError(controller.signal.aborted ? 'feed_timeout' : 'feed_fetch_failed'); }
    finally { clearTimeout(timer); }
  };
}
