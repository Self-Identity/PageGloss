/* PageGloss - shared UI helpers: toast with real DOM removal + API error text.
 * Every toast node is removed after its animation ends, and all timers are
 * cleared on destroy so nothing lingers in the DOM.
 */
(function () {
  'use strict';

  var root = null;
  var live = [];
  var MAX_VISIBLE = 3;

  /**
   * Turn an error object from the background worker into a human sentence.
   * `t` is a translator from i18n.js, `describe` is PageGlossShared.apiErrorKey.
   */
  function formatApiError(message, t, describe) {
    var info = describe ? describe(message) : { key: 'errUnknown' };
    var text = t(info.key, info.values);
    if (info.hintKey && info.hintKey !== info.key) {
      var hint = t(info.hintKey);
      if (hint && hint !== info.hintKey && text.indexOf(hint) < 0) text += ' ' + hint;
    }
    return text;
  }

  function ensureRoot() {
    if (root && root.isConnected) return root;
    root = document.createElement('div');
    root.className = 'pg-toast-root';
    root.setAttribute('role', 'status');
    root.setAttribute('aria-live', 'polite');
    (document.body || document.documentElement).appendChild(root);
    return root;
  }

  function remove(items, item) {
    var index = items.indexOf(item);
    if (index >= 0) items.splice(index, 1);
    if (item.timer) {
      window.clearTimeout(item.timer);
      item.timer = 0;
    }
    if (item.node && item.node.isConnected) item.node.remove();
  }

  function hide(item) {
    if (!item.node || !item.node.isConnected || item.leaving) return;
    item.leaving = true;
    item.node.classList.add('pg-toast-out');
    var done = false;
    var finish = function () {
      if (done) return;
      done = true;
      item.node.removeEventListener('transitionend', finish);
      remove(live, item);
    };
    item.node.addEventListener('transitionend', finish);
    item.finishTimer = window.setTimeout(finish, 400);
  }

  function show(message, options) {
    var opts = options || {};
    if (!message) return null;
    var container = ensureRoot();
    while (live.length >= MAX_VISIBLE) {
      remove(live, live[0]);
    }
    var node = document.createElement('div');
    node.className = 'pg-toast';
    node.textContent = String(message);
    container.appendChild(node);
    var item = {
      node: node,
      timer: window.setTimeout(function () { hide(item); }, opts.duration || 3000),
      leaving: false,
      finishTimer: 0
    };
    live.push(item);
    return item;
  }

  function destroyAll() {
    live.slice().forEach(function (item) { remove(live, item); });
    if (root && root.isConnected) root.remove();
    root = null;
  }

  window.PageGlossUI = {
    toast: show,
    destroyAll: destroyAll,
    formatApiError: formatApiError
  };
})();
