/*
 * PageGloss - content script integration test.
 *
 * Loads the real content scripts (matcher.js + the first half of main.js) against
 * a tiny DOM shim and a fake chrome API, then drives the full flow:
 *   mark -> verify every repeated occurrence -> persist -> simulate reload ->
 *   restore -> remove one occurrence -> remove the term -> reload again.
 *
 * Run with: node tests/integration.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const BODY_HTML = '<body><div id="pg-root"><div id="pg-a"><p id="pg-p1">hello world</p></div><div id="pg-b"><p id="pg-p2">hello world</p></div></div></body>';
const WORD_BODY_HTML = '<body><div id="pg-root"><p id="pg-w1">the start of cartography, an art form</p><p id="pg-w2">art matters</p></div></body>';
const ORIGINAL_TEXT = 'hello worldhello world';

/* ------------------------------------------------------------------ DOM shim */

class SNode {
  constructor(type) {
    this.nodeType = type;
    this.childNodes = [];
    this.parentNode = null;
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
    const siblings = this.parentNode.childNodes;
    const index = siblings.indexOf(this);
    return index >= 0 ? siblings[index + 1] || null : null;
  }

  get previousElementSibling() {
    const siblings = this.parentNode ? this.parentNode.children : [];
    const index = siblings.indexOf(this);
    return index > 0 ? siblings[index - 1] : null;
  }

  appendChild(node) {
    if (node.parentNode) node.parentNode.removeChild(node);
    if (node.tagName === '#FRAGMENT') {
      // The real DOM moves a DocumentFragment's children instead of nesting it.
      node.childNodes.slice().forEach((child) => this.appendChild(child));
      return node;
    }
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
    this.appendChild(new TextNode(String(value)));
  }
}

class TextNode extends SNode {
  constructor(value) {
    super(3);
    this.nodeValue = value;
  }

  splitText(offset) {
    const rest = this.nodeValue.slice(offset);
    this.nodeValue = this.nodeValue.slice(0, offset);
    const sibling = new TextNode(rest);
    if (this.parentNode) {
      const index = this.parentNode.childNodes.indexOf(this);
      this.parentNode.childNodes.splice(index + 1, 0, sibling);
      sibling.parentNode = this.parentNode;
    }
    return sibling;
  }
}

class Element extends SNode {
  constructor(tagName) {
    super(1);
    this.tagName = String(tagName).toUpperCase();
    this.attributes = {};
    this.style = {
      setProperty(name, value) { this[name] = value; },
      cssText: ''
    };
    this.dataset = {};
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
    return { left: 10, top: 20, right: 210, bottom: 40, width: 200, height: 20 };
  }

  attachShadow() {
    const root = new Element('#shadow-root');
    this.shadowRoot = root;
    return root;
  }

  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }

  addEventListener() {}
}

class RangeStub {
  setStart(node, offset) {
    this.startContainer = node;
    this.startOffset = offset;
  }

  setEnd(node, offset) {
    this.endContainer = node;
    this.endOffset = offset;
  }

  toString() {
    return this.cloneContents().textContent;
  }

  cloneRange() {
    const copy = new RangeStub();
    copy.setStart(this.startContainer, this.startOffset);
    copy.setEnd(this.endContainer, this.endOffset);
    return copy;
  }

  cloneContents() {
    const copy = new Element('#fragment');
    this._collect(true).forEach((piece) => copy.appendChild(piece));
    return copy;
  }

  extractContents() {
    const fragment = new Element('#fragment');
    this._collect(false).forEach((piece) => fragment.appendChild(piece));
    return fragment;
  }

