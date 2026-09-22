import { upload } from '../api.js';

export function pickFiles(accept = 'image/*', multiple = false) {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.style.display = 'none';
    document.body.append(input);
    input.addEventListener('change', () => {
      const files = [...(input.files || [])];
      input.remove();
      resolve(files);
    }, { once: true });
    input.click();
  });
}

export async function uploadFiles(files, purpose) {
  const uploaded = [];
  for (const file of files) {
    const { media } = await upload(file, purpose);
    uploaded.push(media);
  }
  return uploaded;
}
