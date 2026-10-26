/*
 * PageGloss - content script loading tests.
 *
 * Reproduces the reported failure: a content script that starts without its
 * shared dependencies must not throw "Cannot read properties of undefined".
 *
 * Cases:
 *   1. only main.js injected          -> friendly notice, no uncaught TypeError
 *   2. full stack from manifest.json  -> boots cleanly
 *   3. missing API key                -> a toast tells the user to configure the LLM
 *   4. marking still works without an API key
 *
 * Run with: node tests/content-load.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));

/* ------------------------------------------------------------------ DOM shim */

class SNode {
  constructor(type) {
    this.nodeType = type;
    this.childNodes = [];
    this.parentNode = null;
    this.attributes = {};
    this.style = {
      setProperty(name, value) { this[name] = value; },
      cssText: ''
    };
    this.dataset = {};
    this.classList = {
      add: () => {},
      remove: () => {},
      toggle: () => {},
      contains: () => false
    };
  }

  get parentElement() {
    return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null;
  }

  get children() {
    return this.childNodes.filter((child) => child.nodeType === 1);
  }

  get firstChild() {
    return this.childNodes[0] || null;
  }

  get nextSibling() {
    if (!this.parentNode) return null;
    const index = this.parentNode.childNodes.indexOf(this);
    return index >= 0 ? this.parentNode.childNodes[index + 1] || null : null;
  }

  get previousElementSibling() {
    const siblings = this.parentNode ? this.parentNode.children : [];
    const index = siblings.indexOf(this);
    return index > 0 ? siblings[index - 1] : null;
  }

  appendChild(node) {
    if (node.tagName === '#FRAGMENT') {
      node.childNodes.slice().forEach((child) => this.appendChild(child));
      return node;
    }
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }

  insertBefore(node, reference) {
    if (!reference) return this.appendChild(node);
    if (node.tagName === '#FRAGMENT') {
      node.childNodes.slice().forEach((child) => this.insertBefore(child, reference));
      return node;
    }
    if (node.parentNode) node.parentNode.removeChild(node);
    const index = this.childNodes.indexOf(reference);
    if (index < 0) return this.appendChild(node);
    node.parentNode = this;
    this.childNodes.splice(index, 0, node);
    return node;
  }

  removeChild(node) {
    const index = this.childNodes.indexOf(node);
    if (index >= 0) this.childNodes.splice(index, 1);
    node.parentNode = null;
    return node;
  }

  normalize() {
    const merged = [];
    for (const child of this.childNodes) {
      if (child.nodeType === 3 && merged.length && merged[merged.length - 1].nodeType === 3) {
        merged[merged.length - 1].nodeValue += child.nodeValue;
        continue;
      }
      merged.push(child);
    }
    this.childNodes = merged;
    merged.forEach((child) => {
      child.parentNode = this;
      if (child.nodeType === 1) child.normalize();
    });
  }

  contains(node) {
    let current = node;
    while (current) {
      if (current === this) return true;
      current = current.parentNode;
    }
    return false;
  }

  get textContent() {
    if (this.nodeType === 3) return this.nodeValue;
    return this.childNodes.map((child) => child.textContent).join('');
  }

  set textContent(value) {
    this.childNodes = [];
    if (value === '' || value == null) return;
    this.appendChild(new SNode(3)).nodeValue = String(value);
  }

  get className() {
    return String(this.attributes.class || '');
  }

  set className(value) {
    this.attributes.class = String(value);
  }

  /** Small HTML parser: enough for the static card shell markup. */
  set innerHTML(markup) {
    this.childNodes = [];
    const source = String(markup);
    const stack = [this];
    const pattern = /<\/?[a-zA-Z][^>]*\/?>/g;
    let cursor = 0;
    let match;
    while ((match = pattern.exec(source))) {
      const text = source.slice(cursor, match.index);
      if (text.trim()) stack[stack.length - 1].appendChild(textNode(text));
      cursor = pattern.lastIndex;
      const token = match[0];
      const nameMatch = /^<\/?([a-zA-Z][a-zA-Z0-9-]*)/.exec(token);
      if (!nameMatch) continue;
      const tag = nameMatch[1].toLowerCase();
      if (token.startsWith('</')) {
        if (stack.length > 1) stack.pop();
        continue;
      }
      const node = element(tag);
      const attrPattern = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
      let attr;
      while ((attr = attrPattern.exec(token))) {
        node.setAttribute(attr[1], attr[2] !== undefined ? attr[2] : attr[3]);
      }
      stack[stack.length - 1].appendChild(node);
      if (tag !== 'input' && tag !== 'br' && tag !== 'hr' && tag !== 'img') stack.push(node);
    }
    const rest = source.slice(cursor);
    if (rest.trim()) stack[stack.length - 1].appendChild(textNode(rest));
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
  }

