import { Temporal } from '@js-temporal/polyfill';
import { nextSlot, type Schedule } from './schedule.ts';
import { selectEpisodes, type Episode } from './selection.ts';

export type Release = Readonly<{ episodeId: string; deliveredAt: string }>;
export type ReleaseState = Readonly<{
  schedule: Schedule;
  paused: boolean;
  nextSlot: string;
  waiting: boolean;
  releases: readonly Release[];
  /** Tracks content changes; delivery decisions increment it when adding history. */
  publicationVersion: number;
}>;
export type InitialRelease = 'now' | 'next';

export function activate(schedule: Schedule, now: string, choice: InitialRelease): ReleaseState {
  return {
    schedule, paused: false, nextSlot: nextSlot(schedule, now),
    waiting: choice === 'now', releases: [], publicationVersion: 0,
  };
}

export function pause(state: ReleaseState): ReleaseState {
  return { ...state, paused: true, waiting: false };
}

/** Edits preserve pause state and discard any previous waiting opportunity. */
export function editSchedule(
  state: ReleaseState, schedule: Schedule, now: string,
): ReleaseState {
  return { ...state, schedule, nextSlot: nextSlot(schedule, now), waiting: false };
}

export function resume(state: ReleaseState, now: string, choice: InitialRelease): ReleaseState {
  return {
    ...state, paused: false,
    nextSlot: nextSlot(state.schedule, now), waiting: choice === 'now',
  };
}

/***************************************************************************
 * Decide at most one delivery using the already selected source episodes.
 * The caller must atomically persist using a state revision check, together with
 * a unique subscription/episode release and a publication outbox update. Retrying
 * publication must use persisted history rather than calling this function.
 ***************************************************************************/
export function processRelease(
  state: ReleaseState, selected: readonly Episode[], now: string,
): ReleaseState {
  const instant = Temporal.Instant.from(now);
  if (state.paused) return state;
  const due = Temporal.Instant.compare(Temporal.Instant.from(state.nextSlot), instant) <= 0;
  if (!due && !state.waiting) return state;
  const queue = selectEpisodes(selected, { mode: 'all' }, state.releases.map(release => release.episodeId));
  const episode = queue[0];
  return {
    ...state,
    nextSlot: due ? nextSlot(state.schedule, now) : state.nextSlot,
    waiting: !episode,
    releases: episode
      ? [...state.releases, { episodeId: episode.id, deliveredAt: instant.toString() }]
      : state.releases,
    publicationVersion: state.publicationVersion + (episode ? 1 : 0),
  };
}
