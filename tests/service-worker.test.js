/*
 * PageGloss - service worker pipeline test.
 *
 * Loads the real service worker against fake chrome APIs and a fake fetch, then
 * verifies the OpenAI-compatible request pipeline: prompt assembly for all three
 * context modes, SSE streaming deltas, error mapping, the abort path and the
 * context menu wiring.
 *
 * Run with: node tests/service-worker.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SW_PATH = path.join(ROOT, 'src', 'background', 'service-worker.js');

/* --------------------------------------------------------------- chrome stub */

function createChromeStub() {
  const storageData = new Map();
  const listener = { onMessage: [], onConnect: [], onInstalled: [], onStartup: [], onCommand: [], onChanged: [] };
  const stub = {
    storageData,
    listeners: listener,
    menus: [],
    menuUpdates: [],
    tabMessages: [],
    lastMenuCreateOptions: null,
    runtime: {
      lastError: null,
      onInstalled: { addListener: (fn) => listener.onInstalled.push(fn) },
      onStartup: { addListener: (fn) => listener.onStartup.push(fn) },
      onMessage: { addListener: (fn) => listener.onMessage.push(fn) },
      onConnect: { addListener: (fn) => listener.onConnect.push(fn) },
      getURL: (value) => 'chrome-extension://stub/' + value
    },
    contextMenus: {
      removeAll: (callback) => {
        stub.menus = [];
        callback();
      },
      create: (options) => {
        // Chrome throws when the same id is created twice, which is exactly what
        // a racing removeAll/create pair produces.
        if (stub.menus.some((menu) => menu.id === options.id)) {
          throw new Error(`Cannot create item with duplicate id ${options.id}`);
        }
        stub.menus.push(options);
        stub.lastMenuCreateOptions = options;
        return options.id;
      },
      update: (id, changes) => {
        stub.menuUpdates.push({ id, changes });
      },
      onClicked: { addListener: () => {} },
      onShown: { addListener: () => {} }
    },
    tabs: {
      query: async () => [{ id: 1, url: 'https://example.com/a' }, { id: 2, url: 'chrome://extensions' }],
      sendMessage: (tabId, message) => {
        stub.tabMessages.push({ tabId, message });
      },
      onUpdated: { addListener: () => {} }
    },
    permissions: {
      contains: async () => true,
      request: async () => true
    },
    i18n: { getUILanguage: () => 'zh-CN' },
    commands: { onCommand: { addListener: (fn) => listener.onCommand.push(fn) } },
    storage: {
      local: {
        get: (keys, callback) => callback(stubStorageGet(keys)),
        set: (items, callback) => {
          Object.keys(items).forEach((key) => storageData.set(key, items[key]));
          if (callback) callback();
        },
        remove: (keys, callback) => {
          (Array.isArray(keys) ? keys : [keys]).forEach((key) => storageData.delete(key));
          if (callback) callback();
        }
      },
      onChanged: { addListener: (fn) => listener.onChanged.push(fn) }
    }
  };

  function stubStorageGet(keys) {
    if (keys == null) {
      const out = {};
      storageData.forEach((value, key) => { out[key] = value; });
      return out;
    }
    if (Array.isArray(keys)) {
      const out = {};
      keys.forEach((key) => { if (storageData.has(key)) out[key] = storageData.get(key); });
      return out;
    }
    if (typeof keys === 'string') return storageData.has(keys) ? { [keys]: storageData.get(keys) } : {};
    const out = {};
    Object.keys(keys).forEach((key) => { out[key] = storageData.has(key) ? storageData.get(key) : keys[key]; });
    return out;
  }

  return stub;
}

/* ------------------------------------------------------------------ loading */

function loadServiceWorker(chrome, fetchImpl) {
  let source = fs.readFileSync(SW_PATH, 'utf8');
  source = source.replace(/^import\s+[\s\S]*?from\s+['"][^'"]+['"];?[ \t]*$/gm, '');

  const sandbox = vm.createContext({
    chrome,
    fetch: fetchImpl,
    console,
    Promise,
    Map,
    Set,
    Date,
    Math,
    JSON,
    URL,
    TextDecoder,
    AbortController,
    setTimeout,
    clearTimeout
  });
  sandbox.globalThis = sandbox;
  sandbox.module = { exports: {} };
  // The classic scripts run in order, exactly like the manifest content script list.
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/shared/messages.js'), 'utf8'), sandbox, { filename: 'messages.js' });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/shared/storage.js'), 'utf8'), sandbox, { filename: 'storage.js' });
  sandbox.__shared = sandbox.PageGlossShared;
  sandbox.__store = sandbox.PageGlossStore;
  if (!sandbox.__shared || !sandbox.__store) {
    throw new Error('shared classic scripts did not publish their globals');
  }
  vm.runInContext('const { DEFAULT_SYSTEM_PROMPT, DEFAULT_SYSTEM_PROMPT_EN, hasChinese } = __shared;\n' +
    'const { getSettings, saveSettings, normalizeSettings } = __store;\n' +
    source, sandbox, { filename: 'service-worker.js' });
  return sandbox;
}