  insertNode(node) {
    const reference = this.startContainer;
    if (reference.nodeType === 3) {
      const tail = reference.splitText(this.startOffset);
      reference.parentNode.insertBefore(node, tail);
      return;
    }
    reference.parentNode.insertBefore(node, reference.firstChild || null);
  }
  _collect(copy) {
    const pieces = [];
    const startNode = this.startContainer;
    const endNode = this.endContainer;
    const startOffset = this.startOffset;
    const endOffset = this.endOffset;

    if (startNode === endNode) {
      pieces.push(new TextNode(startNode.nodeValue.slice(startOffset, endOffset)));
      if (!copy) {
        startNode.nodeValue = startNode.nodeValue.slice(0, startOffset) + startNode.nodeValue.slice(endOffset);
      }
      return pieces;
    }

    const targets = [];
    (function walk(node) {
      if (node === endNode) {
        if (endNode.nodeType === 3) targets.push({ node: endNode, start: 0, end: endOffset });
        return true;
      }
      if (node === startNode) {
        if (startNode.nodeType === 3) targets.push({ node: startNode, start: startOffset, end: startNode.nodeValue.length });
        let child = startNode.firstChild;
        while (child) {
          if (walk(child)) return true;
          child = child.nextSibling;
        }
        let after = startNode.nextSibling;
        while (after) {
          if (walk(after)) return true;
          after = after.nextSibling;
        }
        let up = startNode.parentNode;
        while (up && up !== endNode) {
          let sibling = up.nextSibling;
          while (sibling) {
            if (walk(sibling)) return true;
            sibling = sibling.nextSibling;
          }
          up = up.parentNode;
        }
        return false;
      }
      if (node.nodeType === 3) {
        targets.push({ node, start: 0, end: node.nodeValue.length });
        return false;
      }
      let child = node.firstChild;
      while (child) {
        if (walk(child)) return true;
        child = child.nextSibling;
      }
      return false;
    })(startNode);

    targets.forEach((target) => {
      const value = target.node.nodeValue;
      const start = target.start == null ? 0 : target.start;
      const end = target.end == null ? value.length : target.end;
      if (end > start) pieces.push(new TextNode(value.slice(start, end)));
      if (!copy) target.node.nodeValue = value.slice(0, start) + value.slice(end);
    });
    return pieces;
  }
}

function createDom(bodyKind) {
  const document = {
    createElement: (tag) => new Element(tag),
    createTextNode: (value) => new TextNode(value),
    createRange: () => new RangeStub(),
    createTreeWalker: () => ({ nextNode: () => null }),
    querySelector: () => null,
    querySelectorAll: (selector) => queryAll(document.body, selector),
    addEventListener: () => {},
    removeEventListener: () => {},
    elementFromPoint: () => null,
    body: new Element('body'),
    documentElement: new Element('html'),
    readyState: 'complete',
    title: 'Integration test page'
  };
  document.body.appendChild(parseBody(document, bodyKind));
  return document;
}

