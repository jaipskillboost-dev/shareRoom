// Applies the colour theme before the page paints, so there is no flash of the wrong one,
// and runs every theme button on the page. Loaded from <head>, without defer, on purpose.
(function () {
  'use strict';

  var KEY = 'roomshare-theme';
  // The page background in each theme, so the phone's browser bar matches it.
  var BAR_COLOR = { light: '#f4f6f8', dark: '#0d1013' };
  var root = document.documentElement;
  var query = window.matchMedia('(prefers-color-scheme: dark)');
  var chosen = null; // Kept in memory too, because storage can be blocked in private windows.

  function saved() {
    if (chosen) return chosen;
    try {
      var value = localStorage.getItem(KEY);
      return value === 'light' || value === 'dark' ? value : null;
    } catch (error) {
      return null;
    }
  }

  // Follows the device setting until the person picks a theme themselves.
  function current() {
    return saved() || (query.matches ? 'dark' : 'light');
  }

  function apply() {
    var theme = current();
    var next = theme === 'dark' ? 'light' : 'dark';
    root.dataset.theme = theme;

    var bar = document.querySelector('meta[name="theme-color"]');
    if (bar) bar.setAttribute('content', BAR_COLOR[theme]);

    var buttons = document.querySelectorAll('[data-theme-toggle]');
    for (var i = 0; i < buttons.length; i += 1) {
      buttons[i].setAttribute('aria-label', 'Switch to ' + next + ' theme');
      buttons[i].setAttribute('title', 'Switch to ' + next + ' theme');
    }
  }

  document.addEventListener('click', function (event) {
    if (!event.target.closest || !event.target.closest('[data-theme-toggle]')) return;
    chosen = current() === 'dark' ? 'light' : 'dark';
    try {
      localStorage.setItem(KEY, chosen);
    } catch (error) {}
    apply();
  });

  if (query.addEventListener) query.addEventListener('change', apply);
  else query.addListener(apply);
  document.addEventListener('DOMContentLoaded', apply);
  apply();
})();
