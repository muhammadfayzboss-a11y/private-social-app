import { request } from '../api.js';
import { icon } from '../icons.js';
import { goBack, navigate } from '../router.js';
import { conversationById, loadConversations, state } from '../store.js';
import { avatar, emptyState, escapeHtml, listSkeleton, toast } from '../ui.js';
import { relativeTime } from '../lib/time.js';
import { t } from '../lib/i18n.js';
import { chatRowMarkup } from '../components/chatRow.js';
import { formatBytes, previewText } from '../components/messages.js';

const recentKey = () => `circle-recent-searches-${state.user?.id || 'anonymous'}`;
const FILTERS = [
  { id: 'all', label: 'All' }, { id: 'messages', label: 'Messages' }, { id: 'media', label: 'Media' },
  { id: 'files', label: 'Files' }, { id: 'links', label: 'Links' }, { id: 'voice', label: 'Voice' }
];

function recent() { try { return JSON.parse(localStorage.getItem(recentKey()) || '[]'); } catch { return []; } }
function remember(query) {
  const next = [query, ...recent().filter(item => item !== query)].slice(0, 10);
  try { localStorage.setItem(recentKey(), JSON.stringify(next)); } catch { /* storage full */ }
}

function highlight(text, query) {
  const source = String(text || '');
  if (!query) return escapeHtml(source.slice(0, 140));
  const index = source.toLowerCase().indexOf(query.toLowerCase());
  if (index < 0) return escapeHtml(source.slice(0, 140));
  const start = Math.max(0, index - 30);
  return `${start ? '…' : ''}${escapeHtml(source.slice(start, index))}<mark>${escapeHtml(source.slice(index, index + query.length))}</mark>${escapeHtml(source.slice(index + query.length, index + query.length + 90))}`;
}

