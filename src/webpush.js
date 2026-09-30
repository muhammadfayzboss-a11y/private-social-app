/**
 * Web Push delivery implemented with Node's built-in crypto only:
 * VAPID authentication (RFC 8292) and aes128gcm message encryption (RFC 8291).
 * This keeps the project dependency-free while still sending real, encrypted push messages.
 */
import crypto from 'node:crypto';
import { config } from './config.js';
import { all, run } from './db.js';

const toB64Url = buffer => Buffer.from(buffer).toString('base64url');
const fromB64Url = value => Buffer.from(String(value), 'base64url');

export function generateVapidKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicJwk = publicKey.export({ format: 'jwk' });
  const privateJwk = privateKey.export({ format: 'jwk' });
  return {
    publicKey: toB64Url(Buffer.concat([Buffer.from([4]), fromB64Url(publicJwk.x), fromB64Url(publicJwk.y)])),
    privateKey: privateJwk.d
  };
}

export function pushEnabled() {
  return Boolean(config.vapidPublicKey && config.vapidPrivateKey);
}

function vapidPrivateKeyObject() {
  const publicPoint = fromB64Url(config.vapidPublicKey);
  if (publicPoint.length !== 65 || publicPoint[0] !== 4) throw new Error('VAPID_PUBLIC_KEY must be a 65-byte uncompressed P-256 point.');
  return crypto.createPrivateKey({
    format: 'jwk',
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: toB64Url(publicPoint.subarray(1, 33)),
      y: toB64Url(publicPoint.subarray(33, 65)),
      d: config.vapidPrivateKey
    }
  });
}

function vapidAuthorization(endpoint) {
  const audience = new URL(endpoint).origin;
  const header = toB64Url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = toB64Url(JSON.stringify({
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: config.vapidSubject || 'mailto:admin@example.com'
  }));
  const signature = crypto.sign('sha256', Buffer.from(`${header}.${claims}`), { key: vapidPrivateKeyObject(), dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${claims}.${toB64Url(signature)}, k=${config.vapidPublicKey}`;
}

export function encryptPushPayload(payload, clientPublicKey, authSecret) {
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
  const userPublic = fromB64Url(clientPublicKey);
  const auth = fromB64Url(authSecret);

  const ecdh = crypto.createECDH('prime256v1');
  const serverPublic = ecdh.generateKeys();
  const sharedSecret = ecdh.computeSecret(userPublic);

  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'utf8'), userPublic, serverPublic]);
  const inputKeyingMaterial = Buffer.from(crypto.hkdfSync('sha256', sharedSecret, auth, keyInfo, 32));

  const salt = crypto.randomBytes(16);
  const contentKey = Buffer.from(crypto.hkdfSync('sha256', inputKeyingMaterial, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', inputKeyingMaterial, salt, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12));

  const cipher = crypto.createCipheriv('aes-128-gcm', contentKey, nonce);
  // 0x02 is the final-record delimiter defined by RFC 8188.
  const ciphertext = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);

  const recordSize = Buffer.alloc(4);
  recordSize.writeUInt32BE(4096);
  return Buffer.concat([salt, recordSize, Buffer.from([serverPublic.length]), serverPublic, ciphertext]);
}

export async function sendPushToUser(userId, payload) {
  if (!pushEnabled()) return { sent: 0, skipped: true };
  const subscriptions = all(`SELECT ps.* FROM push_subscriptions ps JOIN sessions s ON s.id = ps.session_id
    WHERE ps.user_id = ? AND s.expires_at > ?`, userId, new Date().toISOString());
  let sent = 0;
  await Promise.all(subscriptions.map(async row => {
    let subscription;
    try { subscription = JSON.parse(row.subscription_json); } catch { return; }
    const clientKey = subscription.keys?.p256dh;
    const authSecret = subscription.keys?.auth;
    if (!clientKey || !authSecret) return;
    try {
      const body = encryptPushPayload(payload, clientKey, authSecret);
      const response = await fetch(row.endpoint, {
        method: 'POST',
        headers: {
          TTL: '86400',
          'Content-Encoding': 'aes128gcm',
          'Content-Type': 'application/octet-stream',
          Authorization: vapidAuthorization(row.endpoint),
          'Content-Length': String(body.length)
        },
        body
      });
      // Push services report expired endpoints with 404/410; drop them so they are not retried forever.
      if (response.status === 404 || response.status === 410) run('DELETE FROM push_subscriptions WHERE id = ?', row.id);
      else if (response.ok) sent += 1;
    } catch (error) {
      console.error('Push delivery failed:', error.message);
    }
  }));
  return { sent, skipped: false };
}
