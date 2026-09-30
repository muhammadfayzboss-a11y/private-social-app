import { upload } from '../api.js';

export function pickFiles(accept = 'image/*', multiple = false) {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.style.display = 'none';
    document.body.append(input);
    let settled = false;
    const finish = files => { if (settled) return; settled = true; input.remove(); resolve(files); };
    input.addEventListener('change', () => finish([...(input.files || [])]), { once: true });
    input.addEventListener('cancel', () => finish([]), { once: true });
    input.click();
  });
}

/** Reads a picked file's pixel size (and a video's duration) without uploading anything. */
export function measureMedia(file) {
  const url = URL.createObjectURL(file);
  const done = value => { URL.revokeObjectURL(url); return value; };
  return new Promise(resolve => {
    const timeout = setTimeout(() => resolve(done({})), 4000);
    if (file.type.startsWith('image/')) {
      const image = new Image();
      image.onload = () => { clearTimeout(timeout); resolve(done({ width: image.naturalWidth, height: image.naturalHeight })); };
      image.onerror = () => { clearTimeout(timeout); resolve(done({})); };
      image.src = url;
    } else if (file.type.startsWith('video/')) {
      const video = document.createElement('video');
      video.preload = 'metadata';
      video.muted = true;
      video.onloadedmetadata = () => { clearTimeout(timeout); resolve(done({ width: video.videoWidth, height: video.videoHeight, durationMs: Number.isFinite(video.duration) ? video.duration * 1000 : 0 })); };
      video.onerror = () => { clearTimeout(timeout); resolve(done({})); };
      video.src = url;
    } else { clearTimeout(timeout); resolve(done({})); }
  });
}

export async function uploadFiles(files, purpose, meta = null) {
  const uploaded = [];
  for (const file of files) {
    const details = meta || await measureMedia(file);
    const { media } = await upload(file, purpose, details);
    uploaded.push({ ...media, width: details.width || null, height: details.height || null });
  }
  return uploaded;
}
