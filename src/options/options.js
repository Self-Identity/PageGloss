/* PageGloss - options page logic */
(function () {
  'use strict';

  var S = window.PageGlossShared;
  var Store = window.PageGlossStore;
  var UI = window.PageGlossUI;

  var state = {
    settings: null,
    i18n: null,
    saveTimer: 0,
    keyVisible: false
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

  /* ------------------------------------------------------------------ labels */

  function applyLabels() {
    document.documentElement.lang = state.i18n.lang === 'zh' ? 'zh-CN' : 'en';
    document.title = t('optTitle');

    el('pageTitle').textContent = t('appName');
    el('pageSub').textContent = t('optTitle');
    el('test').textContent = t('optTest');

    el('apiTitle').textContent = t('optApiSection');
    el('baseUrlLabel').textContent = t('optBaseUrl');
    el('baseUrlHint').textContent = t('optBaseUrlHint');
    el('apiKeyLabel').textContent = t('optApiKey');
    el('apiKeyHint').textContent = t('optApiKeyHint');
    el('toggleKey').textContent = state.keyVisible ? '•••' : '👁';
    el('toggleKey').title = t('optApiKey');
    el('modelLabel').textContent = t('optModel');
    el('fetchModels').textContent = t('optFetchModels');
    el('temperatureLabel').textContent = t('optTemperature');
    el('maxTokensLabel').textContent = t('optMaxTokens');
    el('streamLabel').textContent = t('optStream');
    el('systemPromptLabel').textContent = t('optSystemPrompt');
    el('systemPromptHint').textContent = t('optSystemPromptHint');
    el('resetPrompt').textContent = t('optResetPrompt');
    el('showDefaultPrompt').textContent = t('optShowDefaultPrompt');

    el('contextTitle').textContent = t('optContextSection');
    el('maxContextLabel').textContent = t('optMaxContext');
    el('markSentenceTokensLabel').textContent = t('optSentenceTokens');
    el('matchModeLabel').textContent = t('optMatchMode');
    el('matchModeSmart').textContent = t('matchSmart');
    el('matchModeLoose').textContent = t('matchLoose');
    el('matchModeStrict').textContent = t('matchStrict');
    el('matchModeHint').textContent = t(MATCH_MODE_HINTS[state.settings.matchMode] || MATCH_MODE_HINTS.smart);
    el('cardHoverOpenLabel').textContent = t('optCardHoverOpen');
    el('languageLabel').textContent = t('optLanguage');
    var autoOption = el('language').querySelector('option[value="auto"]');
    if (autoOption) autoOption.textContent = t('optLanguageAuto');

    el('dataTitle').textContent = t('optDataSection');
    el('export').textContent = t('optExport');
    el('import').textContent = t('optImport');
    el('clearAll').textContent = t('optClearAll');
  }

  function renderCacheSummary() {
    return Store.getIndexSummary().then(function (summary) {
      el('cacheSummary').textContent = t('optCacheSummary', { n: summary.pages }) +
        (summary.marks ? ' · ' + summary.marks : '');
    });
  }

  function renderForm() {
    var settings = state.settings;
    el('baseUrl').value = settings.apiBaseUrl || '';
    el('apiKey').value = settings.apiKey || '';
    el('apiKey').type = state.keyVisible ? 'text' : 'password';
    el('model').value = settings.model || '';
    el('temperature').value = String(settings.temperature);
    el('temperatureValue').textContent = String(settings.temperature);
    el('maxTokens').value = String(settings.maxTokens);
    el('stream').checked = !!settings.stream;
    el('systemPrompt').value = settings.systemPrompt || '';
    el('systemPrompt').placeholder = defaultPrompt();
    el('maxContextChars').value = String(settings.maxContextChars);
    el('markSentenceTokens').checked = !!settings.markSentenceTokens;
    renderMatchModes();
    el('cardHoverOpen').checked = !!settings.cardHoverOpen;
    el('language').value = settings.language || 'auto';
  }

  const MATCH_MODE_HINTS = {
    smart: 'matchSmartHint',
    loose: 'matchLooseHint',
    strict: 'matchStrictHint'
  };

  function renderMatchModes() {
    const inputs = document.querySelectorAll('#matchModes input[name="pg-match-mode"]');
    inputs.forEach((input) => {
      input.checked = input.value === (state.settings.matchMode || S.DEFAULT_MATCH_MODE);
      const wrapper = input.closest('.mode');
      if (wrapper) wrapper.classList.toggle('active', input.checked);
    });
    el('matchModeHint').textContent = t(MATCH_MODE_HINTS[state.settings.matchMode] || MATCH_MODE_HINTS.smart);
  }

  function defaultPrompt() {
    return state.i18n.lang === 'zh' ? S.DEFAULT_SYSTEM_PROMPT : S.DEFAULT_SYSTEM_PROMPT_EN;
  }

  /* ------------------------------------------------------------------ saving */

  function setSaveState(text) {
    el('saveState').textContent = text || '';
  }

  function collect(overrides) {
    var patch = {
      apiBaseUrl: el('baseUrl').value.trim(),
      apiKey: el('apiKey').value,
      model: el('model').value.trim(),
      temperature: Number(el('temperature').value),
      maxTokens: Number(el('maxTokens').value),
      stream: el('stream').checked,
      systemPrompt: el('systemPrompt').value,
      maxContextChars: Number(el('maxContextChars').value),
      markSentenceTokens: el('markSentenceTokens').checked,
      matchMode: (document.querySelector('#matchModes input[name="pg-match-mode"]:checked') || {}).value || state.settings.matchMode,
      cardHoverOpen: el('cardHoverOpen').checked,
      language: el('language').value
    };
    if (overrides) Object.keys(overrides).forEach(function (key) { patch[key] = overrides[key]; });
    return patch;
  }

  async function ensureOriginPermission(rawUrl) {
    var origin = S.baseUrlOrigin(rawUrl);
    if (!origin) return false;
    try {
      if (await chrome.permissions.contains({ origins: [origin] })) return true;
      return await chrome.permissions.request({ origins: [origin] });
    } catch (err) {
      return false;
    }
  }

  async function save(patch, options) {
    var opts = options || {};
    var next = await Store.saveSettings(patch || collect());
    if (next.apiBaseUrl) {
      var grant = await ensureOriginPermission(next.apiBaseUrl);
      next.apiBaseUrl = S.normalizeBaseUrl(next.apiBaseUrl);
      next = await Store.saveSettings({ apiBaseUrl: next.apiBaseUrl });
      if (!grant) {
        UI.toast(t('errPermission'), { duration: 5200 });
      }
    }
    state.settings = next;
    if (opts.render !== false) renderForm();
    setSaveState(t('optSaved'));
    chrome.runtime.sendMessage({ type: 'pg:settingsSaved' }, function () { void chrome.runtime.lastError; });
    return next;
  }

  function scheduleSave() {
    setSaveState('…');
    window.clearTimeout(state.saveTimer);
    state.saveTimer = window.setTimeout(function () {
      save(null, { render: false }).catch(function (err) {
        setSaveState(t('optSaveFailed') + ' ' + String(err && err.message ? err.message : err));
      });
    }, 500);
  }

  /* ----------------------------------------------------------------- actions */

  async function testConnection() {
    el('test').disabled = true;
    setSaveState(t('optTesting'));
    var settings = await Store.saveSettings(collect());
    state.settings = settings;
    if (!settings.apiBaseUrl) {
      el('test').disabled = false;
      setSaveState(t('optNeedUrl'));
      UI.toast(t('optNeedUrl'), { duration: 5200 });
      return;
    }
    if (!settings.apiKey) {
      el('test').disabled = false;
      setSaveState(t('optNeedKey'));
      UI.toast(t('optNeedKey'), { duration: 5200 });
      return;
    }
    var originGranted = await ensureOriginPermission(settings.apiBaseUrl);
    chrome.runtime.sendMessage({ type: 'pg:testConnection', settings: settings }, function (response) {
      el('test').disabled = false;
      if (chrome.runtime.lastError) {
        setSaveState(t('optTestFail', { s: chrome.runtime.lastError.message }));
        return;
      }
      if (!response || !response.ok) {
        var detail = response && response.code === 'permission' && !originGranted
          ? t('errPermission')
          : apiErrorText(response || {});
        setSaveState(t('optTestFail', { s: detail }));
        UI.toast(t('optTestFail', { s: detail }), { duration: 7000 });
        return;
      }
      setSaveState(t('optTestOk'));
      UI.toast(t('optTestOk'));
    });
  }

  function fetchModels() {
    el('fetchModels').disabled = true;
    var settings = Object.assign({}, state.settings, collect());
    ensureOriginPermission(settings.apiBaseUrl).then(function () {
      chrome.runtime.sendMessage({ type: 'pg:listModels', settings: settings }, function (response) {
        el('fetchModels').disabled = false;
        if (chrome.runtime.lastError) {
          UI.toast(t('optModelsFail', { s: chrome.runtime.lastError.message }), { duration: 6000 });
          return;
        }
        if (!response || !response.ok) {
          // Show the provider's own message plus an actionable hint instead of
          // the bare error code.
          UI.toast(t('optModelsFail', { s: apiErrorText(response || {}) }), { duration: 7000 });
          return;
        }
        var list = el('modelList');
        list.textContent = '';
        response.models.forEach(function (name) {
          var option = document.createElement('option');
          option.value = name;
          list.appendChild(option);
        });
        if (!el('model').value && response.models.length) {
          el('model').value = response.models[0];
          scheduleSave();
        }
        UI.toast(t('optModelsOk', { n: response.models.length }));
      });
    });
  }

  function exportData() {
    Store.exportAll().then(function (payload) {
      var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var anchor = document.createElement('a');
      var stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      anchor.href = url;
      anchor.download = 'pagegloss-backup-' + stamp + '.json';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    }).catch(function (err) {
      UI.toast(String(err && err.message ? err.message : err));
    });
  }

  function importData(file) {
    var reader = new FileReader();
    reader.onload = function () {
      var payload;
      try {
        payload = JSON.parse(String(reader.result || ''));
      } catch (err) {
        UI.toast(t('optImportFail'), { duration: 4800 });
        return;
      }
      Store.importAll(payload, { includeSettings: false }).then(function (count) {
        UI.toast(t('optImportOk', { n: count }));
        return renderCacheSummary();
      }).catch(function () {
        UI.toast(t('optImportFail'), { duration: 4800 });
      });
    };
    reader.onerror = function () { UI.toast(t('optImportFail'), { duration: 4800 }); };
    reader.readAsText(file);
  }

  function clearAll() {
    if (!window.confirm(t('optClearConfirm'))) return;
    Store.clearAll().then(function () {
      UI.toast(t('optCleared'));
      return renderCacheSummary();
    });
  }

  /* ------------------------------------------------------------------- wiring */

  function bind() {
    ['baseUrl', 'apiKey', 'model', 'maxTokens', 'systemPrompt', 'maxContextChars'].forEach(function (id) {
      el(id).addEventListener('input', scheduleSave);
      el(id).addEventListener('change', scheduleSave);
    });
    ['stream', 'markSentenceTokens', 'cardHoverOpen'].forEach(function (id) {
      el(id).addEventListener('change', scheduleSave);
    });

    el('temperature').addEventListener('input', function () {
      el('temperatureValue').textContent = Number(el('temperature').value).toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
      scheduleSave();
    });

    el('language').addEventListener('change', function () {
      state.settings = Store.normalizeSettings(Object.assign({}, state.settings, { language: el('language').value }));
      state.i18n = window.PageGlossI18n.create(state.settings.language);
      applyLabels();
      renderForm();
      scheduleSave();
    });

    el('toggleKey').addEventListener('click', function () {
      state.keyVisible = !state.keyVisible;
      el('apiKey').type = state.keyVisible ? 'text' : 'password';
      el('toggleKey').textContent = state.keyVisible ? '•••' : '👁';
    });

    el('resetPrompt').addEventListener('click', function () {
      el('systemPrompt').value = '';
      save({ systemPrompt: '' });
    });

    el('showDefaultPrompt').addEventListener('click', function () {
      el('systemPrompt').value = defaultPrompt();
      el('systemPrompt').focus();
      scheduleSave();
    });

    el('test').addEventListener('click', testConnection);
    el('fetchModels').addEventListener('click', fetchModels);
    el('export').addEventListener('click', exportData);
    el('import').addEventListener('click', function () { el('importFile').click(); });
    el('importFile').addEventListener('change', function (event) {
      var file = event.target.files && event.target.files[0];
      if (file) importData(file);
      event.target.value = '';
    });
    el('clearAll').addEventListener('click', clearAll);

    document.querySelectorAll('#matchModes input[name="pg-match-mode"]').forEach((input) => {
      input.addEventListener('change', function () {
        if (!input.checked) return;
        state.settings = Store.normalizeSettings(Object.assign({}, state.settings, { matchMode: input.value }));
        renderMatchModes();
        scheduleSave();
      });
    });

    window.addEventListener('beforeunload', function () {
      window.clearTimeout(state.saveTimer);
      UI.destroyAll();
    });
  }

  async function init() {
    state.settings = await Store.getSettings();
    state.i18n = window.PageGlossI18n.create(state.settings.language);
    applyLabels();
    renderForm();
    bind();
    await renderCacheSummary();
    setSaveState('');
  }

  init().catch(function (err) {
    setSaveState(String(err && err.message ? err.message : err));
  });
})();
