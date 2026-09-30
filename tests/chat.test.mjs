// Chat reliability, deletion, pagination, privacy, stories archive, and upload hardening.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { baseUrl, createClient, dbModule, pngFixture, readEvent, server } from './helpers.mjs';

const admin = createClient();
const ana = createClient();
const ben = createClient();
const ctx = {};

after(() => server.close());

// A minimal but genuine MP4 container header ("ftyp" box), as produced by Safari's recorder.
const m4aFixture = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypM4A \0\0\0\0M4A isom', 'latin1'), Buffer.alloc(64, 1)]);
const send = (client, conversationId, body) => client.call(`/api/conversations/${conversationId}/messages`, { method: 'POST', body });

before(async () => {
  await admin.call('/api/auth/bootstrap', { method: 'POST', body: { setupCode: 'test-setup-code', username: 'mara', displayName: 'Mara Quinn', password: 'circle-admin-1' } });
  for (const [client, username, displayName] of [[ana, 'ana', 'Ana Ruiz'], [ben, 'ben', 'Ben Ode']]) {
    const invite = await admin.call('/api/invites', { method: 'POST', body: { label: username } });
    const joined = await client.call('/api/auth/register', { method: 'POST', body: { inviteCode: invite.data.code, username, displayName, password: `${username}-password-1` } });
    ctx[`${username}Id`] = joined.data.user.id;
  }
  const list = await ana.call('/api/conversations');
  ctx.groupId = list.data.conversations.find(conversation => conversation.kind === 'group').id;
  ctx.directId = (await ana.call('/api/conversations/direct', { method: 'POST', body: { userId: ctx.benId } })).data.conversationId;
});

test('timestamps leave the API as unambiguous UTC ISO strings', async () => {
  const sent = await send(ana, ctx.groupId, { kind: 'text', body: 'What time is it?' });
  assert.match(sent.data.message.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
  const age = Date.now() - new Date(sent.data.message.createdAt).getTime();
  assert.ok(age >= -2000 && age < 10000, `a fresh message must be seconds old, got ${age}ms`);
  const status = await ana.call('/api/auth/status');
  assert.ok(status.data.serverTime);
  assert.match(status.data.user.createdAt, /Z$/);
});

test('re-sending with the same clientId never creates a second message', async () => {
  const clientId = 'voice-retry-0001';
  const first = await send(ana, ctx.groupId, { kind: 'text', body: 'exactly once', clientId });
  const second = await send(ana, ctx.groupId, { kind: 'text', body: 'exactly once', clientId });
  const [third, fourth] = await Promise.all([1, 2].map(() => send(ana, ctx.groupId, { kind: 'text', body: 'exactly once', clientId })));
  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  assert.equal(second.data.duplicate, true);
  for (const response of [second, third, fourth]) assert.equal(response.data.message.id, first.data.message.id);
  assert.equal(first.data.message.clientId, clientId);
  assert.equal(dbModule.one('SELECT COUNT(*) count FROM messages WHERE client_id = ?', clientId).count, 1);

  const invalid = await send(ana, ctx.groupId, { kind: 'text', body: 'bad id', clientId: '<script>' });
  assert.equal(invalid.status, 400);
});

test('a voice message stores its duration and waveform exactly once, and plays for members only', async () => {
  const upload = await ana.call('/api/media?purpose=voice', { method: 'POST', binary: { buffer: m4aFixture, type: 'audio/mp4', name: 'voice.m4a' } });
  assert.equal(upload.status, 201);
  const clientId = 'voice-message-0001';
  const payload = { kind: 'voice', mediaId: upload.data.media.id, durationMs: 4200, waveform: [0, 20, 80, 140, -5, 50], clientId };
  const [a, b] = await Promise.all([send(ana, ctx.directId, payload), send(ana, ctx.directId, payload)]);
  assert.equal(a.data.message.id, b.data.message.id, 'a double-tapped send yields one message');
  assert.equal(dbModule.one("SELECT COUNT(*) count FROM messages WHERE kind = 'voice' AND sender_id = ?", ctx.anaId).count, 1);
  const message = a.data.message;
  assert.equal(message.media.durationMs, 4200);
  assert.deepEqual(message.media.waveform, [0, 20, 80, 100, 0, 50], 'waveform values are clamped to 0-100');
  assert.equal(message.media.mimeType, 'audio/mp4');
  ctx.voiceMediaId = upload.data.media.id;
  ctx.voiceMessageId = message.id;

  assert.equal((await ben.call(`/api/media/${ctx.voiceMediaId}`)).status, 200);
  assert.equal((await admin.call(`/api/media/${ctx.voiceMediaId}`)).status, 403, 'outsiders cannot play a private voice message');

  const ranged = await ben.call(`/api/media/${ctx.voiceMediaId}`, { headers: { range: 'bytes=0-1' } });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers.get('content-range'), `bytes 0-1/${m4aFixture.length}`);
  const suffix = await ben.call(`/api/media/${ctx.voiceMediaId}`, { headers: { range: 'bytes=-10' } });
  assert.equal(suffix.headers.get('content-range'), `bytes ${m4aFixture.length - 10}-${m4aFixture.length - 1}/${m4aFixture.length}`);
  const clamped = await ben.call(`/api/media/${ctx.voiceMediaId}`, { headers: { range: 'bytes=0-999999' } });
  assert.equal(clamped.headers.get('content-length'), String(m4aFixture.length), 'range end is clamped to the file size');
  const unsatisfiable = await ben.call(`/api/media/${ctx.voiceMediaId}`, { headers: { range: `bytes=${m4aFixture.length}-` } });
  assert.equal(unsatisfiable.status, 416);

  const wrongKind = await send(ana, ctx.directId, { kind: 'image', mediaId: ctx.voiceMediaId });
  assert.equal(wrongKind.status, 403, 'voice media cannot be relabelled as a photo');
});

