import { request } from './api.js';
import { toast } from './ui.js';
import { t } from './lib/i18n.js';

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(base64);
  return Uint8Array.from([...raw].map(char => char.charCodeAt(0)));
}

export async function enablePush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    toast(t('This browser does not support push notifications. In-app alerts still work.'), 'error');
    return false;
  }
  const config = await request('/api/push/config');
  if (!config.enabled) {
    toast(t('Push notifications are not set up on this server yet (the admin needs to add VAPID keys).'), 'error');
    return false;
  }
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    toast(t('Notification permission was not granted.'), 'error');
    return false;
  }
  const registration = await navigator.serviceWorker.ready;
  const existing = await registration.pushManager.getSubscription();
  const subscription = existing || await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(config.publicKey)
  });
  await request('/api/push/subscribe', { method: 'POST', body: subscription.toJSON() });
  toast(t('Push notifications enabled'));
  return true;
}

/** Stops push on this device only (other devices keep their own subscriptions). */
export async function disablePush() {
  if (!('serviceWorker' in navigator)) return false;
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager?.getSubscription();
  if (subscription) {
    await request('/api/push/subscribe', { method: 'DELETE', body: { endpoint: subscription.endpoint } }).catch(() => {});
    await subscription.unsubscribe().catch(() => {});
  }
  toast(t('Push notifications turned off on this device'));
  return true;
}
