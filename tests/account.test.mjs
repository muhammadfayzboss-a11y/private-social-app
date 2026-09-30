// Settings sync, privacy (blocks, read receipts, story privacy), devices, chat organisation, files,
// mentions, batch actions, search filters, and link-preview SSRF protection.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createClient, dbModule, pngFixture, readEvent, server } from './helpers.mjs';
import { isPrivateAddress, parsePreview, validatePreviewUrl } from '../src/linkPreview.js';

const admin = createClient();
const ana = createClient();
const ben = createClient();
const ctx = {};
const send = (client, conversationId, body) => client.call(`/api/conversations/${conversationId}/messages`, { method: 'POST', body });

after(() => server.close());

before(async () => {
  await admin.call('/api/auth/bootstrap', { method: 'POST', body: { setupCode: 'test-setup-code', username: 'mara', displayName: 'Mara Quinn', password: 'circle-admin-1' } });
  for (const [client, username, displayName] of [[ana, 'ana', 'Ana Ruiz'], [ben, 'ben', 'Ben Ode']]) {
    const invite = await admin.call('/api/invites', { method: 'POST', body: { label: username } });
    const joined = await client.call('/api/auth/register', { method: 'POST', body: { inviteCode: invite.data.code, username, displayName, password: `${username}-password-1` } });
    ctx[`${username}Id`] = joined.data.user.id;
  }
  ctx.maraId = (await admin.call('/api/auth/status')).data.user.id;
  ctx.groupId = (await ana.call('/api/conversations')).data.conversations.find(item => item.kind === 'group').id;
  ctx.directId = (await ana.call('/api/conversations/direct', { method: 'POST', body: { userId: ctx.benId } })).data.conversationId;
});

test('settings are validated, merged, synced, and returned with the session', async () => {
  const saved = await ana.call('/api/settings', { method: 'PATCH', body: { settings: {
    appearance: { theme: 'amoled', fontSize: 99, wallpaper: { id: 'aurora', blur: 6, dim: 30 } }, language: 'uz',
    notifications: { groups: false }, chat: { enterToSend: 'yes' }, injected: { evil: true }, folders: [{ name: 'Work', groups: true, chatIds: [ctx.groupId, 'x'] }]
  } } });
  assert.equal(saved.status, 200);
  const settings = saved.data.settings;
  assert.equal(settings.appearance.theme, 'amoled');
  assert.equal(settings.appearance.fontSize, 21, 'numbers are clamped');
  assert.equal(settings.appearance.wallpaper.id, 'aurora');
  assert.equal(settings.language, 'uz');
  assert.equal(settings.notifications.groups, false);
  assert.equal(settings.notifications.messages, true, 'untouched values keep their defaults');
  assert.equal(settings.chat.enterToSend, false, 'wrong types fall back to defaults');
  assert.equal(settings.injected, undefined, 'unknown keys are dropped');
  assert.deepEqual(settings.folders[0].chatIds, [ctx.groupId]);
  const status = await ana.call('/api/auth/status');
  assert.equal(status.data.settings.appearance.theme, 'amoled');
  const badTheme = await ana.call('/api/settings', { method: 'PATCH', body: { appearance: { theme: 'neon' } } });
  assert.equal(badTheme.data.settings.appearance.theme, 'amoled', 'an invalid enum keeps the stored value');
  const foreignWallpaper = await ben.call('/api/media?purpose=wallpaper', { method: 'POST', binary: { buffer: pngFixture, type: 'image/png', name: 'w.png' } });
  const stolen = await ana.call('/api/settings', { method: 'PATCH', body: { appearance: { wallpaper: { id: 'custom', mediaId: foreignWallpaper.data.media.id } } } });
  assert.equal(stolen.status, 403, 'another member\'s wallpaper cannot be referenced');
  assert.equal((await ana.call(`/api/media/${foreignWallpaper.data.media.id}`)).status, 403, 'wallpapers are private to their owner');
});

