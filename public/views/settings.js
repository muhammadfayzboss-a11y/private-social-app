import { request, setCsrf } from '../api.js';
import { icon } from '../icons.js';
import { navigate } from '../router.js';
import { conversationById, loadMembers, resetState, state, subscribe } from '../store.js';
import { actionSheet, avatar, confirmSheet, emptyState, escapeHtml, group, listSkeleton, modal, row, toast, topBar } from '../ui.js';
import { exactTime, lastSeenText, relativeTime } from '../lib/time.js';
import { currentLanguage, LANGUAGES, locale, t, tn } from '../lib/i18n.js';
import { clearLocalSettings, clearPrivateLocalData, DEFAULTS, onSettingsChange, settings, updateSettings } from '../lib/settings.js';
import { resolvedTheme, setThemePreference } from '../lib/theme.js';
import { paintWallpaper, resolveWallpaper, WALLPAPER_GROUPS, WALLPAPERS } from '../lib/wallpapers.js';
import { openEditProfile } from './profile.js';
import { preparePhoto } from '../components/attach.js';
import { pickFiles, uploadFiles } from '../components/media.js';

const APP_VERSION = '3.0.2';
const COLORS = { blue: '#3b82f6', gray: '#8e8e93', red: '#ef4444', green: '#22b573', purple: '#8b5cf6', teal: '#14b8a6', orange: '#f59e0b', indigo: '#6366f1', pink: '#ec4899' };

/* --------------------------------- root --------------------------------- */

export function renderSettings(host) {
  const draw = () => {
    const user = state.user;
    const language = LANGUAGES.find(item => item.id === currentLanguage());
    host.innerHTML = `
      ${topBar({ title: t('Settings'), className: 'topbar-root', actions: `<button class="text-button" data-action="edit">${t('Edit')}</button>` })}
      <div class="screen-scroll" data-scroll>
        <button class="profile-card" data-href="/profile">
          ${avatar(user, 'lg')}
          <span class="profile-card-text"><strong>${escapeHtml(user.displayName)}</strong><small>@${escapeHtml(user.username)}</small><small class="online-text">${t('online')}</small></span>
          <span class="row-chevron">${icon('chevron', 18)}</span>
        </button>
        ${group([
          row({ iconName: 'user', color: COLORS.blue, label: t('Account'), href: '/settings/account' }),
          row({ iconName: 'lock2', color: COLORS.gray, label: t('Privacy and Security'), href: '/settings/privacy' }),
          row({ iconName: 'bell', color: COLORS.red, label: t('Notifications'), href: '/settings/notifications' }),
          row({ iconName: 'database', color: COLORS.green, label: t('Data and Storage'), href: '/settings/data' })
        ])}
        ${group([
          row({ iconName: 'palette', color: COLORS.purple, label: t('Appearance'), href: '/settings/appearance', value: escapeHtml(themeName(settings().appearance.theme)) }),
          row({ iconName: 'bubble', color: COLORS.blue, label: t('Chat Settings'), href: '/settings/chat' }),
          row({ iconName: 'wallpaper', color: COLORS.teal, label: t('Chat Background'), href: '/settings/background' }),
          row({ iconName: 'folder', color: COLORS.orange, label: t('Folders'), href: '/settings/folders', value: settings().folders.length ? String(settings().folders.length) : '' }),
          row({ iconName: 'devices', color: COLORS.indigo, label: t('Devices'), href: '/settings/devices' }),
          row({ iconName: 'globe', color: COLORS.pink, label: t('Language'), href: '/settings/language', value: escapeHtml(language.native) })
        ])}
        ${user.role === 'admin' ? group([
          row({ iconName: 'plus', color: COLORS.green, label: t('Invite friends'), href: '/settings/invites' }),
          row({ iconName: 'smile', color: COLORS.orange, label: t('Sticker packs'), action: 'reload-stickers', hint: t('Reload packs from the server’s stickers folder') })
        ], { title: t('Admin') }) : ''}
        ${group([
          !isStandalone() ? row({ iconName: 'install', color: COLORS.blue, label: t('Install app'), href: '/settings/install', hint: t('Add Circle to your home screen') }) : '',
          row({ iconName: 'help', color: COLORS.teal, label: t('Help and About'), href: '/settings/about', value: `v${APP_VERSION}` })
        ].filter(Boolean))}
        ${group([row({ label: t('Sign out'), action: 'logout', danger: true, chevron: false })])}
      </div>`;
  };

  host.addEventListener('click', async event => {
    const link = event.target.closest('[data-href]');
    if (link) return navigate(link.dataset.href);
    const action = event.target.closest('[data-action], [data-row]')?.dataset;
    const id = action?.action || action?.row;
    try {
      if (id === 'edit') openEditProfile();
      if (id === 'reload-stickers') {
        const { stickersLoaded } = await request('/api/stickers/reload', { method: 'POST' });
        toast(tn(stickersLoaded, '{n} sticker loaded', '{n} stickers loaded'));
      }
      if (id === 'logout') signOut();
    } catch (error) { toast(error.message, 'error'); }
  });

  const unsubscribe = subscribe(event => { if (event === 'members') draw(); });
  const unsubscribeSettings = onSettingsChange(() => draw());
  draw();
  return () => { unsubscribe(); unsubscribeSettings(); };
}

export async function signOut() {
  if (!(await confirmSheet({ title: t('Sign out of Circle?'), text: t('You will need your password to sign back in on this device.'), confirm: t('Sign out') }))) return;
  const { stopAll } = await import('../lib/audio.js');
  stopAll();
  try { await request('/api/auth/logout', { method: 'POST' }); } catch { /* the session may already be gone */ }
  const userId = state.user?.id;
  setCsrf(null);
  if (userId) clearPrivateLocalData(userId);
  const { resetRealtime } = await import('../realtime.js');
  resetRealtime();
  resetState();
  clearLocalSettings();
  // Private media must not stay on a shared device after signing out.
  try { await caches.delete('circle-media'); } catch { /* no cache */ }
  window.location.assign('/');
}

