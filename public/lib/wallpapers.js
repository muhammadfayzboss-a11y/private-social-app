/**
 * Chat wallpapers — all original, generated from code (gradients, mesh blends, and SVG patterns),
 * so no third-party artwork is shipped. Every wallpaper declares its tone; a light wallpaper shown in
 * a dark theme is dimmed automatically so bubbles and service labels stay readable.
 */
import { t } from './i18n.js';

const svg = (content, size = 120) => `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' width='${size}' height='${size}' viewBox='0 0 ${size} ${size}'>${content}</svg>`)}")`;

const PATTERNS = {
  orbits: color => svg(`<g fill='none' stroke='${color}' stroke-width='1.6' stroke-linecap='round'>
    <path d='M18 30a12 12 0 1 1 20 9'/><circle cx='88' cy='22' r='5'/><path d='M70 70a16 16 0 0 1 26-12'/><circle cx='30' cy='92' r='8'/>
    <path d='M100 96l6 6M106 96l-6 6'/><circle cx='56' cy='46' r='2.5' fill='${color}'/><path d='M8 64q8-8 16 0t16 0'/><circle cx='104' cy='56' r='2' fill='${color}'/></g>`),
  dots: color => svg(`<g fill='${color}'><circle cx='10' cy='10' r='2'/><circle cx='40' cy='25' r='1.4'/><circle cx='25' cy='40' r='1.4'/></g>`, 50),
  waves: color => svg(`<path d='M0 20 Q15 8 30 20 T60 20 M0 45 Q15 33 30 45 T60 45' fill='none' stroke='${color}' stroke-width='1.5'/>`, 60),
  confetti: color => svg(`<g fill='${color}'><rect x='12' y='14' width='10' height='4' rx='2' transform='rotate(30 17 16)'/>
    <rect x='70' y='20' width='8' height='4' rx='2' transform='rotate(-25 74 22)'/><circle cx='45' cy='60' r='3'/><rect x='88' y='70' width='10' height='4' rx='2' transform='rotate(60 93 72)'/>
    <rect x='20' y='90' width='9' height='4' rx='2' transform='rotate(-40 24 92)'/><circle cx='100' cy='30' r='2'/><circle cx='60' cy='104' r='2.5'/></g>`),
  stars: color => svg(`<g fill='${color}'><path d='M20 10l2.4 5.6L28 18l-5.6 2.4L20 26l-2.4-5.6L12 18l5.6-2.4z'/><path d='M78 52l1.6 3.6 3.6 1.6-3.6 1.6L78 62l-1.6-3.6-3.6-1.6 3.6-1.6z'/>
    <circle cx='52' cy='24' r='1.6'/><circle cx='26' cy='74' r='1.4'/><path d='M96 96l2 4.4 4.4 2-4.4 2-2 4.4-2-4.4-4.4-2 4.4-2z'/></g>`),
  grid: color => svg(`<path d='M0 .5H40M.5 0V40' fill='none' stroke='${color}' stroke-width='1'/>`, 40)
};

const pattern = (name, color, base) => `${PATTERNS[name](color)}, ${base}`;

/** Theme-aware default: soft lavender by day, deep indigo at night, pure black on AMOLED. */
function defaultWallpaper(theme) {
  if (theme === 'amoled') return { background: pattern('orbits', 'rgba(255,255,255,.045)', '#000'), tone: 'dark' };
  if (theme === 'dark') return { background: pattern('orbits', 'rgba(255,255,255,.05)', 'linear-gradient(160deg,#171a2e,#1b1530 55%,#12131f)'), tone: 'dark' };
  return { background: pattern('orbits', 'rgba(90,70,190,.09)', 'linear-gradient(160deg,#e6e4fb,#efe4f7 50%,#e2ecf8)'), tone: 'light' };
}

