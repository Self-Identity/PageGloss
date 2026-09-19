/*
 * PageGloss - ESM smoke test.
 *
 * Runs the probe in a child node process so the real ES module loader can be
 * used (it cannot be enabled mid-process). This is the test that reproduces the
 * reported Chrome failures:
 *   "The requested module '../shared/...' does not provide an export named ..."
 *   "Service worker registration failed. Status code: 15"
 *
 * Coverage:
 *   - imports.classic-as-module.mjs : a named import of a classic script
 *   - imports.missing-export.mjs    : a named import that does not exist
 *   - imports.ok.mjs                 : the real service worker entry point
 *
 * Run with: node tests/esm.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const FIXTURES = path.join(__dirname, 'fixtures');
// The child process runs with cwd = repository root, so entry points are passed
// as plain relative paths. Absolute Windows paths would be read as the "F:" URL
// scheme by Node, and file:// URLs are not accepted as script arguments either.
const PROBE = 'tests/esm-smoke.probe.mjs';
const LOADER = './tests/helpers/classic-guard-loader.mjs';
const CHROME_FLAGS = ['--no-warnings', '--experimental-loader', LOADER];

function runNode(args) {
  // stdio is inherited on purpose: piped stdio needs OS pipes, which some
  // sandboxes deny for child processes (spawnSync EPERM). The probe therefore
  // writes its JSON report to a file and prints to this process's own console.
  return spawnSync(process.execPath, args, {
    cwd: ROOT,
    stdio: 'inherit',
    timeout: 60000
  });
}

/** Run the probe and read its JSON report (via file, since piped stdio may be blocked). */
function runProbe(entry) {
  const reportPath = path.join(ROOT, 'build', 'esm-report.json');
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  try { fs.unlinkSync(reportPath); } catch (err) { /* not there yet */ }

  const result = runNode([...CHROME_FLAGS, PROBE, '--entry', entry, '--out', 'build/esm-report.json']);
  let payload = null;
  if (fs.existsSync(reportPath)) {
    try {
      payload = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    } catch (err) {
      payload = null;
    }
  }
  return {
    status: result.status,
    error: result.error,
    payload: payload
  };
}

/** Run a fixture with inherited stdio so Node's own error report is visible. */
function runFixture(file) {
  return runNode([...CHROME_FLAGS, PROBE, '--fixture', file]);
}

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, error: err && err.stack ? err.stack : String(err) });
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'assertion failed');
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error((message || 'values differ') + ': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
  }
}

function ensureFixtures() {
  fs.mkdirSync(FIXTURES, { recursive: true });
  // The exact mistake from the bug report: a named import of a classic script.
  fs.writeFileSync(path.join(FIXTURES, 'imports.classic-as-module.mjs'), [
    '// Fixture: reproduces the reported Chrome error.',
    "import { DEFAULT_SYSTEM_PROMPT } from '../../src/shared/messages.js';",
    'export default DEFAULT_SYSTEM_PROMPT;',
    ''
  ].join('\n'));

  // A named import that simply does not exist in a real module.
  fs.writeFileSync(path.join(FIXTURES, 'imports.missing-export.mjs'), [
    '// Fixture: named import that the target module does not export.',
    "import { notARealExport } from '../../src/shared/shared.mjs';",
    'export default notARealExport;',
    ''
  ].join('\n'));

  // The real entry point, imported exactly as Chrome does.
  fs.writeFileSync(path.join(FIXTURES, 'imports.ok.mjs'), [
    '// Fixture: the real service worker entry point.',
    "import '../../src/background/service-worker.js';",
    ''
  ].join('\n'));
}

function main() {
  ensureFixtures();

  test('the real service worker loads as an ES module and registers its listeners', () => {
    const result = runProbe('src/background/service-worker.js');
    assertEqual(result.error, undefined, 'the probe process must start: ' + (result.error && result.error.message));
    assert(result.payload, 'the probe produced no JSON report');
    assert(result.payload.ok, 'service worker import failed: ' + (result.payload.error || ''));
    const expected = [
      'onInstalled',
      'onStartup',
      'storage.onChanged',
      'contextMenus.onShown',
      'contextMenus.onClicked',
      'tabs.onUpdated',
      'commands.onCommand',
      'onConnect',
      'onMessage'
    ];
    expected.forEach((name) => {
      assert(result.payload.listeners.includes(name), `missing listener: ${name}`);
    });
    assertEqual(result.payload.badListeners.join(','), '', 'every listener is a function');
  });

  test('fixture: importing a classic script as a module is rejected', () => {
    const result = runFixture('tests/fixtures/imports.classic-as-module.mjs');
    assert(result.status !== 0, 'the classic-script import must fail');
  });

  test('fixture: a missing named export is rejected', () => {
    const result = runFixture('tests/fixtures/imports.missing-export.mjs');
    assert(result.status !== 0, 'the missing export must fail');
  });

  test('every classic script is loadable in order by the content script stack', () => {
    const files = [
      'src/shared/messages.js',
      'src/shared/i18n.js',
      'src/shared/storage.js',
      'src/content/matcher.js'
    ];
    files.forEach((file) => {
      const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
      assert(!/^\s*(import|export)\s/m.test(source), file + ' must stay a classic script');
      assert(/globalThis\.PageGloss|window\.PageGloss/.test(source), file + ' must publish a PageGloss global');
    });
  });

  const failed = results.filter((item) => !item.ok);
  results.forEach((item) => {
    console.log('[' + (item.ok ? 'PASS' : 'FAIL') + '] ' + item.name);
    if (!item.ok) console.log('       ' + item.error);
  });
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' ESM smoke tests passed');
  if (failed.length) process.exitCode = 1;
}

main();
