/**
 * Voice-message UI. Markup is stateless; playback state lives in lib/audio.js and is painted onto
 * whichever element currently represents a media id, so re-rendering a message never interrupts or
 * duplicates playback.
 */
import { icon } from '../icons.js';
import { formatDuration } from '../lib/time.js';
import { onPlaybackChange, seek, snapshotFor, toggle } from '../lib/audio.js';
import { escapeHtml } from '../ui.js';

const BARS = 40;

function bars(waveform) {
  if (!Array.isArray(waveform) || !waveform.length) return Array(BARS).fill(18); // honest flat line when unknown
  return Array.from({ length: BARS }, (_, index) => {
    const value = waveform[Math.floor(index * waveform.length / BARS)] || 0;
    return Math.max(12, Math.min(100, value));
  });
}

export function voiceMarkup(media, { title = '' } = {}) {
  const heights = bars(media.waveform);
  const wave = heights.map(height => `<i style="height:${height}%"></i>`).join('');
  return `<div class="voice" data-voice="${escapeHtml(String(media.id))}" data-src="${escapeHtml(media.url)}" data-duration="${Number(media.durationMs) || ''}" data-title="${escapeHtml(title)}">
    <button type="button" class="voice-play" data-voice-toggle aria-label="Play voice message">
      <span class="voice-icon-play">${icon('play', 20, true)}</span><span class="voice-icon-pause">${icon('pause', 20, true)}</span><span class="voice-spinner"></span>
    </button>
    <div class="voice-body">
      <div class="voice-wave" data-voice-seek role="slider" aria-label="Playback position" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" tabindex="0">
        <div class="voice-bars">${wave}</div><div class="voice-bars voice-bars-progress" aria-hidden="true">${wave}</div>
      </div>
      <div class="voice-meta"><span data-voice-time>${media.durationMs ? formatDuration(media.durationMs) : '0:00'}</span><span class="voice-error" data-voice-error hidden></span></div>
    </div>
  </div>`;
}

function itemFrom(element) {
  return { id: /^\d+$/.test(element.dataset.voice) ? Number(element.dataset.voice) : element.dataset.voice, url: element.dataset.src, durationMs: Number(element.dataset.duration) || 0, title: element.dataset.title };
}

export function paintVoice(element, snapshot) {
  const item = itemFrom(element);
  const state = snapshot || snapshotFor(item.id, item);
  const total = state.duration || item.durationMs / 1000;
  const fraction = total ? Math.min(1, state.position / total) : 0;
  element.classList.toggle('is-playing', state.status === 'playing');
  element.classList.toggle('is-loading', state.status === 'loading');
  element.classList.toggle('is-error', state.status === 'error');
  element.classList.toggle('is-started', state.position > 0 || state.status === 'playing' || state.status === 'loading');
  element.style.setProperty('--progress', `${(fraction * 100).toFixed(2)}%`);
  const wave = element.querySelector('[data-voice-seek]');
  wave?.setAttribute('aria-valuenow', String(Math.round(fraction * 100)));
  const button = element.querySelector('[data-voice-toggle]');
  button?.setAttribute('aria-label', state.status === 'playing' ? 'Pause voice message' : 'Play voice message');
  const time = element.querySelector('[data-voice-time]');
  const showPosition = state.status === 'playing' || state.status === 'loading' || state.position > 0;
  const text = showPosition ? formatDuration(state.position * 1000) : (total ? formatDuration(total * 1000) : '0:00');
  if (time && time.textContent !== text) time.textContent = text;
  const error = element.querySelector('[data-voice-error]');
  if (error) { error.hidden = state.status !== 'error'; error.textContent = state.error || ''; }
}

/** Wires every voice element inside `root`. Returns a cleanup function. */
export function bindVoice(root) {
  const click = event => {
    const toggleButton = event.target.closest('[data-voice-toggle]');
    if (toggleButton && root.contains(toggleButton)) {
      event.stopPropagation();
      toggle(itemFrom(toggleButton.closest('[data-voice]')));
    }
  };
  let scrubbing = null;
  const seekTo = (element, clientX) => {
    const wave = element.querySelector('[data-voice-seek]').getBoundingClientRect();
    seek(itemFrom(element), (clientX - wave.left) / wave.width);
  };
  const down = event => {
    const wave = event.target.closest('[data-voice-seek]');
    if (!wave || !root.contains(wave)) return;
    event.stopPropagation();
    scrubbing = wave.closest('[data-voice]');
    seekTo(scrubbing, event.clientX);
  };
  const move = event => { if (scrubbing) seekTo(scrubbing, event.clientX); };
  const up = () => { scrubbing = null; };
  const key = event => {
    const wave = event.target.closest('[data-voice-seek]');
    if (!wave || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    const element = wave.closest('[data-voice]');
    const item = itemFrom(element);
    const state = snapshotFor(item.id, item);
    const total = state.duration || item.durationMs / 1000;
    if (total) seek(item, (state.position + (event.key === 'ArrowRight' ? 5 : -5)) / total);
  };
  root.addEventListener('click', click);
  root.addEventListener('pointerdown', down);
  window.addEventListener('pointermove', move, { passive: true });
  window.addEventListener('pointerup', up);
  root.addEventListener('keydown', key);
  const unsubscribe = onPlaybackChange((id, snapshot) => {
    if (id === null || id === undefined) return;
    for (const element of root.querySelectorAll(`[data-voice="${CSS.escape(String(id))}"]`)) paintVoice(element, snapshot);
  });
  return () => {
    unsubscribe();
    root.removeEventListener('click', click);
    root.removeEventListener('pointerdown', down);
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    root.removeEventListener('keydown', key);
  };
}