  closest(selector) {
    const wanted = String(selector).split(',').map((part) => part.trim().toUpperCase());
    let current = this;
    while (current && current.nodeType === 1) {
      if (wanted.indexOf(current.tagName) >= 0) return current;
      current = current.parentNode;
    }
    return null;
  }

  getBoundingClientRect() {
    return { left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20 };
  }

  /** Supports `#id`, `.class`, `tag`, `tag.class` and `tag[attr="value"]`. */
  querySelector(selector) {
    const first = String(selector).trim().split(/\s+/)[0];
    const attrMatch = /\[([a-zA-Z-]+)(?:="([^"]*)")?\]/.exec(first);
    const attrName = attrMatch ? attrMatch[1] : null;
    const attrValue = attrMatch && attrMatch[2] !== undefined ? attrMatch[2] : null;
    const base = first.split('[')[0];
    const byId = base.startsWith('#') ? base.slice(1) : null;
    const byClass = base.startsWith('.') ? base.slice(1) : (base.indexOf('.') > 0 ? base.split('.')[1] : null);
    const byTag = !base.startsWith('#') && !base.startsWith('.') && base ? base.split('.')[0].toUpperCase() : null;
    const match = (node) => {
      if (node.nodeType !== 1) return false;
      if (byId && node.getAttribute('id') !== byId) return false;
      if (byTag && node.tagName !== byTag) return false;
      if (byClass) {
        const classes = String(node.getAttribute('class') || '').split(/\s+/);
        if (classes.indexOf(byClass) < 0) return false;
      }
      if (attrName) {
        const value = node.getAttribute(attrName);
        if (value == null) return false;
        if (attrValue != null && value !== attrValue) return false;
      }
      return true;
    };
    let found = null;
    (function walk(node) {
      if (found) return;
      (node.childNodes || []).forEach((child) => {
        if (found) return;
        if (child.nodeType !== 1) return;
        if (match(child)) {
          found = child;
          return;
        }
        walk(child);
      });
      if (node.shadowRoot) walk(node.shadowRoot);
    })(this);
    return found;
  }

  querySelectorAll() {
    return [];
  }

  attachShadow() {
    this.shadowRoot = new SNode(1);
    this.shadowRoot.tagName = '#SHADOW';
    this.shadowRoot.host = this;
    return this.shadowRoot;
  }

  addEventListener() {}
  removeEventListener() {}

  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }
}

function textNode(value) {
  const node = new SNode(3);
  node.nodeValue = value;
  return node;
}

function element(tagName) {
  const node = new SNode(1);
  node.tagName = String(tagName).toUpperCase();
  node._tag = String(tagName).toLowerCase();
  return node;
}

function createDocument() {
  const document = {
    readyState: 'complete',
    title: 'Content load test',
    createElement: (tag) => element(tag),
    createTextNode: (value) => textNode(value),
    createRange: () => ({
      setStart() {},
      setEnd() {},
      extractContents: () => element('#fragment'),
      insertNode() {},
      cloneContents: () => element('#fragment'),
      toString: () => ''
    }),
    createTreeWalker: () => ({ nextNode: () => null }),
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: () => null,
    addEventListener: () => {},
    removeEventListener: () => {},
    elementFromPoint: () => null,
    body: element('body'),
    documentElement: element('html')
  };
  const paragraph = element('p');
  paragraph.appendChild(textNode('PageGloss content load test.'));
  document.body.appendChild(paragraph);
  return document;
}

function createChrome(store) {
  const sent = [];
  const messageListeners = [];
  return {
    __sent: sent,
    __messageListeners: messageListeners,
    runtime: {
      lastError: null,
      id: 'test',
      getURL: (value) => 'chrome-extension://test/' + value,
      sendMessage: (message) => sent.push(message),
      connect: () => ({
        onMessage: { addListener: () => {} },
        onDisconnect: { addListener: () => {} },
        postMessage: () => {},
        disconnect: () => {}
      }),
      onMessage: { addListener: (fn) => messageListeners.push(fn) }
    },
    i18n: { getUILanguage: () => 'zh-CN' },
    storage: {
      local: {
        get: (keys, callback) => callback(store.snapshot(keys)),
        set: (items, callback) => {
          store.applySet(items);
          if (callback) callback();
        },
        remove: (keys, callback) => {
          store.applyRemove(keys);
          if (callback) callback();
        }
      },
      onChanged: { addListener: () => {} }
    },
    permissions: {
      contains: async () => true,
      request: async () => true
    }
  };
}

