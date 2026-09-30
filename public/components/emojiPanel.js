/**
 * Emoji & sticker panel that takes the keyboard's place under the composer. Emoji are plain Unicode
 * characters drawn by the device's own emoji font; recently used ones float to the top.
 */
import { icon } from '../icons.js';
import { loadStickers } from '../store.js';
import { escapeHtml } from '../ui.js';
import { t } from '../lib/i18n.js';

const CATEGORIES = [
  { id: 'smileys', label: 'Smileys', icon: 'smile', emoji: '😀 😃 😄 😁 😆 😅 🤣 😂 🙂 🙃 😉 😊 😇 🥰 😍 🤩 😘 😗 😚 😙 😋 😛 😜 🤪 😝 🤑 🤗 🤭 🤫 🤔 🤐 🤨 😐 😑 😶 😏 😒 🙄 😬 😮‍💨 🤥 😌 😔 😪 🤤 😴 😷 🤒 🤕 🤢 🤮 🥵 🥶 🥴 😵 🤯 🤠 🥳 😎 🤓 🧐 😕 😟 🙁 😮 😯 😲 😳 🥺 😦 😧 😨 😰 😥 😢 😭 😱 😖 😣 😞 😓 😩 😫 🥱 😤 😡 😠 🤬 😈 👿 💀 💩 🤡 👻 👽 🤖 😺 😸 😹 😻 😼 😽 🙀 😿 😾' },
  { id: 'people', label: 'People', icon: 'user', emoji: '👋 🤚 🖐 ✋ 🖖 👌 🤌 🤏 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 👇 ☝️ 👍 👎 ✊ 👊 🤛 🤜 👏 🙌 👐 🤲 🤝 🙏 ✍️ 💅 🤳 💪 🦾 🦵 🦶 👂 👃 🧠 👀 👁 👅 👄 💋 👶 🧒 👦 👧 🧑 👱 👨 🧔 👩 🧓 👴 👵 🙍 🙎 🙅 🙆 💁 🙋 🧏 🙇 🤦 🤷 👮 🕵️ 💂 👷 🤴 👸 👳 🤵 👰 🤰 🤱 👼 🎅 🦸 🦹 🧙 🧚 🧛 🧜 🧝 🧞 💆 💇 🚶 🧍 🧎 🏃 💃 🕺 👯 🧖 🧘 👭 👫 👬 💏 💑 👪' },
  { id: 'hearts', label: 'Symbols', icon: 'heart', emoji: '❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 💟 ☮️ ✝️ ☪️ 🕉 ☯️ ✡️ 🔯 ♈ ♉ ♊ ♋ ♌ ♍ ♎ ♏ ♐ ♑ ♒ ♓ ⛎ 🆔 ⚛️ ✅ ☑️ ✔️ ❌ ❎ ➕ ➖ ➗ ✖️ ♾ ‼️ ⁉️ ❓ ❔ ❕ ❗ 〰️ 💯 🔥 ✨ ⭐ 🌟 💫 ⚡ 💥 💢 💦 💨 🕳 💬 👁‍🗨 🗨 🗯 💭 💤 🔔 🔕 🎵 🎶 ⚠️ 🚸 ⛔ 🚫 🔞 ♻️ 🔰 ⭕ 🔴 🟠 🟡 🟢 🔵 🟣 ⚫ ⚪ 🟤' },
  { id: 'animals', label: 'Nature', icon: 'sparkle', emoji: '🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🙈 🙉 🙊 🐔 🐧 🐦 🐤 🦆 🦅 🦉 🦇 🐺 🐗 🐴 🦄 🐝 🐛 🦋 🐌 🐞 🐜 🦗 🕷 🦂 🐢 🐍 🦎 🐙 🦑 🦐 🦀 🐡 🐠 🐟 🐬 🐳 🐋 🦈 🐊 🐅 🐆 🦓 🦍 🐘 🦛 🦏 🐪 🐫 🦒 🦘 🐃 🐂 🐄 🐎 🐖 🐏 🐑 🐐 🦌 🐕 🐩 🐈 🐓 🦃 🦚 🦜 🦢 🕊 🐇 🦝 🦨 🦡 🦦 🦥 🐁 🐀 🐿 🦔 🌵 🎄 🌲 🌳 🌴 🌱 🌿 ☘️ 🍀 🍁 🍂 🍃 🌺 🌻 🌹 🥀 🌷 🌼 🌸 💐 🍄 🌰 🌙 🌎 ☀️ 🌤 ⛅ 🌧 ⛈ 🌩 ❄️ ☃️ 🌈 🌊' },
  { id: 'food', label: 'Food', icon: 'bubble', emoji: '🍏 🍎 🍐 🍊 🍋 🍌 🍉 🍇 🍓 🫐 🍈 🍒 🍑 🥭 🍍 🥥 🥝 🍅 🍆 🥑 🥦 🥬 🥒 🌶 🌽 🥕 🧄 🧅 🥔 🍠 🥐 🥯 🍞 🥖 🥨 🧀 🥚 🍳 🧈 🥞 🧇 🥓 🥩 🍗 🍖 🌭 🍔 🍟 🍕 🥪 🥙 🧆 🌮 🌯 🥗 🥘 🥫 🍝 🍜 🍲 🍛 🍣 🍱 🥟 🍤 🍙 🍚 🍘 🍥 🥠 🍢 🍡 🍧 🍨 🍦 🥧 🧁 🍰 🎂 🍮 🍭 🍬 🍫 🍿 🍩 🍪 🥜 🍯 🥛 ☕ 🍵 🧃 🥤 🍶 🍺 🍻 🥂 🍷 🥃 🍸 🍹 🧉 🧊' },
  { id: 'activity', label: 'Activity', icon: 'celebrate', emoji: '⚽ 🏀 🏈 ⚾ 🥎 🎾 🏐 🏉 🥏 🎱 🏓 🏸 🏒 🏑 🥍 🏏 ⛳ 🏹 🎣 🥊 🥋 🎽 🛹 ⛸ 🥌 🎿 ⛷ 🏂 🏋️ 🤸 🤺 ⛹️ 🤾 🏌️ 🏇 🧗 🚴 🏆 🥇 🥈 🥉 🏅 🎖 🎗 🎫 🎟 🎪 🎭 🎨 🎬 🎤 🎧 🎼 🎹 🥁 🎷 🎺 🎸 🪕 🎻 🎲 ♟ 🎯 🎳 🎮 🎰 🧩 🎉 🎊 🎈 🎁 🎀' },
  { id: 'travel', label: 'Travel', icon: 'globe', emoji: '🚗 🚕 🚙 🚌 🚎 🏎 🚓 🚑 🚒 🚐 🚚 🚛 🚜 🛴 🚲 🛵 🏍 🚨 🚔 🚍 🚘 🚖 🚡 🚠 🚟 🚃 🚋 🚞 🚝 🚄 🚅 🚈 🚂 🚆 🚇 🚊 🚉 ✈️ 🛫 🛬 🛩 💺 🛰 🚀 🛸 🚁 🛶 ⛵ 🚤 🛥 🛳 ⛴ 🚢 ⚓ ⛽ 🚧 🚦 🗺 🗿 🗽 🗼 🏰 🏯 🏟 🎡 🎢 🎠 ⛲ ⛱ 🏖 🏝 🏜 🌋 ⛰ 🏔 🗻 🏕 ⛺ 🏠 🏡 🏘 🏗 🏭 🏢 🏬 🏣 🏤 🏥 🏦 🏨 🏪 🏫 🏩 💒 🏛 ⛪ 🕌 🕍 🕋 ⛩ 🌅 🌄 🌠 🎇 🎆 🌇 🌆 🏙 🌃 🌌 🌉 🌁' },
  { id: 'objects', label: 'Objects', icon: 'image', emoji: '⌚ 📱 💻 ⌨️ 🖥 🖨 🖱 💽 💾 💿 📀 📷 📸 📹 🎥 📞 ☎️ 📺 📻 🎙 ⏰ ⌛ ⏳ 📡 🔋 🔌 💡 🔦 🕯 🧯 💸 💵 💴 💶 💷 💰 💳 💎 ⚖️ 🧰 🔧 🔨 ⚒ 🛠 ⛏ 🔩 ⚙️ 🧱 ⛓ 🧲 🔫 💣 🧨 🪓 🔪 🗡 ⚔️ 🛡 🚬 ⚰️ ⚱️ 🏺 🔮 📿 🧿 💈 ⚗️ 🔭 🔬 🕳 💊 💉 🩸 🧬 🦠 🧫 🧪 🌡 🧹 🧺 🧻 🚽 🚰 🚿 🛁 🧼 🧽 🧴 🛎 🔑 🗝 🚪 🪑 🛋 🛏 🧸 🖼 🛍 🛒 🎁 🎈 🧧 ✉️ 📩 📨 📧 💌 📥 📤 📦 🏷 📪 📬 📭 📮 📯 📜 📃 📄 📑 🧾 📊 📈 📉 🗒 🗓 📆 📅 🗑 📇 🗃 🗳 🗄 📋 📁 📂 🗂 🗞 📰 📓 📔 📒 📕 📗 📘 📙 📚 📖 🔖 🧷 🔗 📎 🖇 📐 📏 🧮 📌 📍 ✂️ 🖊 🖋 ✒️ 🖌 🖍 📝 ✏️ 🔍 🔎 🔏 🔐 🔒 🔓' }
];
const RECENT_KEY = 'circle-recent-emoji';
const DEFAULT_RECENT = ['😂', '❤️', '👍', '🔥', '😍', '🙏', '😭', '🥰', '😊', '🎉', '👏', '😮'];

