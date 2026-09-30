/**
 * Hold-to-record voice messages.
 *
 *   press & hold mic  → recording (timer, live level, "‹ Slide to cancel")
 *   release           → send          slide left → cancel          slide up → lock (hands-free)
 *   locked: stop      → preview (play it back) → send or delete
 *
 * Quick taps show a hint instead of sending a useless blip. With "hold to record" turned off in
 * Chat Settings, a tap starts a locked recording directly. The recorder's own state machine plus the
 * `phase` guard here mean one recording can only ever produce one send.
 */
import { icon } from '../icons.js';
import { formatDuration } from '../lib/time.js';
import { MAX_RECORDING_MS, recordingSupported, VoiceRecorder } from '../lib/recorder.js?v=8';
import { stopAll, toggle as togglePlayback } from '../lib/audio.js';
import { settings } from '../lib/settings.js';
import { t } from '../lib/i18n.js';
import { toast } from '../ui.js';
import { bindVoice, paintVoice, voiceMarkup } from './voice.js';

const CANCEL_DISTANCE = 110;
const LOCK_DISTANCE = 80;

export function createVoiceComposer({ micButton, wrap, onSend, onRecordingChange }) {
  const recorder = new VoiceRecorder();
  let phase = 'idle';            // idle | starting | holding | locked | preview | sending
  let origin = null;
  let pointerId = null;
  let timer = null;
  let releasedEarly = false;
  let pressedAt = 0;
  let recording = null;
  let previewUrl = null;
  let unbindPreview = null;
  let transition = 0;

  const bar = document.createElement('div');
  bar.className = 'recording-bar';
  bar.hidden = true;
  bar.innerHTML = `
    <div class="rec-left"><span class="recording-dot"></span><span class="recording-time" data-record-time>0:00</span></div>
    <div class="rec-center">
      <span class="slide-cancel" data-slide>${icon('back', 16)} ${t('Slide to cancel')}</span>
      <button type="button" class="text-button rec-cancel" data-action="cancel-recording">${t('Cancel')}</button>
      <div class="rec-preview" data-preview></div>
    </div>
    <div class="rec-right">
      <button type="button" class="icon-button rec-trash" data-action="discard-recording" aria-label="${t('Delete recording')}">${icon('trash', 22)}</button>
      <button type="button" class="rec-stop" data-action="stop-recording" aria-label="${t('Stop and review')}">${icon('stop', 18, true)}</button>
      <button type="button" class="send-circle rec-send" data-action="send-recording" aria-label="${t('Send voice message')}">${icon('send', 20)}</button>
    </div>
    <div class="rec-lock" aria-hidden="true">${icon('lock2', 18)}<span class="rec-lock-arrow">${icon('arrowup', 14)}</span></div>
    <div class="rec-mic" aria-hidden="true"><span class="rec-mic-pulse"></span>${icon('mic', 26)}</div>`;
  wrap.append(bar);
  const timeLabel = bar.querySelector('[data-record-time]');
  const slide = bar.querySelector('[data-slide]');
  const mic = bar.querySelector('.rec-mic');
  const lock = bar.querySelector('.rec-lock');
  const pulse = bar.querySelector('.rec-mic-pulse');

  const setPhase = next => {
    phase = next;
    wrap.dataset.recording = next;
    bar.hidden = next === 'idle';
    bar.toggleAttribute('aria-busy', next === 'starting' || next === 'sending');
    onRecordingChange?.(next !== 'idle');
  };

  const reset = () => {
    clearInterval(timer);
    timer = null;
    origin = null;
    mic.style.transform = '';
    lock.style.transform = '';
    slide.style.transform = '';
    slide.style.opacity = '';
    timeLabel.textContent = '0:00';
    if (unbindPreview) { unbindPreview(); unbindPreview = null; }
    if (previewUrl) { stopAll(); URL.revokeObjectURL(previewUrl); previewUrl = null; }
    bar.querySelector('[data-preview]').innerHTML = '';
    recording = null;
    setPhase('idle');
  };

  async function begin({ locked = false } = {}) {
    if (phase !== 'idle') return;
    if (!recordingSupported()) return toast(t('Voice messages are not supported in this browser.'), 'error');
    stopAll();
    releasedEarly = false;
    setPhase('starting');
    try {
      const started = await recorder.start();
      if (!started) { reset(); return; }
    } catch (error) { reset(); toast(error.message, 'error'); return; }
    // The finger was lifted while the microphone was still starting (e.g. the permission prompt).
    if (releasedEarly && !locked) { recorder.cancel(); reset(); showHint(); return; }
    setPhase(locked ? 'locked' : 'holding');
    navigator.vibrate?.(12);
    recorder.onLevel = level => { pulse.style.transform = `scale(${1 + Math.min(1, level) * 0.9})`; };
    timer = setInterval(() => {
      const elapsed = recorder.elapsed();
      timeLabel.textContent = formatDuration(elapsed);
      if (elapsed >= MAX_RECORDING_MS) return finish('send');
      // iOS can drop the final pointerup/pointercancel (a system gesture or lost pointer capture).
      // "Holding" only offers slide gestures, so without this the bar would keep recording with no
      // reachable Send or Cancel. Fall back to the locked layout, which has real buttons.
      if (phase === 'holding' && pointerId === null) {
        setPhase('locked');
        mic.style.transform = '';
        lock.style.transform = '';
        slide.style.transform = '';
        slide.style.opacity = '';
      }
    }, 200);
  }

  function showHint() {
    toast(settings().chat.sendByHold ? t('Hold to record, release to send') : t('Tap the microphone to start recording'));
  }

  function cancelRecording() {
    transition += 1; // Ignore a late native stop/error callback from the discarded recording.
    recorder.cancel();
    bar.classList.add('cancelled');
    navigator.vibrate?.([8, 40, 8]);
    setTimeout(() => bar.classList.remove('cancelled'), 300);
    reset();
  }

  async function finish(mode) {
    if (mode === 'cancel') {
      if (!['starting', 'holding', 'locked', 'sending'].includes(phase)) return;
      return cancelRecording();
    }
    if (!['holding', 'locked'].includes(phase)) return;

    const currentTransition = ++transition;
    clearInterval(timer);
    timer = null;
    setPhase('sending');
    try {
      const result = await recorder.stop();
      if (currentTransition !== transition) return;
      if (!result) { reset(); return toast(t('Recording was too short — hold on a little longer.')); }
      if (mode === 'preview') return showPreview(result);
      reset();
      onSend(result);
    } catch (error) {
      if (currentTransition !== transition) return;
      console.error('Could not finish voice recording', error);
      reset();
      toast(t('Could not finish recording. Please try again.'), 'error');
    }
  }

  function showPreview(result) {
    recording = result;
    previewUrl = URL.createObjectURL(result.blob);
    const host = bar.querySelector('[data-preview]');
    host.innerHTML = voiceMarkup({ id: `preview-${Date.now()}`, url: previewUrl, durationMs: result.durationMs, waveform: result.waveform }, { mine: true });
    host.querySelectorAll('[data-voice]').forEach(element => paintVoice(element));
    unbindPreview = bindVoice(host);
    setPhase('preview');
  }

  micButton.addEventListener('pointerdown', event => {
    if (event.button > 0) return;
    event.preventDefault();
    if (!settings().chat.sendByHold) return;
    pressedAt = performance.now();
    pointerId = event.pointerId;
    try { micButton.setPointerCapture(pointerId); } catch { /* ignore */ }
    origin = { x: event.clientX, y: event.clientY };
    begin();
  });
  micButton.addEventListener('pointermove', event => {
    if (phase !== 'holding' || !origin || event.pointerId !== pointerId) return;
    const dx = Math.min(0, event.clientX - origin.x);
    const dy = Math.min(0, event.clientY - origin.y);
    mic.style.transform = `translate(${dx}px, ${dy}px)`;
    slide.style.transform = `translateX(${dx * 0.6}px)`;
    slide.style.opacity = String(1 - Math.min(1, -dx / CANCEL_DISTANCE));
    lock.style.transform = `translateY(${Math.max(-LOCK_DISTANCE, dy) * 0.5}px)`;
    if (-dx > CANCEL_DISTANCE) finish('cancel');
    else if (-dy > LOCK_DISTANCE) { setPhase('locked'); mic.style.transform = ''; lock.style.transform = ''; navigator.vibrate?.(10); }
  });
  const release = event => {
    if (event.pointerId !== pointerId) return;
    pointerId = null;
    if (phase === 'starting') { releasedEarly = true; return; }
    if (phase !== 'holding') return;
    if (performance.now() - pressedAt < 350) { recorder.cancel(); reset(); showHint(); return; }
    finish('send');
  };
  const cancelPointer = event => {
    if (event.pointerId !== pointerId) return;
    if (phase === 'holding') { pointerId = null; return finish('cancel'); }
    release(event);
  };
  micButton.addEventListener('pointerup', release);
  micButton.addEventListener('pointercancel', cancelPointer);
  // The finger can leave the button, or iOS can deliver the final event somewhere else entirely.
  // Window-level listeners guarantee a release is always seen; both handlers ignore stale pointer
  // ids, so the button and window firing for the same event is harmless.
  window.addEventListener('pointerup', release);
  window.addEventListener('pointercancel', cancelPointer);
  // Tap mode (hold-to-record switched off) and keyboard users.
  micButton.addEventListener('click', event => {
    event.preventDefault();
    if (!settings().chat.sendByHold && phase === 'idle') begin({ locked: true });
  });
  micButton.addEventListener('keydown', event => { if ((event.key === 'Enter' || event.key === ' ') && phase === 'idle') { event.preventDefault(); begin({ locked: true }); } });

  bar.addEventListener('click', event => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'cancel-recording') finish('cancel');
    if (action === 'stop-recording') finish('preview');
    if (action === 'send-recording') {
      if (phase === 'preview' && recording) { const result = recording; reset(); onSend(result); }
      else finish('send');
    }
    if (action === 'discard-recording') { if (phase === 'preview') reset(); else finish('cancel'); }
  });

  return {
    get active() { return phase !== 'idle'; },
    cancel() {
      if (phase === 'preview') { transition += 1; reset(); }
      else if (phase !== 'idle') finish('cancel');
    },
    destroy() {
      if (phase !== 'idle') { transition += 1; recorder.cancel(); reset(); }
      window.removeEventListener('pointerup', release);
      window.removeEventListener('pointercancel', cancelPointer);
      bar.remove();
    }
  };
}

// Exposed for the voice-message preview in the recording bar.
export { togglePlayback };
