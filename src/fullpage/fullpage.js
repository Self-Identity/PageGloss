/*
 * PageGloss - standalone full-page reading view.
 *
 * Loaded as a classic script after messages.js, i18n.js and storage.js. Reads
 * one cached annotation from chrome.storage.local, streams follow-up answers
 * over the extension's LLM port, and autosaves the note on the right.
 */
(function () {
  'use strict';

  const Store = window.PageGlossStore;
  const S = window.PageGlossShared;
  const I = window.PageGlossI18n.create();

  const refs = {};
  const state = {
    key: '',
    id: '',
    page: null,
    annotation: null,
    thread: [],
    busy: false,
    askPort: null,
    noteTimer: 0,
    pageSaveChain: Promise.resolve(),
    saveChip: null,
    chipHideTimer: 0,
    chipRemoveTimer: 0,
    toasts: []
  };

  function t(key, values) {
    return I.t(key, values);
  }

  /*
   * The task's key list names dataBack, but that key is absent from the shared
   * table in this checkout. Resolve it dynamically so an updated table is used
   * when available, and fall back to the existing cardClose label otherwise.
   * This keeps the page working without adding or editing any i18n key.
   */
  const CLOSE_LABEL_KEY = 'dataBack';

  function closeLabel() {
    const preferred = I.t(CLOSE_LABEL_KEY);
    return preferred === CLOSE_LABEL_KEY ? I.t('cardClose') : preferred;
  }

  /* --------------------------------------------------------------- DOM setup */

  function cacheRefs() {
    [
      'pageTitle', 'saveChipHost', 'openSourceBtn', 'openSourceLabel', 'closeBtn', 'closeLabel',
      'loadingView', 'loadingText', 'missingView', 'missingText',
      'missingOpenBtn', 'missingOpenLabel', 'missingCloseBtn', 'missingCloseLabel',
      'workspace', 'chatHeading', 'annotationText', 'sourceTitle', 'chatUpdated', 'messages',
      'askForm', 'askLabel', 'askInput', 'sendBtn', 'sendLabel',
      'noteHeading', 'noteUpdated', 'noteLabel', 'noteInput', 'toastRoot'
    ].forEach(function (id) {
      refs[id] = document.getElementById(id);
    });
  }

  function applyLabels() {
    document.documentElement.lang = I.lang === 'zh' ? 'zh-CN' : 'en';
    document.title = t('fpTitle');

    refs.pageTitle.textContent = t('fpTitle');
    refs.openSourceLabel.textContent = t('fpOpenSource');
    refs.closeLabel.textContent = closeLabel();
    refs.openSourceBtn.title = t('dataOpenHint');

    refs.loadingText.textContent = t('fpLoading');
    refs.missingText.textContent = t('fpMissing');
    refs.missingOpenLabel.textContent = t('fpOpenSource');
    refs.missingOpenBtn.title = t('dataOpenHint');
    refs.missingCloseLabel.textContent = closeLabel();

    refs.chatHeading.textContent = t('fpChatTitle');
    refs.noteHeading.textContent = t('fpNoteTitle');
    refs.noteLabel.textContent = t('fpNoteTitle');
    refs.askLabel.textContent = t('fpAskPlaceholder');
    refs.askInput.placeholder = t('fpAskPlaceholder');
    refs.sendLabel.textContent = t('fpSend');
    refs.noteInput.placeholder = t('cardNotePlaceholder');
  }

  /** Query string value, decoded exactly as the card's full-page link writes it. */
  function readParam(name) {
    const match = new RegExp('[?&]' + name + '=([^&]*)').exec(window.location.search);
    if (!match) return '';
    try {
      return decodeURIComponent(match[1]);
    } catch (err) {
      return match[1];
    }
  }

  function showLoading() {
    refs.loadingView.hidden = false;
    refs.missingView.hidden = true;
    refs.workspace.hidden = true;
    refs.openSourceBtn.hidden = true;
  }

  function showMissing() {
    const hasUrl = !!(state.page && state.page.url);
    refs.loadingView.hidden = true;
    refs.workspace.hidden = true;
    refs.missingView.hidden = false;
    refs.missingOpenBtn.hidden = !hasUrl;
    refs.openSourceBtn.hidden = true;
    refs.pageTitle.textContent = t('fpTitle');
    refs.pageTitle.title = '';
    document.title = t('fpTitle');
  }

  function showWorkspace() {
    refs.loadingView.hidden = true;
    refs.missingView.hidden = true;
    refs.workspace.hidden = false;
    refs.openSourceBtn.hidden = !(state.page && state.page.url);
  }

  /* ------------------------------------------------------------- formatting */

  function escapeHtml(text) {
    return String(text == null ? '' : text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * Minimal, safe Markdown. The whole source is escaped before any markup is
   * added, so model output can never introduce raw HTML. Only our own known
   * tags and http(s) links are emitted.
   */
  function renderMarkdown(source) {
    let text = escapeHtml(source);
    if (!text.trim()) return '';

    const codeBlocks = [];
    text = text.replace(/```[a-zA-Z0-9_+-]*\n?([\s\S]*?)```/g, function (_match, code) {
      codeBlocks.push(code.replace(/\n$/, ''));
      return '\u0000PGCODE' + (codeBlocks.length - 1) + '\u0000';
    });

    function inline(value) {
      return value
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/__([^_]+)__/g, '<strong>$1</strong>')
        .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
        .replace(/(^|[\s(])_([^_\n]+)_/g, '$1<em>$2</em>')
        .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
          '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    }

    const lines = text.split('\n');
    const html = [];
    let listType = null;

    function closeList() {
      if (!listType) return;
      html.push('</' + listType + '>');
      listType = null;
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const codeOnly = line.match(/^\s*\u0000PGCODE(\d+)\u0000\s*$/);
      if (codeOnly) {
        closeList();
        html.push('<pre><code>' + (codeBlocks[Number(codeOnly[1])] || '') + '</code></pre>');
        continue;
      }
      if (/^```/.test(line)) continue;

      const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
      const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (bullet || ordered) {
        const wanted = bullet ? 'ul' : 'ol';
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
      const heading = line.match(/^#{1,6}\s+(.*)$/);
      if (heading) {
        html.push('<p><strong>' + inline(heading[1]) + '</strong></p>');
        continue;
      }
      html.push('<p>' + inline(line) + '</p>');
    }
    closeList();
    return html.join('');
  }

  function formatTime(timestamp) {
    return new Date(Number(timestamp) || 0)
      .toLocaleString(I.lang === 'zh' ? 'zh-CN' : 'en-US');
  }

  function renderChatUpdated() {
    if (!state.annotation) return;
    const stamp = state.annotation.updatedAt || (state.page && state.page.updatedAt) || 0;
    refs.chatUpdated.textContent = t('fpUpdatedAt', { s: formatTime(stamp) });
  }

  function renderNoteUpdated() {
    if (!state.annotation) return;
    const stamp = state.annotation.noteUpdatedAt || state.annotation.updatedAt ||
      (state.page && state.page.updatedAt) || 0;
    refs.noteUpdated.textContent = t('fpUpdatedAt', { s: formatTime(stamp) });
  }

  /* ------------------------------------------------------------------ toasts */

  function removeToast(entry) {
    if (!entry) return;
    if (entry.hideTimer) window.clearTimeout(entry.hideTimer);
    if (entry.removeTimer) window.clearTimeout(entry.removeTimer);
    if (entry.node && entry.node.parentNode) entry.node.remove();
    const index = state.toasts.indexOf(entry);
    if (index >= 0) state.toasts.splice(index, 1);
  }

  function hideToast(entry) {
    if (!entry || entry.leaving) return;
    entry.leaving = true;
    if (entry.hideTimer) {
      window.clearTimeout(entry.hideTimer);
      entry.hideTimer = 0;
    }
    if (!entry.node || !entry.node.parentNode) {
      removeToast(entry);
      return;
    }
    entry.node.classList.add('is-leaving');
    let finished = false;
    const finish = function () {
      if (finished) return;
      finished = true;
      entry.node.removeEventListener('transitionend', onEnd);
      removeToast(entry);
    };
    const onEnd = function (event) {
      if (event.target === entry.node && event.propertyName === 'opacity') finish();
    };
    entry.node.addEventListener('transitionend', onEnd);
    entry.removeTimer = window.setTimeout(finish, 320);
  }

  function showToast(message) {
    const text = String(message == null ? '' : message).trim();
    if (!text) return;
    const node = document.createElement('div');
    node.className = 'toast';
    node.textContent = text;
    refs.toastRoot.appendChild(node);
    const entry = { node: node, hideTimer: 0, removeTimer: 0, leaving: false };
    state.toasts.push(entry);
    while (state.toasts.length > 3) removeToast(state.toasts[0]);
    entry.hideTimer = window.setTimeout(function () { hideToast(entry); }, 2800);
  }

  /* ------------------------------------------------------------ saved chip */

  function clearSaveChip() {
    if (state.chipHideTimer) {
      window.clearTimeout(state.chipHideTimer);
      state.chipHideTimer = 0;
    }
    if (state.chipRemoveTimer) {
      window.clearTimeout(state.chipRemoveTimer);
      state.chipRemoveTimer = 0;
    }
    if (state.saveChip && state.saveChip.parentNode) state.saveChip.remove();
    state.saveChip = null;
  }

  function beginSaveChipExit(chip) {
    if (state.saveChip !== chip) return;
    if (state.chipHideTimer) {
      window.clearTimeout(state.chipHideTimer);
      state.chipHideTimer = 0;
    }
    chip.classList.add('is-leaving');
    let finished = false;
    const finish = function () {
      if (finished) return;
      finished = true;
      chip.removeEventListener('transitionend', onEnd);
      if (state.chipRemoveTimer) {
        window.clearTimeout(state.chipRemoveTimer);
        state.chipRemoveTimer = 0;
      }
      if (state.saveChip === chip) state.saveChip = null;
      if (chip.parentNode) chip.remove();
    };
    const onEnd = function (event) {
      if (event.target === chip && event.propertyName === 'opacity') finish();
    };
    chip.addEventListener('transitionend', onEnd);
    state.chipRemoveTimer = window.setTimeout(finish, 320);
  }

  /** A short-lived toolbar chip: 1.5s visible, then transition out and remove. */
  function showSaveChip() {
    clearSaveChip();
    const chip = document.createElement('span');
    chip.className = 'save-chip';
    chip.textContent = t('fpNoteAutoSaved');
    state.saveChip = chip;
    refs.saveChipHost.appendChild(chip);
    state.chipHideTimer = window.setTimeout(function () {
      state.chipHideTimer = 0;
      beginSaveChipExit(chip);
    }, 1500);
  }

  /* ----------------------------------------------------------- page loading */

  async function boot() {
    const key = readParam('key');
    const id = readParam('id');
    state.key = key;
    state.id = id;
    if (!key || !id) {
      showMissing();
      return;
    }

    try {
      const page = await Store.getPage(key);
      state.page = page;
      const annotation = page.annotations.find(function (item) {
        return item && item.id === id;
      });
      if (!annotation) {
        showMissing();
        return;
      }
      state.annotation = annotation;
      state.thread = Store.getThread(page, id).slice();
      renderWorkspace();
    } catch (err) {
      state.page = null;
      state.annotation = null;
      showMissing();
    }
  }

  function renderWorkspace() {
    const page = state.page;
    const annotation = state.annotation;
    const term = annotation.text || '';
    const displayTitle = term || t('fpTitle');

    refs.pageTitle.textContent = displayTitle;
    refs.pageTitle.title = term || '';
    document.title = displayTitle;

    refs.annotationText.textContent = term;
    refs.annotationText.title = term;
    refs.sourceTitle.textContent = page.title || page.url || '';
    refs.sourceTitle.title = page.title || page.url || '';
    refs.sourceTitle.hidden = !refs.sourceTitle.textContent;

    refs.noteInput.value = typeof annotation.note === 'string' ? annotation.note : '';
    renderChatUpdated();
    renderNoteUpdated();
    setBusy(false);

    showWorkspace();
    renderThread();
    window.requestAnimationFrame(function () {
      refs.messages.scrollTop = refs.messages.scrollHeight;
    });
  }

  /* ----------------------------------------------------------- conversation */

  function scrollToEnd() {
    window.requestAnimationFrame(function () {
      refs.messages.scrollTop = refs.messages.scrollHeight;
    });
  }

  function removeEmptyState() {
    const empty = refs.messages.querySelector('.empty-state');
    if (empty) empty.remove();
  }

  function appendUserBubble(text) {
    removeEmptyState();
    const bubble = document.createElement('div');
    bubble.className = 'msg user';
    bubble.textContent = text;
    refs.messages.appendChild(bubble);
    scrollToEnd();
    return bubble;
  }

  function createAssistantBubble(thinking) {
    removeEmptyState();
    const bubble = document.createElement('div');
    bubble.className = 'msg assistant';

    const label = document.createElement('span');
    label.className = 'who';
    label.textContent = t('cardAnswerLabel');
    bubble.appendChild(label);

    let status = null;
    if (thinking) {
      status = document.createElement('div');
      status.className = 'thinking';
      const spinner = document.createElement('span');
      spinner.className = 'spinner';
      spinner.setAttribute('aria-hidden', 'true');
      const statusText = document.createElement('span');
      statusText.textContent = t('cardThinking');
      status.appendChild(spinner);
      status.appendChild(statusText);
      bubble.appendChild(status);
    }

    const markdown = document.createElement('div');
    markdown.className = 'md';
    markdown.hidden = true;
    bubble.appendChild(markdown);

    refs.messages.appendChild(bubble);
    return { bubble: bubble, status: status, markdown: markdown };
  }

  function showAnswer(stream, text) {
    if (stream.status) {
      if (stream.status.parentNode) stream.status.remove();
      stream.status = null;
    }
    stream.markdown.hidden = false;
    stream.markdown.innerHTML = renderMarkdown(text);
    scrollToEnd();
  }

  function renderThread() {
    refs.messages.textContent = '';
    if (!state.thread.length) {
      const empty = document.createElement('p');
      empty.className = 'empty-state';
      empty.textContent = t('fpNoMessages');
      refs.messages.appendChild(empty);
      return;
    }

    state.thread.forEach(function (message) {
      if (message.role === 'user') {
        removeEmptyState();
        const bubble = document.createElement('div');
        bubble.className = 'msg user';
        bubble.textContent = message.content;
        refs.messages.appendChild(bubble);
        return;
      }
      const stream = createAssistantBubble(false);
      showAnswer(stream, message.content);
    });
  }

  function appendError(message, retry) {
    const bubble = document.createElement('div');
    bubble.className = 'msg error';
    bubble.setAttribute('role', 'alert');

    const text = document.createElement('span');
    text.className = 'error-text';
    text.textContent = message;
    bubble.appendChild(text);

    if (typeof retry === 'function') {
      const actions = document.createElement('div');
      actions.className = 'error-actions';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn ghost small';
      button.textContent = t('cardRetry');
      button.addEventListener('click', function () {
        if (bubble.parentNode) bubble.remove();
        retry();
      });
      actions.appendChild(button);
      bubble.appendChild(actions);
    }

    refs.messages.appendChild(bubble);
    scrollToEnd();
    return bubble;
  }

  function localizedError(message) {
    if (typeof message === 'string') return message || t('errUnknown');
    const info = S.apiErrorKey(message);
    let text = t(info.key, info.values);
    if (info.hintKey && info.hintKey !== info.key) {
      text += ' ' + t(info.hintKey);
    }
    return text;
  }

  function setBusy(busy) {
    state.busy = !!busy;
    refs.sendBtn.disabled = state.busy;
    refs.askForm.setAttribute('aria-busy', state.busy ? 'true' : 'false');
  }

  function closeAskPort() {
    const port = state.askPort;
    state.askPort = null;
    if (!port) return;
    try { port.disconnect(); } catch (err) { /* already gone */ }
  }

  function startAsk(question) {
    if (!state.page || !state.annotation || state.busy) return;
    const clean = String(question || '').trim();
    if (!clean) return;

    const page = state.page;
    const annotation = state.annotation;
    const history = state.thread
      .filter(function (item) { return item.role === 'user' || item.role === 'assistant'; })
      .map(function (item) { return { role: item.role, content: item.content }; });

    const payload = {
      kind: 'ask',
      term: annotation.text,
      question: clean,
      context: {
        mode: 'sentence',
        title: page.title,
        url: page.url,
        sentence: annotation.sentence || '',
        section: ''
      },
      history: history
    };

    let port = null;
    try {
      const connected = chrome.runtime.connect({ name: 'pagegloss-llm' });
      port = connected;
    } catch (err) {
      appendError(t('errUnknown'), function () { startAsk(clean); });
      return;
    }

    state.askPort = port;
    const askedAt = Date.now();
    const userNode = appendUserBubble(clean);
    const stream = createAssistantBubble(true);
    setBusy(true);
    scrollToEnd();

    let raw = '';
    let settled = false;

    function fail(message) {
      if (settled) return;
      settled = true;
      closeAskPort();
      if (userNode.parentNode) userNode.remove();
      if (stream.bubble.parentNode) stream.bubble.remove();
      setBusy(false);
      appendError(message, function () { startAsk(clean); });
    }

    async function finish(message) {
      if (settled) return;
      settled = true;
      closeAskPort();

      const finalText = String((message && message.text) || raw || '');
      if (!finalText.trim()) {
        if (userNode.parentNode) userNode.remove();
        if (stream.bubble.parentNode) stream.bubble.remove();
        setBusy(false);
        appendError(localizedError({ code: 'empty', detail: String((message && message.finishReason) || '') }), function () {
          startAsk(clean);
        });
        return;
      }

      showAnswer(stream, finalText);
      setBusy(false);

      try {
        const thread = state.thread.slice();
        thread.push({ role: 'user', content: clean, at: askedAt });
        thread.push({ role: 'assistant', content: finalText, at: Date.now() });
        Store.setThread(page, state.id, thread);
        state.thread = Store.getThread(page, state.id).slice();
        Store.touchAnnotation(page, state.id);
        renderChatUpdated();
        await persistPage();
      } catch (err) {
        showToast(t('errUnknown'));
      }
    }

    port.onMessage.addListener(function (message) {
      if (settled || !message || typeof message !== 'object') return;
      if (message.type === 'token') {
        raw += String(message.delta || '');
        showAnswer(stream, raw);
        return;
      }
      if (message.type === 'done') {
        finish(message).catch(function () { showToast(t('errUnknown')); });
        return;
      }
      if (message.type === 'error') {
        fail(localizedError(message));
      }
    });

    port.onDisconnect.addListener(function () {
      if (settled) return;
      // Touch lastError to silence Chrome's unchecked-runtime-error warning.
      if (chrome.runtime.lastError) { /* connection ended */ }
      fail(t('errUnknown'));
    });

    try {
      port.postMessage({ type: 'llm:start', payload: payload });
    } catch (err) {
      fail(t('errUnknown'));
    }
  }

  function submitQuestion() {
    if (state.busy || !state.annotation) return;
    const question = refs.askInput.value.trim();
    if (!question) return;
    refs.askInput.value = '';
    startAsk(question);
  }

  /* --------------------------------------------------------------- notes */

  async function writePage() {
    await Store.savePage(state.page);
  }

  function persistPage() {
    const run = state.pageSaveChain.then(writePage);
    // Keep the chain usable after a failed write while letting this caller see
    // the rejection and show a lightweight hint.
    state.pageSaveChain = run.catch(function () { /* handled by caller */ });
    return run;
  }

  async function saveNoteNow() {
    if (!state.page || !state.annotation) return;
    try {
      const text = refs.noteInput.value;
      const target = Store.setNote(state.page, state.id, text);
      if (!target) return;
      await persistPage();
      renderChatUpdated();
      renderNoteUpdated();
      showSaveChip();
    } catch (err) {
      showToast(t('errUnknown'));
    }
  }

  function scheduleNoteSave() {
    if (state.noteTimer) window.clearTimeout(state.noteTimer);
    state.noteTimer = window.setTimeout(function () {
      state.noteTimer = 0;
      saveNoteNow();
    }, 500);
  }

  /* ------------------------------------------------------------- actions */

  function openSourcePage() {
    const url = state.page && state.page.url;
    if (!url) return;
    try {
      const pending = chrome.tabs.create({ url: url });
      if (pending && typeof pending.catch === 'function') {
        pending.catch(function () { showToast(t('errUnknown')); });
      }
    } catch (err) {
      showToast(t('errUnknown'));
    }
  }

  function closeThisPage() {
    try { window.close(); } catch (err) { /* window already gone */ }
  }

  function bindEvents() {
    refs.openSourceBtn.addEventListener('click', openSourcePage);
    refs.missingOpenBtn.addEventListener('click', openSourcePage);
    refs.closeBtn.addEventListener('click', closeThisPage);
    refs.missingCloseBtn.addEventListener('click', closeThisPage);

    refs.askForm.addEventListener('submit', function (event) {
      event.preventDefault();
      submitQuestion();
    });

    refs.askInput.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        submitQuestion();
      }
    });

    refs.noteInput.addEventListener('input', scheduleNoteSave);

    window.addEventListener('pagehide', function () {
      if (state.noteTimer) {
        window.clearTimeout(state.noteTimer);
        state.noteTimer = 0;
      }
      state.toasts.slice().forEach(removeToast);
      clearSaveChip();
      closeAskPort();
    });
  }

  function init() {
    cacheRefs();
    applyLabels();
    showLoading();
    bindEvents();
    boot();
  }

  init();
})();