/* ------------------------------------------------------------------ fetch fakes */

function sseResponse(chunks, options) {
  const opts = options || {};
  const encoder = new TextEncoder();
  let index = 0;
  const body = {
    getReader() {
      return {
        read: async () => {
          if (index >= chunks.length) return { done: true, value: undefined };
          const chunk = chunks[index++];
          if (opts.delayMs) await new Promise((resolve) => setTimeout(resolve, opts.delayMs));
          return { done: false, value: encoder.encode(chunk) };
        }
      };
    }
  };
  return { ok: true, status: 200, body, json: async () => ({}), text: async () => '' };
}

function jsonResponse(payload, status) {
  const code = status || 200;
  return {
    ok: code >= 200 && code < 300,
    status: code,
    body: null,
    json: async () => payload,
    text: async () => JSON.stringify(payload)
  };
}

function sseChunk(content) {
  return 'data: ' + JSON.stringify({ choices: [{ delta: { content } }] }) + '\n\n';
}

/* -------------------------------------------------------------- port harness */

function startPort(chrome, payload) {
  const port = {
    name: 'pagegloss-llm',
    messages: [],
    disconnected: false,
    onMessage: { listeners: [] },
    onDisconnect: { listeners: [] },
    postMessage(message) {
      this.messages.push(message);
    },
    disconnect() {
      this.disconnected = true;
      this.onDisconnect.listeners.forEach((fn) => fn());
    }
  };
  port.onMessage.addListener = (fn) => port.onMessage.listeners.push(fn);
  port.onDisconnect.addListener = (fn) => port.onDisconnect.listeners.push(fn);
  chrome.listeners.onConnect.forEach((fn) => fn(port));
  port.onMessage.listeners.forEach((fn) => fn({ type: 'llm:start', payload }));
  return port;
}

function waitFor(predicate, timeout = 2000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      let value = false;
      try { value = predicate(); } catch (err) { value = false; }
      if (value) { resolve(value); return; }
      if (Date.now() - started > timeout) { reject(new Error('timeout')); return; }
      setTimeout(tick, 10);
    };
    tick();
  });
}

/* ---------------------------------------------------------------------- tests */

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, error: err && err.stack ? err.stack : String(err) });
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'assertion failed');
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error((message || 'values differ') + ': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
  }
}

const BASE_SETTINGS = {
  enabled: true,
  language: 'zh',
  contextMode: 'page',
  apiBaseUrl: 'https://api.example.com/v1/chat/completions',
  apiKey: 'sk-test',
  model: 'test-model',
  temperature: 0.3,
  maxTokens: 512,
  stream: true,
  systemPrompt: '',
  maxContextChars: 24000,
  requestTimeoutMs: 60000,
  cardHoverOpen: true,
  markSentenceTokens: false
};

const EXPLAIN_PAYLOAD = {
  kind: 'explain',
  term: 'flux capacitor',
  context: {
    mode: 'page',
    title: 'Demo',
    url: 'https://example.com/a',
    term: 'flux capacitor',
    sentence: 'The flux capacitor makes time travel possible.',
    section: 'Section about the flux capacitor.',
    pageText: 'LONG PAGE TEXT with the flux capacitor mentioned twice.',
    truncated: false
  },
  history: []
};

function seed(chrome, overrides) {
  chrome.storageData.set('pg:settings', Object.assign({}, BASE_SETTINGS, overrides || {}));
}

