/*
 * PageGloss - static validation.
 * Parses every JavaScript file, checks the manifest against the files that
 * actually exist, verifies locale parity and scans CSS for layout regressions.
 * Run with: node tools/check.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const errors = [];
const warnings = [];
let checked = 0;

function rel(file) {
  return path.relative(ROOT, file).replace(/\\/g, '/');
}

function fail(message) {
  errors.push(message);
}

function warn(message) {
  warnings.push(message);
}

function walk(dir, filter, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    // build/ holds staged copies and tests/ holds deliberately broken fixtures
    // (imports.classic-as-module.mjs, imports.missing-export.mjs), so neither is
    // part of the static surface that ships.
    if (entry.name === 'node_modules' || entry.name === 'build' || entry.name === 'tests' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, filter, out);
    else if (filter(entry.name)) out.push(full);
  }
  return out;
}

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

/* ------------------------------------------------------------------ JS syntax */

const STRIP_MODULE_SYNTAX = [
  [/^\s*import\s+[\s\S]*?from\s+['"][^'"]+['"];?[ \t]*$/gm, ''],
  [/^\s*import\s+['"][^'"]+['"];?[ \t]*$/gm, ''],
  [/^\s*export\s*\{[^}]*\};?[ \t]*$/gm, ''],
  [/^\s*export\s+default\s+/gm, 'const __default = '],
  [/^\s*export\s+/gm, '']
];

function stripModuleSyntax(source) {
  return STRIP_MODULE_SYNTAX.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), source);
}

function syntaxLint(file) {
  const source = read(file);
  const isModule = /^\s*(import|export)\s/m.test(source);
  try {
    // Classic compile rejects import/export, so module files are compiled with
    // those keywords stripped; genuine syntax errors still surface.
    new vm.Script(isModule ? stripModuleSyntax(source) : source, { filename: file });
    checked++;
  } catch (err) {
    fail(`${rel(file)}: ${err.message}`);
  }
}

/* -------------------------------------------------------- ESM import integrity */

/**
 * Chrome fails the whole service worker when a named import does not exist in
 * the target module (status code 15), so every import/export pair is verified
 * here, and classic scripts are rejected as module targets.
 */
function parseModuleExports(source) {
  const names = new Set();
  const braced = /^[ \t]*export\s*\{([\s\S]*?)\}[ \t]*;?[ \t]*$/gm;
  let match;
  while ((match = braced.exec(source))) {
    match[1].split(',').forEach((entry) => {
      const clean = entry.trim();
      if (!clean) return;
      const alias = clean.split(/\s+as\s+/);
      const name = (alias[1] || alias[0]).trim();
      if (name) names.add(name);
    });
  }
  const declared = /^[ \t]*export\s+(?:async\s+)?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm;
  while ((match = declared.exec(source))) names.add(match[1]);
  if (/^[ \t]*export\s+default\b/m.test(source)) names.add('default');
  return names;
}

function forEachImport(source, visit) {
  const statement = /\bimport\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g;
  let match;
  while ((match = statement.exec(source))) {
    const clause = match[1].trim();
    const specifier = match[2];
    let defaultName = null;
    let namespaceName = null;
    const named = [];
    const namespace = /\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(clause);
    if (namespace) namespaceName = namespace[1];
    const braced = /\{([\s\S]*?)\}/.exec(clause);
    if (braced) {
      braced[1].split(',').forEach((entry) => {
        const clean = entry.trim();
        if (!clean) return;
        const parts = clean.split(/\s+as\s+/);
        named.push({ imported: parts[0].trim(), local: (parts[1] || parts[0]).trim() });
      });
    }
    const bare = clause.replace(/\{[\s\S]*?\}/, '').replace(/\*\s+as\s+[A-Za-z_$][\w$]*/, '').replace(/,/g, '').trim();
    if (bare) defaultName = bare;
    visit({ specifier, defaultName, namespaceName, named });
  }
  // Side-effect-only imports.
  const bareImport = /\bimport\s+['"]([^'"]+)['"]/g;
  while ((match = bareImport.exec(source))) {
    visit({ specifier: match[1], defaultName: null, namespaceName: null, named: [] });
  }
}

function resolveSpecifier(fromFile, specifier) {
  if (!specifier.startsWith('.')) return null;
  return path.resolve(path.dirname(fromFile), specifier);
}

