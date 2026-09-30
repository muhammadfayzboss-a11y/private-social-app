import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createClient, dbModule, pngFixture, server } from './helpers.mjs';

const admin = createClient();
const ana = createClient();
const ben = createClient();
const context = {};

after(() => server.close());

test('health endpoint responds before any account exists', async () => {
  const { status, data } = await admin.call('/api/health');
  assert.equal(status, 200);
  assert.equal(data.status, 'ok');
  const statusResponse = await admin.call('/api/auth/status');
  assert.equal(statusResponse.data.needsSetup, true);
  assert.equal(statusResponse.data.authenticated, false);
});

test('private data is unreachable without a session', async () => {
  for (const endpoint of ['/api/feed', '/api/stories', '/api/conversations', '/api/activity', '/api/members', '/api/stickers']) {
    const { status } = await admin.call(endpoint);
    assert.equal(status, 401, `${endpoint} should require authentication`);
  }
});

test('the first account cannot be created without the private setup code', async () => {
  const { status, data } = await admin.call('/api/auth/bootstrap', {
    method: 'POST', body: { setupCode: 'wrong-code', username: 'intruder', displayName: 'Intruder', password: 'supersecret1' }
  });
  assert.equal(status, 403);
  assert.match(data.error.message, /setup code/i);
});

test('admin bootstrap creates the first member and a session', async () => {
  const { status, data } = await admin.call('/api/auth/bootstrap', {
    method: 'POST', body: { setupCode: 'test-setup-code', username: 'mara', displayName: 'Mara Quinn', password: 'circle-admin-1' }
  });
  assert.equal(status, 201);
  assert.equal(data.user.username, 'mara');
  assert.equal(data.user.role, 'admin');
  assert.ok(data.csrfToken);

  const statusResponse = await admin.call('/api/auth/status');
  assert.equal(statusResponse.data.authenticated, true);
  assert.equal(statusResponse.data.needsSetup, false);

  const second = await admin.call('/api/auth/bootstrap', {
    method: 'POST', body: { setupCode: 'test-setup-code', username: 'other', displayName: 'Other', password: 'circle-admin-2' }
  });
  assert.equal(second.status, 409);
});

test('mutations are rejected without a matching CSRF token', async () => {
  const { status, data } = await admin.call('/api/posts', { method: 'POST', body: { body: 'no csrf' }, skipCsrf: true });
  assert.equal(status, 403);
  assert.equal(data.error.code, 'CSRF_INVALID');
});

test('registration requires a valid single-use invitation', async () => {
  const withoutInvite = await ana.call('/api/auth/register', {
    method: 'POST', body: { username: 'stranger', displayName: 'Stranger', password: 'password-long-1' }
  });
  assert.equal(withoutInvite.status, 403);

  const invite = await admin.call('/api/invites', { method: 'POST', body: { label: 'Ana', days: 7 } });
  assert.equal(invite.status, 201);
  context.inviteCode = invite.data.code;

  const weakPassword = await ana.call('/api/auth/register', {
    method: 'POST', body: { inviteCode: context.inviteCode, username: 'ana', displayName: 'Ana Ruiz', password: 'short' }
  });
  assert.equal(weakPassword.status, 400);

  const badUsername = await ana.call('/api/auth/register', {
    method: 'POST', body: { inviteCode: context.inviteCode, username: 'Ana Ruiz!', displayName: 'Ana Ruiz', password: 'password-long-1' }
  });
  assert.equal(badUsername.status, 400);

  const joined = await ana.call('/api/auth/register', {
    method: 'POST', body: { inviteCode: context.inviteCode, username: 'ana', displayName: 'Ana Ruiz', password: 'password-long-1' }
  });
  assert.equal(joined.status, 201);
  assert.equal(joined.data.user.role, 'member');
  context.anaId = joined.data.user.id;

  const reused = await createClient().call('/api/auth/register', {
    method: 'POST', body: { inviteCode: context.inviteCode, username: 'copycat', displayName: 'Copycat', password: 'password-long-1' }
  });
  assert.equal(reused.status, 403, 'an invite code must not work twice');
});

