/*
 * PageGloss - shared constants and small helpers.
 *
 * CLASSIC SCRIPT ONLY (no import/export statements on purpose).
 * Loaded by the manifest content scripts and by the popup/options HTML pages,
 * which read `globalThis.PageGlossShared`. ES module consumers (service worker,
 * popup, options) import `shared.mjs` instead, which re-exports the same values.
 */

(function () {
  'use strict';

  var PROTOCOL_VERSION = 3;
  var STORAGE_PREFIX = 'pg:page:';
  var STORAGE_INDEX_KEY = 'pg:index';
  var SETTINGS_KEY = 'pg:settings';
  var MAX_MARKS_PER_ANNOTATION = 1500;
  var MAX_NOTE_BYTES = 32 * 1024;
  var MAX_CHAT_MESSAGES = 40;
  var MAX_PAGE_CHARS = 24000;
  var CONTEXT_MODES = ['page', 'section', 'sentence'];
  var DEFAULT_CONTEXT_MODE = 'page';
  var MATCH_MODES = ['smart', 'loose', 'strict'];
  var DEFAULT_MATCH_MODE = 'smart';
  var HOVER_DELAY_MS = 220;

  var DEFAULT_SETTINGS = {
    enabled: true,
    language: 'auto',
    contextMode: DEFAULT_CONTEXT_MODE,
    matchMode: DEFAULT_MATCH_MODE,
    markSentenceTokens: false,
    apiBaseUrl: '',
    apiKey: '',
    model: 'gpt-4o-mini',
    temperature: 0.3,
    maxTokens: 900,
    stream: true,
    systemPrompt: '',
    maxContextChars: 24000,
    requestTimeoutMs: 60000,
    cardHoverOpen: true,
    hideLlmUiHosts: true
  };

  var DEFAULT_SYSTEM_PROMPT = [
    '你是一位严谨的阅读助手，负责解释文章中出现的词语、短语或句子。',
    '',
    '规则：',
    '1. 只依据用户提供的页面上下文作答；上下文不足以判断时，明确说明“仅凭本页内容无法确定”，再给出最可能的通用含义。',
    '2. 先用一句话给出该词在本页语境下的确切含义，再补充 2-4 条要点：可能的本义、在该领域的常见用法、以及本页中它的具体所指。',
    '3. 若该词是专业术语或缩写，先给出全称，再给出中文/英文对照。',
    '4. 用户继续追问时，延续同一个词的上下文，回答保持简洁，不要再重复开头的总述。',
    '5. 输出使用 Markdown，不要输出 JSON，不要复述本规则。'
  ].join('\n');

  var DEFAULT_SYSTEM_PROMPT_EN = [
    'You are a rigorous reading assistant explaining words, phrases or sentences in context.',
    '',
    'Rules:',
    '1. Use only the page context supplied by the user. If it is not enough, say "the page alone does not determine this" and then give the most likely general meaning.',
    '2. Start with one sentence giving the exact meaning in this page\'s context, then add 2-4 bullets: literal sense, common usage in the field, and what it refers to here.',
    '3. For jargon or abbreviations, give the full form first, then a translation if useful.',
    '4. For follow-up questions stay on the same term and do not repeat the opening summary.',
    '5. Answer in Markdown, never JSON, and never restate these rules.'
  ].join('\n');

  var CONTEXT_MODE_KEYS = {
    page: { label: 'modePage', hint: 'modePageHint' },
    section: { label: 'modeSection', hint: 'modeSectionHint' },
    sentence: { label: 'modeSentence', hint: 'modeSentenceHint' }
  };

  function cloneDefaultSettings() {
    var copy = {};
    for (var key in DEFAULT_SETTINGS) {
      if (Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, key)) copy[key] = DEFAULT_SETTINGS[key];
    }
    copy.systemPrompt = '';
    return copy;
  }

  /** Clean up user input without inventing a path. Empty path stays empty. */
  function normalizeInputUrl(value) {
    var url = String(value || '').trim();
    if (!url) return '';
    url = url.replace(/\s+/g, '');
    url = url.replace(/\/+$/, '');
    return url;
  }

  /**
   * Chat completion candidates for a user supplied address, most likely first.
   *
   * A bare origin is ambiguous: OpenAI needs /v1/chat/completions while DeepSeek
   * 404s there (it serves /chat/completions directly), so both are offered and
   * the caller falls back on 404. The typed value is never rewritten.
   */
  function chatEndpointCandidates(value) {
    var input = normalizeInputUrl(value);
    var out = [];
    function push(url) {
      if (url && out.indexOf(url) < 0) out.push(url);
    }
    if (!input) return out;
    if (/\/chat\/completions$/.test(input) || /\/completions$/.test(input)) {
      push(input);
      return out;
    }
    if (/\/v\d+$/.test(input)) {
      push(input + '/chat/completions');
      return out;
    }
    var parsed = null;
    try {
      parsed = new URL(input);
    } catch (err) {
      push(input + '/v1/chat/completions');
      return out;
    }
    var path = parsed.pathname.replace(/\/+$/, '');
    if (!path) {
      push(parsed.origin + '/v1/chat/completions');
      push(parsed.origin + '/chat/completions');
      return out;
    }
    push(input + '/chat/completions');
    return out;
  }

  /**
   * Candidate URLs for the OpenAI-compatible model list, most likely first.
   * Each candidate is derived from the user's input, not from a rewritten one.
   */
  function modelsEndpointCandidates(value) {
    var input = normalizeInputUrl(value);
    var out = [];
    function push(url) {
      if (url && out.indexOf(url) < 0) out.push(url);
    }
    if (!input) return out;

    var base = null;
    try {
      base = new URL(input);
    } catch (err) {
      return out;
    }
    var path = base.pathname.replace(/\/+$/, '');
    var origin = base.origin;

    if (/\/chat\/completions$/.test(path)) {
      // Explicit chat endpoint: the list sits next to it.
      push(origin + path.slice(0, path.length - '/chat/completions'.length) + '/models');
      push(origin + '/models');
      return out;
    }
    if (/\/v\d+$/.test(path)) {
      push(origin + path + '/models');
      push(origin + path.replace(/\/v\d+$/, '') + '/models');
      return out;
    }
    if (path && path !== '/') {
      push(origin + path + '/models');
      push(origin + path + '/v1/models');
      return out;
    }
    // Bare origin: OpenAI style first, then DeepSeek style.
    push(origin + '/v1/models');
    push(origin + '/models');
    return out;
  }

  /** Origin pattern for host permissions, derived from raw user input. */
  function baseUrlOrigin(value) {
    var url = normalizeInputUrl(value);
    if (!url) return '';
    try {
      return new URL(url).origin + '/*';
    } catch (err) {
      return '';
    }
  }

  function truncate(text, limit) {
    var value = String(text == null ? '' : text);
    if (!limit || value.length <= limit) return value;
    return value.slice(0, limit) + '…';
  }

  function normalizeUrlKey(rawUrl) {
    try {
      var url = new URL(String(rawUrl));
      url.hash = '';
      ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid', 'fbclid', 'spm', 'from'].forEach(function (key) {
        url.searchParams.delete(key);
      });
      var search = url.searchParams.toString();
      return url.origin + url.pathname + (search ? '?' + search : '');
    } catch (err) {
      return String(rawUrl || '');
    }
  }

  function storageKey(urlKey) {
    return STORAGE_PREFIX + urlKey;
  }

  function hasChinese(text) {
    return /[\u4e00-\u9fff]/.test(String(text || ''));
  }

  function cssEscape(value) {
    if (typeof CSS !== 'undefined' && CSS && typeof CSS.escape === 'function') return CSS.escape(value);
    return String(value).replace(/["\\]/g, '\\$&');
  }

  function uuid() {
    if (typeof crypto !== 'undefined' && crypto && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    return 'pg-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  /**
   * True when the needle is a word-like token (letters/digits/apostrophes only).
   * Used by the matcher to decide whether word boundaries are required.
   */
  function isWordLikeNeedle(needle) {
    var value = String(needle == null ? '' : needle).replace(/^\s+|\s+$/g, '');
    if (!value) return false;
    if (/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(value)) return false;
    return /^[\p{L}\p{N}][\p{L}\p{N}'’.\-]*$/u.test(value);
  }

  /**
   * Error object from background messages -> the i18n key that explains it.
   * Shared by the content script, popup and options page so every surface
   * reports the same thing instead of a bare "http".
   */
  function apiErrorKey(message) {
    if (!message || typeof message !== 'object') return { key: 'errUnknown' };
    if (message.code === 'no-config') return { key: 'errNoConfig' };
    if (message.code === 'no-key') return { key: 'errNoKey' };
    if (message.code === 'permission') return { key: 'errPermission' };
    if (message.code === 'empty') return { key: 'errEmpty', values: { s: message.detail || '' } };
    if (message.code === 'aborted') return { key: 'errAborted' };
    if (message.code === 'timeout') return { key: 'errTimeout', values: { n: Math.round((message.timeoutMs || 0) / 1000) } };
    if (message.code === 'network') return { key: 'errNetwork', values: { s: message.detail || '' } };
    if (message.code === 'endpoint-not-found') {
      return {
        key: 'errEndpointNotFound',
        values: { s: (message.tried || []).join(' , ') || message.detail || '' }
      };
    }
    if (message.code === 'models-unavailable') {
      return {
        key: 'errModelsUnavailable',
        values: { s: (message.tried || []).join(' , ') || message.detail || '' }
      };
    }
    if (message.code === 'http') {
      var status = message.status || 0;
      var keys = {
        400: 'errBadRequest',
        401: 'errAuth',
        403: 'errAuth',
        404: 'errEndpoint404',
        408: 'errTimeout',
        413: 'errTooLarge',
        429: 'errRateLimited'
      };
      var hintKey = keys[status] || (status >= 500 ? 'errServer' : 'errHttpGeneric');
      return {
        key: 'errHttp',
        values: { n: status, s: message.detail || '' },
        hintKey: hintKey
      };
    }
    return { key: 'errUnknown', values: { s: message.detail || '' } };
  }

  globalThis.PageGlossShared = {
    PROTOCOL_VERSION: PROTOCOL_VERSION,
    STORAGE_PREFIX: STORAGE_PREFIX,
    STORAGE_INDEX_KEY: STORAGE_INDEX_KEY,
    SETTINGS_KEY: SETTINGS_KEY,
    MAX_MARKS_PER_ANNOTATION: MAX_MARKS_PER_ANNOTATION,
    MAX_NOTE_BYTES: MAX_NOTE_BYTES,
    MAX_CHAT_MESSAGES: MAX_CHAT_MESSAGES,
    MAX_PAGE_CHARS: MAX_PAGE_CHARS,
    CONTEXT_MODES: CONTEXT_MODES,
    DEFAULT_CONTEXT_MODE: DEFAULT_CONTEXT_MODE,
    MATCH_MODES: MATCH_MODES,
    DEFAULT_MATCH_MODE: DEFAULT_MATCH_MODE,
    HOVER_DELAY_MS: HOVER_DELAY_MS,
    CONTEXT_MODE_KEYS: CONTEXT_MODE_KEYS,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    DEFAULT_SYSTEM_PROMPT: DEFAULT_SYSTEM_PROMPT,
    DEFAULT_SYSTEM_PROMPT_EN: DEFAULT_SYSTEM_PROMPT_EN,
    cloneDefaultSettings: cloneDefaultSettings,
    normalizeInputUrl: normalizeInputUrl,
    chatEndpointCandidates: chatEndpointCandidates,
    baseUrlOrigin: baseUrlOrigin,
    modelsEndpointCandidates: modelsEndpointCandidates,
    truncate: truncate,
    normalizeUrlKey: normalizeUrlKey,
    storageKey: storageKey,
    hasChinese: hasChinese,
    cssEscape: cssEscape,
    uuid: uuid,
    isWordLikeNeedle: isWordLikeNeedle,
    apiErrorKey: apiErrorKey
  };
})();