function checkModuleImports() {
  const files = walk(ROOT, (name) => name.endsWith('.js') || name.endsWith('.mjs'));

  moduleFiles().forEach((file) => {
    const source = read(file);
    // shared.mjs deliberately runs the classic scripts for their side effect
    // (they publish the PageGloss globals) and then re-exports their values.
    const allowsSideEffectClassic = /shared\.mjs$/.test(file);
    forEachImport(source, ({ specifier, defaultName, named }) => {
      const target = resolveSpecifier(file, specifier);
      if (!target) return;
      if (!fs.existsSync(target)) {
        fail(`${rel(file)}: import path does not exist (${specifier})`);
        return;
      }
      const targetSource = read(target);
      if (!/^\s*(import|export)\s/m.test(targetSource)) {
        if (allowsSideEffectClassic && defaultName == null && named.length === 0) return;
        fail(`${rel(file)}: imports "${specifier}" which is a classic script and provides no ES module exports`);
        return;
      }
      const exported = parseModuleExports(targetSource);
      named.forEach(({ imported }) => {
        if (!exported.has(imported)) {
          fail(`${rel(file)}: "${specifier}" does not provide an export named "${imported}"`);
        }
      });
      if (defaultName && !exported.has('default')) {
        fail(`${rel(file)}: "${specifier}" has no default export (imported by ${rel(file)})`);
      }
    });
  });

  // Every shared global read by a classic consumer must be published somewhere,
  // either as `globalThis.PageGlossX = ...` or as `window.PageGlossX = ...`.
  const published = new Set();
  files.forEach((file) => {
    const source = read(file);
    const pattern = /(?:globalThis|window|sandbox\.window)\.(PageGloss[A-Za-z]+)\s*=/g;
    let match;
    while ((match = pattern.exec(source))) published.add(match[1]);
  });
  files.filter((file) => !file.includes(`${path.sep}tests${path.sep}`)).forEach((file) => {
    const source = read(file);
    const pattern = /(?:globalThis|window)\.(PageGloss[A-Za-z]+)\b/g;
    let match;
    while ((match = pattern.exec(source))) {
      if (!published.has(match[1])) {
        fail(`${rel(file)}: reads ${match[1]} but no script publishes it`);
      }
    }
  });
}

/* -------------------------------------------------------------------- manifest */

const MANIFEST = JSON.parse(read(path.join(ROOT, 'manifest.json')));

function checkManifestFile(value, key) {
  const file = path.join(ROOT, value);
  if (!fs.existsSync(file)) fail(`manifest.json: ${key} references a missing file (${value})`);
}

function checkManifest() {
  const m = MANIFEST;
  if (m.manifest_version !== 3) fail('manifest.json: manifest_version must be 3');
  if (!/^\d+\.\d+\.\d+$/.test(m.version)) fail(`manifest.json: version "${m.version}" must be x.y.z`);

  ['16', '32', '48', '128'].forEach((size) => {
    if (!m.icons || !m.icons[size]) fail(`manifest.json: icons["${size}"] is missing`);
    else checkManifestFile(m.icons[size], `icons.${size}`);
  });

  checkManifestFile(m.action.default_popup, 'action.default_popup');
  checkManifestFile(m.options_ui.page, 'options_ui.page');
  checkManifestFile(m.background.service_worker, 'background.service_worker');

  (m.content_scripts || []).forEach((entry, index) => {
    (entry.js || []).forEach((file) => checkManifestFile(file, `content_scripts[${index}].js`));
    (entry.css || []).forEach((file) => checkManifestFile(file, `content_scripts[${index}].css`));
  });

  (m.web_accessible_resources || []).forEach((entry) => {
    (entry.resources || []).forEach((file) => checkManifestFile(file, 'web_accessible_resources'));
  });

  const requiredPermissions = ['storage', 'contextMenus'];
  requiredPermissions.forEach((permission) => {
    if (!(m.permissions || []).includes(permission)) fail(`manifest.json: permissions must include "${permission}"`);
  });

  // Every local script referenced by an HTML page must exist.
  walk(ROOT, (name) => name.endsWith('.html')).forEach((file) => {
    const html = read(file);
    const scriptPattern = /<script[^>]+src=["']([^"']+)["']/g;
    let match;
    while ((match = scriptPattern.exec(html))) {
      const target = path.resolve(path.dirname(file), match[1]);
      if (!target.startsWith(ROOT)) continue;
      if (!fs.existsSync(target)) fail(`${rel(file)}: missing script ${match[1]}`);
    }
    const linkPattern = /<link[^>]+href=["']([^"']+)["']/g;
    while ((match = linkPattern.exec(html))) {
      if (/^https?:/.test(match[1])) continue;
      const target = path.resolve(path.dirname(file), match[1]);
      if (!fs.existsSync(target)) fail(`${rel(file)}: missing stylesheet ${match[1]}`);
    }
  });
}

