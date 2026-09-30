/**
 * Centralised voice-message playback.
 *
 * Previously every message rendered its own <audio controls>. Re-rendering the list detached those
 * elements while they kept playing, and nothing stopped one player when another started — so two
 * voice messages could play at once, with no UI left to stop the orphan.
 *
 * Now a single HTMLAudioElement is shared by every voice message, so starting one necessarily stops
 * the previous one, and UI state is derived from this module rather than from DOM elements.
 *
 * If the element cannot play a file (for example a WebM recording opened on an iPhone), the file is
 * fetched and decoded with the Web Audio API instead. If that also fails, the error is surfaced.
 * toggle() must be called synchronously from a tap so mobile browsers treat playback as user-initiated.
 */
const listeners = new Set();
const positions = new Map();          // media id -> seconds, so paused messages resume where they stopped
const buffers = new Map();            // media id -> decoded AudioBuffer (small LRU for the fallback path)
const fallbackTried = new Set();

let audio = null;
let context = null;
let current = null;                   // { id, url, durationMs, title }
let status = 'idle';                  // idle | loading | playing | paused | error
let errorMessage = '';
let webAudio = null;                  // { source, buffer, startedAt } while the fallback path is active
let frame = 0;

function emit() {
  const snapshot = snapshotFor(current?.id);
  for (const listener of [...listeners]) {
    try { listener(current?.id ?? null, snapshot); } catch (error) { console.error('Voice listener failed', error); }
  }
}

function setStatus(next, message = '') {
  status = next;
  errorMessage = message;
  if (next === 'playing') loop(); else cancelAnimationFrame(frame);
  updateMediaSession();
  emit();
}

function loop() {
  cancelAnimationFrame(frame);
  const tick = () => { if (status !== 'playing') return; emit(); frame = requestAnimationFrame(tick); };
  frame = requestAnimationFrame(tick);
}

function element() {
  if (audio) return audio;
  audio = new Audio();
  audio.preload = 'auto';
  audio.setAttribute('playsinline', '');
  audio.addEventListener('playing', () => { if (current && !webAudio) setStatus('playing'); });
  audio.addEventListener('waiting', () => { if (status === 'playing' && !webAudio) setStatus('loading'); });
  audio.addEventListener('pause', () => { if (current && !webAudio && status === 'playing') { positions.set(current.id, audio.currentTime); setStatus('paused'); } });
  audio.addEventListener('ended', () => { if (!webAudio) finish(); });
  audio.addEventListener('loadedmetadata', emit);
  audio.addEventListener('durationchange', emit);
  audio.addEventListener('error', () => { if (current && audio.getAttribute('src') && !webAudio) useFallback(current); });
  return audio;
}

function ensureContext() {
  const Context = window.AudioContext || window.webkitAudioContext;
  if (!Context) return null;
  if (!context) context = new Context();
  if (context.state === 'suspended') context.resume().catch(() => {});
  return context;
}

function pauseOtherMedia() {
  for (const media of document.querySelectorAll('video, audio')) if (media !== audio && !media.paused) media.pause();
}

function releaseElement() {
  if (!audio) return;
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
}

function stopWebAudio() {
  if (!webAudio) return;
  const { source } = webAudio;
  webAudio = null;
  try { source.onended = null; source.stop(); } catch { /* already stopped */ }
}

function position() {
  if (!current) return 0;
  if (webAudio && context) return Math.min(context.currentTime - webAudio.startedAt, webAudio.buffer.duration);
  if (buffers.has(current.id) && !audio?.getAttribute('src')) return positions.get(current.id) || 0;
  return audio?.getAttribute('src') ? audio.currentTime : positions.get(current.id) || 0;
}

function duration(item = current) {
  if (!item) return 0;
  if (item === current) {
    if (buffers.has(item.id)) return buffers.get(item.id).duration;
    if (audio && Number.isFinite(audio.duration) && audio.duration > 0) return audio.duration;
  }
  return (Number(item.durationMs) || 0) / 1000;
}

function finish() {
  if (!current) return;
  positions.delete(current.id);
  stopWebAudio();
  const finished = current;
  setStatus('idle');
  current = null;
  for (const listener of [...listeners]) listener(finished.id, { status: 'idle', position: 0, duration: duration(finished), error: '' });
}

function fail(message) {
  stopWebAudio();
  releaseElement();
  setStatus('error', message);
}

function cacheBuffer(id, buffer) {
  buffers.delete(id);
  buffers.set(id, buffer);
  while (buffers.size > 6) buffers.delete(buffers.keys().next().value);
}

function decode(ctx, data) {
  // Older Safari only supports the callback form of decodeAudioData.
  return new Promise((resolve, reject) => {
    const result = ctx.decodeAudioData(data, resolve, reject);
    if (result?.then) result.then(resolve, reject);
  });
}