function isStandalone() {
  return window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
}

function themeName(theme) {
  return { light: t('Light'), dark: t('Dark'), amoled: t('AMOLED'), system: t('System') }[theme] || t('System');
}

/* --------------------------------- pages --------------------------------- */

const PAGES = {
  account: { title: 'Account', render: renderAccount },
  privacy: { title: 'Privacy and Security', render: renderPrivacy },
  blocked: { title: 'Blocked Users', render: renderBlocked, back: '/settings/privacy' },
  notifications: { title: 'Notifications', render: renderNotifications },
  data: { title: 'Data and Storage', render: renderData },
  appearance: { title: 'Appearance', render: renderAppearance },
  background: { title: 'Chat Background', render: renderBackground },
  chat: { title: 'Chat Settings', render: renderChatSettings },
  folders: { title: 'Folders', render: renderFolders },
  devices: { title: 'Devices', render: renderDevices },
  language: { title: 'Language', render: renderLanguage },
  about: { title: 'Help and About', render: renderAbout },
  invites: { title: 'Invite friends', render: renderInvites },
  install: { title: 'Install app', render: renderInstall }
};

export function renderSettingsPage(host, { page }) {
  const definition = PAGES[page];
  if (!definition) {
    host.innerHTML = `${topBar({ title: t('Settings'), back: '/settings' })}<div class="screen-scroll">${emptyState('alert', t('Page not found'), '')}</div>`;
    return null;
  }
  host.innerHTML = `${topBar({ title: t(definition.title), back: definition.back || '/settings' })}<div class="screen-scroll settings-page" data-scroll></div>`;
  const body = host.querySelector('[data-scroll]');
  body.addEventListener('click', event => {
    const link = event.target.closest('[data-href]');
    if (link) { event.stopPropagation(); navigate(link.dataset.href); }
  }, true);
  return definition.render(body, host) || null;
}

/** Wires toggles: rows with data-setting="section.key" flip that boolean and save it. */
function bindToggles(body, redraw) {
  body.addEventListener('click', event => {
    const target = event.target.closest('[data-setting]');
    if (!target) return;
    const [section, key] = target.dataset.setting.split('.');
    const next = !settings()[section][key];
    updateSettings({ [section]: { [key]: next } }).catch(error => toast(error.message, 'error'));
    target.querySelector('.switch')?.classList.toggle('on', next);
    target.querySelector('.switch')?.setAttribute('aria-checked', String(next));
    redraw?.();
  });
}

function toggleRow({ iconName, color, label, hint = '', setting }) {
  const [section, key] = setting.split('.');
  return row({ iconName, color, label, hint, toggle: Boolean(settings()[section][key]), attrs: `data-setting="${setting}"` });
}

function choice(options, current, name) {
  return `<div class="segmented" role="radiogroup">${options.map(([value, label]) => `<button role="radio" aria-checked="${value === current}" class="${value === current ? 'active' : ''}" data-choice="${name}" data-value="${value}">${label}</button>`).join('')}</div>`;
}

/* ------------------------------- account ------------------------------- */

function renderAccount(body) {
  const draw = () => {
    const user = state.user;
    body.innerHTML = `
      <div class="settings-hero">${avatar(user, 'xl')}<button class="text-button" data-row="edit">${t('Set new photo')}</button></div>
      ${group([
        row({ label: t('Name'), value: escapeHtml(user.displayName), action: 'edit' }),
        row({ label: t('Username'), value: `@${escapeHtml(user.username)}`, action: 'edit' }),
        row({ label: t('Bio'), value: escapeHtml(user.bio || t('Add')), action: 'edit' })
      ], { footer: t('Your name, username, and bio are visible to members of your circle only.') })}
      ${group([
        row({ label: t('Member since'), value: escapeHtml(new Date(user.createdAt).toLocaleDateString(locale(), { day: 'numeric', month: 'long', year: 'numeric' })), chevron: false }),
        row({ label: t('Role'), value: user.role === 'admin' ? t('Group admin') : t('Member'), chevron: false })
      ], { title: t('Account information') })}
      ${group([row({ label: t('Sign out'), action: 'logout', danger: true, chevron: false })])}`;
  };
  body.addEventListener('click', event => {
    const id = event.target.closest('[data-row]')?.dataset.row;
    if (id === 'edit') openEditProfile();
    if (id === 'logout') signOut();
  });
  const unsubscribe = subscribe(event => { if (event === 'members') draw(); });
  draw();
  return unsubscribe;
}

/* ------------------------------- privacy ------------------------------- */

