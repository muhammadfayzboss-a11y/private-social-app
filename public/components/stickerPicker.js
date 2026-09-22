import { request } from '../api.js';
import { icon } from '../icons.js';
import { loadStickers, state } from '../store.js';
import { escapeHtml, spinner, toast } from '../ui.js';

export function openStickerPicker(onSelect) {
  document.querySelector('.sticker-picker')?.remove();
  const picker = document.createElement('div');
  picker.className = 'sticker-picker';
  picker.innerHTML = spinner('Loading stickers');
  document.body.append(picker);

  const dismiss = event => {
    if (picker.contains(event.target) || event.target.closest('[data-action="stickers"]')) return;
    close();
  };
  const close = () => { picker.remove(); document.removeEventListener('pointerdown', dismiss); };
  setTimeout(() => document.addEventListener('pointerdown', dismiss), 0);

  loadStickers(true).then(({ packs, recent }) => {
    const favorites = packs.flatMap(pack => pack.stickers.filter(sticker => sticker.favorite));
    const tabs = [
      ...(recent.length ? [{ id: 'recent', name: 'Recent', stickers: recent }] : []),
      ...(favorites.length ? [{ id: 'favorites', name: 'Favorites', stickers: favorites }] : []),
      ...packs.map(pack => ({ id: pack.id, name: pack.name, stickers: pack.stickers }))
    ];

    if (!tabs.length) {
      picker.innerHTML = `<div class="empty-state">${icon('smile', 30)}<h3>No sticker packs yet</h3>
        <p>Add your artwork to <code>stickers/&lt;pack-name&gt;/</code> with a <code>pack.json</code> file, then reload packs from Profile → Settings.</p></div>`;
      return;
    }

    let active = tabs[0].id;
    const draw = () => {
      const current = tabs.find(tab => tab.id === active) || tabs[0];
      picker.innerHTML = `
        <div class="sticker-tabs">${tabs.map(tab => `<button class="sticker-tab${tab.id === active ? ' active' : ''}" data-tab="${escapeHtml(tab.id)}">${escapeHtml(tab.name)}</button>`).join('')}</div>
        <div class="sticker-grid">${current.stickers.map(sticker => `
          <button class="sticker-button" data-sticker="${escapeHtml(sticker.id)}" title="${escapeHtml(sticker.name)}">
            <img src="${escapeHtml(sticker.url)}" alt="${escapeHtml(sticker.name)}" loading="lazy">
          </button>`).join('')}</div>
        <p class="field-hint sticker-hint">Long-press a sticker to ${current.id === 'favorites' ? 'remove it from' : 'add it to'} favorites.</p>`;

      picker.querySelectorAll('[data-tab]').forEach(button => button.addEventListener('click', () => { active = button.dataset.tab; draw(); }));
      picker.querySelectorAll('[data-sticker]').forEach(button => {
        let timer = null;
        const favorite = async () => {
          clearTimeout(timer);
          const id = button.dataset.sticker;
          const isFavorite = favorites.some(sticker => sticker.id === id);
          try {
            await request(`/api/stickers/${encodeURIComponent(id)}/favorite`, { method: 'POST', body: { favorite: !isFavorite } });
            toast(isFavorite ? 'Removed from favorites' : 'Added to favorites');
            await loadStickers(true);
          } catch (error) { toast(error.message, 'error'); }
        };
        button.addEventListener('pointerdown', () => { timer = setTimeout(favorite, 500); });
        ['pointerup', 'pointerleave', 'pointercancel'].forEach(type => button.addEventListener(type, () => clearTimeout(timer)));
        button.addEventListener('contextmenu', event => { event.preventDefault(); favorite(); });
        button.addEventListener('click', () => { onSelect(button.dataset.sticker); close(); });
      });
    };
    draw();
  }).catch(error => { picker.innerHTML = `<p class="field-hint">${escapeHtml(error.message)}</p>`; });

  return picker;
}
