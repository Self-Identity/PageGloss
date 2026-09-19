/*
 * PageGloss - service worker.
 * Owns the context menu, the OpenAI-compatible request pipeline and the
 * streaming bridge back to the content script.
 */
import {
  DEFAULT_SYSTEM_PROMPT,
  DEFAULT_SYSTEM_PROMPT_EN,
  hasChinese,
  getSettings,
  saveSettings,
  normalizeSettings
} from '../shared/shared.mjs';

// Version banner: open chrome://extensions -> the extension's "Service worker"
// console to confirm which build is actually running. If this line is missing
// after a reload, Chrome is still serving a stale registration or an older
// unpacked folder.
const BUILD_VERSION = '1.0.0';
console.info('[PageGloss] service worker ' + BUILD_VERSION + ' loaded (modules: shared.mjs)');

const MENU_IDS = {
  mark: 'pg-mark',
  unmarkOne: 'pg-unmark-one',
  unmarkTerm: 'pg-unmark-term',
  unmarkAll: 'pg-unmark-all',
  paused: 'pg-paused'
};

const MENU_TITLES = {
  zh: {
    mark: 'PageGloss：标记并解释“%s”',
    markShort: 'PageGloss：标记并解释所选文本',
    unmarkOne: 'PageGloss：取消此处标记',
    unmarkTerm: 'PageGloss：取消“%s”的全部标记',
    unmarkAll: 'PageGloss：清空本页全部标记',
    paused: 'PageGloss（本页已暂停）'
  },
  en: {
    mark: 'PageGloss: mark and explain “%s”',
    markShort: 'PageGloss: mark and explain selection',
    unmarkOne: 'PageGloss: unmark this occurrence',
    unmarkTerm: 'PageGloss: unmark all “%s”',
    unmarkAll: 'PageGloss: clear all marks on this page',
    paused: 'PageGloss (paused on this page)'
  }
};

const PENDING = { mark: '', unmarkTerm: '' };
const activeStreams = new Map();
// Last settings snapshot we broadcast, used to re-broadcast from the explicit
// "settings saved" message without spamming every tab.
let lastBroadcast = null;

function uiLanguage(settings) {
  if (settings && settings.language && settings.language !== 'auto') return settings.language;
  let language = 'zh';
  try {
    language = (chrome.i18n.getUILanguage() || 'zh').toLowerCase();
  } catch (err) {
    language = 'zh';
  }
  return language.startsWith('zh') ? 'zh' : 'en';
}

function truncateLabel(text, limit = 32) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (value.length <= limit) return value;
  return value.slice(0, limit - 1) + '…';
}

async function rebuildMenus() {
  const settings = await getSettings();
  const lang = uiLanguage(settings);
  const strings = MENU_TITLES[lang];
  PENDING.mark = strings.mark;
  PENDING.unmarkTerm = strings.unmarkTerm;

  await new Promise((resolve) => {
    // removeAll + create must not interleave with another rebuild, otherwise
    // Chrome reports "Cannot create item with duplicate id".
    chrome.contextMenus.removeAll(() => {
      void chrome.runtime.lastError;
      const enabled = settings.enabled;

      chrome.contextMenus.create({
        id: MENU_IDS.mark,
        title: strings.markShort,
        contexts: ['selection'],
        enabled: enabled
      });

      chrome.contextMenus.create({
        id: MENU_IDS.unmarkOne,
        title: strings.unmarkOne,
        contexts: ['all'],
        enabled: enabled
      });

      chrome.contextMenus.create({
        id: MENU_IDS.unmarkTerm,
        title: strings.unmarkTerm.replace('%s', '…'),
        contexts: ['all'],
        enabled: enabled
      });

      chrome.contextMenus.create({
        id: MENU_IDS.unmarkAll,
        title: strings.unmarkAll,
        contexts: ['all'],
        enabled: enabled
      });

      if (!enabled) {
        chrome.contextMenus.create({
          id: MENU_IDS.paused,
          title: strings.paused,
          contexts: ['selection'],
          enabled: false
        });
      }
      void chrome.runtime.lastError;
      resolve(true);
    });
  });
}

let menuChain = Promise.resolve();