function renderPrivacy(body) {
  let storyPrivacy = null;
  let blockedCount = null;
  const draw = () => {
    const privacy = state.user.privacy || { showLastSeen: true, readReceipts: true };
    body.innerHTML = `
      ${group([
        row({ iconName: 'eye', color: COLORS.green, label: t('Last seen & online'), value: privacy.showLastSeen ? t('Everybody') : t('Nobody'), action: 'last-seen' }),
        row({ iconName: 'checks', color: COLORS.blue, label: t('Read receipts'), toggle: privacy.readReceipts, action: 'read-receipts' })
      ], { title: t('Privacy'), footer: t('Turning read receipts off hides when you have read messages — and you won’t see other people’s read receipts either.') })}
      ${group([
        row({ iconName: 'camera', color: COLORS.orange, label: t('Hide my stories from'), value: storyPrivacy ? (storyPrivacy.hiddenFrom.length ? tn(storyPrivacy.hiddenFrom.length, '{n} person', '{n} people') : t('Nobody')) : '…', action: 'story-hidden' }),
        row({ iconName: 'reply', color: COLORS.purple, label: t('Allow replies to my stories'), toggle: settings().privacy.storyReplies, action: 'story-replies' }),
        row({ iconName: 'users', color: COLORS.gray, label: t('Story viewers'), value: t('Only you'), chevron: false })
      ], { title: t('Stories'), footer: t('Only you can ever see who viewed your stories. Hidden members can’t see your stories or open their media.') })}
      ${group([
        row({ iconName: 'block', color: COLORS.red, label: t('Blocked users'), value: blockedCount === null ? '' : String(blockedCount), href: '/settings/blocked' }),
        row({ iconName: 'devices', color: COLORS.indigo, label: t('Devices'), href: '/settings/devices' }),
        row({ iconName: 'user', color: COLORS.blue, label: t('Who can see my profile'), value: t('Circle members'), chevron: false })
      ], { title: t('Security'), footer: t('Circle is invite-only: nobody outside your circle can see your profile, posts, or messages.') })}`;
  };
  const savePrivacy = async changes => {
    const { user } = await request('/api/profile/privacy', { method: 'PATCH', body: changes });
    state.user = { ...state.user, ...user };
    draw();
  };
  body.addEventListener('click', async event => {
    const id = event.target.closest('[data-row]')?.dataset.row;
    try {
      if (id === 'last-seen') {
        const picked = await actionSheet({ title: t('Last seen & online'), header: `<p class="sheet-text">${t('When set to Nobody, members see “last seen recently” instead of your exact time.')}</p>`,
          actions: [{ id: 'everybody', label: t('Everybody'), icon: 'users' }, { id: 'nobody', label: t('Nobody'), icon: 'block' }] });
        if (picked) await savePrivacy({ showLastSeen: picked === 'everybody' });
      }
      if (id === 'read-receipts') await savePrivacy({ readReceipts: !(state.user.privacy?.readReceipts ?? true) });
      if (id === 'story-replies') { await updateSettings({ privacy: { storyReplies: !settings().privacy.storyReplies } }); draw(); }
      if (id === 'story-hidden') {
        const members = (await loadMembers(true)).filter(member => member.id !== state.user.id);
        const picked = await pickMembers({ title: t('Hide my stories from'), members, selected: storyPrivacy?.hiddenFrom || [], confirm: t('Save') });
        if (picked) { storyPrivacy = await request('/api/stories/privacy', { method: 'PUT', body: { hiddenFrom: picked } }); toast(t('Story privacy saved')); draw(); }
      }
    } catch (error) { toast(error.message, 'error'); }
  });
  draw();
  request('/api/stories/privacy').then(result => { storyPrivacy = result; draw(); }).catch(() => {});
  request('/api/blocks').then(result => { blockedCount = result.blocked.length; draw(); }).catch(() => {});
  return null;
}

/** Member multi-select sheet; resolves with the chosen ids or null when dismissed. */
function pickMembers({ title, members, selected = [], confirm }) {
  return new Promise(resolve => {
    const chosen = new Set(selected.map(Number));
    let result = null;
    const sheet = modal(`<div class="modal-head"><h2>${escapeHtml(title)}</h2><button class="icon-button" data-close-modal aria-label="${t('Close')}">${icon('close', 20)}</button></div>
      <div class="forward-list">${members.map(member => `<label class="forward-item"><input type="checkbox" value="${member.id}" ${chosen.has(member.id) ? 'checked' : ''}>${avatar(member, 'sm')}<span>${escapeHtml(member.displayName)}</span><i class="check-circle">${icon('check', 14)}</i></label>`).join('')}</div>
      <button class="button button-primary button-block" data-confirm>${escapeHtml(confirm)}</button>`);
    sheet.addEventListener('change', event => {
      if (event.target.type !== 'checkbox') return;
      if (event.target.checked) chosen.add(Number(event.target.value)); else chosen.delete(Number(event.target.value));
    });
    sheet.querySelector('[data-confirm]').addEventListener('click', () => { result = [...chosen]; sheet.close(); });
    sheet.addEventListener('sheet:closed', () => resolve(result), { once: true });
  });
}

function renderBlocked(body) {
  let blocked = null;
  const draw = () => {
    body.innerHTML = blocked === null ? listSkeleton(3) : `
      ${blocked.length ? group(blocked.map(member => `<div class="row member-row">${avatar(member, 'sm')}<span class="row-text"><span class="row-label">${escapeHtml(member.displayName)}</span><small>@${escapeHtml(member.username)} · ${t('blocked {time}', { time: escapeHtml(relativeTime(member.blockedAt)) })}</small></span>
          <button class="text-button" data-unblock="${member.id}">${t('Unblock')}</button></div>`), { footer: t('Blocked members can’t message you, see your last seen, or see your stories.') })
        : emptyState('block', t('Nobody is blocked'), t('Blocked members can’t message you, see your last seen, or see your stories.'))}
      ${group([row({ iconName: 'plus', color: COLORS.red, label: t('Block a member'), action: 'block' })])}`;
  };
  const load = () => request('/api/blocks').then(result => { blocked = result.blocked; draw(); }).catch(error => { body.innerHTML = emptyState('alert', t('Could not load'), error.message); });
  body.addEventListener('click', async event => {
    const unblock = event.target.closest('[data-unblock]');
    try {
      if (unblock) { await request(`/api/blocks/${unblock.dataset.unblock}`, { method: 'DELETE' }); toast(t('Member unblocked')); load(); }
      if (event.target.closest('[data-row="block"]')) {
        const members = (await loadMembers(true)).filter(member => member.id !== state.user.id && !blocked.some(item => item.id === member.id));
        const picked = await pickMembers({ title: t('Block a member'), members, confirm: t('Block') });
        for (const id of picked || []) await request('/api/blocks', { method: 'POST', body: { userId: id } });
        if (picked?.length) { toast(t('Blocked')); load(); }
      }
    } catch (error) { toast(error.message, 'error'); }
  });
  draw();
  load();
  return null;
}

