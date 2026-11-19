export const MAX_FEED_BYTES = 8 * 1024 * 1024;
export const MAX_EPISODES = 2000;
export type Validators = { etag?: string; lastModified?: string };
export type FeedResponse = Validators & { status: 200 | 304; xml?: string; finalUrl?: string };
export type FeedTransport = (url: string, validators?: Validators) => Promise<FeedResponse>;
export class FeedError extends Error {
  code: string;
  constructor(code: string) { super(code); this.code = code; }
}
export type EpisodeMetadata = {
  description: string; enclosure: { url: string; type: string; length: string };
  episode?: string; season?: string; duration?: string; explicit?: string; image?: string; link?: string; undated?: boolean;
};
export type ParsedEpisode = { id: string; title: string; publishedAt: string; metadata: EpisodeMetadata };
export type ShowMetadata = { description: string; author?: string; explicit?: string; link?: string; image?: string };
export type ParsedPodcast = { title: string; metadata: ShowMetadata; episodes: ParsedEpisode[] };
