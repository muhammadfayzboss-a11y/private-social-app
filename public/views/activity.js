import { icon } from '../icons.js';
import { navigate } from '../router.js';
import { loadActivity, markActivityRead, state, subscribe } from '../store.js';
import { avatar, emptyState, escapeHtml, listSkeleton, topBar } from '../ui.js';
import { dayKey, dayLabel, timeTag } from '../lib/time.js';
import { enablePullToRefresh } from '../lib/pull.js';
import { t } from '../lib/i18n.js';

const ACTIONS = {
  post_reaction: { one: 'reacted to your post', many: 'reacted to your post', icon: 'heart', color: '#ef4e6d' },
  comment: { one: 'commented on your post', many: 'commented on your post', icon: 'comment', color: '#5b8def' },
  comment_reply: { one: 'replied to your comment', many: 'replied to your comment', icon: 'reply', color: '#5b8def' },
  comment_reaction: { one: 'liked your comment', many: 'liked your comment', icon: 'heart', color: '#ef4e6d' },
  story_reaction: { one: 'reacted to your story', many: 'reacted to your story', icon: 'camera', color: '#ff7a45' },
  story_reply: { one: 'replied to your story', many: 'replied to your story', icon: 'camera', color: '#ff7a45' },
  message_reaction: { one: 'reacted to your message', many: 'reacted to your message', icon: 'smile', color: '#f0a52b' },
  mention: { one: 'mentioned you', many: 'mentioned you', icon: 'bubble', color: '#8e6cf5' },
  message: { one: 'sent you a message', many: 'sent you messages', icon: 'chat', color: '#22b573' }
};
// Kinds where the notification text is a reaction emoji rather than a quote.
const REACTION_KINDS = new Set(['post_reaction', 'story_reaction', 'comment_reaction', 'message_reaction']);

/**
 * Collapses consecutive notifications about the same thing (same kind and target, same day) into
 * one row: "Ana and 2 others reacted to your post".
 */
export function groupActivity(items) {
  const groups = [];
  for (const item of items) {
    const key = `${item.kind}:${item.entityType}:${item.entityId}:${dayKey(item.createdAt)}`;
    const last = groups.at(-1);
    if (last && last.key === key && item.kind !== 'comment' && item.kind !== 'mention') {
      last.items.push(item);
      if (!last.actors.some(actor => actor?.id === item.actor?.id)) last.actors.push(item.actor);
      last.unread = last.unread || !item.readAt;
    } else groups.push({ key, kind: item.kind, entityType: item.entityType, entityId: item.entityId, createdAt: item.createdAt, items: [item], actors: [item.actor], unread: !item.readAt });
  }
  return groups;
}

function actorsLine(actors) {
  const names = actors.map(actor => escapeHtml(actor?.displayName || t('Someone')));
  if (names.length === 1) return `<strong>${names[0]}</strong>`;
  if (names.length === 2) return t('{a} and {b}', { a: `<strong>${names[0]}</strong>`, b: `<strong>${names[1]}</strong>` });
  return t('{a} and {n} others', { a: `<strong>${names[0]}</strong>`, n: names.length - 1 });
}

function groupMarkup(group) {
  const action = ACTIONS[group.kind] || { one: 'interacted with your content', many: 'interacted with your content', icon: 'bell', color: '#8e8e93' };
  const first = group.items[0];
  const reactions = REACTION_KINDS.has(group.kind) ? [...new Set(group.items.map(item => item.message).filter(Boolean))].slice(0, 4).join(' ') : '';
  const quote = !REACTION_KINDS.has(group.kind) && first.message ? `<span class="activity-quote">“${escapeHtml(first.message)}”</span>` : '';
  const faces = group.actors.slice(0, 3);
  return `<button class="activity-item${group.unread ? ' unread' : ''}" data-entity="${escapeHtml(group.entityType)}" data-id="${escapeHtml(String(group.entityId))}">
    <span class="activity-avatars${faces.length > 1 ? ' stacked' : ''}">${faces.map(actor => avatar(actor, 'md')).join('')}<span class="activity-kind" style="--kind:${action.color}">${icon(action.icon, 12, true)}</span></span>
    <span class="activity-content">
      <span>${actorsLine(group.actors)} ${escapeHtml(t(group.actors.length > 1 ? action.many : action.one))}${reactions ? ` <span class="activity-reactions">${escapeHtml(reactions)}</span>` : ''}</span>
      ${quote}
      ${timeTag(group.createdAt)}
    </span>
    ${group.unread ? '<span class="activity-dot" aria-label="Unread"></span>' : ''}
  </button>`;
}

export function renderActivity(host, params, screen) {
  host.innerHTML = `
    ${topBar({ title: t('Activity'), className: 'topbar-root', actions: `<button class="text-button" data-action="read-all">${t('Mark all read')}</button>` })}
    <div class="screen-scroll" data-scroll><div data-list>${listSkeleton(6)}</div></div>`;
  const list = host.querySelector('[data-list]');

  const draw = () => {
    if (!state.activity.loaded) return;
    const groups = groupActivity(state.activity.items);
    if (!groups.length) {
      list.innerHTML = emptyState('bell', t('No activity yet'), t('Reactions, comments, mentions, and story replies show up here. Chat messages live in Chats.'));
      return;
    }
    const days = [];
    for (const group of groups) {
      const day = dayKey(group.createdAt);
      if (days.at(-1)?.day !== day) days.push({ day, label: dayLabel(group.createdAt), groups: [] });
      days.at(-1).groups.push(group);
    }
    list.innerHTML = days.map(section => `<h2 class="list-section">${escapeHtml(section.label)}</h2>
      <div class="activity-list">${section.groups.map(groupMarkup).join('')}</div>`).join('');
  };

  host.addEventListener('click', event => {
    if (event.target.closest('[data-action="read-all"]')) return markActivityRead();
    const item = event.target.closest('[data-entity]');
    if (!item) return;
    if (item.dataset.entity === 'conversation') navigate(`/chat/${item.dataset.id}`);
    else if (item.dataset.entity === 'post' || item.dataset.entity === 'comment') navigate(item.dataset.entity === 'post' ? `/feed?post=${item.dataset.id}` : '/feed');
    // Story reactions and replies belong to your own stories: open your archive with its viewers.
    else if (item.dataset.entity === 'story') navigate('/profile');
  });

  enablePullToRefresh(host.querySelector('[data-scroll]'), () => loadActivity().then(draw));
  const unsubscribe = subscribe(event => { if (event === 'activity') draw(); });
  // Opening the tab marks everything read — after a short delay so unread rows are seen highlighted.
  let readTimer = null;
  const onShow = () => { clearTimeout(readTimer); readTimer = setTimeout(() => { if (screen.isActive()) markActivityRead().catch(() => {}); }, 1500); };
  screen.onShow(() => { loadActivity().then(draw).catch(() => {}); onShow(); });
  loadActivity().then(() => { draw(); onShow(); }).catch(error => { list.innerHTML = emptyState('alert', t('Could not load activity'), error.message); });
  draw();
  return () => { unsubscribe(); clearTimeout(readTimer); };
}