/* ---------------------------- notifications ---------------------------- */

function renderNotifications(body) {
  const draw = () => {
    const permission = !('Notification' in window) ? 'unsupported' : Notification.permission;
    body.innerHTML = `
      ${group([
        toggleRow({ iconName: 'user', color: COLORS.blue, label: t('Private chats'), setting: 'notifications.messages' }),
        toggleRow({ iconName: 'users', color: COLORS.green, label: t('Groups'), setting: 'notifications.groups' }),
        toggleRow({ iconName: 'bubble', color: COLORS.purple, label: t('Mentions'), hint: t('Even in muted groups'), setting: 'notifications.mentions' }),
        toggleRow({ iconName: 'heart', color: COLORS.red, label: t('Reactions'), setting: 'notifications.reactions' }),
        toggleRow({ iconName: 'camera', color: COLORS.orange, label: t('New stories'), setting: 'notifications.stories' })
      ], { title: t('Notify me about'), footer: t('These apply to push notifications on all your devices. Mute a single chat from its menu.') })}
      ${group([
        toggleRow({ iconName: 'bell', color: COLORS.teal, label: t('In-app banners'), setting: 'notifications.inApp' }),
        toggleRow({ iconName: 'speed', color: COLORS.indigo, label: t('Sounds'), setting: 'notifications.sound' }),
        toggleRow({ iconName: 'devices', color: COLORS.gray, label: t('Vibration'), setting: 'notifications.vibrate' }),
        toggleRow({ iconName: 'eye', color: COLORS.blue, label: t('Message preview'), hint: t('Show text in notifications'), setting: 'notifications.preview' })
      ], { title: t('While using the app') })}
      ${group([
        row({ iconName: 'bell', color: COLORS.red, label: permission === 'granted' ? t('Push notifications are on') : t('Enable push notifications'),
          hint: permission === 'denied' ? t('Blocked — allow notifications in your browser or phone settings.') : permission === 'unsupported' ? t('Not supported here. On iPhone, install Circle to the Home Screen first.') : t('Get notified when the app is closed.'),
          action: permission === 'granted' ? 'disable-push' : 'enable-push', chevron: false })
      ], { title: t('This device') })}`;
  };
  bindToggles(body);
  body.addEventListener('click', async event => {
    const id = event.target.closest('[data-row]')?.dataset.row;
    try {
      if (id === 'enable-push') { const { enablePush } = await import('../push.js'); await enablePush(); draw(); }
      if (id === 'disable-push') { const { disablePush } = await import('../push.js'); await disablePush(); draw(); }
    } catch (error) { toast(error.message, 'error'); }
  });
  draw();
  return null;
}

/* ------------------------------ data & storage ------------------------------ */

async function cacheStats() {
  const result = { usage: null, quota: null, media: 0, app: 0 };
  try { const estimate = await navigator.storage?.estimate?.(); result.usage = estimate?.usage ?? null; result.quota = estimate?.quota ?? null; } catch { /* unsupported */ }
  try {
    for (const name of await caches.keys()) {
      const keys = await (await caches.open(name)).keys();
      if (name === 'circle-media') result.media = keys.length; else result.app += keys.length;
    }
  } catch { /* no cache api */ }
  return result;
}

function renderData(body) {
  const format = bytes => bytes === null ? '—' : bytes < 1048576 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
  let stats = null;
  const draw = () => {
    const saveData = navigator.connection?.saveData;
    body.innerHTML = `
      ${group([
        row({ iconName: 'database', color: COLORS.green, label: t('Used on this device'), value: stats ? format(stats.usage) : '…', chevron: false }),
        row({ iconName: 'install', color: COLORS.blue, label: t('Offline app files'), value: stats ? tn(stats.app, '{n} file', '{n} files') : '…', chevron: false }),
        row({ iconName: 'trash', color: COLORS.red, label: t('Clear temporary cache'), hint: t('Removes stale offline files and rebuilds a clean app shell.'), action: 'clear', chevron: false }),
        row({ iconName: 'trash', color: COLORS.gray, label: t('Clear drafts and recent searches'), action: 'clear-local', chevron: false })
      ], { title: t('Storage usage'), footer: t('Private media uses the browser’s protected HTTP cache, which your phone manages automatically. Messages always stay on the server.') })}
      ${group([
        toggleRow({ iconName: 'image', color: COLORS.purple, label: t('Photos'), setting: 'data.autoPhotos' }),
        toggleRow({ iconName: 'camera', color: COLORS.orange, label: t('Videos'), setting: 'data.autoVideos' })
      ], { title: t('Automatic media download'), footer: saveData ? t('Your device’s data saver is on — consider turning automatic downloads off.') : t('When off, tap a photo or video to load it. Useful on mobile data.') })}`;
  };
  bindToggles(body);
  body.addEventListener('click', async event => {
    const action = event.target.closest('[data-row]')?.dataset.row;
    if (action === 'clear') {
      if (!(await confirmSheet({ title: t('Clear temporary cache?'), text: t('Offline app files are rebuilt. Messages and media are not deleted.'), confirm: t('Clear cache') }))) return;
      try {
        for (const key of await caches.keys()) await caches.delete(key);
        const registration = await navigator.serviceWorker?.getRegistration();
        await registration?.unregister();
        await navigator.serviceWorker?.register('/sw.js');
      } catch { /* cache/service worker may be unavailable */ }
      toast(t('Cache cleared'));
      stats = await cacheStats();
      draw();
    }
    if (action === 'clear-local') {
      clearPrivateLocalData(state.user.id);
      toast(t('Drafts and searches cleared'));
    }
  });
  draw();
  cacheStats().then(result => { stats = result; draw(); });
  return null;
}

/* ------------------------------- appearance ------------------------------- */