/**
 * Serialised menu rebuild. Every caller waits for its own rebuild to finish, and
 * concurrent triggers (install + startup + settings change) run one after the
 * other instead of racing each other into duplicate ids.
 */
function queueMenuRebuild() {
  menuChain = menuChain
    .catch(() => {})
    .then(() => rebuildMenus())
    .catch((err) => {
      console.warn('[PageGloss] context menu rebuild failed:', err && err.message ? err.message : err);
    });
  return menuChain;
}

// Whatever triggered this worker to start (install, browser start or a cold
// wake-up), make sure the menus exist exactly once.
void queueMenuRebuild();

function setMenuTitle(id, title) {
  if (!title) return;
  try {
    chrome.contextMenus.update(id, { title }, () => void chrome.runtime.lastError);
  } catch (err) {
    // Menu may already be gone; ignore.
  }
}

chrome.runtime.onInstalled.addListener(() => {
  void queueMenuRebuild();
});

chrome.runtime.onStartup.addListener(() => {
  void queueMenuRebuild();
});

/* -------------------------------------------------------------- tab broadcasts */

// Settings keys that change how the content script renders a page. Only these
// force a page reload; everything else is applied silently to avoid reload storms.
const RELOAD_KEYS = ['contextMode', 'markSentenceTokens', 'cardHoverOpen', 'apiBaseUrl', 'enabled'];

function reloadSensitiveChanged(previous, next) {
  return RELOAD_KEYS.some((key) => String(previous[key]) !== String(next[key]));
}

async function broadcastSettingsChange(previous, next) {
  const needsReload = reloadSensitiveChanged(previous, next);
  lastBroadcast = next;
  const tabs = await chrome.tabs.query({});
  tabs.forEach((tab) => {
    if (tab.id == null || !tab.url || !/^(https?|file):/.test(tab.url)) return;
    forwardToTab(tab.id, needsReload ? { type: 'pg:settingsChanged', settings: next } : { type: 'pg:enabledChanged', enabled: next.enabled });
  });
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  if (!changes['pg:settings']) return;
  void queueMenuRebuild();
  const previous = normalizeSettings(changes['pg:settings'].oldValue || {});
  const next = normalizeSettings(changes['pg:settings'].newValue || {});
  if (JSON.stringify(previous) === JSON.stringify(next)) return;
  broadcastSettingsChange(previous, next).catch(() => {});
});

/* ------------------------------------------------------------- context menus */

function forwardToTab(tabId, message) {
  chrome.tabs.sendMessage(tabId, message, () => void chrome.runtime.lastError);
}

/**
 * The context menu only reports the selected text; the content script performs
 * the marking and unmarking so every DOM decision stays in one place. The
 * background worker only routes the click and refreshes the dynamic labels.
 */
// Keeps the shared mark label useful while the user highlights text.
if (chrome.contextMenus.onShown) {
  chrome.contextMenus.onShown.addListener((info) => {
    refreshDynamicMenuTitles(info);
    try {
      chrome.contextMenus.refresh();
    } catch (err) {
      // refresh() throws if the menu was not fully built yet.
    }
  });
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab || tab.id == null) return;
  const selection = String(info.selectionText || '').replace(/\s+/g, ' ').trim();
  if (info.menuItemId === MENU_IDS.mark) {
    forwardToTab(tab.id, { type: 'pg:markSelection', selection });
    return;
  }
  if (info.menuItemId === MENU_IDS.unmarkOne) {
    forwardToTab(tab.id, { type: 'pg:removeOccurrenceAtPoint' });
    return;
  }
  if (info.menuItemId === MENU_IDS.unmarkTerm) {
    forwardToTab(tab.id, { type: 'pg:removeTermAtPoint' });
    return;
  }
  if (info.menuItemId === MENU_IDS.unmarkAll) {
    forwardToTab(tab.id, { type: 'pg:clearPage' });
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'complete') void queueMenuRebuild();
});

/* ---------------------------------------------------------------- shortcut key */

