/*
 * PageGloss - hover annotation card (Shadow DOM isolated).
 * Shows the LLM explanation of the marked term and lets the user keep asking
 * follow-up questions, either inline (hover) or pinned as a floating window.
 *
 * Layout: the main card plus a note pane on the right, inside one flex shell
 * (stacked vertically on narrow viewports). The note pane starts hidden and is
 * revealed after the pointer rests on the card, while the card is pinned, or
 * while the note textarea is focused / not empty.
 */
(function () {
  'use strict';

  var HOST_ID = 'pagegloss-card-host';

  var CSS = [
    ':host {',
    '  all: initial; display: block;',
    '  width: min(392px, calc(100% - 16px));',
    '  --pg-bg: #ffffff; --pg-head: #f4f6fb; --pg-fg: #1b2433; --pg-fg-dim: #5c6779;',
    '  --pg-border: #d9e0ec; --pg-hover: #eef2f9; --pg-user: #f5f7fb; --pg-code: #f1f4fa;',
    '  --pg-accent: #2f6fed; --pg-accent-soft: rgba(47,111,237,.12); --pg-accent-border: #a9c2fb;',
    '  --pg-danger: #b42318; --pg-danger-soft: rgba(180,35,24,.1); --pg-danger-border: #f3b3ad;',
    '}',
    ':host(.note-open) { width: min(660px, calc(100% - 16px)); }',
    '@media (max-width: 899px) {',
    '  :host(.note-open) { width: min(392px, calc(100% - 16px)); }',
    '}',
    '* { box-sizing: border-box; }',
    '.shell {',
    '  display: flex; flex-direction: row; align-items: stretch; gap: 8px;',
    '  width: 100%; min-width: 0; max-height: calc(100vh - 16px);',
    '  opacity: 1; transform: none; transition: opacity .15s ease, transform .15s ease;',
    '}',
    '.shell.leaving { opacity: 0; transform: translateY(6px); }',
    '@media (max-width: 899px) { .shell { flex-direction: column; } }',
    '.card {',
    '  width: min(392px, calc(100% - 16px)); flex: 0 1 auto;',
    '  max-height: min(70vh, 560px);',
    '  display: flex; flex-direction: column; min-width: 0; min-height: 0;',
    '  font: 13px/1.62 system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;',
    '  color: var(--pg-fg); background: var(--pg-bg);',
    '  border: 1px solid var(--pg-border); border-radius: 14px;',
    '  box-shadow: 0 18px 48px rgba(15, 23, 42, .22), 0 2px 8px rgba(15, 23, 42, .12);',
    '  overflow: hidden;',
    '  transition: opacity .15s ease, transform .15s ease;',
    '}',
    '.card:not(.pinned) { animation: pg-in .14s ease-out; }',
    '.card.leaving { opacity: 0; transform: translateY(6px); }',
    '@keyframes pg-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }',
    '.note {',
    '  flex: 0 0 260px; width: 260px; max-width: 100%;',
    '  display: flex; flex-direction: column; gap: 6px;',
    '  min-width: 0; min-height: 0; max-height: min(70vh, 560px);',
    '  padding: 10px 12px;',
    '  font: 13px/1.62 system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;',
    '  color: var(--pg-fg); background: var(--pg-bg);',
    '  border: 1px solid var(--pg-border); border-radius: 14px;',
    '  box-shadow: 0 18px 48px rgba(15, 23, 42, .2), 0 2px 8px rgba(15, 23, 42, .1);',
    '  overflow: hidden;',
    '  transition: opacity .15s ease, transform .15s ease;',
    '}',
    '.note[hidden] { display: none; }',
    '.note.leaving { opacity: 0; transform: translateY(6px); }',
    '@media (max-width: 899px) { .note { flex: 0 0 auto; width: 100%; max-height: min(50vh, 320px); } }',
    '.note-title {',
    '  flex-shrink: 0; font-size: 10.5px; font-weight: 680; letter-spacing: .05em;',
    '  text-transform: uppercase; color: var(--pg-fg-dim); white-space: nowrap;',
    '  overflow: hidden; text-overflow: ellipsis;',
    '}',
    'textarea.note-text {',
    '  flex: 1 1 auto; min-width: 0; min-height: 104px; resize: none; overflow-y: auto;',
    '  font: inherit; color: var(--pg-fg); background: var(--pg-bg);',
    '  border: 1px solid var(--pg-border); border-radius: 9px; padding: 7px 9px;',
    '  line-height: 1.5; overflow-wrap: anywhere;',
    '}',
    'textarea.note-text:focus { outline: none; border-color: var(--pg-accent-border); box-shadow: 0 0 0 2px var(--pg-accent-soft); }',
    '.note-saved {',
    '  flex-shrink: 0; min-height: 14px; font-size: 11px; color: var(--pg-accent);',
    '  opacity: 0; transition: opacity .2s ease; white-space: nowrap;',
    '}',
    '.note-saved.show { opacity: 1; }',
    '.note-saved.leaving { opacity: 0; }',
    '@media (prefers-reduced-motion: reduce) {',
    '  .shell, .card, .note { transition: none !important; }',
    '  .shell.leaving, .card.leaving, .note.leaving { transform: none; }',
    '}',
    '.head {',
    '  display: flex; align-items: center; gap: 8px; flex-shrink: 0;',
    '  padding: 10px 10px 10px 12px; border-bottom: 1px solid var(--pg-border);',
    '  background: var(--pg-head);',
    '}',    '.dot { width: 10px; height: 10px; border-radius: 3px; flex-shrink: 0; box-shadow: inset 0 0 0 1px rgba(15,23,42,.12); }',
    '.term {',
    '  flex: 1 1 auto; min-width: 0; font-weight: 650; font-size: 13.5px;',
    '  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;',
    '}',
    '.tools { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }',
    'button.tool {',
    '  display: inline-flex; align-items: center; justify-content: center; gap: 4px;',
    '  height: 26px; padding: 0 8px; flex-shrink: 0;',
    '  font: inherit; font-size: 12px; white-space: nowrap;',
    '  color: var(--pg-fg-dim); background: transparent;',
    '  border: 1px solid transparent; border-radius: 7px; cursor: pointer;',
    '}',
    'button.tool:hover { color: var(--pg-fg); background: var(--pg-hover); border-color: var(--pg-border); }',
    'button.tool[aria-pressed="true"] { color: var(--pg-accent); background: var(--pg-accent-soft); border-color: var(--pg-accent-border); }',
    'button.tool svg { width: 1em; height: 1em; flex-shrink: 0; }',
    '.menu {',
    '  display: flex; flex-direction: column; gap: 2px; flex-shrink: 0;',
    '  padding: 6px; border-bottom: 1px solid var(--pg-border); background: var(--pg-head);',
    '}',
    '.menu[hidden] { display: none; }',
    '.menu-item {',
    '  display: block; width: 100%; min-width: 0; text-align: left;',
    '  padding: 7px 9px; flex-shrink: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;',
    '  font: inherit; font-size: 12.5px; color: var(--pg-fg); background: transparent;',
    '  border: 1px solid transparent; border-radius: 7px; cursor: pointer;',
    '}',
    '.menu-item:hover { background: var(--pg-hover); border-color: var(--pg-border); }',
    '.menu-item[data-action="all"] { color: var(--pg-danger); }',
    '.body { padding: 11px 12px 4px; overflow-y: auto; overflow-x: hidden; min-height: 0; flex: 1 1 auto; }',
    '.msg { margin: 0 0 10px; overflow-wrap: anywhere; }',
    '.msg.user {',
    '  background: var(--pg-user); border: 1px solid var(--pg-border);',
    '  border-radius: 9px; padding: 7px 9px; color: var(--pg-fg-dim);',
    '}',
    '.msg.assistant .who {',
    '  display: block; font-size: 11px; font-weight: 650; letter-spacing: .04em;',
    '  text-transform: uppercase; color: var(--pg-fg-dim); margin-bottom: 3px;',
    '}',
    '.md p { margin: 0 0 7px; }',
    '.md p:last-child { margin-bottom: 0; }',
    '.md ul, .md ol { margin: 0 0 7px; padding-left: 20px; }',
    '.md li { margin: 2px 0; }',
    '.md code { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12px;',
    '  background: var(--pg-code); padding: 1px 4px; border-radius: 4px; overflow-wrap: anywhere; }',
    '.md pre { margin: 0 0 7px; padding: 8px 10px; background: var(--pg-code); border-radius: 8px; overflow-x: auto; }',
    '.md pre code { background: none; padding: 0; }',
    '.md strong { font-weight: 680; }',
    '.md a { color: var(--pg-accent); }',
    '.state { display: flex; align-items: center; gap: 8px; color: var(--pg-fg-dim); margin: 0 0 10px; }',
    '.state .spin { width: 12px; height: 12px; flex-shrink: 0; border-radius: 50%;',
    '  border: 2px solid var(--pg-border); border-top-color: var(--pg-accent); animation: pg-spin .8s linear infinite; }',
    '@keyframes pg-spin { to { transform: rotate(360deg); } }',
    '.error { color: var(--pg-danger); background: var(--pg-danger-soft); border: 1px solid var(--pg-danger-border);',
    '  border-radius: 9px; padding: 8px 10px; margin: 0 0 10px; overflow-wrap: anywhere; }',
    '.error-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 7px; }',
    '.reasoning { margin: 0 0 10px; padding: 7px 9px; border: 1px dashed var(--pg-border);',
    '  border-radius: 8px; color: var(--pg-fg-dim); font-size: 12px; max-height: 160px; overflow-y: auto;',
    '  overflow-wrap: anywhere; }',
    '.reasoning .who { display: block; font-size: 10.5px; font-weight: 650; letter-spacing: .04em;',
    '  text-transform: uppercase; margin-bottom: 3px; }',
    '.error-actions button { flex-shrink: 0; white-space: nowrap; }',
    '.foot { flex-shrink: 0; border-top: 1px solid var(--pg-border); padding: 8px; background: var(--pg-head); }',
    '.row { display: flex; align-items: flex-end; gap: 6px; min-width: 0; }',
    'textarea.ask {',
    '  flex: 1 1 auto; min-width: 0; resize: none; overflow-y: auto;',
    '  font: inherit; color: var(--pg-fg); background: var(--pg-bg);',
    '  border: 1px solid var(--pg-border); border-radius: 9px; padding: 7px 9px;',
    '  max-height: 88px; min-height: 34px; line-height: 1.5;',
    '}',
    'textarea.ask:focus { outline: none; border-color: var(--pg-accent-border); box-shadow: 0 0 0 2px var(--pg-accent-soft); }',
    'button.send {',
    '  flex-shrink: 0; height: 34px; padding: 0 13px; white-space: nowrap;',
    '  font: inherit; font-weight: 620; color: #fff; background: var(--pg-accent);',
    '  border: 1px solid transparent; border-radius: 9px; cursor: pointer;',
    '}',
    'button.send:hover { filter: brightness(1.06); }',
    'button.send:disabled { opacity: .5; cursor: default; filter: none; }',
    'button.ghost {',
    '  flex-shrink: 0; height: 34px; padding: 0 10px; white-space: nowrap; font: inherit; font-size: 12px;',
    '  color: var(--pg-fg-dim); background: transparent; border: 1px solid var(--pg-border);',
    '  border-radius: 9px; cursor: pointer;',
    '}',
    'button.ghost:hover { color: var(--pg-fg); background: var(--pg-hover); }',
    '.hint { margin: 6px 2px 0; font-size: 11px; color: var(--pg-fg-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }',
    '.confirm-overlay {',
    '  position: fixed; inset: 0; display: flex; align-items: center; justify-content: center;',
    '  padding: 16px; background: rgba(15, 23, 42, .44);',
    '}',
    '.confirm {',
    '  width: min(360px, 100%); max-height: calc(100vh - 32px); overflow-y: auto; min-width: 0;',
    '  display: flex; flex-direction: column; gap: 10px;',
    '  padding: 14px 16px 12px;',
    '  font: 13px/1.62 system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;',
    '  color: var(--pg-fg); background: var(--pg-bg);',
    '  border: 1px solid var(--pg-border); border-radius: 14px;',
    '  box-shadow: 0 18px 48px rgba(15, 23, 42, .28), 0 2px 8px rgba(15, 23, 42, .14);',
    '}',
    '.confirm-title { margin: 0; font-size: 14px; font-weight: 680; overflow-wrap: anywhere; }',
    '.confirm-body { margin: 0; color: var(--pg-fg-dim); overflow-wrap: anywhere; }',
    '.confirm-actions { display: flex; justify-content: flex-end; gap: 8px; flex-wrap: nowrap; }',
    '.confirm-actions button {',
    '  flex-shrink: 0; white-space: nowrap; height: 30px; padding: 0 12px;',
    '  font: inherit; font-size: 12.5px; font-weight: 620; border-radius: 8px; cursor: pointer;',
    '}',
    'button.confirm-cancel { color: var(--pg-fg-dim); background: transparent; border: 1px solid var(--pg-border); }',
    'button.confirm-cancel:hover { color: var(--pg-fg); background: var(--pg-hover); }',
    'button.confirm-ok { color: #fff; background: var(--pg-danger); border: 1px solid transparent; }',
    'button.confirm-ok:hover { filter: brightness(1.06); }',
    '@media (prefers-color-scheme: dark) {',
    '  :host { --pg-bg: #1c1f26; --pg-head: #23262f; --pg-fg: #e8eaf0; --pg-fg-dim: #9aa3b2;',
    '    --pg-border: #333846; --pg-hover: #2a2e39; --pg-user: #262a34; --pg-code: #2b303b;',
    '    --pg-accent: #6f9bff; --pg-accent-soft: rgba(111,155,255,.16); --pg-accent-border: #4c6fd6;',
    '    --pg-danger: #ff9a9a; --pg-danger-soft: rgba(255,120,120,.12); --pg-danger-border: #7a3b3b; }',
    '}'
  ].join('\n');

  var ICONS = {
    pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 4h6l-1 6 3.5 3.5H4.5L8 10z"/><path d="M12 13.5V21"/></svg>',
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 5.5A2.5 2.5 0 0 0 12.5 3h-6A3.5 3.5 0 0 0 3 6.5v6A2.5 2.5 0 0 0 5.5 15"/></svg>',
    unmark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16"/><path d="M7 7l1 12h8l1-12"/><path d="M10 7V5h4v2"/></svg>',
    fullscreen: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 4H4v5"/><path d="M15 4h5v5"/><path d="M15 20h5v-5"/><path d="M9 20H4v-5"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>'
  };

  function buildCardHtml() {
    return [
      '<div class="shell">',
      '  <div class="card">',
      '    <div class="head">',
      '      <span class="dot" aria-hidden="true"></span>',
      '      <span class="term"></span>',
      '      <span class="tools">',
      '        <button class="tool unmark" type="button" aria-haspopup="menu" aria-expanded="false">' + ICONS.unmark + '</button>',
      '        <button class="tool pin" type="button" aria-pressed="false">' + ICONS.pin + '</button>',
      '        <button class="tool copy" type="button">' + ICONS.copy + '</button>',
      '        <button class="tool fullscreen" type="button">' + ICONS.fullscreen + '</button>',
      '        <button class="tool close" type="button">' + ICONS.close + '</button>',
      '      </span>',
      '    </div>',
      '    <div class="menu" role="menu" hidden>',
      '      <button class="menu-item" type="button" role="menuitem" data-action="one"></button>',
      '      <button class="menu-item" type="button" role="menuitem" data-action="all"></button>',
      '    </div>',
      '    <div class="body"></div>',
      '    <div class="foot">',
      '      <div class="row">',
      '        <textarea class="ask" rows="1" spellcheck="false"></textarea>',
      '        <button class="send" type="button"></button>',
      '      </div>',
      '      <div class="hint"></div>',
      '    </div>',
      '  </div>',
      '  <aside class="note" hidden>',
      '    <div class="note-title"></div>',
      '    <textarea class="note-text" rows="4" spellcheck="false"></textarea>',
      '    <div class="note-saved" role="status" aria-live="polite"></div>',
      '  </aside>',
      '</div>'
    ].join('');
  }

  var CARD_HTML = buildCardHtml();

  function escapeHtml(text) {
    return String(text == null ? '' : text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /** Minimal, safe markdown renderer: no raw HTML ever passes through. */
  function renderMarkdown(source) {
    var text = String(source == null ? '' : source);
    if (!text.trim()) return '';
    var codeBlocks = [];
    text = text.replace(/```[a-zA-Z0-9_+-]*\n?([\s\S]*?)```/g, function (_m, code) {
      codeBlocks.push(code.replace(/\n$/, ''));
      return '\u0000CODE' + (codeBlocks.length - 1) + '\u0000';
    });

    function inline(value) {
      return escapeHtml(value)
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
        .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    }

    var lines = text.split('\n');
    var html = [];
    var listType = null;

    function closeList() {
      if (listType) {
        html.push('</' + listType + '>');
        listType = null;
      }
    }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var codeOnly = line.match(/^\u0000CODE(\d+)\u0000$/);
      if (codeOnly) {
        closeList();
        html.push('<pre><code>' + escapeHtml(codeBlocks[Number(codeOnly[1])] || '') + '</code></pre>');
        continue;
      }
      if (/^```/.test(line)) continue;
      var bullet = line.match(/^\s*[-*+]\s+(.*)$/);
      var ordered = line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (bullet || ordered) {
        var wanted = bullet ? 'ul' : 'ol';
        if (listType !== wanted) {
          closeList();
          html.push('<' + wanted + '>');
          listType = wanted;
        }
        html.push('<li>' + inline((bullet || ordered)[1]) + '</li>');
        continue;
      }
      closeList();
      if (!line.trim()) continue;
      var heading = line.match(/^#{1,6}\s+(.*)$/);
      if (heading) {
        html.push('<p><strong>' + inline(heading[1]) + '</strong></p>');
        continue;
      }
      html.push('<p>' + inline(line) + '</p>');
    }
    closeList();
    return html.join('');
  }

  /** Honour the OS reduced motion setting: skip the closing fade entirely. */
  function prefersReducedMotion() {
    try {
      return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (err) {
      return false;
    }
  }

  function createCard(options) {
    var opts = options || {};
    var position = opts.position || { x: 24, y: 24 };
    var host = document.createElement('pagegloss-ui');
    host.id = HOST_ID;
    // The width is inline because the page's `pagegloss-ui { all: initial }`
    // reset outranks :host rules; it grows while the note pane is open.
    host.style.cssText = 'position:fixed;z-index:2147483600;left:' + Math.round(position.x) +
      'px;top:' + Math.round(position.y) + 'px;width:min(392px, calc(100% - 16px));';
    var shadow = host.attachShadow({ mode: 'open' });
    var style = document.createElement('style');
    style.textContent = CSS;
    shadow.appendChild(style);

    var shell = document.createElement('div');
    shell.className = 'shell';
    // Static shell markup without interpolation; every dynamic value is written
    // with textContent and every model answer goes through renderMarkdown().
    shell.innerHTML = CARD_HTML;
    shadow.appendChild(shell);

    var card = shell.querySelector('.card');
    var body = card.querySelector('.body');
    var ask = card.querySelector('textarea.ask');
    var send = card.querySelector('.send');
    var notePane = shell.querySelector('.note');
    var noteTitle = shell.querySelector('.note-title');
    var noteText = shell.querySelector('textarea.note-text');

    var i18n = opts.i18n;
    var t = function (key) { return i18n ? i18n.t(key) : key; };

    card.querySelector('.term').textContent = opts.term || '';
    card.querySelector('.dot').style.background = opts.color || '#fff2a8';
    card.querySelector('.pin').title = t('cardPin');
    card.querySelector('.pin').setAttribute('aria-label', t('cardPin'));
    card.querySelector('.copy').title = t('cardCopy');
    card.querySelector('.copy').setAttribute('aria-label', t('cardCopy'));
    var fullscreenButton = card.querySelector('.fullscreen');
    fullscreenButton.title = t('cardFullscreen');
    fullscreenButton.setAttribute('aria-label', t('cardFullscreen'));
    card.querySelector('.close').title = t('cardClose');
    card.querySelector('.close').setAttribute('aria-label', t('cardClose'));
    send.textContent = t('cardSend');
    ask.placeholder = t('cardPlaceholder');
    card.querySelector('.hint').textContent = t('cardHint');
    noteTitle.textContent = t('cardNoteTitle');
    noteText.placeholder = t('cardNotePlaceholder');
    noteText.value = String(opts.note == null ? '' : opts.note);

    var handlers = {};
    var streamHandle = null;
    var autoScroll = true;
    var drag = null;
    var reasoningNode = null;
    var destroyed = false;
    var closing = false;

    // Every timer is tracked so destroy() can never leave one behind.
    var noteShowTimer = 0;
    var noteHideTimer = 0;
    var noteSaveTimer = 0;
    var savedTimer = 0;
    var savedRemoveTimer = 0;
    var closeTimer = 0;
    var savedNode = null;
    var lastSavedNote = noteText.value;

    // Cancel-mark menu: offers the two unmark scopes without leaving the card.
    var unmarkButton = card.querySelector('.unmark');
    var menu = card.querySelector('.menu');
    var menuOne = card.querySelector('.menu-item[data-action="one"]');
    var menuAll = card.querySelector('.menu-item[data-action="all"]');

    function closeMenu() {
      if (menu.hidden) return;
      menu.hidden = true;
      unmarkButton.setAttribute('aria-expanded', 'false');
      card.removeEventListener('mousedown', onDocumentMouseDown, true);
      removeEventListener('keydown', onMenuKeyDown, true);
    }

    function onDocumentMouseDown(event) {
      if (event.target === unmarkButton) return;
      var path = event.composedPath ? event.composedPath() : [];
      if (path.indexOf(menu) >= 0 || path.indexOf(unmarkButton) >= 0) return;
      closeMenu();
    }

    function onMenuKeyDown(event) {
      if (event.key === 'Escape') {
        event.stopPropagation();
        closeMenu();
        unmarkButton.focus();
      }
    }

    function openMenu() {
      menu.hidden = false;
      unmarkButton.setAttribute('aria-expanded', 'true');
      card.addEventListener('mousedown', onDocumentMouseDown, true);
      addEventListener('keydown', onMenuKeyDown, true);
      var firstItem = menuOne.offsetParent === null ? menuAll : menuOne;
      if (firstItem && firstItem.focus) firstItem.focus();
    }

    // Dragging the pinned window keeps it where the reader wants it.
    var head = card.querySelector('.head');
    head.addEventListener('pointerdown', function (event) {
      if (!card.classList.contains('pinned')) return;
      if (event.button !== 0) return;
      if (event.target.closest && event.target.closest('button')) return;
      var rect = host.getBoundingClientRect();
      drag = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        originX: rect.left,
        originY: rect.top
      };
      if (head.setPointerCapture) {
        try { head.setPointerCapture(event.pointerId); } catch (err) { /* ignore */ }
      }
      head.style.cursor = 'grabbing';
    });
    head.addEventListener('pointermove', function (event) {
      if (drag && event.pointerId === drag.pointerId) {
        event.preventDefault();
        api.setPosition(drag.originX + (event.clientX - drag.startX), drag.originY + (event.clientY - drag.startY));
      }
      if (!drag && card.classList.contains('pinned') && !(event.target.closest && event.target.closest('button'))) {
        head.style.cursor = 'grab';
      }
    });
    head.addEventListener('pointerup', function (event) {
      if (!drag || event.pointerId !== drag.pointerId) return;
      drag = null;
      head.style.cursor = card.classList.contains('pinned') ? 'grab' : 'default';
    });

    /* ------------------------------------------------------------- note pane */

    var pointerInShell = false;

    function noteOpen() {
      return !!host.classList.contains('note-open');
    }

    /**
     * Row layout needs room for card + note; below 900px the note stacks under
     * the card, so the host keeps the single-card width.
     */
    function applyHostWidth() {
      var stacked = false;
      try {
        stacked = !!(window.matchMedia && window.matchMedia('(max-width: 899px)').matches);
      } catch (err) {
        stacked = false;
      }
      var wide = noteOpen() && !stacked;
      host.style.width = wide ? 'min(660px, calc(100% - 16px))' : 'min(392px, calc(100% - 16px))';
    }

    function showNote() {
      if (destroyed) return;
      if (noteHideTimer) {
        window.clearTimeout(noteHideTimer);
        noteHideTimer = 0;
      }
      if (noteOpen()) return;
      host.classList.add('note-open');
      notePane.hidden = false;
      applyHostWidth();
      // The host got wider; pull it back inside the viewport if needed.
      reposition();
    }

    function hideNote() {
      if (noteHideTimer) {
        window.clearTimeout(noteHideTimer);
        noteHideTimer = 0;
      }
      if (!noteOpen()) return;
      notePane.hidden = true;
      host.classList.remove('note-open');
      applyHostWidth();
    }

    function scheduleNoteShow(delay) {
      if (destroyed) return;
      if (noteShowTimer) window.clearTimeout(noteShowTimer);
      noteShowTimer = window.setTimeout(function () {
        noteShowTimer = 0;
        if (destroyed || closing) return;
        showNote();
      }, delay == null ? 200 : delay);
    }

    function scheduleNoteHide(delay) {
      if (destroyed) return;
      if (noteHideTimer) window.clearTimeout(noteHideTimer);
      noteHideTimer = window.setTimeout(function () {
        noteHideTimer = 0;
        if (destroyed || closing) return;
        if (isPinned() || isTyping()) return;
        if (pointerInShell) return;
        hideNote();
      }, delay == null ? 200 : delay);
    }

    shell.addEventListener('mouseenter', function () {
      pointerInShell = true;
      if (noteHideTimer) {
        window.clearTimeout(noteHideTimer);
        noteHideTimer = 0;
      }
    });
    shell.addEventListener('mouseleave', function () {
      pointerInShell = false;
      scheduleNoteHide(200);
      if (handlers.onPointerLeave) handlers.onPointerLeave();
    });
    card.addEventListener('mouseenter', function () {
      if (handlers.onPointerEnter) handlers.onPointerEnter();
      scheduleNoteShow(200);
    });
    card.addEventListener('mouseleave', function () {
      // The pointer may be moving into the note pane, which keeps the shell
      // hovered; the delayed check decides.
      scheduleNoteHide(200);
    });
    notePane.addEventListener('mouseenter', function () {
      if (noteHideTimer) {
        window.clearTimeout(noteHideTimer);
        noteHideTimer = 0;
      }
      scheduleNoteShow(0);
    });
    notePane.addEventListener('mouseleave', function () {
      scheduleNoteHide(200);
    });

    function inShadowFocus(element) {
      try {
        if (shadow.activeElement) return shadow.activeElement === element;
        return document.activeElement === element;
      } catch (err) {
        return false;
      }
    }

    /** True while the reader is typing a question or a note. */
    function isTyping() {
      if (inShadowFocus(ask) || inShadowFocus(noteText)) return true;
      if (String(ask.value || '').trim()) return true;
      if (String(noteText.value || '').trim()) return true;
      return false;
    }

    function flashNoteSaved() {
      if (destroyed || !notePane) return;
      if (savedTimer) {
        window.clearTimeout(savedTimer);
        savedTimer = 0;
      }
      if (savedRemoveTimer) {
        window.clearTimeout(savedRemoveTimer);
        savedRemoveTimer = 0;
      }
      if (savedNode && savedNode.parentNode) savedNode.parentNode.removeChild(savedNode);
      savedNode = document.createElement('div');
      savedNode.className = 'note-saved show';
      savedNode.setAttribute('role', 'status');
      savedNode.textContent = t('cardNoteSaved');
      notePane.appendChild(savedNode);
      var node = savedNode;
      savedTimer = window.setTimeout(function () {
        savedTimer = 0;
        if (!node || !node.classList) return;
        node.classList.add('leaving');
        var removed = false;
        var finish = function () {
          if (removed) return;
          removed = true;
          if (savedRemoveTimer) {
            window.clearTimeout(savedRemoveTimer);
            savedRemoveTimer = 0;
          }
          if (node.removeEventListener) node.removeEventListener('transitionend', finish);
          if (node.parentNode) node.parentNode.removeChild(node);
          if (savedNode === node) savedNode = null;
        };
        if (node.addEventListener) node.addEventListener('transitionend', finish);
        savedRemoveTimer = window.setTimeout(finish, 320);
      }, 900);
    }

    function commitNote() {
      noteSaveTimer = 0;
      if (destroyed) return;
      var text = String(noteText.value || '');
      if (text === lastSavedNote) return;
      lastSavedNote = text;
      if (!handlers.onNoteChange) return;
      var result = null;
      try {
        result = handlers.onNoteChange(text);
      } catch (err) {
        result = null;
      }
      if (result && typeof result.then === 'function') {
        result.then(function (saved) {
          if (saved !== false) flashNoteSaved();
        }).catch(function () { /* persistence problems stay quiet here */ });
      } else {
        flashNoteSaved();
      }
    }

    noteText.addEventListener('input', function () {
      if (noteSaveTimer) window.clearTimeout(noteSaveTimer);
      noteSaveTimer = window.setTimeout(commitNote, 500);
    });
    noteText.addEventListener('focus', function () {
      if (noteHideTimer) {
        window.clearTimeout(noteHideTimer);
        noteHideTimer = 0;
      }
      scheduleNoteShow(0);
    });
    noteText.addEventListener('blur', function () {
      if (isPinned() || isTyping()) return;
      scheduleNoteHide(260);
    });

    body.addEventListener('scroll', function () {
      autoScroll = body.scrollTop + body.clientHeight >= body.scrollHeight - 24;
    });

    function scrollToEnd() {
      if (autoScroll) body.scrollTop = body.scrollHeight;
    }

    function clearBody() {
      body.textContent = '';
    }

    function addUserMessage(text) {
      var el = document.createElement('div');
      el.className = 'msg user';
      el.textContent = text;
      body.appendChild(el);
      scrollToEnd();
      return el;
    }

    function addAssistantBubble() {
      var el = document.createElement('div');
      el.className = 'msg assistant';
      var who = document.createElement('span');
      who.className = 'who';
      who.textContent = t('cardAnswerLabel');
      var md = document.createElement('div');
      md.className = 'md';
      el.appendChild(who);
      el.appendChild(md);
      body.appendChild(el);
      return md;
    }

    function addState(label) {
      var el = document.createElement('div');
      el.className = 'state';
      var spin = document.createElement('span');
      spin.className = 'spin';
      spin.setAttribute('aria-hidden', 'true');
      var text = document.createElement('span');
      text.textContent = label;
      el.appendChild(spin);
      el.appendChild(text);
      body.appendChild(el);
      scrollToEnd();
      return el;
    }

    function addError(message, retry, extra) {
      var el = document.createElement('div');
      el.className = 'error';
      var text = document.createElement('span');
      text.className = 'error-text';
      text.textContent = message;
      el.appendChild(text);
      var actions = document.createElement('span');
      actions.className = 'error-actions';
      if (retry) {
        var button = document.createElement('button');
        button.type = 'button';
        button.className = 'ghost';
        button.textContent = t('cardRetry');
        button.addEventListener('click', function () {
          el.remove();
          retry();
        });
        actions.appendChild(button);
      }
      if (extra && typeof extra.onOpenSettings === 'function') {
        var settingsButton = document.createElement('button');
        settingsButton.type = 'button';
        settingsButton.className = 'ghost';
        settingsButton.textContent = t('cfgOpenOptions');
        settingsButton.addEventListener('click', function () {
          extra.onOpenSettings();
        });
        actions.appendChild(settingsButton);
      }
      if (actions.childNodes.length) el.appendChild(actions);
      body.appendChild(el);
      scrollToEnd();
      return el;
    }

    function setBusy(busy) {
      send.disabled = busy;
      ask.disabled = busy;
      card.querySelector('.pin').disabled = false;
      card.classList.toggle('busy', busy);
    }

    function abortStream() {
      if (streamHandle && typeof streamHandle.abort === 'function') {
        try { streamHandle.abort(); } catch (err) { /* ignore */ }
      }
      streamHandle = null;
    }

    function submit(question) {
      var text = String(question || '').trim();
      if (!text) return;
      if (!handlers.onAsk) return;
      addUserMessage(text);
      ask.value = '';
      ask.style.height = 'auto';
      setBusy(true);
      var md = null;
      var buffer = '';
      var state = addState(t('cardThinking'));
      var finished = false;

      function beginAnswer() {
        if (md) return;
        state.remove();
        md = addAssistantBubble();
      }

      streamHandle = handlers.onAsk(text, {
        onToken: function (chunk) {
          beginAnswer();
          buffer += chunk;
          md.innerHTML = renderMarkdown(buffer);
          scrollToEnd();
        },
        onDone: function (full) {
          if (finished) return;
          finished = true;
          if (!md) {
            if (full) {
              beginAnswer();
              buffer = full;
            } else {
              state.remove();
              addError(t('cardEmpty'));
            }
          }
          if (md && buffer !== full && full) {
            buffer = full;
            md.innerHTML = renderMarkdown(buffer);
          }
          if (md) md.dataset.raw = buffer;
          setBusy(false);
          abortStream();
          if (md && handlers.onAnswer) handlers.onAnswer(question, buffer);
          scrollToEnd();
        },
        onError: function (message) {
          if (finished) return;
          finished = true;
          state.remove();
          setBusy(false);
          abortStream();
          addError(message || t('errUnknown'), function () { submit(text); });
          if (handlers.onError) handlers.onError(message);
        }
      });
    }

    send.addEventListener('click', function () { submit(ask.value); });
    ask.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        submit(ask.value);
      }
    });
    ask.addEventListener('input', function () {
      ask.style.height = 'auto';
      ask.style.height = Math.min(ask.scrollHeight, 88) + 'px';
    });
    card.querySelector('.close').addEventListener('click', function () {
      if (handlers.onClose) handlers.onClose();
    });
    var pinButton = card.querySelector('.pin');
    pinButton.addEventListener('click', function () {
      if (handlers.onTogglePin) handlers.onTogglePin();
    });
    fullscreenButton.addEventListener('click', function () {
      if (handlers.onFullscreen) handlers.onFullscreen();
    });

    unmarkButton.title = t('cardUnmark');
    unmarkButton.setAttribute('aria-label', t('cardUnmark'));
    unmarkButton.addEventListener('click', function () {
      if (menu.hidden) openMenu();
      else closeMenu();
    });
    menuOne.textContent = t('cardUnmarkOne');
    menuAll.textContent = t('cardUnmarkAll');
    menuOne.addEventListener('click', function () {
      closeMenu();
      if (handlers.onUnmarkOne) handlers.onUnmarkOne();
    });
    menuAll.addEventListener('click', function () {
      closeMenu();
      if (handlers.onUnmarkAll) handlers.onUnmarkAll();
    });
    card.querySelector('.copy').addEventListener('click', function () {
      var raw = '';
      var bubbles = body.querySelectorAll('.md');
      for (var i = 0; i < bubbles.length; i++) {
        var value = bubbles[i].dataset.raw || bubbles[i].textContent || '';
        if (value.trim()) raw += (raw ? '\n\n' : '') + value.trim();
      }
      var copy = navigator.clipboard && navigator.clipboard.writeText
        ? navigator.clipboard.writeText(raw)
        : Promise.reject(new Error('unsupported'));
      copy.then(function () {
        if (handlers.onToast) handlers.onToast(t('cardCopied'));
      }).catch(function () {
        if (handlers.onToast) handlers.onToast(t('cardCopyFailed'));
      });
    });

    function isPinned() {
      return card.classList.contains('pinned');
    }

    function setPosition(x, y) {
      var width = host.offsetWidth || Math.min(392, window.innerWidth - 16);
      var height = host.offsetHeight || 320;
      var maxX = Math.max(8, window.innerWidth - width - 8);
      var maxY = Math.max(8, window.innerHeight - Math.min(height, window.innerHeight) - 8);
      host.style.left = Math.round(Math.max(8, Math.min(x, maxX))) + 'px';
      host.style.top = Math.round(Math.max(8, Math.min(y, maxY))) + 'px';
    }

    function currentLeft() {
      var value = parseFloat(host.style.left);
      return isFinite(value) ? value : position.x;
    }

    function currentTop() {
      var value = parseFloat(host.style.top);
      return isFinite(value) ? value : position.y;
    }

    function reposition() {
      setPosition(currentLeft(), currentTop());
    }

    function clearTimers() {
      if (noteShowTimer) window.clearTimeout(noteShowTimer);
      if (noteHideTimer) window.clearTimeout(noteHideTimer);
      if (noteSaveTimer) window.clearTimeout(noteSaveTimer);
      if (savedTimer) window.clearTimeout(savedTimer);
      if (savedRemoveTimer) window.clearTimeout(savedRemoveTimer);
      if (closeTimer) window.clearTimeout(closeTimer);
      noteShowTimer = 0;
      noteHideTimer = 0;
      noteSaveTimer = 0;
      savedTimer = 0;
      savedRemoveTimer = 0;
      closeTimer = 0;
    }

    function setPinned(pinned) {
      card.classList.toggle('pinned', !!pinned);
      pinButton.setAttribute('aria-pressed', pinned ? 'true' : 'false');
      pinButton.title = pinned ? t('cardUnpin') : t('cardPin');
      pinButton.setAttribute('aria-label', pinned ? t('cardUnpin') : t('cardPin'));
      head.style.cursor = pinned ? 'grab' : 'default';
      if (pinned) {
        // A pinned window keeps the note pane visible.
        showNote();
      } else if (!pointerInShell && !isTyping()) {
        scheduleNoteHide(260);
      }
    }

    function destroy() {
      if (destroyed) return;
      // Flush a note edit whose 500ms debounce has not fired yet.
      if (noteSaveTimer) {
        try { commitNote(); } catch (err) { /* ignore */ }
      }
      destroyed = true;
      closing = true;
      clearTimers();
      abortStream();
      try { closeMenu(); } catch (err) { /* ignore */ }
      if (savedNode && savedNode.parentNode) savedNode.parentNode.removeChild(savedNode);
      savedNode = null;
      if (host.parentNode) host.parentNode.removeChild(host);
    }

    /** Fade the card out, then remove it. animated:false removes it at once. */
    function close(animated) {
      if (destroyed || closing) return;
      if (animated === false || prefersReducedMotion()) {
        destroy();
        return;
      }
      closing = true;
      shell.classList.add('leaving');
      card.classList.add('leaving');
      notePane.classList.add('leaving');
      var finished = false;
      var finish = function () {
        if (finished) return;
        finished = true;
        if (closeTimer) {
          window.clearTimeout(closeTimer);
          closeTimer = 0;
        }
        if (shell.removeEventListener) shell.removeEventListener('transitionend', onEnd);
        destroy();
      };
      var onEnd = function (event) {
        if (event && event.target && event.target !== shell && event.target !== card) return;
        finish();
      };
      if (shell.addEventListener) {
        shell.addEventListener('transitionend', onEnd);
        closeTimer = window.setTimeout(finish, 180);
      } else {
        finish();
      }
    }

    var api = {
      host: host,
      card: card,
      setPinned: setPinned,
      isPinned: isPinned,
      isTyping: isTyping,
      setNote: function (text) {
        if (noteSaveTimer) {
          window.clearTimeout(noteSaveTimer);
          noteSaveTimer = 0;
        }
        noteText.value = String(text == null ? '' : text);
        lastSavedNote = noteText.value;
      },
      getNote: function () { return String(noteText.value || ''); },
      flashNoteSaved: flashNoteSaved,
      clear: function () { reasoningNode = null; clearBody(); },
      addUserMessage: addUserMessage,
      addAssistantMarkdown: function (raw) {
        var md = addAssistantBubble();
        md.innerHTML = renderMarkdown(raw);
        md.dataset.raw = raw;
        scrollToEnd();
      },
      addNotice: function (message) {
        var el = document.createElement('div');
        el.className = 'msg';
        el.textContent = message;
        body.appendChild(el);
        scrollToEnd();
      },
      /** Chain-of-thought output: shown muted, above the final answer. */
      appendReasoning: function (text) {
        if (!text) return;
        if (!reasoningNode) {
          reasoningNode = document.createElement('div');
          reasoningNode.className = 'reasoning';
          var who = document.createElement('span');
          who.className = 'who';
          who.textContent = t('cardReasoningLabel');
          reasoningNode.appendChild(who);
          var bodyText = document.createElement('span');
          bodyText.className = 'reasoning-text';
          reasoningNode.appendChild(bodyText);
          body.appendChild(reasoningNode);
        }
        var target = reasoningNode.querySelector('.reasoning-text');
        if (target) target.textContent += text;
        scrollToEnd();
      },
      addNoticeAction: function (message, label, onAction) {
        var el = document.createElement('div');
        el.className = 'msg';
        el.textContent = message;
        var button = document.createElement('button');
        button.type = 'button';
        button.className = 'ghost';
        button.textContent = label;
        button.style.marginTop = '8px';
        button.addEventListener('click', function () {
          el.remove();
          onAction();
        });
        el.appendChild(document.createElement('br'));
        el.appendChild(button);
        body.appendChild(el);
        scrollToEnd();
      },
      addError: addError,
      addState: addState,
      removeState: function (el) { if (el && el.parentNode) el.remove(); },
      setBusy: setBusy,
      submit: submit,
      focus: function () { ask.focus(); },
      abort: abortStream,
      close: close,
      destroy: destroy,
      setHandlers: function (next) { handlers = next || {}; },
      setPosition: setPosition,
      moveBy: function (dx, dy) {
        var rect = host.getBoundingClientRect();
        host.style.left = Math.round(rect.left + dx) + 'px';
        host.style.top = Math.round(rect.top + dy) + 'px';
      },
      scrollToEnd: scrollToEnd
    };
    return api;
  }

  /**
   * In-page confirmation dialog in the card's visual language.
   * Returns Promise<boolean>: true when the primary action is chosen.
   */
  function confirmDialog(options) {
    var opts = options || {};
    return new Promise(function (resolve) {
      var host = document.createElement('pagegloss-ui');
      host.id = 'pagegloss-confirm-host';
      host.style.cssText = 'position:fixed;inset:0;z-index:2147483645;width:100%;height:100%;';
      var shadow = host.attachShadow({ mode: 'open' });
      var style = document.createElement('style');
      style.textContent = CSS;
      shadow.appendChild(style);

      var overlay = document.createElement('div');
      overlay.className = 'confirm-overlay';
      var dialog = document.createElement('div');
      dialog.className = 'confirm';
      dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-modal', 'true');

      var title = document.createElement('h2');
      title.className = 'confirm-title';
      title.textContent = opts.title || '';
      var bodyText = document.createElement('p');
      bodyText.className = 'confirm-body';
      bodyText.textContent = opts.body || '';
      var actions = document.createElement('div');
      actions.className = 'confirm-actions';
      var cancelButton = document.createElement('button');
      cancelButton.type = 'button';
      cancelButton.className = 'confirm-cancel';
      cancelButton.textContent = opts.cancel || '';
      var okButton = document.createElement('button');
      okButton.type = 'button';
      okButton.className = 'confirm-ok';
      okButton.textContent = opts.ok || '';
      actions.appendChild(cancelButton);
      actions.appendChild(okButton);
      dialog.appendChild(title);
      dialog.appendChild(bodyText);
      dialog.appendChild(actions);
      overlay.appendChild(dialog);
      shadow.appendChild(overlay);
      (document.body || document.documentElement).appendChild(host);

      var settled = false;

      function finish(result) {
        if (settled) return;
        settled = true;
        try { removeEventListener('keydown', onKeyDown, true); } catch (err) { /* ignore */ }
        overlay.removeEventListener('mousedown', onOverlayDown);
        if (host.parentNode) host.parentNode.removeChild(host);
        resolve(!!result);
      }

      function onOverlayDown(event) {
        var path = event.composedPath ? event.composedPath() : [];
        if (path.indexOf(dialog) >= 0) return;
        if (dialog.contains && event.target && dialog.contains(event.target)) return;
        finish(false);
      }

      function onKeyDown(event) {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        if (event.stopImmediatePropagation) event.stopImmediatePropagation();
        else event.stopPropagation();
        finish(false);
      }

      cancelButton.addEventListener('click', function () { finish(false); });
      okButton.addEventListener('click', function () { finish(true); });
      overlay.addEventListener('mousedown', onOverlayDown);
      addEventListener('keydown', onKeyDown, true);
      try { okButton.focus(); } catch (err) { /* ignore */ }
    });
  }

  window.PageGlossCard = {
    create: createCard,
    confirm: confirmDialog,
    renderMarkdown: renderMarkdown,
    escapeHtml: escapeHtml,
    HOST_ID: HOST_ID
  };
})();