function themePreviewCard(theme, current) {
  return `<button class="theme-card${current === theme ? ' active' : ''}" data-theme-choice="${theme}" aria-pressed="${current === theme}">
    <span class="theme-preview theme-preview-${theme}"><i></i><i></i><i></i></span><span>${themeName(theme)}</span></button>`;
}

function renderAppearance(body) {
  const draw = () => {
    const appearance = settings().appearance;
    body.innerHTML = `
      ${group([`<div class="theme-cards">${['light', 'dark', 'amoled', 'system'].map(theme => themePreviewCard(theme, appearance.theme)).join('')}</div>`], { title: t('Theme') })}
      ${group([row({ iconName: 'wallpaper', color: COLORS.teal, label: t('Chat Background'), href: '/settings/background' })])}
      ${group([`<div class="font-preview" data-font-preview>
          <div class="preview-bubble in" style="font-size:${appearance.fontSize}px">${t('Good morning! 👋')}</div>
          <div class="preview-bubble out" style="font-size:${appearance.fontSize}px">${t('Morning! Coffee at 10?')}</div>
        </div>
        <div class="slider-row"><span class="slider-a small">A</span><input type="range" min="13" max="21" step="1" value="${appearance.fontSize}" data-font aria-label="${t('Message text size')}"><span class="slider-a large">A</span></div>`], { title: t('Message text size') })}
      ${group([`<div class="padded">${choice([['comfortable', t('Comfortable')], ['compact', t('Compact')]], appearance.density, 'density')}</div>`], { title: t('Message density') })}
      ${group([`<div class="padded">${choice([['relative', t('Just now, 5m…')], ['clock', t('Clock (14:05)')]], appearance.bubbleTime, 'bubbleTime')}</div>`], { title: t('Time in messages') })}
      ${group([`<div class="padded">${choice([['full', t('Full')], ['reduced', t('Reduced')], ['off', t('Off')]], appearance.animations, 'animations')}</div>`], { title: t('Animations'), footer: t('Reduced keeps essential transitions; Off removes motion entirely. Your device’s reduce-motion setting is always respected.') })}`;
  };
  body.addEventListener('click', event => {
    const theme = event.target.closest('[data-theme-choice]');
    if (theme) { setThemePreference(theme.dataset.themeChoice); return setTimeout(draw, 20); }
    const option = event.target.closest('[data-choice]');
    if (option) { updateSettings({ appearance: { [option.dataset.choice]: option.dataset.value } }).catch(() => {}); draw(); }
  });
  body.addEventListener('input', event => {
    if (!event.target.matches('[data-font]')) return;
    const size = Number(event.target.value);
    body.querySelectorAll('[data-font-preview] .preview-bubble').forEach(bubble => { bubble.style.fontSize = `${size}px`; });
    updateSettings({ appearance: { fontSize: size } }).catch(() => {});
  });
  draw();
  return null;
}

/* ------------------------------ chat background ------------------------------ */

function renderBackground(body) {
  let preview = { ...settings().appearance.wallpaper };
  const theme = () => document.documentElement.dataset.theme;
  const draw = () => {
    body.innerHTML = `
      <div class="wallpaper-preview"><div class="chat-wallpaper" data-preview-wallpaper></div>
        <div class="wallpaper-sample">
          <span class="day-separator"><span>${t('Today')}</span></span>
          <div class="preview-bubble in">${t('How does this background look?')}</div>
          <div class="preview-bubble out">${t('Readable and calm — love it!')}</div>
        </div></div>
      ${group([`<div class="padded slider-stack">
          <label class="slider-label">${t('Blur')}<input type="range" min="0" max="24" step="1" value="${preview.blur}" data-wallpaper-blur></label>
          <label class="slider-label">${t('Dim')}<input type="range" min="0" max="80" step="5" value="${preview.dim}" data-wallpaper-dim></label>
        </div>`], { title: t('Adjust'), footer: theme() === 'light' ? '' : t('In dark themes bright wallpapers are dimmed automatically so messages stay readable.') })}
      ${group([
        row({ iconName: 'image', color: COLORS.blue, label: t('Upload from device'), action: 'upload' }),
        row({ iconName: 'close', color: COLORS.gray, label: t('Reset to default'), action: 'reset', chevron: false })
      ])}
      ${WALLPAPER_GROUPS.map(section => group([`<div class="wallpaper-grid">${WALLPAPERS.filter(item => item.group === section.id).map(item => {
        const look = resolveWallpaper({ id: item.id }, theme());
        return `<button class="wallpaper-tile${preview.id === item.id ? ' active' : ''}" data-wallpaper="${item.id}" style="background:${look.background.replace(/"/g, '&quot;')}" aria-label="${escapeHtml(t(item.name))}"><span>${escapeHtml(t(item.name))}</span></button>`;
      }).join('')}${section.id === 'default' && preview.id === 'custom' ? `<button class="wallpaper-tile active" data-wallpaper="custom" style="background:${resolveWallpaper(preview, theme()).background.replace(/"/g, '&quot;')}"><span>${t('Your photo')}</span></button>` : ''}</div>`], { title: section.label() })).join('')}
      <div class="sticky-apply"><button class="button button-primary button-block" data-apply>${t('Apply background')}</button></div>`;
    paintWallpaper(body.querySelector('[data-preview-wallpaper]'), preview, theme());
  };
  const repaint = () => paintWallpaper(body.querySelector('[data-preview-wallpaper]'), preview, theme());
  body.addEventListener('click', async event => {
    const tile = event.target.closest('[data-wallpaper]');
    if (tile) { preview = { ...preview, id: tile.dataset.wallpaper, mediaId: tile.dataset.wallpaper === 'custom' ? preview.mediaId : null }; draw(); return; }
    const id = event.target.closest('[data-row]')?.dataset.row;
    try {
      if (id === 'reset') { preview = { ...DEFAULTS.appearance.wallpaper }; draw(); }
      if (id === 'upload') {
        const files = await pickFiles('image/*', false);
        if (!files.length) return;
        toast(t('Uploading…'));
        const prepared = await preparePhoto(files[0]);
        const [media] = await uploadFiles([prepared.file], 'wallpaper', prepared);
        preview = { id: 'custom', mediaId: media.id, blur: preview.blur, dim: Math.max(preview.dim, 10) };
        draw();
      }
    } catch (error) { toast(error.message, 'error'); }
    if (event.target.closest('[data-apply]')) {
      try { await updateSettings({ appearance: { wallpaper: preview } }); toast(t('Background applied')); } catch (error) { toast(error.message, 'error'); }
    }
  });
  body.addEventListener('input', event => {
    if (event.target.matches('[data-wallpaper-blur]')) { preview.blur = Number(event.target.value); repaint(); }
    if (event.target.matches('[data-wallpaper-dim]')) { preview.dim = Number(event.target.value); repaint(); }
  });
  const onTheme = () => draw();
  document.addEventListener('themechange', onTheme);
  draw();
  return () => document.removeEventListener('themechange', onTheme);
}

