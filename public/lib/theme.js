/**
 * Light / Dark / AMOLED / System themes plus the appearance preferences that are applied globally
 * (font size, density, animation level). The browser chrome colour follows the theme so an
 * installed app's status bar always matches.
 */
import { onSettingsChange, settings, updateSettings } from './settings.js';

const media = window.matchMedia('(prefers-color-scheme: dark)');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const CHROME = { light: '#ffffff', dark: '#17171f', amoled: '#000000' };
export const THEMES = ['light', 'dark', 'amoled', 'system'];

export function themePreference() { return settings().appearance.theme; }

export function resolvedTheme(preference = themePreference()) {
  if (preference === 'system') return media.matches ? 'dark' : 'light';
  return THEMES.includes(preference) ? preference : 'light';
}

function applyNow() {
  const appearance = settings().appearance;
  const theme = resolvedTheme(appearance.theme);
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.dataset.scheme = theme === 'light' ? 'light' : 'dark';
  root.style.setProperty('--message-font', `${appearance.fontSize}px`);
  root.dataset.density = appearance.density;
  root.dataset.motion = reducedMotion.matches || appearance.animations === 'off' ? 'off' : appearance.animations;
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) meta.setAttribute('content', CHROME[theme]);
  try { localStorage.setItem('circle-theme', theme); } catch { /* boot script fallback only */ }
  document.dispatchEvent(new CustomEvent('themechange', { detail: { theme } }));
  return theme;
}

/** Applies the theme; with `animate`, cross-fades using the View Transitions API where available. */
export function applyTheme({ animate = false } = {}) {
  const before = document.documentElement.dataset.theme;
  if (animate && before !== resolvedTheme() && document.startViewTransition && document.documentElement.dataset.motion !== 'off') {
    const transition = document.startViewTransition(() => { applyNow(); });
    // Browsers reject these promises when a second theme change supersedes the first. That is a
    // normal cancellation, not a runtime error.
    transition.ready?.catch(() => {});
    transition.finished?.catch(() => {});
    transition.updateCallbackDone?.catch(() => {});
    return resolvedTheme();
  }
  return applyNow();
}

export function setThemePreference(preference) {
  updateSettings({ appearance: { theme: THEMES.includes(preference) ? preference : 'system' } }).catch(() => {});
  return applyTheme({ animate: true });
}

export function toggleTheme() {
  return setThemePreference(resolvedTheme() === 'light' ? 'dark' : 'light');
}

media.addEventListener?.('change', () => { if (themePreference() === 'system') applyTheme({ animate: true }); });
reducedMotion.addEventListener?.('change', () => applyTheme());
onSettingsChange((next, changed) => { if (changed?.appearance || changed === undefined) applyTheme({ animate: Boolean(changed?.appearance?.theme) }); });
