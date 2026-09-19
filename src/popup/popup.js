/* PageGloss - popup logic */
(function () {
  'use strict';

  var S = window.PageGlossShared;
  var Store = window.PageGlossStore;
  var UI = window.PageGlossUI;
  var state = {
    settings: null,
    tab: null,
    supported: false,
    pageState: null,
    i18n: null
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

  function renderNotes() {
    var list = el('notes');
    var empty = el('notesEmpty');
    list.textContent = '';
    var annotations = state.pageState && Array.isArray(state.pageState.annotations) ? state.pageState.annotations : [];
    el('marksCount').textContent = String(annotations.length);
    if (!annotations.length) {
      empty.hidden = false;
      empty.textContent = t('popupMarksValue', { n: 0, m: 0 });
      return;
    }
    empty.hidden = true;
    var total = 0;
    annotations.forEach(function (annotation) {
      total += Number(annotation.marks) || 0;
      var item = document.createElement('li');
      var swatch = document.createElement('span');
      swatch.className = 'swatch';
      swatch.style.background = swatchColor(annotation.color);
      var text = document.createElement('span');
      text.className = 'note-text';
      text.textContent = annotation.text;
      text.title = annotation.text;
      text.addEventListener('click', function () {
        sendToTab({ type: 'pg:focusAnnotation', annotationId: annotation.id }).then(function () {
          window.close();
        });
      });
      var meta = document.createElement('span');
      meta.className = 'note-meta';
      meta.textContent = '×' + (Number(annotation.marks) || 0);
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
      item.appendChild(meta);
      item.appendChild(remove);
      list.appendChild(item);
    });
    el('marksCount').textContent = String(total);
  }

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

  async function refreshPageState() {
    if (!state.supported) {
      state.pageState = null;
      renderNotes();
      return;
    }
    var response = await sendToTab({ type: 'pg:queryState' });
    state.pageState = response;
    renderNotes();
  }

  function applyStaticLabels() {
    el('modeTitle').textContent = t('popupContextMode');
    el('marksTitle').textContent = t('popupMarks');
    el('clearPage').textContent = t('popupClearPage');
    el('llmTitle').textContent = t('optApiSection');
    el('openOptions').textContent = t('popupOpenOptions');
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

    el('openOptions').addEventListener('click', function () {
      chrome.runtime.openOptionsPage();
    });

    el('openOptions').addEventListener('auxclick', function (event) {
      if (event.button === 1) chrome.runtime.openOptionsPage();
    });

    window.addEventListener('unload', function () {
      UI.destroyAll();
    });
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