/* ------------------------------- chat settings ------------------------------- */

function renderChatSettings(body) {
  const draw = () => {
    body.innerHTML = `
      ${group([
        toggleRow({ iconName: 'keyboard', color: COLORS.blue, label: t('Send with Enter'), hint: t('Enter sends; Shift+Enter adds a new line'), setting: 'chat.enterToSend' }),
        toggleRow({ iconName: 'link', color: COLORS.teal, label: t('Link previews'), setting: 'chat.linkPreviews' }),
        toggleRow({ iconName: 'bubble', color: COLORS.purple, label: t('Show when I’m typing'), setting: 'chat.typingIndicators' })
      ], { title: t('Messages') })}
      ${group([
        row({ iconName: 'checks', color: COLORS.green, label: t('Read receipts'), value: state.user.privacy?.readReceipts === false ? t('Off') : t('On'), href: '/settings/privacy' })
      ], { footer: t('Read receipts are part of your privacy settings.') })}
      ${group([
        toggleRow({ iconName: 'mic', color: COLORS.red, label: t('Hold to record'), hint: t('Off: tap the microphone to start and stop'), setting: 'chat.sendByHold' }),
        toggleRow({ iconName: 'play', color: COLORS.orange, label: t('Play voice messages in a row'), setting: 'chat.autoplayVoice' }),
        `<div class="padded"><p class="slider-label">${t('Default playback speed')}</p>${choice([['1', '1×'], ['1.5', '1.5×'], ['2', '2×']], String(settings().chat.voiceSpeed), 'voiceSpeed')}</div>`
      ], { title: t('Voice messages') })}`;
  };
  bindToggles(body);
  body.addEventListener('click', async event => {
    const option = event.target.closest('[data-choice="voiceSpeed"]');
    if (option) {
      const speed = Number(option.dataset.value);
      updateSettings({ chat: { voiceSpeed: speed } }).catch(() => {});
      (await import('../lib/audio.js')).setPlaybackRate(speed);
      draw();
    }
  });
  draw();
  return null;
}

/* ---------------------------------- folders ---------------------------------- */

function renderFolders(body) {
  const draw = () => {
    const folders = settings().folders;
    body.innerHTML = `
      <div class="settings-hero">${icon('folder', 48)}<p class="field-hint centered">${t('Create folders for different groups of chats and switch between them quickly from the chat list.')}</p></div>
      ${group([
        ...folders.map(folder => row({ iconName: 'folder', color: COLORS.orange, label: escapeHtml(folder.name), hint: folderSummary(folder), action: `edit:${folder.id}` })),
        row({ iconName: 'plus', color: COLORS.blue, label: t('Create a folder'), action: 'create', chevron: false })
      ], { title: t('My folders'), footer: t('Built-in folders — All, Unread, Personal, Groups — are always available.') })}`;
  };
  body.addEventListener('click', event => {
    const id = event.target.closest('[data-row]')?.dataset.row;
    if (!id) return;
    if (id === 'create') editFolder(null, draw);
    if (id.startsWith('edit:')) editFolder(settings().folders.find(folder => folder.id === id.slice(5)), draw);
  });
  const unsubscribe = onSettingsChange((next, changed) => { if (changed?.folders) draw(); });
  draw();
  return unsubscribe;
}

function folderSummary(folder) {
  const parts = [];
  if (folder.direct) parts.push(t('Personal'));
  if (folder.groups) parts.push(t('Groups'));
  if (folder.chatIds.length) parts.push(tn(folder.chatIds.length, '{n} chat', '{n} chats'));
  if (folder.unreadOnly) parts.push(t('unread only'));
  return escapeHtml(parts.join(' · ') || t('Empty'));
}

