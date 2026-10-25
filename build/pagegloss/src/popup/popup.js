/* PageGloss - popup logic */
(function () {
  'use strict';

  var S = window.PageGlossShared;
  var Store = window.PageGlossStore;
  var UI = window.PageGlossUI;

  var PAGE_SIZE = 5;
  var PAGE_KEY_PREFIX = 'pg:popup-page:';
  var NOTES_KEY_PREFIX = 'pg:popup-notes:';
  var RETRY_DELAY = 200;
  var RETRY_COUNT = 2;

  var state = {
    settings: null,
    tab: null,
    supported: false,
    pageState: null,
    i18n: null,
    page: 1,
    annotations: [],
    annotationsUrl: '',
    loaded: false,
    cache: Object.create(null),
    pageMemory: Object.create(null),
    notesSignature: '',
    refreshSeq: 0,
    refreshTimer: 0,
    alive: true
  };

  function t(key, values) {
    return state.i18n.t(key, values);
  }

  /** Human readable text for an error object coming from the background worker. */
  function apiErrorText(message) {
    return UI.formatApiError(message, t, S.apiErrorKey);
  }

  function el(id) {
    return document.getElementById(id);
  }

  function delay(ms) {
    return new Promise(function (resolve) {
      window.setTimeout(resolve, ms);
    });
  }

  function sendToTab(message) {
    return new Promise(function (resolve) {
      if (!state.tab || state.tab.id == null) {
        resolve(null);
        return;
      }
      chrome.tabs.sendMessage(state.tab.id, message, function (response) {
        if (chrome.runtime.lastError) {
          resolve(null);
          return;
        }
        resolve(response || null);
      });
    });
  }

  async function activeTab() {
    var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs && tabs.length ? tabs[0] : null;
  }

  function isSupportedTab(tab) {
    if (!tab || !tab.url) return false;
    return /^https?:\/\//.test(tab.url) || /^file:\/\//.test(tab.url);
  }

  function tabUrl() {
    return state.tab && typeof state.tab.url === 'string' ? state.tab.url : '';
  }

  /** Compare URLs after normalisation so a trailing slash does not look like a navigation. */
  function sameUrl(left, right) {
    if (left === right) return true;
    if (!left || !right) return false;
    try {
      return new URL(left).href === new URL(right).href;
    } catch (err) {
      return false;
    }
  }

  function cacheKeyFor(tabId, url) {
    return String(tabId == null ? '0' : tabId) + '\n' + String(url || '');
  }

  function currentCacheKey() {
    return cacheKeyFor(state.tab && state.tab.id, tabUrl());
  }

  function pageStorageKey(tabId) {
    return PAGE_KEY_PREFIX + tabId;
  }

  function notesStorageKey(tabId) {
    return NOTES_KEY_PREFIX + tabId;
  }

  function runtimeError() {
    try {
      return chrome.runtime && chrome.runtime.lastError ? chrome.runtime.lastError : null;
    } catch (err) {
      return null;
    }
  }

  function sessionArea() {
    try {
      return chrome.storage && chrome.storage.session ? chrome.storage.session : null;
    } catch (err) {
      return null;
    }
  }

  function sessionGet(key) {
    return new Promise(function (resolve) {
      var area = sessionArea();
      if (!area) {
        resolve(null);
        return;
      }
      try {
        area.get(key, function (result) {
          if (runtimeError()) {
            resolve(null);
            return;
          }
          resolve(result && Object.prototype.hasOwnProperty.call(result, key) ? result[key] : null);
        });
      } catch (err) {
        resolve(null);
      }
    });
  }

  function sessionSet(items) {
    return new Promise(function (resolve) {
      var area = sessionArea();
      if (!area) {
        resolve(false);
        return;
      }
      try {
        area.set(items, function () {
          resolve(!runtimeError());
        });
      } catch (err) {
        resolve(false);
      }
    });
  }

  function sessionRemove(key) {
    return new Promise(function (resolve) {
      var area = sessionArea();
      if (!area) {
        resolve(false);
        return;
      }
      try {
        area.remove(key, function () {
          resolve(!runtimeError());
        });
      } catch (err) {
        resolve(false);
      }
    });
  }

  /** Duplicated ids can appear after a BFCache restore, so every render path dedupes. */
  function dedupeAnnotations(list) {
    var seen = Object.create(null);
    var out = [];
    if (!Array.isArray(list)) return out;
    list.forEach(function (annotation) {
      if (!annotation || annotation.id == null) return;
      var id = String(annotation.id);
      if (seen[id]) return;
      seen[id] = true;
      out.push(annotation);
    });
    return out;
  }

  function readPageNumber(entry) {
    if (!entry || typeof entry !== 'object') return 0;
    var page = Math.floor(Number(entry.page));
    return isFinite(page) && page >= 1 ? page : 0;
  }

  function totalPages() {
    return Math.max(1, Math.ceil(state.annotations.length / PAGE_SIZE));
  }

  function persistPage() {
    if (!state.supported || !state.tab || state.tab.id == null) return;
    state.pageMemory[state.tab.id] = state.page;
    var items = {};
    items[pageStorageKey(state.tab.id)] = {
      url: tabUrl(),
      page: state.page,
      updatedAt: Date.now()
    };
    sessionSet(items);
  }

  function saveNotesSnapshot() {
    if (!state.supported || !state.tab || state.tab.id == null) return;
    var annotations = state.annotations.map(function (annotation) {
      return {
        id: annotation.id,
        text: annotation.text == null ? '' : String(annotation.text),
        color: annotation.color,
        marks: annotation.marks,
        stale: annotation.stale === true
      };
    });
    var payload = { url: tabUrl(), annotations: annotations, updatedAt: Date.now() };
    try {
      // A very large page must not push the snapshot into session quota errors.
      if (JSON.stringify(payload).length > 256 * 1024) return;
    } catch (err) {
      return;
    }
    var items = {};
    items[notesStorageKey(state.tab.id)] = payload;
    sessionSet(items);
  }

  /** Clamp to the last page only once real data exists, so a restored page is not lost. */
  function clampPage() {
    if (!state.loaded) return false;
    var total = totalPages();
    var next = Math.min(Math.max(1, state.page), total);
    if (next === state.page) return false;
    state.page = next;
    persistPage();
    return true;
  }

  function setStatus(text) {
    var node = el('notesStatus');
    if (!text) {
      if (!node.hidden) {
        node.hidden = true;
        node.textContent = '';
      }
      return;
    }
    if (node.textContent !== text) node.textContent = text;
    node.hidden = false;
  }

  /** Reuse an existing generic key instead of adding a new one: "读取数据失败". */
  function loadFailText() {
    return String(t('dataLoadFail', { s: '' })).replace(/\s*[：:]\s*$/, '');
  }

  function renderPager(total, count) {
    var pager = el('notesPager');
    var info = el('notesPageInfo');
    var prev = el('notesPrev');
    var next = el('notesNext');
    var visible = count > PAGE_SIZE;
    pager.hidden = !visible;
    if (!visible) return;
    info.textContent = t('popupPageOf', { s: state.page + ' / ' + total });
    prev.disabled = state.page <= 1;
    next.disabled = state.page >= total;
  }

  function buildNoteRow(annotation) {
    var item = document.createElement('li');
    var swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.background = swatchColor(annotation.color);
    var text = document.createElement('span');
    text.className = 'note-text';
    text.textContent = annotation.text;
    text.title = annotation.text;
    var stale = annotation.stale === true;
    if (stale) {
      // The mark is gone from the page: keep the row for the note, but make it
      // clear it cannot be jumped to any more.
      item.classList.add('is-stale');
      text.setAttribute('aria-disabled', 'true');
      text.title = t('dataStaleHint');
    } else {
      text.addEventListener('click', function () {
        sendToTab({ type: 'pg:focusAnnotation', annotationId: annotation.id }).then(function () {
          window.close();
        });
      });
    }
    var remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'icon-btn';
    remove.title = t('cardClose');
    remove.setAttribute('aria-label', t('cardClose'));
    remove.innerHTML = TRASH_ICON;
    remove.addEventListener('click', function () {
      sendToTab({ type: 'pg:removeAnnotation', annotationId: annotation.id }).then(refreshPageState);
    });
    item.appendChild(swatch);
    item.appendChild(text);
    if (stale) {
      var staleTag = document.createElement('span');
      staleTag.className = 'stale-tag';
      staleTag.textContent = t('dataStale');
      staleTag.title = t('dataStaleHint');
      item.appendChild(staleTag);
    }
    item.appendChild(remove);
    return item;
  }

  function renderNotes(force) {
    var list = el('notes');
    var empty = el('notesEmpty');
    var annotations = dedupeAnnotations(state.annotations);
    state.annotations = annotations;
    clampPage();
    var total = totalPages();
    var totalMarks = 0;
    annotations.forEach(function (annotation) {
      totalMarks += Number(annotation.marks) || 0;
    });
    var signature = [
      state.supported ? '1' : '0',
      state.loaded ? '1' : '0',
      state.page,
      total,
      totalMarks,
      annotations.map(function (annotation) {
        return [annotation.id, annotation.text, annotation.color, Number(annotation.marks) || 0].join('\u0001');
      }).join('\u0002')
    ].join('\u0000');
    if (!force && signature === state.notesSignature) {
      renderPager(total, annotations.length);
      return;
    }
    state.notesSignature = signature;

    list.textContent = '';
    el('marksCount').textContent = annotations.length ? String(totalMarks) : '0';
    if (!annotations.length) {
      empty.hidden = !state.loaded;
      empty.textContent = t('popupEmpty');
    } else {
      empty.hidden = true;
    }
    if (annotations.length) {
      var start = (state.page - 1) * PAGE_SIZE;
      annotations.slice(start, start + PAGE_SIZE).forEach(function (annotation) {
        list.appendChild(buildNoteRow(annotation));
      });
    }
    renderPager(total, annotations.length);
  }

  function changePage(delta) {
    if (!state.loaded) return;
    var total = totalPages();
    if (total <= 1) return;
    var next = Math.min(Math.max(1, state.page + delta), total);
    if (next === state.page) return;
    state.page = next;
    persistPage();
    renderNotes(false);
  }

  function renderModeCard() {
    var container = el('modes');
    var hint = el('modeHint');
    container.textContent = '';
    S.CONTEXT_MODES.forEach(function (mode) {
      var wrapper = document.createElement('label');
      wrapper.className = 'mode' + (state.settings.contextMode === mode ? ' active' : '');
      wrapper.dataset.mode = mode;
      var input = document.createElement('input');
      input.type = 'radio';
      input.name = 'pg-context-mode';
      input.value = mode;
      input.checked = state.settings.contextMode === mode;
      input.addEventListener('change', function () {
        if (!input.checked) return;
        setContextMode(mode);
      });
      var text = document.createElement('span');
      text.textContent = t(S.CONTEXT_MODE_KEYS[mode].label);
      wrapper.appendChild(input);
      wrapper.appendChild(text);
      container.appendChild(wrapper);
    });
    hint.textContent = t(S.CONTEXT_MODE_KEYS[state.settings.contextMode].hint);
  }

  function highlightMode(mode) {
    var options = el('modes').querySelectorAll('.mode');
    for (var i = 0; i < options.length; i++) {
      options[i].classList.toggle('active', options[i].dataset.mode === mode);
    }
    el('modeHint').textContent = t(S.CONTEXT_MODE_KEYS[mode].hint);
  }

  async function setContextMode(mode) {
    state.settings = await Store.saveSettings({ contextMode: mode });
    highlightMode(state.settings.contextMode);
    chrome.runtime.sendMessage({ type: 'pg:settingsSaved' }, function () { void chrome.runtime.lastError; });
    UI.toast(t('optSaved'));
  }

  function swatchColor(color) {
    return color || '#fff2a8';
  }

  var TRASH_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/></svg>';

  function renderLlmCard() {
    var ready = !!(state.settings.apiBaseUrl && state.settings.model && state.settings.apiKey);
    el('llmState').textContent = ready ? t('optOn') : t('optOff');
    el('llmHint').textContent = ready
      ? t('popupConfigReady', { s: state.settings.model })
      : t('popupConfigMissing');
  }

  function renderHeader() {
    el('title').textContent = t('appName');
    var enabled = !!(state.settings && state.settings.enabled);
    el('enabled').checked = enabled;
    el('enabled').title = enabled ? t('popupStatusOn') : t('popupStatusOff');
    var parts = [enabled ? t('popupStatusOn') : t('popupStatusOff')];
    if (state.tab && state.tab.title) parts.push(state.tab.title);
    el('status').textContent = parts.join(' · ');
    el('status').title = state.tab ? state.tab.url || '' : '';
  }

  function renderNotice() {
    var notice = el('notice');
    if (state.supported) {
      notice.hidden = true;
      notice.textContent = '';
      return;
    }
    notice.hidden = false;
    notice.textContent = t('popupNoTab');
    el('clearPage').disabled = true;
  }

  /** Ask the content script for the page state, tolerating a page that is still coming back. */
  async function queryPageState(tabId, url, seq) {
    var attempts = RETRY_COUNT + 1;
    for (var attempt = 0; attempt < attempts; attempt++) {
      if (!state.alive || seq !== state.refreshSeq) return null;
      if (!state.tab || state.tab.id !== tabId || !sameUrl(tabUrl(), url)) return null;
      var response = await sendToTab({ type: 'pg:queryState' });
      if (response && response.ok !== false && (!response.url || sameUrl(response.url, url))) {
        return response;
      }
      if (attempt < attempts - 1) await delay(RETRY_DELAY);
    }
    return null;
  }

  async function refreshPageState() {
    if (!state.supported || !state.tab || state.tab.id == null) {
      state.pageState = null;
      state.annotations = [];
      state.annotationsUrl = '';
      state.loaded = false;
      state.notesSignature = '';
      setStatus('');
      renderNotes(true);
      return;
    }

    var tabId = state.tab.id;
    var url = tabUrl();
    var seq = ++state.refreshSeq;
    var cached = state.cache[cacheKeyFor(tabId, url)];

    // Paint what we already know before the round trip so the list never blinks empty.
    if (cached) {
      state.annotations = dedupeAnnotations(cached.annotations);
      state.annotationsUrl = url;
      state.loaded = true;
      renderNotes(false);
    } else if (!state.loaded || !sameUrl(state.annotationsUrl, url)) {
      state.annotations = [];
      state.annotationsUrl = '';
      state.loaded = false;
      state.notesSignature = '';
      renderNotes(true);
    }

    if (!state.annotations.length && !state.loaded) {
      setStatus(t('fpLoading'));
    } else {
      setStatus('');
    }

    var response = await queryPageState(tabId, url, seq);
    if (!state.alive || seq !== state.refreshSeq) return;
    if (!state.tab || state.tab.id !== tabId || !sameUrl(tabUrl(), url)) return;

    if (!response) {
      // Keep whatever is on screen; only add a quiet hint.
      setStatus(loadFailText());
      renderNotes(false);
      return;
    }

    state.pageState = response;
    state.annotations = dedupeAnnotations(response.annotations);
    state.annotationsUrl = url;
    state.loaded = true;
    state.cache[cacheKeyFor(tabId, url)] = {
      url: url,
      annotations: state.annotations,
      updatedAt: Date.now()
    };
    renderNotes(false);
    setStatus('');
    persistPage();
    saveNotesSnapshot();
  }

  function scheduleRefresh(waitMs) {
    if (!state.supported) return;
    if (state.refreshTimer) {
      window.clearTimeout(state.refreshTimer);
      state.refreshTimer = 0;
    }
    state.refreshTimer = window.setTimeout(function () {
      state.refreshTimer = 0;
      refreshPageState().catch(function () { /* the status line already reports failure */ });
    }, waitMs == null ? 120 : waitMs);
  }

  function onUrlChanged() {
    state.refreshSeq += 1;
    state.page = 1;
    state.pageState = null;
    state.annotations = [];
    state.annotationsUrl = '';
    state.loaded = false;
    state.notesSignature = '';
    setStatus('');
    if (state.tab && state.tab.id != null) sessionRemove(notesStorageKey(state.tab.id));
    var cached = state.cache[currentCacheKey()];
    if (cached) {
      state.annotations = dedupeAnnotations(cached.annotations);
      state.annotationsUrl = tabUrl();
      state.loaded = true;
    }
    renderHeader();
    persistPage();
    renderNotes(true);
  }

  function onTabUpdated(tabId, changeInfo, tab) {
    if (!state.alive || !state.supported || !state.tab || tabId !== state.tab.id) return;
    var nextUrl = tab && tab.url ? tab.url : (changeInfo && changeInfo.url ? changeInfo.url : '');
    var urlChanged = !!nextUrl && !sameUrl(nextUrl, tabUrl());
    if (urlChanged) {
      state.tab.url = nextUrl;
      if (tab && tab.title) state.tab.title = tab.title;
      onUrlChanged();
    } else if (tab && tab.title && tab.title !== state.tab.title) {
      state.tab.title = tab.title;
      renderHeader();
    }
    if (urlChanged || (changeInfo && changeInfo.status === 'complete')) {
      scheduleRefresh(80);
    }
  }

  function onTabActivated(info) {
    if (!state.alive || !state.supported || !state.tab || !info || info.tabId !== state.tab.id) return;
    chrome.tabs.get(info.tabId, function (tab) {
      if (runtimeError() || !state.alive || !state.tab) return;
      if (tab && tab.url && !sameUrl(tab.url, tabUrl())) {
        state.tab.url = tab.url;
        if (tab.title) state.tab.title = tab.title;
        onUrlChanged();
      } else if (tab && tab.title && tab.title !== state.tab.title) {
        state.tab.title = tab.title;
        renderHeader();
      }
      scheduleRefresh(60);
    });
  }

  function bindTabEvents() {
    try {
      chrome.tabs.onUpdated.addListener(onTabUpdated);
      chrome.tabs.onActivated.addListener(onTabActivated);
    } catch (err) {
      /* tab events are an optimisation; the initial query still works without them */
    }
  }

  function applyStaticLabels() {
    el('modeTitle').textContent = t('popupContextMode');
    el('marksTitle').textContent = t('popupMarks');
    el('clearPage').textContent = t('popupClearPage');
    el('llmTitle').textContent = t('optApiSection');
    el('openOptions').textContent = t('popupOpenOptions');
    el('notesPrev').textContent = t('popupPrev');
    el('notesNext').textContent = t('popupNext');
    el('notesPager').setAttribute('aria-label', t('popupMarks'));
    el('version').textContent = 'PageGloss v' + chrome.runtime.getManifest().version;
    var help = el('help');
    help.textContent = t('optTitle');
    var homepage = chrome.runtime.getManifest().homepage_url;
    help.href = homepage || chrome.runtime.getURL('docs/help.html');
    help.target = homepage ? '_blank' : '_self';
  }

  function bind() {
    el('enabled').addEventListener('change', async function (event) {
      var enabled = !!event.target.checked;
      state.settings = await Store.saveSettings({ enabled: enabled });
      renderHeader();
      chrome.runtime.sendMessage({ type: 'pg:settingsSaved' }, function () { void chrome.runtime.lastError; });
    });

    el('clearPage').addEventListener('click', async function () {
      await sendToTab({ type: 'pg:clearPage' });
      await refreshPageState();
      UI.toast(t('toastCleared'));
    });

    el('notesPrev').addEventListener('click', function () {
      changePage(-1);
    });

    el('notesNext').addEventListener('click', function () {
      changePage(1);
    });

    el('openOptions').addEventListener('click', function () {
      chrome.runtime.openOptionsPage();
    });

    el('openOptions').addEventListener('auxclick', function (event) {
      if (event.button === 1) chrome.runtime.openOptionsPage();
    });

    bindTabEvents();

    window.addEventListener('unload', function () {
      state.alive = false;
      if (state.refreshTimer) {
        window.clearTimeout(state.refreshTimer);
        state.refreshTimer = 0;
      }
      UI.destroyAll();
    });
  }

  /** Restore the page number and the previous snapshot for this tab + URL before querying. */
  async function hydrateFromSession() {
    if (!state.supported || !state.tab || state.tab.id == null) {
      renderNotes(true);
      return;
    }
    var tabId = state.tab.id;
    var url = tabUrl();
    var values = await Promise.all([
      sessionGet(pageStorageKey(tabId)),
      sessionGet(notesStorageKey(tabId))
    ]);
    if (!state.alive || !state.tab || state.tab.id !== tabId || !sameUrl(tabUrl(), url)) return;

    var savedPage = readPageNumber(values[0]);
    if (savedPage && values[0] && sameUrl(values[0].url, url)) {
      state.page = savedPage;
    } else {
      state.page = 1;
      if (savedPage) persistPage();
      if (!savedPage && state.pageMemory[tabId]) state.page = state.pageMemory[tabId];
    }

    var snapshot = values[1];
    if (snapshot && sameUrl(snapshot.url, url) && Array.isArray(snapshot.annotations)) {
      var notes = dedupeAnnotations(snapshot.annotations);
      // An empty snapshot would flash a false empty state; wait for the live answer instead.
      if (notes.length) {
        state.annotations = notes;
        state.annotationsUrl = url;
        state.loaded = true;
        state.cache[cacheKeyFor(tabId, url)] = {
          url: url,
          annotations: notes,
          updatedAt: Number(snapshot.updatedAt) || Date.now()
        };
      }
    }

    renderNotes(true);
  }

  async function init() {
    state.settings = await Store.getSettings();
    state.i18n = window.PageGlossI18n.create(state.settings.language);
    document.documentElement.lang = state.i18n.lang === 'zh' ? 'zh-CN' : 'en';
    state.tab = await activeTab();
    state.supported = isSupportedTab(state.tab);
    applyStaticLabels();
    renderHeader();
    renderNotice();
    renderModeCard();
    renderLlmCard();
    bind();
    await hydrateFromSession();
    await refreshPageState();
  }

  init().catch(function (err) {
    var notice = el('notice');
    if (notice) {
      notice.hidden = false;
      notice.textContent = String(err && err.message ? err.message : err);
    }
  });
})();
