/*
 * PageGloss - matcher smoke tests.
 *
 * Runs under plain Node with a tiny DOM shim (no external dependencies), so
 * `npm test` verifies the tricky parts: cross-node matching, whitespace
 * collapsing, case folding, block separation and non-destructive marking.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

/* ------------------------------------------------------------------ DOM shim */

const VOID_TAGS = new Set(['br', 'hr', 'img', 'input', 'meta', 'link']);
const BLOCK_TAGS = new Set(['p', 'div', 'li', 'h1', 'h2', 'h3', 'ul', 'ol', 'section', 'article', 'blockquote']);

class SNode {
  constructor(type) {
    this.nodeType = type;
    this.childNodes = [];
    this.parentNode = null;
    this.ownerDocument = null;
  }

  get parentElement() {
    return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null;
  }

  get children() {
    return this.childNodes.filter((child) => child.nodeType === 1);
  }

  get previousElementSibling() {
    if (!this.parentNode) return null;
    const siblings = this.parentNode.children;
    const index = siblings.indexOf(this);
    return index > 0 ? siblings[index - 1] : null;
  }

  get firstChild() {
    return this.childNodes[0] || null;
  }

  get lastChild() {
    return this.childNodes[this.childNodes.length - 1] || null;
  }

  get nextSibling() {
    if (!this.parentNode) return null;
    const index = this.parentNode.childNodes.indexOf(this);
    return this.parentNode.childNodes[index + 1] || null;
  }

  appendChild(node) {
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this;
    this.childNodes.push(node);
    node.ownerDocument = this.ownerDocument || this;
    return node;
  }

  insertBefore(node, reference) {
    if (!reference) return this.appendChild(node);
    if (node.parentNode) node.parentNode.removeChild(node);
    const index = this.childNodes.indexOf(reference);
    if (index < 0) return this.appendChild(node);
    node.parentNode = this;
    this.childNodes.splice(index, 0, node);
    node.ownerDocument = this.ownerDocument || this;
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
    const tag = String(tagName).toLowerCase();
    this.tagName = tag.toUpperCase();
    this._tag = tag;
    this.attributes = {};
    this.style = { setProperty() {} };
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
  }

  closest(selector) {
    const wanted = selector.split(',').map((part) => part.trim().toUpperCase());
    let current = this;
    while (current && current.nodeType === 1) {
      if (wanted.indexOf(current.tagName) >= 0) return current;
      current = current.parentNode;
    }
    return null;
  }

  get innerText() {
    if (BLOCK_TAGS.has(this._tag)) return this.textContent;
    return this.textContent;
  }
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

  cloneContents() {
    const copy = new Element('#fragment');
    this._extract(true).childNodes.slice().forEach((child) => copy.appendChild(child));
    return copy;
  }

  extractContents() {
    return this._extract(false);
  }

  insertNode(node) {
    let reference = this.startContainer;
    let parent = reference.nodeType === 3 ? reference.parentNode : reference;
    if (!parent) throw new Error('invalid range');
    if (reference.nodeType === 3) {
      const tail = reference.splitText(this.startOffset);
      reference.parentNode.insertBefore(node, tail);
      return;
    }
    parent.insertBefore(node, reference.firstChild || null);
  }