function editFolder(folder, onDone) {
  const draft = folder ? structuredClone(folder) : { id: `f${Date.now().toString(36)}`, name: '', direct: false, groups: false, unreadOnly: false, chatIds: [] };
  const chats = state.conversations.items;
  const sheet = modal(`
    <div class="modal-head"><h2>${folder ? t('Edit folder') : t('New folder')}</h2><button class="icon-button" data-close-modal aria-label="${t('Close')}">${icon('close', 20)}</button></div>
    <div class="field"><input data-name maxlength="24" value="${escapeHtml(draft.name)}" placeholder="${t('Folder name')}" aria-label="${t('Folder name')}"></div>
    <div class="group-body">
      ${row({ label: t('All personal chats'), toggle: draft.direct, attrs: 'data-flag="direct"' })}
      ${row({ label: t('All groups'), toggle: draft.groups, attrs: 'data-flag="groups"' })}
      ${row({ label: t('Only unread chats'), toggle: draft.unreadOnly, attrs: 'data-flag="unreadOnly"' })}
    </div>
    <h3 class="sheet-section">${t('Included chats')}</h3>
    <div class="forward-list">${chats.map(chat => `<label class="forward-item"><input type="checkbox" value="${chat.id}" ${draft.chatIds.includes(chat.id) ? 'checked' : ''}>
      <span class="avatar avatar-sm avatar-group">${icon(chat.kind === 'group' ? 'users' : 'user', 16)}</span><span>${escapeHtml(chat.title)}</span><i class="check-circle">${icon('check', 14)}</i></label>`).join('')}</div>
    <button class="button button-primary button-block" data-save>${t('Save folder')}</button>
    ${folder ? `<button class="button button-ghost button-block danger-text" data-delete>${t('Delete folder')}</button>` : ''}`);
  sheet.addEventListener('click', event => {
    const flag = event.target.closest('[data-flag]');
    if (flag) { draft[flag.dataset.flag] = !draft[flag.dataset.flag]; flag.querySelector('.switch').classList.toggle('on', draft[flag.dataset.flag]); }
    if (event.target.closest('[data-save]')) {
      draft.name = sheet.querySelector('[data-name]').value.trim();
      if (!draft.name) return toast(t('Give the folder a name'), 'error');
      const folders = settings().folders.filter(item => item.id !== draft.id);
      const index = settings().folders.findIndex(item => item.id === draft.id);
      folders.splice(index >= 0 ? index : folders.length, 0, draft);
      updateSettings({ folders }).catch(error => toast(error.message, 'error'));
      sheet.close();
      onDone();
    }
    if (event.target.closest('[data-delete]')) {
      updateSettings({ folders: settings().folders.filter(item => item.id !== draft.id) }).catch(error => toast(error.message, 'error'));
      sheet.close();
      onDone();
    }
  });
  sheet.addEventListener('change', event => {
    if (event.target.type !== 'checkbox') return;
    const chatId = Number(event.target.value);
    draft.chatIds = event.target.checked ? [...new Set([...draft.chatIds, chatId])] : draft.chatIds.filter(id => id !== chatId);
  });
}

/* ---------------------------------- devices ---------------------------------- */

function renderDevices(body) {
  let sessions = null;
  const deviceRow = session => `<div class="row device-row">${icon(/iPhone|Android|iPad/.test(session.device.os) ? 'devices' : 'monitor', 24)}
    <span class="row-text"><span class="row-label">${escapeHtml(session.device.label)}</span><small title="${escapeHtml(exactTime(session.lastActiveAt))}">${session.current ? t('This device · online') : t('Last active {time}', { time: escapeHtml(relativeTime(session.lastActiveAt)) })}</small></span>
    ${session.current ? '' : `<button class="text-button danger-text" data-end="${session.id}">${t('End')}</button>`}</div>`;
  const draw = () => {
    if (!sessions) { body.innerHTML = listSkeleton(3); return; }
    const current = sessions.find(session => session.current);
    const others = sessions.filter(session => !session.current);
    body.innerHTML = `
      ${group([current ? deviceRow(current) : ''], { title: t('This device') })}
      ${others.length ? `${group([row({ iconName: 'logout', color: COLORS.red, label: t('Terminate all other sessions'), action: 'end-all', danger: true, chevron: false })], { footer: t('Signs out every device except this one.') })}
        ${group(others.map(deviceRow), { title: t('Active sessions') })}` : `<p class="group-footer">${t('No other devices are signed in.')}</p>`}`;
  };
  const load = () => request('/api/sessions').then(result => { sessions = result.sessions; draw(); }).catch(error => { body.innerHTML = emptyState('alert', t('Could not load'), error.message); });
  body.addEventListener('click', async event => {
    try {
      const end = event.target.closest('[data-end]');
      if (end) { await request(`/api/sessions/${end.dataset.end}`, { method: 'DELETE' }); toast(t('Session ended')); load(); }
      if (event.target.closest('[data-row="end-all"]')) {
        if (!(await confirmSheet({ title: t('Terminate all other sessions?'), text: t('Every other phone and browser will be signed out.'), confirm: t('Terminate') }))) return;
        const { removed } = await request('/api/sessions/terminate-others', { method: 'POST' });
        toast(tn(removed, '{n} session ended', '{n} sessions ended'));
        load();
      }
    } catch (error) { toast(error.message, 'error'); }
  });
  draw();
  load();
  return null;
}

/* --------------------------------- language --------------------------------- */

function renderLanguage(body) {
  body.innerHTML = group(LANGUAGES.map(language => `<button class="row" data-language="${language.id}">
    <span class="row-text"><span class="row-label">${escapeHtml(language.native)}</span><small>${escapeHtml(language.name)}</small></span>
    ${language.id === currentLanguage() ? `<span class="row-check">${icon('check', 20)}</span>` : ''}</button>`), { footer: t('Dates and times follow the chosen language.') });
  body.addEventListener('click', event => {
    const option = event.target.closest('[data-language]');
    if (!option || option.dataset.language === currentLanguage()) return;
    updateSettings({ language: option.dataset.language }).catch(() => {});
  });
  return null;
}

/* ----------------------------------- about ----------------------------------- */