if (chrome.commands && chrome.commands.onCommand) {
  chrome.commands.onCommand.addListener(async (command) => {
    if (command !== 'toggle-mark-mode') return;
    const settings = await getSettings();
    const enabled = !settings.enabled;
    await saveSettings({ enabled });
    await queueMenuRebuild();
    const tabs = await chrome.tabs.query({});
    tabs.forEach((tab) => {
      if (tab.id != null && tab.url && /^(https?|file):/.test(tab.url)) {
        forwardToTab(tab.id, { type: 'pg:enabledChanged', enabled });
      }
    });
  });
}

/* -------------------------------------------------------------- LLM pipeline */

function resolveSystemPrompt(settings) {
  const custom = (settings.systemPrompt || '').trim();
  if (custom) return custom;
  if (settings.language === 'en') return DEFAULT_SYSTEM_PROMPT_EN;
  if (settings.language === 'zh') return DEFAULT_SYSTEM_PROMPT;
  return hasChinese(settings.sampleText || '') ? DEFAULT_SYSTEM_PROMPT : DEFAULT_SYSTEM_PROMPT_EN;
}

function contextBlock(context) {
  const parts = [];
  parts.push('页面标题：' + (context.title || '(无标题)'));
  parts.push('页面网址：' + (context.url || ''));
  if (context.sentence) parts.push('该段文本所在的完整句子：\n' + context.sentence);

  if (context.mode === 'page') {
    if (context.section) parts.push('该段文本所在章节（节选）：\n' + context.section);
    if (context.pageText) parts.push('页面全部正文：\n' + context.pageText);
  } else if (context.mode === 'section') {
    if (context.section) parts.push('该段文本所在章节：\n' + context.section);
    if (context.excerpts) parts.push('页面中与该词相关的关键片段：\n' + context.excerpts);
  } else {
    if (context.section) parts.push('该段文本上下文：\n' + context.section);
  }
  if (context.truncated) parts.push('（提示：页面内容过长，已自动截断。）');
  return parts.join('\n\n');
}

function explainPrompt(term, context) {
  return [
    '页面内容如下：',
    '',
    contextBlock(context),
    '',
    '──────',
    '问题：在“' + (context.sentence || term) + '”这句话里，“' + term + '”是什么意思？',
    '',
    '请先用一句话给出它在本页语境下的含义，再补充 2-4 条要点。'
  ].join('\n');
}

function askPrompt(term, question, context) {
  return [
    '页面内容如下：',
    '',
    contextBlock(context),
    '',
    '──────',
    '正在讨论的词语/短语：“' + term + '”',
    '用户追问：' + question
  ].join('\n');
}

function buildMessages(settings, payload) {
  const context = payload.context || {};
  const term = payload.term || '';
  const sample = term + ' ' + (context.sentence || '') + ' ' + (context.section || '') + ' ' + (context.pageText || '');
  const system = resolveSystemPrompt(Object.assign({}, settings, { sampleText: sample }));
  const messages = [{ role: 'system', content: system }];

  if (payload.kind === 'ask' && Array.isArray(payload.history) && payload.history.length) {
    const history = payload.history.slice(-20);
    history.forEach((item) => {
      if (!item || !item.content) return;
      messages.push({ role: item.role === 'user' ? 'user' : 'assistant', content: String(item.content) });
    });
    messages.push({ role: 'user', content: askPrompt(term, payload.question || '', context) });
    return messages;
  }

  messages.push({ role: 'user', content: explainPrompt(term, context) });
  return messages;
}

async function ensureHostPermission(url) {
  let origin = '';
  try {
    origin = new URL(url).origin + '/*';
  } catch (err) {
    return false;
  }
  try {
    if (await chrome.permissions.contains({ origins: [origin] })) return true;
    return await chrome.permissions.request({ origins: [origin] });
  } catch (err) {
    return false;
  }
}

function classifyHttpError(status, bodyText) {
  let detail = String(bodyText || '').slice(0, 300);
  try {
    const parsed = JSON.parse(bodyText);
    if (parsed && parsed.error) {
      detail = parsed.error.message || parsed.error.type || detail;
    } else if (parsed && parsed.message) {
      detail = parsed.message;
    }
  } catch (err) { /* keep raw text */ }
  return { code: 'http', status, detail };
}

