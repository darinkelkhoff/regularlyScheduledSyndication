import type { Schedule } from '../domain/schedule.ts';

const weekdays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const list = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' });

export function scheduleLabel(schedule: Schedule): string {
  const time = `${schedule.hour % 12 || 12} ${schedule.hour < 12 ? 'AM' : 'PM'}`;
  const rhythm = schedule.kind === 'daily' ? 'Every day'
    : schedule.kind === 'weekly' ? `Every ${list.format(schedule.weekdays.map(day => weekdays[day - 1]!))}`
    : `Every ${schedule.weeks === 1 ? 'week' : `${schedule.weeks} weeks`} on ${weekdays[schedule.weekday - 1]}`;
  return `${rhythm} at ${time}`;
}