export function renderSearch(host) {
  let query = '';
  let filter = 'all';
  let seq = 0;
  let timer = null;
  let results = null;

  host.innerHTML = `
    <header class="topbar topbar-search">
      <label class="search-field">${icon('search', 18)}<input type="search" data-query placeholder="${t('Search chats, people, messages')}" autocomplete="off" enterkeyhint="search" aria-label="${t('Search')}"></label>
      <button class="text-button" data-back="/">${t('Cancel')}</button>
    </header>
    <div class="screen-scroll" data-scroll>
      <div class="folder-tabs search-filters" role="tablist">${FILTERS.map(item => `<button class="folder-tab${item.id === filter ? ' active' : ''}" data-filter="${item.id}">${t(item.label)}</button>`).join('')}</div>
      <div data-results></div>
    </div>`;
  const input = host.querySelector('[data-query]');
  const out = host.querySelector('[data-results]');

  const drawRecent = () => {
    const items = recent();
    out.innerHTML = items.length
      ? `<div class="list-section-row"><h2 class="list-section">${t('Recent searches')}</h2><button class="text-button" data-clear-recent>${t('Clear')}</button></div>
        <div class="group-body">${items.map(item => `<button class="row" data-recent="${escapeHtml(item)}">${icon('clock', 18)}<span class="row-text"><span class="row-label">${escapeHtml(item)}</span></span></button>`).join('')}</div>`
      : `<div class="search-hint">${emptyState('search', t('Search Circle'), t('Find chats, people, messages, photos, files, links, and voice messages.'))}</div>`;
  };

  const messageRow = message => {
    const conversation = conversationById(message.conversationId);
    if (message.kind === 'file' && message.media) {
      return `<button class="conversation" data-result="${message.conversationId}" data-message-id="${message.id}"><span class="file-icon">${escapeHtml(String(message.media.name || '').split('.').pop().slice(0, 4) || 'file')}</span>
        <span class="conversation-main"><span class="conversation-row"><strong>${highlight(message.media.name, query)}</strong><time>${relativeTime(message.createdAt)}</time></span>
        <span class="conversation-row"><span class="conversation-preview">${formatBytes(message.media.size)} · ${escapeHtml(message.conversationTitle)}</span></span></span></button>`;
    }
    return `<button class="conversation" data-result="${message.conversationId}" data-message-id="${message.id}">
      ${avatar(message.sender, 'md')}
      <span class="conversation-main"><span class="conversation-row"><strong>${escapeHtml(message.conversationTitle || conversation?.title || '')}</strong><time>${relativeTime(message.createdAt)}</time></span>
      <span class="conversation-row"><span class="conversation-preview"><span class="preview-sender">${escapeHtml(message.isMine ? t('You') : message.sender.displayName.split(' ')[0])}:</span> ${highlight(message.body || previewText(message), query)}</span></span></span>
    </button>`;
  };

  const draw = () => {
    host.querySelectorAll('[data-filter]').forEach(button => button.classList.toggle('active', button.dataset.filter === filter));
    const needsQuery = filter === 'all' || filter === 'messages';
    if (needsQuery && query.length < 2) {
      if (!query) return drawRecent();
      out.innerHTML = `<p class="list-hint">${t('Type at least two characters.')}</p>`;
      return;
    }
    const lower = query.toLowerCase();
    const sections = [];
    if (filter === 'all') {
      const chats = state.conversations.items.filter(item => item.title.toLowerCase().includes(lower));
      if (chats.length) sections.push(`<h2 class="list-section">${t('Chats')}</h2><div class="chat-list">${chats.map(chat => chatRowMarkup(chat, { swipe: false })).join('')}</div>`);
      const people = (results?.members || []).filter(member => member.id !== state.user?.id);
      if (people.length) sections.push(`<h2 class="list-section">${t('People')}</h2><div class="chat-list">${people.map(member => `
        <button class="conversation" data-member="${member.id}"><span class="avatar-wrap${member.online ? ' is-online' : ''}">${avatar(member, 'md')}</span>
        <span class="conversation-main"><span class="conversation-row"><strong>${highlight(member.displayName, query)}</strong></span>
        <span class="conversation-row"><span class="conversation-preview">@${highlight(member.username, query)}</span></span></span></button>`).join('')}</div>`);
    }
    if (!results) { out.innerHTML = sections.join('') + listSkeleton(3); return; }
    if (filter === 'media' && results.messages.length) {
      sections.push(`<div class="gallery-grid search-gallery">${results.messages.map(message => `<button class="gallery-item" data-result="${message.conversationId}" data-message-id="${message.id}" style="${message.media?.thumb ? `background-image:url('${message.media.thumb}')` : ''}">
        ${message.kind === 'video' ? `<video src="${escapeHtml(message.media.url)}" preload="metadata" muted playsinline></video><span class="gallery-badge">${icon('play', 12, true)}</span>` : `<img src="${escapeHtml(message.media.url)}" alt="" loading="lazy">`}</button>`).join('')}</div>`);
    } else if (results.messages.length) {
      sections.push(`<h2 class="list-section">${filter === 'all' || filter === 'messages' ? t('Messages') : t(FILTERS.find(item => item.id === filter).label)}</h2><div class="chat-list">${results.messages.map(messageRow).join('')}</div>`);
    }
    if (results.posts?.length) sections.push(`<h2 class="list-section">${t('Posts')}</h2><div class="chat-list">${results.posts.map(post => `
      <button class="conversation" data-post="${post.id}"><span class="avatar avatar-md avatar-group">${icon('grid', 22)}</span>
      <span class="conversation-main"><span class="conversation-row"><strong>${escapeHtml(post.author.displayName)}</strong><time>${relativeTime(post.createdAt)}</time></span>
      <span class="conversation-row"><span class="conversation-preview">${highlight(post.body, query)}</span></span></span></button>`).join('')}</div>`);
    out.innerHTML = sections.length ? sections.join('') : emptyState('search', t('No results'), query ? t('Nothing matches “{query}”.', { query }) : t('Nothing has been shared here yet.'));
  };

  const run = () => {
    clearTimeout(timer);
    results = null;
    draw();
    const needsQuery = filter === 'all' || filter === 'messages';
    if (needsQuery && query.length < 2) return;
    const current = ++seq;
    timer = setTimeout(async () => {
      try {
        const data = await request(`/api/search?type=${filter}${query ? `&q=${encodeURIComponent(query)}` : ''}`);
        if (current !== seq) return;
        results = data;
        draw();
      } catch (error) { if (current === seq) { results = { members: [], messages: [], posts: [] }; draw(); toast(error.message, 'error'); } }
    }, 220);
  };

  input.addEventListener('input', () => { query = input.value.trim(); run(); });
  input.addEventListener('keydown', event => { if (event.key === 'Enter' && query.length >= 2) { remember(query); input.blur(); } });

  host.addEventListener('click', async event => {
    const filterButton = event.target.closest('[data-filter]');
    if (filterButton) { filter = filterButton.dataset.filter; return run(); }
    const recentButton = event.target.closest('[data-recent]');
    if (recentButton) { input.value = recentButton.dataset.recent; query = input.value; return run(); }
    if (event.target.closest('[data-clear-recent]')) { localStorage.removeItem(recentKey()); return drawRecent(); }
    if (query.length >= 2) remember(query);
    const result = event.target.closest('[data-result]');
    if (result) return navigate(`/chat/${result.dataset.result}?m=${result.dataset.messageId}`);
    const open = event.target.closest('[data-open]');
    if (open) return navigate(`/chat/${open.dataset.open}`);
    const post = event.target.closest('[data-post]');
    if (post) return navigate(`/feed?post=${post.dataset.post}`);
    const member = event.target.closest('[data-member]');
    if (member) {
      try {
        const { conversationId } = await request('/api/conversations/direct', { method: 'POST', body: { userId: Number(member.dataset.member) } });
        if (!conversationById(conversationId)) await loadConversations();
        navigate(`/chat/${conversationId}`);
      } catch (error) { toast(error.message, 'error'); }
    }
  });

  drawRecent();
  setTimeout(() => input.focus(), 320);
  return () => clearTimeout(timer);
}

export { goBack };
