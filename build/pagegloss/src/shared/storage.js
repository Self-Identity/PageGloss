/*
 * PageGloss - storage helpers (chrome.storage.local).
 *
 * CLASSIC SCRIPT ONLY (no import/export statements on purpose), loaded by the
 * manifest content scripts and by the popup/options HTML pages. All of them read
 * `globalThis.PageGlossStore`; ES module consumers import `shared.mjs` instead.
 *
 * The shared constants come from messages.js, which is always loaded first. When
 * this file is loaded as a module (through a bundler-style wrapper) it falls back
 * to the PageGlossShared global that messages.js publishes.
 *
 * Layout:
 *   pg:settings          -> user settings (single object)
 *   pg:index             -> { [urlKey]: { url, title, updatedAt, annotations, marks } }
 *   pg:page:<urlKey>     -> { url, title, updatedAt, annotations: [...], chats: {...} }
 */

(function () {
  'use strict';

  var shared = globalThis.PageGlossShared;
  if (!shared) {
    throw new Error('storage.js: messages.js must be loaded first');
  }

  var SETTINGS = shared.SETTINGS_KEY;
  var PAGE_PREFIX = shared.STORAGE_PREFIX;
  var INDEX_KEY = shared.STORAGE_INDEX_KEY;
  var CHAT_LIMIT = shared.MAX_CHAT_MESSAGES;
  var MODES = shared.CONTEXT_MODES;
  var DEFAULT_MODE = shared.DEFAULT_CONTEXT_MODE;
  var MATCH_MODES = shared.MATCH_MODES;
  var DEFAULT_MATCH_MODE = shared.DEFAULT_MATCH_MODE;
  var storageKey = shared.storageKey;
  var NOTE_LIMIT = 8000;

  var cachedArea = null;

  function area() {
    if (cachedArea) return cachedArea;
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
      throw new Error('chrome.storage.local is unavailable');
    }
    cachedArea = chrome.storage.local;
    return cachedArea;
  }

  function get(keys) {
    return new Promise(function (resolve, reject) {
      area().get(keys, function (result) {
        var error = typeof chrome !== 'undefined' && chrome.runtime ? chrome.runtime.lastError : null;
        if (error) reject(new Error(error.message));
        else resolve(result || {});
      });
    });
  }

  function set(items) {
    return new Promise(function (resolve, reject) {
      area().set(items, function () {
        var error = typeof chrome !== 'undefined' && chrome.runtime ? chrome.runtime.lastError : null;
        if (error) reject(new Error(error.message));
        else resolve();
      });
    });
  }

  function remove(keys) {
    return new Promise(function (resolve, reject) {
      area().remove(keys, function () {
        var error = typeof chrome !== 'undefined' && chrome.runtime ? chrome.runtime.lastError : null;
        if (error) reject(new Error(error.message));
        else resolve();
      });
    });
  }

  function normalizeSettings(raw) {
    var out = shared.cloneDefaultSettings();
    if (raw && typeof raw === 'object') {
      for (var key in out) {
        if (!Object.prototype.hasOwnProperty.call(raw, key)) continue;
        var value = raw[key];
        if (value === undefined || value === null) continue;
        if (typeof out[key] === 'boolean') out[key] = !!value;
        else if (typeof out[key] === 'number') {
          var num = Number(value);
          if (isFinite(num)) out[key] = num;
        } else out[key] = String(value);
      }
    }
    if (MODES.indexOf(out.contextMode) < 0) out.contextMode = DEFAULT_MODE;
    if (MATCH_MODES.indexOf(out.matchMode) < 0) out.matchMode = DEFAULT_MATCH_MODE;
    out.temperature = Math.max(0, Math.min(2, out.temperature));
    out.maxTokens = Math.max(64, Math.min(32000, Math.round(out.maxTokens)));
    out.maxContextChars = Math.max(500, Math.min(200000, Math.round(out.maxContextChars)));
    out.requestTimeoutMs = Math.max(5000, Math.min(600000, Math.round(out.requestTimeoutMs)));
    if (!out.systemPrompt) out.systemPrompt = '';
    // The shipped default used to be Alt+Q. Move that exact value to the new
    // default once, while leaving a genuinely custom combination untouched.
    if (out.markHotkey === 'Alt+Q') out.markHotkey = 'Alt+W';
    if (!out.markHotkey) out.markHotkey = 'Alt+W';
    return out;
  }

  function getSettings() {
    return get(SETTINGS).then(function (result) {
      return normalizeSettings(result[SETTINGS]);
    });
  }

  function saveSettings(patch) {
    return getSettings().then(function (current) {
      var next = normalizeSettings(Object.assign({}, current, patch || {}));
      return set({ [SETTINGS]: next }).then(function () { return next; });
    });
  }

  function emptyPage(urlKey, url, title) {
    return { urlKey: urlKey, url: url || '', title: title || '', updatedAt: Date.now(), annotations: [], chats: {} };
  }

  function sanitizeThread(thread) {
    var out = [];
    for (var i = 0; i < thread.length; i++) {
      var item = thread[i];
      if (!item || typeof item !== 'object') continue;
      var role = item.role === 'user' ? 'user' : 'assistant';
      var content = typeof item.content === 'string' ? item.content : '';
      if (!content) continue;
      out.push({ role: role, content: content, at: Number(item.at) || Date.now() });
    }
    if (out.length > CHAT_LIMIT) out = out.slice(out.length - CHAT_LIMIT);
    return out;
  }

  function sanitizePage(raw, urlKey) {
    var page = emptyPage(urlKey, raw && raw.url, raw && raw.title);
    if (!raw || typeof raw !== 'object') return page;
    page.updatedAt = Number(raw.updatedAt) || Date.now();
    if (Array.isArray(raw.annotations)) {
      page.annotations = raw.annotations.filter(function (item) {
        return item && typeof item === 'object' && typeof item.id === 'string' && typeof item.text === 'string';
      });
      page.annotations.forEach(function (item) {
        if (typeof item.note !== 'string') item.note = '';
        if (!Number(item.createdAt)) item.createdAt = page.updatedAt;
        if (!Number(item.updatedAt)) item.updatedAt = Number(item.createdAt) || page.updatedAt;
        if (!Number(item.noteUpdatedAt)) item.noteUpdatedAt = 0;
      });
    }
    if (raw.chats && typeof raw.chats === 'object') {
      page.chats = {};
      Object.keys(raw.chats).forEach(function (id) {
        var thread = raw.chats[id];
        if (Array.isArray(thread)) page.chats[id] = sanitizeThread(thread);
      });
    }
    return page;
  }

  function getPage(urlKey) {
    return get(storageKey(urlKey)).then(function (result) {
      return sanitizePage(result[storageKey(urlKey)], urlKey);
    });
  }

  function updateIndex(urlKey, page) {
    return get(INDEX_KEY).then(function (result) {
      var index = result[INDEX_KEY];
      if (!index || typeof index !== 'object') index = {};
      var marks = 0;
      for (var i = 0; i < page.annotations.length; i++) {
        marks += Number(page.annotations[i].marks) || 0;
      }
      index[urlKey] = {
        url: page.url,
        title: page.title,
        updatedAt: page.updatedAt,
        annotations: page.annotations.length,
        marks: marks
      };
      return set({ [INDEX_KEY]: index });
    });
  }

  function savePage(page) {
    page.updatedAt = Date.now();
    return set({ [storageKey(page.urlKey)]: page }).then(function () {
      return updateIndex(page.urlKey, page);
    }).then(function () {
      return page;
    });
  }

  function addAnnotation(urlKey, annotation) {
    return getPage(urlKey).then(function (page) {
      var existing = page.annotations.findIndex(function (item) { return item.id === annotation.id; });
      if (existing >= 0) page.annotations[existing] = annotation;
      else page.annotations.push(annotation);
      return savePage(page);
    });
  }

  /**
   * Pure mutation helpers so callers can batch several changes into one write.
   */
  function upsertAnnotation(page, annotation) {
    var index = page.annotations.findIndex(function (item) { return item.id === annotation.id; });
    if (index >= 0) page.annotations[index] = annotation;
    else page.annotations.push(annotation);
    return page;
  }

  function removeAnnotationFromPage(page, annotationId) {
    page.annotations = page.annotations.filter(function (item) { return item.id !== annotationId; });
    delete page.chats[annotationId];
    return page;
  }

  function anchorKey(anchor) {
    if (!anchor) return '';
    return String(anchor.path || '') + '|' + String(anchor.start == null ? '' : anchor.start) + '|' + String(anchor.end == null ? '' : anchor.end);
  }

  function liveAnchors(annotation) {
    var anchors = Array.isArray(annotation && annotation.anchors) ? annotation.anchors : [];
    return anchors.filter(function (item) { return item && !item.removed; });
  }

  /**
   * Removing a single occurrence keeps the anchor as a tombstone. The offsets of
   * the remaining anchors stay valid because the original markup is untouched,
   * and restore / re-anchor passes skip the tombstones.
   */
  function removeOccurrence(page, annotationId, anchor) {
    var target = page.annotations.find(function (item) { return item.id === annotationId; });
    if (!target) return null;
    var anchors = Array.isArray(target.anchors) ? target.anchors : [];
    var live = anchors.filter(function (item) { return !item.removed; });
    if (live.length <= 1) {
      removeAnnotationFromPage(page, annotationId);
      return { removedAll: true, remaining: 0 };
    }
    var key = anchorKey(anchor);
    var index = -1;
    for (var i = 0; i < anchors.length; i++) {
      if (!anchors[i].removed && anchorKey(anchors[i]) === key) {
        index = i;
        break;
      }
    }
    if (index < 0) {
      for (var j = 0; j < anchors.length; j++) {
        if (!anchors[j].removed) {
          index = j;
          break;
        }
      }
    }
    if (index >= 0) anchors[index].removed = true;
    target.anchors = anchors;
    target.marks = anchors.filter(function (item) { return !item.removed; }).length;
    return { removedAll: false, remaining: target.marks };
  }

  function getThread(page, annotationId) {
    var thread = page.chats && page.chats[annotationId];
    return Array.isArray(thread) ? thread : [];
  }

  function setThread(page, annotationId, thread) {
    if (!page.chats) page.chats = {};
    var clean = sanitizeThread(thread || []);
    if (clean.length) page.chats[annotationId] = clean;
    else delete page.chats[annotationId];
    return page;
  }

  function appendThreadMessage(page, annotationId, message) {
    var thread = getThread(page, annotationId).slice();
    thread.push({ role: message.role === 'user' ? 'user' : 'assistant', content: String(message.content || ''), at: Date.now() });
    return setThread(page, annotationId, thread);
  }

  function pageSize(page) {
    try {
      return JSON.stringify(page).length;
    } catch (err) {
      return 0;
    }
  }

  function pruneIfTooLarge(page) {
    var guard = 0;
    while (pageSize(page) > 512 * 1024 && guard < 200) {
      guard++;
      var ids = Object.keys(page.chats || {});
      if (!ids.length) break;
      var oldest = null;
      var oldestAt = Infinity;
      ids.forEach(function (id) {
        var thread = page.chats[id];
        var at = thread.length ? thread[thread.length - 1].at || 0 : 0;
        if (at < oldestAt) {
          oldestAt = at;
          oldest = id;
        }
      });
      if (!oldest) break;
      var thread = page.chats[oldest];
      if (thread.length > 4) {
        page.chats[oldest] = thread.slice(thread.length - 4);
      } else {
        delete page.chats[oldest];
      }
    }
    return Promise.resolve(page);
  }

  function clearPage(urlKey) {
    return remove(storageKey(urlKey)).then(function () {
      return get(INDEX_KEY);
    }).then(function (result) {
      var index = result[INDEX_KEY];
      if (index && typeof index === 'object' && index[urlKey]) {
        delete index[urlKey];
        return set({ [INDEX_KEY]: index });
      }
      return undefined;
    });
  }

  function clearAll() {
    return get(null).then(function (result) {
      var keys = Object.keys(result).filter(function (key) {
        return key.indexOf(PAGE_PREFIX) === 0 || key === INDEX_KEY;
      });
      if (!keys.length) return 0;
      return remove(keys).then(function () { return keys.length; });
    });
  }

  function exportAll() {
    return get(null).then(function (result) {
      var pages = {};
      Object.keys(result).forEach(function (key) {
        if (key.indexOf(PAGE_PREFIX) === 0) pages[key.slice(PAGE_PREFIX.length)] = result[key];
      });
      return {
        format: 'pagegloss-backup',
        version: 1,
        exportedAt: new Date().toISOString(),
        settings: normalizeSettings(result[SETTINGS]),
        pages: pages
      };
    });
  }

  function importAll(payload, options) {
    if (!payload || payload.format !== 'pagegloss-backup' || !payload.pages || typeof payload.pages !== 'object') {
      return Promise.reject(new Error('bad-format'));
    }
    var items = {};
    var count = 0;
    Object.keys(payload.pages).forEach(function (urlKey) {
      items[storageKey(urlKey)] = sanitizePage(payload.pages[urlKey], urlKey);
      count++;
    });
    if (options && options.includeSettings && payload.settings) {
      items[SETTINGS] = normalizeSettings(payload.settings);
    }
    if (!count) return Promise.resolve(0);
    return set(items).then(function () {
      return get(INDEX_KEY);
    }).then(function (result) {
      var index = result[INDEX_KEY];
      if (!index || typeof index !== 'object') index = {};
      Object.keys(payload.pages).forEach(function (urlKey) {
        var page = items[storageKey(urlKey)];
        var marks = 0;
        page.annotations.forEach(function (item) { marks += Number(item.marks) || 0; });
        index[urlKey] = {
          url: page.url,
          title: page.title,
          updatedAt: page.updatedAt,
          annotations: page.annotations.length,
          marks: marks
        };
      });
      return set({ [INDEX_KEY]: index }).then(function () { return count; });
    });
  }

  /** Every cached page with its annotations, newest first (used by the data page). */
  function getAllPages() {
    return get(null).then(function (result) {
      var pages = [];
      Object.keys(result).forEach(function (key) {
        if (key.indexOf(PAGE_PREFIX) !== 0) return;
        pages.push(sanitizePage(result[key], key.slice(PAGE_PREFIX.length)));
      });
      pages.sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
      return pages;
    });
  }

  /** Store the free form note for one annotation and bump its timestamps. */
  function setNote(page, annotationId, text) {
    var target = page.annotations.find(function (item) { return item.id === annotationId; });
    if (!target) return null;
    var now = Date.now();
    target.note = String(text == null ? '' : text).slice(0, NOTE_LIMIT);
    target.noteUpdatedAt = now;
    target.updatedAt = now;
    return target;
  }

  /** Mark success counts as an update of the annotation. */
  function touchAnnotation(page, annotationId) {
    var target = page.annotations.find(function (item) { return item.id === annotationId; });
    if (!target) return null;
    target.updatedAt = Date.now();
    return target;
  }

  function getIndexSummary() {
    return get(INDEX_KEY).then(function (result) {
      var index = result[INDEX_KEY];
      if (!index || typeof index !== 'object') return { pages: 0, annotations: 0, marks: 0, list: [] };
      var list = Object.keys(index).map(function (urlKey) {
        var item = index[urlKey] || {};
        return {
          urlKey: urlKey,
          url: item.url || '',
          title: item.title || '',
          updatedAt: item.updatedAt || 0,
          annotations: item.annotations || 0,
          marks: item.marks || 0
        };
      }).sort(function (a, b) { return b.updatedAt - a.updatedAt; });
      var annotations = 0;
      var marks = 0;
      list.forEach(function (item) {
        annotations += item.annotations;
        marks += item.marks;
      });
      return { pages: list.length, annotations: annotations, marks: marks, list: list };
    });
  }

  globalThis.PageGlossStore = {
    get: get,
    set: set,
    remove: remove,
    normalizeSettings: normalizeSettings,
    getSettings: getSettings,
    saveSettings: saveSettings,
    getPage: getPage,
    savePage: savePage,
    addAnnotation: addAnnotation,
    upsertAnnotation: upsertAnnotation,
    removeAnnotationFromPage: removeAnnotationFromPage,
    removeOccurrence: removeOccurrence,
    liveAnchors: liveAnchors,
    anchorKey: anchorKey,
    getThread: getThread,
    setThread: setThread,
    appendThreadMessage: appendThreadMessage,
    setNote: setNote,
    touchAnnotation: touchAnnotation,
    getAllPages: getAllPages,
    pruneIfTooLarge: pruneIfTooLarge,
    clearPage: clearPage,
    clearAll: clearAll,
    exportAll: exportAll,
    importAll: importAll,
    getIndexSummary: getIndexSummary,
    sanitizePage: sanitizePage,
    sanitizeThread: sanitizeThread
  };
})();
