// Runs before first paint (classic, blocking script) so the saved theme applies without a flash.
(function () {
  try {
    var stored = localStorage.getItem('circle-theme');
    var dark = stored ? stored === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  } catch { document.documentElement.dataset.theme = 'light'; }
})();
