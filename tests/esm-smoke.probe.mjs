/*
 * PageGloss - in-process probe for the ESM smoke test.
 *
 * Runs with Node's real ES module loader (driven by tests/esm.test.js), loads
 * src/background/service-worker.js exactly like Chrome does, and reports the
 * registered listeners as JSON on stdout. In fixture mode it loads whatever the
 * first argument points at and lets any import error escape (non-zero exit).
 */
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const fixtureMode = argv.includes('--fixture');
const entryFlag = argv.indexOf('--entry');
const entry = entryFlag >= 0 ? argv[entryFlag + 1] : null;
const outFlag = argv.indexOf('--out');
const outFile = outFlag >= 0 ? argv[outFlag + 1] : null;

/** Report to stdout and, when asked, to a file (some hosts block piped stdio). */
function report(payload) {
  const json = JSON.stringify(payload);
  if (outFile) {
    try {
      fs.writeFileSync(outFile, json, 'utf8');
    } catch (err) {
      // Fall through to stdout only.
    }
  }
  console.log(json);
}

/** Resolve an entry given as a repo-relative or absolute path into a file URL. */
function entryUrl(target) {
  const absolute = path.isAbsolute(target) ? target : path.resolve(process.cwd(), target);
  return pathToFileURL(absolute).href;
}

if (fixtureMode) {
  await import(entryUrl(entry || 'src/background/service-worker.js'));
  process.exit(0);
}

const listeners = [];
const record = (name) => (fn) => listeners.push({ name, type: typeof fn });

globalThis.chrome = {
  runtime: {
    lastError: null,
    onInstalled: { addListener: record('onInstalled') },
    onStartup: { addListener: record('onStartup') },
    onMessage: { addListener: record('onMessage') },
    onConnect: { addListener: record('onConnect') },
    getURL: (value) => 'chrome-extension://probe/' + value,
    getManifest: () => ({ version: '1.0.0' })
  },
  i18n: { getUILanguage: () => 'zh-CN' },
  contextMenus: {
    removeAll: (callback) => callback(),
    create: (options) => options.id,
    update: () => {},
    refresh: () => {},
    onClicked: { addListener: record('contextMenus.onClicked') },
    onShown: { addListener: record('contextMenus.onShown') }
  },
  tabs: {
    query: async () => [],
    sendMessage: () => {},
    onUpdated: { addListener: record('tabs.onUpdated') }
  },
  permissions: {
    contains: async () => true,
    request: async () => true
  },
  commands: { onCommand: { addListener: record('commands.onCommand') } },
  storage: {
    local: {
      get: (keys, callback) => callback({}),
      set: (items, callback) => { if (callback) callback(); },
      remove: (keys, callback) => { if (callback) callback(); }
    },
    onChanged: { addListener: record('storage.onChanged') }
  }
};

const url = entryUrl('src/background/service-worker.js');
try {
  await import(url);
} catch (err) {
  report({ ok: false, error: String(err && err.stack ? err.stack : err), url: url });
  process.exit(0);
}

// Give the top-level context menu rebuild a tick to settle.
await new Promise((resolve) => setTimeout(resolve, 30));

report({
  ok: true,
  listeners: listeners.map((entry) => entry.name),
  badListeners: listeners.filter((entry) => entry.type !== 'function').map((entry) => entry.name)
});