test('a third member joins and duplicate usernames are refused', async () => {
  const invite = await admin.call('/api/invites', { method: 'POST', body: { label: 'Ben' } });
  const joined = await ben.call('/api/auth/register', {
    method: 'POST', body: { inviteCode: invite.data.code, username: 'ben', displayName: 'Ben Ito', password: 'password-long-2' }
  });
  assert.equal(joined.status, 201);
  context.benId = joined.data.user.id;

  const duplicateInvite = await admin.call('/api/invites', { method: 'POST', body: { label: 'dupe' } });
  const duplicate = await createClient().call('/api/auth/register', {
    method: 'POST', body: { inviteCode: duplicateInvite.data.code, username: 'ana', displayName: 'Ana Two', password: 'password-long-3' }
  });
  assert.equal(duplicate.status, 409);
});

test('members cannot create invitations', async () => {
  const { status } = await ana.call('/api/invites', { method: 'POST', body: { label: 'nope' } });
  assert.equal(status, 403);
});

test('login rejects wrong credentials and restores a session', async () => {
  const fresh = createClient();
  const wrong = await fresh.call('/api/auth/login', { method: 'POST', body: { username: 'ana', password: 'not-the-password' } });
  assert.equal(wrong.status, 401);

  const correct = await fresh.call('/api/auth/login', { method: 'POST', body: { username: 'ana', password: 'password-long-1' } });
  assert.equal(correct.status, 200);
  assert.equal(correct.data.user.username, 'ana');
});

