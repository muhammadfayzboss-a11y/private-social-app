// Runs before first paint (classic, blocking script) so the saved theme and text size apply without a flash.
(function () {
  var root = document.documentElement;
  try {
    var saved = JSON.parse(localStorage.getItem('circle-settings') || '{}');
    var appearance = saved.appearance || {};
    var preference = appearance.theme || 'system';
    var theme = preference === 'system' ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : preference;
    if (['light', 'dark', 'amoled'].indexOf(theme) < 0) theme = 'light';
    root.dataset.theme = theme;
    root.dataset.scheme = theme === 'light' ? 'light' : 'dark';
    if (appearance.fontSize) root.style.setProperty('--message-font', appearance.fontSize + 'px');
    if (appearance.density) root.dataset.density = appearance.density;
    if (saved.language === 'uz') root.lang = 'uz-Latn';
    var colors = { light: '#ffffff', dark: '#17171f', amoled: '#000000' };
    var metas = document.querySelectorAll('meta[name="theme-color"]');
    for (var i = 0; i < metas.length; i += 1) metas[i].setAttribute('content', colors[theme]);
  } catch (error) {
    root.dataset.theme = 'light';
    root.dataset.scheme = 'light';
  }
  if (window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches) root.classList.add('standalone');
})();
