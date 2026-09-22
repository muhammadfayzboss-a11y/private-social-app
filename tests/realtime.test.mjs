import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createClient, readEvent, server } from './helpers.mjs';

const admin = createClient();
const ana = createClient();

after(() => server.close());

test('realtime stream requires authentication', async () => {
  const { status } = await createClient().call('/api/events');
  assert.equal(status, 401);
});

test('messages, reactions, and notifications arrive over the realtime stream', async () => {
  await admin.call('/api/auth/bootstrap', {
    method: 'POST', body: { setupCode: 'test-setup-code', username: 'mara', displayName: 'Mara Quinn', password: 'circle-admin-1' }
  });
  const invite = await admin.call('/api/invites', { method: 'POST', body: { label: 'Ana' } });
  const joined = await ana.call('/api/auth/register', {
    method: 'POST', body: { inviteCode: invite.data.code, username: 'ana', displayName: 'Ana Ruiz', password: 'password-long-1' }
  });
  const anaId = joined.data.user.id;

  const controller = new AbortController();
  const stream = await admin.call('/api/events', { stream: true, signal: controller.signal });
  assert.equal(stream.status, 200);
  assert.match(stream.response.headers.get('content-type'), /text\/event-stream/);
  const reader = stream.response.body.getReader();

  const connected = await readEvent(reader, 'connected');
  assert.ok(connected.userId);

  const conversations = await admin.call('/api/conversations');
  const groupId = conversations.data.conversations.find(conversation => conversation.kind === 'group').id;

  // A message sent by Ana must reach the admin's open stream without polling.
  const sent = await ana.call(`/api/conversations/${groupId}/messages`, { method: 'POST', body: { kind: 'text', body: 'Live from the stream' } });
  assert.equal(sent.status, 201);
  const delivered = await readEvent(reader, 'message:created');
  assert.equal(delivered.conversationId, groupId);
  assert.equal(delivered.message.body, 'Live from the stream');
  assert.equal(delivered.message.sender.id, anaId);
  // The payload must be rendered from the recipient's perspective, not the sender's.
  assert.equal(delivered.message.isMine, false, 'an incoming message must not be marked as the recipient\'s own');

  // Typing indicators propagate.
  await ana.call(`/api/conversations/${groupId}/typing`, { method: 'POST', body: { typing: true } });
  const typing = await readEvent(reader, 'typing');
  assert.equal(typing.userId, anaId);
  assert.equal(typing.typing, true);

  // New posts and their reactions are pushed to other members.
  const post = await ana.call('/api/posts', { method: 'POST', body: { body: 'Realtime post' } });
  const broadcastPost = await readEvent(reader, 'post:created');
  assert.equal(broadcastPost.post.body, 'Realtime post');

  // Notifications are pushed to the owner of the content.
  const adminPost = await admin.call('/api/posts', { method: 'POST', body: { body: 'Admin post for notification' } });
  await ana.call(`/api/posts/${adminPost.data.post.id}/reaction`, { method: 'POST', body: { reaction: 'heart' } });
  const notification = await readEvent(reader, 'notification');
  assert.equal(notification.kind, 'post_reaction');
  assert.equal(notification.actor.username, 'ana');

  // Presence is announced when a member disconnects.
  const anaController = new AbortController();
  const anaStream = await ana.call('/api/events', { stream: true, signal: anaController.signal });
  const anaReader = anaStream.response.body.getReader();
  await readEvent(anaReader, 'connected');
  const online = await readEvent(reader, 'presence');
  assert.equal(online.userId, anaId);
  assert.equal(online.online, true);

  anaController.abort();
  const offline = await readEvent(reader, 'presence');
  assert.equal(offline.userId, anaId);
  assert.equal(offline.online, false);

  controller.abort();
});
