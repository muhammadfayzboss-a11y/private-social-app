/**
 * Per-member preferences, synced across devices. Stored as JSON on the user row, but every value is
 * validated against this schema: unknown keys are dropped and wrong types fall back to defaults, so a
 * client can never store arbitrary data here. Notification preferences are also enforced server-side.
 */
import { one, run } from './db.js';
import { HttpError } from './utils.js';

export const DEFAULT_SETTINGS = Object.freeze({
  language: 'en',
  appearance: { theme: 'system', fontSize: 16, density: 'comfortable', animations: 'full', bubbleTime: 'relative',
    wallpaper: { id: 'default', blur: 0, dim: 0, mediaId: null } },
  chat: { enterToSend: false, linkPreviews: true, typingIndicators: true, voiceSpeed: 1, autoplayVoice: true, sendByHold: true },
  notifications: { messages: true, groups: true, mentions: true, reactions: true, stories: true, sound: true, vibrate: true, preview: true, inApp: true },
  data: { autoPhotos: true, autoVideos: true, autoFiles: false },
  privacy: { storyReplies: true },
  folders: []
});

const ENUMS = {
  language: ['en', 'uz'],
  'appearance.theme': ['system', 'light', 'dark', 'amoled'],
  'appearance.density': ['comfortable', 'compact'],
  'appearance.animations': ['full', 'reduced', 'off'],
  'appearance.bubbleTime': ['relative', 'clock']
};
const RANGES = { 'appearance.fontSize': [13, 21], 'appearance.wallpaper.blur': [0, 24], 'appearance.wallpaper.dim': [0, 80], 'chat.voiceSpeed': [1, 2] };

function clean(value, fallback, path) {
  if (Array.isArray(fallback)) return fallback;
  if (fallback !== null && typeof fallback === 'object') {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    return Object.fromEntries(Object.entries(fallback).map(([key, inner]) => [key, clean(source[key], inner, path ? `${path}.${key}` : key)]));
  }
  if (ENUMS[path]) return ENUMS[path].includes(value) ? value : fallback;
  if (RANGES[path]) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(RANGES[path][1], Math.max(RANGES[path][0], number)) : fallback;
  }
  if (path === 'appearance.wallpaper.id') return typeof value === 'string' && /^[a-z0-9-]{1,32}$/.test(value) ? value : fallback;
  if (path === 'appearance.wallpaper.mediaId') return Number.isInteger(value) && value > 0 ? value : null;
  if (typeof fallback === 'boolean') return typeof value === 'boolean' ? value : fallback;
  return fallback;
}

function cleanFolders(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 10).map((folder, index) => ({
    id: typeof folder?.id === 'string' && /^[a-z0-9-]{1,24}$/i.test(folder.id) ? folder.id : `folder-${index + 1}`,
    name: String(folder?.name || '').trim().slice(0, 24) || `Folder ${index + 1}`,
    direct: Boolean(folder?.direct),
    groups: Boolean(folder?.groups),
    unreadOnly: Boolean(folder?.unreadOnly),
    chatIds: [...new Set((Array.isArray(folder?.chatIds) ? folder.chatIds : []).map(Number).filter(id => Number.isInteger(id) && id > 0))].slice(0, 200)
  }));
}

/** Validates `raw`; anything invalid falls back to `base` (the stored settings, or the defaults). */
export function normaliseSettings(raw, base = DEFAULT_SETTINGS) {
  const settings = clean(raw, base, '');
  settings.folders = Array.isArray(raw?.folders) ? cleanFolders(raw.folders) : cleanFolders(base.folders);
  return settings;
}

export function getSettings(userId) {
  const row = one('SELECT settings_json FROM users WHERE id = ?', userId);
  let parsed = {};
  try { parsed = JSON.parse(row?.settings_json || '{}'); } catch { parsed = {}; }
  return normaliseSettings(parsed, DEFAULT_SETTINGS);
}

function merge(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const result = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    result[key] = value && typeof value === 'object' && !Array.isArray(value) && base?.[key] && typeof base[key] === 'object' ? merge(base[key], value) : value;
  }
  return result;
}

/** Applies a partial update (deep-merged) and returns the complete, validated settings. */
export function updateSettings(userId, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new HttpError(400, 'Settings must be an object.');
  const current = getSettings(userId);
  const next = normaliseSettings(merge(current, patch), current);
  const wallpaperMedia = next.appearance.wallpaper.mediaId;
  if (wallpaperMedia && !one("SELECT id FROM media WHERE id = ? AND owner_id = ? AND purpose = 'wallpaper'", wallpaperMedia, userId)) {
    throw new HttpError(403, 'Invalid wallpaper image.');
  }
  const serialised = JSON.stringify(next);
  if (serialised.length > 20000) throw new HttpError(413, 'Settings are too large.');
  run('UPDATE users SET settings_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', serialised, userId);
  return next;
}

export function notificationPrefs(userId) {
  return getSettings(userId).notifications;
}
