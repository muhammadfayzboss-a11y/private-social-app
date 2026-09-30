/**
 * Minimal i18n. English text is the key, so untranslated strings still read correctly, and
 * `{name}` placeholders are filled from params. Plurals: tn(count, 'one form', 'other form').
 */
import uz from './locales/uz.js';

const dictionaries = { uz };
export const LANGUAGES = [
  { id: 'en', name: 'English', native: 'English' },
  { id: 'uz', name: 'Uzbek', native: 'Oʻzbekcha' }
];
let language = 'en';

export function setLanguage(value) {
  language = value === 'uz' ? 'uz' : 'en';
  document.documentElement.lang = language === 'uz' ? 'uz-Latn' : 'en';
  return language;
}

export function currentLanguage() { return language; }

/** Locale for Intl date/number formatting. */
export function locale() { return language === 'uz' ? 'uz-Latn-UZ' : undefined; }

function fill(template, params) {
  return params ? template.replace(/\{(\w+)\}/g, (match, key) => (params[key] ?? match)) : template;
}

export function t(text, params) {
  const translated = language !== 'en' ? dictionaries[language]?.[text] : null;
  return fill(translated || text, params);
}

export function tn(count, one, other, params = {}) {
  return t(Number(count) === 1 ? one : other, { n: count, ...params });
}