test('every member tab receives exactly one message:created, including the sender', async () => {
  const controller = new AbortController();
  const stream = await ana.call('/api/events', { stream: true, signal: controller.signal });
  const reader = stream.response.body.getReader();
  await readEvent(reader, 'connected');
  const sent = await send(ana, ctx.groupId, { kind: 'text', body: 'my other tab should see this', clientId: 'multi-tab-00001' });
  const event = await readEvent(reader, 'message:created');
  assert.equal(event.message.id, sent.data.message.id);
  assert.equal(event.message.isMine, true);
  assert.equal(event.message.clientId, 'multi-tab-00001', 'the sender can reconcile its optimistic copy');
  await send(ana, ctx.groupId, { kind: 'text', body: 'my other tab should see this', clientId: 'multi-tab-00001' });
  await assert.rejects(readEvent(reader, 'message:created', 800), /Timed out/, 'a duplicate send is not re-broadcast');
  controller.abort();
});

test('only the author can edit a text message, and edits are synchronised', async () => {
  const sent = await send(ben, ctx.groupId, { kind: 'text', body: 'Dinner at 7' });
  const foreign = await ana.call(`/api/messages/${sent.data.message.id}`, { method: 'PATCH', body: { body: 'hijacked' } });
  assert.equal(foreign.status, 403);
  const edited = await ben.call(`/api/messages/${sent.data.message.id}`, { method: 'PATCH', body: { body: 'Dinner at 8' } });
  assert.equal(edited.status, 200);
  assert.equal(edited.data.message.body, 'Dinner at 8');
  assert.ok(edited.data.message.editedAt);
  const voiceEdit = await ana.call(`/api/messages/${ctx.voiceMessageId}`, { method: 'PATCH', body: { body: 'text' } });
  assert.equal(voiceEdit.status, 400);
});

test('delete for me hides a message only from me; delete for everyone removes content and access', async () => {
  const sent = await send(ben, ctx.groupId, { kind: 'text', body: 'hide me' });
  const hidden = await ana.call(`/api/messages/${sent.data.message.id}?scope=me`, { method: 'DELETE' });
  assert.equal(hidden.status, 200);
  const anaView = await ana.call(`/api/conversations/${ctx.groupId}/messages`);
  const benView = await ben.call(`/api/conversations/${ctx.groupId}/messages`);
  assert.equal(anaView.data.messages.some(message => message.id === sent.data.message.id), false);
  assert.equal(benView.data.messages.some(message => message.id === sent.data.message.id), true);

  const controller = new AbortController();
  const stream = await ben.call('/api/events', { stream: true, signal: controller.signal });
  const reader = stream.response.body.getReader();
  await readEvent(reader, 'connected');
  const removed = await ana.call(`/api/messages/${ctx.voiceMessageId}?scope=everyone`, { method: 'DELETE' });
  assert.equal(removed.status, 200);
  const event = await readEvent(reader, 'message:deleted');
  assert.equal(event.messageId, ctx.voiceMessageId);
  assert.equal(event.scope, 'everyone');
  controller.abort();

  assert.equal((await ben.call(`/api/media/${ctx.voiceMediaId}`)).status, 403, 'deleted voice media is no longer readable');
  assert.equal((await ana.call(`/api/media/${ctx.voiceMediaId}`)).status, 403, 'even the uploader cannot bypass delete-for-everyone with the old URL');
  const reaction = await ben.call(`/api/messages/${ctx.voiceMessageId}/reaction`, { method: 'POST', body: { reaction: '🔥' } });
  assert.equal(reaction.status, 410);
  const conversations = await ben.call('/api/conversations');
  const direct = conversations.data.conversations.find(conversation => conversation.id === ctx.directId);
  assert.notEqual(direct.lastMessage?.id, ctx.voiceMessageId, 'a deleted message is never the chat preview');
});

