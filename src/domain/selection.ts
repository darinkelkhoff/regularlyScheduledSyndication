import { Temporal } from '@js-temporal/polyfill';

/** id is the stable source identity, independent of output publication dates. */
export type Episode = { id: string; publishedAt: string };
export type Selection =
  | { mode: 'all' }
  | { mode: 'before' | 'after'; boundaryId: string }
  | { mode: 'choose'; ids: readonly string[] };

/** Reconstruct the upcoming queue; never changes the input or delivery history. */
export function selectEpisodes<T extends Episode>(
  episodes: readonly T[], selection: Selection, deliveredIds: readonly string[] = [],
): T[] {
  const seen = new Set<string>();
  const ordered = episodes.map(episode => {
    if (!episode.id || seen.has(episode.id)) throw new RangeError('Episode identities must be nonempty and unique');
    seen.add(episode.id);
    return { episode, instant: Temporal.Instant.from(episode.publishedAt) };
  }).sort((a, b) => Temporal.Instant.compare(a.instant, b.instant)
    || (a.episode.id < b.episode.id ? -1 : a.episode.id > b.episode.id ? 1 : 0));
  let selected: T[];
  switch (selection.mode) {
    case 'all': selected = ordered.map(item => item.episode); break;
    case 'choose': {
      const chosen = new Set(selection.ids);
      selected = ordered.filter(item => chosen.has(item.episode.id)).map(item => item.episode);
      break;
    }
    case 'before':
    case 'after': {
      const boundary = ordered.findIndex(item => item.episode.id === selection.boundaryId);
      if (boundary === -1) throw new RangeError('Boundary episode is unavailable');
      selected = (selection.mode === 'before' ? ordered.slice(0, boundary) : ordered.slice(boundary + 1))
        .map(item => item.episode);
      break;
    }
    default: throw new RangeError('Unsupported selection mode');
  }
  const delivered = new Set(deliveredIds);
  return selected.filter(episode => !delivered.has(episode.id));
}
