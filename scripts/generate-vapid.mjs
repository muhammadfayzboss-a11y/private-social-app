// Prints a fresh VAPID key pair for push notifications. Run with: npm run vapid
import { generateVapidKeys } from '../src/webpush.js';

const { publicKey, privateKey } = generateVapidKeys();
console.log('Add these to your .env file:\n');
console.log(`VAPID_PUBLIC_KEY=${publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${privateKey}`);
console.log('VAPID_SUBJECT=mailto:you@example.com');
