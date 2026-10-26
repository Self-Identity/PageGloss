/*
 * PageGloss - content script entry point.
 * Responsibilities: context menu wiring, marking engine orchestration, hover
 * card lifecycle, per-annotation chat persistence and page restore.
 *
 * Load order is declared in manifest.json: messages.js, i18n.js, storage.js,
 * matcher.js, card.js, then this file. Dependencies are checked before use so a
 * broken load order reports itself instead of throwing "cannot read properties
 * of undefined".
 */
(function () {
  'use strict';

  /**
   * Self contained dependency check. It runs before anything else touches the
   * shared globals so a broken manifest load order reports itself instead of
   * throwing "Cannot read properties of undefined".
   */
  (function checkDependencies() {
    var missing = [];
    if (!window.PageGlossShared) missing.push('PageGlossShared (src/shared/messages.js)');
    if (!window.PageGlossMatcher) missing.push('PageGlossMatcher (src/content/matcher.js)');
    if (!window.PageGlossStore) missing.push('PageGlossStore (src/shared/storage.js)');
    if (!window.PageGlossCard) missing.push('PageGlossCard (src/content/card.js)');
    if (!missing.length) return;
    var message = '[PageGloss] missing shared script(s): ' + missing.join(', ') +
      '. Check the content_scripts order in manifest.json.';
    try {
      console.error(message);
    } catch (err) { /* console may be unavailable */ }
    try {
      var host = document.createElement('pagegloss-ui');
      host.id = 'pagegloss-toast-host';
      host.style.cssText = 'position:fixed;z-index:2147483647;left:50%;bottom:28px;' +
        'transform:translateX(-50%);width:min(420px, calc(100% - 24px));';
      var shadow = host.attachShadow({ mode: 'open' });
      var box = document.createElement('div');
      box.setAttribute('role', 'alert');
      box.style.cssText = 'font:13px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:#f8fafc;' +
        'background:rgba(23,26,33,.96);border:1px solid rgba(255,255,255,.14);border-radius:11px;' +
        'padding:9px 13px;overflow-wrap:anywhere;';
      box.textContent = window.PageGlossI18n
        ? window.PageGlossI18n.create().t('errContentScriptBroken')
        : message;
      shadow.appendChild(box);
      (document.body || document.documentElement).appendChild(host);
    } catch (err) { /* the console message above is enough */ }
    throw new Error('PageGloss: required shared script(s) missing: ' + missing.join(', '));
  })();

  /** Minimal no-op translator used when i18n.js failed to load. */
  function fallbackI18n() {
    return function (key, values) {
      var text = String(key);
      if (values && values.s !== undefined) text += ': ' + values.s;
      return text;
    };
  }

  var M = window.PageGlossMatcher;
  var S = window.PageGlossShared;
  var Store = window.PageGlossStore;
  var Card = window.PageGlossCard;
  var i18n = window.PageGlossI18n ? window.PageGlossI18n.create() : null;
  var t = i18n ? i18n.t : fallbackI18n();

  var state = {
    settings: null,
    settingsPromise: null,
    page: null,
    urlKey: S.normalizeUrlKey(location.href),
    annotations: [],
    threads: {},
    pendingMenu: null,
    note: null,
    hoverTimer: 0,
    hideTimer: 0,
    scrollLock: 0
  };

  var TOAST_ID = 'pagegloss-toast-host';
  var MARK_TAG = 'pagegloss-mark';

  /** chrome.runtime.openOptionsPage is not available in every context. */
  function openOptionsPage() {
    try {
      if (chrome.runtime && typeof chrome.runtime.sendMessage === 'function') {
        chrome.runtime.sendMessage({ type: 'pg:openOptions' }, function () {
          void chrome.runtime.lastError;
        });
        return;
      }
    } catch (err) {
      // fall through to the direct URL below
    }
    try {
      if (chrome.runtime && typeof chrome.runtime.getURL === 'function') {
        window.open(chrome.runtime.getURL('src/options/options.html'), '_blank', 'noopener');
        return;
      }
    } catch (err) {
      showToast(t('errOpenOptions'));
    }
  }

  /**
   * Settings are loaded asynchronously at boot. Everything that asks the user
   * to configure the LLM must wait for that load instead of guessing: checking
   * an empty snapshot is exactly what produced the old false "not configured"
   * toast right after every page load.
   */
  function whenSettings() {
    if (state.settings) return Promise.resolve(state.settings);
    if (state.settingsPromise) {
      return state.settingsPromise.catch(function () { return null; });
    }
    return Promise.resolve(null);
  }

  /** The three settings every explanation request needs. */
  function llmConfigState() {
    // Not loaded yet: the caller must wait (whenSettings) instead of warning.
    if (!state.settings) return { ready: false, code: 'loading', pending: true, missing: [], message: '' };
    var settings = state.settings || {};
    var hasUrl = !!String(settings.apiBaseUrl || '').trim();
    var hasKey = !!String(settings.apiKey || '').trim();
    var hasModel = !!String(settings.model || '').trim();
    if (hasUrl && hasKey && hasModel) return { ready: true, code: 'ok' };
    var missing = [];
    var code = 'not-configured';
    if (!hasUrl) missing.push(t('cfgBaseUrl'));
    if (!hasKey) {
      missing.push(t('cfgApiKey'));
      code = 'no-key';
    }
    if (!hasModel) missing.push(t('cfgModel'));
    return {
      ready: false,
      code: code,
      missing: missing,
      message: t('errNotConfigured', { s: missing.join('、') })
    };
  }

  /**
   * Friendly, actionable notice for a missing configuration. Shown as a toast
   * (with a shortcut to the settings page) and, when a card is open, inside the
   * card with a retry button.
   */
  function notifyNotConfigured(config, card) {
    var configState = config || llmConfigState();
    if (configState.ready || configState.pending) return false;
    showToast(configState.message, {
      duration: 6000,
      action: { label: t('cfgOpenOptions'), run: openOptionsPage }
    });
    if (card) {
      card.addError(configState.message, function () {
        var annotation = stateAnnotationForCard(card);
        if (annotation) requestExplanation(annotation, card);
      }, { onOpenSettings: openOptionsPage });
    }
    return true;
  }

  /** The annotation currently shown by a card, used by retry handlers. */
  function stateAnnotationForCard(card) {
    if (state.note && state.note.card === card) return annotationById(state.note.annotationId);
    return null;
  }

  /* ------------------------------------------------------------------ toasts */

  var toastState = { host: null, item: null, timer: 0, removeTimer: 0 };

  function clearToastTimers() {
    if (toastState.timer) window.clearTimeout(toastState.timer);
    if (toastState.removeTimer) window.clearTimeout(toastState.removeTimer);
    toastState.timer = 0;
    toastState.removeTimer = 0;
  }

  function destroyToast() {
    clearToastTimers();
    if (toastState.item && toastState.item.parentNode) toastState.item.parentNode.removeChild(toastState.item);
    toastState.item = null;
    if (toastState.host && toastState.host.parentNode) toastState.host.parentNode.removeChild(toastState.host);
    toastState.host = null;
  }

  function showToast(message, options) {
    var opts = options || {};
    if (!message) return;
    if (!toastState.host || !toastState.host.isConnected) {
      var host = document.createElement('pagegloss-ui');
      host.id = TOAST_ID;
      host.style.cssText = 'position:fixed;z-index:2147483647;left:50%;bottom:28px;transform:translateX(-50%);width:min(420px, calc(100% - 24px));pointer-events:none;';
      var shadow = host.attachShadow({ mode: 'open' });
      var style = document.createElement('style');
      style.textContent = [
        ':host{all:initial}',
        '.toast{',
        '  display:flex;align-items:center;gap:10px;flex-wrap:nowrap;',
        '  font:13px/1.5 system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;',
        '  color:#f8fafc;background:rgba(23,26,33,.94);border:1px solid rgba(255,255,255,.12);',
        '  border-radius:11px;padding:9px 13px;box-shadow:0 12px 30px rgba(15,23,42,.34);',
        '  overflow-wrap:anywhere;opacity:1;transform:translateY(0);transition:opacity .2s ease,transform .2s ease;pointer-events:auto;',
        '}',
        '.toast.leaving{opacity:0;transform:translateY(6px)}',
        '.toast-text{flex:1 1 auto;min-width:0}',
        '.toast-action{',
        '  flex:0 0 auto;white-space:nowrap;font:inherit;font-weight:620;font-size:12px;',
        '  color:#cfe0ff;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.22);',
        '  border-radius:7px;padding:3px 9px;cursor:pointer;pointer-events:auto;',
        '}',
        '.toast-action:hover{background:rgba(255,255,255,.16)}'
      ].join('');
      shadow.appendChild(style);
      (document.body || document.documentElement).appendChild(host);
      toastState.host = host;
    }
    if (toastState.item && toastState.item.parentNode) toastState.item.parentNode.removeChild(toastState.item);
    clearToastTimers();
    var shadowRoot = toastState.host.shadowRoot;
    var item = document.createElement('div');
    item.className = 'toast';
    item.setAttribute('role', 'status');
    var label = document.createElement('span');
    label.className = 'toast-text';
    label.textContent = message;
    item.appendChild(label);
    item.appendChild(document.createTextNode(''));
    if (opts.action && typeof opts.action.run === 'function') {
      var actionButton = document.createElement('button');
      actionButton.type = 'button';
      actionButton.className = 'toast-action';
      actionButton.textContent = opts.action.label || 'OK';
      actionButton.addEventListener('click', function () {
        try {
          opts.action.run();
        } catch (err) { /* ignore */ }
        destroyToast();
      });
      item.appendChild(actionButton);
    }
    shadowRoot.appendChild(item);
    toastState.item = item;

    var duration = opts.duration || 3200;
    toastState.timer = window.setTimeout(function () {
      if (!item.isConnected) return;
      item.classList.add('leaving');
      var done = false;
      var finish = function () {
        if (done) return;
        done = true;
        item.removeEventListener('transitionend', finish);
        if (toastState.item === item) toastState.item = null;
        if (item.parentNode) item.parentNode.removeChild(item);
      };
      item.addEventListener('transitionend', finish);
      toastState.removeTimer = window.setTimeout(finish, 420);
    }, duration);
  }

  /* ------------------------------------------------------------ rect helpers */

  function viewportRect(element) {
    var rect = element.getBoundingClientRect();
    return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function cardPositionFor(rect) {
    var width = Math.min(392, window.innerWidth - 16);
    var height = Math.min(Math.round(window.innerHeight * 0.7), 560);
    var x = rect.right + 10;
    if (x + width > window.innerWidth - 8) {
      x = rect.left - width - 10;
      if (x < 8) x = clamp(rect.left, 8, Math.max(8, window.innerWidth - width - 8));
    }
    var y = clamp(rect.top - 6, 8, Math.max(8, window.innerHeight - height - 12));
    return { x: x, y: y };
  }

  function targetFromPoint(element) {
    if (!element) return null;
    var mark = element.nodeType === 1 ? element.closest(MARK_TAG) : (element.parentElement && element.parentElement.closest(MARK_TAG));
    return mark || null;
  }

  function annotationById(id) {
    for (var i = 0; i < state.annotations.length; i++) {
      if (state.annotations[i].id === id) return state.annotations[i];
    }
    return null;
  }

  /* ---------------------------------------------------- selection mark button */

  var SELECTION_CSS = [
    ':host { all: initial; display: block; }',
    '.selection-mark {',
    '  display: inline-flex; align-items: center; gap: 5px;',
    '  height: 28px; padding: 0 10px; flex-shrink: 0;',
    '  font: 12.5px/1 system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;',
    '  white-space: nowrap; color: #fff; background: #2f6fed;',
    '  border: 1px solid transparent; border-radius: 8px; cursor: pointer;',
    '  box-shadow: 0 6px 18px rgba(15, 23, 42, .3);',
    '}',
    '.selection-mark:hover { filter: brightness(1.06); }',
    '.selection-mark svg { width: 1em; height: 1em; flex-shrink: 0; }'
  ].join('');

  var selectionButton = { host: null, button: null, visible: false, checkTimer: 0, suppressUntil: 0 };

  function selectionButtonEnabled() {
    return !!(state.settings && state.settings.enabled && state.settings.selectionButton !== false);
  }

  /** Decorative inline SVG; built with DOM APIs so no markup is injected. */
  function createSelectionIcon() {
    try {
      if (typeof document.createElementNS !== 'function') return null;
      var ns = 'http://www.w3.org/2000/svg';
      var svg = document.createElementNS(ns, 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('fill', 'none');
      svg.setAttribute('stroke', 'currentColor');
      svg.setAttribute('stroke-width', '1.9');
      svg.setAttribute('stroke-linecap', 'round');
      svg.setAttribute('stroke-linejoin', 'round');
      svg.setAttribute('aria-hidden', 'true');
      var pathA = document.createElementNS(ns, 'path');
      pathA.setAttribute('d', 'M4 20l4.5-1 9-9-3.5-3.5-9 9z');
      var pathB = document.createElementNS(ns, 'path');
      pathB.setAttribute('d', 'M13 6.5L16.5 10');
      svg.appendChild(pathA);
      svg.appendChild(pathB);
      return svg;
    } catch (err) {
      return null;
    }
  }

  function ensureSelectionButton() {
    if (selectionButton.host && selectionButton.host.isConnected) return selectionButton;
    var host = document.createElement('pagegloss-ui');
    host.id = 'pagegloss-selection-host';
    // display:none inline, because the page's `pagegloss-ui { display:block }`
    // rule outranks both the UA [hidden] rule and :host styles.
    host.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483646;display:none;';
    var shadow = host.attachShadow({ mode: 'open' });
    var style = document.createElement('style');
    style.textContent = SELECTION_CSS;
    shadow.appendChild(style);
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'selection-mark';
    button.title = t('selectionMark');
    button.setAttribute('aria-label', t('selectionMark'));
    var icon = createSelectionIcon();
    if (icon) button.appendChild(icon);
    var label = document.createElement('span');
    label.className = 'selection-mark-label';
    label.textContent = t('selectionMark');
    button.appendChild(label);
    // mousedown is prevented so the selection survives the click.
    button.addEventListener('mousedown', function (event) { event.preventDefault(); });
    button.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      hideSelectionButton();
      var info = selectionInfo();
      if (!info || !info.text) {
        showToast(t('toastNoSelection'));
        return;
      }
      startMarking(info);
    });
    shadow.appendChild(button);
    (document.body || document.documentElement).appendChild(host);
    selectionButton.host = host;
    selectionButton.button = button;
    return selectionButton;
  }

  function hideSelectionButton() {
    selectionButton.visible = false;
    if (selectionButton.checkTimer) {
      window.clearTimeout(selectionButton.checkTimer);
      selectionButton.checkTimer = 0;
    }
    if (selectionButton.host) selectionButton.host.style.display = 'none';
  }

  /** Geometry of the current non-empty selection, or null. */
  function selectionAnchor() {
    var selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
    if (!String(selection.toString() || '').trim()) return null;
    var range = selection.getRangeAt(0);
    var node = range.startContainer;
    var element = node && node.nodeType === 1 ? node : (node ? node.parentElement : null);
    if (!element) return null;
    // Selections inside our own shadow roots must not spawn the page button.
    try {
      var root = element.getRootNode ? element.getRootNode() : null;
      if (root && root.host && root.host.tagName === 'PAGEGLOSS-UI') return null;
    } catch (err) { /* ignore */ }
    if (element.closest && (element.closest('pagegloss-ui') || element.closest(MARK_TAG))) return null;
    if (isEditableTarget(element)) return null;
    var rect = range.getBoundingClientRect ? range.getBoundingClientRect() : null;
    if ((!rect || (!rect.width && !rect.height)) && range.getClientRects) {
      var rects = range.getClientRects();
      if (rects && rects.length) rect = rects[rects.length - 1];
    }
    return { range: range, rect: rect || { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 } };
  }

  function updateSelectionButton() {
    selectionButton.checkTimer = 0;
    if (!selectionButtonEnabled()) {
      hideSelectionButton();
      return;
    }
    // Do not pop the button back right after a mark while the selection lives on.
    if (Date.now() < selectionButton.suppressUntil) {
      hideSelectionButton();
      return;
    }
    var anchor = selectionAnchor();
    if (!anchor) {
      hideSelectionButton();
      return;
    }
    var ui = ensureSelectionButton();
    if (!ui || !ui.host) return;
    var rect = anchor.rect;
    var width = ui.host.offsetWidth || 134;
    var height = ui.host.offsetHeight || 28;
    var x = rect.right + 100;
    if (x + width > window.innerWidth - 8) x = rect.left - 100 - width;
    x = clamp(x, 8, Math.max(8, window.innerWidth - width - 8));
    var y = clamp(rect.bottom + 8, 8, Math.max(8, window.innerHeight - height - 8));
    ui.host.style.left = Math.round(x) + 'px';
    ui.host.style.top = Math.round(y) + 'px';
    ui.host.style.display = 'block';
    selectionButton.visible = true;
  }

  function onSelectionChange() {
    if (!selectionButtonEnabled()) {
      hideSelectionButton();
      return;
    }
    var selection = window.getSelection();
    if (!selection || selection.isCollapsed || !String(selection.toString() || '').trim()) {
      hideSelectionButton();
      return;
    }
    if (selectionButton.checkTimer) window.clearTimeout(selectionButton.checkTimer);
    selectionButton.checkTimer = window.setTimeout(updateSelectionButton, 90);
  }

  function onSelectionMouseUp(event) {
    if (event && event.button !== 0) return;
    if (!selectionButtonEnabled()) return;
    if (selectionButton.checkTimer) window.clearTimeout(selectionButton.checkTimer);
    selectionButton.checkTimer = window.setTimeout(updateSelectionButton, 10);
  }

  /* --------------------------------------------------------- mark shortcut */

  var hotkeyCache = { spec: null, parsed: null };

  /** Parse 'Alt+Q', 'Ctrl+Shift+K' or 'Alt+KeyQ' into modifier + key parts. */
  function parseHotkey(spec) {
    var value = String(spec || '').trim();
    if (!value) return null;
    var parts = value.split('+');
    var parsed = { alt: false, ctrl: false, shift: false, meta: false, key: '', code: '' };
    var keyToken = '';
    for (var i = 0; i < parts.length; i++) {
      var part = parts[i].replace(/^\s+|\s+$/g, '');
      if (!part) continue;
      var lower = part.toLowerCase();
      if (lower === 'alt' || lower === 'option') parsed.alt = true;
      else if (lower === 'ctrl' || lower === 'control') parsed.ctrl = true;
      else if (lower === 'shift') parsed.shift = true;
      else if (lower === 'meta' || lower === 'cmd' || lower === 'command' || lower === 'win' || lower === 'super') parsed.meta = true;
      else keyToken = part;
    }
    if (!keyToken) return null;
    var token = keyToken.toLowerCase();
    var aliases = {
      space: 'Space', esc: 'Escape', escape: 'Escape', enter: 'Enter', return: 'Enter',
      tab: 'Tab', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
      del: 'Delete', delete: 'Delete', backspace: 'Backspace', plus: 'Equal', minus: 'Minus'
    };
    if (/^key[a-z]$/i.test(keyToken)) {
      parsed.code = 'Key' + keyToken.slice(3).toUpperCase();
      parsed.key = keyToken.slice(3).toLowerCase();
    } else if (/^digit\d$/i.test(keyToken)) {
      parsed.code = 'Digit' + keyToken.slice(5);
      parsed.key = keyToken.slice(5);
    } else if (/^f\d{1,2}$/i.test(keyToken)) {
      parsed.code = keyToken.toUpperCase();
    } else if (aliases[token]) {
      parsed.code = aliases[token];
    } else if (keyToken.length === 1) {
      parsed.key = token;
      if (/[a-z]/.test(token)) parsed.code = 'Key' + token.toUpperCase();
      else if (/[0-9]/.test(token)) parsed.code = 'Digit' + token;
    } else {
      parsed.code = keyToken;
    }
    return parsed;
  }

  function isEditableTarget(target) {
    var element = target && target.nodeType === 1 ? target : (target ? target.parentElement : null);
    if (!element) return false;
    if (element.isContentEditable) return true;
    if (!element.closest) return false;
    try {
      return !!element.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]');
    } catch (err) {
      return false;
    }
  }

  function matchesHotkey(spec, event) {
    if (hotkeyCache.spec !== spec) {
      hotkeyCache.spec = spec;
      hotkeyCache.parsed = parseHotkey(spec);
    }
    var parsed = hotkeyCache.parsed;
    if (!parsed) return false;
    if (!!event.altKey !== parsed.alt) return false;
    if (!!event.ctrlKey !== parsed.ctrl) return false;
    if (!!event.shiftKey !== parsed.shift) return false;
    if (!!event.metaKey !== parsed.meta) return false;
    var code = String(event.code || '').toLowerCase();
    var key = String(event.key || '').toLowerCase();
    if (parsed.code && code && code === parsed.code.toLowerCase()) return true;
    if (parsed.key && key && key === parsed.key) return true;
    return false;
  }

  function onMarkHotkey(event) {
    if (event.defaultPrevented) return;
    if (event.isComposing || event.keyCode === 229) return;
    var modifiers = ['Alt', 'Control', 'Shift', 'Meta', 'OS'];
    if (modifiers.indexOf(event.key) >= 0) return;
    if (!state.settings || !state.settings.enabled) return;
    var spec = state.settings.markHotkey || S.DEFAULT_SETTINGS.markHotkey;
    if (!matchesHotkey(spec, event)) return;
    var path = event.composedPath ? event.composedPath() : [];
    var target = path.length ? path[0] : event.target;
    if (isEditableTarget(target)) return;
    var element = target && target.nodeType === 1 ? target : (target ? target.parentElement : null);
    if (element && element.closest) {
      try {
        if (element.closest('pagegloss-ui')) return;
      } catch (err) { /* ignore */ }
    }
    event.preventDefault();
    hideSelectionButton();
    var info = selectionInfo();
    if (!info || !info.text) {
      showToast(t('toastHotkeyNoSelection'), { duration: 2200 });
      return;
    }
    startMarking(info);
  }

  /* --------------------------------------------------------- context capture */

  function topLevelElement(node) {
    if (!node) return document.body;
    var element = node.nodeType === 1 ? node : node.parentElement;
    if (!element) return document.body;
    while (element.parentElement && element.parentElement !== document.body) {
      element = element.parentElement;
    }
    return element;
  }

  function isDocumentLevel(element) {
    if (!element || element === document.body || element === document.documentElement) return true;
    var rect = element.getBoundingClientRect();
    var height = window.innerHeight || document.documentElement.clientHeight;
    if (rect.height >= height * 0.96) return true;
    var role = element.getAttribute && (element.getAttribute('role') || '');
    if (role === 'main' || role === 'article') return true;
    var tag = element.tagName;
    return tag === 'MAIN' || tag === 'ARTICLE' || tag === 'BODY' || tag === 'HTML';
  }

  function headingFor(element) {
    var current = M.closestBlock(element);
    var guard = 0;
    while (current && current !== document.body && guard < 8) {
      guard++;
      var previous = current.previousElementSibling;
      var hops = 0;
      while (previous && hops < 6) {
        hops++;
        if (/^H[1-6]$/.test(previous.tagName)) {
          var clean = String(previous.innerText || previous.textContent || '').replace(/\s+/g, ' ').trim();
          if (clean) return clean.slice(0, 140);
        }
        previous = previous.previousElementSibling;
      }
      current = current.parentElement ? M.closestBlock(current.parentElement) : null;
      if (current === element) break;
    }
    return '';
  }

  function sectionText(anchorElement, term) {
    var block = M.closestBlock(anchorElement);
    var parts = [];
    var container = block;
    // Walk up until we collected a reasonable amount of text.
    while (container && container !== document.body) {
      var text = String(container.innerText || container.textContent || '').replace(/\s+/g, ' ').trim();
      if (text.length >= 1400 || container.parentElement === document.body || isDocumentLevel(container.parentElement)) {
        parts.push(text);
        break;
      }
      parts.push(text);
      container = container.parentElement;
    }
    var heading = headingFor(anchorElement);
    if (heading && parts.length) parts.unshift(heading + '\n');
    var joined = parts.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    return S.truncate(joined, 4000);
  }

  function keywordsFrom(text) {
    var words = String(text || '').toLowerCase().match(/[\p{L}\p{N}'’-]{3,}/gu) || [];
    var seen = {};
    var out = [];
    for (var i = 0; i < words.length && out.length < 40; i++) {
      var word = words[i];
      if (seen[word]) continue;
      seen[word] = 1;
      out.push(word);
    }
    return out;
  }

  function keyExcerpts(term) {
    var paragraphs = document.querySelectorAll('p, li, h1, h2, h3, blockquote, dd, td');
    var keywords = keywordsFrom(term);
    var scored = [];
    for (var i = 0; i < paragraphs.length; i++) {
      var element = paragraphs[i];
      if (element.closest('pagegloss-mark, pagegloss-ui')) continue;
      var text = String(element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim();
      if (text.length < 40) continue;
      var lower = text.toLowerCase();
      var score = 0;
      for (var k = 0; k < keywords.length; k++) {
        var keyword = keywords[k];
        var at = lower.indexOf(keyword);
        while (at >= 0) {
          score += 1;
          at = lower.indexOf(keyword, at + keyword.length);
        }
      }
      if (score > 0) scored.push({ text: text, score: score, order: i });
    }
    scored.sort(function (a, b) { return b.score - a.score || a.order - b.order; });
    var picked = [];
    var total = 0;
    for (var s = 0; s < scored.length && picked.length < 12; s++) {
      picked.push(scored[s].text);
      total += scored[s].text.length;
      if (total > 6000) break;
    }
    if (!picked.length) {
      var fallback = document.querySelectorAll('p, li');
      for (var f = 0; f < fallback.length && picked.length < 6; f++) {
        var fallbackText = String(fallback[f].innerText || fallback[f].textContent || '').replace(/\s+/g, ' ').trim();
        if (fallbackText.length >= 60) picked.push(fallbackText);
      }
    }
    return S.truncate(picked.join('\n\n'), 6000);
  }

  function buildContext(term, anchorElement, sentence) {
    var settings = state.settings || {};
    var mode = settings.contextMode || S.DEFAULT_CONTEXT_MODE;
    var limit = settings.maxContextChars || S.MAX_PAGE_CHARS;
    var context = {
      mode: mode,
      title: document.title || '',
      url: location.href,
      term: term,
      sentence: sentence || '',
      truncated: false
    };
    if (mode === 'sentence') {
      var block = M.closestBlock(anchorElement);
      var previous = block && block.previousElementSibling ? String(block.previousElementSibling.innerText || '').replace(/\s+/g, ' ').trim() : '';
      var next = block && block.nextElementSibling ? String(block.nextElementSibling.innerText || '').replace(/\s+/g, ' ').trim() : '';
      var own = block ? String(block.innerText || block.textContent || '').replace(/\s+/g, ' ').trim() : '';
      context.section = S.truncate([previous, own, next].filter(Boolean).join('\n\n'), 2000);
      context.pageText = '';
      return context;
    }
    if (mode === 'section') {
      context.section = sectionText(anchorElement, term);
      context.excerpts = keyExcerpts(term);
      context.pageText = '';
      if ((context.section.length + context.excerpts.length) > limit) {
        context.excerpts = S.truncate(context.excerpts, Math.max(400, limit - context.section.length));
        context.truncated = true;
      }
      return context;
    }
    var full = M.pageText(0);
    if (full.length > limit) {
      var head = full.slice(0, Math.round(limit * 0.62));
      var tail = full.slice(full.length - Math.round(limit * 0.34));
      full = head + '\n\n…（页面中部内容已省略）…\n\n' + tail;
      context.truncated = true;
      showToast(t('errPageTooLong'), { duration: 4200 });
    }
    context.pageText = full;
    context.section = S.truncate(sectionText(anchorElement, term), 2400);
    return context;
  }

  /* ------------------------------------------------------------------ marking */

  function selectionInfo() {
    var selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) {
      if (state.pendingMenu && Date.now() - state.pendingMenu.at < 25000) return state.pendingMenu.info;
      return null;
    }
    var text = M.normalizeNeedle(selection.toString());
    if (!text) return null;
    var range = selection.getRangeAt(0).cloneRange();
    var element = topLevelElement(range.startContainer);
    var sentence = M.sentenceAround(range.startContainer.parentElement || range.startContainer, text);
    return {
      text: S.truncate(text, 300),
      range: range,
      element: element,
      anchorElement: range.startContainer.parentElement || (range.startContainer.nodeType === 1 ? range.startContainer : document.body),
      sentence: sentence,
      at: Date.now()
    };
  }

  /**
   * Match one needle against the page map.
   *
   * The default "smart" mode treats word-like needles (letters, digits,
   * apostrophes; no CJK) as whole words first, so selecting "art" no longer
   * lights up every "start", "chart" or "matters". If nothing stand-alone
   * exists it falls back to the loose substring hits, so the feature still does
   * something useful. "loose" keeps the old greedy behaviour, "strict" never
   * falls back. CJK has no whitespace boundaries and always matches substrings.
   */
  function matchNeedle(map, needle, limit, options) {
    var opts = options || {};
    var mode = (state.settings && state.settings.matchMode) || S.DEFAULT_MATCH_MODE;
    if (mode !== 'smart' && mode !== 'loose' && mode !== 'strict') mode = 'smart';
    var wordLike = S.isWordLikeNeedle(needle);
    if (opts.allowLoose) {
      // One-shot substring match confirmed by the user; the global mode and the
      // stored settings are untouched.
      return { matches: M.findMatches(map, needle, { limit: limit }), mode: 'substring', strict: true };
    }
    if (mode === 'loose' || !wordLike) {
      // Substring matching: loose by request, or the only sensible option for CJK.
      return { matches: M.findMatches(map, needle, { limit: limit }), mode: 'substring', strict: true };
    }
    var strictMatches = M.findMatches(map, needle, { limit: limit, wholeWord: true });
    if (strictMatches.length || mode === 'strict') {
      return { matches: strictMatches, mode: 'whole-word', strict: true };
    }
    return { matches: M.findMatches(map, needle, { limit: limit }), mode: 'substring', strict: false };
  }

  function collectRangesForAnnotation(annotation, options) {
    var opts = options || {};
    var map = M.buildTextMap(document.body);
    var needles = [{ text: annotation.text, sentenceScope: false, secondary: false }];
    if (state.settings && state.settings.markSentenceTokens && /[\s。！？!?；;]/.test(annotation.text)) {
      var tokens = M.tokenize(annotation.text, M.stopwordTable());
      for (var i = 0; i < tokens.length; i++) {
        needles.push({ text: tokens[i], sentenceScope: false, secondary: true });
      }
    }
    var ranges = [];
    var truncated = false;
    var looseOnly = false;
    for (var n = 0; n < needles.length; n++) {
      var needle = needles[n];
      var budget = Math.max(0, S.MAX_MARKS_PER_ANNOTATION - ranges.length);
      if (budget === 0) {
        truncated = true;
        break;
      }
      var result = matchNeedle(map, needle.text, budget, { strict: opts.strict, allowLoose: opts.allowLoose });
      if (result.strict === false && !result.matches.length) looseOnly = true;
      if (result.matches.length >= budget) truncated = true;
      for (var m = 0; m < result.matches.length; m++) {
        ranges.push({
          start: result.matches[m].start,
          end: result.matches[m].end,
          annotationId: annotation.id,
          color: annotation.color,
          secondary: !!needle.secondary
        });
      }
    }
    return { map: map, ranges: M.mergeRanges(ranges), truncated: truncated, looseOnly: looseOnly };
  }

  /**
   * Anchors are stored as { path, start, end, text } so a reload can re-locate
   * them inside the same container even if the surrounding markup changed.
   */
  function anchorsForRanges(map, ranges) {
    var anchors = [];
    for (var i = 0; i < ranges.length; i++) {
      var anchor = M.anchorForRange(map, ranges[i]);
      if (anchor) {
        anchor.secondary = !!ranges[i].secondary;
        anchors.push(anchor);
      }
    }
    return anchors;
  }

  function markAnnotation(annotation, options) {
    var opts = options || {};
    var built = collectRangesForAnnotation(annotation, opts);
    var created = M.applyRanges(built.map, built.ranges);
    annotation.marks = created;
    annotation.anchors = created > 0 ? anchorsForRanges(built.map, built.ranges) : [];
    return { created: created, truncated: built.truncated, looseOnly: built.looseOnly };
  }

  /* ----------------------------------------------------------------- the note */

  function noteFor(annotationId) {
    return annotationById(annotationId);
  }

  function scheduleThreadSave() {
    if (!state.note) return;
    window.clearTimeout(state.note.saveTimer);
    state.note.saveTimer = window.setTimeout(function () { persistThread(); }, 400);
  }

  function persistThread() {
    if (!state.note || !state.page) return;
    var id = state.note.annotationId;
    var thread = state.threads[id] || [];
    Store.setThread(state.page, id, thread);
    Store.pruneIfTooLarge(state.page).then(function (page) {
      return Store.savePage(page);
    }).catch(function () { /* storage full - ignore */ });
  }

  function openNote(annotation, options) {
    var opts = options || {};
    var mark = opts.mark || (annotation.id ? document.querySelector(MARK_TAG + '[data-pg-id="' + S.cssEscape(annotation.id) + '"]') : null);
    if (mark && !annotation.anchorElement) annotation.anchorElement = mark;
    var rect = mark ? viewportRect(mark) : { left: window.innerWidth / 2, top: window.innerHeight / 3, right: window.innerWidth / 2, bottom: window.innerHeight / 3, width: 0, height: 0 };
    var position = cardPositionFor(rect);

    if (state.note && state.note.annotationId === annotation.id) {
      if (typeof state.note.card.setNote === 'function') state.note.card.setNote(annotation.note || '');
      if (opts.pin) {
        state.note.card.setPinned(true);
        state.note.card.setPosition(position.x, position.y);
      }
      // Only a card opened by "mark and explain" becomes temporarily resident.
      if (opts.sticky) state.note.sticky = true;
      state.note.card.focus();
      return state.note.card;
    }
    closeNote(false);

    var card = Card.create({
      i18n: i18n,
      term: annotation.text,
      color: annotation.color,
      position: position,
      note: typeof annotation.note === 'string' ? annotation.note : '',
      textColor: M.contrastTextColor ? M.contrastTextColor(annotation.color) : '',
      markCount: annotation.id ? M.countMarks(annotation.id) : 0
    });
    (document.body || document.documentElement).appendChild(card.host);

    var thread = state.threads[annotation.id] || [];
    for (var i = 0; i < thread.length; i++) {
      if (thread[i].role === 'user') card.addUserMessage(thread[i].content);
      else card.addAssistantMarkdown(thread[i].content);
    }
    if (annotation.explanation && !thread.length) {
      card.addAssistantMarkdown(annotation.explanation);
      thread.push({ role: 'assistant', content: annotation.explanation, at: Date.now() });
      state.threads[annotation.id] = thread;
    }

    // The reader should start at the top of a restored thread. Streaming keeps
    // the card's own auto-follow behaviour; we do not override it per token.
    if (typeof card.scrollToTop === 'function') {
      try {
        card.scrollToTop();
      } catch (err) { /* older card builds */ }
    }

    state.note = {
      annotationId: annotation.id,
      card: card,
      mark: mark || null,
      saveTimer: 0,
      requestSeq: 0,
      sticky: !!opts.sticky
    };

    if (!thread.length) {
      if (opts.auto && !annotation.explanation) {
        requestExplanation(annotation, card, {});
      } else {
        card.addNoticeAction(t('cardNoExplanation'), t('cardExplainNow'), function () {
          requestExplanation(annotation, card, {});
        });
      }
    }

    card.setHandlers({
      onAsk: function (question, handlers) {
        return askQuestion(annotation, card, question, handlers);
      },
      onAnswer: function (question, answer) {
        var list = state.threads[annotation.id] || [];
        list.push({ role: 'user', content: question, at: Date.now() });
        list.push({ role: 'assistant', content: answer, at: Date.now() });
        if (list.length > S.MAX_CHAT_MESSAGES) list = list.slice(list.length - S.MAX_CHAT_MESSAGES);
        state.threads[annotation.id] = list;
        scheduleThreadSave();
      },
      onError: function () {
        scheduleThreadSave();
      },
      onUnmarkOne: function () {
        // Prefer the mark the card was opened from; fall back to the first one.
        var targetMark = (state.note && state.note.mark && state.note.mark.isConnected) ? state.note.mark : null;
        if (!targetMark) {
          targetMark = document.querySelector(MARK_TAG + '[data-pg-id="' + S.cssEscape(annotation.id) + '"]');
        }
        if (!targetMark) {
          showToast(t('toastRemovedOne'));
          return;
        }
        removeOccurrence(targetMark);
      },
      onUnmarkAll: function () {
        removeTerm(annotation.id);
      },
      onTogglePin: function () {
        card.setPinned(!card.isPinned());
        if (!card.isPinned()) scheduleHide(320);
      },
      onNoteChange: function (text) {
        return persistNote(annotation, text);
      },
      onFullscreen: function () {
        openFullpage(annotation);
      },
      onPointerEnter: function () {
        window.clearTimeout(state.hideTimer);
      },
      onPointerLeave: function () {
        scheduleHide(260);
      },
      onClose: function () { closeNote(true); },
      onToast: function (message) { showToast(message, { duration: 1800 }); }
    });

    if (opts.pin) card.setPinned(true);
    if (opts.focus) card.focus();
    return card;
  }

  function closeNote(userAction) {
    if (!state.note) return;
    var note = state.note;
    note.sticky = false;
    state.note = null;
    window.clearTimeout(note.saveTimer);
    try { note.card.abort(); } catch (err) { /* already gone */ }
    if (typeof note.card.close === 'function') {
      try {
        note.card.close();
      } catch (err) {
        note.card.destroy();
      }
    } else {
      // Older card builds only know destroy().
      note.card.destroy();
    }
    if (userAction) persistThreadFrom(note.annotationId);
  }

  function persistThreadFrom(annotationId) {
    if (!state.page) return;
    Store.setThread(state.page, annotationId, state.threads[annotationId] || []);
    Store.pruneIfTooLarge(state.page).then(function (page) {
      return Store.savePage(page);
    }).catch(function () { /* ignore */ });
  }

  var pageSaveTimer = 0;

  /** Debounced page write; resolves with true only after the write succeeded. */
  function savePageDebounced(delay) {
    if (!state.page) return Promise.resolve(false);
    if (pageSaveTimer) window.clearTimeout(pageSaveTimer);
    return new Promise(function (resolve) {
      pageSaveTimer = window.setTimeout(function () {
        pageSaveTimer = 0;
        if (!state.page) {
          resolve(false);
          return;
        }
        Store.savePage(state.page).then(function () {
          resolve(true);
        }).catch(function () {
          resolve(false);
        });
      }, delay == null ? 220 : delay);
    });
  }

  /** Persist the free-form note of one annotation (called by the card). */
  function persistNote(annotation, text) {
    var value = String(text == null ? '' : text);
    annotation.note = value;
    annotation.updatedAt = Date.now();
    if (!state.page) return Promise.resolve(false);
    var stored = null;
    try {
      stored = Store.setNote(state.page, annotation.id, value);
    } catch (err) {
      stored = null;
    }
    if (!stored) return Promise.resolve(false);
    var runtime = annotationById(annotation.id);
    if (runtime) {
      runtime.note = value;
      runtime.updatedAt = annotation.updatedAt;
      runtime.noteUpdatedAt = Date.now();
    }
    return savePageDebounced(220);
  }

  /** Ask the background worker to open the full-page reading view. */
  function openFullpage(annotation) {
    var annotationId = annotation && annotation.id ? annotation.id : '';
    var failed = function () { showToast(t('cardFullscreenFailed'), { duration: 3200 }); };
    if (!annotationId) {
      failed();
      return;
    }
    try {
      if (!chrome.runtime || typeof chrome.runtime.sendMessage !== 'function') {
        failed();
        return;
      }
      chrome.runtime.sendMessage({
        type: 'pg:openFullpage',
        urlKey: state.urlKey,
        annotationId: annotationId
      }, function (response) {
        var error = chrome.runtime.lastError;
        if (error || (response && response.ok === false)) failed();
      });
    } catch (err) {
      failed();
    }
  }

  /** True while the reader is typing a follow-up question or a note. */
  function cardIsTyping(card) {
    return !!(card && typeof card.isTyping === 'function' && card.isTyping());
  }

  /** A freshly marked card stays open until the reader dismisses it explicitly. */
  function noteIsSticky() {
    return !!(state.note && state.note.sticky === true);
  }

  function scheduleHide(delay) {
    window.clearTimeout(state.hideTimer);
    state.hideTimer = window.setTimeout(function () {
      if (!state.note) return;
      var card = state.note.card;
      if (card.isPinned()) return;
      // Never yank the card away while the reader is typing a question or note.
      if (cardIsTyping(card)) return;
      // A card opened right after marking is temporarily resident.
      if (noteIsSticky()) return;
      if (isPointerInsideCard() || isPointerOnMark()) return;
      closeNote(true);
    }, delay == null ? 260 : delay);
  }

  function isPointerInsideCard() {
    if (!state.note || !state.note.card) return false;
    var host = state.note.card.host;
    if (!host || !host.isConnected) return false;
    return typeof host.matches === 'function' ? host.matches(':hover') : false;
  }

  var lastPointer = { x: 0, y: 0 };

  function isPointerOnMark() {
    var element = document.elementFromPoint(clamp(lastPointer.x, 0, window.innerWidth - 1), clamp(lastPointer.y, 0, window.innerHeight - 1));
    return !!targetFromPoint(element);
  }

  /* ------------------------------------------------------------- LLM plumbing */

  function requestExplanation(annotation, card, options) {
    var config = llmConfigState();
    if (config.pending) {
      // Settings are still loading: wait instead of claiming a missing config.
      var pendingHandle = { abort: function () {} };
      whenSettings().then(function () {
        if (!state.settings) return;
        // The card may have been closed while the settings were loading.
        if (!state.note || state.note.card !== card) return;
        var next = requestExplanation(annotation, card, options);
        if (next && typeof next.abort === 'function') pendingHandle.abort = next.abort;
      });
      return pendingHandle;
    }
    if (!config.ready) {
      notifyNotConfigured(config, card);
      return null;
    }
    var previous = card.addState ? card.addState(t('cardThinking')) : null;
    var answerText = '';
    var done = false;

    return connectLlm({
      kind: 'explain',
      term: annotation.text,
      context: buildContext(annotation.text, annotation.anchorElement || document.body, annotation.sentence || ''),
      history: []
    }, {
      onReasoning: function (chunk) {
        if (previous) {
          card.removeState(previous);
          previous = null;
        }
        if (card.appendReasoning) card.appendReasoning(chunk);
      },
      onToken: function (chunk) {
        if (previous) {
          card.removeState(previous);
          previous = null;
        }
        if (!answerText) {
          card.addAssistantMarkdown('');
        }
        answerText += chunk;
        var bubbles = card.card.querySelectorAll('.md');
        var last = bubbles[bubbles.length - 1];
        if (last) {
          last.innerHTML = Card.renderMarkdown(answerText);
          last.dataset.raw = answerText;
          card.scrollToEnd();
        }
      },
      onDone: function (full, meta) {
        if (done) return;
        done = true;
        if (previous) {
          card.removeState(previous);
          previous = null;
        }
        if (meta && meta.reasoningOnly) {
          // The model spent its budget on the chain of thought: keep what it
          // produced and explain how to get a real answer.
          card.addNotice(t('cardReasoningOnly'));
        }
        var text = full || answerText;
        if (!text) {
          card.addError(t('errEmpty'));
          return;
        }
        answerText = text;
        var bubbles = card.card.querySelectorAll('.md');
        var last = bubbles[bubbles.length - 1];
        if (last) {
          last.innerHTML = Card.renderMarkdown(answerText);
          last.dataset.raw = answerText;
        } else {
          card.addAssistantMarkdown(answerText);
        }
        annotation.explanation = answerText;
        state.threads[annotation.id] = [{ role: 'assistant', content: answerText, at: Date.now() }];
        var target = annotationById(annotation.id);
        if (target) target.explanation = answerText;
        if (state.page) {
          Store.setThread(state.page, annotation.id, state.threads[annotation.id]);
          Store.savePage(state.page).catch(function () { /* ignore */ });
        }
      },
      onError: function (message) {
        if (done) return;
        done = true;
        if (previous) {
          card.removeState(previous);
          previous = null;
        }
        card.addError(message, function () { requestExplanation(annotation, card); });
        showToast(t('toastExplainFailed'), { duration: 3200 });
      }
    });
    return handle;
  }

  function askQuestion(annotation, card, question, handlers) {
    var requestHandlers = handlers || {};
    if (card && card.appendReasoning && !requestHandlers.onReasoning) {
      requestHandlers.onReasoning = function (chunk) { card.appendReasoning(chunk); };
    }
    var config = llmConfigState();
    if (config.pending) {
      // The follow-up was typed before the settings finished loading.
      var aborted = false;
      var current = null;
      whenSettings().then(function () {
        if (aborted) return;
        var next = llmConfigState();
        if (next.pending) return;
        if (!next.ready) {
          notifyNotConfigured(next, null);
          if (typeof requestHandlers.onError === 'function') requestHandlers.onError(next.message);
          return;
        }
        current = sendAsk(annotation, question, requestHandlers);
      });
      return {
        abort: function () {
          aborted = true;
          if (current && typeof current.abort === 'function') current.abort();
        }
      };
    }
    if (!config.ready) {
      notifyNotConfigured(config, null);
      if (typeof requestHandlers.onError === 'function') requestHandlers.onError(config.message);
      return { abort: function () {} };
    }
    return sendAsk(annotation, question, requestHandlers);
  }

  function sendAsk(annotation, question, handlers) {
    var history = (state.threads[annotation.id] || []).filter(function (item) {
      return item.role === 'user' || item.role === 'assistant';
    });
    return connectLlm({
      kind: 'ask',
      term: annotation.text,
      question: question,
      context: buildContext(annotation.text, annotation.anchorElement || document.body, annotation.sentence || ''),
      history: history
    }, handlers);
  }

  function connectLlm(payload, handlers) {
    var aborted = false;
    var port;
    try {
      port = chrome.runtime.connect({ name: 'pagegloss-llm' });
    } catch (err) {
      handlers.onError(t('errUnknown'));
      return { abort: function () {} };
    }
    var settled = false;

    function finishError(message) {
      if (settled || aborted) return;
      settled = true;
      handlers.onError(message);
      try { port.disconnect(); } catch (err) { /* ignore */ }
    }

    port.onMessage.addListener(function (message) {
      if (!message || typeof message !== 'object') return;
      if (message.type === 'token') {
        if (aborted) return;
        handlers.onToken(message.delta || '');
        return;
      }
      if (message.type === 'reasoning') {
        if (aborted) return;
        if (handlers.onReasoning) handlers.onReasoning(message.delta || '');
        return;
      }
      if (message.type === 'done') {
        if (aborted) return;
        settled = true;
        handlers.onDone(message.text || '', message);
        try { port.disconnect(); } catch (err) { /* ignore */ }
        return;
      }
      if (message.type === 'error') {
        finishError(localizedError(message));
      }
    });
    port.onDisconnect.addListener(function () {
      if (settled || aborted) return;
      settled = true;
      var error = chrome.runtime.lastError;
      handlers.onError(error ? error.message : t('errUnknown'));
    });

    try {
      port.postMessage({
        type: 'llm:start',
        payload: payload
      });
    } catch (err) {
      finishError(String(err && err.message ? err.message : err));
    }

    return {
      abort: function () {
        aborted = true;
        try {
          port.postMessage({ type: 'llm:abort' });
        } catch (err) { /* ignore */ }
        try { port.disconnect(); } catch (err) { /* ignore */ }
      }
    };
  }

  /** Turn the machine readable empty-answer reason into a sentence. */
  function emptyAnswerText(detail) {
    var raw = String(detail || '');
    var suffix = raw ? t('errEmptyDetail', { s: raw }) : '';
    if (raw.indexOf('reasoning_only_length') >= 0) return t('errEmptyReasoningLength');
    if (raw.indexOf('reasoning_only') >= 0) return t('errEmptyReasoning');
    var finish = /finish_reason=([a-z_]+)/i.exec(raw);
    if (finish) {
      var code = finish[1].toLowerCase();
      if (code === 'length') return t('errEmptyFinishLength') + suffix;
      if (code === 'content_filter') return t('errEmptyFinishFilter') + suffix;
    }
    if (raw.indexOf('keys=') >= 0) return t('errEmptyShape') + suffix;
    return t('errEmpty') + suffix;
  }

  function localizedError(message) {
    if (message.code === 'no-config') return t('errNoConfig');
    if (message.code === 'no-key') return t('errNoKey');
    if (message.code === 'permission') return t('errPermission');
    if (message.code === 'http') {
      var status = message.status || 0;
      var hint = '';
      if (status === 401 || status === 403) hint = t('errAuth');
      else if (status === 404) hint = t('errEndpoint404');
      else if (status === 429) hint = t('errRateLimited');
      else if (status >= 500) hint = t('errServer');
      var detail = message.detail ? String(message.detail) : '';
      return t('errHttp', { n: status, s: detail || hint }) + (detail && hint ? ' ' + hint : '');
    }
    if (message.code === 'timeout') return t('errTimeout', { n: Math.round((message.timeoutMs || 0) / 1000) });
    if (message.code === 'network') return t('errNetwork', { s: message.detail || '' });
    if (message.code === 'empty') return emptyAnswerText(message.detail);
    if (message.code === 'aborted') return t('errAborted');
    return message.detail || t('errUnknown');
  }

  /* ------------------------------------------------------------- menu actions */

  function startMarking(info) {
    var text = S.truncate(M.normalizeNeedle(info.text), 300);
    selectionButton.suppressUntil = Date.now() + 600;
    hideSelectionButton();
    if (!text) {
      showToast(t('toastNoSelection'));
      return;
    }
    var existing = state.annotations.find(function (item) {
      return item.text.toLowerCase() === text.toLowerCase();
    });
    if (existing) {
      showToast(t('toastAlready'));
      var mark = document.querySelector(MARK_TAG + '[data-pg-id="' + S.cssEscape(existing.id) + '"]');
      openNote(existing, { mark: mark, pin: false, auto: false });
      return;
    }
    // smart mode no longer silently falls back to substring matching: when the
    // text only appears inside longer words, ask once and let the answer apply
    // to this marking only (the global mode is left alone).
    var allowLoose = !!info.allowLoose;
    var markMode = (state.settings && state.settings.matchMode) || S.DEFAULT_MATCH_MODE;
    if (!allowLoose && markMode === 'smart' && S.isWordLikeNeedle(text)) {
      var probe = M.buildTextMap(document.body);
      var strictHits = M.findMatches(probe, text, { wholeWord: true, limit: 1 });
      if (!strictHits.length) {
        var looseHits = M.findMatches(probe, text, { limit: 1 });
        if (looseHits.length) {
          showToast(t('toastLooseAsk'), {
            duration: 8000,
            action: {
              label: t('toastLooseUse'),
              run: function () {
                startMarking(Object.assign({}, info, { allowLoose: true }));
              }
            }
          });
          return null;
        }
      }
    }
    var annotation = {
      id: S.uuid(),
      text: text,
      color: M.pickColor(text.toLowerCase()),
      sentence: info.sentence || '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      note: '',
      marks: 0,
      anchors: [],
      explanation: '',
      looseMatch: allowLoose
    };
    annotation.anchorElement = info.anchorElement;
    annotation.sentence = info.sentence || M.sentenceAround(info.anchorElement, text);
    var result = markAnnotation(annotation, { wholeSentence: false, allowLoose: allowLoose });
    if (!result.created) {
      showToast(t('toastNotFound'), { duration: 3600 });
      return;
    }
    state.annotations.push(annotation);
    annotation.updatedAt = Date.now();
    if (state.page) {
      Store.upsertAnnotation(state.page, stripRuntime(annotation));
      // A successful mark counts as an update of the annotation.
      Store.touchAnnotation(state.page, annotation.id);
    }

    var config = llmConfigState();
    if (!config.ready && !config.pending) {
      showToast(t('toastMarkedNoLlm', { n: result.created }), { duration: 4200 });
      saveAnnotationsDebounced();
      // Still open the card so the notice, the settings shortcut and the retry
      // button are one click away. It is NOT pinned: only the pin button pins.
      // It stays resident until dismissed because the reader just marked text.
      var pending = openNote(annotation, { pin: false, auto: false, sticky: true });
      notifyNotConfigured(config, pending);
      return pending;
    }
    if (result.truncated) {
      showToast(t('toastLimit', { n: S.MAX_MARKS_PER_ANNOTATION }), { duration: 4000 });
    } else if (result.looseOnly) {
      showToast(t('toastMarkedLoose', { n: result.created }), { duration: 4400 });
    } else {
      showToast(t('toastMarked', { n: result.created }));
    }
    // Marking never pins the card; the pin button is the only way to pin.
    // It is temporarily resident (sticky) so scrolling cannot dismiss it.
    var card = openNote(annotation, { pin: false, auto: true, sticky: true });
    saveAnnotationsDebounced();
    return card;
  }

  function stripRuntime(annotation) {
    var copy = {};
    Object.keys(annotation).forEach(function (key) {
      if (key === 'anchorElement') return;
      copy[key] = annotation[key];
    });
    return copy;
  }

  var saveTimer = 0;
  function saveAnnotationsDebounced() {
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(function () {
      if (!state.page) return;
      state.page.annotations = state.annotations.map(stripRuntime);
      Store.pruneIfTooLarge(state.page).then(function (page) {
        return Store.savePage(page);
      }).catch(function () { /* ignore */ });
    }, 300);
  }

  function removeOccurrence(mark) {
    if (!mark) return;
    var id = mark.getAttribute('data-pg-id');
    var annotation = annotationById(id);
    if (!annotation) return;
    var container = state.page || { urlKey: state.urlKey, annotations: [], chats: {} };
    var anchor = findAnchorForMark(mark, annotation);
    var outcome = Store.removeOccurrence(container, id, anchor);
    if (state.page) state.page = container;
    M.unwrapMark(mark);
    if (outcome && outcome.removedAll) {
      state.annotations = state.annotations.filter(function (item) { return item.id !== id; });
      delete state.threads[id];
      if (state.note && state.note.annotationId === id) closeNote(true);
      showToast(t('toastRemovedTerm', { s: S.truncate(annotation.text, 40) }));
    } else {
      annotation.marks = M.countMarks(id);
      showToast(t('toastRemovedOne'));
    }
    saveAnnotationsDebounced();
  }

  function findAnchorForMark(mark, annotation) {
    var anchors = Store.liveAnchors(annotation);
    if (!anchors.length) return null;
    for (var i = 0; i < anchors.length; i++) {
      var container = M.elementByPath(anchors[i].path);
      if (container && container.contains(mark)) return anchors[i];
    }
    return anchors[0];
  }

  function removeTerm(annotationId) {
    var annotation = annotationById(annotationId);
    if (!annotation) return;
    M.unwrapAnnotations([annotationId]);
    state.annotations = state.annotations.filter(function (item) { return item.id !== annotationId; });
    delete state.threads[annotationId];
    if (state.note && state.note.annotationId === annotationId) closeNote(true);
    if (state.page) Store.removeAnnotationFromPage(state.page, annotationId);
    showToast(t('toastRemovedTerm', { s: S.truncate(annotation.text, 40) }));
    saveAnnotationsDebounced();
  }

  /**
   * Ask before wiping the page. The card module renders the custom dialog in
   * its own shadow root so it matches the card style; native window.confirm is
   * only a fallback for contexts where the card UI is unavailable (tests,
   * stubbed builds).
   */
  function requestClearPage() {
    var count = state.annotations.length;
    var labels = {
      title: t('confirmClearTitle'),
      body: t('confirmClearBody', { n: count }),
      cancel: t('confirmCancel'),
      ok: t('confirmClearOk')
    };
    if (Card && typeof Card.confirm === 'function') {
      try {
        return Promise.resolve(Card.confirm(labels)).catch(function () { return false; });
      } catch (err) {
        // fall through to the native dialog below
      }
    }
    try {
      if (typeof window.confirm === 'function') {
        return Promise.resolve(!!window.confirm(labels.title + '\n' + labels.body));
      }
    } catch (err) { /* ignore */ }
    // No dialog surface at all: do not block the caller forever.
    return Promise.resolve(true);
  }

  /** Clear every annotation of this page, without asking. */
  function clearPageNow() {
    // Cancel pending debounced writes first: they would otherwise recreate the
    // storage key right after Store.clearPage() removed it.
    if (saveTimer) {
      window.clearTimeout(saveTimer);
      saveTimer = 0;
    }
    if (pageSaveTimer) {
      window.clearTimeout(pageSaveTimer);
      pageSaveTimer = 0;
    }
    M.unwrapAnnotations(null);
    state.annotations = [];
    state.threads = {};
    if (state.page) {
      state.page.annotations = [];
      state.page.chats = {};
    }
    closeNote(false);
    return Store.clearPage(state.urlKey).then(function () {
      showToast(t('toastCleared'));
      return true;
    }).catch(function () {
      showToast(t('toastCleared'));
      return true;
    });
  }

  /** Public clear action: always goes through the in-page confirmation. */
  function clearPage() {
    return requestClearPage().then(function (confirmed) {
      if (!confirmed) return false;
      return clearPageNow();
    });
  }

  /* ------------------------------------------------------------------ restore */

  function isWordChar(ch) {
    return !!ch && /[\p{L}\p{N}_]/u.test(ch);
  }

  /** True when [start, end) is delimited by non-word characters on both sides. */
  function isWholeWordRange(raw, start, end) {
    var before = start > 0 ? raw.charAt(start - 1) : '';
    var after = end < raw.length ? raw.charAt(end) : '';
    return !(isWordChar(before) && isWordChar(raw.charAt(start))) &&
      !(isWordChar(after) && isWordChar(raw.charAt(end - 1)));
  }

  function restorePage() {
    if (!state.page || !state.page.annotations.length) return;
    state.annotations = state.page.annotations.map(function (item) {
      var annotation = stripRuntime(item);
      annotation.anchors = Array.isArray(item.anchors) ? item.anchors : [];
      return annotation;
    });
    state.threads = {};
    Object.keys(state.page.chats || {}).forEach(function (id) {
      state.threads[id] = state.page.chats[id].slice();
    });

    // Remember which annotations were anchored or marked before the re-anchor
    // pass below may clear the runtime anchors of text that no longer exists.
    previouslyMarked = {};
    state.annotations.forEach(function (annotation) {
      var anchors = Array.isArray(annotation.anchors) ? annotation.anchors : [];
      if (anchors.length || Number(annotation.marks) > 0) previouslyMarked[annotation.id] = true;
    });

    // One text map serves the whole restore pass. Each annotation is verified
    // against the current page text before it is drawn again: a page whose
    // content changed must not keep highlighting text that is no longer there,
    // otherwise the marks sit on unrelated words and contradict their notes.
    var pageMap = M.buildTextMap(document.body);
    state.annotations.forEach(function (annotation) {
      var needle = M.normalizeNeedle(annotation.text);
      var ranges = M.rangesFromAnchors(annotation).slice(0, S.MAX_MARKS_PER_ANNOTATION);
      var offsets = ranges.length
        ? M.offsetsForRanges(pageMap, ranges, {
          annotationId: annotation.id,
          color: annotation.color,
          secondary: false
        })
        : [];
      // Keep only the ranges whose current text is still the marked text. Some
      // engines report an end offset one short at a node boundary, so accept the
      // one-character extension and use it when it matches exactly.
      var verified = [];
      var wordLikeNeedle = S.isWordLikeNeedle(needle);
      var strictNeedle = wordLikeNeedle && annotation.looseMatch !== true;
      offsets.forEach(function (offset) {
        var raw = pageMap.raw;
        var candidates = [
          raw.slice(offset.start, offset.end),
          raw.slice(offset.start, Math.min(offset.end + 1, raw.length))
        ];
        for (var i = 0; i < candidates.length; i++) {
          if (M.normalizeNeedle(candidates[i]) !== needle) continue;
          var next = { start: offset.start, end: offset.end };
          if (i === 1) next.end = Math.min(offset.end + 1, raw.length);
          // Old data may point inside a longer word (the MA / make bug). Strict
          // annotations must land on whole words, otherwise re-locate or expire.
          if (strictNeedle && !isWholeWordRange(raw, next.start, next.end)) continue;
          next.annotationId = offset.annotationId;
          next.color = offset.color;
          next.secondary = offset.secondary;
          verified.push(next);
          return;
        }
      });
      offsets = verified;
      // Keep only the ranges whose current text is still the marked text. The
      // offsets index map.raw, so slicing it avoids depending on Range.toString
      // (which differs between engines and test stubs).
      offsets = offsets.filter(function (offset) {
        try {
          return M.normalizeNeedle(pageMap.raw.slice(offset.start, offset.end)) === needle;
        } catch (err) {
          return false;
        }
      });
      if (!offsets.length && needle) {
        // No usable anchors left; look the text up again before giving up. A
        // loose marking re-locates loosely, a strict one stays whole-word.
        var found = M.findMatches(pageMap, needle, {
          wholeWord: !annotation.looseMatch,
          limit: S.MAX_MARKS_PER_ANNOTATION
        });
        offsets = M.mergeRanges(found.map(function (match) {
          return {
            start: match.start,
            end: match.end,
            annotationId: annotation.id,
            color: annotation.color,
            secondary: false
          };
        }));
      }
      if (!offsets.length) {
        annotation.marks = 0;
        annotation.anchors = [];
        if (needle) {
          annotation.stale = true;
          annotation.staleAt = Number(annotation.staleAt) || Date.now();
        }
        return;
      }
      delete annotation.stale;
      delete annotation.staleAt;
      annotation.marks = M.applyRanges(pageMap, offsets);
    });
    saveAnnotationsDebounced();
  }

  /* --------------------------------------------------------- stale annotations */

  var STALE_RECHECK_MS = 5 * 60 * 1000;
  var staleMonitor = { ran: false, scheduled: false, lastRunAt: 0 };
  // Annotation ids that were anchored or marked before restorePage() rewrote
  // the runtime anchor list (a page may have changed since the last visit).
  var previouslyMarked = {};

  function applyStaleResult(target, exists, at) {
    if (!target) return;
    target.lastCheckedAt = at;
    if (exists) {
      delete target.stale;
      delete target.staleAt;
    } else {
      target.stale = true;
      target.staleAt = at;
    }
  }

  /**
   * Advisory only: check whether the marked text still occurs on the page.
   * Runs in the background, updates memory plus the debounced save, and never
   * touches the DOM, the toast surface or an open card.
   */
  function detectStaleAnnotations() {
    try {
      if (!state.page || !Array.isArray(state.page.annotations) || !state.page.annotations.length) return;
      if (!M || typeof M.buildTextMap !== 'function' || typeof M.normalizeNeedle !== 'function') return;
      var now = Date.now();
      var pending = [];
      for (var i = 0; i < state.page.annotations.length; i++) {
        var stored = state.page.annotations[i];
        if (!stored || typeof stored.text !== 'string' || !stored.text) continue;
        var anchors = Array.isArray(stored.anchors) ? stored.anchors : [];
        // Only annotations that were anchored or marked before are worth checking.
        if (!anchors.length && !(Number(stored.marks) > 0) && !previouslyMarked[stored.id]) continue;
        var checkedAt = Number(stored.lastCheckedAt) || 0;
        if (checkedAt && now - checkedAt < STALE_RECHECK_MS) continue;
        pending.push(stored);
      }
      if (!pending.length) return;

      // One page text map serves every annotation in this pass.
      var map = M.buildTextMap(document.body);
      // buildTextMap deliberately skips our own <pagegloss-mark> wrappers, so a
      // currently highlighted term is absent from map.raw. Add the mark text
      // back; a live mark for the annotation is proof enough on its own.
      var searchMap = map;
      try {
        var markText = '';
        var marks = document.querySelectorAll('pagegloss-mark');
        for (var k = 0; k < marks.length; k++) markText += ' ' + (marks[k].textContent || '');
        markText = M.normalizeNeedle(markText);
        if (markText) searchMap = { raw: M.normalizeNeedle(map.raw + ' ' + markText) };
      } catch (err) { /* keep the plain map */ }
      var checkedAtStamp = Date.now();
      for (var j = 0; j < pending.length; j++) {
        var annotation = pending[j];
        var needle = M.normalizeNeedle(annotation.text);
        var exists = false;
        try {
          exists = M.countMarks(annotation.id) > 0;
        } catch (err) {
          exists = false;
        }
        if (!exists && needle) {
          // Same matching rules as marking (settings.matchMode, whole-word first).
          try {
            exists = matchNeedle(searchMap, needle, 1).matches.length > 0;
          } catch (err) {
            exists = false;
          }
        }
        applyStaleResult(annotation, exists, checkedAtStamp);
        applyStaleResult(annotationById(annotation.id), exists, checkedAtStamp);
      }
      saveAnnotationsDebounced();
    } catch (err) {
      // Staleness is advisory; it must never disturb reading.
    }
  }

  /**
   * Defer the check so restoring highlights and the first paint stay fast.
   * "force" is used after a BFCache restore and keeps a five minute throttle.
   */
  function scheduleStaleDetection(options) {
    var opts = options || {};
    var force = !!opts.force;
    if (staleMonitor.scheduled) return;
    if (force) {
      if (Date.now() - staleMonitor.lastRunAt < STALE_RECHECK_MS) return;
    } else if (staleMonitor.ran) {
      return;
    }
    staleMonitor.scheduled = true;
    var delay = typeof opts.delay === 'number' ? opts.delay : 1200;
    var run = function () {
      staleMonitor.scheduled = false;
      if (force) {
        if (Date.now() - staleMonitor.lastRunAt < STALE_RECHECK_MS) return;
      } else if (staleMonitor.ran) {
        return;
      }
      staleMonitor.ran = true;
      staleMonitor.lastRunAt = Date.now();
      detectStaleAnnotations();
    };
    var start = function () {
      var done = false;
      var safety = 0;
      var invoke = function () {
        if (done) return;
        done = true;
        if (safety) window.clearTimeout(safety);
        run();
      };
      if (typeof window.requestIdleCallback === 'function') {
        try {
          window.requestIdleCallback(invoke, { timeout: 2000 });
          // Some embedders expose requestIdleCallback but never fire it.
          safety = window.setTimeout(invoke, 2600);
          return;
        } catch (err) { /* fall back to a plain timeout */ }
      }
      window.setTimeout(invoke, 0);
    };
    window.setTimeout(start, delay);
  }

  /* ------------------------------------------------------------------- events */

  function onContextMenu(event) {
    var mark = targetFromPoint(event.target);
    state.pendingMenu = null;
    if (mark) {
      var id = mark.getAttribute('data-pg-id');
      var annotation = annotationById(id);
      if (annotation) {
        state.pendingMenu = {
          kind: 'mark',
          annotationId: id,
          mark: mark,
          at: Date.now(),
          info: { text: annotation.text }
        };
      }
    } else {
      var info = selectionInfo();
      if (info) {
        state.pendingMenu = { kind: 'selection', info: info, at: Date.now() };
      }
    }
  }

  function onPointerMove(event) {
    lastPointer.x = event.clientX;
    lastPointer.y = event.clientY;
  }

  function onMouseOver(event) {
    var mark = targetFromPoint(event.target);
    if (!mark) return;
    window.clearTimeout(state.hoverTimer);
    window.clearTimeout(state.hideTimer);
    if (!state.settings || !state.settings.cardHoverOpen) return;
    var id = mark.getAttribute('data-pg-id');
    if (state.note && state.note.annotationId === id) return;
    state.hoverTimer = window.setTimeout(function () {
      var annotation = annotationById(id);
      if (!annotation) return;
      if (!mark.isConnected) return;
      openNote(annotation, { mark: mark, pin: false, auto: !annotation.explanation });
    }, S.HOVER_DELAY_MS);
  }

  function onMouseOut(event) {
    var mark = targetFromPoint(event.target);
    if (!mark) return;
    window.clearTimeout(state.hoverTimer);
    scheduleHide(280);
  }

  function onClick(event) {
    var mark = targetFromPoint(event.target);
    if (!mark) return;
    var id = mark.getAttribute('data-pg-id');
    var annotation = annotationById(id);
    if (!annotation) return;
    if (state.note && state.note.annotationId === id) {
      // Already open: keep its current pin state. Only the pin button pins.
      state.note.card.focus();
      return;
    }
    // Clicking a highlight opens an UNPINNED card; pinning is explicit.
    openNote(annotation, { mark: mark, pin: false, auto: !annotation.explanation, focus: true });
  }

  function isInsideCardHost(event) {
    if (!state.note || !state.note.card) return true;
    var host = state.note.card.host;
    if (!host) return true;
    var path = event.composedPath ? event.composedPath() : [];
    if (path.indexOf(host) >= 0) return true;
    var target = event.target;
    if (target && target.nodeType === 1 && host.contains && host.contains(target)) return true;
    return false;
  }

  function isInsideConfirmHost(event) {
    var path = event.composedPath ? event.composedPath() : [];
    for (var i = 0; i < path.length; i++) {
      var node = path[i];
      if (node && node.nodeType === 1 && node.id === 'pagegloss-confirm-host') return true;
    }
    return false;
  }

  /** An unpinned card closes when the page outside it is pressed. */
  function closeOnOutside(event) {
    if (!state.note) return;
    if (state.note.card.isPinned()) return;
    if (isInsideCardHost(event)) return;
    // Interacting with the clear-confirmation must not dismiss the card behind it.
    if (isInsideConfirmHost(event)) return;
    // Pressing a <pagegloss-mark> is not "outside": the click handler owns it.
    if (targetFromPoint(event.target)) return;
    closeNote(true);
  }

  function onGlobalKeyDown(event) {
    if (event.key === 'Escape') {
      hideSelectionButton();
      if (state.note) closeNote(true);
      return;
    }
    onMarkHotkey(event);
  }

  function onScroll() {
    hideSelectionButton();
    // Opening a card can itself scroll the page (scrollIntoView / deep links);
    // that scroll must not immediately close the card it was opened for.
    if (Date.now() < state.scrollLock) return;
    if (!state.note) return;
    var card = state.note.card;
    if (card && typeof card.isPinned === 'function' && card.isPinned()) return;
    // Marking opens a temporarily resident card; scrolling must not dismiss it.
    if (noteIsSticky()) return;
    // Scrolling while typing a follow-up question or a note keeps the card.
    if (cardIsTyping(card)) return;
    closeNote(true);
  }

  /**
   * BFCache restore: the page is shown again without re-running the script.
   * Re-announce the current annotations and re-check staleness (throttled).
   */
  function onPageShow(event) {
    if (!event || !event.persisted) return;
    try {
      installDebugSurface();
      broadcastState();
      scheduleStaleDetection({ force: true });
    } catch (err) { /* restoring from BFCache must never throw */ }
  }

  var globalListenersBound = false;

  function bindGlobalListeners() {
    if (globalListenersBound) return;
    globalListenersBound = true;
    document.addEventListener('contextmenu', onContextMenu, true);
    document.addEventListener('mousemove', onPointerMove, true);
    document.addEventListener('mouseover', onMouseOver, true);
    document.addEventListener('mouseout', onMouseOut, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('mousedown', closeOnOutside, true);
    document.addEventListener('click', closeOnOutside, true);
    document.addEventListener('selectionchange', onSelectionChange);
    document.addEventListener('mouseup', onSelectionMouseUp, true);
    window.addEventListener('pageshow', onPageShow);
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('keydown', onGlobalKeyDown);
  }

  bindGlobalListeners();

  /* ------------------------------------------------------------- messaging in */

  /** Public content-script state; also re-broadcast after a BFCache restore. */
  function stateSnapshot() {
    return {
      ok: true,
      url: location.href,
      urlKey: state.urlKey,
      enabled: !!(state.settings && state.settings.enabled),
      contextMode: state.settings ? state.settings.contextMode : S.DEFAULT_CONTEXT_MODE,
      annotations: state.annotations.map(function (item) {
        return {
          id: item.id,
          text: item.text,
          color: item.color,
          marks: M.countMarks(item.id),
          hasExplanation: !!item.explanation,
          // Staleness is passed through as-is; it never changes the highlight.
          stale: !!item.stale,
          staleAt: Number(item.staleAt) || 0
        };
      })
    };
  }

  function broadcastState() {
    try {
      if (typeof chrome === 'undefined' || !chrome.runtime || typeof chrome.runtime.sendMessage !== 'function') return;
      var payload = stateSnapshot();
      payload.type = 'pg:stateChanged';
      chrome.runtime.sendMessage(payload, function () {
        try { void chrome.runtime.lastError; } catch (err) { /* ignore */ }
      });
    } catch (err) { /* no channel available: the popup can still query the tab */ }
  }

  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (!message || typeof message !== 'object') return undefined;
    switch (message.type) {
      case 'pg:ping':
        sendResponse({ ok: true, version: S.PROTOCOL_VERSION });
        return undefined;
      case 'pg:markSelection':
        markFromMenu(message.selection);
        sendResponse({ ok: true });
        return undefined;
      case 'pg:removeOccurrenceAtPoint':
        removeOccurrenceFromMenu();
        sendResponse({ ok: true });
        return undefined;
      case 'pg:removeTermAtPoint':
        removeTermFromMenu();
        sendResponse({ ok: true });
        return undefined;
      case 'pg:clearPage':
        clearPage();
        sendResponse({ ok: true });
        return undefined;
      case 'pg:queryState':
        sendResponse(stateSnapshot());
        return undefined;
      case 'pg:removeAnnotation':
        removeTerm(message.annotationId);
        sendResponse({ ok: true });
        return undefined;
      case 'pg:focusAnnotation':
        var target = annotationById(message.annotationId);
        if (target) {
          var mark = document.querySelector(MARK_TAG + '[data-pg-id="' + S.cssEscape(target.id) + '"]');
          if (mark) mark.scrollIntoView({ block: 'center', behavior: 'smooth' });
          // The smooth scroll fires scroll events; keep the card alive through them.
          state.scrollLock = Date.now() + 900;
          openNote(target, { mark: mark, pin: false, auto: !target.explanation });
        }
        sendResponse({ ok: !!target });
        return undefined;
      case 'pg:settingsChanged':
        applySettings(message.settings);
        location.reload();
        sendResponse({ ok: true });
        return undefined;
      case 'pg:enabledChanged':
        if (state.settings) state.settings.enabled = !!message.enabled;
        if (!message.enabled) {
          closeNote(false);
          showToast(t('popupStatusOff'));
        } else {
          showToast(t('popupStatusOn'));
        }
        sendResponse({ ok: true });
        return undefined;
      default:
        return undefined;
    }
  });

  function menuContext(selectionText) {
    var pending = state.pendingMenu;
    if (pending && Date.now() - pending.at < 30000) return pending;
    var text = M.normalizeNeedle(selectionText || '');
    if (text) {
      var info = selectionInfo();
      if (info) return { kind: 'selection', info: info, at: Date.now() };
      return {
        kind: 'selection',
        info: { text: text, anchorElement: document.body, sentence: '', at: Date.now() },
        at: Date.now()
      };
    }
    return null;
  }

  function markFromMenu(selectionText) {
    var context = menuContext(selectionText);
    if (!context) {
      showToast(t('toastNoSelection'));
      return;
    }
    var info = context.kind === 'mark' ? { text: context.info.text, anchorElement: null, sentence: '' } : context.info;
    if (context.kind === 'mark') {
      var existing = annotationById(context.annotationId);
      if (existing) {
        openNote(existing, { mark: context.mark, pin: false, auto: !existing.explanation });
        return;
      }
      info = { text: context.info.text, anchorElement: context.mark, sentence: M.sentenceAround(context.mark, context.info.text) };
    }
    startMarking(info);
  }

  function removeOccurrenceFromMenu() {
    var context = menuContext('');
    if (context && context.kind === 'mark' && context.mark) {
      removeOccurrence(context.mark);
      return;
    }
    var selection = selectionInfo();
    if (!selection) {
      showToast(t('toastNoSelection'));
      return;
    }
    var annotation = findAnnotationByText(selection.text);
    if (!annotation) {
      showToast(t('toastNotFound'));
      return;
    }
    removeTerm(annotation.id);
  }

  function removeTermFromMenu() {
    var context = menuContext('');
    var annotation = null;
    if (context && context.kind === 'mark') annotation = annotationById(context.annotationId);
    if (!annotation) {
      var selection = selectionInfo();
      if (selection) annotation = findAnnotationByText(selection.text);
    }
    if (!annotation) {
      showToast(t('toastNotFound'));
      return;
    }
    removeTerm(annotation.id);
  }

  function findAnnotationByText(text) {
    var needle = M.normalizeNeedle(text).toLowerCase();
    if (!needle) return null;
    for (var i = 0; i < state.annotations.length; i++) {
      var candidate = state.annotations[i];
      var value = String(candidate.text || '').toLowerCase();
      if (value === needle || value.indexOf(needle) >= 0 || needle.indexOf(value) >= 0) return candidate;
    }
    return null;
  }

  function applySettings(settings) {
    state.settings = Store.normalizeSettings(settings || {});
  }

  /* --------------------------------------------------------------------- boot */

  /**
   * Deep link used by the data page: #pg-focus=<encodeURIComponent(id)> opens
   * that annotation and scrolls it into view. Unknown ids are ignored silently.
   */
  function focusFromHash() {
    var hash = String(location.hash || '');
    var match = /pg-focus=([^&]+)/.exec(hash);
    if (!match) return;
    var wanted = match[1];
    var decoded = wanted;
    try { decoded = decodeURIComponent(wanted); } catch (err) { decoded = wanted; }
    var annotation = annotationById(decoded) || annotationById(wanted);
    if (!annotation) return;
    var mark = null;
    try {
      mark = document.querySelector(MARK_TAG + '[data-pg-id="' + S.cssEscape(annotation.id) + '"]');
    } catch (err) {
      mark = null;
    }
    if (mark && typeof mark.scrollIntoView === 'function') {
      try {
        mark.scrollIntoView({ block: 'center', behavior: 'auto' });
      } catch (err) {
        try { mark.scrollIntoView(); } catch (err2) { /* ignore */ }
      }
    }
    state.scrollLock = Date.now() + 800;
    openNote(annotation, { mark: mark, pin: false, auto: false });
  }

  /* ------------------------------------------------ single page app navigation */

  var urlWatcher = { installed: false, last: '' };

  /**
   * A history API navigation changes the URL without reloading the document.
   * The cached annotations belong to the previous URL, so drop the old marks
   * and load the new URL's own annotation set.
   */
  function handleUrlChange() {
    var nextKey = S.normalizeUrlKey(location.href);
    if (!nextKey || nextKey === state.urlKey) return;
    // Persist the open thread against the page we are leaving.
    if (state.note) closeNote(true);
    window.clearTimeout(saveTimer);
    window.clearTimeout(noteSaveTimer);
    try { M.unwrapAnnotations(null); } catch (err) { /* ignore */ }
    state.annotations = [];
    state.threads = {};
    state.note = null;
    state.urlKey = nextKey;
    if (!state.settings || !state.settings.enabled) {
      broadcastState();
      return;
    }
    Store.getPage(nextKey).then(function (page) {
      state.page = page;
      state.page.url = location.href;
      state.page.title = document.title;
      restorePage();
      scheduleStaleDetection({ force: true });
      broadcastState();
    }).catch(function () {
      broadcastState();
    });
  }

  function installUrlWatcher() {
    if (urlWatcher.installed) return;
    urlWatcher.installed = true;
    urlWatcher.last = location.href;
    function check() {
      if (location.href === urlWatcher.last) return;
      urlWatcher.last = location.href;
      handleUrlChange();
    }
    if (typeof window.addEventListener === 'function') {
      window.addEventListener('popstate', check);
      window.addEventListener('hashchange', check);
    }
    try {
      if (typeof history === 'object' && history) {
        ['pushState', 'replaceState'].forEach(function (name) {
          var original = history[name];
          if (typeof original !== 'function') return;
          history[name] = function () {
            var result = original.apply(history, arguments);
            window.setTimeout(check, 0);
            return result;
          };
        });
      }
    } catch (err) { /* frozen history: the periodic check still covers it */ }
    if (typeof window.setInterval === 'function') window.setInterval(check, 1200);
  }

  function boot() {
    if (!document.body) {
      // Nothing to attach marks or the card to yet; retry once the DOM exists.
      document.addEventListener('DOMContentLoaded', function () {
        if (document.body) boot();
      }, { once: true });
      return;
    }
    installUrlWatcher();
    state.settingsPromise = Store.getSettings()
      .then(function (settings) {
        state.settings = settings;
        // Cards and toasts must follow the interface language chosen in the
        // options page, not the browser language used before settings loaded.
        if (window.PageGlossI18n) {
          i18n = window.PageGlossI18n.create(settings.language);
          t = i18n.t;
        }
        if (!settings.enabled) return settings;
        return Store.getPage(state.urlKey)
          .then(function (page) {
            state.page = page;
            state.page.url = location.href;
            state.page.title = document.title;
            restorePage();
            focusFromHash();
            // Advisory background pass; never blocks the first paint.
            scheduleStaleDetection();
            return settings;
          })
          .catch(function (err) {
            // Storage may be unavailable (quota, disabled sync); marking still
            // works for this session, only persistence is skipped.
            console.warn('[PageGloss] stored annotations could not be read:', err && err.message ? err.message : err);
            showToast(t('errStorageUnavailable'), { duration: 4200 });
            return settings;
          });
      })
      .catch(function (err) {
        state.settings = state.settings || Store.normalizeSettings({});
        console.warn('[PageGloss] settings could not be read:', err && err.message ? err.message : err);
        showToast(t('errStorageUnavailable'), { duration: 4200 });
        return state.settings;
      });

    // Deliberately NO "LLM not configured" warning here. The settings request
    // above is asynchronous, so checking llmConfigState() at this point warned
    // on every page load even when everything was configured. The notice is
    // shown by the first real mark / follow-up instead.
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }

  // Expose a tiny debug surface without polluting the page. It is reinstalled
  // (never re-bound) after a BFCache restore.
  var debugSurface = {
    version: S.PROTOCOL_VERSION,
    state: state,
    mark: startMarking,
    removeOccurrenceAt: removeOccurrence,
    removeTerm: removeTerm,
    clear: clearPage
  };

  function installDebugSurface() {
    try {
      window.__pagegloss = debugSurface;
    } catch (err) { /* a hostile page may freeze window */ }
  }

  installDebugSurface();
})();