test('profile photo upload and profile editing persist', async () => {
  const upload = await ana.call('/api/media?purpose=avatar', { method: 'POST', binary: { buffer: pngFixture, type: 'image/png', name: 'ana.png' } });
  assert.equal(upload.status, 201);
  context.anaAvatarId = upload.data.media.id;

  const updated = await ana.call('/api/profile', {
    method: 'PATCH', body: { displayName: 'Ana R.', bio: 'Climbing and cold coffee.', avatarMediaId: context.anaAvatarId }
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.data.user.displayName, 'Ana R.');
  assert.equal(updated.data.user.bio, 'Climbing and cold coffee.');
  assert.equal(updated.data.user.avatarUrl, `/api/media/${context.anaAvatarId}`);

  const reloaded = await ana.call('/api/auth/status');
  assert.equal(reloaded.data.user.displayName, 'Ana R.');

  const media = await ben.call(`/api/media/${context.anaAvatarId}`);
  assert.equal(media.status, 200, 'members can load each others profile photos');

  const anonymous = await createClient().call(`/api/media/${context.anaAvatarId}`);
  assert.equal(anonymous.status, 401, 'media must never be public');
});

test('rejects files whose content is not an allowed media type', async () => {
  const { status } = await ana.call('/api/media?purpose=post', {
    method: 'POST', binary: { buffer: Buffer.from('#!/bin/sh\necho hi\n'), type: 'application/x-sh', name: 'payload.sh' }
  });
  assert.equal(status, 415);
});

test('posts with media are stored and appear newest first in the feed', async () => {
  const upload = await ana.call('/api/media?purpose=post', { method: 'POST', binary: { buffer: pngFixture, type: 'image/png', name: 'trip.png' } });
  const created = await ana.call('/api/posts', { method: 'POST', body: { body: 'Sunrise on the ridge', mediaIds: [upload.data.media.id] } });
  assert.equal(created.status, 201);
  assert.equal(created.data.post.media.length, 1);
  context.postId = created.data.post.id;

  const older = await ben.call('/api/posts', { method: 'POST', body: { body: 'Second post from Ben' } });
  assert.equal(older.status, 201);
  context.benPostId = older.data.post.id;

  const feed = await admin.call('/api/feed');
  assert.equal(feed.status, 200);
  assert.deepEqual(feed.data.posts.map(post => post.id), [context.benPostId, context.postId]);
  assert.equal(feed.data.posts[1].body, 'Sunrise on the ridge');

  const empty = await ana.call('/api/posts', { method: 'POST', body: { body: '   ', mediaIds: [] } });
  assert.equal(empty.status, 400);
});

test('media belonging to another member cannot be attached to your post', async () => {
  const upload = await ana.call('/api/media?purpose=post', { method: 'POST', binary: { buffer: pngFixture, type: 'image/png', name: 'private.png' } });
  const { status } = await ben.call('/api/posts', { method: 'POST', body: { body: 'stolen media', mediaIds: [upload.data.media.id] } });
  assert.equal(status, 403);
});

test('reactions, comments, and replies persist and notify the right people', async () => {
  const reacted = await ben.call(`/api/posts/${context.postId}/reaction`, { method: 'POST', body: { reaction: 'fire' } });
  assert.equal(reacted.status, 200);
  assert.equal(reacted.data.reactions.fire, 1);

  const changed = await ben.call(`/api/posts/${context.postId}/reaction`, { method: 'POST', body: { reaction: 'heart' } });
  assert.equal(changed.data.reactions.heart, 1);
  assert.equal(changed.data.reactions.fire, undefined);

  const comment = await ben.call(`/api/posts/${context.postId}/comments`, { method: 'POST', body: { body: 'Unreal light!' } });
  assert.equal(comment.status, 201);
  context.commentId = comment.data.comment.id;

  const reply = await ana.call(`/api/posts/${context.postId}/comments`, { method: 'POST', body: { body: 'Right? Worth the 4am start.', parentId: context.commentId } });
  assert.equal(reply.status, 201);
  assert.equal(reply.data.comment.parentId, context.commentId);

  const commentReaction = await ana.call(`/api/comments/${context.commentId}/reaction`, { method: 'POST', body: { reaction: 'laugh' } });
  assert.equal(commentReaction.status, 200);

  const feed = await ana.call('/api/feed');
  const post = feed.data.posts.find(item => item.id === context.postId);
  assert.equal(post.comments.length, 2);
  assert.equal(post.reactions.heart, 1);

  const activity = await ana.call('/api/activity');
  const kinds = activity.data.notifications.map(item => item.kind);
  assert.ok(kinds.includes('post_reaction'), 'author is notified about reactions');
  assert.ok(kinds.includes('comment'), 'author is notified about comments');
  assert.ok(activity.data.unread >= 2);

  const benActivity = await ben.call('/api/activity');
  assert.ok(benActivity.data.notifications.some(item => item.kind === 'comment_reply'), 'comment author is notified about replies');
  assert.ok(benActivity.data.notifications.some(item => item.kind === 'comment_reaction'));

  const read = await ana.call('/api/activity/read', { method: 'POST', body: { all: true } });
  assert.equal(read.status, 200);
  const afterRead = await ana.call('/api/activity');
  assert.equal(afterRead.data.unread, 0);
});

test('an invalid reaction value is refused', async () => {
  const { status } = await ben.call(`/api/posts/${context.postId}/reaction`, { method: 'POST', body: { reaction: 'shrug' } });
  assert.equal(status, 400);
});

test('only the author may edit a post, and edits are recorded', async () => {
  const foreign = await ben.call(`/api/posts/${context.postId}`, { method: 'PATCH', body: { body: 'hijacked' } });
  assert.equal(foreign.status, 403);

  const edited = await ana.call(`/api/posts/${context.postId}`, { method: 'PATCH', body: { body: 'Sunrise on the ridge (5:40am)' } });
  assert.equal(edited.status, 200);
  assert.equal(edited.data.post.body, 'Sunrise on the ridge (5:40am)');
  assert.ok(edited.data.post.editedAt);
});

test('post text is stored verbatim so the client can escape it safely', async () => {
  const payload = '<img src=x onerror="alert(1)">';
  const created = await ana.call('/api/posts', { method: 'POST', body: { body: payload } });
  assert.equal(created.data.post.body, payload);
  const feed = await ana.call('/api/feed');
  assert.equal(feed.data.posts[0].body, payload);
  await ana.call(`/api/posts/${created.data.post.id}`, { method: 'DELETE' });
});

test('stories expire after 24 hours and record views, reactions, and replies', async () => {
  const upload = await ana.call('/api/media?purpose=story', { method: 'POST', binary: { buffer: pngFixture, type: 'image/png', name: 'story.png' } });
  const created = await ana.call('/api/stories', { method: 'POST', body: { mediaId: upload.data.media.id, caption: 'Trail day' } });
  assert.equal(created.status, 201);
  context.storyId = created.data.story.id;
  const lifetimeHours = (new Date(created.data.story.expiresAt) - new Date(created.data.story.createdAt)) / 3600000;
  assert.ok(Math.abs(lifetimeHours - 24) < 0.01, 'stories live for 24 hours');

  const beforeView = await ben.call('/api/stories');
  assert.equal(beforeView.data.stories.find(story => story.id === context.storyId).viewed, false);

  const viewed = await ben.call(`/api/stories/${context.storyId}/view`, { method: 'POST' });
  assert.equal(viewed.status, 200);
  const afterView = await ben.call('/api/stories');
  assert.equal(afterView.data.stories.find(story => story.id === context.storyId).viewed, true);

  const ownerView = await ana.call('/api/stories');
  const ownStory = ownerView.data.stories.find(story => story.id === context.storyId);
  assert.equal(ownStory.views.length, 1);
  assert.equal(ownStory.views[0].user.username, 'ben');

  const reaction = await ben.call(`/api/stories/${context.storyId}/reaction`, { method: 'POST', body: { reaction: '❤️' } });
  assert.equal(reaction.status, 200);

  const replied = await ben.call(`/api/stories/${context.storyId}/reply`, { method: 'POST', body: { body: 'That view!' } });
  assert.equal(replied.status, 201);
  context.storyReplyConversationId = replied.data.conversationId;

  const anaActivity = await ana.call('/api/activity');
  const kinds = anaActivity.data.notifications.map(item => item.kind);
  assert.ok(kinds.includes('story_reaction'));
  assert.ok(kinds.includes('story_reply'));

  dbModule.run("UPDATE stories SET expires_at = ? WHERE id = ?", new Date(Date.now() - 1000).toISOString(), context.storyId);
  const expired = await ben.call('/api/stories');
  assert.equal(expired.data.stories.some(story => story.id === context.storyId), false, 'expired stories disappear');

  const lateView = await ben.call(`/api/stories/${context.storyId}/view`, { method: 'POST' });
  assert.equal(lateView.status, 404, 'expired stories cannot be viewed');
});

test('the group conversation exists for every member and delivers stored messages', async () => {
  const conversations = await ana.call('/api/conversations');
  assert.equal(conversations.status, 200);
  const group = conversations.data.conversations.find(conversation => conversation.kind === 'group');
  assert.ok(group, 'a group conversation is provisioned');
  assert.equal(group.members.length, 3);
  context.groupId = group.id;

  const sent = await ana.call(`/api/conversations/${context.groupId}/messages`, { method: 'POST', body: { kind: 'text', body: 'Dinner Friday?' } });
  assert.equal(sent.status, 201);
  context.groupMessageId = sent.data.message.id;

  const benView = await ben.call(`/api/conversations/${context.groupId}/messages`);
  const delivered = benView.data.messages.find(message => message.id === context.groupMessageId);
  assert.equal(delivered.body, 'Dinner Friday?');
  assert.equal(delivered.isMine, false);

  const benConversations = await ben.call('/api/conversations');
  assert.ok(benConversations.data.conversations.find(conversation => conversation.id === context.groupId).unread >= 1);

  const reply = await ben.call(`/api/conversations/${context.groupId}/messages`, {
    method: 'POST', body: { kind: 'text', body: 'Only if there is pasta', replyToId: context.groupMessageId }
  });
  assert.equal(reply.status, 201);
  assert.equal(reply.data.message.replyTo.id, context.groupMessageId);

  const reacted = await admin.call(`/api/messages/${context.groupMessageId}/reaction`, { method: 'POST', body: { reaction: '🔥' } });
  assert.equal(reacted.status, 200);
  assert.equal(reacted.data.message.reactions[0].reaction, '🔥');

  const read = await ben.call(`/api/conversations/${context.groupId}/read`, { method: 'POST', body: { messageId: reply.data.message.id } });
  assert.equal(read.status, 200);
  const afterRead = await ben.call('/api/conversations');
  assert.equal(afterRead.data.conversations.find(conversation => conversation.id === context.groupId).unread, 0);

  const senderView = await ana.call(`/api/conversations/${context.groupId}/messages`);
  const seenMessage = senderView.data.messages.find(message => message.id === context.groupMessageId);
  assert.ok(seenMessage.readBy.some(reader => reader.username === 'ben'), 'read receipts are visible to the sender');

  const typing = await ana.call(`/api/conversations/${context.groupId}/typing`, { method: 'POST', body: { typing: true } });
  assert.equal(typing.status, 200);

  const empty = await ana.call(`/api/conversations/${context.groupId}/messages`, { method: 'POST', body: { kind: 'text', body: '' } });
  assert.equal(empty.status, 400);
});

test('direct conversations are private to their two members', async () => {
  const created = await ana.call('/api/conversations/direct', { method: 'POST', body: { userId: context.benId } });
  assert.equal(created.status, 200);
  context.directId = created.data.conversationId;

  const again = await ana.call('/api/conversations/direct', { method: 'POST', body: { userId: context.benId } });
  assert.equal(again.data.conversationId, context.directId, 'direct conversations are reused, not duplicated');

  const upload = await ana.call('/api/media?purpose=chat', { method: 'POST', binary: { buffer: pngFixture, type: 'image/png', name: 'chat.png' } });
  const photo = await ana.call(`/api/conversations/${context.directId}/messages`, { method: 'POST', body: { kind: 'image', mediaId: upload.data.media.id } });
  assert.equal(photo.status, 201);
  context.chatMediaId = upload.data.media.id;

  const intruderRead = await admin.call(`/api/conversations/${context.directId}/messages`);
  assert.equal(intruderRead.status, 403, 'non-members cannot read a private conversation');

  const intruderWrite = await admin.call(`/api/conversations/${context.directId}/messages`, { method: 'POST', body: { kind: 'text', body: 'let me in' } });
  assert.equal(intruderWrite.status, 403);

  const intruderMedia = await admin.call(`/api/media/${context.chatMediaId}`);
  assert.equal(intruderMedia.status, 403, 'private chat media stays private');

  const memberMedia = await ben.call(`/api/media/${context.chatMediaId}`);
  assert.equal(memberMedia.status, 200);

  const selfDirect = await ana.call('/api/conversations/direct', { method: 'POST', body: { userId: context.anaId } });
  assert.equal(selfDirect.status, 400);
});

test('story replies are delivered as a private message', async () => {
  const messages = await ben.call(`/api/conversations/${context.storyReplyConversationId}/messages`);
  assert.equal(messages.status, 200);
  const reply = messages.data.messages.find(message => message.kind === 'story_reply');
  assert.equal(reply.body, 'That view!');
});

test('stickers load from disk, send in chat, and track recents and favorites', async () => {
  const listed = await ana.call('/api/stickers');
  assert.equal(listed.status, 200);
  const pack = listed.data.packs.find(item => item.id === 'circle-basics');
  assert.ok(pack, 'packs are discovered from the stickers directory');
  assert.ok(pack.stickers.length >= 6);
  assert.equal(pack.coverUrl, '/api/stickers/basics-heart/file');
  const sticker = pack.stickers[0];

  const file = await ana.call(sticker.url);
  assert.equal(file.status, 200);
  assert.match(file.headers.get('content-type'), /svg/);

  const sent = await ana.call(`/api/conversations/${context.groupId}/messages`, { method: 'POST', body: { kind: 'sticker', stickerId: sticker.id } });
  assert.equal(sent.status, 201);
  assert.equal(sent.data.message.kind, 'sticker');
  assert.equal(sent.data.message.sticker.url, `/api/stickers/${sticker.id}/file`);

  const received = await ben.call(`/api/conversations/${context.groupId}/messages`);
  const stickerMessage = received.data.messages.find(message => message.id === sent.data.message.id);
  assert.equal(stickerMessage.sticker.id, sticker.id, 'the receiver gets the real sticker artwork');

  const recents = await ana.call('/api/stickers');
  assert.equal(recents.data.recent[0].id, sticker.id, 'recently used stickers are tracked per member');

  const favorited = await ana.call(`/api/stickers/${sticker.id}/favorite`, { method: 'POST', body: { favorite: true } });
  assert.equal(favorited.status, 200);
  const afterFavorite = await ana.call('/api/stickers');
  assert.equal(afterFavorite.data.packs.find(item => item.id === 'circle-basics').stickers.find(item => item.id === sticker.id).favorite, true);

  const missing = await ana.call(`/api/conversations/${context.groupId}/messages`, { method: 'POST', body: { kind: 'sticker', stickerId: 'does-not-exist' } });
  assert.equal(missing.status, 400);

  const memberReload = await ana.call('/api/stickers/reload', { method: 'POST' });
  assert.equal(memberReload.status, 403, 'only the admin reloads packs');
  const adminReload = await admin.call('/api/stickers/reload', { method: 'POST' });
  assert.equal(adminReload.status, 200);
  assert.ok(adminReload.data.stickersLoaded >= 6);
});

test('members can only delete their own messages for everyone, and deleted messages leave every history', async () => {
  const sent = await ben.call(`/api/conversations/${context.groupId}/messages`, { method: 'POST', body: { kind: 'text', body: 'oops wrong chat' } });
  const foreign = await ana.call(`/api/messages/${sent.data.message.id}?scope=everyone`, { method: 'DELETE' });
  assert.equal(foreign.status, 403);

  const removed = await ben.call(`/api/messages/${sent.data.message.id}`, { method: 'DELETE' });
  assert.equal(removed.status, 200);
  assert.equal(removed.data.scope, 'everyone');

  for (const client of [ana, ben]) {
    const messages = await client.call(`/api/conversations/${context.groupId}/messages`);
    assert.equal(messages.data.messages.some(message => message.id === sent.data.message.id), false);
  }
  const stored = dbModule.one('SELECT body, deleted_at FROM messages WHERE id = ?', sent.data.message.id);
  assert.equal(stored.body, '', 'content is erased from the database');
  assert.ok(stored.deleted_at);
});

test('push subscriptions are stored per member', async () => {
  const config = await ana.call('/api/push/config');
  assert.equal(config.status, 200);
  assert.equal(typeof config.data.enabled, 'boolean');

  const subscription = { endpoint: 'https://push.example.com/abc123', keys: { p256dh: 'key', auth: 'auth' } };
  const saved = await ana.call('/api/push/subscribe', { method: 'POST', body: subscription });
  assert.equal(saved.status, 201);
  assert.equal(dbModule.one('SELECT COUNT(*) count FROM push_subscriptions WHERE user_id = ?', context.anaId).count, 1);

  const removed = await ana.call('/api/push/subscribe', { method: 'DELETE', body: { endpoint: subscription.endpoint } });
  assert.equal(removed.status, 200);
  assert.equal(dbModule.one('SELECT COUNT(*) count FROM push_subscriptions WHERE user_id = ?', context.anaId).count, 0);
});

test('a post can be deleted by its author and disappears from the feed', async () => {
  const removed = await ben.call(`/api/posts/${context.benPostId}`, { method: 'DELETE' });
  assert.equal(removed.status, 200);
  const feed = await ben.call('/api/feed');
  assert.equal(feed.data.posts.some(post => post.id === context.benPostId), false);
});

test('signing out invalidates the session cookie', async () => {
  const client = createClient();
  await client.call('/api/auth/login', { method: 'POST', body: { username: 'ben', password: 'password-long-2' } });
  const before = await client.call('/api/feed');
  assert.equal(before.status, 200);

  const logout = await client.call('/api/auth/logout', { method: 'POST' });
  assert.equal(logout.status, 200);

  const after = await client.call('/api/feed');
  assert.equal(after.status, 401);
});

test('unknown API routes return a structured error', async () => {
  const { status, data } = await admin.call('/api/does-not-exist');
  assert.equal(status, 404);
  assert.equal(data.error.code, 'REQUEST_ERROR');
});

test('the application shell and PWA assets are served', async () => {
  const shell = await createClient().call('/');
  assert.equal(shell.status, 200);
  assert.match(shell.data, /<div id="splash"/);
  assert.match(shell.headers.get('content-security-policy'), /default-src 'self'/);

  const manifest = await createClient().call('/manifest.webmanifest');
  assert.equal(manifest.status, 200);
  assert.equal(manifest.data.display, 'standalone');

  const worker = await createClient().call('/sw.js');
  assert.equal(worker.status, 200);
  assert.match(worker.data, /addEventListener\('push'/);

  const deepLink = await createClient().call('/chat/1');
  assert.equal(deepLink.status, 200, 'client routes fall back to the app shell');
});

test('server files outside the public folder are never served', async () => {
  const attempts = ['/../src/config.js', '/%2e%2e%2fsrc%2fconfig.js', '/..%2fsrc%2fschema.sql', '/../.env.example', '/../data/circle.db'];
  for (const attempt of attempts) {
    const { data } = await createClient().call(attempt);
    const text = typeof data === 'string' ? data : JSON.stringify(data ?? '');
    assert.ok(!text.includes('APP_SECRET'), `${attempt} must not leak configuration`);
    assert.ok(!text.includes('CREATE TABLE'), `${attempt} must not leak the schema`);
    assert.ok(!text.includes('password_hash'), `${attempt} must not leak database contents`);
  }
});

test('repeated failed logins are rate limited', async () => {
  const attacker = createClient();
  let limited = false;
  for (let attempt = 0; attempt < 14; attempt += 1) {
    const { status } = await attacker.call('/api/auth/login', { method: 'POST', body: { username: 'mara', password: `guess-${attempt}` } });
    if (status === 429) { limited = true; break; }
  }
  assert.ok(limited, 'brute force attempts should be throttled');

  // Throttling is per account: when hosted, every member shares the proxy's IP address.
  const bystander = createClient();
  const { status } = await bystander.call('/api/auth/login', { method: 'POST', body: { username: 'ana', password: 'password-long-1' } });
  assert.equal(status, 200, 'another member must still be able to sign in');
});