/** Minimal selector support for the tag / tag[attr] / tag[attr="value"] queries. */
function queryAll(root, selector) {
  const match = /^\s*([a-z0-9-]+)(?:\[([a-z-]+)(?:="([^"]*)")?\])?\s*$/i.exec(String(selector));
  if (!match) return [];
  const tag = match[1].toUpperCase();
  const attribute = match[2];
  const expected = match[3];
  const presenceOnly = Boolean(attribute) && match[3] === undefined;
  const out = [];
  (function walk(node) {
    node.childNodes.forEach((child) => {
      if (child.nodeType !== 1) return;
      if (child.tagName === tag) {
        if (!attribute) out.push(child);
        else if (presenceOnly ? child.getAttribute(attribute) != null : child.getAttribute(attribute) === expected) out.push(child);
      }
      walk(child);
    });
  })(root);
  return out;
}

/** Build the canned body markup. kind: 'words' for the word-boundary fixture. */
function parseBody(document, kind) {
  if (kind === 'ma' || kind === 'ma-embedded') {
    // "MA" must not mark make/matter/mark/human: the strict fixture keeps one
    // standalone MA, the embedded one has none.
    const maRoot = new Element('div');
    maRoot.setAttribute('id', 'pg-root');
    const sentence = kind === 'ma'
      ? 'make matter mark human MA'
      : 'make matter mark human';
    const maParagraph = new Element('p');
    maParagraph.setAttribute('id', 'pg-ma');
    maParagraph.appendChild(new TextNode(sentence));
    maRoot.appendChild(maParagraph);
    return maRoot;
  }
  if (kind === 'changed') {
    // Same URL, completely different article: cached annotations must not be
    // drawn over unrelated words (the reported misalignment bug).
    const changedRoot = new Element('div');
    changedRoot.setAttribute('id', 'pg-root');
    const paragraph = new Element('p');
    paragraph.setAttribute('id', 'pg-changed');
    paragraph.appendChild(new TextNode('A rewritten article about something else entirely.'));
    changedRoot.appendChild(paragraph);
    return changedRoot;
  }
  if (kind === 'words') {
    const wordRoot = new Element('div');
    wordRoot.setAttribute('id', 'pg-root');
    [['pg-w1', 'the start of cartography, an art form'], ['pg-w2', 'art matters']].forEach(([id, text]) => {
      const p = new Element('p');
      p.setAttribute('id', id);
      p.appendChild(new TextNode(text));
      wordRoot.appendChild(p);
    });
    return wordRoot;
  }
  const root = new Element('div');
  root.setAttribute('id', 'pg-root');
  ['pg-a', 'pg-b'].forEach((containerId, index) => {
    const container = new Element('div');
    container.setAttribute('id', containerId);
    const paragraph = new Element('p');
    paragraph.setAttribute('id', index === 0 ? 'pg-p1' : 'pg-p2');
    paragraph.appendChild(new TextNode('hello world'));
    container.appendChild(paragraph);
    root.appendChild(container);
  });
  return root;
}

function makeWindow(document) {
  return {
    document,
    innerWidth: 1280,
    innerHeight: 800,
    location: { href: 'https://example.com/article?utm_source=test' },
    CSS: { escape: (value) => String(value) },
    addEventListener: () => {},
    removeEventListener: () => {},
    setTimeout: (fn, delay) => setTimeout(fn, delay),
    clearTimeout: (handle) => clearTimeout(handle),
    getSelection: () => null,
    navigator: { language: 'zh-CN' }
  };
}

/* ---------------------------------------------------------------- fake chrome */

function createChrome(storage) {
  const connectListeners = [];
  const messageListeners = [];
  const chrome = {
    runtime: {
      lastError: null,
      connect: () => ({
        onMessage: { addListener: () => {} },
        onDisconnect: { addListener: () => {} },
        postMessage: () => {},
        disconnect: () => {}
      }),
      onMessage: { addListener: (fn) => messageListeners.push(fn) },
      sendMessage: () => {},
      getManifest: () => ({ version: '1.0.0' }),
      getURL: (value) => 'chrome-extension://test/' + value
    },
    storage: {
      local: {
        get: (keys, callback) => callback(storage.snapshot(keys)),
        set: (items, callback) => {
          storage.applySet(items);
          if (callback) callback();
        },
        remove: (keys, callback) => {
          storage.applyRemove(keys);
          if (callback) callback();
        }
      },
      onChanged: { addListener: () => {} }
    },
    i18n: { getUILanguage: () => 'zh-CN' },
    permissions: {
      contains: async () => true,
      request: async () => true
    },
    __connectListeners: connectListeners,
    __messageListeners: messageListeners
  };
  return chrome;
}

function createStore() {
  const data = new Map();
  return {
    data,
    snapshot(keys) {
      if (keys == null) {
        const out = {};
        data.forEach((value, key) => { out[key] = value; });
        return out;
      }
      if (Array.isArray(keys)) {
        const out = {};
        keys.forEach((key) => { if (data.has(key)) out[key] = data.get(key); });
        return out;
      }
      if (typeof keys === 'string') {
        return data.has(keys) ? { [keys]: data.get(keys) } : {};
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

/* -------------------------------------------------------------------- loading */

function loadScript(file, sandbox) {
  let source = fs.readFileSync(file, 'utf8');
  source = source.replace(/if \(typeof module !== 'undefined' && module\.exports\)[\s\S]*?;\n/, '');
  vm.runInContext(source, sandbox, { filename: file });
}

function createSandbox(document, window, chrome) {
  const sandbox = {
    document,
    chrome,
    location: window.location,
    NodeFilter: { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 },
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    CSS: window.CSS,
    navigator: window.navigator,
    getSelection: window.getSelection,
    addEventListener: window.addEventListener,
    removeEventListener: window.removeEventListener,
    console,
    Promise,
    Map,
    Set,
    Date,
    Math,
    JSON,
    URL,
    setTimeout,
    clearTimeout,
    queueMicrotask
  };
  // A browser window IS the global object, so the shared classic scripts that
  // publish globalThis.PageGloss* must be visible as window.PageGloss* here.
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  return sandbox;
}

function bootContent(bodyKind) {
  const document = createDom(bodyKind);
  const window = makeWindow(document);
  const store = createStore();
  const chrome = createChrome(store);
  const sandbox = createSandbox(document, window, chrome);
  loadScript(path.join(ROOT, 'src/shared/messages.js'), sandbox);
  loadScript(path.join(ROOT, 'src/shared/i18n.js'), sandbox);
  loadScript(path.join(ROOT, 'src/shared/storage.js'), sandbox);
  sandbox.window.PageGlossCard = createCardStub();
  loadScript(path.join(ROOT, 'src/content/matcher.js'), sandbox);
  loadScript(path.join(ROOT, 'src/content/main.js'), sandbox);
  return { document, window, chrome, store, sandbox };
}

function bootContentWithStore(store, bodyKind) {
  const document = createDom(bodyKind);
  const window = makeWindow(document);
  const chrome = createChrome(store);
  const sandbox = createSandbox(document, window, chrome);
  loadScript(path.join(ROOT, 'src/shared/messages.js'), sandbox);
  loadScript(path.join(ROOT, 'src/shared/i18n.js'), sandbox);
  loadScript(path.join(ROOT, 'src/shared/storage.js'), sandbox);
  sandbox.window.PageGlossCard = createCardStub();
  loadScript(path.join(ROOT, 'src/content/matcher.js'), sandbox);
  loadScript(path.join(ROOT, 'src/content/main.js'), sandbox);
  return { document, window, chrome, store, sandbox };
}

/** Minimal card stub: records interactions without needing Shadow DOM. */
function createCardStub() {
  return {
    renderMarkdown: (value) => String(value || ''),
    create(options) {
      const card = {
        options,
        messages: [],
        handlers: {},
        pinned: false,
        destroyed: false,
        host: new Element('pagegloss-ui'),
        card: { querySelectorAll: () => [] },
        setHandlers(next) { this.handlers = next || {}; },
        setPinned(value) { this.pinned = !!value; },
        isPinned() { return this.pinned; },
        addUserMessage(text) { this.messages.push({ role: 'user', content: text }); },
        addAssistantMarkdown(text) { this.messages.push({ role: 'assistant', content: text }); },
        addNotice(text) { this.messages.push({ role: 'notice', content: text }); },
        addNoticeAction(text) { this.messages.push({ role: 'notice', content: text }); },
        addError(text) { this.messages.push({ role: 'error', content: text }); },
        addState() { return {}; },
        removeState() {},
        setBusy() {},
        submit(question) { if (this.handlers.onAsk) this.handlers.onAsk(question, {}); },
        focus() {},
        abort() {},
        scrollToEnd() {},
        setPosition() {},
        // 1.1.0 additions: notes, typing guard, animated close, reasoning.
        appendReasoning(text) { this.messages.push({ role: 'reasoning', content: text }); },
        setNote(text) { this.note = String(text || ''); },
        getNote() { return this.note || ''; },
        isTyping() { return !!this.typing; },
        flashNoteSaved() {},
        close() { this.destroyed = true; },
        destroy() { this.destroyed = true; }
      };
      return card;
    }
  };
}

function marksIn(document) {
  const marks = [];
  (function collect(node) {
    node.childNodes.forEach((child) => {
      if (child.nodeType === 1 && child.tagName === 'PAGEGLOSS-MARK') marks.push(child);
      collect(child);
    });
  })(document.body);
  return marks;
}

function bodyHtml(document, options) {
  const opts = options || {};
  function render(node) {
    if (node.nodeType === 3) return node.nodeValue;
    const tag = node.tagName.toLowerCase();
    if (tag === '#fragment') {
      // The real DOM flattens DocumentFragments on insert; the shim keeps them.
      return node.childNodes.map(render).join('');
    }
    if (opts.ignoreUi && tag === 'pagegloss-ui') return '';
    if (opts.ignoreMarks && tag === 'pagegloss-mark') return node.childNodes.map(render).join('');
    const id = node.getAttribute && node.getAttribute('id');
    const head = '<' + tag + (id ? ' id="' + id + '"' : '') + '>';
    return head + node.childNodes.map(render).join('') + '</' + tag + '>';
  }
  return render(document.body);
}

function dispatch(chrome, message) {
  return new Promise((resolve) => {
    let handled = false;
    chrome.__messageListeners.forEach((listener) => {
      const result = listener(message, {}, (response) => {
        handled = true;
        resolve(response);
      });
      if (result === true) handled = true;
    });
    setTimeout(() => { if (!handled) resolve(null); }, 60);
    if (!chrome.__messageListeners.length) resolve(null);
  });
}

function waitFor(check, timeout = 1500) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      let value = false;
      try { value = check(); } catch (err) { value = false; }
      if (value) { resolve(value); return; }
      if (Date.now() - started > timeout) { reject(new Error('timeout waiting for condition')); return; }
      setTimeout(tick, 15);
    };
    tick();
  });
}

/* ------------------------------------------------------------------ test body */

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
  await test('boot loads settings and page state', async () => {
    const env = bootContent();
    await waitFor(() => env.sandbox.window.__pagegloss && env.sandbox.window.__pagegloss.state.settings);
    const state = env.sandbox.window.__pagegloss.state;
    assertEqual(state.settings.contextMode, 'page', 'default context mode');
    assertEqual(state.settings.enabled, true, 'enabled by default');
    assertEqual(bodyHtml(env.document, { ignoreUi: true }), BODY_HTML, 'page untouched before marking');
  });

  await test('marking explains nothing but marks every occurrence', async () => {
    const env = bootContent();
    await waitFor(() => env.sandbox.window.__pagegloss.state.settings);
    env.sandbox.window.__pagegloss.mark({
      text: 'hello world',
      anchorElement: env.document.body.childNodes[0].childNodes[0].childNodes[0],
      sentence: 'hello world'
    });
    const marks = marksIn(env.document);
    assertEqual(marks.length, 2, 'both occurrences marked');
    assertEqual(marks[0].getAttribute('data-pg-id'), marks[1].getAttribute('data-pg-id'), 'same annotation id');
    assert(/^#[0-9a-f]{6}$/.test(marks[0].getAttribute('data-pg-color')), 'color attribute present');

    // The rendered text and markup must be identical to the original.
    assertEqual(bodyHtml(env.document, { ignoreMarks: true, ignoreUi: true }), BODY_HTML, 'text and markup preserved');

    const annotations = env.sandbox.window.__pagegloss.state.annotations;
    assertEqual(annotations.length, 1, 'one annotation registered');
    assertEqual(annotations[0].anchors.length, 2, 'two anchors stored');
    assertEqual(annotations[0].anchors[0].path, 'div:0/div:0/p:0', 'anchor path points at the containing block');
    assertEqual(annotations[0].marks, 2, 'mark count recorded');
  });

  await test('state is persisted to storage and survives a reload', async () => {
    const env = bootContent();
    await waitFor(() => env.sandbox.window.__pagegloss.state.settings);
    env.sandbox.window.__pagegloss.mark({
      text: 'hello world',
      anchorElement: env.document.body.childNodes[0].childNodes[0].childNodes[0],
      sentence: 'hello world'
    });
    const key = env.sandbox.window.__pagegloss.state.urlKey;
    await waitFor(() => {
      const stored = env.store.data.get('pg:page:' + key);
      return stored && stored.annotations && stored.annotations.length === 1;
    });
    const stored = env.store.data.get('pg:page:' + key);
    assertEqual(stored.urlKey, key, 'stored under the url key');
    assertEqual(stored.annotations[0].text, 'hello world', 'text stored');
    assert(!('anchorElement' in stored.annotations[0]), 'DOM references are not persisted');
    assertEqual(stored.annotations[0].anchors.length, 2, 'anchors persisted');

    // Fresh environment with the same storage: markings are restored.
    const restarted = bootContentWithStore(env.store);
    await waitFor(() => marksIn(restarted.document).length === 2, 2000);
    assertEqual(marksIn(restarted.document).length, 2, 'marks restored after reload');
    assertEqual(bodyHtml(restarted.document, { ignoreMarks: true, ignoreUi: true }), BODY_HTML, 'restored page text preserved');
  });

  await test('unwrapping a single mark restores its paragraph exactly', async () => {
    const env = bootContent();
    await waitFor(() => env.sandbox.window.__pagegloss.state.settings);
    env.sandbox.window.__pagegloss.mark({
      text: 'hello world',
      anchorElement: env.document.body.childNodes[0].childNodes[0].childNodes[0],
      sentence: 'hello world'
    });
    const annotationId = env.sandbox.window.__pagegloss.state.annotations[0].id;
    const first = marksIn(env.document)[0];
    const parent = first.parentNode;
    const before = first.textContent;

    // Same path the context menu takes: unwrap that single mark, then drop its anchor.
    const matcher = env.sandbox.window.PageGlossMatcher;
    const state = env.sandbox.window.__pagegloss.state;
    const annotation = state.annotations[0];
    const anchor = annotation.anchors.find((item) => {
      const container = matcher.elementByPath(item.path);
      return container && container.contains(first);
    });
    const outcome = env.sandbox.window.PageGlossStore.removeOccurrence(state.page, annotationId, anchor);
    matcher.unwrapMark(first);

    assertEqual(before, 'hello world', 'unwrapped text is intact');
    assertEqual(parent.textContent.replace(/\s+/g, ' ').trim(), 'hello world', 'paragraph text unchanged');
    assertEqual(marksIn(env.document).length, 1, 'one mark left');
    assert(outcome && outcome.removedAll === false, 'annotation kept, occurrence tombstoned');
    assertEqual(outcome.remaining, 1, 'store reports one live occurrence left');
  });

  await test('word-like selections only mark standalone occurrences', async () => {
    const env = bootContent('words');
    await waitFor(() => env.sandbox.window.__pagegloss.state.settings);
    const M = env.sandbox.window.PageGlossMatcher;
    const map = M.buildTextMap(env.document.body);

    // Greedy substring matching also hits "start", "cartography" and "matters".
    assertEqual(M.findMatches(map, 'art', {}).length, 4, 'substring matching is greedy');
    const strict = M.findMatches(map, 'art', { wholeWord: true });
    assertEqual(strict.length, 2, 'word boundaries keep start/cartography/matters out');
    strict.forEach((match) => {
      const word = map.raw.slice(match.start, match.end);
      assertEqual(word.toLowerCase(), 'art', 'only standalone words match, got ' + word);
    });
  });

  await test('marking a whole word leaves embedded words untouched', async () => {
    const env = bootContent('words');
    await waitFor(() => env.sandbox.window.__pagegloss.state.settings);
    env.sandbox.window.__pagegloss.mark({
      text: 'art',
      anchorElement: env.document.body.childNodes[0].childNodes[0].childNodes[0],
      sentence: 'the start of cartography, an art form'
    });
    const marks = marksIn(env.document).map((mark) => mark.textContent);
    assertEqual(marks.length, 2, 'only standalone hits are marked: ' + JSON.stringify(marks));
    marks.forEach((word) => assertEqual(word.toLowerCase(), 'art', 'marked word is exactly "art"'));
    const state = env.sandbox.window.__pagegloss.state;
    assertEqual(state.annotations[0].marks, 2, 'annotation records two marks');
    const text = env.document.body.textContent;
    ['the start of cartography', 'matters'].forEach((fragment) => {
      assert(text.indexOf(fragment) >= 0, 'embedded word kept intact: ' + fragment);
    });
  });

  await test('loose mode keeps the old greedy behaviour', async () => {
    const env = bootContent('words');
    await waitFor(() => env.sandbox.window.__pagegloss.state.settings);
    env.sandbox.window.__pagegloss.state.settings.matchMode = 'loose';
    env.sandbox.window.__pagegloss.mark({
      text: 'art',
      anchorElement: env.document.body.childNodes[0].childNodes[0].childNodes[0],
      sentence: 'the start of cartography, an art form'
    });
    const marks = marksIn(env.document).map((mark) => mark.textContent);
    assertEqual(marks.length, 4, 'loose mode marks every containing word: ' + JSON.stringify(marks));
  });

  await test('strict mode never falls back to containing words', async () => {
    const env = bootContent('words');
    await waitFor(() => env.sandbox.window.__pagegloss.state.settings);
    env.sandbox.window.__pagegloss.state.settings.matchMode = 'strict';
    env.sandbox.window.__pagegloss.mark({
      text: 'matters',
      anchorElement: env.document.body.childNodes[0].childNodes[0].childNodes[0],
      sentence: 'art matters'
    });
    // "matters" only exists as a stand-alone word once, so strict finds it.
    assertEqual(marksIn(env.document).length, 1, 'the stand-alone word is marked');
    // "atter" only exists inside "matters", so strict finds nothing.
    const before = marksIn(env.document).length;
    env.sandbox.window.__pagegloss.mark({
      text: 'atter',
      anchorElement: env.document.body.childNodes[0].childNodes[0].childNodes[0],
      sentence: 'art matters'
    });
    assertEqual(marksIn(env.document).length, before, 'nothing embedded is marked in strict mode');
    assertEqual(env.sandbox.window.__pagegloss.state.annotations.length, 1, 'no annotation was created');
  });

  await test('removing one occurrence survives a reload', async () => {
    const env = bootContent();
    await waitFor(() => env.sandbox.window.__pagegloss.state.settings);
    env.sandbox.window.__pagegloss.mark({
      text: 'hello world',
      anchorElement: env.document.body.childNodes[0].childNodes[0].childNodes[0],
      sentence: 'hello world'
    });
    await waitFor(() => marksIn(env.document).length === 2);
    env.sandbox.window.__pagegloss.removeOccurrenceAt(marksIn(env.document)[0]);
    assertEqual(marksIn(env.document).length, 1, 'one mark left in the live page');

    const key = env.sandbox.window.__pagegloss.state.urlKey;
    // Wait until the tombstoned annotation reached storage, then reload the page.
    await waitFor(() => {
      const stored = env.store.data.get('pg:page:' + key);
      if (!stored || !stored.annotations.length) return false;
      const anchors = stored.annotations[0].anchors;
      return anchors.length === 2 && anchors.filter((item) => item.removed).length === 1;
    });
    const restarted = bootContentWithStore(env.store);
    await waitFor(() => marksIn(restarted.document).length === 1, 2000);
    assertEqual(marksIn(restarted.document).length, 1, 'removed occurrence stays removed after reload');
    assertEqual(bodyHtml(restarted.document, { ignoreMarks: true, ignoreUi: true }), BODY_HTML, 'page text intact after reload');
  });

  await test('clearPage wipes marks, state and storage', async () => {    const env = bootContent();
    await waitFor(() => env.sandbox.window.__pagegloss.state.settings);
    env.sandbox.window.__pagegloss.mark({
      text: 'hello world',
      anchorElement: env.document.body.childNodes[0].childNodes[0].childNodes[0],
      sentence: 'hello world'
    });
    await waitFor(() => marksIn(env.document).length === 2);
    const key = env.sandbox.window.__pagegloss.state.urlKey;
    await waitFor(() => env.store.data.has('pg:page:' + key));
    env.sandbox.window.__pagegloss.clear();
    await waitFor(() => env.sandbox.window.__pagegloss.state.annotations.length === 0);
    assertEqual(marksIn(env.document).length, 0, 'marks removed');
    await waitFor(() => !env.store.data.has('pg:page:' + key));
    assert(!env.store.data.has('pg:page:' + key), 'page storage removed');
    assertEqual(bodyHtml(env.document, { ignoreUi: true }), BODY_HTML, 'page restored to original markup');
  });

  await test('queryState reports annotations and context mode', async () => {
    const env = bootContent();
    await waitFor(() => env.sandbox.window.__pagegloss.state.settings);
    env.sandbox.window.__pagegloss.mark({
      text: 'hello world',
      anchorElement: env.document.body.childNodes[0].childNodes[0].childNodes[0],
      sentence: 'hello world'
    });
    const response = await dispatch(env.chrome, { type: 'pg:queryState' });
    assert(response && response.ok, 'queryState responded');
    assertEqual(response.contextMode, 'page', 'context mode reported');
    assertEqual(response.annotations.length, 1, 'annotation listed');
    assertEqual(response.annotations[0].marks, 2, 'mark count reported');
  });

  await test('site grouping ignores www and keeps the protocol', async () => {
    const env = bootContent('words');
    const S = env.sandbox.PageGlossShared;
    assertEqual(S.siteGroupOf('https://www.example.com/a/b?x=1'), 'https://example.com', 'www stripped');
    assertEqual(S.siteGroupOf('http://blog.example.com:8080/x'), 'http://blog.example.com:8080', 'port kept');
    assertEqual(S.siteGroupOf('https://example.com/y'), 'https://example.com', 'same bucket');
    assertEqual(S.siteGroupOf('not a url'), 'not a url', 'unparsable input passes through');
  });

  await test('notes round-trip through storage with a fresh updatedAt', async () => {
    const env = bootContent('words');
    const Store = env.sandbox.PageGlossStore;
    const page = Store.sanitizePage({
      url: 'https://example.com/a',
      title: 'A',
      annotations: [{ id: 'a1', text: 'alpha', color: '#fff2a8', anchors: [] }]
    }, 'https://example.com/a');
    const before = Date.now();
    Store.setNote(page, 'a1', 'my note');
    assertEqual(page.annotations[0].note, 'my note', 'note is written onto the annotation');
    assert(page.annotations[0].updatedAt >= before, 'updatedAt is bumped');
    assertEqual(page.annotations[0].note, 'my note', 'note stays readable');
    await Store.savePage(page);
    const all = await Store.getAllPages();
    assertEqual(all.length, 1, 'one page is listed');
    assertEqual(all[0].annotations[0].note, 'my note', 'note survives the storage round trip');
    assert(all[0].annotations[0].noteUpdatedAt > 0, 'noteUpdatedAt is persisted');
  });

  await test('a stale flag survives the storage round trip', async () => {
    const env = bootContent('words');
    const Store = env.sandbox.PageGlossStore;
    const page = Store.sanitizePage({
      url: 'https://example.com/a',
      title: 'A',
      annotations: [{
        id: 'a1',
        text: 'alpha',
        color: '#fff2a8',
        anchors: [],
        stale: true,
        staleAt: 1700000000000,
        lastCheckedAt: 1700000000000
      }]
    }, 'https://example.com/a');
    await Store.savePage(page);
    const all = await Store.getAllPages();
    const saved = all[0].annotations[0];
    assertEqual(saved.stale, true, 'stale flag is preserved');
    assertEqual(saved.staleAt, 1700000000000, 'staleAt is preserved');
    assertEqual(saved.lastCheckedAt, 1700000000000, 'lastCheckedAt is preserved');
  });

  await test('an exported backup can be imported again', async () => {
    const env = bootContent('words');
    const Store = env.sandbox.PageGlossStore;
    const page = Store.sanitizePage({
      url: 'https://example.com/a',
      title: 'A',
      annotations: [{ id: 'a1', text: 'alpha', color: '#fff2a8', anchors: [], note: 'kept' }]
    }, 'https://example.com/a');
    await Store.savePage(page);

    // Exactly the shape the data page downloads: the options importer must eat it.
    const backup = {
      format: 'pagegloss-backup',
      version: 1,
      exportedAt: new Date().toISOString(),
      scope: { type: 'page', label: 'example.com' },
      pages: {}
    };
    const pages = await Store.getAllPages();
    pages.forEach((item) => { backup.pages[item.urlKey] = item; });

    await Store.clearAll();
    assertEqual((await Store.getAllPages()).length, 0, 'cleared before import');
    const count = await Store.importAll(backup, { includeSettings: false });
    assertEqual(count, 1, 'one page imported');
    const restored = await Store.getPage('https://example.com/a');
    assertEqual(restored.annotations[0].note, 'kept', 'note survives export and import');
  });

  await test('a rewritten page does not restore misaligned marks', async () => {
    const env = bootContent();
    await waitFor(() => env.sandbox.window.__pagegloss.state.settings);
    env.sandbox.window.__pagegloss.mark({
      text: 'hello world',
      anchorElement: env.document.body.childNodes[0].childNodes[0].childNodes[0],
      sentence: 'hello world'
    });
    await waitFor(() => marksIn(env.document).length === 2);
    const key = env.sandbox.window.__pagegloss.state.urlKey;
    await waitFor(() => env.store.data.has('pg:page:' + key));

    // The same URL now serves different text.
    const restarted = bootContentWithStore(env.store, 'changed');
    await waitFor(() => restarted.sandbox.window.__pagegloss.state.annotations.length > 0, 2000);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assertEqual(marksIn(restarted.document).length, 0, 'nothing is highlighted on unrelated text');
    const annotation = restarted.sandbox.window.__pagegloss.state.annotations[0];
    assertEqual(annotation.stale, true, 'the cached annotation is flagged as stale');
    assertEqual(annotation.marks, 0, 'no live marks are reported');
  });

  await test('a short token only marks the standalone word', async () => {
    const env = bootContent('ma');
    await waitFor(() => env.sandbox.window.__pagegloss.state.settings);
    env.sandbox.window.__pagegloss.mark({
      text: 'MA',
      anchorElement: env.document.body.childNodes[0].childNodes[0].childNodes[0],
      sentence: 'make matter mark human MA'
    });
    await waitFor(() => env.sandbox.window.__pagegloss.state.annotations.length === 1);
    const marks = marksIn(env.document);
    assertEqual(marks.length, 1, 'only the standalone MA is marked');
    assertEqual(marks[0].textContent, 'MA', 'the marked text is MA');
    const bodyText = env.document.body.textContent;
    ['make', 'matter', 'mark', 'human'].forEach((word) => {
      assert(bodyText.indexOf(word) >= 0, word + ' stays untouched text');
    });
  });

  await test('a short token found only inside words asks before matching substrings', async () => {
    const env = bootContent('ma-embedded');
    await waitFor(() => env.sandbox.window.__pagegloss.state.settings);
    env.sandbox.window.__pagegloss.mark({
      text: 'MA',
      anchorElement: env.document.body.childNodes[0].childNodes[0].childNodes[0],
      sentence: 'make matter mark human'
    });
    await new Promise((resolve) => setTimeout(resolve, 120));
    assertEqual(marksIn(env.document).length, 0, 'nothing is marked without confirmation');
    assertEqual(env.sandbox.window.__pagegloss.state.annotations.length, 0, 'no annotation is stored yet');
  });

  const failed = results.filter((item) => !item.ok);
  results.forEach((item) => {
    console.log('[' + (item.ok ? 'PASS' : 'FAIL') + '] ' + item.name);
    if (!item.ok) console.log('       ' + item.error);
  });
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' integration tests passed');
  if (failed.length) process.exitCode = 1;
}

/** Boot a second content script instance that shares the given storage. */
main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
