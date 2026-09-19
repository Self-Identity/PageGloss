/*
 * PageGloss - ES module surface for the shared helpers.
 *
 * The service worker, popup and options page import this file. It is a thin,
 * side-effect-free wrapper around the classic scripts (messages.js and
 * storage.js) that all other contexts load directly, so there is exactly one
 * implementation of every constant and helper.
 *
 * Note: importing this file alone does NOT execute the classic scripts. Every
 * consumer must load messages.js and storage.js as classic scripts too (the
 * content script via the manifest, the popup/options via <script> tags, the
 * service worker via an explicit import of the side-effect modules below).
 */

import './messages.js';
import './storage.js';

const shared = globalThis.PageGlossShared;
const store = globalThis.PageGlossStore;

if (!shared) {
  throw new Error('shared.mjs: messages.js did not run; the classic scripts must be loaded first');
}
if (!store) {
  throw new Error('shared.mjs: storage.js did not run; the classic scripts must be loaded first');
}

export const PROTOCOL_VERSION = shared.PROTOCOL_VERSION;
export const STORAGE_PREFIX = shared.STORAGE_PREFIX;
export const STORAGE_INDEX_KEY = shared.STORAGE_INDEX_KEY;
export const SETTINGS_KEY = shared.SETTINGS_KEY;
export const MAX_MARKS_PER_ANNOTATION = shared.MAX_MARKS_PER_ANNOTATION;
export const MAX_NOTE_BYTES = shared.MAX_NOTE_BYTES;
export const MAX_CHAT_MESSAGES = shared.MAX_CHAT_MESSAGES;
export const MAX_PAGE_CHARS = shared.MAX_PAGE_CHARS;
export const CONTEXT_MODES = shared.CONTEXT_MODES;
export const DEFAULT_CONTEXT_MODE = shared.DEFAULT_CONTEXT_MODE;
export const MATCH_MODES = shared.MATCH_MODES;
export const DEFAULT_MATCH_MODE = shared.DEFAULT_MATCH_MODE;
export const HOVER_DELAY_MS = shared.HOVER_DELAY_MS;
export const CONTEXT_MODE_KEYS = shared.CONTEXT_MODE_KEYS;
export const DEFAULT_SETTINGS = shared.DEFAULT_SETTINGS;
export const DEFAULT_SYSTEM_PROMPT = shared.DEFAULT_SYSTEM_PROMPT;
export const DEFAULT_SYSTEM_PROMPT_EN = shared.DEFAULT_SYSTEM_PROMPT_EN;

export const cloneDefaultSettings = shared.cloneDefaultSettings;
export const normalizeInputUrl = shared.normalizeInputUrl;
export const chatEndpointCandidates = shared.chatEndpointCandidates;
export const baseUrlOrigin = shared.baseUrlOrigin;
export const modelsEndpointCandidates = shared.modelsEndpointCandidates;
export const truncate = shared.truncate;
export const normalizeUrlKey = shared.normalizeUrlKey;
export const storageKey = shared.storageKey;
export const hasChinese = shared.hasChinese;
export const cssEscape = shared.cssEscape;
export const uuid = shared.uuid;
export const isWordLikeNeedle = shared.isWordLikeNeedle;
export const apiErrorKey = shared.apiErrorKey;

export const get = store.get;
export const set = store.set;
export const remove = store.remove;
export const normalizeSettings = store.normalizeSettings;
export const getSettings = store.getSettings;
export const saveSettings = store.saveSettings;
export const getPage = store.getPage;
export const savePage = store.savePage;
export const addAnnotation = store.addAnnotation;
export const upsertAnnotation = store.upsertAnnotation;
export const removeAnnotationFromPage = store.removeAnnotationFromPage;
export const removeOccurrence = store.removeOccurrence;
export const liveAnchors = store.liveAnchors;
export const anchorKey = store.anchorKey;
export const getThread = store.getThread;
export const setThread = store.setThread;
export const appendThreadMessage = store.appendThreadMessage;
export const pruneIfTooLarge = store.pruneIfTooLarge;
export const clearPage = store.clearPage;
export const clearAll = store.clearAll;
export const exportAll = store.exportAll;
export const importAll = store.importAll;
export const getIndexSummary = store.getIndexSummary;
export const sanitizePage = store.sanitizePage;
export const sanitizeThread = store.sanitizeThread;
