import { navigate } from '../router.js';
import { loadFeed, loadStories, refreshFeed, state, subscribe } from '../store.js';
import { emptyState, skeleton, spinner } from '../ui.js';
import { createPostCard } from '../components/post.js';
import { createStoriesTray, renderStoriesTray } from '../components/stories.js';

export function renderHome(host) {
  host.innerHTML = `
    <div class="page">
      <div data-stories></div>
      <div class="feed" data-feed>${skeleton(2)}</div>
      <div data-sentinel class="feed-sentinel"></div>
    </div>`;

  const storiesHost = host.querySelector('[data-stories]');
  const feedHost = host.querySelector('[data-feed]');
  const sentinel = host.querySelector('[data-sentinel]');
  const tray = createStoriesTray();
  storiesHost.append(tray);

  const cards = new Map();

  const drawFeed = () => {
    const { posts, loading, loaded, error } = state.feed;
    if (error && !posts.length) {
      feedHost.innerHTML = emptyState('close', 'Could not load the feed', error, '<button class="button button-primary" data-retry>Try again</button>');
      feedHost.querySelector('[data-retry]')?.addEventListener('click', () => loadFeed({ reset: true }));
      return;
    }
    if (!loaded && loading) { feedHost.innerHTML = skeleton(2); return; }
    if (!posts.length) {
      feedHost.innerHTML = emptyState('image', 'Nothing here yet', 'Share the first moment with your circle — a photo, a video, or just a thought.',
        '<button class="button button-primary" data-create>Create a post</button>');
      feedHost.querySelector('[data-create]')?.addEventListener('click', () => navigate('/create'));
      cards.clear();
      return;
    }

    const fragment = document.createDocumentFragment();
    const seen = new Set();
    for (const post of posts) {
      seen.add(post.id);
      const signature = JSON.stringify([post.body, post.editedAt, post.reactions, post.viewerReaction, post.comments.length, post.comments.map(c => [c.id, c.viewerReaction, c.reactions])]);
      let card = cards.get(post.id);
      // Never rebuild a card the member is typing in — it would discard their half-written comment.
      if (card && card.contains(document.activeElement)) {
        fragment.append(card);
        continue;
      }
      if (!card || card.dataset.signature !== signature) {
        card = createPostCard(post);
        card.dataset.signature = signature;
        cards.set(post.id, card);
      }
      fragment.append(card);
    }
    for (const id of [...cards.keys()]) if (!seen.has(id)) cards.delete(id);
    feedHost.replaceChildren(fragment);
    if (loading) feedHost.insertAdjacentHTML('beforeend', spinner('Loading more'));
  };

  const unsubscribe = subscribe(event => {
    if (['feed', 'feed:loading', 'post', 'post:removed', 'members'].includes(event)) drawFeed();
    if (['stories', 'story:viewed', 'members'].includes(event)) renderStoriesTray(tray);
    // After a dropped connection the client may have missed broadcasts, so resynchronise.
    if (event === 'realtime:open' && state.feed.loaded) {
      refreshFeed().catch(() => {});
      loadStories().catch(() => {});
    }
  });

  const observer = new IntersectionObserver(entries => {
    if (entries.some(entry => entry.isIntersecting) && state.feed.nextCursor && !state.feed.loading) loadFeed({ more: true });
  }, { rootMargin: '400px' });
  observer.observe(sentinel);

  Promise.all([
    state.feed.loaded ? refreshFeed() : loadFeed({ reset: true }),
    loadStories()
  ]).then(() => {
    drawFeed();
    renderStoriesTray(tray);
    const requested = new URLSearchParams(window.location.search).get('post');
    if (requested) {
      const card = feedHost.querySelector(`[data-post="${CSS.escape(requested)}"]`);
      card?.scrollIntoView({ block: 'center' });
      card?.classList.add('post-highlight');
    }
  });

  drawFeed();

  return () => { unsubscribe(); observer.disconnect(); };
}