test('usernames can be changed but must stay unique and valid', async () => {
  const taken = await ana.call('/api/profile/username', { method: 'PATCH', body: { username: 'ben' } });
  assert.equal(taken.status, 409);
  const invalid = await ana.call('/api/profile/username', { method: 'PATCH', body: { username: 'a b' } });
  assert.equal(invalid.status, 400);
  const changed = await ana.call('/api/profile/username', { method: 'PATCH', body: { username: 'ana_r' } });
  assert.equal(changed.data.user.username, 'ana_r');
  await ana.call('/api/profile/username', { method: 'PATCH', body: { username: 'ana' } });
});

test('blocking closes the direct chat both ways and hides presence and stories', async () => {
  const blocked = await ben.call('/api/blocks', { method: 'POST', body: { userId: ctx.anaId } });
  assert.equal(blocked.status, 201);
  assert.equal((await send(ana, ctx.directId, { kind: 'text', body: 'hello?' })).status, 403, 'the blocked member cannot message the blocker');
  const own = await send(ben, ctx.directId, { kind: 'text', body: 'hi' });
  assert.equal(own.status, 403, 'the blocker must unblock before writing');
  assert.match(own.data.error.message, /Unblock/);
  const conversation = (await ben.call(`/api/conversations/${ctx.directId}`)).data.conversation;
  assert.deepEqual(conversation.blocked, { byMe: true, byThem: false });

  dbModule.run('UPDATE users SET last_seen_at = ? WHERE id = ?', new Date().toISOString(), ctx.benId);
  const seenByAna = (await ana.call('/api/members')).data.members.find(member => member.id === ctx.benId);
  assert.equal(seenByAna.lastSeenAt, null);
  assert.equal(seenByAna.presenceHidden, true);

  const upload = await ben.call('/api/media?purpose=story', { method: 'POST', binary: { buffer: pngFixture, type: 'image/png', name: 's.png' } });
  const story = (await ben.call('/api/stories', { method: 'POST', body: { mediaId: upload.data.media.id } })).data.story;
  assert.equal((await ana.call('/api/stories')).data.stories.some(item => item.id === story.id), false);
  assert.equal((await ana.call(`/api/stories/${story.id}/view`, { method: 'POST' })).status, 404);
  assert.equal((await ana.call(`/api/media/${upload.data.media.id}`)).status, 403, 'story media is closed to blocked members');
  assert.equal((await ben.call('/api/blocks')).data.blocked[0].id, ctx.anaId);

  assert.equal((await ben.call(`/api/blocks/${ctx.anaId}`, { method: 'DELETE' })).status, 200);
  assert.equal((await send(ana, ctx.directId, { kind: 'text', body: 'hello again' })).status, 201);
  assert.equal((await ana.call(`/api/media/${upload.data.media.id}`)).status, 200);
  ctx.benStoryId = story.id;
});

test('story privacy hides stories from chosen members and can turn replies off', async () => {
  const saved = await ben.call('/api/stories/privacy', { method: 'PUT', body: { hiddenFrom: [ctx.maraId, ctx.benId] } });
  assert.deepEqual(saved.data.hiddenFrom, [ctx.maraId], 'you cannot hide stories from yourself');
  assert.equal((await admin.call('/api/stories')).data.stories.some(item => item.id === ctx.benStoryId), false);
  assert.equal((await ana.call('/api/stories')).data.stories.some(item => item.id === ctx.benStoryId), true);
  await ben.call('/api/settings', { method: 'PATCH', body: { privacy: { storyReplies: false } } });
  const reply = await ana.call(`/api/stories/${ctx.benStoryId}/reply`, { method: 'POST', body: { body: 'nice' } });
  assert.equal(reply.status, 403);
  await ben.call('/api/settings', { method: 'PATCH', body: { privacy: { storyReplies: true } } });
  await ben.call('/api/stories/privacy', { method: 'PUT', body: { hiddenFrom: [] } });
  assert.equal((await admin.call('/api/stories')).data.stories.some(item => item.id === ctx.benStoryId), true);
});