export function recentEmoji() {
  try { const saved = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); return saved.length ? saved : DEFAULT_RECENT; } catch { return DEFAULT_RECENT; }
}

export function rememberEmoji(emoji) {
  const next = [emoji, ...recentEmoji().filter(item => item !== emoji)].slice(0, 24);
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(next)); } catch { /* storage full */ }
}

function emojiGrid(list) {
  return list.map(emoji => `<button type="button" class="emoji-key" data-emoji="${escapeHtml(emoji)}">${escapeHtml(emoji)}</button>`).join('');
}

/**
 * Mounts the panel into `host`. `onEmoji(text)` inserts an emoji; `onSticker(sticker)` sends one.
 * Returns { element, setTab, destroy }.
 */
export function createEmojiPanel({ onEmoji, onSticker, tab = 'emoji' }) {
  const element = document.createElement('div');
  element.className = 'emoji-panel';
  let active = tab;
  const drawEmoji = () => `
    <div class="emoji-scroll" data-no-drag>
      <h4>${t('Recently used')}</h4><div class="emoji-grid">${emojiGrid(recentEmoji())}</div>
      ${CATEGORIES.map(category => `<h4 id="emoji-${category.id}">${t(category.label)}</h4><div class="emoji-grid">${emojiGrid(category.emoji.split(' '))}</div>`).join('')}
    </div>
    <div class="emoji-categories">${CATEGORIES.map(category => `<button type="button" data-category="${category.id}" aria-label="${t(category.label)}">${icon(category.icon, 20)}</button>`).join('')}</div>`;
  const drawStickers = async () => {
    const body = element.querySelector('[data-body]');
    body.innerHTML = `<div class="emoji-scroll"><div class="loading"><span class="spinner"></span></div></div>`;
    try {
      const { packs, recent } = await loadStickers();
      const sections = [...(recent.length ? [{ name: t('Recently used'), stickers: recent }] : []), ...packs.map(pack => ({ name: pack.name, stickers: pack.stickers }))];
      body.innerHTML = sections.length
        ? `<div class="emoji-scroll">${sections.map(section => `<h4>${escapeHtml(section.name)}</h4><div class="sticker-grid">${section.stickers.map(sticker => `
            <button type="button" class="sticker-button" data-sticker="${escapeHtml(sticker.id)}" data-sticker-url="${escapeHtml(sticker.url)}" data-sticker-name="${escapeHtml(sticker.name)}"><img src="${escapeHtml(sticker.url)}" alt="${escapeHtml(sticker.name)}" loading="lazy"></button>`).join('')}</div>`).join('')}</div>`
        : `<div class="emoji-scroll"><p class="field-hint">${t('No sticker packs yet. The group admin can add them on the server.')}</p></div>`;
    } catch (error) { body.innerHTML = `<div class="emoji-scroll"><p class="field-hint">${escapeHtml(error.message)}</p></div>`; }
  };
  const draw = () => {
    element.innerHTML = `
      <div class="emoji-tabs" role="tablist">
        <button type="button" role="tab" class="${active === 'emoji' ? 'active' : ''}" data-panel-tab="emoji">${t('Emoji')}</button>
        <button type="button" role="tab" class="${active === 'stickers' ? 'active' : ''}" data-panel-tab="stickers">${t('Stickers')}</button>
      </div>
      <div class="emoji-body" data-body>${active === 'emoji' ? drawEmoji() : ''}</div>`;
    if (active === 'stickers') drawStickers();
  };
  element.addEventListener('pointerdown', event => { if (event.target.closest('button')) event.preventDefault(); }); // keep the text field's caret
  element.addEventListener('click', event => {
    const tabButton = event.target.closest('[data-panel-tab]');
    if (tabButton) { active = tabButton.dataset.panelTab; draw(); return; }
    const category = event.target.closest('[data-category]');
    if (category) { element.querySelector(`#emoji-${category.dataset.category}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }); return; }
    const key = event.target.closest('[data-emoji]');
    if (key) { rememberEmoji(key.dataset.emoji); onEmoji(key.dataset.emoji); return; }
    const sticker = event.target.closest('[data-sticker]');
    if (sticker) onSticker({ id: sticker.dataset.sticker, url: sticker.dataset.stickerUrl, name: sticker.dataset.stickerName });
  });
  draw();
  return { element, setTab: next => { active = next; draw(); }, destroy: () => element.remove() };
}

/** Quick reactions shown above a long-pressed message; the last button opens the full emoji set. */
export const QUICK_REACTIONS = ['❤️', '👍', '😂', '😮', '😢', '🙏', '🔥'];