test('history pages backwards, catches up forwards, and opens around a message', async () => {
  const ids = [];
  for (let index = 0; index < 60; index += 1) {
    ids.push(Number(dbModule.run("INSERT INTO messages(conversation_id, sender_id, kind, body) VALUES (?, ?, 'text', ?)", ctx.directId, ctx.benId, `page message ${index}`).lastInsertRowid));
  }
  const latest = await ana.call(`/api/conversations/${ctx.directId}/messages`);
  assert.equal(latest.data.messages.length, 50);
  assert.equal(latest.data.messages.at(-1).id, ids.at(-1));
  assert.ok(latest.data.nextCursor);
  const older = await ana.call(`/api/conversations/${ctx.directId}/messages?before=${latest.data.nextCursor}`);
  assert.ok(older.data.messages.every(message => message.id < latest.data.nextCursor));
  const after = await ana.call(`/api/conversations/${ctx.directId}/messages?after=${ids[54]}`);
  assert.deepEqual(after.data.messages.map(message => message.id), ids.slice(55));
  assert.equal(after.data.hasNewer, false);
  const around = await ana.call(`/api/conversations/${ctx.directId}/messages?around=${ids[20]}`);
  assert.ok(around.data.messages.some(message => message.id === ids[20]));
  assert.equal(around.data.hasNewer, true);
  const bad = await ana.call(`/api/conversations/${ctx.directId}/messages?before=abc`);
  assert.equal(bad.status, 400);
});

test('pinning, forwarding, and per-member chat settings', async () => {
  const sent = await send(ana, ctx.groupId, { kind: 'text', body: 'Trip on the 12th — pin this' });
  const pinned = await ben.call(`/api/conversations/${ctx.groupId}/pin`, { method: 'POST', body: { messageId: sent.data.message.id } });
  assert.equal(pinned.status, 200);
  const conversation = (await admin.call(`/api/conversations/${ctx.groupId}`)).data.conversation;
  assert.equal(conversation.pinnedMessage.id, sent.data.message.id);
  const foreignPin = await admin.call(`/api/conversations/${ctx.directId}/pin`, { method: 'POST', body: { messageId: sent.data.message.id } });
  assert.equal(foreignPin.status, 403);

  const forwarded = await ana.call(`/api/messages/${sent.data.message.id}/forward`, { method: 'POST', body: { conversationIds: [ctx.directId], operationId: 'forward-single-0001' } });
  assert.equal(forwarded.status, 201);
  assert.equal(forwarded.data.messages[0].forwardedFrom.id, ctx.anaId);
  assert.equal(forwarded.data.messages[0].conversationId, ctx.directId);
  const intoForeign = await admin.call(`/api/messages/${sent.data.message.id}/forward`, { method: 'POST', body: { conversationIds: [ctx.directId], operationId: 'forward-single-0001' } });
  assert.equal(intoForeign.status, 403, 'you cannot forward into a chat you are not in');

  const settings = await ana.call(`/api/conversations/${ctx.directId}/settings`, { method: 'POST', body: { pinned: true, muted: true } });
  assert.equal(settings.data.conversation.pinned, true);
  assert.equal(settings.data.conversation.muted, true);
  const list = await ana.call('/api/conversations');
  assert.equal(list.data.conversations[0].id, ctx.directId, 'pinned chats sort first');
  const benList = await ben.call('/api/conversations');
  assert.equal(benList.data.conversations.find(item => item.id === ctx.directId).muted, false, 'settings are per member');
});

test('messages no longer flood the Activity feed', async () => {
  const before = dbModule.one("SELECT COUNT(*) count FROM notifications WHERE kind = 'message'").count;
  await send(ben, ctx.groupId, { kind: 'text', body: 'no activity row please' });
  assert.equal(dbModule.one("SELECT COUNT(*) count FROM notifications WHERE kind = 'message'").count, before);
});

test('search only returns messages from conversations the caller belongs to', async () => {
  await send(ana, ctx.directId, { kind: 'text', body: 'secret-kiwi between ana and ben' });
  const found = await ben.call('/api/search?q=secret-kiwi');
  assert.equal(found.data.messages.length, 1);
  assert.ok(found.data.messages[0].conversationTitle);
  const outsider = await admin.call('/api/search?q=secret-kiwi');
  assert.equal(outsider.data.messages.length, 0, 'a private message is invisible to non-members');
  const members = await admin.call('/api/search?q=ben');
  assert.ok(members.data.members.some(member => member.username === 'ben'));
  const wildcard = await admin.call('/api/search?q=%25%25');
  assert.equal(wildcard.data.messages.length, 0, 'LIKE wildcards are escaped');
});