test('read receipts are reciprocal when a member turns them off', async () => {
  const sent = await send(ana, ctx.groupId, { kind: 'text', body: 'did you read this?' });
  await ben.call(`/api/conversations/${ctx.groupId}/read`, { method: 'POST', body: { messageId: sent.data.message.id } });
  const before = (await ana.call(`/api/conversations/${ctx.groupId}/messages`)).data.messages.find(item => item.id === sent.data.message.id);
  assert.ok(before.readBy.some(reader => reader.id === ctx.benId));
  await ben.call('/api/profile/privacy', { method: 'PATCH', body: { readReceipts: false } });
  const hidden = (await ana.call(`/api/conversations/${ctx.groupId}/messages`)).data.messages.find(item => item.id === sent.data.message.id);
  assert.equal(hidden.readBy.some(reader => reader.id === ctx.benId), false, 'Ben no longer shares read state');
  const benOwn = await send(ben, ctx.groupId, { kind: 'text', body: 'my message' });
  await ana.call(`/api/conversations/${ctx.groupId}/read`, { method: 'POST', body: { messageId: benOwn.data.message.id } });
  const benView = (await ben.call(`/api/conversations/${ctx.groupId}/messages`)).data.messages.find(item => item.id === benOwn.data.message.id);
  assert.deepEqual(benView.readBy, [], 'and Ben sees no read receipts himself');
  assert.equal((await ben.call('/api/auth/status')).data.user.privacy.readReceipts, false);
  await ben.call('/api/profile/privacy', { method: 'PATCH', body: { readReceipts: true } });
});

