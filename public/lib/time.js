/**
 * Time parsing and formatting for server timestamps.
 *
 * The server sends ISO-8601 UTC ("…Z"). Older rows written by SQLite's CURRENT_TIMESTAMP look like
 * "2026-09-30 13:16:00" (UTC without a zone); browsers treat that as local time, which used to make
 * a message sent a moment ago show "5h" for someone at UTC+5. parseTime() treats it as UTC.
 *
 * The phone's clock can also drift from the server's, so relative times are computed against an
 * offset learned from the server (setServerTime).
 */
import { locale, t } from './i18n.js';

let clockOffset = 0;

export function parseTime(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  let text = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(text)) text = `${text.replace(' ', 'T')}Z`;
  const time = Date.parse(text);
  return Number.isFinite(time) ? time : null;
}

export function setServerTime(value) {
  const server = parseTime(value);
  // Ignore absurd offsets (a broken header must not shift every timestamp by days).
  if (server && Math.abs(server - Date.now()) < 7 * 86400000) clockOffset = server - Date.now();
}

export function now() { return Date.now() + clockOffset; }

const startOfDay = time => { const date = new Date(time); date.setHours(0, 0, 0, 0); return date.getTime(); };
const DAY = 86400000;

function dateLabel(time, { withYear } = {}) {
  const date = new Date(time);
  const sameYear = date.getFullYear() === new Date(now()).getFullYear();
  return new Intl.DateTimeFormat(locale(), { month: 'short', day: 'numeric', ...(withYear || !sameYear ? { year: 'numeric' } : {}) }).format(date);
}

/** "just now", "1m", "5m", "1h", "yesterday", then a date. Never negative, never in the future. */
export function relativeTime(value) {
  const time = parseTime(value);
  if (time === null) return '';
  const current = now();
  const seconds = Math.max(0, (current - time) / 1000);
  if (seconds < 45) return t('Just now');
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))}m`;
  const today = startOfDay(current);
  // Hours for anything today, and for the last few hours even across midnight ("2h" beats "yesterday" at 1am).
  if (time >= today || seconds < 6 * 3600) return `${Math.floor(seconds / 3600)}h`;
  if (time >= today - DAY) return t('Yesterday');
  return dateLabel(time);
}

export function clockTime(value) {
  const time = parseTime(value);
  return time === null ? '' : new Intl.DateTimeFormat(locale(), { hour: 'numeric', minute: '2-digit' }).format(new Date(time));
}

export function exactTime(value) {
  const time = parseTime(value);
  return time === null ? '' : new Intl.DateTimeFormat(locale(), { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' }).format(new Date(time));
}

/** Chat list column: clock time today, weekday this week, otherwise a short date. */
export function listTime(value) {
  const time = parseTime(value);
  if (time === null) return '';
  const today = startOfDay(now());
  if (time >= today) return clockTime(time);
  if (time >= today - DAY) return t('Yesterday');
  if (time >= today - 6 * DAY) return new Intl.DateTimeFormat(locale(), { weekday: 'short' }).format(new Date(time));
  return dateLabel(time);
}

/** Sticky separators between days in a conversation. */
export function dayLabel(value) {
  const time = parseTime(value);
  if (time === null) return '';
  const today = startOfDay(now());
  if (time >= today) return t('Today');
  if (time >= today - DAY) return t('Yesterday');
  return new Intl.DateTimeFormat(locale(), { weekday: 'long', month: 'long', day: 'numeric', ...(new Date(time).getFullYear() !== new Date(now()).getFullYear() ? { year: 'numeric' } : {}) }).format(new Date(time));
}

export function dayKey(value) {
  const time = parseTime(value);
  if (time === null) return '';
  const date = new Date(time);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

export function lastSeenText(user) {
  if (!user) return '';
  if (user.online) return t('online');
  if (user.presenceHidden) return t('last seen recently');
  const time = parseTime(user.lastSeenAt);
  if (time === null) return t('offline');
  const seconds = Math.max(0, (now() - time) / 1000);
  if (seconds < 60) return t('last seen just now');
  if (seconds < 3600) return t('last seen {n}m ago', { n: Math.round(seconds / 60) });
  const today = startOfDay(now());
  if (time >= today) return t('last seen today at {time}', { time: clockTime(time) });
  if (time >= today - DAY) return t('last seen yesterday at {time}', { time: clockTime(time) });
  return t('last seen {date}', { date: dateLabel(time) });
}

export function formatDuration(ms) {
  const total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * A <time> element that keeps itself current: the ticker below re-renders every element carrying
 * data-rel, and the title shows the exact date and time on hover / long-press.
 */
export function timeTag(value, className = '') {
  const time = parseTime(value);
  if (time === null) return '';
  const isoValue = new Date(time).toISOString();
  return `<time class="${className}" datetime="${isoValue}" data-rel title="${exactTime(time)}">${relativeTime(time)}</time>`;
}

let ticker = null;
export function refreshRelativeTimes(root = document) {
  for (const node of root.querySelectorAll('time[data-rel]')) {
    const text = relativeTime(node.getAttribute('datetime'));
    if (node.textContent !== text) node.textContent = text;
  }
}
export function startRelativeTimeTicker() {
  if (ticker) return;
  ticker = setInterval(() => { if (document.visibilityState === 'visible') refreshRelativeTimes(); }, 30000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refreshRelativeTimes(); });
}
