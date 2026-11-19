import { Temporal } from '@js-temporal/polyfill';

type Clock = { hour: number; timeZone: string };
/** ISO weekdays: Monday = 1, Sunday = 7. */
export type Schedule = Clock & (
  | { kind: 'daily' }
  | { kind: 'weekly'; weekdays: readonly number[] }
  | { kind: 'interval'; weeks: number; weekday: number; startDate: string }
);

function validate(schedule: Schedule): void {
  if (!Number.isInteger(schedule.hour) || schedule.hour < 0 || schedule.hour > 23) {
    throw new RangeError('Release hour must be an integer from 0 to 23');
  }
  if (/^[+-]/.test(schedule.timeZone)) throw new RangeError('Use an IANA timezone');
  Temporal.Instant.from('2000-01-01T00:00:00Z').toZonedDateTimeISO(schedule.timeZone);
  const weekday = (day: number) => Number.isInteger(day) && day >= 1 && day <= 7;
  switch (schedule.kind) {
    case 'daily': break;
    case 'weekly':
      if (!schedule.weekdays.length || !schedule.weekdays.every(weekday)) {
        throw new RangeError('Select at least one valid ISO weekday');
      }
      break;
    case 'interval':
      if (!Number.isSafeInteger(schedule.weeks) || schedule.weeks < 1 || !weekday(schedule.weekday)) {
        throw new RangeError('Invalid week interval or weekday');
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(schedule.startDate)) throw new RangeError('Use an ISO start date');
      Temporal.PlainDate.from(schedule.startDate);
      break;
    default: throw new RangeError('Unsupported schedule kind');
  }
}

function slotOn(date: Temporal.PlainDate, schedule: Schedule): Temporal.Instant {
  ////////////////////////////////////////////////////////////////////////////////
  // Earlier disambiguation resolves a repeated hour once. A gap maps backward, //
  // which fails the equality check, so scan forward to a valid whole hour.     //
  ////////////////////////////////////////////////////////////////////////////////
  let local = date.toPlainDateTime({ hour: schedule.hour });
  for (let attempt = 0; attempt <= 48; attempt++) {
    const zoned = local.toZonedDateTime(schedule.timeZone, { disambiguation: 'earlier' });
    if (zoned.toPlainDateTime().equals(local)) return zoned.toInstant();
    local = local.add({ hours: 1 });
  }
  throw new RangeError('Unable to resolve a valid local release hour');
}

/** Returns the first calendar slot strictly after an explicit UTC instant. */
export function nextSlot(schedule: Schedule, after: string): string {
  validate(schedule);
  const instant = Temporal.Instant.from(after);
  let date = instant.toZonedDateTimeISO(schedule.timeZone).toPlainDate();
  if (schedule.kind === 'interval') {
    const start = Temporal.PlainDate.from(schedule.startDate);
    const anchor = start.add({ days: (schedule.weekday - start.dayOfWeek + 7) % 7 });
    const days = anchor.until(date, { largestUnit: 'days' }).days;
    const period = schedule.weeks * 7;
    if (!Number.isSafeInteger(period)) throw new RangeError('Week interval is too large');
    date = anchor.add({ days: Math.max(0, Math.floor(days / period)) * period });
    let slot = slotOn(date, schedule);
    if (Temporal.Instant.compare(slot, instant) <= 0) {
      date = date.add({ days: period });
      slot = slotOn(date, schedule);
    }
    return slot.toString();
  }
  for (let offset = 0; offset <= 7; offset++) {
    if (schedule.kind === 'daily' || schedule.weekdays.includes(date.dayOfWeek)) {
      const slot = slotOn(date, schedule);
      if (Temporal.Instant.compare(slot, instant) > 0) return slot.toString();
    }
    date = date.add({ days: 1 });
  }
  throw new RangeError('Unable to find next release slot');
}

export function previewSlots(schedule: Schedule, after: string, count = 5): string[] {
  if (!Number.isInteger(count) || count < 0 || count > 1000) throw new RangeError('Preview count must be 0–1000');
  validate(schedule);
  Temporal.Instant.from(after);
  const slots: string[] = [];
  let cursor = after;
  for (let i = 0; i < count; i++) {
    cursor = nextSlot(schedule, cursor);
    slots.push(cursor);
  }
  return slots;
}
