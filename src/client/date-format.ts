const dateOptions: Intl.DateTimeFormatOptions = { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' };
export function formatDateTime(value: string, timeZone?: string, locale?: string): string {
  return new Intl.DateTimeFormat(locale, { ...dateOptions, hour: 'numeric', minute: '2-digit', ...(timeZone ? { timeZone } : {}) }).format(new Date(value));
}
export function formatDate(value: string, timeZone?: string, locale?: string): string {
  return new Intl.DateTimeFormat(locale, { ...dateOptions, ...(timeZone ? { timeZone } : {}) }).format(new Date(value));
}
export function calendarDate(value: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(value));
  const part = (type: string) => parts.find(part => part.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