async function performRequest(settings, payload, onToken, signal) {
  const endpoint = settings.apiBaseUrl;
  if (!endpoint) return { error: { code: 'no-config' } };
  if (!settings.apiKey) return { error: { code: 'no-key' } };
  if (!(await ensureHostPermission(endpoint))) return { error: { code: 'permission' } };

  const timeoutMs = Math.max(5000, Math.min(600000, Number(settings.requestTimeoutMs) || 60000));
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => {
    try {
      controller.abort();
    } catch (err) { /* ignore */ }
  };
  if (signal) {
    if (signal.aborted) abortFromCaller();
    else signal.addEventListener('abort', abortFromCaller, { once: true });
  }
  const timer = setTimeout(() => {
    timedOut = true;
    abortFromCaller();
  }, timeoutMs);

  const cleanup = () => {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', abortFromCaller);
  };

  const body = {
    model: settings.model,
    messages: buildMessages(settings, payload),
    temperature: settings.temperature,
    max_tokens: settings.maxTokens,
    stream: !!settings.stream
  };

  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + settings.apiKey
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (err) {
    cleanup();
    if (timedOut) return { error: { code: 'timeout', timeoutMs } };
    if (err && err.name === 'AbortError') return { error: { code: 'aborted' } };
    return { error: { code: 'network', detail: String(err && err.message ? err.message : err) } };
  }

  if (!response.ok) {
    cleanup();
    const text = await response.text().catch(() => '');
    return { error: classifyHttpError(response.status, text) };
  }

  if (!settings.stream || !response.body) {
    let parsed;
    try {
      parsed = await response.json();
    } catch (err) {
      cleanup();
      if (timedOut) return { error: { code: 'timeout', timeoutMs } };
      return { error: { code: 'network', detail: 'invalid JSON response' } };
    }
    cleanup();
    const text = extractContent(parsed);
    if (!text) return { error: { code: 'empty' } };
    return { text };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let full = '';

  while (true) {
    let chunk;
    try {
      chunk = await reader.read();
    } catch (err) {
      cleanup();
      if (timedOut) return { error: { code: 'timeout', timeoutMs, partial: full } };
      if (err && err.name === 'AbortError') return { text: full, aborted: true };
      return { error: { code: 'network', detail: String(err && err.message ? err.message : err) } };
    }
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith(':')) continue;
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      let parsed;
      try {
        parsed = JSON.parse(data);
      } catch (err) {
        continue;
      }
      const delta = extractDelta(parsed);
      if (delta) {
        full += delta;
        onToken(delta);
      }
    }
  }

  cleanup();
  if (!full) return { error: { code: 'empty' } };
  return { text: full };
}

function extractDelta(parsed) {
  if (!parsed) return '';
  const choices = parsed.choices;
  if (Array.isArray(choices) && choices.length) {
    const choice = choices[0];
    if (choice.delta && typeof choice.delta.content === 'string') return choice.delta.content;
    if (choice.delta && Array.isArray(choice.delta.content)) {
      return choice.delta.content.map((part) => (part && part.text) || '').join('');
    }
    if (typeof choice.text === 'string') return choice.text;
  }
  if (typeof parsed.delta === 'string') return parsed.delta;
  return '';
}

function extractContent(parsed) {
  if (!parsed) return '';
  const choices = parsed.choices;
  if (Array.isArray(choices) && choices.length) {
    const choice = choices[0];
    if (choice.message && typeof choice.message.content === 'string') return choice.message.content;
    if (choice.message && Array.isArray(choice.message.content)) {
      return choice.message.content.map((part) => (part && part.text) || '').join('');
    }
    if (typeof choice.text === 'string') return choice.text;
  }
  if (typeof parsed.output_text === 'string') return parsed.output_text;
  return '';
}

/* --------------------------------------------------------------- port bridge */

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'pagegloss-llm') return;
  const controller = new AbortController();
  const stateKey = Math.random().toString(36).slice(2);
  activeStreams.set(stateKey, controller);

  const post = (message) => {
    try {
      port.postMessage(message);
    } catch (err) {
      // Port already closed by the page.
    }
  };

  port.onDisconnect.addListener(() => {
    try {
      controller.abort();
    } catch (err) { /* ignore */ }
    activeStreams.delete(stateKey);
  });

  port.onMessage.addListener(async (message) => {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'llm:abort') {
      controller.abort();
      return;
    }
    if (message.type !== 'llm:start') return;
    const settings = await getSettings();
    const payload = message.payload || {};
    const result = await performRequest(settings, payload, (delta) => {
      post({ type: 'token', delta });
    }, controller.signal);
    if (result.aborted) {
      post({ type: 'error', code: 'aborted' });
      return;
    }
    if (result.error) {
      post(Object.assign({ type: 'error' }, result.error));
      return;
    }
    post({ type: 'done', text: result.text });
  });
});

