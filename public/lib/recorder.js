/**
 * Voice recording with an explicit state machine: idle → starting → recording → stopping → idle.
 * start() while not idle is ignored, so a double tap (or a tap during the permission prompt) cannot
 * start a second recorder — one of the ways a single voice note used to be sent more than once.
 *
 * Formats are tried in order of how widely they play back: AAC in MP4 plays on every iPhone,
 * Android, and desktop browser; Opus/WebM is the fallback where MP4 recording is unavailable.
 */
const PREFERRED_TYPES = ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
const WAVEFORM_BARS = 48;
export const MAX_RECORDING_MS = 10 * 60 * 1000;

export function recordingSupported() {
  return Boolean(navigator.mediaDevices?.getUserMedia) && typeof window.MediaRecorder !== 'undefined';
}

function pickType() {
  if (typeof MediaRecorder.isTypeSupported !== 'function') return '';
  return PREFERRED_TYPES.find(type => { try { return MediaRecorder.isTypeSupported(type); } catch { return false; } }) || '';
}

/** Reduces raw loudness samples to a fixed number of bars on a 0–100 scale. */
export function summariseWaveform(samples, bars = WAVEFORM_BARS) {
  if (!samples.length) return [];
  const size = samples.length / bars;
  const values = Array.from({ length: bars }, (_, index) => {
    const slice = samples.slice(Math.floor(index * size), Math.max(Math.floor((index + 1) * size), Math.floor(index * size) + 1));
    return slice.length ? Math.max(...slice) : 0;
  });
  const peak = Math.max(...values, 0.01);
  return values.map(value => Math.round(Math.min(1, value / peak) * 100));
}

export class VoiceRecorder {
  state = 'idle';
  levels = [];
  startedAt = 0;
  onLevel = null;

  async start() {
    if (this.state !== 'idle') return false;
    this.state = 'starting';
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (this.state !== 'starting') { this.#releaseStream(); return false; } // cancelled while the prompt was open
      const mimeType = pickType();
      this.recorder = new MediaRecorder(this.stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: 48000 });
      this.chunks = [];
      this.levels = [];
      this.recorder.addEventListener('dataavailable', event => { if (event.data?.size) this.chunks.push(event.data); });
      this.#startMeter();
      this.recorder.start(250);
      this.startedAt = performance.now();
      this.state = 'recording';
      return true;
    } catch (error) {
      this.#cleanup();
      this.state = 'idle';
      if (error?.name === 'NotAllowedError') throw new Error('Microphone access was blocked. Allow it in your browser settings to record voice messages.');
      if (error?.name === 'NotFoundError') throw new Error('No microphone was found on this device.');
      throw error;
    }
  }

  elapsed() { return this.state === 'recording' ? performance.now() - this.startedAt : 0; }

  /** Stops and resolves with the recording, or null if it was too short to be meaningful. */
  stop() {
    if (this.state !== 'recording') return Promise.resolve(null);
    this.state = 'stopping';
    const durationMs = Math.round(performance.now() - this.startedAt);
    return new Promise(resolve => {
      this.recorder.addEventListener('stop', () => {
        const type = (this.recorder.mimeType || this.chunks[0]?.type || 'audio/webm').split(';')[0];
        const blob = new Blob(this.chunks, { type });
        const waveform = summariseWaveform(this.levels);
        this.#cleanup();
        this.state = 'idle';
        resolve(durationMs < 600 || blob.size < 500 ? null : { blob, type, durationMs, waveform });
      }, { once: true });
      try { this.recorder.requestData?.(); } catch { /* not all browsers allow it here */ }
      this.recorder.stop();
    });
  }

  cancel() {
    if (this.state === 'starting') { this.state = 'idle'; return; }
    if (this.state !== 'recording') return;
    this.state = 'stopping';
    this.recorder.addEventListener('stop', () => { this.#cleanup(); this.state = 'idle'; }, { once: true });
    this.recorder.stop();
  }

  #startMeter() {
    const Context = window.AudioContext || window.webkitAudioContext;
    if (!Context) return;
    try {
      this.context = new Context();
      const source = this.context.createMediaStreamSource(this.stream);
      const analyser = this.context.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      const data = new Uint8Array(analyser.fftSize);
      this.meter = setInterval(() => {
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (const value of data) { const centred = (value - 128) / 128; sum += centred * centred; }
        const level = Math.sqrt(sum / data.length);
        this.levels.push(level);
        this.onLevel?.(Math.min(1, level * 4));
      }, 60);
    } catch { /* the waveform is optional */ }
  }

  #releaseStream() { this.stream?.getTracks().forEach(track => track.stop()); this.stream = null; }

  #cleanup() {
    clearInterval(this.meter);
    this.meter = null;
    this.#releaseStream();
    this.context?.close?.().catch?.(() => {});
    this.context = null;
  }
}
