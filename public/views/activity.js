import { icon } from '../icons.js';
import { navigate } from '../router.js';
import { loadActivity, markActivityRead, state, subscribe } from '../store.js';
import { avatar, emptyState, escapeHtml, listSkeleton } from '../ui.js';
import { timeTag } from '../lib/time.js';

const summaries = {
  post_reaction: 'reacted to your post',
  comment: 'commented on your post',
  comment_reply: 'replied to your comment',
  comment_reaction: 'liked your comment',
  story_reaction: 'reacted to your story',
  story_reply: 'replied to your story',
  message: 'sent you a message'
};

export function renderActivity(host) {
  host.innerHTML = `
    <div class="page">
      <div class="page-title"><div><h1>Activity</h1><p>Reactions, comments, and story replies.</p></div>
        <button class="button button-ghost" data-action="read-all">${icon('check', 18)} Mark read</button></div>
      <div data-list>${listSkeleton(5)}</div>
    </div>`;

  const list = host.querySelector('[data-list]');

  const draw = () => {
    if (!state.activity.loaded) return;
    const items = state.activity.items;
    if (!items.length) {
      list.innerHTML = emptyState('bell', 'No activity yet', 'Reactions, comments, and story replies will show up here. Chat messages live in Chats.');
      return;
    }
    list.innerHTML = `<div class="activity-list">${items.map(item => `
      <button class="activity-item${item.readAt ? '' : ' unread'}" data-entity="${escapeHtml(item.entityType)}" data-id="${escapeHtml(String(item.entityId))}">
        ${avatar(item.actor, 'md')}
        <span class="activity-content">
          <strong>${escapeHtml(item.actor?.displayName || 'Someone')}</strong>
          ${escapeHtml(summaries[item.kind] || 'interacted with your content')}${item.message && !['post_reaction', 'story_reaction', 'comment_reaction'].includes(item.kind) ? `: “${escapeHtml(item.message)}”` : ''}
          ${timeTag(item.createdAt)}
        </span>
        ${item.readAt ? '' : '<span class="activity-dot"></span>'}
      </button>`).join('')}</div>`;
  };

  host.addEventListener('click', async event => {
    if (event.target.closest('[data-action="read-all"]')) return markActivityRead();
    const item = event.target.closest('[data-entity]');
    if (!item) return;
    if (item.dataset.entity === 'conversation') navigate(`/chat/${item.dataset.id}`);
    else if (item.dataset.entity === 'post') navigate(`/?post=${item.dataset.id}`);
    // Story reactions and replies belong to your own stories: open your archive with its viewers.
    else if (item.dataset.entity === 'story') navigate('/profile');
    else navigate('/');
  });

  const unsubscribe = subscribe(event => { if (event === 'activity') draw(); });
  loadActivity().then(() => { draw(); markActivityRead().catch(() => {}); }).catch(error => {
    list.innerHTML = emptyState('alert', 'Could not load activity', error.message);
  });
  draw();
  return unsubscribe;
}