function createStore(initial) {
  const data = new Map(Object.entries(initial || {}));
  return {
    data,
    snapshot(keys) {
      if (keys == null) return Object.fromEntries(data);
      if (typeof keys === 'string') return data.has(keys) ? { [keys]: data.get(keys) } : {};
      if (Array.isArray(keys)) {
        const out = {};
        keys.forEach((key) => { if (data.has(key)) out[key] = data.get(key); });
        return out;
      }
      const out = {};
      Object.keys(keys).forEach((key) => { out[key] = data.has(key) ? data.get(key) : keys[key]; });
      return out;
    },
    applySet(items) {
      Object.keys(items).forEach((key) => data.set(key, items[key]));
    },
    applyRemove(keys) {
      (Array.isArray(keys) ? keys : [keys]).forEach((key) => data.delete(key));
    }
  };
}

/* ------------------------------------------------------------------ harness */

function loadContentScriptStack(files, options) {
  const opts = options || {};
  const document = createDocument();
  const store = createStore(opts.storage);
  const chrome = createChrome(store);
  const errors = [];

  // console.log/info pass through to the terminal; warn/error are recorded so
  // tests can assert on them.
  const sandbox = {
    document,
    chrome,
    location: { href: 'https://www.metal-archives.com/bands/Test/123' },
    console: {
      log: (...args) => console.log(...args),
      info: (...args) => console.info(...args),
      warn: (...args) => errors.push({ kind: 'warn', message: args.join(' ') }),
      error: (...args) => errors.push({ kind: 'error', message: args.join(' ') })
    },
    Promise,
    Map,
    Set,
    Date,
    Math,
    JSON,
    URL,
    Number,
    String,
    Object,
    Array,
    isFinite,
    setTimeout: (fn, delay) => setTimeout(fn, delay),
    clearTimeout: (handle) => clearTimeout(handle),
    queueMicrotask,
    navigator: { language: 'zh-CN' },
    innerWidth: 1280,
    innerHeight: 800,
    CSS: { escape: (value) => String(value) },
    getSelection: () => null,
    addEventListener: () => {},
    removeEventListener: () => {},
    NodeFilter: { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);

  const loaded = [];
  files.forEach((file) => {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    try {
      vm.runInContext(source, context, { filename: file });
      loaded.push(file);
    } catch (err) {
      errors.push({ kind: 'throw', message: `${file}: ${err && err.message ? err.message : err}` });
    }
  });

  return { document, sandbox, chrome, store, errors, loaded };
}

function shadowText(root) {
  const parts = [];
  (function walk(node) {
    if (!node) return;
    if (node.nodeType === 3) parts.push(node.nodeValue);
    (node.childNodes || []).forEach(walk);
    if (node.shadowRoot) walk(node.shadowRoot);
  })(root);
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

function allElements(root) {
  const out = [];
  (function walk(node) {
    (node.childNodes || []).forEach((child) => {
      if (child.nodeType === 1 && child.tagName !== '#SHADOW') out.push(child);
      walk(child);
    });
    // Shadow roots host their own tree; descend so buttons inside are visible.
    if (node.shadowRoot) walk(node.shadowRoot);
  })(root);
  return out;
}

function waitFor(predicate, timeout = 1500) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      let value = false;
      try { value = predicate(); } catch (err) { value = false; }
      if (value) { resolve(value); return; }
      if (Date.now() - started > timeout) { reject(new Error('timeout')); return; }
      setTimeout(tick, 15);
    };
    tick();
  });
}

/* -------------------------------------------------------------------- tests */

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