async function useFallback(item) {
  if (fallbackTried.has(item.id)) return fail('This voice message could not be played.');
  fallbackTried.add(item.id);
  setStatus('loading');
  try {
    const response = await fetch(item.url, { credentials: 'same-origin' });
    if (!response.ok) throw new Error(response.status === 403 || response.status === 404 ? 'This voice message is no longer available.' : 'Could not load the voice message.');
    const data = await response.arrayBuffer();
    const ctx = ensureContext();
    if (!ctx) throw new Error('This device cannot play this voice message.');
    let buffer;
    try { buffer = await decode(ctx, data); } catch { throw new Error('This voice message format is not supported on this device.'); }
    cacheBuffer(item.id, buffer);
    if (current?.id !== item.id) return;
    releaseElement();
    playBuffer(positions.get(item.id) || 0);
  } catch (error) {
    if (current?.id === item.id) fail(error.message);
  }
}

function playBuffer(offset) {
  const ctx = ensureContext();
  const buffer = buffers.get(current.id);
  if (!ctx || !buffer) return fail('This voice message could not be played.');
  stopWebAudio();
  const start = offset >= buffer.duration - 0.05 ? 0 : offset;
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(ctx.destination);
  source.onended = () => { if (webAudio?.source === source) finish(); };
  source.start(0, start);
  webAudio = { source, buffer, startedAt: ctx.currentTime - start };
  setStatus('playing');
}

function start(item) {
  stopCurrent();
  current = item;
  pauseOtherMedia();
  ensureContext();
  const resumeAt = positions.get(item.id) || 0;
  if (buffers.has(item.id)) return playBuffer(resumeAt);
  const el = element();
  el.src = item.url;
  if (resumeAt) el.addEventListener('loadedmetadata', () => { try { el.currentTime = resumeAt; } catch { /* not seekable yet */ } }, { once: true });
  setStatus('loading');
  el.play()?.catch(error => {
    if (current?.id !== item.id || webAudio) return;
    if (error.name === 'AbortError') return;
    if (error.name === 'NotAllowedError') return setStatus('paused');
    useFallback(item);
  });
}

function stopCurrent() {
  if (!current) return;
  positions.set(current.id, position());
  stopWebAudio();
  releaseElement();
  const previous = current;
  current = null;
  status = 'idle';
  cancelAnimationFrame(frame);
  for (const listener of [...listeners]) listener(previous.id, { status: 'paused', position: positions.get(previous.id) || 0, duration: duration(previous), error: '' });
}

export function pause() {
  if (!current) return;
  positions.set(current.id, position());
  if (webAudio) { stopWebAudio(); setStatus('paused'); return; }
  audio?.pause();
  setStatus('paused');
}

function resume() {
  pauseOtherMedia();
  ensureContext();
  if (buffers.has(current.id)) return playBuffer(positions.get(current.id) || 0);
  if (!audio?.getAttribute('src')) return start(current);
  setStatus('loading');
  audio.play()?.catch(error => { if (error.name !== 'AbortError') useFallback(current); });
}

/** Play/pause a voice message. Must run inside the tap handler (mobile autoplay rules). */
export function toggle(item) {
  if (current?.id === item.id) {
    if (status === 'playing' || status === 'loading') return pause();
    if (status === 'error') { fallbackTried.delete(item.id); return start(item); }
    return resume();
  }
  fallbackTried.delete(item.id);
  start(item);
}

export function seek(item, fraction) {
  const clamped = Math.min(Math.max(fraction, 0), 1);
  if (current?.id !== item.id) {
    positions.set(item.id, clamped * duration(item));
    for (const listener of [...listeners]) listener(item.id, snapshotFor(item.id, item));
    return;
  }
  const target = clamped * duration();
  positions.set(item.id, target);
  if (webAudio) { playBuffer(target); return; }
  if (buffers.has(item.id)) { emit(); return; }
  try { element().currentTime = target; } catch { /* not seekable yet */ }
  emit();
}

/** Stops playback entirely (leaving a conversation, signing out). */
export function stopAll() {
  if (!current) return;
  stopCurrent();
}

/** An optimistic (local) voice message was confirmed by the server under a new id. */
export function renameMedia(fromId, toId) {
  if (positions.has(fromId)) { positions.set(toId, positions.get(fromId)); positions.delete(fromId); }
  if (buffers.has(fromId)) { buffers.set(toId, buffers.get(fromId)); buffers.delete(fromId); }
  if (current?.id === fromId) current = { ...current, id: toId };
}

export function snapshotFor(id, item = null) {
  if (id !== null && id !== undefined && current?.id === id) {
    return { status, position: position(), duration: duration(), error: errorMessage };
  }
  return { status: 'idle', position: positions.get(id) || 0, duration: item ? duration(item) : 0, error: '' };
}

export function onPlaybackChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function updateMediaSession() {
  if (!('mediaSession' in navigator)) return;
  try {
    if (current && (status === 'playing' || status === 'paused' || status === 'loading')) {
      navigator.mediaSession.metadata = new window.MediaMetadata({ title: 'Voice message', artist: current.title || 'Circle' });
      navigator.mediaSession.playbackState = status === 'paused' ? 'paused' : 'playing';
      navigator.mediaSession.setActionHandler('play', () => current && resume());
      navigator.mediaSession.setActionHandler('pause', () => pause());
    } else {
      navigator.mediaSession.playbackState = 'none';
    }
  } catch { /* Media Session is optional */ }
}

// A video starting anywhere in the app pauses the voice message, keeping "one sound at a time".
document.addEventListener('play', event => {
  if (event.target !== audio && event.target instanceof HTMLMediaElement && current && status !== 'paused') pause();
}, true);
