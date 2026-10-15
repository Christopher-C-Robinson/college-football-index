// Calendar helpers shared by the BBS and ESPN producers. Pure: no Worker imports.
export const TIME_ZONE = 'America/Chicago';

const formatters = new Map();
function formatterFor(timeZone) {
  if (!formatters.has(timeZone)) {
    formatters.set(timeZone, new Intl.DateTimeFormat('en-US', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }));
  }
  return formatters.get(timeZone);
}

export const iso = value => {
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
};

export const utcDay = value => new Date(value).toISOString().slice(0, 10);

export function calendarDay(value, timeZone = TIME_ZONE) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = Object.fromEntries(formatterFor(timeZone).formatToParts(date)
    .filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  return parts.year + '-' + parts.month + '-' + parts.day;
}

export function shiftDay(day, delta) {
  const date = new Date(day + 'T12:00:00.000Z');
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

export function validDay(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
  const parsed = Date.parse(value + 'T12:00:00.000Z');
  return Number.isFinite(parsed) && utcDay(parsed) === value;
}

/** Chicago yesterday/today/tomorrow: the public default window. */
export function chicagoWindow(now) {
  const today = calendarDay(now);
  return [shiftDay(today, -1), today, shiftDay(today, 1)];
}
