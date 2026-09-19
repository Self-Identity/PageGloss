/*
 * PageGloss - Node module loader hooks used by the ESM smoke test.
 *
 * Purpose: load the real service worker module exactly like Chrome would, and
 * fail loudly when a consumer imports a classic script with named bindings. That
 * is the mistake that makes Chrome report
 *   "does not provide an export named ..." + "Service worker registration failed"
 *
 * Rules:
 *   - a classic script may only be imported by src/shared/shared.mjs
 *   - src/shared/*.js may only be imported by src/shared/shared.mjs
 *
 * Usage:
 *   node --experimental-loader ./tests/helpers/classic-guard-loader.mjs <entry>
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Files injected as classic scripts by the manifest: they publish globals and
// provide no ES module exports.
const CLASSIC_FILES = new Set([
  'messages.js',
  'storage.js',
  'i18n.js',
  'ui.js',
  'matcher.js',
  'card.js',
  'main.js'
]);

const WRAPPER = 'shared.mjs';

/** resolved child URL -> specifier used to import it. */
const specifiers = new Map();
/** specifier -> importing module URL (recorded by the resolve hook). */
const importers = new Map();

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  specifiers.set(resolved.url, specifier);
  if (context && context.parentURL) importers.set(specifier, context.parentURL);
  return resolved;
}

function importerBase(url) {
  const actual = importers.get(specifiers.get(url) || '');
  if (!actual) return 'an entry point';
  return path.basename(fileURLToPath(actual));
}

export async function load(url, context, nextLoad) {
  if (!url.startsWith('file:')) return nextLoad(url, context);

  const file = fileURLToPath(url);
  const base = path.basename(file);
  const normalized = file.split(path.sep).join('/');
  const from = importerBase(url);

  if (CLASSIC_FILES.has(base)) {
    if (from !== WRAPPER) {
      throw fail(
        'ERR_CLASSIC_AS_MODULE',
        `classic script imported with bindings by ${from}: ${base} (${file})`
      );
    }
  } else if (/src\/shared\//.test(normalized) && path.extname(file) !== '.mjs' && base !== WRAPPER) {
    throw fail(
      'ERR_SHARED_CLASSIC_IMPORT',
      `src/shared/*.js is classic-only, import shared.mjs instead: ${file}`
    );
  }

  return nextLoad(url, context);
}
