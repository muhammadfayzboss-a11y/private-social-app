import fs from 'node:fs';
import path from 'node:path';

function loadEnv(file = '.env') {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index < 1) continue;
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim().replace(/^['"]|['"]$/g, '');
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnv();

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 4173),
  origin: process.env.APP_ORIGIN || `http://localhost:${process.env.PORT || 4173}`,
  databasePath: path.resolve(process.env.DATABASE_PATH || './data/circle.db'),
  uploadDir: path.resolve(process.env.UPLOAD_DIR || './data/uploads'),
  stickerDir: path.resolve(process.env.STICKER_DIR || './stickers'),
  sessionDays: Number(process.env.SESSION_DAYS || 30),
  maxUploadBytes: Number(process.env.MAX_UPLOAD_MB || 25) * 1024 * 1024,
  secret: process.env.APP_SECRET || 'development-only-secret-change-before-deploying',
  setupCode: process.env.SETUP_CODE || 'circle-first-admin',
  secureCookies: (process.env.APP_ORIGIN || '').startsWith('https://'),
  // Enable only when a trusted reverse proxy (Fly, Render, Caddy, nginx) sets X-Forwarded-For.
  trustProxy: process.env.TRUST_PROXY === 'true',
  vapidPublicKey: process.env.VAPID_PUBLIC_KEY || '',
  vapidPrivateKey: process.env.VAPID_PRIVATE_KEY || '',
  vapidSubject: process.env.VAPID_SUBJECT || ''
};

// Production must never fall back to the built-in development defaults.
if (config.env === 'production') {
  const problems = [];
  if (!process.env.APP_SECRET?.trim()) problems.push('APP_SECRET is required');
  else if (process.env.APP_SECRET.trim().length < 32) problems.push('APP_SECRET must contain at least 32 characters');
  if (!process.env.SETUP_CODE?.trim()) problems.push('SETUP_CODE is required');
  if (problems.length) {
    throw new Error(`Refusing to start in production: ${problems.join('; ')}. Copy .env.example to .env and set real values.`);
  }
}
