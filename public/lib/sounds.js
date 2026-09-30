/**
 * Short interface sounds, synthesised with the Web Audio API (no audio files). Mobile browsers only
 * allow audio after a user gesture, so the context is created on the first tap and reused.
 */
let context = null;
let lastPlayed = 0;

function ensureContext() {
  const Context = window.AudioContext || window.webkitAudioContext;
  if (!Context) return null;
  if (!context) context = new Context();
  if (context.state === 'suspended') context.resume().catch(() => {});
  return context;
}

document.addEventListener('pointerdown', () => { if (!context) ensureContext(); }, { once: true, capture: true });

function tone(ctx, frequency, start, duration, gain) {
  const oscillator = ctx.createOscillator();
  const volume = ctx.createGain();
  oscillator.type = 'sine';
  oscillator.frequency.setValueAtTime(frequency, start);
  volume.gain.setValueAtTime(0.0001, start);
  volume.gain.exponentialRampToValueAtTime(gain, start + 0.012);
  volume.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  oscillator.connect(volume).connect(ctx.destination);
  oscillator.start(start);
  oscillator.stop(start + duration + 0.02);
}

/** A soft two-note chime for incoming messages; bursts are rate-limited to one per second. */
export function playIncomingSound() {
  const now = Date.now();
  if (now - lastPlayed < 1000) return;
  lastPlayed = now;
  const ctx = ensureContext();
  if (!ctx || ctx.state !== 'running') return;
  const start = ctx.currentTime + 0.01;
  tone(ctx, 880, start, 0.16, 0.08);
  tone(ctx, 1320, start + 0.09, 0.22, 0.06);
}

/** A tiny tick when a message is sent. */
export function playSentSound() {
  const ctx = ensureContext();
  if (!ctx || ctx.state !== 'running') return;
  tone(ctx, 660, ctx.currentTime + 0.005, 0.09, 0.04);
}