export const WALLPAPERS = [
  { id: 'default', group: 'default', name: 'Default', render: defaultWallpaper },
  { id: 'plain', group: 'default', name: 'Plain', render: theme => ({ background: theme === 'light' ? '#eceef3' : theme === 'amoled' ? '#000' : '#15151d', tone: theme === 'light' ? 'light' : 'dark' }) },
  // Solid colours
  { id: 'mist', group: 'solid', name: 'Mist', render: () => ({ background: '#dfe6ef', tone: 'light' }) },
  { id: 'lavender', group: 'solid', name: 'Lavender', render: () => ({ background: '#e6e0f7', tone: 'light' }) },
  { id: 'mint', group: 'solid', name: 'Mint', render: () => ({ background: '#d9eee3', tone: 'light' }) },
  { id: 'sand', group: 'solid', name: 'Sand', render: () => ({ background: '#f1e6d8', tone: 'light' }) },
  { id: 'graphite', group: 'solid', name: 'Graphite', render: () => ({ background: '#1f1f28', tone: 'dark' }) },
  { id: 'midnight', group: 'solid', name: 'Midnight', render: () => ({ background: '#0e1a2b', tone: 'dark' }) },
  // Gradients
  { id: 'aurora', group: 'gradient', name: 'Aurora', render: () => ({ background: 'linear-gradient(150deg,#7c6cf0,#5aa9e6 60%,#6fd6c2)', tone: 'dark' }) },
  { id: 'sunset', group: 'gradient', name: 'Sunset', render: () => ({ background: 'linear-gradient(160deg,#ffb88c,#ff7e8f 55%,#c86dd7)', tone: 'dark' }) },
  { id: 'ocean', group: 'gradient', name: 'Ocean', render: () => ({ background: 'linear-gradient(160deg,#274b6d,#3f3d7a 60%,#1f2a44)', tone: 'dark' }) },
  { id: 'forest', group: 'gradient', name: 'Forest', render: () => ({ background: 'linear-gradient(160deg,#164e57,#3d7e62 55%,#8fb77a)', tone: 'dark' }) },
  { id: 'peach', group: 'gradient', name: 'Peach', render: () => ({ background: 'linear-gradient(160deg,#fde2c4,#f7c3cf 55%,#dcd0f7)', tone: 'light' }) },
  { id: 'dusk', group: 'gradient', name: 'Dusk', render: () => ({ background: 'linear-gradient(170deg,#1b2338,#2e2450 55%,#4a2c5c)', tone: 'dark' }) },
  // Patterns
  { id: 'pattern-dots', group: 'pattern', name: 'Dots', render: theme => theme === 'light'
    ? { background: pattern('dots', 'rgba(60,60,120,.14)', '#e9ebf3'), tone: 'light' } : { background: pattern('dots', 'rgba(255,255,255,.07)', '#14151f'), tone: 'dark' } },
  { id: 'pattern-waves', group: 'pattern', name: 'Waves', render: theme => theme === 'light'
    ? { background: pattern('waves', 'rgba(40,110,160,.12)', '#e1edf3'), tone: 'light' } : { background: pattern('waves', 'rgba(120,190,255,.07)', '#101a24'), tone: 'dark' } },
  { id: 'pattern-confetti', group: 'pattern', name: 'Confetti', render: theme => theme === 'light'
    ? { background: pattern('confetti', 'rgba(200,90,140,.13)', '#f5e9ef'), tone: 'light' } : { background: pattern('confetti', 'rgba(255,140,190,.08)', '#1c1219'), tone: 'dark' } },
  { id: 'pattern-stars', group: 'pattern', name: 'Stars', render: theme => theme === 'light'
    ? { background: pattern('stars', 'rgba(110,90,200,.14)', '#ebe8f8'), tone: 'light' } : { background: pattern('stars', 'rgba(255,255,255,.09)', 'linear-gradient(170deg,#0f1022,#1a1633)'), tone: 'dark' } },
  { id: 'pattern-grid', group: 'pattern', name: 'Grid', render: theme => theme === 'light'
    ? { background: pattern('grid', 'rgba(30,30,60,.06)', '#f1f2f6'), tone: 'light' } : { background: pattern('grid', 'rgba(255,255,255,.035)', '#121218'), tone: 'dark' } },
  // Abstract mesh blends
  { id: 'nebula', group: 'abstract', name: 'Nebula', render: () => ({ background: 'radial-gradient(at 20% 20%,#6a4cff 0,transparent 55%),radial-gradient(at 80% 10%,#ff5fa2 0,transparent 50%),radial-gradient(at 70% 85%,#2ec5d3 0,transparent 55%),#1a1433', tone: 'dark' }) },
  { id: 'lagoon', group: 'abstract', name: 'Lagoon', render: () => ({ background: 'radial-gradient(at 15% 80%,#29c5a6 0,transparent 55%),radial-gradient(at 85% 25%,#3a7bd5 0,transparent 55%),radial-gradient(at 50% 50%,#6fe3d3 0,transparent 40%),#0f2c3a', tone: 'dark' }) },
  { id: 'ember', group: 'abstract', name: 'Ember', render: () => ({ background: 'radial-gradient(at 25% 25%,#ff8a3d 0,transparent 55%),radial-gradient(at 80% 70%,#e0365f 0,transparent 55%),radial-gradient(at 60% 10%,#ffd166 0,transparent 45%),#3a1020', tone: 'dark' }) },
  { id: 'cloud', group: 'abstract', name: 'Cloud', render: () => ({ background: 'radial-gradient(at 20% 30%,#ffffff 0,transparent 55%),radial-gradient(at 80% 20%,#dcd6ff 0,transparent 55%),radial-gradient(at 60% 90%,#d1ecff 0,transparent 55%),#eceaf6', tone: 'light' }) }
];

export const WALLPAPER_GROUPS = [
  { id: 'default', label: () => t('Default') },
  { id: 'solid', label: () => t('Colors') },
  { id: 'gradient', label: () => t('Gradients') },
  { id: 'pattern', label: () => t('Patterns') },
  { id: 'abstract', label: () => t('Abstract') }
];

/**
 * Resolves a wallpaper preference to concrete styles for the given theme:
 * { background, blur, dim } where dim already includes any automatic dark-theme treatment.
 */
export function resolveWallpaper(preference = {}, theme = 'light') {
  const blur = Math.max(0, Math.min(24, Number(preference.blur) || 0));
  let dim = Math.max(0, Math.min(80, Number(preference.dim) || 0));
  let result;
  if (preference.id === 'custom' && preference.mediaId) {
    result = { background: `center / cover no-repeat url("/api/media/${Number(preference.mediaId)}"), #222`, tone: 'photo' };
  } else {
    const entry = WALLPAPERS.find(item => item.id === preference.id) || WALLPAPERS[0];
    result = entry.render(theme);
  }
  if (theme !== 'light' && (result.tone === 'light' || result.tone === 'photo')) dim = Math.max(dim, result.tone === 'photo' ? 30 : 45);
  return { ...result, blur, dim };
}

export function paintWallpaper(element, preference, theme) {
  const { background, blur, dim } = resolveWallpaper(preference, theme);
  element.style.background = background;
  element.style.setProperty('--wallpaper-dim', String(dim / 100));
  element.style.filter = blur ? `blur(${blur}px)` : '';
  element.style.transform = blur ? `scale(${1 + blur / 120})` : '';
}