async function main() {
  await test('context menu is created for selection and page actions', async () => {
    const chrome = createChromeStub();
    seed(chrome);
    loadServiceWorker(chrome, async () => jsonResponse({}));
    await waitFor(() => chrome.menus.length >= 4);
    const ids = chrome.menus.map((menu) => menu.id).sort();
    assertEqual(ids.join(','), 'pg-mark,pg-unmark-all,pg-unmark-one,pg-unmark-term', 'four menu entries');
    const mark = chrome.menus.find((menu) => menu.id === 'pg-mark');
    assert(mark.contexts.includes('selection'), 'mark entry targets selections');
    assertEqual(mark.enabled, true, 'mark entry enabled while the extension is active');
  });

  await test('paused state disables the menu entries', async () => {
    const chrome = createChromeStub();
    seed(chrome, { enabled: false });
    loadServiceWorker(chrome, async () => jsonResponse({}));
    await waitFor(() => chrome.menus.length >= 4);
    chrome.menus.forEach((menu) => {
      const expected = menu.id === 'pg-paused' ? false : false;
      assertEqual(menu.enabled, expected, menu.id + ' disabled while paused');
    });
    assert(chrome.menus.some((menu) => menu.id === 'pg-paused'), 'paused placeholder entry exists');
  });

  await test('page mode sends the whole page text plus the sentence', async () => {
    const chrome = createChromeStub();
    seed(chrome);
    let requestBody = null;
    const sandbox = loadServiceWorker(chrome, async (url, init) => {
      requestBody = JSON.parse(init.body);
      return sseResponse([sseChunk('ok'), 'data: [DONE]\n\n']);
    });
    await waitFor(() => chrome.listeners.onConnect.length > 0);
    const port = startPort(chrome, EXPLAIN_PAYLOAD);
    await waitFor(() => port.messages.some((message) => message.type === 'done'));

    assert(requestBody, 'a request was sent');
    assertEqual(requestBody.model, 'test-model', 'model from settings');
    assertEqual(requestBody.stream, true, 'streaming requested');
    const userMessage = requestBody.messages[requestBody.messages.length - 1].content;
    assert(userMessage.includes(EXPLAIN_PAYLOAD.context.pageText), 'page text included in page mode');
    assert(userMessage.includes('The flux capacitor makes time travel possible.'), 'sentence included');
    assert(userMessage.includes('“flux capacitor”是什么意思'), 'term question shape');
    assertEqual(sandbox.__shared.CONTEXT_MODES.length, 3, 'three context modes exist');
  });

  await test('section mode sends the section and excerpts instead of the page text', async () => {
    const chrome = createChromeStub();
    seed(chrome, { contextMode: 'section' });
    let userMessage = '';
    loadServiceWorker(chrome, async (url, init) => {
      userMessage = JSON.parse(init.body).messages.slice(-1)[0].content;
      return sseResponse([sseChunk('ok'), 'data: [DONE]\n\n']);
    });
    await waitFor(() => chrome.listeners.onConnect.length > 0);
    const payload = JSON.parse(JSON.stringify(EXPLAIN_PAYLOAD));
    payload.context.mode = 'section';
    payload.context.excerpts = 'Relevant excerpt about the flux capacitor.';
    const port = startPort(chrome, payload);
    await waitFor(() => port.messages.some((message) => message.type === 'done'));
    assert(userMessage.includes('Relevant excerpt about the flux capacitor.'), 'excerpts included');
    assert(!userMessage.includes(EXPLAIN_PAYLOAD.context.pageText), 'full page text omitted');
    assert(userMessage.includes('Section about the flux capacitor.'), 'section included');
  });

  await test('sentence mode sends only the local context', async () => {
    const chrome = createChromeStub();
    seed(chrome, { contextMode: 'sentence' });
    let userMessage = '';
    loadServiceWorker(chrome, async (url, init) => {
      userMessage = JSON.parse(init.body).messages.slice(-1)[0].content;
      return sseResponse([sseChunk('ok'), 'data: [DONE]\n\n']);
    });
    await waitFor(() => chrome.listeners.onConnect.length > 0);
    const payload = JSON.parse(JSON.stringify(EXPLAIN_PAYLOAD));
    payload.context.mode = 'sentence';
    payload.context.section = 'Neighbouring paragraphs only.';
    const port = startPort(chrome, payload);
    await waitFor(() => port.messages.some((message) => message.type === 'done'));
    assert(userMessage.includes('Neighbouring paragraphs only.'), 'local context included');
    assert(!userMessage.includes(EXPLAIN_PAYLOAD.context.pageText), 'page text omitted');
    assert(!userMessage.includes('Section about the flux capacitor.'), 'unrelated section omitted');
  });

  await test('streaming deltas are forwarded in order and assembled', async () => {
    const chrome = createChromeStub();
    seed(chrome);
    const parts = ['光', '速', '旅', '行'];
    const chunks = parts.map((part) => sseChunk(part));
    chunks.push('data: [DONE]\n\n');
    loadServiceWorker(chrome, async () => sseResponse(chunks));
    await waitFor(() => chrome.listeners.onConnect.length > 0);
    const port = startPort(chrome, EXPLAIN_PAYLOAD);
    await waitFor(() => port.messages.some((message) => message.type === 'done'));
    const deltas = port.messages.filter((message) => message.type === 'token').map((message) => message.delta);
    assertEqual(deltas.join(''), parts.join(''), 'deltas arrive in order');
    const done = port.messages.find((message) => message.type === 'done');
    assertEqual(done.text, parts.join(''), 'final text assembled');
  });

  await test('SSE frames split across reads are reassembled', async () => {
    const chrome = createChromeStub();
    seed(chrome);
    const frame = sseChunk('split-across-reads');
    const chunks = [frame.slice(0, 12), frame.slice(12), 'data: [DONE]\n\n'];
    loadServiceWorker(chrome, async () => sseResponse(chunks));
    await waitFor(() => chrome.listeners.onConnect.length > 0);
    const port = startPort(chrome, EXPLAIN_PAYLOAD);
    await waitFor(() => port.messages.some((message) => message.type === 'done'));
    const done = port.messages.find((message) => message.type === 'done');
    assertEqual(done.text, 'split-across-reads', 'partial SSE line is buffered');
  });

  await test('non-streaming responses are parsed from choices[0].message.content', async () => {
    const chrome = createChromeStub();
    seed(chrome, { stream: false });
    loadServiceWorker(chrome, async (url, init) => {
      assertEqual(JSON.parse(init.body).stream, false, 'stream flag forwarded');
      return jsonResponse({ choices: [{ message: { content: 'complete answer' } }] });
    });
    await waitFor(() => chrome.listeners.onConnect.length > 0);
    const port = startPort(chrome, EXPLAIN_PAYLOAD);
    await waitFor(() => port.messages.some((message) => message.type === 'done'));
    const done = port.messages.find((message) => message.type === 'done');
    assertEqual(done.text, 'complete answer', 'content extracted');
  });

  await test('missing configuration produces a targeted error', async () => {
    const chrome = createChromeStub();
    seed(chrome, { apiBaseUrl: '', apiKey: 'sk-test' });
    loadServiceWorker(chrome, async () => jsonResponse({}));
    await waitFor(() => chrome.listeners.onConnect.length > 0);
    const port = startPort(chrome, EXPLAIN_PAYLOAD);
    await waitFor(() => port.messages.some((message) => message.type === 'error'));
    assertEqual(port.messages.find((message) => message.type === 'error').code, 'no-config', 'no-config error reported');
  });

  await test('missing API key produces a targeted error', async () => {
    const chrome = createChromeStub();
    seed(chrome, { apiKey: '' });
    loadServiceWorker(chrome, async () => jsonResponse({}));
    await waitFor(() => chrome.listeners.onConnect.length > 0);
    const port = startPort(chrome, EXPLAIN_PAYLOAD);
    await waitFor(() => port.messages.some((message) => message.type === 'error'));
    assertEqual(port.messages.find((message) => message.type === 'error').code, 'no-key', 'no-key error reported');
  });

  await test('HTTP failures surface the provider message', async () => {
    const chrome = createChromeStub();
    seed(chrome);
    loadServiceWorker(chrome, async () => ({
      ok: false,
      status: 401,
      body: null,
      json: async () => ({}),
      text: async () => JSON.stringify({ error: { message: 'Invalid API key' } })
    }));
    await waitFor(() => chrome.listeners.onConnect.length > 0);
    const port = startPort(chrome, EXPLAIN_PAYLOAD);
    await waitFor(() => port.messages.some((message) => message.type === 'error'));
    const error = port.messages.find((message) => message.type === 'error');
    assertEqual(error.code, 'http', 'http error code');
    assertEqual(error.status, 401, 'status forwarded');
    assertEqual(error.detail, 'Invalid API key', 'provider message extracted');
  });

  await test('network failures are reported as network errors', async () => {
    const chrome = createChromeStub();
    seed(chrome);
    loadServiceWorker(chrome, async () => {
      throw new Error('connect ECONNREFUSED');
    });
    await waitFor(() => chrome.listeners.onConnect.length > 0);
    const port = startPort(chrome, EXPLAIN_PAYLOAD);
    await waitFor(() => port.messages.some((message) => message.type === 'error'));
    const error = port.messages.find((message) => message.type === 'error');
    assertEqual(error.code, 'network', 'network error code');
    assert(error.detail.includes('ECONNREFUSED'), 'underlying error kept');
  });

  await test('aborting a stream stops the request', async () => {
    const chrome = createChromeStub();
    seed(chrome);
    let aborted = false;
    // Two chunks with a delay before the second one gives the abort a window.
    const chunks = [
      'data: ' + JSON.stringify({ choices: [{ delta: { content: 'partial' } }] }) + '\n\n',
      'data: ' + JSON.stringify({ choices: [{ delta: { content: 'rest' } }] }) + '\n\n'
    ];
    loadServiceWorker(chrome, async (url, init) => {
      const response = sseResponse(chunks, { delayMs: 40 });
      const originalReader = response.body.getReader();
      response.body.getReader = () => ({
        read: async () => {
          if (init.signal && init.signal.aborted) {
            aborted = true;
            const err = new Error('aborted');
            err.name = 'AbortError';
            throw err;
          }
          return originalReader.read();
        }
      });
      return response;
    });
    await waitFor(() => chrome.listeners.onConnect.length > 0);
    const port = startPort(chrome, EXPLAIN_PAYLOAD);
    await waitFor(() => port.messages.some((message) => message.type === 'token'));
    port.onMessage.listeners.forEach((fn) => fn({ type: 'llm:abort' }));
    await waitFor(() => aborted || port.messages.some((message) => message.type === 'error'), 3000);
    assert(
      aborted || port.messages.some((message) => message.type === 'error'),
      'abort either stopped the reader or surfaced an aborted error'
    );
  });
  await test('custom system prompt overrides the built-in one', async () => {
    const chrome = createChromeStub();
    seed(chrome, { systemPrompt: 'CUSTOM SYSTEM PROMPT' });
    let system = '';
    loadServiceWorker(chrome, async (url, init) => {
      system = JSON.parse(init.body).messages[0].content;
      return sseResponse([sseChunk('ok'), 'data: [DONE]\n\n']);
    });
    await waitFor(() => chrome.listeners.onConnect.length > 0);
    const port = startPort(chrome, EXPLAIN_PAYLOAD);
    await waitFor(() => port.messages.some((message) => message.type === 'done'));
    assertEqual(system, 'CUSTOM SYSTEM PROMPT', 'custom prompt used verbatim');
  });

  await test('follow-up questions include the previous chat history', async () => {
    const chrome = createChromeStub();
    seed(chrome);
    let messages = [];
    loadServiceWorker(chrome, async (url, init) => {
      messages = JSON.parse(init.body).messages;
      return sseResponse([sseChunk('ok'), 'data: [DONE]\n\n']);
    });
    await waitFor(() => chrome.listeners.onConnect.length > 0);
    const payload = JSON.parse(JSON.stringify(EXPLAIN_PAYLOAD));
    payload.kind = 'ask';
    payload.question = '它需要多少电力？';
    payload.history = [
      { role: 'assistant', content: '它是时间机器的核心部件。' },
      { role: 'user', content: '为什么叫这个名字？' },
      { role: 'assistant', content: '因为靠磁通量驱动。' }
    ];
    const port = startPort(chrome, payload);
    await waitFor(() => port.messages.some((message) => message.type === 'done'));
    assert(messages.length >= 5, 'history passed through as separate turns');
    assertEqual(messages[1].content, '它是时间机器的核心部件。', 'assistant history preserved');
    assertEqual(messages[2].content, '为什么叫这个名字？', 'user history preserved');
    assert(messages.slice(-1)[0].content.includes('它需要多少电力？'), 'follow-up question included');
    assert(messages.slice(-1)[0].content.includes('正在讨论的词语/短语'), 'term reminder included in follow-ups');
  });

  await test('settings changes are pushed to matching tabs only', async () => {
    const chrome = createChromeStub();
    seed(chrome);
    loadServiceWorker(chrome, async () => jsonResponse({}));
    await waitFor(() => chrome.listeners.onChanged.length > 0);
    chrome.listeners.onChanged.forEach((fn) => fn({
      'pg:settings': { oldValue: Object.assign({}, BASE_SETTINGS), newValue: Object.assign({}, BASE_SETTINGS, { contextMode: 'sentence' }) }
    }, 'local'));
    await waitFor(() => chrome.tabMessages.length > 0);
    assertEqual(chrome.tabMessages.length, 1, 'only the http tab is notified');
    assertEqual(chrome.tabMessages[0].tabId, 1, 'browser internal pages are skipped');
    assertEqual(chrome.tabMessages[0].message.type, 'pg:settingsChanged', 'reload-triggering change type');
  });

  await test('concurrent menu rebuilds never create duplicate ids', async () => {
    const chrome = createChromeStub();
    seed(chrome);
    loadServiceWorker(chrome, async () => jsonResponse({}));
    await waitFor(() => chrome.menus.length >= 4);

    // Install + startup + two settings changes all landing at once.
    chrome.listeners.onInstalled.forEach((fn) => fn({ reason: 'update' }));
    chrome.listeners.onStartup.forEach((fn) => fn());
    chrome.listeners.onChanged.forEach((fn) => fn({
      'pg:settings': { oldValue: Object.assign({}, BASE_SETTINGS), newValue: Object.assign({}, BASE_SETTINGS, { enabled: false }) }
    }, 'local'));
    chrome.listeners.onChanged.forEach((fn) => fn({
      'pg:settings': { oldValue: Object.assign({}, BASE_SETTINGS), newValue: Object.assign({}, BASE_SETTINGS, { enabled: true }) }
    }, 'local'));

    await new Promise((resolve) => setTimeout(resolve, 120));
    const ids = chrome.menus.map((menu) => menu.id);
    const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
    assertEqual(duplicates.join(','), '', 'no duplicate menu ids were created');
    assert(ids.includes('pg-mark'), 'the mark entry exists after the rebuild storm');
    assert(ids.includes('pg-unmark-all'), 'the clear entry exists after the rebuild storm');
  });

  await test('model list without a key reports no-key instead of an http error', async () => {
    const chrome = createChromeStub();
    seed(chrome, { apiKey: '' });
    loadServiceWorker(chrome, async () => jsonResponse({ data: [] }));
    await waitFor(() => chrome.listeners.onMessage.length > 0);
    const response = await new Promise((resolve) => {
      chrome.listeners.onMessage[0]({ type: 'pg:listModels', settings: { apiBaseUrl: 'https://api.example.com/v1/chat/completions', apiKey: '' } }, {}, resolve);
    });
    assertEqual(response.ok, false, 'request rejected');
    assertEqual(response.code, 'no-key', 'the missing key is named, so the UI can explain it');
  });

  await test('model list surfaces the provider auth message', async () => {
    const chrome = createChromeStub();
    seed(chrome);
    loadServiceWorker(chrome, async () => ({
      ok: false,
      status: 401,
      body: null,
      json: async () => ({}),
      text: async () => JSON.stringify({ error: { message: 'Authentication Fails, Your api key: ****Test is invalid', type: 'authentication_error' } })
    }));
    await waitFor(() => chrome.listeners.onMessage.length > 0);
    const response = await new Promise((resolve) => {
      chrome.listeners.onMessage[0]({ type: 'pg:listModels', settings: { apiBaseUrl: 'https://api.example.com/v1/chat/completions', apiKey: 'sk-bad' } }, {}, resolve);
    });
    assertEqual(response.ok, false, 'request rejected');
    assertEqual(response.code, 'http', 'http error code');
    assertEqual(response.status, 401, 'status forwarded so the UI can hint about the key');
    assert(
      String(response.detail).indexOf('Authentication Fails') >= 0,
      'provider message kept for the toast: ' + response.detail
    );
  });

  await test('model list requests hit the models endpoint', async () => {
    const chrome = createChromeStub();
    seed(chrome);
    let requestedUrl = '';
    loadServiceWorker(chrome, async (url) => {
      requestedUrl = url;
      return jsonResponse({ data: [{ id: 'model-a' }, { id: 'model-b' }] });
    });
    await waitFor(() => chrome.listeners.onMessage.length > 0);
    const response = await new Promise((resolve) => {
      const keepAlive = chrome.listeners.onMessage[0]({ type: 'pg:listModels', settings: { apiBaseUrl: 'https://api.example.com/v1/chat/completions', apiKey: 'sk' } }, {}, resolve);
      assertEqual(keepAlive, true, 'async response channel kept open');
    });
    assertEqual(requestedUrl, 'https://api.example.com/v1/models', 'models endpoint derived from the chat URL');
    assertEqual(response.models.join(','), 'model-a,model-b', 'model ids returned');
  });

  const failed = results.filter((item) => !item.ok);
  results.forEach((item) => {
    console.log('[' + (item.ok ? 'PASS' : 'FAIL') + '] ' + item.name);
    if (!item.ok) console.log('       ' + item.error);
  });
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' service worker tests passed');
  if (failed.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
