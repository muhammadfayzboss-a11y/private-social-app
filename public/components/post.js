import { request } from '../api.js';
import { icon } from '../icons.js';
import { navigate } from '../router.js';
import { patchPost, removePost, state, upsertPost } from '../store.js';
import { avatar, confirmSheet, escapeHtml, mediaView, modal, reactionIcon, REACTION_LABELS, toast } from '../ui.js';
import { timeTag } from '../lib/time.js';
import { REACTIONS } from './reactions.js';
import { openSendToChat } from './share.js';

function reactionSummary(post) {
  const entries = Object.entries(post.reactions || {}).filter(([, count]) => count > 0);
  if (!entries.length) return '';
  const total = entries.reduce((sum, [, count]) => sum + count, 0);
  const chips = entries.map(([name, count]) => `<span class="reaction-chip">${reactionIcon(name, 14)}${count}</span>`).join('');
  return `<div class="reaction-summary">${chips}<span>${total} ${total === 1 ? 'reaction' : 'reactions'}</span></div>`;
}

function commentMarkup(post) {
  if (!post.comments.length) return '';
  return `<div class="comment-thread">${post.comments.map(comment => `
    <article class="comment" data-comment="${comment.id}">
      ${avatar(comment.author, 'sm')}
      <div class="comment-content">
        <div class="comment-bubble">
          <strong>${escapeHtml(comment.author.displayName)}</strong>${escapeHtml(comment.body)}
        </div>
        <div class="comment-meta">
          ${timeTag(comment.createdAt)}
          · <button class="text-button comment-like${comment.viewerReaction ? ' liked' : ''}" data-action="comment-react" data-comment="${comment.id}">${comment.viewerReaction ? 'Liked' : 'Like'}</button>
          ${Object.values(comment.reactions || {}).reduce((sum, count) => sum + count, 0) ? `<span class="comment-like-count">${Object.values(comment.reactions).reduce((sum, count) => sum + count, 0)}</span>` : ''}
          · <button class="text-button" data-action="reply-comment" data-comment="${comment.id}" data-name="${escapeHtml(comment.author.username)}">Reply</button>
        </div>
      </div>
    </article>`).join('')}</div>`;
}

export function createPostCard(post) {
  const element = document.createElement('article');
  element.className = 'card post-card';
  element.dataset.post = String(post.id);
  const isMine = post.author.id === state.user?.id;
  const canModerate = isMine || state.user?.role === 'admin';
  const liked = Boolean(post.viewerReaction);

  element.innerHTML = `
    <header class="post-head">
      <button class="avatar-button" data-action="open-profile" aria-label="Open ${escapeHtml(post.author.displayName)}'s profile">${avatar(post.author, 'md')}</button>
      <div class="post-author">
        <strong>${escapeHtml(post.author.displayName)}</strong>
        <small>@${escapeHtml(post.author.username)} · ${timeTag(post.createdAt)}${post.editedAt ? ' · edited' : ''}</small>
      </div>
      ${canModerate ? `<button class="icon-button" data-action="post-menu" aria-label="Post options">${icon('more', 20)}</button>` : ''}
    </header>
    ${post.body ? `<div class="post-body">${escapeHtml(post.body)}</div>` : ''}
    ${post.media.length ? `<div class="post-media-grid${post.media.length > 1 ? ' multi' : ''}">${post.media.map(media => mediaView(media)).join('')}</div>` : ''}
    ${reactionSummary(post)}
    <div class="post-actions">
      <button class="post-action like-action${liked ? ' liked' : ''}" data-action="like" aria-pressed="${liked}" aria-label="${liked ? 'Remove reaction' : 'React to post'}">
        ${liked ? reactionIcon(post.viewerReaction, 21) : icon('heart', 21)}
        <span>${Object.values(post.reactions || {}).reduce((sum, count) => sum + count, 0) || ''}</span>
      </button>
      <button class="post-action" data-action="focus-comment">${icon('comment', 21)}<span>${post.comments.length || ''}</span></button>
      <button class="post-action" data-action="share">${icon('send', 21)}</button>
    </div>
    <div class="comments">
      ${commentMarkup(post)}
      <form class="comment-form" data-post="${post.id}">
        ${avatar(state.user, 'sm')}
        <input name="body" maxlength="800" placeholder="Add a comment…" aria-label="Add a comment" autocomplete="off">
        <button class="icon-button" type="submit" aria-label="Send comment">${icon('send', 18)}</button>
      </form>
    </div>`;

  const likeButton = element.querySelector('[data-action="like"]');
  let pressTimer = null;
  const openPicker = () => {
    clearTimeout(pressTimer);
    const sheet = modal(`
      <div class="modal-head"><h2>React</h2><button class="icon-button" data-close-modal aria-label="Close">${icon('close', 20)}</button></div>
      <div class="reaction-picker">${REACTIONS.map(name => `
        <button data-reaction="${name}" aria-label="${REACTION_LABELS[name]}" class="${post.viewerReaction === name ? 'selected' : ''}">
          ${reactionIcon(name, 22)}<small>${REACTION_LABELS[name]}</small>
        </button>`).join('')}</div>`);
    sheet.querySelectorAll('[data-reaction]').forEach(button => button.addEventListener('click', async () => {
      sheet.remove();
      await react(post, button.dataset.reaction);
    }));
  };
  likeButton.addEventListener('pointerdown', () => { pressTimer = setTimeout(openPicker, 420); });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach(type => likeButton.addEventListener(type, () => clearTimeout(pressTimer)));
  likeButton.addEventListener('contextmenu', event => { event.preventDefault(); openPicker(); });

  element.addEventListener('click', async event => {
    const trigger = event.target.closest('[data-action]');
    if (!trigger) return;
    const action = trigger.dataset.action;
    try {
      if (action === 'open-profile') navigate(`/profile/${post.author.id}`);
      if (action === 'like') await react(post, post.viewerReaction ? null : 'heart');
      if (action === 'focus-comment') element.querySelector('.comment-form input').focus();
      if (action === 'share') openSendToChat(post);
      if (action === 'post-menu') openPostMenu(post, isMine);
      if (action === 'comment-react') await reactToComment(post, Number(trigger.dataset.comment));
      if (action === 'reply-comment') {
        const input = element.querySelector('.comment-form input');
        input.value = `@${trigger.dataset.name} `;
        input.dataset.parent = trigger.dataset.comment;
        input.focus();
      }
    } catch (error) { toast(error.message, 'error'); }
  });

  element.querySelector('.comment-form').addEventListener('submit', async event => {
    event.preventDefault();
    const input = event.target.querySelector('input');
    const body = input.value.trim();
    if (!body) return;
    const parentId = input.dataset.parent ? Number(input.dataset.parent) : null;
    input.disabled = true;
    try {
      const { comment } = await request(`/api/posts/${post.id}/comments`, { method: 'POST', body: { body, parentId } });
      if (!post.comments.some(item => item.id === comment.id)) post.comments.push(comment);
      input.value = '';
      delete input.dataset.parent;
      upsertPost(post);
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      input.disabled = false;
    }
  });

  return element;
}

