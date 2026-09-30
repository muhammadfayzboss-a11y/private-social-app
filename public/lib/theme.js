/** Light / Dark / System theme preference, applied to <html data-theme> and the browser chrome. */
const KEY = 'circle-theme';
const media = window.matchMedia('(prefers-color-scheme: dark)');
const COLORS = { light: '#ffffff', dark: '#17171c' };

export function themePreference() {
  const stored = localStorage.getItem(KEY);
  return stored === 'light' || stored === 'dark' ? stored : 'system';
}

export function resolvedTheme(preference = themePreference()) {
  return preference === 'system' ? (media.matches ? 'dark' : 'light') : preference;
}

export function applyTheme() {
  const theme = resolvedTheme();
  document.documentElement.dataset.theme = theme;
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) meta.setAttribute('content', COLORS[theme]);
  document.dispatchEvent(new CustomEvent('themechange', { detail: { theme, preference: themePreference() } }));
  return theme;
}

export function setThemePreference(preference) {
  if (preference === 'system') localStorage.removeItem(KEY);
  else localStorage.setItem(KEY, preference);
  return applyTheme();
}

/** Header shortcut: flips between an explicit light and dark choice. */
export function toggleTheme() {
  return setThemePreference(resolvedTheme() === 'dark' ? 'light' : 'dark');
}

media.addEventListener?.('change', () => { if (themePreference() === 'system') applyTheme(); });
