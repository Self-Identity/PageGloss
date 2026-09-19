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
    page: null,
    urlKey: S.normalizeUrlKey(location.href),
    annotations: [],
    threads: {},
    pendingMenu: null,
    note: null,
    hoverTimer: 0,
    hideTimer: 0
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

  /** The three settings every explanation request needs. */
  function llmConfigState() {
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
    var state = config || llmConfigState();
    if (state.ready) return false;
    showToast(state.message, {
      duration: 6000,
      action: { label: t('cfgOpenOptions'), run: openOptionsPage }
    });
    if (card) {
      card.addError(state.message, function () {
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
    var mode = state.settings.contextMode || S.DEFAULT_CONTEXT_MODE;
    var limit = state.settings.maxContextChars || S.MAX_PAGE_CHARS;
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
    if (state.settings.markSentenceTokens && /[\s。！？!?；;]/.test(annotation.text)) {
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
      var result = matchNeedle(map, needle.text, budget, { strict: opts.strict });
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
      if (opts.pin) {
        state.note.card.setPinned(true);
        state.note.card.setPosition(position.x, position.y);
      }
      state.note.card.focus();
      return state.note.card;
    }
    closeNote(false);

    var card = Card.create({
      i18n: i18n,
      term: annotation.text,
      color: annotation.color,
      position: position,
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

    state.note = {
      annotationId: annotation.id,
      card: card,
      mark: mark || null,
      saveTimer: 0,
      requestSeq: 0
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
    state.note = null;
    window.clearTimeout(note.saveTimer);
    note.card.abort();
    note.card.destroy();
    if (userAction) persistThreadFrom(note.annotationId);
  }

  function persistThreadFrom(annotationId) {
    if (!state.page) return;
    Store.setThread(state.page, annotationId, state.threads[annotationId] || []);
    Store.pruneIfTooLarge(state.page).then(function (page) {
      return Store.savePage(page);
    }).catch(function () { /* ignore */ });
  }

  function scheduleHide(delay) {
    window.clearTimeout(state.hideTimer);
    state.hideTimer = window.setTimeout(function () {
      if (!state.note) return;
      if (state.note.card.isPinned()) return;
      if (isPointerInsideCard() || isPointerOnMark()) return;
      closeNote(true);
    }, delay == null ? 260 : delay);
  }

  function isPointerInsideCard() {
    if (!state.note || !state.note.card) return false;
    var host = state.note.card.host;
    if (!host || !host.isConnected) return false;
    return host.matches(':hover');
  }

  var lastPointer = { x: 0, y: 0 };

  function isPointerOnMark() {
    var element = document.elementFromPoint(clamp(lastPointer.x, 0, window.innerWidth - 1), clamp(lastPointer.y, 0, window.innerHeight - 1));
    return !!targetFromPoint(element);
  }

  /* ------------------------------------------------------------- LLM plumbing */

  function requestExplanation(annotation, card, options) {
    var config = llmConfigState();
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
    if (handlers && !handlers.onReasoning && card && card.appendReasoning) {
      handlers.onReasoning = function (chunk) { card.appendReasoning(chunk); };
    }
    var config = llmConfigState();
    if (!config.ready) {
      notifyNotConfigured(config, null);
      handlers.onError(config.message);
      return { abort: function () {} };
    }
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
      openNote(existing, { mark: mark, pin: true, auto: false });
      return;
    }
    var annotation = {
      id: S.uuid(),
      text: text,
      color: M.pickColor(text.toLowerCase()),
      sentence: info.sentence || '',
      createdAt: Date.now(),
      marks: 0,
      anchors: [],
      explanation: ''
    };
    annotation.anchorElement = info.anchorElement;
    annotation.sentence = info.sentence || M.sentenceAround(info.anchorElement, text);
    var result = markAnnotation(annotation, { wholeSentence: false });
    if (!result.created) {
      showToast(t('toastNotFound'), { duration: 3600 });
      return;
    }
    state.annotations.push(annotation);
    if (state.page) Store.upsertAnnotation(state.page, stripRuntime(annotation));

    var config = llmConfigState();
    if (!config.ready) {
      showToast(t('toastMarkedNoLlm', { n: result.created }), { duration: 4200 });
      saveAnnotationsDebounced();
      // Still open the card so the notice, the settings shortcut and the retry
      // button are one click away.
      var pending = openNote(annotation, { pin: true, auto: false });
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
    var card = openNote(annotation, { pin: true, auto: true });
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

  function clearPage() {
    M.unwrapAnnotations(null);
    state.annotations = [];
    state.threads = {};
    closeNote(false);
    if (state.page) {
      state.page.annotations = [];
      state.page.chats = {};
    }
    Store.clearPage(state.urlKey).then(function () {
      showToast(t('toastCleared'));
    }).catch(function () {
      showToast(t('toastCleared'));
    });
  }

  /* ------------------------------------------------------------------ restore */

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

    state.annotations.forEach(function (annotation) {
      var ranges = M.rangesFromAnchors(annotation).slice(0, S.MAX_MARKS_PER_ANNOTATION);
      if (!ranges.length) {
        annotation.marks = 0;
        annotation.anchors = [];
        return;
      }
      var map = M.buildTextMap(document.body);
      var offsets = M.offsetsForRanges(map, ranges, {
        annotationId: annotation.id,
        color: annotation.color,
        secondary: false
      });
      if (!offsets.length) {
        annotation.marks = 0;
        return;
      }
      annotation.marks = M.applyRanges(map, offsets);
    });
    saveAnnotationsDebounced();
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
    if (state.note && state.note.annotationId === id && state.note.card.isPinned()) {
      closeNote(true);
      return;
    }
    openNote(annotation, { mark: mark, pin: true, auto: !annotation.explanation, focus: true });
  }

  document.addEventListener('contextmenu', onContextMenu, true);
  document.addEventListener('mousemove', onPointerMove, true);
  document.addEventListener('mouseover', onMouseOver, true);
  document.addEventListener('mouseout', onMouseOut, true);
  document.addEventListener('click', onClick, true);
  window.addEventListener('scroll', function () {
    if (state.note && !state.note.card.isPinned()) closeNote(true);
  }, { passive: true });
  window.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && state.note) closeNote(true);
  });

  /* ------------------------------------------------------------- messaging in */

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
        sendResponse({
          ok: true,
          url: location.href,
          urlKey: state.urlKey,
          enabled: !!(state.settings && state.settings.enabled),
          contextMode: state.settings ? state.settings.contextMode : S.DEFAULT_CONTEXT_MODE,
          annotations: state.annotations.map(function (item) {
            return { id: item.id, text: item.text, color: item.color, marks: M.countMarks(item.id), hasExplanation: !!item.explanation };
          })
        });
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
          openNote(target, { mark: mark, pin: true, auto: !target.explanation });
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
        openNote(existing, { mark: context.mark, pin: true, auto: !existing.explanation });
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

  function boot() {
    if (!document.body) {
      // Nothing to attach marks or the card to yet; retry once the DOM exists.
      document.addEventListener('DOMContentLoaded', function () {
        if (document.body) boot();
      }, { once: true });
      return;
    }

    Store.getSettings()
      .then(function (settings) {
        state.settings = settings;
        if (!settings.enabled) return null;
        return Store.getPage(state.urlKey)
          .then(function (page) {
            state.page = page;
            state.page.url = location.href;
            state.page.title = document.title;
            restorePage();
            return null;
          })
          .catch(function (err) {
            // Storage may be unavailable (quota, disabled sync); marking still
            // works for this session, only persistence is skipped.
            console.warn('[PageGloss] stored annotations could not be read:', err && err.message ? err.message : err);
            showToast(t('errStorageUnavailable'), { duration: 4200 });
            return null;
          });
      })
      .catch(function (err) {
        state.settings = state.settings || Store.normalizeSettings({});
        console.warn('[PageGloss] settings could not be read:', err && err.message ? err.message : err);
        showToast(t('errStorageUnavailable'), { duration: 4200 });
      });

    var config = llmConfigState();
    if (!config.ready) {
      // Friendly heads-up instead of failing later with a cryptic request error.
      showToast(config.message, { duration: 6000, action: { label: t('cfgOpenOptions'), run: openOptionsPage } });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }

  // Expose a tiny debug surface without polluting the page.
  window.__pagegloss = {
    version: S.PROTOCOL_VERSION,
    state: state,
    mark: startMarking,
    removeOccurrenceAt: removeOccurrence,
    removeTerm: removeTerm,
    clear: clearPage
  };
})();
