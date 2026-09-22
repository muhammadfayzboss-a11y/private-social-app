import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { db, run, transaction } from './db.js';

export const stickerRoot = config.stickerDir;
fs.mkdirSync(stickerRoot, { recursive: true });

export function syncStickerPacks() {
  const seen = [];
  for (const entry of fs.readdirSync(stickerRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const metadataFile = path.join(stickerRoot, entry.name, 'pack.json');
    if (!fs.existsSync(metadataFile)) continue;
    try {
      const pack = JSON.parse(fs.readFileSync(metadataFile, 'utf8'));
      const id = String(pack.id || entry.name).replace(/[^a-z0-9_-]/gi, '').slice(0, 50);
      if (!id || !Array.isArray(pack.stickers)) continue;
      transaction(() => {
        run(`INSERT INTO sticker_packs(id,name,description,cover_sticker_id,version,active,sort_order) VALUES (?,?,?,?,?,1,?)
          ON CONFLICT(id) DO UPDATE SET name=excluded.name,description=excluded.description,cover_sticker_id=excluded.cover_sticker_id,version=excluded.version,active=1,sort_order=excluded.sort_order`,
          id, String(pack.name || id).slice(0,80), String(pack.description || '').slice(0,200), pack.coverStickerId || null, Number(pack.version || 1), Number(pack.sortOrder || 0));
        run('DELETE FROM stickers WHERE pack_id=?', id);
        pack.stickers.forEach((sticker, index) => {
          const file = String(sticker.file || '');
          const absolute = path.resolve(stickerRoot, entry.name, file);
          if (!file || !absolute.startsWith(path.resolve(stickerRoot, entry.name) + path.sep) || !fs.existsSync(absolute)) return;
          const stickerId = String(sticker.id || `${id}-${index}`).replace(/[^a-z0-9_-]/gi, '').slice(0,80);
          const extension = path.extname(file).toLowerCase();
          const mime = extension === '.webp' ? 'image/webp' : extension === '.png' ? 'image/png' : extension === '.gif' ? 'image/gif' : extension === '.svg' ? 'image/svg+xml' : null;
          if (!mime) return;
          const relative = path.relative(stickerRoot, absolute).split(path.sep).join('/');
          run('INSERT INTO stickers(id,pack_id,name,file_path,mime_type,sort_order) VALUES (?,?,?,?,?,?)', stickerId,id,String(sticker.name||stickerId).slice(0,80),relative,mime,Number(sticker.sortOrder ?? index));
          seen.push(stickerId);
        });
      });
    } catch (error) { console.error(`Could not load sticker pack ${entry.name}:`, error.message); }
  }
  db.prepare('UPDATE sticker_packs SET active=0 WHERE id NOT IN (SELECT DISTINCT pack_id FROM stickers)').run();
  return seen.length;
}

export function stickerFile(sticker) {
  const file = path.resolve(stickerRoot, sticker.file_path);
  return file.startsWith(stickerRoot + path.sep) ? file : null;
}