async function react(post, reaction) {
  const data = await request(`/api/posts/${post.id}/reaction`, { method: 'POST', body: { reaction } });
  patchPost(post.id, { reactions: data.reactions, viewerReaction: data.viewerReaction });
}

async function reactToComment(post, commentId) {
  const comment = post.comments.find(item => item.id === commentId);
  if (!comment) return;
  const next = comment.viewerReaction ? null : 'heart';
  await request(`/api/comments/${commentId}/reaction`, { method: 'POST', body: { reaction: next } });
  comment.viewerReaction = next;
  comment.reactions = { ...comment.reactions };
  const current = comment.reactions.heart || 0;
  comment.reactions.heart = Math.max(0, next ? current + 1 : current - 1);
  upsertPost(post);
}

function openPostMenu(post, isMine) {
  const sheet = modal(`
    <div class="modal-head"><h2>Post options</h2><button class="icon-button" data-close-modal aria-label="Close">${icon('close', 20)}</button></div>
    <div class="settings-list">
      ${isMine ? `<button class="settings-item" data-menu="edit">${icon('edit', 20)}<span>Edit post</span></button>` : ''}
      <button class="settings-item" data-menu="delete">${icon('trash', 20)}<span>Delete post</span></button>
    </div>`);
  sheet.querySelector('[data-menu="delete"]').addEventListener('click', async () => {
    sheet.remove();
    if (!(await confirmSheet({ title: 'Delete this post?', text: 'It will be removed for everyone, including its comments.', confirm: 'Delete post' }))) return;
    try {
      await request(`/api/posts/${post.id}`, { method: 'DELETE' });
      removePost(post.id);
      toast('Post deleted');
    } catch (error) { toast(error.message, 'error'); }
  });
  sheet.querySelector('[data-menu="edit"]')?.addEventListener('click', () => {
    sheet.remove();
    const editor = modal(`
      <div class="modal-head"><h2>Edit post</h2><button class="icon-button" data-close-modal aria-label="Close">${icon('close', 20)}</button></div>
      <form data-edit-form>
        <div class="field"><textarea name="body" maxlength="2200" rows="5">${escapeHtml(post.body)}</textarea></div>
        <button class="button button-primary button-block" type="submit">Save changes</button>
      </form>`);
    editor.querySelector('[data-edit-form]').addEventListener('submit', async event => {
      event.preventDefault();
      const body = event.target.querySelector('textarea').value;
      try {
        const data = await request(`/api/posts/${post.id}`, { method: 'PATCH', body: { body } });
        upsertPost(data.post);
        editor.remove();
        toast('Post updated');
      } catch (error) { toast(error.message, 'error'); }
    });
  });
}
