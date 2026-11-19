import { nextSlot } from '../domain/schedule.ts';
import type { ReleaseState } from '../domain/release.ts';
export function expectedReleases(state: Pick<ReleaseState, 'schedule' | 'paused' | 'waiting' | 'nextSlot'>, count: number, now: string): (string | null)[] {
  if (state.paused) return Array.from({ length: count }, () => null);
  const dates: (string | null)[] = [];
  let cursor = state.nextSlot;
  if (count > 0 && (state.waiting || Date.parse(cursor) <= Date.parse(now))) {
    dates.push(null);
    if (Date.parse(cursor) <= Date.parse(now)) cursor = nextSlot(state.schedule, now);
  }
  while (dates.length < count) { dates.push(cursor); cursor = nextSlot(state.schedule, cursor); }
  return dates;
}