test('hiding last seen removes presence details for others but not for yourself', async () => {
  const updated = await ben.call('/api/profile/privacy', { method: 'PATCH', body: { showLastSeen: false } });
  assert.equal(updated.status, 200);
  assert.equal(updated.data.user.privacy.showLastSeen, false);
  dbModule.run('UPDATE users SET last_seen_at = ? WHERE id = ?', new Date().toISOString(), ctx.benId);
  const members = await ana.call('/api/members');
  const seen = members.data.members.find(member => member.id === ctx.benId);
  assert.equal(seen.lastSeenAt, null);
  assert.equal(seen.online, false);
  assert.equal(seen.presenceHidden, true);
  const self = await ben.call('/api/auth/status');
  assert.ok(self.data.user.lastSeenAt);
  const invalid = await ben.call('/api/profile/privacy', { method: 'PATCH', body: { showLastSeen: 'nope' } });
  assert.equal(invalid.status, 400);
  await ben.call('/api/profile/privacy', { method: 'PATCH', body: { showLastSeen: true } });
});

test('authors can see their own stories and viewers, including expired ones; others cannot', async () => {
  const upload = await ana.call('/api/media?purpose=story', { method: 'POST', binary: { buffer: pngFixture, type: 'image/png', name: 'story.png' } });
  const story = (await ana.call('/api/stories', { method: 'POST', body: { mediaId: upload.data.media.id, caption: 'Summit' } })).data.story;
  assert.equal(story.viewCount, 0);
  await ben.call(`/api/stories/${story.id}/view`, { method: 'POST' });
  await ben.call(`/api/stories/${story.id}/view`, { method: 'POST' });
  await ana.call(`/api/stories/${story.id}/view`, { method: 'POST' });
  await ben.call(`/api/stories/${story.id}/reaction`, { method: 'POST', body: { reaction: '🔥' } });

  const views = await ana.call(`/api/stories/${story.id}/views`);
  assert.equal(views.data.views.length, 1, 'repeat views and self-views never duplicate viewers');
  assert.equal(views.data.views[0].user.id, ctx.benId);
  assert.equal(views.data.views[0].reaction, '🔥');
  assert.match(views.data.views[0].viewedAt, /Z$/);
  assert.equal((await ben.call(`/api/stories/${story.id}/views`)).status, 403);
  const benList = await ben.call('/api/stories');
  assert.equal(benList.data.stories.find(item => item.id === story.id).views, undefined, 'viewer lists are private to the author');

  dbModule.run('UPDATE stories SET expires_at = ? WHERE id = ?', new Date(Date.now() - 1000).toISOString(), story.id);
  const archive = await ana.call('/api/stories/archive');
  const archived = archive.data.stories.find(item => item.id === story.id);
  assert.ok(archived, 'expired stories stay in the author\'s archive');
  assert.equal(archived.expired, true);
  assert.equal(archived.views.length, 1);
  assert.equal((await ben.call('/api/stories/archive')).data.stories.length, 0, 'the archive only ever contains your own stories');
  assert.equal((await ana.call(`/api/media/${upload.data.media.id}`)).status, 200);
  assert.equal((await ben.call(`/api/media/${upload.data.media.id}`)).status, 403, 'expired story media is closed to others');
});

test('uploads are verified by content, not by the declared type', async () => {
  const cases = [
    { buffer: Buffer.from('<html><script>alert(1)</script></html>'), type: 'audio/mpeg' },
    { buffer: Buffer.from('not really a jpeg at all'), type: 'image/jpeg' },
    { buffer: pngFixture, type: 'audio/webm' }
  ];
  for (const item of cases) {
    const response = await ana.call('/api/media?purpose=chat', { method: 'POST', binary: { ...item, name: 'x' } });
    assert.equal(response.status, 415, `${item.type} with the wrong content must be rejected`);
  }
  const pngAsVoice = await ana.call('/api/media?purpose=voice', { method: 'POST', binary: { buffer: pngFixture, type: 'image/png', name: 'x.png' } });
  assert.equal(pngAsVoice.status, 415);
  const badName = await ana.call('/api/media?purpose=chat', { method: 'POST', headers: { 'x-file-name': '%E0%A4%A' }, binary: { buffer: pngFixture, type: 'image/png', name: '%E0%A4%A' } });
  assert.equal(badName.status, 201, 'a malformed file name header is tolerated, not a server error');
});

test('malformed cookies and push endpoints are handled safely', async () => {
  const response = await fetch(`${baseUrl}/api/auth/status`, { headers: { cookie: 'circle_session=%E0%A4%A; other' } });
  assert.equal(response.status, 200);
  const invalid = await ana.call('/api/push/subscribe', { method: 'POST', body: { endpoint: 'file:///etc/passwd', keys: { p256dh: 'a', auth: 'b' } } });
  assert.equal(invalid.status, 400);
});
