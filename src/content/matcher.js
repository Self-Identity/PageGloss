/*
 * PageGloss - text matching engine (content script side, classic script).
 *
 * Strategy: the page DOM is never mutated. Highlights are freshly created
 * elements that wrap existing text nodes, and each mark carries a copy of the
 * computed color/style of its original parent, so removing a mark restores the
 * page byte for byte.
 */
(function () {
  'use strict';

  var SKIP_TAGS = {
    SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, TEXTAREA: 1, INPUT: 1,
    SELECT: 1, OPTION: 1, BUTTON: 1, CODE: 1, PRE: 1, KBD: 1, SAMP: 1,
    CANVAS: 1, SVG: 1, MATH: 1, IFRAME: 1, VIDEO: 1, AUDIO: 1, TITLE: 1,
    HEAD: 1, META: 1, LINK: 1, BASE: 1, OBJECT: 1, EMBED: 1
  };

  var BLOCK_TAGS = {
    ADDRESS: 1, ARTICLE: 1, ASIDE: 1, BLOCKQUOTE: 1, BODY: 1, CAPTION: 1,
    DD: 1, DETAILS: 1, DIALOG: 1, DIV: 1, DL: 1, DT: 1, FIELDSET: 1,
    FIGCAPTION: 1, FIGURE: 1, FOOTER: 1, FORM: 1, H1: 1, H2: 1, H3: 1,
    H4: 1, H5: 1, H6: 1, HEADER: 1, HGROUP: 1, HR: 1, LI: 1, MAIN: 1,
    NAV: 1, OL: 1, P: 1, PRE: 1, SECTION: 1, SUMMARY: 1, TABLE: 1,
    TBODY: 1, TD: 1, TFOOT: 1, TH: 1, THEAD: 1, TR: 1, UL: 1
  };

  var INVISIBLE_CHARS = /[\u00ad\u200b\u200c\u200d\u2060\ufeff]/;
  var SPACE_CHARS = /\s/;

  function isOwnNode(node) {
    var el = node && node.nodeType === 1 ? node : node && node.parentElement;
    return !!(el && el.closest && el.closest('pagegloss-mark, pagegloss-ui'));
  }

  function shouldSkipElement(el) {
    if (!el || el.nodeType !== 1) return false;
    if (SKIP_TAGS[el.tagName]) return true;
    if (el.isContentEditable) return true;
    if (el.getAttribute && el.getAttribute('aria-hidden') === 'true') return true;
    if (el.hidden) return true;
    return false;
  }

  /**
   * Build a normalized, whitespace-collapsed view of every visible text node.
   * blockGap inserts a single space between block level elements so phrases are
   * never matched across unrelated sections.
   */
  function buildTextMap(root, options) {
    var opts = options || {};
    var nodes = [];
    var chars = [];      // { c: normalized char, n: nodeIndex, o: original offset }
    var raw = '';        // normalized text

    function pushChar(ch, nodeIndex, offset) {
      chars.push({ c: ch, n: nodeIndex, o: offset });
      raw += ch;
    }

    function pushSeparator() {
      if (raw.length === 0) return;
      if (SPACE_CHARS.test(raw.charAt(raw.length - 1))) return;
      chars.push({ c: ' ', n: -1, o: -1 });
      raw += ' ';
    }

    function walk(node, isRoot) {
      if (node.nodeType === 3) {
        var nodeIndex = nodes.length;
        nodes.push(node);
        var text = node.nodeValue || '';
        for (var i = 0; i < text.length; i++) {
          var ch = text.charAt(i);
          if (INVISIBLE_CHARS.test(ch)) continue;
          if (SPACE_CHARS.test(ch)) {
            pushSeparator();
            continue;
          }
          pushChar(ch, nodeIndex, i);
        }
        return;
      }
      if (node.nodeType !== 1) return;
      if (!isRoot && (shouldSkipElement(node) || isOwnNode(node))) return;
      var block = BLOCK_TAGS[node.tagName] ? 1 : 0;
      if (block && !isRoot) pushSeparator();
      for (var child = node.firstChild; child; child = child.nextSibling) {
        walk(child, false);
      }
      if (block && !isRoot) pushSeparator();
    }

    walk(root || document.body, true);
    return { raw: raw, chars: chars, nodes: nodes };
  }

  function normalizeNeedle(needle) {
    return String(needle == null ? '' : needle)
      .replace(/[\u00ad\u200b\u200c\u200d\u2060\ufeff]/g, '')
      .replace(/\s+/g, ' ')
      .replace(/^ +| +$/g, '');
  }

  function foldCase(str, caseSensitive) {
    return caseSensitive ? str : str.toLowerCase();
  }

  /** Locate [start, end) offsets of the needle inside a text map. */
  function findMatches(map, needle, options) {
    var opts = options || {};
    var caseSensitive = !!opts.caseSensitive;
    var wholeWord = !!opts.wholeWord;
    var limit = opts.limit || 4000;
    var query = normalizeNeedle(needle);
    if (!query) return [];
    var haystack = foldCase(map.raw, caseSensitive);
    var target = foldCase(query, caseSensitive);
    var out = [];
    var from = 0;
    while (out.length < limit) {
      var at = haystack.indexOf(target, from);
      if (at < 0) break;
      var end = at + target.length;
      if (wholeWord && !isWordBoundary(map.raw, at, end)) {
        from = at + 1;
        continue;
      }
      out.push({ start: at, end: end });
      from = end > at ? end : at + 1;
    }
    return out;
  }

  function isWordChar(ch) {
    if (!ch) return false;
    return /[0-9A-Za-z_\u00c0-\u024f\u0370-\u03ff\u0400-\u04ff]/.test(ch);
  }

  function isWordBoundary(raw, start, end) {
    var before = start > 0 ? raw.charAt(start - 1) : '';
    var after = end < raw.length ? raw.charAt(end) : '';
    return !(isWordChar(before) && isWordChar(raw.charAt(start))) &&
      !(isWordChar(after) && isWordChar(raw.charAt(end - 1)));
  }

  /** Split a needle into the tokens to mark when "sentence" scope is used. */
  function tokenize(needle, stopwords) {
    var text = normalizeNeedle(needle);
    if (!text) return [];
    var stop = stopwords || {};
    var parts = text.split(/[^\p{L}\p{N}'’-]+/u);
    var seen = {};
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var token = parts[i].replace(/^['’-]+|['’-]+$/g, '');
      if (token.length < 2 && !/[\u4e00-\u9fff]/.test(token)) continue;
      if (token.length < 1) continue;
      var key = token.toLowerCase();
      if (stop[key]) continue;
      if (seen[key]) continue;
      seen[key] = 1;
      out.push(token);
    }
    return out;
  }

  var EN_STOPWORDS = ('a an the and or but if then than that this these those of in on at to for from by with without ' +
    'is are was were be been being am do does did doing have has had having it its as so such not no nor ' +
    'we you they he she i me my your our their his her them us him into over under again more most some any ' +
    'can could will would shall should may might must about after before between during while because').split(' ');

  function stopwordTable() {
    var table = {};
    for (var i = 0; i < EN_STOPWORDS.length; i++) table[EN_STOPWORDS[i]] = 1;
    return table;
  }

  /** Map [start, end) character offsets back to text node slices. */
  function sliceForRange(map, start, end) {
    var slices = [];
    var current = null;
    for (var i = start; i < end; i++) {
      var info = map.chars[i];
      if (!info) continue;
      if (info.n < 0) {
        // Collapsed or removed whitespace sits between the real characters, so
        // it terminates the current slice instead of being swallowed by it.
        current = null;
        continue;
      }
      if (current && current.nodeIndex === info.n && info.o === current.end) {
        current.end = info.o + 1;
        continue;
      }
      current = { nodeIndex: info.n, start: info.o, end: info.o + 1 };
      if (start === end - 1) current.single = true;
      slices.push(current);
    }
    return slices;
  }

  /** Merge overlapping/adjacent ranges so one node is edited once. */
  function mergeRanges(ranges) {
    var sorted = ranges.slice().sort(function (a, b) {
      return a.start - b.start || a.end - b.end;
    });
    var out = [];
    for (var i = 0; i < sorted.length; i++) {
      var current = sorted[i];
      var last = out[out.length - 1];
      if (last && current.start <= last.end) {
        if (current.end > last.end) last.end = current.end;
        if (current.annotationId && last.annotationId !== current.annotationId) {
          last.annotationId = current.annotationId;
          last.mixed = true;
        }
        if (current.secondary) last.secondary = true;
        continue;
      }
      out.push({
        start: current.start,
        end: current.end,
        annotationId: current.annotationId,
        sentenceScope: current.sentenceScope,
        secondary: current.secondary
      });
    }
    return out;
  }

  /* ------------------------------------------------------------------ colors */

  var PALETTE = [
    '#fff2a8', '#b7ecc0', '#b9e2ff', '#ffd6cc', '#e2d3ff', '#ffe0b3',
    '#c8f2ef', '#f6d4ec', '#d9e8a8', '#cfe0ff', '#ffd9e0', '#d8f0c9'
  ];

  function hashString(str) {
    var hash = 2166136261;
    for (var i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = (hash * 16777619) >>> 0;
    }
    return hash >>> 0;
  }

  function pickColor(key) {
    return PALETTE[hashString(key) % PALETTE.length];
  }

  function hexToRgb(hex) {
    var value = String(hex || '').replace('#', '');
    if (value.length === 3) {
      value = value.charAt(0) + value.charAt(0) + value.charAt(1) + value.charAt(1) + value.charAt(2) + value.charAt(2);
    }
    if (value.length !== 6) return null;
    var num = parseInt(value, 16);
    if (!isFinite(num)) return null;
    return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
  }

  /** WCAG relative luminance, 0 (black) .. 1 (white). */
  function relativeLuminance(hex) {
    var rgb = hexToRgb(hex);
    if (!rgb) return 1;
    var channels = [rgb.r, rgb.g, rgb.b].map(function (channel) {
      var value = channel / 255;
      return value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  }

  /**
   * Readable ink for a highlight: dark text on light backgrounds and light text
   * on dark ones, so the page text stays legible under every highlight colour.
   */
  function contrastTextColor(background) {
    return relativeLuminance(background) > 0.45 ? '#12161d' : '#fbfcff';
  }

  /** Contrast ratio between two hex colours (1..21); used by the tests. */
  function contrastRatio(colorA, colorB) {
    var a = relativeLuminance(colorA);
    var b = relativeLuminance(colorB);
    var light = Math.max(a, b);
    var dark = Math.min(a, b);
    return (light + 0.05) / (dark + 0.05);
  }

  /* ------------------------------------------------------------------ marking */

  function createMarkElement(annotationId, color, secondary) {
    var mark = document.createElement('pagegloss-mark');
    var background = color || '#fff2a8';
    var ink = contrastTextColor(background);
    mark.setAttribute('data-pg-id', annotationId);
    mark.setAttribute('data-pg-color', background);
    mark.setAttribute('data-pg-ink', ink);
    if (secondary) mark.setAttribute('data-pg-secondary', '1');
    // A <mark> element carries default light-yellow UA styles that would fight
    // the injected stylesheet, and custom elements are inline by default: pin
    // both the layout and the colours here so no page style can break them.
    mark.setAttribute('style', 'display:inline;background-color:' + background + ';color:' + ink + ';');
    if (mark.style.setProperty) {
      mark.style.setProperty('--pg-mark-color', background);
      mark.style.setProperty('--pg-mark-ink', ink);
    }
    return mark;
  }

  function resolveNode(map, nodeIndex) {
    var node = map.nodes[nodeIndex];
    if (!node) return null;
    if (!node.parentNode) {
      node = null;
      return null;
    }
    return node;
  }

  /**
   * Apply merged ranges. Every node is edited from the highest offset down so
   * earlier offsets stay valid.
   */
  function applyRanges(map, rangeList) {
    var byNode = new Map();
    for (var i = 0; i < rangeList.length; i++) {
      var range = rangeList[i];
      if (!range.annotationId) continue;
      var slices = sliceForRange(map, range.start, range.end);
      for (var s = 0; s < slices.length; s++) {
        var slice = slices[s];
        var node = resolveNode(map, slice.nodeIndex);
        if (!node) continue;
        var bucket = byNode.get(node);
        if (!bucket) {
          bucket = [];
          byNode.set(node, bucket);
        }
        bucket.push({
          start: slice.start,
          end: slice.end,
          rangeStart: range.start,
          rangeEnd: range.end,
          annotationId: range.annotationId,
          color: range.color || pickColor(range.colorKey || String(range.annotationId)),
          secondary: !!range.secondary
        });
      }
    }

    var created = 0;
    byNode.forEach(function (bucket, node) {
      bucket.sort(function (a, b) { return b.start - a.start || b.end - a.end; });
      for (var i = 0; i < bucket.length; i++) {
        var item = bucket[i];
        if (applyToNode(map, node, item)) created++;
      }
    });
    return created;
  }

  function applyToNode(map, node, item) {
    // Cut a single contiguous chunk: the logical match is extended to the
    // surrounding word boundaries so a hit spanning several text nodes (or a
    // word wrapped across inline tags) lands in exactly one executable range.
    var span = wordSpanForRange(map, item.rangeStart, item.rangeEnd);
    if (span.nodeIndex !== map.nodes.indexOf(node)) return false;
    var text = node.nodeValue || '';
    var start = Math.max(0, Math.min(span.start, text.length));
    var end = Math.max(start, Math.min(span.end, text.length));
    if (end <= start) return false;
    if (node.parentNode && node.parentNode.nodeName === 'PAGEGLOSS-MARK') {
      // Already wrapped by a previous pass: nothing to do.
      return false;
    }

    var original = document.createRange();
    original.setStart(node, start);
    original.setEnd(node, end);

    var mark = createMarkElement(item.annotationId, item.color, item.secondary);
    var middle = original.extractContents();
    if (!middle.textContent) return false;
    var payload = trimWhitespaceEdges(middle);
    if (!payload) return false;
    mark.appendChild(payload);
    try {
      original.insertNode(mark);
    } catch (err) {
      // Restore the extracted content so no text is lost.
      var parent = node.parentNode;
      if (parent) parent.insertBefore(middle, node.nextSibling);
      return false;
    }
    return true;
  }

  function trimWhitespaceEdges(fragment) {
    var nodes = [];
    var current = fragment.firstChild;
    while (current) {
      nodes.push(current);
      current = current.nextSibling;
    }
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      if (node.nodeType !== 3) break;
      node.nodeValue = node.nodeValue.replace(/^\s+/, '');
      if (node.nodeValue) break;
      fragment.removeChild(node);
    }
    for (var j = nodes.length - 1; j >= 0; j--) {
      var tail = nodes[j];
      if (!tail.parentNode) continue;
      if (tail.nodeType !== 3) break;
      tail.nodeValue = tail.nodeValue.replace(/\s+$/, '');
      if (tail.nodeValue) break;
      fragment.removeChild(tail);
    }
    return fragment.textContent ? fragment : null;
  }

  /**
   * Expand a logical match to whole words and report the single text node that
   * can hold it. Returns { nodeIndex, start, end } in original offsets.
   */
  function wordSpanForRange(map, start, end) {
    var chars = map.chars;
    var firstReal = -1;
    var lastReal = -1;
    for (var i = start; i < end; i++) {
      if (chars[i] && chars[i].n >= 0) {
        if (firstReal < 0) firstReal = i;
        lastReal = i;
      }
    }
    if (firstReal < 0) return { nodeIndex: -1, start: 0, end: 0 };
    var first = chars[firstReal];
    var last = chars[lastReal];
    // Only Latin/digit word characters are extended to a whole word. CJK has no
    // spaces, so extending there swallowed the entire sentence around a match.
    var from = firstReal;
    while (from > 0) {
      var prev = chars[from - 1];
      if (!prev || prev.n < 0 || !isWordChar(prev.c)) break;
      from--;
    }
    var to = lastReal;
    while (to < chars.length - 1) {
      var next = chars[to + 1];
      if (!next || next.n < 0 || !isWordChar(next.c)) break;
      to++;
    }
    if (!isWordChar(first.c)) {
      from = firstReal;
      to = lastReal;
    }
    var firstChar = chars[from];
    var lastChar = chars[to];
    if (!firstChar || !lastChar || firstChar.n !== lastChar.n) {
      // The word really does span several nodes; fall back to the raw match so
      // every node still receives a mark fragment.
      var fallbackFirst = chars[firstReal];
      return { nodeIndex: fallbackFirst.n, start: fallbackFirst.o, end: chars[lastReal].o + 1, partial: true };
    }
    return { nodeIndex: firstChar.n, start: firstChar.o, end: lastChar.o + 1 };
  }

  function unwrapMark(mark) {
    if (!mark || !mark.parentNode) return;
    var parent = mark.parentNode;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
    parent.normalize();
  }

  function unwrapAnnotations(ids) {
    var set = ids && ids.length ? new Set(ids) : null;
    var marks = document.querySelectorAll('pagegloss-mark[data-pg-id]');
    var removed = 0;
    for (var i = marks.length - 1; i >= 0; i--) {
      var mark = marks[i];
      if (set && !set.has(mark.getAttribute('data-pg-id'))) continue;
      unwrapMark(mark);
      removed++;
    }
    return removed;
  }
  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(value);
    return String(value).replace(/["\\]/g, '\\$&');
  }

  function countMarks(annotationId) {
    return document.querySelectorAll('pagegloss-mark[data-pg-id="' + cssEscape(annotationId) + '"]').length;
  }

  /* ------------------------------------------------------- context extraction */

  function textOf(element) {
    if (!element) return '';
    var value = element.innerText || element.textContent || '';
    return value.replace(/\s+/g, ' ').replace(/^ +| +$/g, '');
  }

  function closestBlock(node) {
    var el = node && node.nodeType === 1 ? node : node && node.parentElement;
    var current = el;
    while (current && current !== document.body) {
      if (BLOCK_TAGS[current.tagName] && current.tagName !== 'BODY') return current;
      current = current.parentElement;
    }
    return el || document.body;
  }

  function sentenceAround(element, needle) {
    var block = closestBlock(element);
    var text = textOf(block);
    if (!text) return '';
    var query = normalizeNeedle(needle);
    var haystack = text.toLowerCase();
    var target = query.toLowerCase();
    var at = target ? haystack.indexOf(target) : -1;
    if (at < 0) {
      return text.length > 400 ? text.slice(0, 400) + '…' : text;
    }
    var left = at;
    while (left > 0 && !/[.!?。！？；;\n]/.test(text.charAt(left - 1))) left--;
    var right = at + query.length;
    while (right < text.length && !/[.!?。！？；;\n]/.test(text.charAt(right))) right++;
    if (right < text.length) right++;
    var sentence = text.slice(left, right).replace(/^ +| +$/g, '');
    if (sentence.length > 700) sentence = sentence.slice(0, 700) + '…';
    return sentence;
  }

  function pageText(limit) {
    var root = document.querySelector('main, article, [role="main"]') || document.body;
    var text = textOf(root);
    if (limit && text.length > limit) text = text.slice(0, limit) + '…';
    return text;
  }

  /* --------------------------------------------------------- anchor persistence */

  function pathOf(element) {
    var parts = [];
    var current = element;
    var guard = 0;
    while (current && current !== document.body && guard < 16) {
      guard++;
      var parent = current.parentElement;
      if (!parent) break;
      var index = 0;
      var sibling = current;
      while (sibling.previousElementSibling) {
        sibling = sibling.previousElementSibling;
        index++;
      }
      parts.unshift(current.tagName.toLowerCase() + ':' + index);
      current = parent;
    }
    return parts.join('/');
  }

  function elementByPath(path) {
    if (!path) return null;
    var parts = String(path).split('/');
    var current = document.body;
    for (var i = 0; i < parts.length; i++) {
      var piece = parts[i].split(':');
      var tag = piece[0];
      var index = Number(piece[1]) || 0;
      if (!current || !current.children) return null;
      var children = current.children;
      if (!children[index]) return null;
      var candidate = children[index];
      if (candidate.tagName.toLowerCase() !== tag) {
        candidate = null;
        for (var c = 0; c < children.length; c++) {
          if (children[c].tagName.toLowerCase() === tag) {
            candidate = children[c];
            break;
          }
        }
        if (!candidate) return null;
      }
      current = candidate;
    }
    return current;
  }

  function isUiNode(node) {
    return !!(node && node.parentElement && node.parentElement.closest && node.parentElement.closest('pagegloss-mark, pagegloss-ui'));
  }

  function offsetIn(container, target, offset) {
    var total = 0;
    var found = null;
    (function walk(node) {
      if (found !== null) return true;
      if (node === target) {
        found = total + offset;
        return true;
      }
      if (node.nodeType === 3) {
        total += (node.nodeValue || '').length;
        return false;
      }
      if (node.nodeType !== 1) return false;
      if (node !== container && (shouldSkipElement(node) || isUiNode(node))) return false;
      for (var child = node.firstChild; child; child = child.nextSibling) {
        if (walk(child)) return true;
      }
      return false;
    })(container);
    return found;
  }

  /** Store the location of a matched range so a reload can find it again. */
  function anchorForRange(map, range) {
    var slices = sliceForRange(map, range.start, range.end);
    if (!slices.length) return null;
    var first = slices[0];
    var last = slices[slices.length - 1];
    var node = map.nodes[first.nodeIndex];
    if (!node || !node.parentElement) return null;
    var block = closestBlock(node.parentElement);
    if (!block || block === document.body) return null;
    var start = offsetIn(block, node, first.start);
    if (start == null) return null;
    var length = 0;
    for (var i = 0; i < slices.length; i++) length += slices[i].end - slices[i].start;
    return {
      path: pathOf(block),
      start: start,
      end: start + length,
      text: map.raw.slice(range.start, range.end)
    };
  }

  /**
   * Re-locate stored anchors on the current document. Returns DOM ranges that
   * survived the reload; unlocatable anchors are skipped silently.
   */
  function rangesFromAnchors(annotation) {
    var anchors = Array.isArray(annotation && annotation.anchors) ? annotation.anchors : [];
    var out = [];
    for (var i = 0; i < anchors.length; i++) {
      var anchor = anchors[i];
      if (!anchor || anchor.removed || anchor.start == null || anchor.end == null) continue;
      var container = elementByPath(anchor.path);
      if (!container) continue;
      var total = 0;
      var startInfo = null;
      var endInfo = null;
      (function walk(node) {
        if (startInfo && endInfo) return true;
        if (node.nodeType === 3) {
          var length = (node.nodeValue || '').length;
          if (!startInfo && anchor.start >= total && anchor.start < total + length) {
            startInfo = { node: node, offset: anchor.start - total };
          }
          if (!endInfo && anchor.end > total && anchor.end <= total + length) {
            endInfo = { node: node, offset: anchor.end - total };
          }
          total += length;
          return false;
        }
        if (node.nodeType !== 1) return false;
        if (node !== container && (shouldSkipElement(node) || isUiNode(node))) return false;
        for (var child = node.firstChild; child; child = child.nextSibling) {
          if (walk(child)) return true;
        }
        return false;
      })(container);
      if (!startInfo || !endInfo) continue;
      try {
        var range = document.createRange();
        range.setStart(startInfo.node, startInfo.offset);
        range.setEnd(endInfo.node, endInfo.offset);
        out.push(range);
      } catch (err) {
        // Skip anchors that no longer line up with the document.
      }
    }
    return out;
  }

  /** Convert DOM ranges (e.g. restored anchors) into logical offsets. */
  function offsetsForRanges(map, rangeList, meta) {
    var out = [];
    for (var i = 0; i < rangeList.length; i++) {
      var range = rangeList[i];
      var start = offsetOfPoint(map, range.startContainer, range.startOffset);
      var end = offsetOfPoint(map, range.endContainer, range.endOffset);
      if (start == null || end == null || end <= start) continue;
      out.push({
        start: start,
        end: end,
        annotationId: meta.annotationId,
        color: meta.color,
        secondary: !!meta.secondary
      });
    }
    return mergeRanges(out);
  }

  function offsetOfPoint(map, node, offset) {
    if (node.nodeType === 3) {
      var nodeIndex = map.nodes.indexOf(node);
      if (nodeIndex < 0) return null;
      for (var i = 0; i < map.chars.length; i++) {
        var info = map.chars[i];
        if (info.n === nodeIndex && info.o >= offset) return i;
      }
      return null;
    }
    var scope = node;
    var found = -1;
    for (var j = 0; j < map.chars.length; j++) {
      var charInfo = map.chars[j];
      if (charInfo.n < 0) continue;
      var textNode = map.nodes[charInfo.n];
      if (textNode && scope.contains && scope.contains(textNode)) {
        found = j;
        break;
      }
    }
    return found < 0 ? null : found;
  }

  var api = {
    buildTextMap: buildTextMap,
    normalizeNeedle: normalizeNeedle,
    findMatches: findMatches,
    sliceForRange: sliceForRange,
    mergeRanges: mergeRanges,
    applyRanges: applyRanges,
    unwrapMark: unwrapMark,
    unwrapAnnotations: unwrapAnnotations,
    countMarks: countMarks,
    pickColor: pickColor,
    contrastTextColor: contrastTextColor,
    contrastRatio: contrastRatio,
    tokenize: tokenize,
    stopwordTable: stopwordTable,
    sentenceAround: sentenceAround,
    pageText: pageText,
    closestBlock: closestBlock,
    cssEscape: cssEscape,
    pathOf: pathOf,
    elementByPath: elementByPath,
    offsetIn: offsetIn,
    anchorForRange: anchorForRange,
    rangesFromAnchors: rangesFromAnchors,
    offsetsForRanges: offsetsForRanges
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.PageGlossMatcher = api;
})();