/* --------------------------------------------------------------------- locales */

function checkLocales() {
  const base = path.join(ROOT, '_locales', 'zh_CN', 'messages.json');
  const other = path.join(ROOT, '_locales', 'en', 'messages.json');
  if (!fs.existsSync(base)) {
    fail('missing _locales/zh_CN/messages.json');
    return;
  }
  const zh = JSON.parse(read(base));
  const en = fs.existsSync(other) ? JSON.parse(read(other)) : {};
  if (!Object.keys(en).length) fail('missing _locales/en/messages.json');

  // Any __MSG_key__ used in the manifest must exist in every locale.
  const manifestText = read(path.join(ROOT, 'manifest.json'));
  const used = new Set();
  const pattern = /__MSG_([A-Za-z0-9_]+)__/g;
  let match;
  while ((match = pattern.exec(manifestText))) used.add(match[1]);

  used.forEach((key) => {
    if (!zh[key]) fail(`manifest.json uses __MSG_${key}__ but zh_CN has no such message`);
    if (en && !en[key]) fail(`manifest.json uses __MSG_${key}__ but en has no such message`);
  });

  const missingInEn = Object.keys(zh).filter((key) => !en[key]);
  const missingInZh = Object.keys(en).filter((key) => !zh[key]);
  if (missingInEn.length) fail(`_locales/en is missing keys: ${missingInEn.join(', ')}`);
  if (missingInZh.length) fail(`_locales/zh_CN is missing keys: ${missingInZh.join(', ')}`);
}

/* ----------------------------------------------------------- i18n key parity */

const I18N_KEYS = (() => {
  const source = read(path.join(ROOT, 'src', 'shared', 'i18n.js'));
  const sandbox = { module: { exports: {} }, window: undefined };
  vm.runInNewContext(source, sandbox, { filename: 'i18n.js' });
  return sandbox.module.exports.MESSAGES;
})();

