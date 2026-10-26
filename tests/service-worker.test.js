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
  const listener = { onMessage: [], onConnect: [], onInstalled: [], onStartup: [], onCommand: [], onChanged: [], onUpdated: [] };
  const stub = {
    storageData,
    listeners: listener,
    menus: [],
    menuUpdates: [],
    tabMessages: [],
    tabCreates: [],
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
      create: async (props) => {
        stub.tabCreates.push(props);
        return { id: 99 };
      },
      onUpdated: { addListener: (fn) => listener.onUpdated.push(fn) }
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
    TextEncoder,
    AbortController,
    setTimeout,
    clearTimeout
  });
  sandbox.globalThis = sandbox;
  sandbox.module = { exports: {} };
  // The classic scripts run in order, exactly like the manifest content script list.
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/shared/messages.js'), 'utf8'), sandbox, { filename: 'messages.js' });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/shared/storage.js'), 'utf8'), sandbox, { filename: 'storage.js' });
  const shared = sandbox.PageGlossShared;
  const store = sandbox.PageGlossStore;
  if (!shared || !store) {
    throw new Error('shared classic scripts did not publish their globals');
  }

  // Mirror the real module namespace as `ns` so the worker can be loaded without
  // hand written destructuring (which used to introduce duplicate bindings).
  sandbox.ns = Object.assign(Object.create(null), shared, store);
  vm.runInContext(source, sandbox, { filename: 'service-worker.js' });
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
    assertEqual(sandbox.PageGlossShared.CONTEXT_MODES.length, 3, 'three context modes exist');
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
    // The custom prompt is kept, and the interface language is appended after it
    // so a Chinese UI still gets Chinese answers.
    assert(system.indexOf('CUSTOM SYSTEM PROMPT') === 0, 'custom prompt comes first: ' + system);
    assert(/始终使用简体中文回答|Always answer in English/.test(system), 'language directive appended: ' + system);
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

  await test('model list falls back to the origin /models when /v1/models 404s', async () => {
    // DeepSeek shape: chat lives at /v1/chat/completions, the list at /models.
    const chrome = createChromeStub();
    seed(chrome, { apiBaseUrl: 'https://api.deepseek.com/v1/chat/completions' });
    const requested = [];
    loadServiceWorker(chrome, async (url) => {
      requested.push(url);
      if (url === 'https://api.deepseek.com/models') {
        return jsonResponse({ data: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }] });
      }
      return { ok: false, status: 404, body: null, json: async () => ({}), text: async () => 'not found' };
    });
    await waitFor(() => chrome.listeners.onMessage.length > 0);
    const response = await new Promise((resolve) => {
      chrome.listeners.onMessage[0]({ type: 'pg:listModels' }, {}, resolve);
    });
    assertEqual(response.ok, true, 'the fallback candidate succeeded');
    assertEqual(response.models.join(','), 'deepseek-chat,deepseek-reasoner', 'models returned');
    assertEqual(response.modelListUrl, 'https://api.deepseek.com/models', 'the working URL is reported');
    assert(requested.indexOf('https://api.deepseek.com/v1/models') >= 0, 'the naive candidate was tried first');
    assert(
      requested.indexOf('https://api.deepseek.com/models') > requested.indexOf('https://api.deepseek.com/v1/models'),
      'fallback order is correct'
    );
  });

  await test('model list reports every attempted URL when none works', async () => {
    const chrome = createChromeStub();
    seed(chrome, { apiBaseUrl: 'https://api.deepseek.com/v1/chat/completions' });
    loadServiceWorker(chrome, async () => ({
      ok: false,
      status: 404,
      body: null,
      json: async () => ({}),
      text: async () => 'not found'
    }));
    await waitFor(() => chrome.listeners.onMessage.length > 0);
    const response = await new Promise((resolve) => {
      chrome.listeners.onMessage[0]({ type: 'pg:listModels' }, {}, resolve);
    });
    assertEqual(response.ok, false, 'reported as failed');
    assertEqual(response.code, 'models-unavailable', 'a dedicated code instead of a bare http 404');
    assert(response.tried.length >= 2, 'candidate URLs reported: ' + JSON.stringify(response.tried));
    assert(response.tried.indexOf('https://api.deepseek.com/models') >= 0, 'origin fallback included');
  });

  await test('model list keeps an auth error instead of trying more URLs', async () => {
    const chrome = createChromeStub();
    seed(chrome, { apiBaseUrl: 'https://api.deepseek.com/v1/chat/completions' });
    let calls = 0;
    loadServiceWorker(chrome, async () => {
      calls++;
      return {
        ok: false,
        status: 401,
        body: null,
        json: async () => ({}),
        text: async () => JSON.stringify({ error: { message: 'Authentication Fails' } })
      };
    });
    await waitFor(() => chrome.listeners.onMessage.length > 0);
    const response = await new Promise((resolve) => {
      chrome.listeners.onMessage[0]({ type: 'pg:listModels' }, {}, resolve);
    });
    assertEqual(response.ok, false, 'rejected');
    assertEqual(response.code, 'http', 'auth failures stay http errors');
    assertEqual(response.status, 401, 'status forwarded');
    assertEqual(calls, 1, 'a 401 is not retried against more URLs');
  });

  await test('the chat URL is completed per request without rewriting the stored input', async () => {
    const chrome = createChromeStub();
    seed(chrome, { apiBaseUrl: 'https://api.deepseek.com' });
    const requested = [];
    loadServiceWorker(chrome, async (url) => {
      requested.push(url);
      // DeepSeek 404s on /v1/chat/completions and serves /chat/completions.
      if (url.endsWith('/v1/chat/completions')) {
        return { ok: false, status: 404, body: null, json: async () => ({}), text: async () => 'not found' };
      }
      return sseResponse([sseChunk('ok'), 'data: [DONE]\n\n']);
    });
    await waitFor(() => chrome.listeners.onConnect.length > 0);
    const port = startPort(chrome, EXPLAIN_PAYLOAD);
    await waitFor(() => port.messages.some((message) => message.type === 'done'));
    assertEqual(requested[0], 'https://api.deepseek.com/chat/completions', 'DeepSeek serves the direct path first');
    assertEqual(requested.length, 1, 'the documented DeepSeek endpoint needs no 404 round trip');
    assert(port.messages.some((message) => message.type === 'done'), 'the request produced an answer');
    assertEqual(
      chrome.storageData.get('pg:settings').apiBaseUrl,
      'https://api.deepseek.com',
      'the stored value stays exactly as typed'
    );
  });

  await test('a bare origin still gets the OpenAI style /v1 path', async () => {
    const chrome = createChromeStub();
    seed(chrome, { apiBaseUrl: 'https://api.openai.com' });
    const requested = [];
    loadServiceWorker(chrome, async (url) => {
      requested.push(url);
      return sseResponse([sseChunk('ok'), 'data: [DONE]\n\n']);
    });
    await waitFor(() => chrome.listeners.onConnect.length > 0);
    const port = startPort(chrome, EXPLAIN_PAYLOAD);
    await waitFor(() => port.messages.some((message) => message.type === 'done'));
    assertEqual(requested[0], 'https://api.openai.com/v1/chat/completions', 'OpenAI style completion');
  });

  await test('explicit paths and local servers are respected', async () => {
    const cases = [
      ['https://api.deepseek.com/v1', 'https://api.deepseek.com/v1/chat/completions'],
      ['https://api.deepseek.com/v1/chat/completions', 'https://api.deepseek.com/v1/chat/completions'],
      ['http://localhost:11434/v1', 'http://localhost:11434/v1/chat/completions'],
      ['https://openrouter.ai/api', 'https://openrouter.ai/api/chat/completions']
    ];
    for (const entry of cases) {
      const input = entry[0];
      const expected = entry[1];
      const chrome = createChromeStub();
      seed(chrome, { apiBaseUrl: input });
      const requested = [];
      loadServiceWorker(chrome, async (url) => {
        requested.push(url);
        return sseResponse([sseChunk('ok'), 'data: [DONE]\n\n']);
      });
      await waitFor(() => chrome.listeners.onConnect.length > 0);
      const port = startPort(chrome, EXPLAIN_PAYLOAD);
      await waitFor(() => port.messages.some((message) => message.type === 'done'));
      assertEqual(requested[0], expected, 'input: ' + input);
    }
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
    assertEqual(response.models.length, 2, 'both models reach the caller, not just the first one');
    assertEqual(response.models.join(','), 'model-a,model-b', 'model ids returned in order');
  });

  await test('an empty answer reports what the provider actually said', async () => {
    const chrome = createChromeStub();
    seed(chrome, { stream: false });
    loadServiceWorker(chrome, async () => jsonResponse({
      id: 'chatcmpl-1',
      choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'length' }]
    }));
    await waitFor(() => chrome.listeners.onConnect.length > 0);
    const port = startPort(chrome, EXPLAIN_PAYLOAD);
    await waitFor(() => port.messages.some((message) => message.type === 'error'));
    const error = port.messages.find((message) => message.type === 'error');
    assertEqual(error.code, 'empty', 'empty answer code');
    assert(
      String(error.detail).indexOf('finish_reason=length') >= 0,
      'the finish reason is passed through: ' + error.detail
    );
  });

  await test('an empty streaming answer also carries diagnostics', async () => {
    const chrome = createChromeStub();
    seed(chrome);
    loadServiceWorker(chrome, async () => sseResponse([
      'data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'content_filter' }] }) + '\n\n',
      'data: [DONE]\n\n'
    ]));
    await waitFor(() => chrome.listeners.onConnect.length > 0);
    const port = startPort(chrome, EXPLAIN_PAYLOAD);
    await waitFor(() => port.messages.some((message) => message.type === 'error'));
    const error = port.messages.find((message) => message.type === 'error');
    assertEqual(error.code, 'empty', 'empty answer code');
    assert(
      String(error.detail).indexOf('content_filter') >= 0,
      'the streamed finish reason is reported: ' + error.detail
    );
  });

  await test('a reasoning-only answer is still delivered with a warning', async () => {
    const chrome = createChromeStub();
    seed(chrome);
    loadServiceWorker(chrome, async () => sseResponse([
      'data: ' + JSON.stringify({ choices: [{ delta: { reasoning_content: '先分析语境' } }] }) + '\n\n',
      'data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] }) + '\n\n',
      'data: [DONE]\n\n'
    ]));
    await waitFor(() => chrome.listeners.onConnect.length > 0);
    const port = startPort(chrome, EXPLAIN_PAYLOAD);
    await waitFor(() => port.messages.some((message) => message.type === 'done'));
    const reasoning = port.messages.filter((message) => message.type === 'reasoning').map((m) => m.delta).join('');
    assertEqual(reasoning, '先分析语境', 'the chain of thought is streamed on its own channel');
    const done = port.messages.find((message) => message.type === 'done');
    assertEqual(done.text, '先分析语境', 'the reasoning text is handed back instead of an empty answer');
    assertEqual(done.reasoningOnly, true, 'flagged so the UI can explain it');
    assertEqual(done.finishReason, 'length', 'the finish reason is forwarded');
  });

  await test('a normal answer is not flagged as reasoning only', async () => {
    const chrome = createChromeStub();
    seed(chrome);
    loadServiceWorker(chrome, async () => sseResponse([
      'data: ' + JSON.stringify({ choices: [{ delta: { reasoning_content: '思考' } }] }) + '\n\n',
      'data: ' + JSON.stringify({ choices: [{ delta: { content: '答案' } }] }) + '\n\n',
      'data: [DONE]\n\n'
    ]));
    await waitFor(() => chrome.listeners.onConnect.length > 0);
    const port = startPort(chrome, EXPLAIN_PAYLOAD);
    await waitFor(() => port.messages.some((message) => message.type === 'done'));
    const done = port.messages.find((message) => message.type === 'done');
    assertEqual(done.text, '答案', 'only the answer text is returned');
    assertEqual(done.reasoningOnly, false, 'not flagged');
    const reasoning = port.messages.filter((message) => message.type === 'reasoning').map((m) => m.delta).join('');
    assertEqual(reasoning, '思考', 'the reasoning channel still carries the chain of thought');
  });

  await test('a non-streaming reasoning-only reply is unpacked', async () => {
    const chrome = createChromeStub();
    seed(chrome, { stream: false });
    loadServiceWorker(chrome, async () => jsonResponse({
      choices: [{ message: { role: 'assistant', content: '', reasoning_content: '推理全文' }, finish_reason: 'length' }]
    }));
    await waitFor(() => chrome.listeners.onConnect.length > 0);
    const port = startPort(chrome, EXPLAIN_PAYLOAD);
    await waitFor(() => port.messages.some((message) => message.type === 'done'));
    const done = port.messages.find((message) => message.type === 'done');
    assertEqual(done.text, '推理全文', 'reasoning_content is used as the answer');
    assertEqual(done.reasoningOnly, true, 'flagged');
  });

  await test('the full page view is opened with the annotation identity', async () => {
    const chrome = createChromeStub();
    seed(chrome);
    loadServiceWorker(chrome, async () => jsonResponse({}));
    await waitFor(() => chrome.listeners.onMessage.length > 0);
    const response = await new Promise((resolve) => {
      chrome.listeners.onMessage[0]({
        type: 'pg:openFullpage',
        urlKey: 'https://example.com/a',
        annotationId: 'ann-1'
      }, {}, resolve);
    });
    assertEqual(response.ok, true, 'the tab is opened');
    const created = chrome.tabCreates[0];
    assert(created, 'chrome.tabs.create was called');
    assert(
      created.url.indexOf('chrome-extension://stub/src/fullpage/fullpage.html') === 0,
      'full page url: ' + created.url
    );
    assert(created.url.indexOf('key=https%3A%2F%2Fexample.com%2Fa') >= 0, 'url key is encoded');
    assert(created.url.indexOf('id=ann-1') >= 0, 'annotation id is forwarded');
  });

  await test('opening the full page without an annotation is refused', async () => {
    const chrome = createChromeStub();
    seed(chrome);
    loadServiceWorker(chrome, async () => jsonResponse({}));
    await waitFor(() => chrome.listeners.onMessage.length > 0);
    const response = await new Promise((resolve) => {
      chrome.listeners.onMessage[0]({ type: 'pg:openFullpage', urlKey: '', annotationId: '' }, {}, resolve);
    });
    assertEqual(response.ok, false, 'no tab is created for an empty request');
    assertEqual(chrome.tabCreates.length, 0, 'tabs.create was not called');
  });

  await test('official provider base URLs resolve to the documented chat endpoint', async () => {
    // Load the shared helpers on their own, exactly like the options page does.
    const context = vm.createContext({ URL, console });
    context.globalThis = context;
    context.window = context;
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/shared/messages.js'), 'utf8'), context, { filename: 'messages.js' });
    const S = context.PageGlossShared;
    assert(S && typeof S.chatEndpointCandidates === 'function', 'shared helpers exported');

    const cases = [
      ['https://api.openai.com/v1', 'https://api.openai.com/v1/chat/completions'],
      ['https://api.openai.com/v1/', 'https://api.openai.com/v1/chat/completions'],
      ['  "https://api.deepseek.com"  ', 'https://api.deepseek.com/chat/completions'],
      ['https://api.deepseek.com/v1', 'https://api.deepseek.com/v1/chat/completions'],
      ['https://api.deepseek.com/v1/chat/completions', 'https://api.deepseek.com/v1/chat/completions'],
      ['https://api.moonshot.cn', 'https://api.moonshot.cn/v1/chat/completions'],
      ['https://api.moonshot.cn/v1', 'https://api.moonshot.cn/v1/chat/completions'],
      ['https://open.bigmodel.cn', 'https://open.bigmodel.cn/api/paas/v4/chat/completions'],
      ['https://open.bigmodel.cn/api/paas/v4', 'https://open.bigmodel.cn/api/paas/v4/chat/completions'],
      ['https://dashscope.aliyuncs.com/compatible-mode/v1', 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'],
      ['https://dashscope-intl.aliyuncs.com/compatible-mode/v1', 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions'],
      ['https://ark.cn-beijing.volces.com/api/v3', 'https://ark.cn-beijing.volces.com/api/v3/chat/completions'],
      ['https://api.groq.com', 'https://api.groq.com/openai/v1/chat/completions'],
      ['https://api.groq.com/openai/v1', 'https://api.groq.com/openai/v1/chat/completions'],
      ['https://api.mistral.ai/v1', 'https://api.mistral.ai/v1/chat/completions'],
      ['https://api.x.ai/v1', 'https://api.x.ai/v1/chat/completions'],
      ['https://openrouter.ai/api/v1', 'https://openrouter.ai/api/v1/chat/completions'],
      ['https://api.together.xyz/v1', 'https://api.together.xyz/v1/chat/completions'],
      ['https://api.siliconflow.cn/v1', 'https://api.siliconflow.cn/v1/chat/completions'],
      ['https://generativelanguage.googleapis.com', 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'],
      ['https://generativelanguage.googleapis.com/v1beta/openai', 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'],
      ['http://localhost:11434', 'http://localhost:11434/v1/chat/completions'],
      ['http://localhost:11434/v1', 'http://localhost:11434/v1/chat/completions']
    ];
    for (const [input, expected] of cases) {
      const candidates = S.chatEndpointCandidates(input);
      assertEqual(candidates[0], expected, 'input: ' + input);
    }

    // The query string of an Azure style URL survives the path append.
    const azure = S.chatEndpointCandidates('https://x.openai.azure.com/openai/deployments/d?api-version=2024-06-01');
    assertEqual(
      azure[0],
      'https://x.openai.azure.com/openai/deployments/d/chat/completions?api-version=2024-06-01',
      'query preserved: ' + azure[0]
    );

    // Anthropic is flagged instead of being sent an OpenAI request.
    assertEqual(S.isAnthropicUrl('https://api.anthropic.com'), true, 'anthropic detected');
    assertEqual(S.isAnthropicUrl('https://api.openai.com/v1'), false, 'openai not flagged');

    // The model list follows the same provider prefixes.
    assertEqual(S.modelsEndpointCandidates('https://open.bigmodel.cn')[0], 'https://open.bigmodel.cn/api/paas/v4/models', 'zhipu models');
    assertEqual(S.modelsEndpointCandidates('https://api.deepseek.com')[0], 'https://api.deepseek.com/models', 'deepseek models');
    assertEqual(S.modelsEndpointCandidates('https://api.openai.com/v1')[0], 'https://api.openai.com/v1/models', 'openai models');
  });

  await test('a pasted official base URL is used verbatim by the request pipeline', async () => {
    const cases = [
      ['https://api.openai.com/v1', 'https://api.openai.com/v1/chat/completions'],
      ['https://api.moonshot.cn', 'https://api.moonshot.cn/v1/chat/completions'],
      ['https://open.bigmodel.cn', 'https://open.bigmodel.cn/api/paas/v4/chat/completions']
    ];
    for (const [input, expected] of cases) {
      const chrome = createChromeStub();
      seed(chrome, { apiBaseUrl: input });
      const requested = [];
      loadServiceWorker(chrome, async (url) => {
        requested.push(url);
        return sseResponse([sseChunk('答案正确'), 'data: [DONE]\n\n']);
      });
      await waitFor(() => chrome.listeners.onConnect.length > 0);
      const port = startPort(chrome, EXPLAIN_PAYLOAD);
      await waitFor(() => port.messages.some((message) => message.type === 'done'));
      const done = port.messages.find((message) => message.type === 'done');
      assertEqual(requested[0], expected, 'request URL for ' + input);
      assertEqual(done.text, '答案正确', 'text extracted for ' + input);
    }
  });

  await test('a rate limit is retried once before failing', async () => {
    const chrome = createChromeStub();
    seed(chrome, { apiBaseUrl: 'https://api.openai.com/v1' });
    let calls = 0;
    loadServiceWorker(chrome, async () => {
      calls += 1;
      if (calls === 1) {
        return {
          ok: false,
          status: 429,
          headers: { get: () => '0' },
          body: null,
          json: async () => ({}),
          text: async () => 'rate limited'
        };
      }
      return sseResponse([sseChunk('重试成功'), 'data: [DONE]\n\n']);
    });
    await waitFor(() => chrome.listeners.onConnect.length > 0);
    const port = startPort(chrome, EXPLAIN_PAYLOAD);
    await waitFor(() => port.messages.some((message) => message.type === 'done'), 5000);
    const done = port.messages.find((message) => message.type === 'done');
    assertEqual(done.text, '重试成功', 'the retried request produced the answer');
    assertEqual(calls, 2, 'exactly one retry');
  });

  await test('a persistent server error is reported instead of endpoint-not-found', async () => {
    const chrome = createChromeStub();
    seed(chrome, { apiBaseUrl: 'https://api.openai.com/v1' });
    let calls = 0;
    loadServiceWorker(chrome, async () => {
      calls += 1;
      return {
        ok: false,
        status: 503,
        headers: { get: () => '0' },
        body: null,
        json: async () => ({}),
        text: async () => 'upstream down'
      };
    });
    await waitFor(() => chrome.listeners.onConnect.length > 0);
    const port = startPort(chrome, EXPLAIN_PAYLOAD);
    await waitFor(() => port.messages.some((message) => message.type === 'error'), 5000);
    const error = port.messages.find((message) => message.type === 'error');
    assertEqual(error.code, 'http', 'http error code');
    assertEqual(error.status, 503, 'real status preserved');
    assertEqual(calls, 2, 'one retry was made');
  });

  await test('the interface language is appended to every system prompt', async () => {
    const chrome = createChromeStub();
    seed(chrome, { language: 'en', systemPrompt: '' });
    let system = '';
    loadServiceWorker(chrome, async (url, init) => {
      system = JSON.parse(init.body).messages[0].content;
      return sseResponse([sseChunk('ok'), 'data: [DONE]\n\n']);
    });
    await waitFor(() => chrome.listeners.onConnect.length > 0);
    const port = startPort(chrome, EXPLAIN_PAYLOAD);
    await waitFor(() => port.messages.some((message) => message.type === 'done'));
    assert(system.indexOf('Always answer in English.') >= 0, 'English directive: ' + system.slice(-80));
  });

  await test('SPA url changes are forwarded to the content script', async () => {
    const chrome = createChromeStub();
    seed(chrome);
    loadServiceWorker(chrome, async () => jsonResponse({}));
    await waitFor(() => chrome.listeners.onUpdated.length > 0);
    chrome.listeners.onUpdated[0](7, { url: 'https://example.com/next' });
    await waitFor(() => chrome.tabMessages.some((item) => item.message.type === 'pg:urlChanged'));
    const forwarded = chrome.tabMessages.filter((item) => item.message.type === 'pg:urlChanged').pop();
    assertEqual(forwarded.tabId, 7, 'forwarded to the changed tab');
    assertEqual(forwarded.message.url, 'https://example.com/next', 'new URL forwarded');
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
