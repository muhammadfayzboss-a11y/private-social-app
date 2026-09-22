import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'circle-config-'));

// Boots the server in a child process so configuration validation can be observed directly.
function boot(env) {
  return run(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/server.js'], {
    timeout: 8000,
    env: {
      PATH: process.env.PATH,
      NODE_OPTIONS: '',
      PORT: '0',
      DATABASE_PATH: path.join(workDir, `${Math.random().toString(36).slice(2)}.db`),
      UPLOAD_DIR: path.join(workDir, 'uploads'),
      STICKER_DIR: path.resolve('./stickers'),
      ...env
    }
  });
}

test('production refuses to start without an explicit APP_SECRET', async () => {
  await assert.rejects(
    boot({ NODE_ENV: 'production', SETUP_CODE: 'a-private-code' }),
    error => {
      assert.match(error.stderr, /Refusing to start in production/);
      assert.match(error.stderr, /APP_SECRET is required/);
      return true;
    }
  );
});

test('production refuses to start with a short APP_SECRET or missing SETUP_CODE', async () => {
  await assert.rejects(
    boot({ NODE_ENV: 'production', APP_SECRET: 'too-short', SETUP_CODE: 'a-private-code' }),
    error => {
      assert.match(error.stderr, /at least 32 characters/);
      return true;
    }
  );

  await assert.rejects(
    boot({ NODE_ENV: 'production', APP_SECRET: 'x'.repeat(40) }),
    error => {
      assert.match(error.stderr, /SETUP_CODE is required/);
      return true;
    }
  );
});

test('development starts with defaults so local setup needs no configuration', async () => {
  // The process stays running once healthy, so the timeout killing it is the success signal.
  await assert.rejects(
    boot({ NODE_ENV: 'development' }),
    error => {
      assert.equal(error.killed, true, `expected the server to keep running, got: ${error.stderr}`);
      assert.match(error.stdout, /Circle is ready/);
      return true;
    }
  );
});