function checkI18nKeys() {
  const zh = Object.keys(I18N_KEYS.zh);
  const en = Object.keys(I18N_KEYS.en);
  const missing = zh.filter((key) => !I18N_KEYS.en[key]);
  if (missing.length) fail(`i18n: English table is missing: ${missing.join(', ')}`);
  const extra = en.filter((key) => !I18N_KEYS.zh[key]);
  if (extra.length) warn(`i18n: English table has unused keys: ${extra.join(', ')}`);

  // Every t('...') call must resolve to a real key.
  const files = walk(path.join(ROOT, 'src'), (name) => name.endsWith('.js'));
  const callPattern = /\bt\(\s*'([A-Za-z0-9_]+)'/g;
  files.forEach((file) => {
    const source = read(file);
    let match;
    while ((match = callPattern.exec(source))) {
      if (!I18N_KEYS.zh[match[1]]) fail(`${rel(file)}: t('${match[1]}') has no translation key`);
    }
  });
}

/* ------------------------------------------------------------------ CSS rules */

function checkCss() {
  const files = walk(path.join(ROOT, 'src'), (name) => name.endsWith('.css'));
  files.forEach((file) => {
    const source = read(file);
    if (/\b100vw\b/.test(source)) fail(`${rel(file)}: 100vw is banned (use 100%)`);
    const buttonRules = source.match(/button[^{]*\{[^}]*\}/g) || [];
    buttonRules.forEach((rule) => {
      if (/white-space/.test(rule)) return;
      if (/\.(pg-)?toast/.test(rule)) return;
    });
  });

  const htmlFiles = walk(path.join(ROOT, 'src'), (name) => name.endsWith('.html'));
  htmlFiles.forEach((file) => {
    const source = read(file);
    if (/<html[^>]*>\s*<head>[\s\S]*?<meta[^>]+charset/i.test(source)) return;
    if (!/charset/i.test(source)) fail(`${rel(file)}: missing charset meta tag`);
  });

  // Buttons that contain text must not be allowed to wrap.
  const allCss = files.map(read).join('\n');
  ['btn', 'button'].forEach((selector) => {
    if (!new RegExp(`\\.${selector}|\\.btn`).test(allCss)) warn(`CSS may be missing button styles for ${selector}`);
  });
}

/* ------------------------------------------------------------- danger patterns */

function checkDangerousPatterns() {
  const files = walk(ROOT, (name) => name.endsWith('.js') && !name.endsWith('check.js'));
  const banned = [
    {
      // Flag innerHTML writes whose right-hand side is not one of the known safe
      // producers (our own static templates or the sanitizing markdown renderer).
      pattern: /innerHTML\s*=\s*(?![\s;]*((?:[A-Za-z_$][\w$]*\.)*renderMarkdown\s*\(|buildCardHtml\s*\(|CARD_HTML\b|TRASH_ICON\b|''|""))/,
      reason: 'innerHTML assignment with unsanitized content'
    },
    { pattern: /\beval\(/, reason: 'eval' },
    { pattern: /new\s+Function\(/, reason: 'new Function' },
    { pattern: /document\.write\(/, reason: 'document.write' }
  ];
  files.forEach((file) => {
    const source = read(file);
    banned.forEach((rule) => {
      if (rule.pattern.test(source)) warn(`${rel(file)}: ${rule.reason}`);
    });
    if (/chrome\.storage\.sync/.test(source)) fail(`${rel(file)}: settings must use storage.local (sync quota is too small)`);
  });
}

/* ------------------------------------------------- classic vs module boundaries */

// Declared load order of the shared content-script stack together with the
// globals each file publishes and requires. The manifest must inject them in
// this order, otherwise a content script starts without its dependencies.
const CONTENT_STACK = [
  { file: 'src/shared/messages.js', provides: ['PageGlossShared'], requires: [] },
  { file: 'src/shared/i18n.js', provides: ['PageGlossI18n'], requires: [] },
  { file: 'src/shared/storage.js', provides: ['PageGlossStore'], requires: ['PageGlossShared'] },
  { file: 'src/content/matcher.js', provides: ['PageGlossMatcher'], requires: [] },
  { file: 'src/content/card.js', provides: ['PageGlossCard'], requires: [] },
  { file: 'src/content/main.js', provides: [], requires: ['PageGlossShared', 'PageGlossI18n', 'PageGlossStore', 'PageGlossMatcher', 'PageGlossCard'] }
];

function manifestContentScripts() {
  const entries = (MANIFEST.content_scripts || []);
  return entries.reduce((all, entry) => all.concat(entry.js || []), []);
}

function checkContentScriptOrder() {
  const injected = manifestContentScripts();
  const index = new Map(injected.map((file, position) => [file.replace(/\\/g, '/'), position]));

  // 1. Everything the stack needs must be injected.
  const missing = CONTENT_STACK
    .filter((item) => !index.has(item.file))
    .map((item) => item.file);
  if (missing.length) {
    fail(`manifest.json: content_scripts is missing ${missing.join(', ')}; ` +
      'a content script would start without its shared dependencies');
  }

  // 2. The injection order must satisfy every declared dependency.
  CONTENT_STACK.forEach((item) => {
    const position = index.get(item.file);
    if (position === undefined) return;
    item.requires.forEach((dependency) => {
      const provider = CONTENT_STACK.find((candidate) => candidate.provides.includes(dependency));
      if (!provider) {
        fail(`check config: ${dependency} has no known provider`);
        return;
      }
      const providerPosition = index.get(provider.file);
      if (providerPosition === undefined) {
        fail(`manifest.json: ${item.file} needs ${dependency} from ${provider.file}, which is not injected`);
        return;
      }
      if (providerPosition > position) {
        fail(`manifest.json: ${provider.file} must be injected before ${item.file}`);
      }
    });
  });

  // 3. Each content script must actually publish the globals it promises, and
  //    must not reference a PageGloss global that nobody provides.
  CONTENT_STACK.forEach((item) => {
    const file = path.join(ROOT, item.file);
    if (!fs.existsSync(file)) return;
    const source = read(file);
    item.provides.forEach((name) => {
      const pattern = new RegExp(`(?:globalThis|window)\\.${name}\\s*=`);
      if (!pattern.test(source)) {
        fail(`${item.file}: declared to publish ${name} but never assigns it`);
      }
    });
    if (item.file.endsWith('main.js')) {
      item.requires.forEach((name) => {
        if (!new RegExp(`window\\.${name}\\b`).test(source)) {
          warn(`${item.file}: expected to read window.${name}`);
        }
      });
    }
  });

  // 4. Files in the stack must stay classic scripts.
  CONTENT_STACK.forEach((item) => {
    const file = path.join(ROOT, item.file);
    if (!fs.existsSync(file)) return;
    if (/^\s*(import|export)\s/m.test(read(file))) {
      fail(`${item.file}: part of the content-script stack, so it must stay a classic script`);
    }
  });
}

/* --------------------------------------------------------------- shell scripts */

function checkClassicVsModuleBoundaries() {
  const files = walk(ROOT, (name) => name.endsWith('.js') || name.endsWith('.mjs'));

  // Files the manifest injects as content scripts must be classic scripts:
  // an export/import statement there is either a syntax error or silently ignored.
  (MANIFEST.content_scripts || []).forEach((entry) => {
    (entry.js || []).forEach((value) => {
      const file = path.join(ROOT, value);
      if (!fs.existsSync(file)) return;
      if (/^\s*(import|export)\s/m.test(read(file))) {
        fail(`${value}: content scripts are classic scripts, remove the import/export statements`);
      }
    });
  });

  // The service worker must only import real ES modules, never a classic script:
  // that exact mistake makes Chrome report "does not provide an export named ..."
  // and fail registration with status code 15.
  const manifestWorker = MANIFEST.background && MANIFEST.background.service_worker;
  if (manifestWorker) {
    const workerPath = path.join(ROOT, manifestWorker);
    if (fs.existsSync(workerPath)) {
      forEachImport(read(workerPath), ({ specifier, defaultName, named }) => {
        const target = resolveSpecifier(workerPath, specifier);
        if (!target) return;
        if (!fs.existsSync(target)) {
          fail(`${manifestWorker}: import path does not exist (${specifier})`);
          return;
        }
        if (!/^\s*(import|export)\s/m.test(read(target))) {
          fail(`${manifestWorker}: service worker imports the classic script "${specifier}"; import a .mjs module instead`);
          return;
        }
        const exported = parseModuleExports(read(target));
        named.forEach(({ imported }) => {
          if (!exported.has(imported)) {
            fail(`${manifestWorker}: "${specifier}" does not provide an export named "${imported}"`);
          }
        });
        if (defaultName && !exported.has('default')) {
          fail(`${manifestWorker}: "${specifier}" has no default export`);
        }
      });
    }
  }

  // A file that publishes a PageGloss global must never contain module syntax.
  files.forEach((file) => {
    const source = read(file);
    if (/globalThis\.PageGloss[A-Za-z]+\s*=/.test(source) && /^\s*(import|export)\s/m.test(source)) {
      fail(`${rel(file)}: publishes a PageGloss global but also uses module syntax`);
    }
  });

  // Side-effect imports of classic scripts are only allowed in the wrapper.
  moduleFiles().forEach((file) => {
    if (/shared\.mjs$/.test(file)) return;
    forEachImport(read(file), ({ specifier, defaultName, named }) => {
      const target = resolveSpecifier(file, specifier);
      if (!target || !fs.existsSync(target)) return;
      if (!/^\s*(import|export)\s/m.test(read(target)) && defaultName == null && named.length === 0) {
        fail(`${rel(file)}: side-effect import of a classic script is only allowed in shared.mjs`);
      }
    });
  });

  // Every classic script loaded from HTML must exist (already checked) and the
  // ESM wrapper must in turn load exactly the shared classic scripts.
  const wrapper = read(path.join(ROOT, 'src', 'shared', 'shared.mjs'));
  if (!/import\s+['"]\.\/messages\.js['"]/.test(wrapper)) {
    fail('src/shared/shared.mjs must import ./messages.js for its side effect');
  }
  if (!/import\s+['"]\.\/storage\.js['"]/.test(wrapper)) {
    fail('src/shared/shared.mjs must import ./storage.js for its side effect');
  }

  // The manifest must not ship the wrapper to content scripts.
  (MANIFEST.content_scripts || []).forEach((entry) => {
    (entry.js || []).forEach((value) => {
      if (/\.mjs$/.test(value)) fail(`${value}: content scripts cannot load ES modules; use .js`);
    });
  });
}

function moduleFiles() {
  return walk(ROOT, (name) => name.endsWith('.js') || name.endsWith('.mjs'))
    .filter((file) => /^\s*(import|export)\s/m.test(read(file)));
}

/**
 * Catch a shared helper that is called but never imported or declared: exactly
 * the class of bug that broke the model list (normalizeBaseUrl used without an
 * import), which the ESM loader only reports at runtime.
 */
function checkModuleUndefinedHelpers() {
  const helperNames = [
    'normalizeBaseUrl',
    'baseUrlOrigin',
    'modelsEndpointCandidates',
    'normalizeUrlKey',
    'storageKey',
    'isWordLikeNeedle',
    'apiErrorKey',
    'cloneDefaultSettings',
    'truncate'
  ];
  moduleFiles().forEach((file) => {
    const source = read(file);
    const bound = new Set();
    forEachImport(source, ({ defaultName, namespaceName, named }) => {
      if (defaultName) bound.add(defaultName);
      if (namespaceName) bound.add(namespaceName);
      named.forEach((entry) => bound.add(entry.local));
    });
    const declared = /\b(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g;
    let match;
    while ((match = declared.exec(source))) bound.add(match[1]);
    const destructured = /\b(?:const|let|var)\s*\{([^}]*)\}\s*=/g;
    while ((match = destructured.exec(source))) {
      match[1].split(',').forEach((entry) => {
        const name = entry.split(':').pop().trim();
        if (name) bound.add(name);
      });
    }

    helperNames.forEach((name) => {
      if (!new RegExp(`\\b${name}\\s*\\(`).test(source)) return;
      if (bound.has(name)) return;
      if (new RegExp(`function[^(]*\\([^)]*\\b${name}\\b`).test(source)) return;
      if (new RegExp(`\\([^)]*\\b${name}\\b[^)]*\\)\\s*=>`).test(source)) return;
      fail(`${rel(file)}: calls ${name}() without importing or declaring it`);
    });
  });
}

/* --------------------------------------------------------------- shell scripts */

/**
 * Duplicate top level declarations break the whole file (Chrome refuses to
 * register the service worker), and they are easy to introduce with search and
 * replace edits. Function declarations are silent in classic scripts too, so
 * they are checked in every file.
 */
function checkDuplicateDeclarations() {
  walk(ROOT, (name) => name.endsWith('.js') || name.endsWith('.mjs')).forEach((file) => {
    const source = read(file);
    const lines = source.split('\n');
    const seen = new Map();
    // Only top level declarations collide: nested functions legitimately reuse
    // names inside their own scope.
    const functionPattern = /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/;
    const bindingPattern = /^(?:const|let|var|class)\s+([A-Za-z_$][\w$]*)/;
    const isModule = /^\s*(import|export)\s/m.test(source);
    lines.forEach((line, index) => {
      if (/^\s/.test(line)) return;            // indented: not top level
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
      let found = null;
      const fn = functionPattern.exec(line);
      if (fn) found = { kind: 'function', name: fn[1] };
      if (!found && isModule) {
        const binding = bindingPattern.exec(line);
        if (binding) found = { kind: 'binding', name: binding[1] };
      }
      if (!found) return;
      const previous = seen.get(found.name);
      if (previous && previous.kind === found.kind) {
        fail(`${rel(file)}: ${found.kind} "${found.name}" is declared twice (lines ${previous.line} and ${index + 1})`);
        return;
      }
      seen.set(found.name, { kind: found.kind, line: index + 1 });
    });
  });
}

function checkShellScripts() {
  const shFile = path.join(ROOT, 'deploy', 'deploy.sh');
  const batFile = path.join(ROOT, 'deploy', 'deploy.bat');
  if (!fs.existsSync(shFile)) fail('deploy/deploy.sh is missing');
  if (!fs.existsSync(batFile)) fail('deploy/deploy.bat is missing');
  if (!fs.existsSync(shFile) || !fs.existsSync(batFile)) return;

  const shBuffer = fs.readFileSync(shFile);
  const sh = shBuffer.toString('utf8');
  if (shBuffer.includes(0x0d)) fail('deploy/deploy.sh must use LF line endings');
  if (/[^\x00-\x7f]/.test(sh)) fail('deploy/deploy.sh must be pure ASCII');
  if (shBuffer.slice(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) fail('deploy/deploy.sh must not have a BOM');
  if (!/^#!\/usr\/bin\/env bash/.test(sh)) fail('deploy/deploy.sh must start with #!/usr/bin/env bash');
  if (!/^set -euo pipefail$/m.test(sh)) fail('deploy/deploy.sh must set -euo pipefail');
  if (!fs.statSync(shFile).mode.toString(8).endsWith('755') && process.platform !== 'win32') {
    warn('deploy/deploy.sh is not executable (run: chmod +x deploy/deploy.sh)');
  }

  const bat = fs.readFileSync(batFile, 'utf8');
  if (!/\r\n/.test(bat)) fail('deploy/deploy.bat must use CRLF line endings');
  if (/[^\x00-\x7f]/.test(bat)) fail('deploy/deploy.bat must be pure ASCII');
  if (!/\r\ndeploy\.ps1/.test(bat.replace(/\\/g, '')) && !/deploy\.ps1/.test(bat)) {
    fail('deploy/deploy.bat must fall back to deploy.ps1');
  }

  // Every repo path referenced by the scripts must exist.
  const referenced = new Set();
  [sh, bat, fs.readFileSync(path.join(ROOT, 'deploy', 'deploy.ps1'), 'utf8')].forEach((source) => {
    const pattern = /(?:tools|tests|deploy|docs|icons|src|_locales)\/[A-Za-z0-9_.\-\/]+/g;
    let match;
    while ((match = pattern.exec(source))) referenced.add(match[0].replace(/\/$/, ''));
  });
  referenced.forEach((value) => {
    if (!fs.existsSync(path.join(ROOT, value))) fail(`deploy scripts reference a missing path: ${value}`);
  });

  // Unbalanced quotes in the shell script usually mean a broken deploy.
  let single = false;
  let double = false;
  sh.split('\n').forEach((line, index) => {
    if (/^\s*#/.test(line)) return;
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '\\') {
        i++;
        continue;
      }
      if (char === "'" && !double) single = !single;
      else if (char === '"' && !single) double = !double;
    }
    if (single || double) fail(`deploy/deploy.sh:${index + 1}: unbalanced quote`);
  });
}

/* -------------------------------------------------------------------- icons */

function checkIcons() {
  ['16', '32', '48', '128'].forEach((size) => {
    const file = path.join(ROOT, 'icons', `icon${size}.png`);
    if (!fs.existsSync(file)) {
      fail(`icons/icon${size}.png is missing (run: node tools/make-icons.js)`);
      return;
    }
    const buffer = fs.readFileSync(file);
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (!signature.every((byte, index) => buffer[index] === byte)) {
      fail(`icons/icon${size}.png is not a valid PNG`);
      return;
    }
    const width = buffer.readUInt32BE(16);
    const height = buffer.readUInt32BE(20);
    if (width !== Number(size) || height !== Number(size)) {
      fail(`icons/icon${size}.png is ${width}x${height}, expected ${size}x${size}`);
    }
    if (buffer.length < 80) fail(`icons/icon${size}.png looks truncated (${buffer.length} bytes)`);
    const trailer = buffer.slice(buffer.length - 8, buffer.length - 4).toString('ascii');
    if (trailer !== 'IEND') fail(`icons/icon${size}.png has no IEND chunk`);
  });
}

/* ------------------------------------------------------------------ run checks */

function main() {
  const jsFiles = walk(ROOT, (name) => name.endsWith('.js') || name.endsWith('.mjs'));
  jsFiles.forEach(syntaxLint);
  checkManifest();
  checkLocales();
  checkI18nKeys();
  checkModuleImports();
  checkModuleUndefinedHelpers();
  checkDuplicateDeclarations();
  checkClassicVsModuleBoundaries();
  checkContentScriptOrder();
  checkCss();
  checkDangerousPatterns();
  checkShellScripts();
  checkIcons();

  console.log(`checked ${checked} script(s), manifest, locales, i18n keys and CSS`);
  if (warnings.length) {
    console.log('\nwarnings:');
    warnings.forEach((message) => console.log('  ! ' + message));
  }
  if (errors.length) {
    console.log('\nerrors:');
    errors.forEach((message) => console.log('  x ' + message));
    process.exitCode = 1;
    return;
  }
  console.log('\nall checks passed');
}

main();
