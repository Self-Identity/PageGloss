/*
 * PageGloss - annotation data page.
 *
 * Browse everything in chrome.storage.local: annotations are grouped by site,
 * pages inside a group are paginated ten at a time, and the marks of an
 * expanded page are shown as a 5 x 10 matrix (fifty per page).
 *
 * The page can also maintain the cache: sites, pages and single marks have
 * checkboxes (selection may mix all three levels), the toolbar deletes or
 * exports the selection, and every site/page row has its own delete and JSON
 * export button. Exports use the same `pagegloss-backup` v1 envelope as the
 * options page, so they can be imported back unchanged.
 *
 * Hovering a mark opens the real annotation card in read-only mode. The data
 * page is loaded before card.js learns about read-only cards, so the call is
 * capability-checked and falls back to the legacy built-in panel otherwise.
 *
 * Classic script on purpose: messages.js, i18n.js, storage.js and card.js are
 * loaded by data.html before this file, so there is no import/export here.
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
  var TOAST_DURATION = 3200;
  var TOAST_ERROR_DURATION = 5200;
  var SVG_NS = 'http://www.w3.org/2000/svg';

  var ICON_PATHS = {
    chevron: ['M8 10l4 4 4-4'],
    external: ['M14 4h6v6', 'M20 4l-9 9', 'M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5'],
    download: ['M12 4v10', 'M8 10l4 4 4-4', 'M5 19h14'],
    trash: ['M4 7h16', 'M7 7l1 12h8l1-12', 'M10 7V5h4v2']
  };

  var state = {
    pages: [],
    groups: [],
    siteClosed: Object.create(null),
    pageClosed: Object.create(null),
    pageIndex: Object.create(null),
    matrixIndex: Object.create(null),
    selection: emptySelection(),
    selectMode: false,
    loading: false,
    loadToken: 0,
    working: false,
    confirming: false,
    overlay: null,
    // 0 = not tried yet, 1 = card.js supports read-only cards, -1 = fallback.
    cardMode: 0
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
    sites: null,
    selectionCount: null,
    selectAll: null,
    clearSelection: null,
    exportSelected: null,
    deleteSelected: null,
    selectMode: null,
    importData: null,
    importFile: null,
    selectionBar: null,
    toasts: null
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

  /** Small square icon button used for per-site / per-page actions. */
  function iconButton(className, iconName, label, onClick) {
    var node = button('btn-icon-sm' + (className ? ' ' + className : ''));
    node.appendChild(icon(iconName, 'icon'));
    node.title = label;
    node.setAttribute('aria-label', label);
    node.addEventListener('click', onClick);
    return node;
  }

  /** Native checkbox in a label; the change handler re-renders the page. */
  function checkbox(className, checked, label, onChange) {
    var wrap = el('label', 'check' + (className ? ' ' + className : ''));
    var input = document.createElement('input');
    input.type = 'checkbox';
    input.className = 'check-input';
    input.checked = !!checked;
    if (label) input.setAttribute('aria-label', label);
    input.addEventListener('change', function () {
      onChange(!!input.checked);
    });
    wrap.appendChild(input);
    // Rendered only in select mode; the input is also used for the half-state.
    wrap.input = input;
    return wrap;
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

  /* --------------------------------------------------------------- selection */

  function emptySelection() {
    return {
      sites: Object.create(null),
      pages: Object.create(null),
      anns: Object.create(null) // pageKey -> { annotationId: true }
    };
  }

  function annotationIdsOf(page) {
    var ids = Object.create(null);
    var annotations = page && Array.isArray(page.annotations) ? page.annotations : [];
    annotations.forEach(function (item) {
      if (item && item.id) ids[item.id] = true;
    });
    return ids;
  }

  function isAnnotationSelected(pageKey, annotationId) {
    var map = state.selection.anns[pageKey];
    return !!(map && map[annotationId]);
  }

  /** "all" | "some" | "none" for a page, used for checkbox half states. */
  function pageSelectionState(page) {
    var key = pageKeyOf(page);
    var ids = Object.keys(annotationIdsOf(page));
    var map = state.selection.anns[key] || {};
    var picked = ids.filter(function (id) { return !!map[id]; }).length;
    if (ids.length && picked === ids.length) return 'all';
    if (picked > 0) return 'some';
    return state.selection.pages[key] ? 'all' : 'none';
  }

  function siteSelectionState(group) {
    var pages = group && Array.isArray(group.pages) ? group.pages : [];
    var states = pages.map(pageSelectionState);
    if (states.length && states.every(function (s) { return s === 'all'; })) return 'all';
    if (states.some(function (s) { return s !== 'none'; })) return 'some';
    return state.selection.sites[group.key] ? 'all' : 'none';
  }

  function groupByKey(key) {
    for (var i = 0; i < state.groups.length; i++) {
      if (state.groups[i].key === key) return state.groups[i];
    }
    return null;
  }

  function pageByKey(key) {
    for (var i = 0; i < state.pages.length; i++) {
      if (pageKeyOf(state.pages[i]) === key) return state.pages[i];
    }
    return null;
  }

  /** Selecting a site selects every page and mark below it. */
  function setSiteSelected(groupKey, selected) {
    var group = groupByKey(groupKey);
    if (selected) {
      state.selection.sites[groupKey] = true;
      if (group) {
        group.pages.forEach(function (page) {
          var key = pageKeyOf(page);
          state.selection.pages[key] = true;
          var ids = annotationIdsOf(page);
          if (Object.keys(ids).length) state.selection.anns[key] = ids;
        });
      }
    } else {
      delete state.selection.sites[groupKey];
      if (group) {
        group.pages.forEach(function (page) {
          var key = pageKeyOf(page);
          delete state.selection.pages[key];
          delete state.selection.anns[key];
        });
      }
    }
    syncParents();
    render();
  }

  /** Selecting a page selects all of its marks. */
  function setPageSelected(page, selected) {
    var key = pageKeyOf(page);
    if (selected) {
      state.selection.pages[key] = true;
      var ids = annotationIdsOf(page);
      if (Object.keys(ids).length) state.selection.anns[key] = ids;
    } else {
      delete state.selection.pages[key];
      delete state.selection.anns[key];
    }
    syncParents();
    render();
  }

  /** Marks bubble up: a fully selected page selects its site. */
  function setAnnotationSelected(pageKey, annotationId, selected) {
    var map = state.selection.anns[pageKey];
    if (selected) {
      if (!map) map = state.selection.anns[pageKey] = Object.create(null);
      map[annotationId] = true;
    } else if (map) {
      delete map[annotationId];
      if (!Object.keys(map).length) delete state.selection.anns[pageKey];
    }
    var page = pageByKey(pageKey);
    if (page) {
      var ids = Object.keys(annotationIdsOf(page));
      var chosen = state.selection.anns[pageKey] || {};
      var all = ids.length > 0 && ids.every(function (id) { return !!chosen[id]; });
      if (all) state.selection.pages[pageKey] = true;
      else delete state.selection.pages[pageKey];
    }
    syncParents();
    render();
  }

  function syncParents() {
    state.groups.forEach(function (group) {
      var pages = group.pages || [];
      var all = pages.length > 0 && pages.every(function (page) {
        return !!state.selection.pages[pageKeyOf(page)];
      });
      if (all) state.selection.sites[group.key] = true;
      else delete state.selection.sites[group.key];
    });
  }

  /** Checkboxes only appear in select mode, and leaving it clears the picks. */
  function toggleSelectMode() {
    state.selectMode = !state.selectMode;
    state.selection = emptySelection();
    render();
  }

  function clearSelectionState() {
    state.selection = emptySelection();
    updateToolbar();
  }

  function selectAllSites() {
    if (state.working) return;
    state.selection = emptySelection();
    state.groups.forEach(function (group) {
      state.selection.sites[group.key] = true;
    });
    render();
  }

  /**
   * Resolve the selection into the concrete work it implies: whole pages to
   * clear plus individual marks to remove. Pages win over marks on the same
   * page so nothing is processed twice.
   */
  function selectionTotals() {
    var pageKeys = Object.create(null);
    var pages = [];
    var annsByPage = Object.create(null);
    state.groups.forEach(function (group) {
      var siteSelected = !!state.selection.sites[group.key];
      group.pages.forEach(function (page) {
        var key = pageKeyOf(page);
        if (siteSelected || state.selection.pages[key]) {
          if (!pageKeys[key]) {
            pageKeys[key] = true;
            pages.push(page);
          }
          return;
        }
        var picked = state.selection.anns[key];
        if (!picked) return;
        Object.keys(picked).forEach(function (id) {
          if (!picked[id]) return;
          if (!annsByPage[key]) annsByPage[key] = [];
          annsByPage[key].push(id);
        });
      });
    });
    var annotations = 0;
    Object.keys(annsByPage).forEach(function (key) {
      annotations += annsByPage[key].length;
    });
    return {
      pages: pages,
      pageKeys: pageKeys,
      annsByPage: annsByPage,
      count: pages.length + annotations
    };
  }

  /** Forget selections whose site/page/annotation disappeared after a reload. */
  function pruneSelection() {
    var siteKeys = Object.create(null);
    var pageIds = Object.create(null);
    state.groups.forEach(function (group) {
      siteKeys[group.key] = true;
    });
    state.pages.forEach(function (page) {
      pageIds[pageKeyOf(page)] = annotationIdsOf(page);
    });

    Object.keys(state.selection.sites).forEach(function (key) {
      if (!siteKeys[key]) delete state.selection.sites[key];
    });
    Object.keys(state.selection.pages).forEach(function (key) {
      if (!pageIds[key]) delete state.selection.pages[key];
    });
    Object.keys(state.selection.anns).forEach(function (pageKey) {
      if (!pageIds[pageKey]) {
        delete state.selection.anns[pageKey];
        return;
      }
      var live = pageIds[pageKey];
      Object.keys(state.selection.anns[pageKey]).forEach(function (id) {
        if (!live[id]) delete state.selection.anns[pageKey][id];
      });
      if (!Object.keys(state.selection.anns[pageKey]).length) delete state.selection.anns[pageKey];
    });
  }

  /* ------------------------------------------------------------------ loading */

  function load() {
    var token = ++state.loadToken;
    state.loading = true;
    closeOverlay();
    setRefreshBusy(true);
    return Store.getAllPages().then(function (pages) {
      if (token !== state.loadToken) return;
      state.pages = Array.isArray(pages) ? pages : [];
      state.groups = groupPages(state.pages);
      pruneState();
      pruneSelection();
      render();
    }).catch(function (err) {
      if (token !== state.loadToken) return;
      state.pages = [];
      state.groups = [];
      pruneSelection();
      dom.sites.textContent = '';
      renderStats();
      updateToolbar();
      showStatus(t('dataLoadFail', { s: (err && err.message) || t('errUnknown') }), true);
    }).then(function () {
      if (token !== state.loadToken) return;
      state.loading = false;
      setRefreshBusy(false);
      updateToolbar();
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
    dom.selectAll.textContent = t('dataSelectAll');
    dom.clearSelection.textContent = t('dataClearSelection');
    dom.exportSelected.textContent = t('dataExportSelected');
    dom.deleteSelected.textContent = t('dataDeleteSelected');
    dom.selectMode.textContent = t('dataSelectMode');
    dom.importData.textContent = t('dataImport');
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

  /* ---------------------------------------------------------------- toolbar */

  function updateToolbar() {
    var totals = selectionTotals();
    var count = totals.count;
    var selecting = !!state.selectMode;
    dom.selectionBar.hidden = !selecting;
    dom.selectionCount.textContent = t('dataSelectionCount', { n: count });
    dom.selectAll.hidden = !selecting;
    dom.clearSelection.hidden = !selecting;
    dom.deleteSelected.hidden = !selecting;
    dom.exportSelected.hidden = !selecting || count === 0;
    dom.clearSelection.disabled = count === 0 || state.working;
    dom.deleteSelected.disabled = count === 0 || state.working;
    dom.selectAll.disabled = state.loading || state.working || !state.groups.length;
    dom.selectMode.textContent = selecting ? t('dataSelectModeOn') : t('dataSelectMode');
    dom.selectMode.setAttribute('aria-pressed', selecting ? 'true' : 'false');
    dom.selectMode.disabled = state.working;
    dom.importData.disabled = state.working;
  }

  /* ------------------------------------------------------------------ toast */

  /**
   * Non-blocking notice. The node is removed after the fade-out transition
   * (with a timer as a fallback), never just hidden.
   */
  function toast(text, isError) {
    if (!dom.toasts) return;
    var node = el('div', 'toast' + (isError ? ' is-error' : ''));
    node.setAttribute('role', 'status');
    node.textContent = String(text == null ? '' : text);
    dom.toasts.appendChild(node);

    var timer = 0;
    var removed = false;

    function remove() {
      if (removed) return;
      removed = true;
      if (timer) {
        window.clearTimeout(timer);
        timer = 0;
      }
      node.removeEventListener('transitionend', onEnd);
      if (node.parentNode) node.parentNode.removeChild(node);
    }

    function onEnd(event) {
      if (!event || event.target === node) remove();
    }

    node.addEventListener('transitionend', onEnd);
    node.addEventListener('click', remove);
    window.setTimeout(function () {
      if (removed) return;
      node.classList.add('is-leaving');
      window.setTimeout(remove, 400);
    }, isError ? TOAST_ERROR_DURATION : TOAST_DURATION);
    timer = window.setTimeout(remove, (isError ? TOAST_ERROR_DURATION : TOAST_DURATION) + 1200);

    while (dom.toasts.childNodes.length > 4) {
      dom.toasts.removeChild(dom.toasts.firstChild);
    }
  }

  /* ------------------------------------------------------------------ render */

  function render() {
    closeOverlay();
    document.body.classList.toggle('select-mode', !!state.selectMode);
    var scrollTop = dom.content.scrollTop;
    dom.sites.textContent = '';
    renderStats();
    updateToolbar();
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
    var head = el('div', 'site-head');

    var siteCheck = checkbox(
      'site-check',
      siteSelectionState(group) === 'all',
      siteLabel(group.key),
      function (checked) { setSiteSelected(group.key, checked); }
    );
    if (siteSelectionState(group) === 'some') siteCheck.input.indeterminate = true;
    head.appendChild(siteCheck);

    var toggle = button('site-toggle');
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    toggle.appendChild(icon('chevron', 'chev'));
    var name = el('span', 'site-name', siteLabel(group.key));
    name.title = group.key;
    toggle.appendChild(name);
    var meta = el('span', 'site-meta');
    meta.textContent = t('dataPagesCount', { n: group.pages.length }) +
      ' · ' + t('dataAnnotationsCount', { n: group.annotations });
    toggle.appendChild(meta);
    toggle.addEventListener('click', function () {
      state.siteClosed[group.key] = open;
      render();
    });
    head.appendChild(toggle);

    var actions = el('div', 'site-actions');
    actions.appendChild(iconButton(
      '',
      'download',
      t('dataExportSite') + ' · ' + siteLabel(group.key),
      function () { exportSite(group); }
    ));
    actions.appendChild(iconButton(
      'is-danger',
      'trash',
      t('dataDelete') + ' · ' + siteLabel(group.key),
      function () { deleteSite(group); }
    ));
    head.appendChild(actions);
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
    var label = page.title || page.url || key;
    var open = !state.pageClosed[key];
    var article = el('article', 'page');
    var row = el('div', 'page-row');

    var pageCheck = checkbox(
      'page-check',
      pageSelectionState(page) === 'all',
      label,
      function (checked) { setPageSelected(page, checked); }
    );
    if (pageSelectionState(page) === 'some') pageCheck.input.indeterminate = true;
    row.appendChild(pageCheck);

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

    var actions = el('div', 'page-actions');
    actions.appendChild(iconButton(
      '',
      'download',
      t('dataExportPage') + ' · ' + label,
      function () { exportPage(page); }
    ));
    actions.appendChild(iconButton(
      'is-danger',
      'trash',
      t('dataDelete') + ' · ' + label,
      function () { deletePage(page); }
    ));
    row.appendChild(actions);

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
    var pageKey = pageKeyOf(page);
    var text = String((annotation && annotation.text) || '');
    var cell = el('div', 'mark-cell');
    if (annotation && annotation.stale === true) cell.classList.add('is-stale');

    cell.appendChild(checkbox(
      'mark-check',
      isAnnotationSelected(pageKey, annotation && annotation.id),
      text || t('dataAnnotationsTitle'),
      function (checked) {
        if (annotation && annotation.id) setAnnotationSelected(pageKey, annotation.id, checked);
      }
    ));

    var hit = button('mark-hit');
    hit.appendChild(el('span', 'mark-text', text));

    var foot = el('span', 'mark-foot');
    if (annotation && annotation.stale === true) {
      var badge = el('span', 'stale-badge', t('dataStale'));
      badge.title = t('dataStaleHint');
      foot.appendChild(badge);
    }
    foot.appendChild(el('span', 'mark-time', updatedLine(annotation.updatedAt || annotation.createdAt)));
    hit.appendChild(foot);
    if (text) hit.setAttribute('aria-label', text + ' — ' + t('dataOpenHint'));

    hit.addEventListener('mouseenter', function () {
      showOverlay(page, annotation, cell);
    });
    hit.addEventListener('mouseleave', scheduleOverlayClose);
    hit.addEventListener('focus', function () {
      showOverlay(page, annotation, cell);
    });
    hit.addEventListener('blur', scheduleOverlayClose);
    hit.addEventListener('click', function () {
      closeOverlay();
      openFocus(page, annotation);
    });

    cell.appendChild(hit);
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

  /* ---------------------------------------------------------------- navigation */

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

  /** Open the same full page reader tab the in-page card opens. */
  function openFullpage(page, annotation) {
    var key = pageKeyOf(page);
    var id = annotation && annotation.id ? String(annotation.id) : '';
    if (!key || !id) return;
    var url = chrome.runtime.getURL('src/fullpage/fullpage.html') +
      '?key=' + encodeURIComponent(key) + '&id=' + encodeURIComponent(id);
    try {
      chrome.tabs.create({ url: url });
    } catch (err) {
      openUrl(url);
    }
  }

  /* ----------------------------------------------------------------- deletion */

  function messageOf(err) {
    if (!err) return t('errUnknown');
    var text = err && err.message ? String(err.message) : String(err);
    return text.length > 300 ? text.slice(0, 300) : text;
  }

  function confirmDelete(count) {
    var title = t('dataDeleteConfirm', { n: count });
    closeOverlay();
    var api = window.PageGlossCard;
    if (api && typeof api.confirm === 'function') {
      try {
        return api.confirm({
          title: title,
          body: '',
          cancel: t('confirmCancel'),
          ok: t('dataDelete')
        }).catch(function () { return false; });
      } catch (err) { /* fall through to window.confirm */ }
    }
    try {
      return Promise.resolve(window.confirm(title));
    } catch (err) {
      return Promise.resolve(false);
    }
  }

  /**
   * Run a delete plan sequentially. Sequential writes matter because the
   * storage index is read-modify-write; parallel clearPage calls would race.
   */
  function runDelete(spec) {
    if (state.working) return Promise.resolve(false);
    state.working = true;
    closeOverlay();
    setRefreshBusy(true);
    updateToolbar();

    var done = 0;
    var chain = Promise.resolve();

    spec.pageKeys.forEach(function (key) {
      chain = chain.then(function () {
        return Store.clearPage(key).then(function () {
          done++;
        });
      });
    });

    Object.keys(spec.annsByPage).forEach(function (key) {
      var ids = spec.annsByPage[key];
      chain = chain.then(function () {
        return Store.getPage(key).then(function (page) {
          ids.forEach(function (id) {
            Store.removeAnnotationFromPage(page, id);
          });
          if (!page.annotations.length) {
            return Store.clearPage(key).then(function () {
              done += ids.length;
            });
          }
          return Store.savePage(page).then(function () {
            done += ids.length;
          });
        });
      });
    });

    function finish() {
      state.working = false;
      clearSelectionState();
      return load();
    }

    return chain.then(function () {
      return finish().then(function () {
        toast(t('dataDeleted', { n: done }));
      });
    }, function (err) {
      return finish().then(function () {
        toast(t('dataDeleteFail', { s: messageOf(err) }), true);
      });
    });
  }

  /** One confirmation at a time, whatever entry point asked for it. */
  function askDelete(count, onConfirm) {
    if (state.working || state.confirming) return;
    state.confirming = true;
    confirmDelete(count).then(function (ok) {
      state.confirming = false;
      if (ok) onConfirm();
    });
  }

  function deleteSelection() {
    var totals = selectionTotals();
    if (!totals.count) return;
    askDelete(totals.count, function () {
      runDelete({
        pageKeys: totals.pages.map(pageKeyOf),
        annsByPage: totals.annsByPage
      });
    });
  }

  function deleteSite(group) {
    if (!group || !group.pages.length) return;
    var pageKeys = group.pages.map(pageKeyOf);
    askDelete(pageKeys.length, function () {
      runDelete({ pageKeys: pageKeys, annsByPage: {} });
    });
  }

  function deletePage(page) {
    if (!page) return;
    var key = pageKeyOf(page);
    askDelete(1, function () {
      runDelete({ pageKeys: [key], annsByPage: {} });
    });
  }

  /* ------------------------------------------------------------------- import */

  /**
   * Merge a pagegloss-backup file into the cache.
   *
   * Pages merge by URL key and annotations by id. A mark whose text AND
   * explanation are already present is skipped, so re-importing the same file
   * twice never duplicates entries.
   */
  function importData(file) {
    if (state.working) return;
    var reader = new FileReader();
    reader.onload = function () {
      var payload;
      try {
        payload = JSON.parse(String(reader.result || ''));
      } catch (err) {
        toast(t('dataImportFail', { s: t('errUnknown') }), true);
        return;
      }
      if (!payload || payload.format !== 'pagegloss-backup' || !payload.pages || typeof payload.pages !== 'object') {
        toast(t('dataImportFail', { s: t('errUnknown') }), true);
        return;
      }
      state.working = true;
      setRefreshBusy(true);
      updateToolbar();
      var imported = 0;
      var touched = 0;
      var chain = Promise.resolve();
      Object.keys(payload.pages).forEach(function (key) {
        chain = chain.then(function () {
          return Store.getPage(key).then(function (existing) {
            var incoming = Store.sanitizePage(payload.pages[key], key);
            var changed = false;
            incoming.annotations.forEach(function (annotation) {
              var duplicate = existing.annotations.some(function (old) {
                if (old.id && annotation.id && old.id === annotation.id) return true;
                return String(old.text) === String(annotation.text) &&
                  String(old.explanation || '') === String(annotation.explanation || '');
              });
              if (duplicate) return;
              existing.annotations.push(annotation);
              imported += 1;
              changed = true;
            });
            if (!existing.title && incoming.title) existing.title = incoming.title;
            if (!existing.url && incoming.url) existing.url = incoming.url;
            if (!changed) return null;
            touched += 1;
            return Store.savePage(existing);
          });
        });
      });
      chain.then(function () {
        state.working = false;
        setRefreshBusy(false);
        toast(imported ? t('dataImportOk', { n: touched }) : t('dataImportEmpty'));
        return load();
      }).catch(function (err) {
        state.working = false;
        setRefreshBusy(false);
        updateToolbar();
        toast(t('dataImportFail', { s: messageOf(err) }), true);
      });
    };
    reader.onerror = function () {
      toast(t('dataImportFail', { s: t('errUnknown') }), true);
    };
    reader.readAsText(file);
  }

  /* ------------------------------------------------------------------- export */

  function pad2(value) {
    return value < 10 ? '0' + value : String(value);
  }

  function dateStamp() {
    var now = new Date();
    return now.getFullYear() + '-' + pad2(now.getMonth() + 1) + '-' + pad2(now.getDate());
  }

  function slugify(value) {
    return String(value || '')
      .toLowerCase()
      .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
      .replace(/[^a-z0-9.-]+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '')
      .slice(0, 60);
  }

  function filenameFor(type, nameSource) {
    var stamp = dateStamp();
    if (type === 'selection') return 'pagegloss-selection-' + stamp + '.json';
    var slug = slugify(nameSource) || 'page';
    return 'pagegloss-' + type + '-' + slug + '-' + stamp + '.json';
  }

  function downloadFile(text, filename) {
    var blob = new Blob([text], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 4000);
  }

  /**
   * Build a pagegloss-backup v1 payload from fresh Store.getPage results and
   * download it. The options page imports exactly this shape, so scope and
   * exportedAt are informational only.
   */
  function exportPayload(keys, type, label, nameSource) {
    var unique = [];
    var seen = Object.create(null);
    keys.forEach(function (key) {
      if (!key || seen[key]) return;
      seen[key] = true;
      unique.push(key);
    });
    if (!unique.length) {
      toast(t('dataExportFail', { s: t('dataEmpty') }), true);
      return Promise.resolve(false);
    }

    closeOverlay();
    return Promise.all(unique.map(function (key) {
      return Store.getPage(key).then(function (page) {
        return page;
      }).catch(function () {
        return null;
      });
    })).then(function (pages) {
      var map = {};
      pages.forEach(function (page) {
        if (page && page.urlKey) map[page.urlKey] = page;
      });
      var count = Object.keys(map).length;
      if (!count) throw new Error(t('dataEmpty'));
      var payload = {
        format: 'pagegloss-backup',
        version: 1,
        exportedAt: new Date().toISOString(),
        scope: { type: type, label: label },
        pages: map
      };
      downloadFile(JSON.stringify(payload, null, 2), filenameFor(type, nameSource));
      toast(t('dataExportOk', { n: count }));
      return true;
    }).catch(function (err) {
      toast(t('dataExportFail', { s: messageOf(err) }), true);
      return false;
    });
  }

  function exportSite(group) {
    exportPayload(
      group.pages.map(pageKeyOf),
      'site',
      siteLabel(group.key),
      siteLabel(group.key)
    );
  }

  function exportPage(page) {
    var key = pageKeyOf(page);
    var label = page.title || page.url || key;
    exportPayload([key], 'page', label, siteLabel(siteKeyOf(page)));
  }

  function exportSelection() {
    var totals = selectionTotals();
    if (!totals.count) return;
    var keys = totals.pages.map(pageKeyOf);
    Object.keys(totals.annsByPage).forEach(function (key) {
      keys.push(key);
    });
    exportPayload(keys, 'selection', t('dataExportSelected'), '');
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
    if (annotation && annotation.stale === true) {
      var badge = el('span', 'stale-badge', t('dataStale'));
      badge.title = t('dataStaleHint');
      foot.appendChild(badge);
    }
    foot.appendChild(el('span', 'overlay-time', updatedLine(annotation.updatedAt || annotation.createdAt)));
    node.appendChild(foot);
    return node;
  }

  /** Compute the fixed position for a panel/card anchored to a cell. */
  function floatingPosition(node, cell) {
    if (!node || !cell || !cell.getBoundingClientRect) return null;
    var margin = 8;
    var gap = 8;
    var viewportWidth = document.documentElement.clientWidth || window.innerWidth;
    var viewportHeight = window.innerHeight || document.documentElement.clientHeight;
    var rect = cell.getBoundingClientRect();
    var width = node.offsetWidth || 360;
    var height = node.offsetHeight || 240;

    var left = rect.left;
    var top = rect.bottom + gap;
    if (left + width > viewportWidth - margin) left = viewportWidth - margin - width;
    if (left < margin) left = margin;
    if (top + height > viewportHeight - margin) {
      var above = rect.top - gap - height;
      top = above >= margin ? above : Math.max(margin, viewportHeight - margin - height);
    }
    if (top < margin) top = margin;

    return { left: Math.round(left), top: Math.round(top) };
  }

  /** Keep the floating panel/card inside the viewport, flipping above if needed. */
  function placeFloating(node, cell) {
    var position = floatingPosition(node, cell);
    if (!position) return;
    node.style.left = position.left + 'px';
    node.style.top = position.top + 'px';
  }

  function destroyCard(card) {
    if (!card) return;
    try {
      if (typeof card.destroy === 'function') card.destroy();
      else if (typeof card.close === 'function') card.close(false);
      else if (card.host && card.host.parentNode) card.host.parentNode.removeChild(card.host);
    } catch (err) { /* the node is detached on a best-effort basis */ }
  }

  /** Wire the card's own close button to this page's overlay lifecycle. */
  function wireCardClose(card) {
    try {
      var root = card && card.host ? card.host.shadowRoot : null;
      if (!root) return;
      var closeButton = root.querySelector('.close');
      if (closeButton) closeButton.addEventListener('click', closeOverlay);
    } catch (err) { /* older/alternative card builds may not expose .close */ }
  }

  /**
   * Ask card.js for a read-only card. Older builds ignore `readOnly` and return
   * the interactive API without the read-only surface, so it is validated and
   * destroyed immediately; the caller then uses the legacy panel.
   */
  function tryCreateReadOnlyCard(page, annotation, cell) {
    if (state.cardMode < 0) return null;
    var api = window.PageGlossCard;
    if (!api || typeof api.create !== 'function') {
      state.cardMode = -1;
      return null;
    }
    var rect = cell.getBoundingClientRect();
    var card = null;
    try {
      card = api.create({
        readOnly: true,
        i18n: I,
        term: String((annotation && annotation.text) || ''),
        color: annotation && annotation.color ? String(annotation.color) : '',
        explanation: explanationText(page, annotation),
        note: annotation && typeof annotation.note === 'string' ? annotation.note : '',
        position: { x: Math.round(rect.left), y: Math.round(rect.bottom + 8) }
      });
    } catch (err) {
      card = null;
    }
    var supported = !!(card && card.host);
    if (supported) {
      try {
        supported = card.readOnly === true ||
          typeof card.scrollToTop === 'function' ||
          (card.host.getAttribute && card.host.getAttribute('data-readonly') === 'true') ||
          !!(card.host.shadowRoot && card.host.shadowRoot.querySelector('.card[aria-readonly="true"]'));
      } catch (err) {
        supported = false;
      }
    }
    if (!supported) {
      destroyCard(card);
      state.cardMode = -1;
      return null;
    }
    state.cardMode = 1;
    // card.js returns a detached host; the caller owns mounting it.
    if (!card.host.isConnected) {
      (document.body || document.documentElement).appendChild(card.host);
    }
    if (typeof card.setHandlers === 'function') {
      // The read-only card keeps the fullscreen button: it opens the same
      // reader tab as the in-page card does.
      card.setHandlers({
        onFullscreen: function () {
          closeOverlay();
          openFullpage(page, annotation);
        }
      });
    }
    return card;
  }

  function cancelOverlayTimer(record) {
    if (!record || !record.timer) return;
    window.clearTimeout(record.timer);
    record.timer = 0;
  }

  /** Keep the card open while the pointer is over the card or its note pane. */
  function bindCardHover(card, record) {
    function keepOpen() {
      cancelOverlayTimer(record);
    }
    var targets = [card.host];
    try {
      var root = card.host.shadowRoot;
      if (root) {
        var content = root.querySelector('.card');
        var note = root.querySelector('.note');
        if (content) targets.push(content);
        if (note) targets.push(note);
      }
    } catch (err) { /* fall back to the host alone */ }
    targets.forEach(function (target) {
      target.addEventListener('mouseenter', keepOpen);
      target.addEventListener('mouseleave', scheduleOverlayClose);
    });
  }

  function showOverlay(page, annotation, cell) {
    if (!cell) return;
    var current = state.overlay;
    if (current && current.cell === cell) {
      cancelOverlayTimer(current);
      return;
    }
    closeOverlay();

    var record = { cell: cell, timer: 0, card: null, node: null };
    state.overlay = record;

    var card = tryCreateReadOnlyCard(page, annotation, cell);
    if (card) {
      record.card = card;
      bindCardHover(card, record);
      wireCardClose(card);
      var cardPosition = floatingPosition(card.host, cell);
      if (cardPosition) {
        // setPosition also re-runs the card's own note-pane placement, which
        // matters after the panel flips above the cell.
        if (typeof card.setPosition === 'function') card.setPosition(cardPosition.left, cardPosition.top);
        else {
          card.host.style.left = cardPosition.left + 'px';
          card.host.style.top = cardPosition.top + 'px';
        }
      }
      return;
    }

    var node = buildOverlay(page, annotation);
    record.node = node;
    node.addEventListener('mouseenter', function () {
      cancelOverlayTimer(record);
    });
    node.addEventListener('mouseleave', scheduleOverlayClose);
    document.body.appendChild(node);
    placeFloating(node, cell);
  }

  function scheduleOverlayClose() {
    var record = state.overlay;
    if (!record) return;
    cancelOverlayTimer(record);
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
    cancelOverlayTimer(record);
    if (record.card) destroyCard(record.card);
    if (record.node && record.node.isConnected) record.node.remove();
  }

  /* --------------------------------------------------------------------- init */

  function wire() {
    dom.expandAll.addEventListener('click', expandAll);
    dom.collapseAll.addEventListener('click', collapseAll);
    dom.refresh.addEventListener('click', function () {
      if (!state.loading && !state.working) load();
    });
    dom.selectAll.addEventListener('click', selectAllSites);
    dom.clearSelection.addEventListener('click', function () {
      closeOverlay();
      clearSelectionState();
      render();
    });
    dom.exportSelected.addEventListener('click', exportSelection);
    dom.deleteSelected.addEventListener('click', deleteSelection);
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
    dom.selectionCount = document.getElementById('selectionCount');
    dom.selectAll = document.getElementById('selectAll');
    dom.clearSelection = document.getElementById('clearSelection');
    dom.exportSelected = document.getElementById('exportSelected');
    dom.deleteSelected = document.getElementById('deleteSelected');
    dom.selectMode = document.getElementById('selectMode');
    dom.importData = document.getElementById('importData');
    dom.importFile = document.getElementById('importFile');
    dom.selectionBar = document.getElementById('selectionBar');
    dom.toasts = document.getElementById('toasts');
    dom.selectMode.addEventListener('click', toggleSelectMode);
    dom.importData.addEventListener('click', function () {
      if (dom.importFile) dom.importFile.click();
    });
    dom.importFile.addEventListener('change', function (event) {
      var file = event.target.files && event.target.files[0];
      dom.importFile.value = '';
      if (file) importData(file);
    });
    applyLabels();
    updateToolbar();
    wire();
    load();
  }

  init();
})();