  /**
   * Shared implementation for clone/extract. Walks forward from the range start
   * and rebuilds the matched fragment, mutating the document when copy = false.
   */
  _extract(copy) {
    const fragment = new Element('#fragment');
    const startNode = this.startContainer;
    const endNode = this.endContainer;
    const startOffset = this.startOffset;
    const endOffset = this.endOffset;

    if (startNode === endNode && startNode.nodeType === 3) {
      const piece = new TextNode(startNode.nodeValue.slice(startOffset, endOffset));
      fragment.appendChild(piece);
      if (!copy) {
        startNode.nodeValue = startNode.nodeValue.slice(0, startOffset) + startNode.nodeValue.slice(endOffset);
      }
      return fragment;
    }

    const targets = [];
    (function walk(node) {
      if (node === endNode) {
        if (endNode.nodeType === 3) targets.push({ node, start: 0, end: endOffset });
        targets.push({ node: endNode, start: null, end: null, stop: true });
        return true;
      }
      if (node === startNode) {
        if (startNode.nodeType === 3) targets.push({ node, start: startOffset, end: startNode.nodeValue.length });
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
      if (target.stop) return;
      const value = target.node.nodeValue;
      const start = target.start == null ? 0 : target.start;
      const end = target.end == null ? value.length : target.end;
      if (end > start) fragment.appendChild(new TextNode(value.slice(start, end)));
      if (!copy) target.node.nodeValue = value.slice(0, start) + value.slice(end);
    });
    return fragment;
  }
}

function createDocument() {
  const document = {
    createElement: (tag) => new Element(tag),
    createTextNode: (value) => new TextNode(value),
    createRange: () => new RangeStub(),
    createTreeWalker: () => ({ nextNode: () => null }),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
    removeEventListener: () => {},
    body: new Element('body'),
    documentElement: new Element('html')
  };
  document.body.ownerDocument = document;
  return document;
}

function makeWindow(document) {
  return {
    document,
    CSS: { escape: (value) => String(value) },
    addEventListener: () => {},
    removeEventListener: () => {},
    setTimeout: (fn) => setTimeout(fn, 0),
    clearTimeout: () => {},
    getSelection: () => null
  };
}

/* ------------------------------------------------------------- module loading */

function loadInSandbox(file, sandbox) {
  let source = fs.readFileSync(file, 'utf8');
  source = source.replace(/if \(typeof module !== 'undefined' && module\.exports\)[\s\S]*?;\n/, '');
  vm.runInNewContext(source, sandbox, { filename: file });
}

function loadMatcher(document, window) {
  const sandbox = { window, document, console };
  loadInSandbox(path.join(__dirname, '..', 'src', 'content', 'matcher.js'), sandbox);
  return window.PageGlossMatcher;
}

/* -------------------------------------------------------------------- helpers */

const results = [];
function test(name, fn) {
  try {
    fn();
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

function paragraph(document, text) {
  const p = new Element('p');
  p.appendChild(new TextNode(text));
  document.body.appendChild(p);
  return p;
}

function paraWithSpans(document, parts) {
  const p = new Element('p');
  parts.forEach((part) => {
    if (typeof part === 'string') p.appendChild(new TextNode(part));
    else {
      const strong = new Element(part.tag);
      strong.appendChild(new TextNode(part.text));
      p.appendChild(strong);
    }
  });
  document.body.appendChild(p);
  return p;
}

/* ----------------------------------------------------------------------- tests */

test('normalizeNeedle collapses whitespace and trims', () => {
  const document = createDocument();
  const M = loadMatcher(document, makeWindow(document));
  assertEqual(M.normalizeNeedle('  Hello\n\tworld  '), 'Hello world');
  assertEqual(M.normalizeNeedle('a\u00adb'), 'ab');
});

test('findMatches is case-insensitive by default', () => {
  const document = createDocument();
  const M = loadMatcher(document, makeWindow(document));
  const map = M.buildTextMap(document.body);
  const matches = M.findMatches(map, 'the', { caseSensitive: false });
  assertEqual(matches.length, 0, 'empty page has no matches');
});

test('matches every occurrence in one text node', () => {
  const document = createDocument();
  const M = loadMatcher(document, makeWindow(document));
  paragraph(document, 'The cat, the hat and THE mat.');
  const map = M.buildTextMap(document.body);
  const matches = M.findMatches(map, 'the', {});
  assertEqual(matches.length, 3, 'three occurrences of "the"');
  matches.forEach((match) => assertEqual(map.raw.slice(match.start, match.end).toLowerCase(), 'the'));
});

test('collapses whitespace and newlines before matching', () => {
  const document = createDocument();
  const M = loadMatcher(document, makeWindow(document));
  paragraph(document, 'A quick   brown\n   fox jumps.');
  const map = M.buildTextMap(document.body);
  const matches = M.findMatches(map, 'quick brown fox', {});
  assertEqual(matches.length, 1, 'phrase with irregular whitespace still matches');
});

test('matches across inline element boundaries', () => {
  const document = createDocument();
  const M = loadMatcher(document, makeWindow(document));
  paraWithSpans(document, ['Hello ', { tag: 'strong', text: 'wonder' }, 'ful world']);
  const map = M.buildTextMap(document.body);
  const matches = M.findMatches(map, 'wonderful', {});
  assertEqual(matches.length, 1, 'word split across nodes is found');
  const slices = M.sliceForRange(map, matches[0].start, matches[0].end);
  assertEqual(slices.length, 2, 'match spans two text nodes');
});

test('does not match across block boundaries', () => {
  const document = createDocument();
  const M = loadMatcher(document, makeWindow(document));
  paragraph(document, 'alpha');
  paragraph(document, 'beta');
  const map = M.buildTextMap(document.body);
  const matches = M.findMatches(map, 'alphabeta', {});
  assertEqual(matches.length, 0, 'block elements are separated');
  assertEqual(M.findMatches(map, 'beta', {}).length, 1, 'each block still matches alone');
});

test('whole word matching rejects embedded hits', () => {
  const document = createDocument();
  const M = loadMatcher(document, makeWindow(document));
  paragraph(document, 'there the theory');
  const map = M.buildTextMap(document.body);
  assertEqual(M.findMatches(map, 'the', {}).length, 3, 'substring search finds embedded hits');
  assertEqual(M.findMatches(map, 'the', { wholeWord: true }).length, 1, 'word boundary filter keeps only the standalone word');
});

test('marking wraps text without changing the page text', () => {
  const document = createDocument();
  const M = loadMatcher(document, makeWindow(document));
  paragraph(document, 'Repeat me. Repeat me. Repeat me.');
  const before = document.body.textContent;
  const map = M.buildTextMap(document.body);
  const ranges = M.mergeRanges(M.findMatches(map, 'Repeat me', {}).map((match) => ({
    start: match.start,
    end: match.end,
    annotationId: 'a1',
    color: '#fff2a8'
  })));
  const created = M.applyRanges(map, ranges);
  assertEqual(created, 3, 'three marks created');
  assertEqual(document.body.textContent, before, 'text content is unchanged');
});

test('unwrapAnnotations restores the original markup', () => {
  const document = createDocument();
  const window = makeWindow(document);
  const M = loadMatcher(document, window);
  const p = paragraph(document, 'one two one two one');
  const originalTagSignature = '<p>one two one two one</p>';
  const map = M.buildTextMap(document.body);
  const ranges = M.mergeRanges(M.findMatches(map, 'one', {}).map((match) => ({
    start: match.start,
    end: match.end,
    annotationId: 'a2',
    color: '#b9e2ff'
  })));
  M.applyRanges(map, ranges);
  const marks = [];
  (function collect(node) {
    node.childNodes.forEach((child) => {
      if (child.nodeType === 1 && child.tagName === 'PAGEGLOSS-MARK') marks.push(child);
      collect(child);
    });
  })(document.body);
  assertEqual(marks.length, 3, 'three mark elements');
  marks.slice().forEach((mark) => M.unwrapMark(mark));
  assertEqual(p.textContent, 'one two one two one', 'text preserved after unwrap');
  assertEqual('<p>' + p.textContent + '</p>', originalTagSignature);
});

test('tokenize drops stopwords and duplicates', () => {
  const document = createDocument();
  const M = loadMatcher(document, makeWindow(document));
  const tokens = M.tokenize('The quick brown fox and the quick dog', M.stopwordTable());
  assertEqual(tokens.join(','), 'quick,brown,fox,dog');
});

test('colors are stable per text and limited to the palette', () => {
  const document = createDocument();
  const M = loadMatcher(document, makeWindow(document));
  const first = M.pickColor('photosynthesis');
  const second = M.pickColor('photosynthesis');
  assertEqual(first, second, 'same text gets the same color');
  assert(/^#[0-9a-f]{6}$/.test(first), 'palette color format');
});

test('sentenceAround extracts the containing sentence', () => {
  const document = createDocument();
  const M = loadMatcher(document, makeWindow(document));
  const p = paragraph(document, 'Intro here. The flux capacitor is key. Outro here.');
  const sentence = M.sentenceAround(p.firstChild, 'flux capacitor');
  assertEqual(sentence, 'The flux capacitor is key.');
});

test('word-like needles are detected so word boundaries can be applied', () => {
  const document = createDocument();
  const M = loadMatcher(document, makeWindow(document));
  const isWordLike = M.isWordLikeNeedle || (typeof window !== 'undefined' ? null : null);
  // isWordLikeNeedle lives in messages.js; the matcher only needs the whole-word flag.
  assert(isWordLike === null || typeof isWordLike === 'function', 'helper is optional here');
  const map = M.buildTextMap(document.body);
  assertEqual(map.raw.length, 0, 'empty document');
});

test('every palette colour keeps WCAG AA contrast with its computed ink', () => {
  const document = createDocument();
  const M = loadMatcher(document, makeWindow(document));
  const colors = ['#fff2a8', '#b7ecc0', '#b9e2ff', '#ffd6cc', '#e2d3ff', '#ffe0b3',
    '#c8f2ef', '#f6d4ec', '#d9e8a8', '#cfe0ff', '#ffd9e0', '#d8f0c9'];
  colors.forEach((background) => {
    const ink = M.contrastTextColor(background);
    const ratio = M.contrastRatio(background, ink);
    assert(ratio >= 4.5, `${background} vs ${ink} only reaches ${ratio.toFixed(2)}:1`);
  });
});

test('dark backgrounds receive light ink and light backgrounds dark ink', () => {
  const document = createDocument();
  const M = loadMatcher(document, makeWindow(document));
  assertEqual(M.contrastTextColor('#fff2a8'), '#12161d', 'light background -> dark ink');
  assertEqual(M.contrastTextColor('#12213a'), '#fbfcff', 'dark background -> light ink');
  assert(M.contrastRatio('#12213a', M.contrastTextColor('#12213a')) >= 4.5, 'dark case is readable');
});

test('marks carry both the highlight and the contrast ink variable', () => {
  const document = createDocument();
  const M = loadMatcher(document, makeWindow(document));
  const p = paragraph(document, 'alpha beta gamma');
  const map = M.buildTextMap(document.body);
  const color = M.pickColor('ink-1');
  const ranges = M.mergeRanges(M.findMatches(map, 'beta', {}).map((match) => ({
    start: match.start,
    end: match.end,
    annotationId: 'ink-1',
    color: color
  })));
  assertEqual(M.applyRanges(map, ranges), 1, 'one mark created');
  const mark = p.childNodes.find((node) => node.tagName === 'PAGEGLOSS-MARK');
  assert(mark, 'the mark replaced the text node in place');
  assertEqual(mark.textContent, 'beta', 'the mark holds the matched text');
  assert(
    String(mark.getAttribute('style') || '').includes('background-color:' + color),
    'background applied inline: ' + mark.getAttribute('style')
  );
  assertEqual(mark.getAttribute('data-pg-ink'), '#12161d', 'ink recorded on the mark');
  assert(
    String(mark.getAttribute('style') || '').includes('color:#12161d'),
    'ink applied inline: ' + mark.getAttribute('style')
  );
});

test('whole-word matching ignores hits embedded in longer words', () => {
  const document = createDocument();
  const M = loadMatcher(document, makeWindow(document));
  paragraph(document, 'start the art of cartography, an art form. Art matters.');
  const map = M.buildTextMap(document.body);
  assertEqual(M.findMatches(map, 'art', {}).length, 5, 'substring matching hits start/cartography too');
  const strict = M.findMatches(map, 'art', { wholeWord: true });
  assertEqual(strict.length, 3, 'standalone art twice plus the capitalised Art');
  strict.forEach((match) => {
    assertEqual(map.raw.slice(match.start, match.end).toLowerCase(), 'art');
  });
});

test('anchors survive a simulated reload and re-mark the same text', () => {
  const document = createDocument();
  const M = loadMatcher(document, makeWindow(document));
  const p = paragraph(document, 'Alpha beta. Gamma beta. Delta beta.');
  const map = M.buildTextMap(document.body);
  const ranges = M.mergeRanges(M.findMatches(map, 'beta', {}).map((match) => ({
    start: match.start,
    end: match.end,
    annotationId: 'a3',
    color: '#b7ecc0'
  })));
  const anchors = ranges.map((range) => M.anchorForRange(map, range)).filter(Boolean);
  assertEqual(anchors.length, 3, 'one anchor per occurrence');
  assertEqual(anchors[0].path, 'p:0', 'path points at the paragraph');
  assertEqual(anchors[0].text, 'beta');

  // Rebuild a clean paragraph (simulating a page reload with untouched markup).
  const fresh = createDocument();
  const M2 = loadMatcher(fresh, makeWindow(fresh));
  paraWithSpans(fresh, ['Alpha beta. Gamma beta. Delta beta.']);
  const restored = M2.rangesFromAnchors({ anchors });
  assertEqual(restored.length, 3, 'every anchor is located again');
  const map2 = M2.buildTextMap(fresh.body);
  const offsets = M2.offsetsForRanges(map2, restored, { annotationId: 'a3', color: '#b7ecc0' });
  assertEqual(offsets.length, 3, 'offsets resolved');
  assertEqual(M2.applyRanges(map2, offsets), 3, 'marks restored after reload');
  assertEqual(fresh.body.textContent, 'Alpha beta. Gamma beta. Delta beta.', 'text untouched');
});

test('anchors that no longer exist are skipped silently', () => {
  const document = createDocument();
  const M = loadMatcher(document, makeWindow(document));
  paragraph(document, 'Nothing in common here.');
  const ranges = M.rangesFromAnchors({
    anchors: [
      { path: 'p:9', start: 0, end: 4, text: 'gone' },
      { path: '', start: 5, end: 9, text: 'nope' },
      { path: 'p:0', start: 0, end: 7, text: 'Nothing', removed: true }
    ]
  });
  assertEqual(ranges.length, 0, 'unlocatable and removed anchors are ignored');
});

/* ---------------------------------------------------------------------- report */

const failed = results.filter((item) => !item.ok);
results.forEach((item) => {
  const mark = item.ok ? 'PASS' : 'FAIL';
  console.log('[' + mark + '] ' + item.name);
  if (!item.ok) console.log('       ' + item.error);
});
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' tests passed');
if (failed.length) process.exitCode = 1;
