/**
 * Client copy of the member's synced preferences. Reads are synchronous (a localStorage copy makes
 * the first paint use the right appearance/language); writes apply instantly and sync in a debounced
 * PATCH. Failed writes remain queued and retry online, so preferences never become silently local-only.
 */
import { request } from '../api.js';

const KEY = 'circle-settings';
export const DEFAULTS = {
  language: 'en',
  appearance: { theme: 'system', fontSize: 16, density: 'comfortable', animations: 'full', bubbleTime: 'relative', wallpaper: { id: 'default', blur: 0, dim: 0, mediaId: null } },
  chat: { enterToSend: false, linkPreviews: true, typingIndicators: true, voiceSpeed: 1, autoplayVoice: true, sendByHold: true },
  notifications: { messages: true, groups: true, mentions: true, reactions: true, stories: true, sound: true, vibrate: true, preview: true, inApp: true },
  data: { autoPhotos: true, autoVideos: true, autoFiles: false },
  privacy: { storyReplies: true },
  folders: []
};

const listeners = new Set();
let current = merge(DEFAULTS, readLocal());
let acknowledged = merge(DEFAULTS, current);
let pending = {};
let timer = null;
let flushing = false;
let waiters = [];

function readLocal() {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; }
}
function isObject(value) { return value && typeof value === 'object' && !Array.isArray(value); }
export function merge(base, patch) {
  if (!isObject(patch)) return structuredClone(base);
  const result = structuredClone(base);
  for (const [key, value] of Object.entries(patch)) {
    result[key] = isObject(value) && isObject(result[key]) ? merge(result[key], value) : structuredClone(value);
  }
  return result;
}
function persist() { try { localStorage.setItem(KEY, JSON.stringify(current)); } catch { /* storage full or disabled */ } }
function emit(changed) {
  for (const listener of [...listeners]) {
    try { listener(current, changed); } catch (error) { console.error('Settings listener failed', error); }
  }
}

export function settings() { return current; }
export function onSettingsChange(listener) { listeners.add(listener); return () => listeners.delete(listener); }

/** Server state is authoritative, with still-pending local edits layered on top. */
export function applyServerSettings(next) {
  if (!next) return;
  acknowledged = merge(DEFAULTS, next);
  current = merge(acknowledged, pending);
  persist();
  emit(next);
}

/** Applies a partial change immediately and resolves when that debounced batch reaches the server. */
export function updateSettings(patch) {
  current = merge(current, patch);
  pending = merge(pending, patch);
  if (Array.isArray(patch.folders)) pending.folders = patch.folders;
  persist();
  emit(patch);
  clearTimeout(timer);
  return new Promise((resolve, reject) => {
    waiters.push({ resolve, reject });
    timer = setTimeout(flush, 350);
  });
}

async function flush() {
  if (flushing || !Object.keys(pending).length) return;
  flushing = true;
  clearTimeout(timer);
  const body = pending;
  const batch = waiters;
  pending = {};
  waiters = [];
  try {
    const { settings: saved } = await request('/api/settings', { method: 'PATCH', body: { settings: body } });
    acknowledged = merge(DEFAULTS, saved);
    current = merge(acknowledged, pending);
    persist();
    batch.forEach(waiter => waiter.resolve(current));
  } catch (error) {
    // New edits made during the request win over this older failed batch on overlapping paths.
    pending = merge(body, pending);
    current = merge(acknowledged, pending);
    persist();
    batch.forEach(waiter => waiter.reject(error));
    emit({ syncError: error.message });
  } finally {
    flushing = false;
    if (Object.keys(pending).length) timer = setTimeout(flush, navigator.onLine === false ? 5000 : 1200);
  }
}

window.addEventListener('online', () => {
  if (!Object.keys(pending).length) return;
  clearTimeout(timer);
  timer = setTimeout(flush, 50);
});

export function clearLocalSettings() {
  clearTimeout(timer);
  pending = {};
  waiters.splice(0).forEach(waiter => waiter.reject(new Error('Signed out')));
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
  current = merge(DEFAULTS, {});
  acknowledged = merge(DEFAULTS, {});
}

/** Removes account-specific drafts and search history on sign-out/revocation. */
export function clearPrivateLocalData(userId) {
  try {
    const prefixes = [`circle-draft-${Number(userId)}-`, `circle-recent-searches-${Number(userId)}`];
    for (let index = localStorage.length - 1; index >= 0; index -= 1) {
      const key = localStorage.key(index);
      if (key && prefixes.some(prefix => key.startsWith(prefix))) localStorage.removeItem(key);
    }
  } catch { /* storage may be disabled */ }
}
