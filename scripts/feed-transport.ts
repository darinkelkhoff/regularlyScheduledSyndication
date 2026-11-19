import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';
import { createFeedTransport, type Exchange } from '../src/importer/fetch.ts';
import { FeedError, MAX_FEED_BYTES } from '../src/importer/types.ts';
/** Resolving happens before connection; lookup returns only the already validated address. */
export const nodeExchange: Exchange = (url, address, headers, signal) => new Promise((resolve, reject) => {
  const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
    method: 'GET', headers, signal, agent: false,
    lookup: (_host, options, callback) => options.all ? callback(null, [address]) : callback(null, address.address, address.family),
  }, response => {
    const resultHeaders: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(response.headers)) if (typeof value === 'string') resultHeaders[key] = value;
    const status = response.statusCode ?? 0;
    if (status !== 200) { response.destroy(); resolve({ status, headers: resultHeaders, xml: '' }); return; }
    if (Number(response.headers['content-length']) > MAX_FEED_BYTES) { response.destroy(); reject(new FeedError('feed_too_large')); return; }
    const encoding = response.headers['content-encoding']?.toLowerCase();
    if (encoding && !['identity', 'gzip', 'deflate', 'br'].includes(encoding)) { response.destroy(); reject(new FeedError('unsupported_feed_encoding')); return; }
    const decoder = encoding === 'gzip' ? createGunzip() : encoding === 'deflate' ? createInflate() : encoding === 'br' ? createBrotliDecompress() : null;
    const stream = decoder ? response.pipe(decoder) : response;
    const chunks: Buffer[] = []; let bytes = 0; let wireBytes = 0;
    const fail = (error: Error) => { response.destroy(); decoder?.destroy(); reject(error); };
    response.on('data', chunk => { wireBytes += chunk.length; if (wireBytes > MAX_FEED_BYTES) fail(new FeedError('feed_too_large')); });
    stream.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > MAX_FEED_BYTES) fail(new FeedError('feed_too_large')); else chunks.push(chunk); });
    stream.on('end', () => {
      const buffer = Buffer.concat(chunks);
      try {
        const declaration = buffer.subarray(0, 200).toString('ascii').match(/encoding=["']([^"']+)/i)?.[1];
        const charset = response.headers['content-type']?.match(/charset=["']?([^;"'\s]+)/i)?.[1] ?? declaration ?? 'utf-8';
        resolve({ status, headers: resultHeaders, xml: new TextDecoder(charset, { fatal: true }).decode(buffer) });
      } catch { reject(new FeedError('unsupported_feed_encoding')); }
    });
    response.on('error', () => fail(new FeedError('feed_fetch_failed')));
    if (decoder) decoder.on('error', () => fail(new FeedError('feed_fetch_failed')));
  });
  request.on('error', () => reject(new FeedError(signal.aborted ? 'feed_timeout' : 'feed_fetch_failed')));
  request.end();
});
export const fetchFeed = createFeedTransport(async hostname => isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : lookup(hostname, { all: true, verbatim: true }), nodeExchange);