test('devices list the member\'s own sessions and can be signed out remotely', async () => {
  const second = createClient();
  await second.call('/api/auth/login', { method: 'POST', body: { username: 'ana', password: 'ana-password-1' }, headers: { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/605.1.15' } });
  const sessions = (await ana.call('/api/sessions')).data.sessions;
  assert.ok(sessions.length >= 2);
  assert.equal(sessions.filter(item => item.current).length, 1);
  const phone = sessions.find(item => item.device.os === 'iPhone');
  assert.ok(phone, 'devices are described from their user agent');
  assert.equal((await ben.call(`/api/sessions/${phone.id}`, { method: 'DELETE' })).status, 404, 'another member\'s session cannot be ended');
  assert.equal((await ana.call(`/api/sessions/${phone.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await second.call('/api/feed')).status, 401, 'the removed device is signed out');
  const current = sessions.find(item => item.current);
  assert.equal((await ana.call(`/api/sessions/${current.id}`, { method: 'DELETE' })).status, 400);
  const third = createClient();
  await third.call('/api/auth/login', { method: 'POST', body: { username: 'ana', password: 'ana-password-1' } });
  const ended = await ana.call('/api/sessions/terminate-others', { method: 'POST' });
  assert.ok(ended.data.removed >= 1);
  assert.equal((await third.call('/api/feed')).status, 401);
  assert.equal((await ana.call('/api/feed')).status, 200, 'the current device stays signed in');
});

test('archive, mark as unread, and delete-for-me organise chats per member', async () => {
  await send(ben, ctx.directId, { kind: 'text', body: 'archive me' });
  await ana.call(`/api/conversations/${ctx.directId}/settings`, { method: 'POST', body: { archived: true } });
  await send(ben, ctx.directId, { kind: 'text', body: 'still archived?' });
  const list = (await ana.call('/api/conversations')).data.conversations.find(item => item.id === ctx.directId);
  assert.equal(list.archived, true, 'new messages never pull an archived chat back out');
  assert.equal((await ben.call('/api/conversations')).data.conversations.find(item => item.id === ctx.directId).archived, false);
  await ana.call(`/api/conversations/${ctx.directId}/settings`, { method: 'POST', body: { archived: false, markedUnread: true } });
  assert.equal((await ana.call(`/api/conversations/${ctx.directId}`)).data.conversation.markedUnread, true);
  const last = (await ana.call(`/api/conversations/${ctx.directId}/messages`)).data.messages.at(-1);
  await ana.call(`/api/conversations/${ctx.directId}/read`, { method: 'POST', body: { messageId: last.id } });
  assert.equal((await ana.call(`/api/conversations/${ctx.directId}`)).data.conversation.markedUnread, false, 'reading clears the mark');

  const cleared = await ana.call(`/api/conversations/${ctx.directId}/clear`, { method: 'POST' });
  assert.equal(cleared.status, 200);
  assert.equal((await ana.call('/api/conversations')).data.conversations.some(item => item.id === ctx.directId), false, 'deleted chats leave the list');
  assert.equal((await ana.call(`/api/conversations/${ctx.directId}/messages`)).data.messages.length, 0);
  assert.ok((await ben.call(`/api/conversations/${ctx.directId}/messages`)).data.messages.length > 0, 'the other member keeps their history');
  await send(ben, ctx.directId, { kind: 'text', body: 'are you there?' });
  const back = (await ana.call('/api/conversations')).data.conversations.find(item => item.id === ctx.directId);
  assert.equal(back.lastMessage.body, 'are you there?', 'the chat returns with only the new message');
  assert.equal((await ana.call(`/api/conversations/${ctx.directId}/messages`)).data.messages.length, 1);
});

test('members can create, rename, and leave their own groups — but not the main circle', async () => {
  const created = await ana.call('/api/conversations/group', { method: 'POST', body: { title: 'Weekend trip', memberIds: [ctx.benId] } });
  assert.equal(created.status, 201);
  const group = created.data.conversation;
  assert.equal(group.members.length, 2);
  assert.equal((await admin.call(`/api/conversations/${group.id}/messages`)).status, 403, 'non-members stay out');
  assert.equal((await ben.call(`/api/conversations/${group.id}`, { method: 'PATCH', body: { title: 'Hijack' } })).status, 403);
  assert.equal((await ana.call(`/api/conversations/${group.id}`, { method: 'PATCH', body: { title: 'Trip 🏔' } })).data.conversation.title, 'Trip 🏔');
  assert.equal((await ben.call(`/api/conversations/${ctx.groupId}/leave`, { method: 'POST' })).status, 400, 'the main group cannot be left');
  assert.equal((await ben.call(`/api/conversations/${group.id}/leave`, { method: 'POST' })).status, 200);
  assert.equal((await ben.call(`/api/conversations/${group.id}/messages`)).status, 403);
  ctx.tripId = group.id;
});

test('files are shared as downloads, never rendered inline', async () => {
  const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(200, 32)]);
  const upload = await ana.call('/api/media?purpose=file', { method: 'POST', binary: { buffer: pdf, type: 'application/pdf', name: encodeURIComponent('Report — Q3.pdf') } });
  assert.equal(upload.status, 201);
  const sent = await send(ana, ctx.groupId, { kind: 'file', mediaId: upload.data.media.id, body: 'Here is the report' });
  assert.equal(sent.status, 201);
  assert.equal(sent.data.message.media.name, 'Report — Q3.pdf');
  assert.equal(sent.data.message.media.size, pdf.length);
  const download = await ben.call(`/api/media/${upload.data.media.id}`);
  assert.equal(download.status, 200);
  assert.match(download.headers.get('content-disposition'), /^attachment;.*filename\*=UTF-8''Report%20%E2%80%94%20Q3\.pdf/);
  const html = await ana.call('/api/media?purpose=file', { method: 'POST', binary: { buffer: Buffer.from('<html><script>x</script>'), type: 'text/html', name: 'x.html' } });
  assert.equal(html.status, 415, 'HTML cannot be uploaded');
  const disguised = await ana.call('/api/media?purpose=file', { method: 'POST', binary: { buffer: Buffer.from([0, 1, 2, 3, 0, 5]), type: 'text/plain', name: 'x.txt' } });
  assert.equal(disguised.status, 415, 'binary data labelled as text is refused');
  const text = await ana.call('/api/media?purpose=file', { method: 'POST', binary: { buffer: Buffer.from('notes ✓\n'), type: 'text/plain', name: 'notes.txt' } });
  assert.equal(text.status, 201);
  assert.equal((await ana.call('/api/media?purpose=avatar', { method: 'POST', binary: { buffer: pdf, type: 'application/pdf', name: 'a.pdf' } })).status, 415, 'avatars must be images');
  const photo = await ana.call('/api/media?purpose=chat', { method: 'POST', binary: { buffer: pngFixture, type: 'image/png', name: 'p.png' }, headers: { 'x-media-thumb': 'data:image/jpeg;base64,/9j/AAAA' } });
  const photoMessage = await send(ana, ctx.groupId, { kind: 'image', mediaId: photo.data.media.id });
  assert.equal(photoMessage.data.message.media.thumb, 'data:image/jpeg;base64,/9j/AAAA');
  const badThumb = await ana.call('/api/media?purpose=chat', { method: 'POST', binary: { buffer: pngFixture, type: 'image/png', name: 'p.png' }, headers: { 'x-media-thumb': 'javascript:alert(1)' } });
  const badThumbMessage = await send(ana, ctx.groupId, { kind: 'image', mediaId: badThumb.data.media.id });
  assert.equal(badThumbMessage.data.message.media.thumb, null);
  const shared = await ben.call(`/api/conversations/${ctx.groupId}/media?type=files`);
  assert.ok(shared.data.items.some(item => item.kind === 'file'));
  ctx.fileMessageId = sent.data.message.id;
});

test('mentions and reactions to your messages reach you as activity', async () => {
  await ben.call(`/api/conversations/${ctx.groupId}/settings`, { method: 'POST', body: { muted: true } });
  const mention = await send(ana, ctx.groupId, { kind: 'text', body: 'hey @ben, look at this (also @nobody)' });
  const reaction = await ben.call(`/api/messages/${ctx.fileMessageId}/reaction`, { method: 'POST', body: { reaction: '👍' } });
  assert.equal(reaction.status, 200);
  await ben.call(`/api/messages/${ctx.fileMessageId}/reaction`, { method: 'POST', body: { reaction: '👍' } });
  const benActivity = (await ben.call('/api/activity')).data.notifications;
  assert.ok(benActivity.some(item => item.kind === 'mention' && item.entityId === String(ctx.groupId)), 'mentions notify even in a muted group');
  const anaActivity = (await ana.call('/api/activity')).data.notifications.filter(item => item.kind === 'message_reaction');
  assert.equal(anaActivity.length, 1, 're-sending the same reaction does not notify twice');
  assert.equal(anaActivity[0].message, '👍');
  assert.ok(mention.status === 201);
});

test('batch delete and batch forward act on many messages safely', async () => {
  const ids = [];
  for (const body of ['one', 'two', 'three']) ids.push((await send(ana, ctx.groupId, { kind: 'text', body })).data.message.id);
  const foreign = (await send(ben, ctx.groupId, { kind: 'text', body: 'not yours' })).data.message.id;
  const refused = await ana.call(`/api/conversations/${ctx.groupId}/messages/delete`, { method: 'POST', body: { messageIds: [...ids, foreign], scope: 'everyone' } });
  assert.equal(refused.status, 403, 'one foreign message blocks the whole batch');
  assert.equal(dbModule.one('SELECT COUNT(*) count FROM messages WHERE id IN (?, ?, ?) AND deleted_at IS NULL', ...ids).count, 3, 'nothing was deleted');
  const forwarded = await ana.call('/api/messages/forward', { method: 'POST', body: { messageIds: [ids[1], ids[0]], conversationIds: [ctx.tripId] } });
  assert.equal(forwarded.status, 201);
  assert.deepEqual(forwarded.data.messages.map(message => message.body), ['one', 'two'], 'forwarded in original order');
  const done = await ana.call(`/api/conversations/${ctx.groupId}/messages/delete`, { method: 'POST', body: { messageIds: ids, scope: 'everyone' } });
  assert.equal(done.data.deleted, 3);
  const mine = await ben.call(`/api/conversations/${ctx.groupId}/messages/delete`, { method: 'POST', body: { messageIds: [foreign, ids[0]], scope: 'me' } });
  assert.equal(mine.status, 200);
  const elsewhere = await ana.call(`/api/conversations/${ctx.directId}/messages/delete`, { method: 'POST', body: { messageIds: [foreign], scope: 'me' } });
  assert.equal(elsewhere.status, 404, 'ids from another chat are rejected');
});

test('search filters by type and inside one chat, only within your chats', async () => {
  await send(ana, ctx.groupId, { kind: 'text', body: 'Guide: https://example.com/guide' });
  const links = await ben.call('/api/search?type=links');
  assert.ok(links.data.messages.some(message => message.body.includes('example.com/guide')));
  const files = await ben.call('/api/search?type=files&q=report');
  assert.ok(files.data.messages.every(message => message.kind === 'file'));
  assert.ok(files.data.messages.length >= 1, 'files match by name');
  const inside = await ben.call(`/api/search?q=guide&conversationId=${ctx.groupId}`);
  assert.ok(inside.data.messages.length >= 1);
  assert.equal((await admin.call(`/api/search?q=guide&conversationId=${ctx.tripId}`)).status, 403, 'cannot search a chat you are not in');
  assert.equal((await ben.call('/api/search?type=bogus')).status, 400);
});

test('link previews refuse private and non-web addresses (SSRF protection)', async () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '192.168.0.10', '172.20.0.1', '169.254.169.254', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '0.0.0.0']) {
    assert.equal(isPrivateAddress(address), true, `${address} is private`);
  }
  assert.equal(isPrivateAddress('93.184.216.34'), false);
  for (const url of ['http://127.0.0.1/', 'http://localhost/', 'https://example.com:8443/', 'file:///etc/passwd', 'http://user:pw@example.com/', 'http://[::1]/', 'https://router.local/']) {
    assert.equal(validatePreviewUrl(url), null, `${url} is refused`);
  }
  assert.ok(validatePreviewUrl('https://example.com/page'));

  let hits = 0;
  const internal = http.createServer((req, res) => { hits += 1; res.writeHead(200, { 'content-type': 'text/html' }).end('<title>internal</title>'); });
  await new Promise(resolve => internal.listen(0, '127.0.0.1', resolve));
  const sent = await send(ana, ctx.groupId, { kind: 'text', body: `internal http://127.0.0.1:${internal.address().port}/admin` });
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(hits, 0, 'the server never requested the internal address');
  assert.equal(sent.data.message.linkPreview, null);
  internal.close();

  const parsed = parsePreview('<html><head><meta property="og:title" content="Tom &amp; Jerry"><meta name="description" content="A &quot;classic&quot;"><title>x</title></head></html>');
  assert.deepEqual(parsed, { title: 'Tom & Jerry', description: 'A "classic"', siteName: '' });
});

test('settings changes reach the member\'s other devices live', async () => {
  const controller = new AbortController();
  const stream = await ana.call('/api/events', { stream: true, signal: controller.signal });
  const reader = stream.response.body.getReader();
  await readEvent(reader, 'connected');
  await ana.call('/api/settings', { method: 'PATCH', body: { appearance: { theme: 'dark' } } });
  const event = await readEvent(reader, 'settings:updated');
  assert.equal(event.settings.appearance.theme, 'dark');
  controller.abort();
});