/* -------------------------------------------------------------- one-shot API */

async function handleRequest(message, sender) {
  if (message.type === 'pg:openOptions') {
    // The content script cannot call openOptionsPage itself, so it asks here.
    try {
      if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
      else chrome.tabs.create({ url: chrome.runtime.getURL('src/options/options.html') });
      return { ok: true };
    } catch (err) {
      return { ok: false, code: 'network', detail: String(err && err.message ? err.message : err) };
    }
  }
  if (message.type === 'pg:testConnection') {
    const settings = normalizeSettings(Object.assign({}, await getSettings(), message.settings || {}, {
      stream: false,
      // Keep the probe cheap and quick: a handful of tokens is enough to prove
      // the endpoint, the key and the model all work.
      maxTokens: Math.min(32, Number(message.settings && message.settings.maxTokens) || 32)
    }));
    if (!settings.apiBaseUrl) return { ok: false, code: 'no-config' };
    if (!settings.apiKey) return { ok: false, code: 'no-key' };
    const result = await performRequest(settings, {
      kind: 'explain',
      term: 'test',
      context: { mode: 'sentence', title: 'connection test', url: 'about:blank', sentence: 'This is a connection test.', section: '' }
    }, () => {}, new AbortController().signal);
    if (result.error) return { ok: false, ...result.error };
    return { ok: true, sample: String(result.text || '').slice(0, 200) };
  }
  if (message.type === 'pg:listModels') {
    const settings = normalizeSettings(Object.assign({}, await getSettings(), message.settings || {}));
    if (!settings.apiBaseUrl) return { ok: false, code: 'no-config' };
    if (!settings.apiKey) return { ok: false, code: 'no-key' };
    const granted = await ensureHostPermission(settings.apiBaseUrl);
    if (!granted) return { ok: false, code: 'permission' };
    const url = settings.apiBaseUrl.replace(/\/chat\/completions$/, '/models');
    try {
      const response = await fetch(url, {
        headers: settings.apiKey ? { Authorization: 'Bearer ' + settings.apiKey } : {}
      });
      if (!response.ok) return { ok: false, code: 'http', status: response.status, detail: await response.text().catch(() => '') };
      const parsed = await response.json();
      const list = Array.isArray(parsed && parsed.data)
        ? parsed.data.map((item) => (typeof item === 'string' ? item : item && item.id)).filter(Boolean)
        : [];
      return { ok: true, models: list };
    } catch (err) {
      return { ok: false, code: 'network', detail: String(err && err.message ? err.message : err) };
    }
  }
  if (message.type === 'pg:settingsSaved') {
    await queueMenuRebuild();
    const next = await getSettings();
    const previous = lastBroadcast || normalizeSettings({});
    if (JSON.stringify(previous) !== JSON.stringify(next)) {
      await broadcastSettingsChange(previous, next);
    }
    return { ok: true };
  }
  return { ok: false, code: 'unknown' };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object' || typeof message.type !== 'string') return undefined;
  if (message.type.startsWith('pg:')) {
    handleRequest(message, sender).then(sendResponse).catch((err) => {
      sendResponse({ ok: false, code: 'network', detail: String(err && err.message ? err.message : err) });
    });
    return true;
  }
  return undefined;
});

/* ---------------------------------------------------------------- menu labels */

function refreshDynamicMenuTitles(info) {
  const selection = String(info && info.selectionText || '').replace(/\s+/g, ' ').trim();
  if (selection && PENDING.mark) {
    setMenuTitle(MENU_IDS.mark, PENDING.mark.replace('%s', truncateLabel(selection)));
  } else if (PENDING.mark) {
    setMenuTitle(MENU_IDS.mark, PENDING.mark.replace('%s', '…'));
  }
}
