/*
 * PageGloss - annotation data page.
 *
 * Read-only browser for everything in chrome.storage.local: annotations are
 * grouped by site, pages inside a group are paginated ten at a time, and the
 * marks of an expanded page are shown as a 5 x 10 matrix (fifty per page).
 * Hovering a mark opens a floating explanation / note panel; clicking it tries
 * to focus that annotation on the original page.
 *
 * Classic script on purpose: messages.js, i18n.js and storage.js are loaded by
 * data.html before this file, so there is no import/export here.
 */
(function () {
  'use strict';

  var Store = window.PageGlossStore;
  var S = window.PageGlossShared;
  var I = window.PageGlossI18n.create();

  var PAGE_ROWS = 10;
  var GRID_COLUMNS = 5;
  var GRID_ROWS = 10;
  var GRID_PAGE_SIZE = GRID_COLUMNS * GRID_ROWS; // 50 marks per page
  var HOVER_CLOSE_DELAY = 180;
  var SVG_NS = 'http://www.w3.org/2000/svg';

  var ICON_PATHS = {
    chevron: ['M8 10l4 4 4-4'],
    external: ['M14 4h6v6', 'M20 4l-9 9', 'M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5']
  };

  var state = {
    pages: [],
    groups: [],
    siteClosed: Object.create(null),
    pageClosed: Object.create(null),
    pageIndex: Object.create(null),
    matrixIndex: Object.create(null),
    loading: false,
    loadToken: 0,
    overlay: null
  };

  var dom = {
    title: null,
    stats: null,
    expandAll: null,
    expandAllText: null,
    collapseAll: null,
    collapseAllText: null,
    refresh: null,
    content: null,
    status: null,
    sites: null
  };

  /* ------------------------------------------------------------------ helpers */

  function t(key, values) {
    return I.t(key, values);
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = String(text);
    return node;
  }

  function button(className, text) {
    var node = el('button', className, text);
    node.type = 'button';
    return node;
  }

  /** Inline SVG icon: currentColor stroke, decorative by default. */
  function icon(name, className) {
    var paths = ICON_PATHS[name] || [];
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.8');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    if (className) svg.setAttribute('class', className);
    paths.forEach(function (d) {
      var path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', d);
      svg.appendChild(path);
    });
    return svg;
  }

  function siteKeyOf(page) {
    var url = page && page.url ? String(page.url) : '';
    var key = url ? S.siteGroupOf(url) : '';
    if (!key && page && page.urlKey) key = String(page.urlKey);
    return key || 'unknown';
  }

  function pageKeyOf(page) {
    if (!page) return '';
    return String(page.urlKey || page.url || '');
  }

  /** "https://example.com" -> "example.com"; the www prefix is already gone. */
  function siteLabel(key) {
    var label = String(key || '').replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/+$/, '');
    return label || String(key || '');
  }

  function localTime(value) {
    var ms = Number(value) || 0;
    if (!ms) return '—';
    var date = new Date(ms);
    if (isNaN(date.getTime())) return '—';
    try {
      return date.toLocaleString(I.lang === 'zh' ? 'zh-CN' : 'en-US', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      });
    } catch (err) {
      return date.toLocaleString();
    }
  }

  function updatedLine(value) {
    return t('fpUpdatedAt', { s: localTime(value) });
  }

  function pagerIndex(map, key, count) {
    var index = Math.floor(Number(map[key]));
    if (!isFinite(index) || index < 0) index = 0;
    if (index > count - 1) index = count - 1;
    map[key] = index;
    return index;
  }

  /* --------------------------------------------------------------- data model */

  function groupPages(pages) {
    var byKey = Object.create(null);
    var groups = [];
    pages.forEach(function (page) {
      if (!page || typeof page !== 'object') return;
      var key = siteKeyOf(page);
      var group = byKey[key];
      if (!group) {
        group = { key: key, pages: [], latest: 0, annotations: 0 };
        byKey[key] = group;
        groups.push(group);
      }
      group.pages.push(page);
      group.latest = Math.max(group.latest, Number(page.updatedAt) || 0);
      group.annotations += Array.isArray(page.annotations) ? page.annotations.length : 0;
    });
    groups.forEach(function (group) {
      group.pages.sort(function (a, b) {
        return (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0);
      });
    });
    groups.sort(function (a, b) {
      return b.latest - a.latest;
    });
    return groups;
  }

  /** Drop expand/pagination memory for pages that no longer exist. */
  function pruneState() {
    var siteKeys = Object.create(null);
    var pageKeys = Object.create(null);
    state.groups.forEach(function (group) {
      siteKeys[group.key] = true;
    });
    state.pages.forEach(function (page) {
      pageKeys[pageKeyOf(page)] = true;
    });
    [state.siteClosed, state.pageIndex].forEach(function (map) {
      Object.keys(map).forEach(function (key) {
        if (!siteKeys[key]) delete map[key];
      });
    });
    [state.pageClosed, state.matrixIndex].forEach(function (map) {
      Object.keys(map).forEach(function (key) {
        if (!pageKeys[key]) delete map[key];
      });
    });
  }

  /* ------------------------------------------------------------------ loading */

  function load() {
    var token = ++state.loadToken;
    state.loading = true;
    closeOverlay();
    setRefreshBusy(true);
    Store.getAllPages().then(function (pages) {
      if (token !== state.loadToken) return;
      state.pages = Array.isArray(pages) ? pages : [];
      state.groups = groupPages(state.pages);
      pruneState();
      render();
    }).catch(function (err) {
      if (token !== state.loadToken) return;
      state.pages = [];
      state.groups = [];
      dom.sites.textContent = '';
      renderStats();
      showStatus(t('dataLoadFail', { s: (err && err.message) || t('errUnknown') }), true);
    }).then(function () {
      if (token !== state.loadToken) return;
      state.loading = false;
      setRefreshBusy(false);
    });
  }

  function setRefreshBusy(busy) {
    var on = !!busy;
    dom.refresh.classList.toggle('is-loading', on);
    dom.refresh.disabled = on;
  }

  /* -------------------------------------------------------------- page chrome */

  function applyLabels() {
    document.documentElement.lang = I.lang === 'zh' ? 'zh-CN' : 'en';
    document.title = t('dataPageTitle');
    dom.title.textContent = t('dataPageTitle');
    dom.expandAllText.textContent = t('dataExpandAll');
    dom.collapseAllText.textContent = t('dataCollapseAll');
    // The allowed key set has no dedicated "refresh" label, so the icon-only
    // button reuses the page title as its accessible name.
    dom.refresh.setAttribute('aria-label', t('dataPageTitle'));
    dom.refresh.title = t('dataPageTitle');
  }

  function renderStats() {
    var annotations = 0;
    state.pages.forEach(function (page) {
      if (page && Array.isArray(page.annotations)) annotations += page.annotations.length;
    });
    dom.stats.textContent = t('dataSitesCount', { n: state.groups.length }) +
      ' · ' + t('dataPagesCount', { n: state.pages.length }) +
      ' · ' + t('dataAnnotationsCount', { n: annotations });
  }

  function showStatus(text, isError) {
    dom.status.hidden = false;
    dom.status.textContent = text;
    dom.status.classList.toggle('is-error', !!isError);
  }

  function clearStatus() {
    dom.status.hidden = true;
    dom.status.textContent = '';
    dom.status.classList.remove('is-error');
  }

  /* ------------------------------------------------------------------ render */

  function render() {
    closeOverlay();
    var scrollTop = dom.content.scrollTop;
    dom.sites.textContent = '';
    renderStats();
    if (!state.groups.length) {
      showStatus(t('dataEmpty'), false);
      dom.content.scrollTop = 0;
      return;
    }
    clearStatus();
    state.groups.forEach(function (group) {
      dom.sites.appendChild(renderGroup(group));
    });
    var maxScroll = Math.max(0, dom.content.scrollHeight - dom.content.clientHeight);
    dom.content.scrollTop = Math.max(0, Math.min(scrollTop, maxScroll));
  }

  function renderGroup(group) {
    var open = !state.siteClosed[group.key];
    var section = el('section', 'site');

    var head = button('site-head');
    head.setAttribute('aria-expanded', open ? 'true' : 'false');
    head.appendChild(icon('chevron', 'chev'));
    var name = el('span', 'site-name', siteLabel(group.key));
    name.title = group.key;
    head.appendChild(name);
    var meta = el('span', 'site-meta');
    meta.textContent = t('dataPagesCount', { n: group.pages.length }) +
      ' · ' + t('dataAnnotationsCount', { n: group.annotations });
    head.appendChild(meta);
    head.addEventListener('click', function () {
      state.siteClosed[group.key] = open;
      render();
    });
    section.appendChild(head);

    if (!open) return section;

    var totalPages = Math.max(1, Math.ceil(group.pages.length / PAGE_ROWS));
    var index = pagerIndex(state.pageIndex, group.key, totalPages);
    var start = index * PAGE_ROWS;

    var body = el('div', 'site-body');
    var list = el('div', 'page-list');
    group.pages.slice(start, start + PAGE_ROWS).forEach(function (page) {
      list.appendChild(renderPage(page));
    });
    body.appendChild(list);

    if (totalPages > 1) {
      body.appendChild(pager(index, totalPages, function (next) {
        state.pageIndex[group.key] = next;
        render();
      }));
    }
    section.appendChild(body);
    return section;
  }

  function renderPage(page) {
    var key = pageKeyOf(page);
    var open = !state.pageClosed[key];
    var article = el('article', 'page');
    var row = el('div', 'page-row');

    var toggle = button('page-toggle');
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    toggle.appendChild(icon('chevron', 'chev'));
    var title = el('span', 'page-title', page.title || page.url || key);
    title.title = page.title || '';
    toggle.appendChild(title);
    toggle.appendChild(el('span', 'page-updated', updatedLine(page.updatedAt)));
    toggle.addEventListener('click', function () {
      state.pageClosed[key] = open;
      render();
    });

    var openLink = button('page-open');
    openLink.title = page.url || '';
    openLink.setAttribute('aria-label', (page.url || '') + ' — ' + t('dataOpenHint'));
    openLink.appendChild(el('span', 'page-url', page.url || ''));
    openLink.appendChild(icon('external', 'icon'));
    openLink.addEventListener('click', function () {
      closeOverlay();
      openUrl(String(page.url || ''));
    });

    row.appendChild(toggle);
    row.appendChild(openLink);
    article.appendChild(row);

    if (open) {
      var body = el('div', 'page-body');
      body.appendChild(renderMarks(page));
      article.appendChild(body);
    }
    return article;
  }

  function renderMarks(page) {
    var wrap = el('div', 'marks-wrap');
    var annotations = Array.isArray(page.annotations) ? page.annotations : [];
    if (!annotations.length) {
      wrap.appendChild(el('p', 'marks-empty', t('dataEmpty')));
      return wrap;
    }

    var totalPages = Math.max(1, Math.ceil(annotations.length / GRID_PAGE_SIZE));
    var key = pageKeyOf(page);
    var index = pagerIndex(state.matrixIndex, key, totalPages);
    var start = index * GRID_PAGE_SIZE;

    var grid = el('div', 'marks');
    grid.setAttribute('aria-label', t('dataAnnotationsTitle'));
    annotations.slice(start, start + GRID_PAGE_SIZE).forEach(function (annotation) {
      grid.appendChild(renderCell(page, annotation));
    });
    wrap.appendChild(grid);

    if (totalPages > 1) {
      wrap.appendChild(pager(index, totalPages, function (next) {
        state.matrixIndex[key] = next;
        render();
      }));
    }
    return wrap;
  }

  function renderCell(page, annotation) {
    var cell = button('mark-cell');
    var text = String((annotation && annotation.text) || '');
    cell.appendChild(el('span', 'mark-text', text));
    cell.appendChild(el('span', 'mark-time', updatedLine(annotation.updatedAt || annotation.createdAt)));
    if (text) cell.setAttribute('aria-label', text + ' — ' + t('dataOpenHint'));
    cell.addEventListener('mouseenter', function () {
      showOverlay(page, annotation, cell);
    });
    cell.addEventListener('mouseleave', scheduleOverlayClose);
    cell.addEventListener('focus', function () {
      showOverlay(page, annotation, cell);
    });
    cell.addEventListener('blur', scheduleOverlayClose);
    cell.addEventListener('click', function () {
      closeOverlay();
      openFocus(page, annotation);
    });
    return cell;
  }

  function pager(index, count, onChange) {
    var bar = el('div', 'pager');
    var prev = button('btn pager-btn', t('dataPrev'));
    prev.disabled = index <= 0;
    prev.addEventListener('click', function () {
      if (index > 0) onChange(index - 1);
    });
    var info = el('span', 'pager-info', t('dataPager', { s: (index + 1) + ' / ' + count }));
    var next = button('btn pager-btn', t('dataNext'));
    next.disabled = index >= count - 1;
    next.addEventListener('click', function () {
      if (index < count - 1) onChange(index + 1);
    });
    bar.appendChild(prev);
    bar.appendChild(info);
    bar.appendChild(next);
    return bar;
  }

  /* ------------------------------------------------------------------ actions */

  function expandAll() {
    state.siteClosed = Object.create(null);
    state.pageClosed = Object.create(null);
    render();
  }

  function collapseAll() {
    state.groups.forEach(function (group) {
      state.siteClosed[group.key] = true;
    });
    state.pages.forEach(function (page) {
      state.pageClosed[pageKeyOf(page)] = true;
    });
    render();
  }

  function openUrl(url) {
    if (!url) return;
    try {
      if (typeof chrome !== 'undefined' && chrome.tabs && typeof chrome.tabs.create === 'function') {
        chrome.tabs.create({ url: url });
        return;
      }
    } catch (err) { /* fall through to window.open */ }
    window.open(url, '_blank', 'noopener');
  }

  /** Best-effort deep link understood by the full page reader. */
  function openFocus(page, annotation) {
    var base = page && page.url ? String(page.url) : '';
    if (!base || !annotation || !annotation.id) return;
    openUrl(base + '#pg-focus=' + encodeURIComponent(String(annotation.id)));
  }

  /* ---------------------------------------------------------- hover overlay */

  function explanationText(page, annotation) {
    if (annotation && annotation.explanation) return String(annotation.explanation);
    var thread = page && page.chats && annotation ? page.chats[annotation.id] : null;
    if (Array.isArray(thread)) {
      for (var i = 0; i < thread.length; i++) {
        var message = thread[i];
        if (message && message.role === 'assistant' && typeof message.content === 'string' && message.content.trim()) {
          return message.content;
        }
      }
    }
    return '';
  }

  function overlayPanel(label, text, isNote) {
    var panel = el('section', 'overlay-panel' + (isNote ? ' is-note' : ''));
    panel.appendChild(el('h3', 'overlay-label', label));
    panel.appendChild(el('p', 'overlay-text', text));
    return panel;
  }

  function buildOverlay(page, annotation) {
    var node = el('div', 'overlay');
    node.setAttribute('role', 'tooltip');
    var grid = el('div', 'overlay-grid');
    var explanation = explanationText(page, annotation).trim();
    grid.appendChild(overlayPanel(t('dataAnnotationsTitle'), explanation || '—', false));
    var note = annotation && typeof annotation.note === 'string' ? annotation.note.trim() : '';
    grid.appendChild(overlayPanel(t('dataNoteLabel'), note || t('dataNoNote'), true));
    node.appendChild(grid);

    var foot = el('div', 'overlay-foot');
    foot.appendChild(el('span', 'overlay-hint', t('dataOpenHint')));
    foot.appendChild(el('span', 'overlay-time', updatedLine(annotation.updatedAt || annotation.createdAt)));
    node.appendChild(foot);
    return node;
  }

  /** Keep the card inside the viewport; flip above the cell when there is no room. */
  function placeOverlay(node, cell) {
    var margin = 8;
    var gap = 8;
    var viewportWidth = document.documentElement.clientWidth || window.innerWidth;
    var viewportHeight = window.innerHeight || document.documentElement.clientHeight;
    var rect = cell.getBoundingClientRect();
    var width = node.offsetWidth;
    var height = node.offsetHeight;

    var left = rect.left;
    var top = rect.bottom + gap;
    if (left + width > viewportWidth - margin) left = viewportWidth - margin - width;
    if (left < margin) left = margin;
    if (top + height > viewportHeight - margin) {
      var above = rect.top - gap - height;
      top = above >= margin ? above : Math.max(margin, viewportHeight - margin - height);
    }
    if (top < margin) top = margin;

    node.style.left = Math.round(left) + 'px';
    node.style.top = Math.round(top) + 'px';
  }

  function showOverlay(page, annotation, cell) {
    var current = state.overlay;
    if (current && current.cell === cell) {
      if (current.timer) {
        window.clearTimeout(current.timer);
        current.timer = 0;
      }
      return;
    }
    closeOverlay();

    var node = buildOverlay(page, annotation);
    var record = { node: node, cell: cell, timer: 0 };
    state.overlay = record;

    node.addEventListener('mouseenter', function () {
      if (record.timer) {
        window.clearTimeout(record.timer);
        record.timer = 0;
      }
    });
    node.addEventListener('mouseleave', scheduleOverlayClose);

    document.body.appendChild(node);
    placeOverlay(node, cell);
  }

  function scheduleOverlayClose() {
    var record = state.overlay;
    if (!record) return;
    if (record.timer) window.clearTimeout(record.timer);
    record.timer = window.setTimeout(function () {
      record.timer = 0;
      if (state.overlay === record) closeOverlay();
    }, HOVER_CLOSE_DELAY);
  }

  /** Remove the node entirely: no hidden overlay may linger in the DOM. */
  function closeOverlay() {
    var record = state.overlay;
    if (!record) return;
    state.overlay = null;
    if (record.timer) {
      window.clearTimeout(record.timer);
      record.timer = 0;
    }
    if (record.node && record.node.isConnected) record.node.remove();
  }

  /* --------------------------------------------------------------------- init */

  function wire() {
    dom.expandAll.addEventListener('click', expandAll);
    dom.collapseAll.addEventListener('click', collapseAll);
    dom.refresh.addEventListener('click', function () {
      if (!state.loading) load();
    });
    dom.content.addEventListener('scroll', closeOverlay, { passive: true });
    window.addEventListener('resize', closeOverlay);
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && state.overlay) closeOverlay();
    });
  }

  function init() {
    dom.title = document.getElementById('pageTitle');
    dom.stats = document.getElementById('stats');
    dom.expandAll = document.getElementById('expandAll');
    dom.expandAllText = document.getElementById('expandAllText');
    dom.collapseAll = document.getElementById('collapseAll');
    dom.collapseAllText = document.getElementById('collapseAllText');
    dom.refresh = document.getElementById('refresh');
    dom.content = document.getElementById('content');
    dom.status = document.getElementById('status');
    dom.sites = document.getElementById('sites');
    applyLabels();
    wire();
    load();
  }

  init();
})();
