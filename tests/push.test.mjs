import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
// Keys are generated inline so no application module (and therefore no database) loads
// before the test environment variables below are in place.
const vapid = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const publicJwk = vapid.publicKey.export({ format: 'jwk' });
const keys = {
  publicKey: Buffer.concat([
    Buffer.from([4]),
    Buffer.from(publicJwk.x, 'base64url'),
    Buffer.from(publicJwk.y, 'base64url')
  ]).toString('base64url'),
  privateKey: vapid.privateKey.export({ format: 'jwk' }).d
};
process.env.VAPID_PUBLIC_KEY = keys.publicKey;
process.env.VAPID_PRIVATE_KEY = keys.privateKey;
process.env.VAPID_SUBJECT = 'mailto:circle@example.com';

const { createClient, server, dbModule } = await import('./helpers.mjs');
const { encryptPushPayload, pushEnabled, sendPushToUser } = await import('../src/webpush.js');

// Stands in for a browser push service so delivery can be verified without external network access.
const received = [];
const pushService = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    received.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
    res.writeHead(201).end();
  });
});
await new Promise(resolve => pushService.listen(0, '127.0.0.1', resolve));
const pushEndpoint = `http://127.0.0.1:${pushService.address().port}/push/device-1`;

after(() => { server.close(); pushService.close(); });

// A subscriber keypair, exactly as a browser would create through the Push API.
const subscriber = crypto.createECDH('prime256v1');
const subscriberPublic = subscriber.generateKeys();
const authSecret = crypto.randomBytes(16);

function decryptPushBody(body) {
  const salt = body.subarray(0, 16);
  const keyLength = body[20];
  const serverPublic = body.subarray(21, 21 + keyLength);
  const ciphertext = body.subarray(21 + keyLength);
  const sharedSecret = subscriber.computeSecret(serverPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), subscriberPublic, serverPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', sharedSecret, authSecret, keyInfo, 32));
  const contentKey = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const decipher = crypto.createDecipheriv('aes-128-gcm', contentKey, nonce);
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  const plaintext = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()]);
  return JSON.parse(plaintext.subarray(0, plaintext.length - 1).toString('utf8'));
}

test('push encryption produces a payload the subscriber can decrypt', () => {
  assert.equal(pushEnabled(), true);
  const body = encryptPushPayload({ title: 'Circle', body: 'Hello' }, subscriberPublic.toString('base64url'), authSecret.toString('base64url'));
  assert.equal(body.readUInt32BE(16), 4096, 'record size header');
  assert.equal(body[20], 65, 'uncompressed server key length');
  assert.deepEqual(decryptPushBody(body), { title: 'Circle', body: 'Hello' });
});

test('an offline member receives an encrypted push notification for new activity', async () => {
  const admin = createClient();
  const ana = createClient();

  await admin.call('/api/auth/bootstrap', {
    method: 'POST', body: { setupCode: 'test-setup-code', username: 'mara', displayName: 'Mara Quinn', password: 'circle-admin-1' }
  });
  const invite = await admin.call('/api/invites', { method: 'POST', body: { label: 'Ana' } });
  await ana.call('/api/auth/register', {
    method: 'POST', body: { inviteCode: invite.data.code, username: 'ana', displayName: 'Ana Ruiz', password: 'password-long-1' }
  });

  const subscribed = await admin.call('/api/push/subscribe', {
    method: 'POST',
    body: { endpoint: pushEndpoint, keys: { p256dh: subscriberPublic.toString('base64url'), auth: authSecret.toString('base64url') } }
  });
  assert.equal(subscribed.status, 201);

  const config = await admin.call('/api/push/config');
  assert.equal(config.data.enabled, true);
  assert.equal(config.data.publicKey, keys.publicKey);

  // The admin has no open event stream, so a comment on their post must arrive as a push message.
  const post = await admin.call('/api/posts', { method: 'POST', body: { body: 'Ridge sunrise' } });
  received.length = 0;
  await ana.call(`/api/posts/${post.data.post.id}/comments`, { method: 'POST', body: { body: 'Stunning shot' } });

  const deadline = Date.now() + 5000;
  while (!received.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(received.length, 1, 'exactly one push message was delivered');

  const request = received[0];
  assert.equal(request.headers['content-encoding'], 'aes128gcm');
  assert.match(request.headers.authorization, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=/);
  const payload = decryptPushBody(request.body);
  assert.match(payload.body, /Ana Ruiz commented on your post: Stunning shot/);
  assert.match(payload.url, /^\/\?post=\d+$/);
});

test('expired push endpoints are removed after a 410 response', async () => {
  const goneService = http.createServer((req, res) => res.writeHead(410).end());
  await new Promise(resolve => goneService.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${goneService.address().port}/gone`;

  const member = dbModule.one('SELECT id FROM users WHERE username = ?', 'ana');
  dbModule.run('INSERT INTO push_subscriptions(user_id, endpoint, subscription_json) VALUES (?, ?, ?)', member.id, endpoint,
    JSON.stringify({ endpoint, keys: { p256dh: subscriberPublic.toString('base64url'), auth: authSecret.toString('base64url') } }));

  await sendPushToUser(member.id, { title: 'Circle', body: 'test' });
  assert.equal(dbModule.one('SELECT COUNT(*) count FROM push_subscriptions WHERE endpoint = ?', endpoint).count, 0);
  goneService.close();
});
