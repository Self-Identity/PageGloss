/*
 * PageGloss - hover annotation card (Shadow DOM isolated).
 * Shows the LLM explanation of the marked term and lets the user keep asking
 * follow-up questions, either inline (hover) or pinned as a floating window.
 */
(function () {
  'use strict';

  var HOST_ID = 'pagegloss-card-host';

  var CSS = [
    ':host { all: initial; }',
    '* { box-sizing: border-box; }',
    '.card {',
    '  width: min(392px, calc(100% - 16px));',
    '  max-height: min(70vh, 560px);',
    '  display: flex; flex-direction: column; min-width: 0; min-height: 0;',
    '  font: 13px/1.62 system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;',
    '  color: var(--pg-fg); background: var(--pg-bg);',
    '  border: 1px solid var(--pg-border); border-radius: 14px;',
    '  box-shadow: 0 18px 48px rgba(15, 23, 42, .22), 0 2px 8px rgba(15, 23, 42, .12);',
    '  overflow: hidden;',
    '}',
    '.card:not(.pinned) { animation: pg-in .14s ease-out; }',
    '@keyframes pg-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }',
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
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>'
  };

  function buildCardHtml() {
    return [
      '<div class="head">',
      '  <span class="dot" aria-hidden="true"></span>',
      '  <span class="term"></span>',
      '  <span class="tools">',
      '    <button class="tool unmark" type="button" aria-haspopup="menu" aria-expanded="false">' + ICONS.unmark + '</button>',
      '    <button class="tool pin" type="button" aria-pressed="false">' + ICONS.pin + '</button>',
      '    <button class="tool copy" type="button">' + ICONS.copy + '</button>',
      '    <button class="tool close" type="button">' + ICONS.close + '</button>',
      '  </span>',
      '</div>',
      '<div class="menu" role="menu" hidden>',
      '  <button class="menu-item" type="button" role="menuitem" data-action="one"></button>',
      '  <button class="menu-item" type="button" role="menuitem" data-action="all"></button>',
      '</div>',
      '<div class="body"></div>',
      '<div class="foot">',
      '  <div class="row">',
      '    <textarea class="ask" rows="1" spellcheck="false"></textarea>',
      '    <button class="send" type="button"></button>',
      '  </div>',
      '  <div class="hint"></div>',
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

  function createCard(options) {
    var opts = options || {};
    var position = opts.position || { x: 24, y: 24 };
    var host = document.createElement('pagegloss-ui');
    host.id = HOST_ID;
    host.style.cssText = 'position:fixed;z-index:2147483600;left:' + Math.round(position.x) +
      'px;top:' + Math.round(position.y) + 'px;width:min(392px, calc(100% - 16px));';
    var shadow = host.attachShadow({ mode: 'open' });
    var style = document.createElement('style');
    style.textContent = CSS;
    shadow.appendChild(style);

    var card = document.createElement('div');
    card.className = 'card';
    // Static shell markup without interpolation; every dynamic value is written
    // with textContent and every model answer goes through renderMarkdown().
    card.innerHTML = CARD_HTML;
    shadow.appendChild(card);

    var body = card.querySelector('.body');
    var ask = card.querySelector('textarea.ask');
    var send = card.querySelector('.send');

    var i18n = opts.i18n;
    var t = function (key) { return i18n ? i18n.t(key) : key; };

    card.querySelector('.term').textContent = opts.term || '';
    card.querySelector('.dot').style.background = opts.color || '#fff2a8';
    card.querySelector('.pin').title = t('cardPin');
    card.querySelector('.pin').setAttribute('aria-label', t('cardPin'));
    card.querySelector('.copy').title = t('cardCopy');
    card.querySelector('.copy').setAttribute('aria-label', t('cardCopy'));
    card.querySelector('.close').title = t('cardClose');
    card.querySelector('.close').setAttribute('aria-label', t('cardClose'));
    send.textContent = t('cardSend');
    ask.placeholder = t('cardPlaceholder');
    card.querySelector('.hint').textContent = t('cardHint');

    var handlers = {};
    var streamHandle = null;
    var autoScroll = true;
    var drag = null;

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

    var api = {
      host: host,
      card: card,
      setPinned: function (pinned) {
        card.classList.toggle('pinned', !!pinned);
        pinButton.setAttribute('aria-pressed', pinned ? 'true' : 'false');
        pinButton.title = pinned ? t('cardUnpin') : t('cardPin');
        head.style.cursor = pinned ? 'grab' : 'default';
      },
      isPinned: function () { return card.classList.contains('pinned'); },
      clear: clearBody,
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
      setHandlers: function (next) { handlers = next || {}; },
      setPosition: function (x, y) {
        var width = host.offsetWidth || Math.min(392, window.innerWidth - 16);
        var height = host.offsetHeight || 320;
        var maxX = Math.max(8, window.innerWidth - width - 8);
        var maxY = Math.max(8, window.innerHeight - Math.min(height, window.innerHeight) - 8);
        host.style.left = Math.round(Math.max(8, Math.min(x, maxX))) + 'px';
        host.style.top = Math.round(Math.max(8, Math.min(y, maxY))) + 'px';
      },
      moveBy: function (dx, dy) {
        var rect = host.getBoundingClientRect();
        host.style.left = Math.round(rect.left + dx) + 'px';
        host.style.top = Math.round(rect.top + dy) + 'px';
      },
      scrollToEnd: scrollToEnd,
      destroy: function () {
        abortStream();
        closeMenu();
        if (host.parentNode) host.parentNode.removeChild(host);
      }
    };
    return api;
  }

  window.PageGlossCard = {
    create: createCard,
    renderMarkdown: renderMarkdown,
    escapeHtml: escapeHtml,
    HOST_ID: HOST_ID
  };
})();
