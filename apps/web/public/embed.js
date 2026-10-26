/*
 * Booking button for any website (like the Booksy widget, but ours).
 *
 *   <script src="https://<booking host>/embed.js" data-salon="<salon slug>" data-lang="pl" async></script>
 *
 * Adds a floating "Book a visit" button; a click opens the salon's booking page in a window
 * over the site. Any element on the page with the attribute data-bp-book opens it too
 * (then data-button="none" hides the floating button). Optional: data-label (button text),
 * data-color (button colour, #rgb or #rrggbb), data-position="left".
 * Plain script, no dependencies; nothing is stored in the visitor's browser.
 */
(function () {
  'use strict';
  var script = document.currentScript;
  if (!script || window.__bpEmbed) return;
  window.__bpEmbed = true;

  var slug = (script.getAttribute('data-salon') || '').trim().toLowerCase();
  if (!/^[a-z0-9-]{1,80}$/.test(slug)) return;
  var LANGS = ['pl', 'uk', 'ru', 'en'];
  var lang = (script.getAttribute('data-lang') || '').toLowerCase();
  if (LANGS.indexOf(lang) < 0) {
    var page = (document.documentElement.lang || navigator.language || 'pl').slice(0, 2);
    lang = LANGS.indexOf(page) >= 0 ? page : 'pl';
  }
  var TEXT = {
    pl: { book: 'Umów wizytę', close: 'Zamknij' },
    uk: { book: 'Записатися', close: 'Закрити' },
    ru: { book: 'Записаться', close: 'Закрыть' },
    en: { book: 'Book a visit', close: 'Close' },
  }[lang];
  var origin = new URL(script.src, window.location.href).origin;
  var url = origin + '/' + lang + '/b/' + slug + '?embed=1';
  var color = script.getAttribute('data-color') || '';
  if (!/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(color)) color = '#111111';
  var left = script.getAttribute('data-position') === 'left';

  var css =
    '.bp-btn{position:fixed;bottom:20px;z-index:2147483000;padding:14px 22px;border:0;border-radius:999px;' +
    'font:600 16px/1 system-ui,-apple-system,"Segoe UI",sans-serif;color:#fff;cursor:pointer;' +
    'box-shadow:0 6px 20px rgba(0,0,0,.25)}' +
    '.bp-overlay{position:fixed;inset:0;z-index:2147483001;display:flex;align-items:center;' +
    'justify-content:center;background:rgba(0,0,0,.55)}' +
    '.bp-overlay[hidden]{display:none}' +
    '.bp-frame{position:relative;width:min(480px,100%);height:min(820px,100%);background:#fff;' +
    'border-radius:16px;overflow:hidden;box-shadow:0 10px 40px rgba(0,0,0,.35)}' +
    '.bp-frame iframe{width:100%;height:100%;border:0;display:block}' +
    '.bp-close{position:absolute;top:8px;right:8px;z-index:1;width:36px;height:36px;border:0;' +
    'border-radius:50%;background:rgba(0,0,0,.65);color:#fff;font:22px/36px system-ui,sans-serif;' +
    'cursor:pointer}' +
    '@media (max-width:520px){.bp-frame{width:100%;height:100%;border-radius:0}}';
  var style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  var overlay = document.createElement('div');
  overlay.className = 'bp-overlay';
  overlay.hidden = true;
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', TEXT.book);
  var frame = document.createElement('div');
  frame.className = 'bp-frame';
  var close = document.createElement('button');
  close.type = 'button';
  close.className = 'bp-close';
  close.setAttribute('aria-label', TEXT.close);
  close.textContent = '×';
  frame.appendChild(close);
  overlay.appendChild(frame);

  var iframe = null;
  var opener = null;

  function open(e) {
    if (e) e.preventDefault();
    opener = document.activeElement;
    if (!iframe) {
      // Loaded on the first click only: the salon's page costs nothing until it is needed.
      iframe = document.createElement('iframe');
      iframe.src = url;
      iframe.title = TEXT.book;
      iframe.allow = 'clipboard-write';
      frame.appendChild(iframe);
    }
    overlay.hidden = false;
    close.focus();
  }

  function hide() {
    overlay.hidden = true;
    if (opener && opener.focus) opener.focus();
  }

  close.addEventListener('click', hide);
  overlay.addEventListener('click', function (e) {
    if (e.target === overlay) hide();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !overlay.hidden) hide();
  });
  document.addEventListener('click', function (e) {
    var target = e.target && e.target.closest ? e.target.closest('[data-bp-book]') : null;
    if (target) open(e);
  });

  function mount() {
    document.body.appendChild(overlay);
    if (script.getAttribute('data-button') === 'none') return;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'bp-btn';
    btn.style.background = color;
    btn.style[left ? 'left' : 'right'] = '20px';
    btn.textContent = script.getAttribute('data-label') || TEXT.book;
    btn.addEventListener('click', open);
    document.body.appendChild(btn);
  }

  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount);
})();