async function main() {
  const manifestFiles = (MANIFEST.content_scripts || [])
    .reduce((all, entry) => all.concat(entry.js || []), []);

  await test('manifest injects the whole content-script stack in dependency order', () => {
    assertEqual(
      manifestFiles.join(','),
      'src/shared/messages.js,src/shared/i18n.js,src/shared/storage.js,src/content/matcher.js,src/content/card.js,src/content/main.js',
      'content script order'
    );
  });

  await test('only main.js injected: friendly notice instead of an uncaught TypeError', () => {
    const env = loadContentScriptStack(['src/content/main.js']);
    const thrown = env.errors.filter((item) => item.kind === 'throw');
    assertEqual(thrown.length, 1, 'the guard reports the broken load order');
    assert(
      /required shared script/.test(thrown[0].message),
      'the thrown error should name the missing scripts, got: ' + thrown[0].message
    );
    assert(
      !/Cannot read properties of undefined/.test(thrown[0].message),
      'it must not be a raw TypeError, got: ' + thrown[0].message
    );
    const logged = env.errors.find((item) => item.kind === 'error');
    assert(logged && /missing shared script/.test(logged.message), 'the console error names the missing scripts');
  });

  await test('full stack injection boots without errors', async () => {
    const env = loadContentScriptStack(manifestFiles);
    assertEqual(env.loaded.length, manifestFiles.length, 'every script executed');
    assertEqual(env.errors.filter((item) => item.kind === 'throw').length, 0, 'no script threw');
    await waitFor(() => env.sandbox.window.__pagegloss && env.sandbox.window.__pagegloss.state.settings);
    assert(env.sandbox.window.__pagegloss.state.settings, 'settings loaded');
    assertEqual(env.sandbox.window.__pagegloss.state.urlKey, 'https://www.metal-archives.com/bands/Test/123', 'url key normalised');
  });

  await test('opening a page with no configuration does not nag the user', async () => {
    const env = loadContentScriptStack(manifestFiles);
    await waitFor(() => env.sandbox.window.__pagegloss && env.sandbox.window.__pagegloss.state.settings);
    // Give any deferred boot work a moment, then assert nothing was announced.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const notice = shadowText(env.document.body);
    assert(
      !/未配置 LLM|not configured/i.test(notice),
      'no startup nag: ' + notice.slice(0, 120)
    );
  });

  await test('using the feature without an API key raises the notice', async () => {
    const env = loadContentScriptStack(manifestFiles);
    await waitFor(() => env.sandbox.window.__pagegloss && env.sandbox.window.__pagegloss.state.settings);
    const MM = env.sandbox.window.PageGlossMatcher;
    const originalApply = MM.applyRanges;
    MM.applyRanges = function (map, ranges) {
      originalApply(map, ranges);
      return ranges.length;
    };
    env.sandbox.window.__pagegloss.mark({
      text: 'PageGloss content load test.',
      anchorElement: env.document.body.childNodes[0],
      sentence: 'PageGloss content load test.'
    });
    const notice = await waitFor(() => {
      const text = shadowText(env.document.body);
      return /未配置 LLM|not configured/i.test(text) ? text : '';
    });
    assert(/未配置 LLM|not configured/i.test(notice), 'the notice appears on use, got: ' + notice.slice(0, 160));
    assert(/API ?key/i.test(notice), 'toast should name the missing field, got: ' + notice);
    const host = allElements(env.document.body).find((node) => node.tagName === 'PAGEGLOSS-UI');
    assert(host, 'a toast host exists');
  });

  await test('marking without an API key still marks and explains why', async () => {
    const env = loadContentScriptStack(manifestFiles);
    await waitFor(() => env.sandbox.window.__pagegloss && env.sandbox.window.__pagegloss.state.settings);
    // This DOM stub does not implement Range.extractContents, so the marking
    // engine itself is covered by tests/integration.test.js. Here the spy runs
    // the real engine first, then reports the ranges as applied so the rest of
    // the flow (card, notice, persistence) is exercised.
    const MM = env.sandbox.window.PageGlossMatcher;
    const calls = [];
    const originalApply = MM.applyRanges;
    MM.applyRanges = function (map, ranges) {
      calls.push(ranges.map((range) => ({ start: range.start, end: range.end })));
      originalApply(map, ranges);
      return ranges.length;
    };

    const result = env.sandbox.window.__pagegloss.mark({
      text: 'PageGloss content load test.',
      anchorElement: env.document.body.childNodes[0],
      sentence: 'PageGloss content load test.'
    });

    assertEqual(env.errors.filter((item) => item.kind === 'throw').length, 0,
      'marking must not throw: ' + JSON.stringify(env.errors));
    assertEqual(calls.length, 1, 'the marking engine was asked to apply one set of ranges');
    assertEqual(calls[0].length, 1, 'the full sentence was matched once');
    assert(result, 'a card is returned so the user can retry after configuring');
    const notice = shadowText(env.document.body);
    assert(/未配置 LLM|not configured/i.test(notice), 'the notice is visible in the card as well, got: ' + notice.slice(0, 120));
  });

  await test('a background SPA url change is handled without throwing', async () => {
    const env = loadContentScriptStack(manifestFiles);
    await waitFor(() => env.sandbox.window.__pagegloss && env.sandbox.window.__pagegloss.state.settings);
    await waitFor(() => env.chrome.__messageListeners.length > 0);
    const before = env.errors.length;
    env.chrome.__messageListeners.forEach((listener) => {
      listener({ type: 'pg:urlChanged', url: 'https://example.com/next' }, {}, () => {});
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assertEqual(env.errors.length, before, 'route change must not throw: ' + JSON.stringify(env.errors));
    assertEqual(
      env.sandbox.window.__pagegloss.state.urlKey,
      'https://example.com/next',
      'the route key switched'
    );
  });

  const failed = results.filter((item) => !item.ok);
  results.forEach((item) => {
    console.log('[' + (item.ok ? 'PASS' : 'FAIL') + '] ' + item.name);
    if (!item.ok) console.log('       ' + item.error);
  });
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' content load tests passed');
  if (failed.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