function renderAbout(body) {
  const faq = [
    [t('How do I install Circle on my phone?'), t('On iPhone open Circle in Safari, tap Share, then Add to Home Screen. On Android open it in Chrome and choose Install app from the menu.')],
    [t('Why don’t I get notifications?'), t('Turn on push in Settings → Notifications on each device. On iPhone, notifications only work from the installed Home Screen app (iOS 16.4 or later).')],
    [t('How do I send a voice message?'), t('Press and hold the microphone, speak, and release to send. Slide left to cancel, or slide up to lock and record hands-free.')],
    [t('Who can see my stories and who viewed them?'), t('Everyone in your circle except the people you hide them from. Only you can see who viewed your stories.')],
    [t('What does “Delete for me” do?'), t('It removes messages from your history only. “Delete for everyone” removes your own messages for all members.')]
  ];
  body.innerHTML = `
    <div class="settings-hero"><span class="app-icon-large">${icon('lock', 34)}</span><strong>Circle</strong><small>${t('Version {version}', { version: APP_VERSION })}</small></div>
    ${group(faq.map(([question, answer]) => `<details class="faq"><summary>${escapeHtml(question)}</summary><p>${escapeHtml(answer)}</p></details>`), { title: t('Help') })}
    ${group([`<div class="padded legal"><p>${t('Circle is a private, invite-only space for a small group of friends. Accounts are created only with an invitation from the group admin.')}</p>
      <p>${t('Be kind. Don’t share anything you don’t have the right to share, and respect other members’ privacy. The admin can remove content that breaks the group’s trust.')}</p></div>`], { title: t('Terms') })}
    ${group([`<div class="padded legal"><p>${t('Your messages, posts, stories, and media are stored on the server run by your group admin and are visible only to members of your circle (private chats only to their members).')}</p>
      <p>${t('Circle has no ads, no tracking, and no third-party analytics. Passwords are stored as salted hashes. Link previews are fetched by the server, so websites never see your address.')}</p></div>`], { title: t('Privacy') })}`;
  return null;
}

/* ---------------------------------- invites ---------------------------------- */

function renderInvites(body) {
  let invites = null;
  const draw = () => {
    body.innerHTML = `
      ${group([row({ iconName: 'plus', color: COLORS.green, label: t('Create invite code'), hint: t('Single-use, expires in 7 days'), action: 'create', chevron: false })],
        { footer: t('Share each code privately with one friend. Without a code nobody can join.') })}
      ${invites === null ? listSkeleton(2) : invites.length ? group(invites.map(invite => row({
        iconName: invite.claimedAt ? 'check' : 'clock', color: invite.claimedAt ? COLORS.green : COLORS.gray, label: escapeHtml(invite.label || t('Invite')),
        hint: invite.claimedAt ? t('Used {time}', { time: escapeHtml(relativeTime(invite.claimedAt)) }) : new Date(invite.expiresAt) < new Date() ? t('Expired') : t('Expires {time}', { time: escapeHtml(new Date(invite.expiresAt).toLocaleDateString(locale())) }),
        chevron: false
      })), { title: t('Invites') }) : ''}`;
  };
  const load = () => request('/api/invites').then(result => { invites = result.invites; draw(); }).catch(() => { invites = []; draw(); });
  body.addEventListener('click', async event => {
    if (!event.target.closest('[data-row="create"]')) return;
    try {
      const { code, expiresAt } = await request('/api/invites', { method: 'POST', body: { label: t('Circle invite'), days: 7 } });
      const sheet = modal(`<div class="modal-head"><h2>${t('Invite code')}</h2><button class="icon-button" data-close-modal aria-label="${t('Close')}">${icon('close', 20)}</button></div>
        <p class="field-hint">${t('Share this code privately. It works once and expires {date}.', { date: escapeHtml(new Date(expiresAt).toLocaleDateString(locale())) })}</p>
        <div class="invite-result">${escapeHtml(code)}</div>
        <button class="button button-primary button-block" data-copy>${t('Copy code')}</button>
        ${navigator.share ? `<button class="button button-block" data-share>${t('Share…')}</button>` : ''}`);
      sheet.querySelector('[data-copy]').addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(code); toast(t('Invite code copied')); } catch { toast(t('Copy failed — select the code manually'), 'error'); }
      });
      sheet.querySelector('[data-share]')?.addEventListener('click', () => navigator.share({ text: t('Join me on Circle: {url} — your invite code is {code}', { url: window.location.origin, code }) }).catch(() => {}));
      load();
    } catch (error) { toast(error.message, 'error'); }
  });
  draw();
  load();
  return null;
}

/* ---------------------------------- install ---------------------------------- */

function renderInstall(body) {
  const ios = /iP(hone|ad|od)/.test(navigator.userAgent);
  const draw = () => {
    body.innerHTML = `
      <div class="settings-hero"><span class="app-icon-large">${icon('lock', 34)}</span><strong>${t('Install Circle')}</strong><small>${t('Opens full screen like a native app, with notifications and a home-screen icon.')}</small></div>
      ${state.installPrompt ? `<div class="padded"><button class="button button-primary button-block" data-install>${icon('install', 20)} ${t('Install app')}</button></div>` : ''}
      ${group(ios ? [
        `<div class="install-step"><b>1</b><span>${t('Open this page in Safari.')}</span></div>`,
        `<div class="install-step"><b>2</b><span>${t('Tap the Share button')} ${icon('share', 18)}</span></div>`,
        `<div class="install-step"><b>3</b><span>${t('Choose “Add to Home Screen”, then Add.')}</span></div>`
      ] : [
        `<div class="install-step"><b>1</b><span>${t('Open this page in Chrome.')}</span></div>`,
        `<div class="install-step"><b>2</b><span>${t('Tap the menu ⋮ in the top corner.')}</span></div>`,
        `<div class="install-step"><b>3</b><span>${t('Choose “Install app” or “Add to Home screen”.')}</span></div>`
      ], { title: ios ? 'iPhone & iPad' : 'Android', footer: t('Then open Circle from its new icon. Enable notifications from Settings → Notifications.') })}`;
  };
  body.addEventListener('click', async event => {
    if (!event.target.closest('[data-install]') || !state.installPrompt) return;
    state.installPrompt.prompt();
    try { await state.installPrompt.userChoice; } catch { /* dismissed */ }
    state.installPrompt = null;
    draw();
  });
  draw();
  return null;
}

export { conversationById, lastSeenText, resolvedTheme };
