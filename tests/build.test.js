// Checks the built artifact against the platform rules in docs/SPEC.md section 1.
const LP = require('./loader');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

test('build produces the fragment and standalone files and they follow the artifact rules', () => {
  execFileSync(process.execPath, [path.join(ROOT, 'build.js')], { cwd: ROOT, stdio: 'pipe' });
  const fragment = fs.readFileSync(path.join(ROOT, 'dist/lightplan.artifact.html'), 'utf8');
  const standalone = fs.readFileSync(path.join(ROOT, 'dist/lightplan.html'), 'utf8');

  // The viewer wraps the fragment itself, so it must not carry document tags.
  assert.doesNotMatch(fragment, /<!doctype|<html[\s>]|<head[\s>]|<body[\s>]/i);
  assert.match(standalone, /^<!doctype html>/i);

  // Strip comments so explanatory notes ("the viewer ignores window.print()") do not count as calls.
  const code = fragment.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
  // Native dialogs and print do nothing in the viewer; actions.confirm is the in-page dialog.
  const calls = code.match(/(^|[^.\w$])(alert|confirm|prompt)\s*\(|window\s*\.\s*(alert|confirm|prompt|print)\s*\(|\bprint\s*\(\s*\)/g) || [];
  assert.deepEqual(calls, [], 'native dialog or print calls: ' + calls.join(', '));

  // Only Google Fonts may be fetched. XML namespaces and the JSON Schema $schema id are identifiers, not requests.
  // Supplier links (SPEC section 8.3) are addresses a person opens, never fetched by the page: an https URL whose
  // host is one the supplier map uses is allowed, and every other external URL is still refused.
  const allowed = /^https:\/\/(fonts\.googleapis\.com|fonts\.gstatic\.com)(\/|$)|^http:\/\/www\.w3\.org\/|^https:\/\/json-schema\.org\//;
  const linkHosts = LP.require('suppliers').linkHosts();
  assert.ok(linkHosts.length > 0 && linkHosts.every((h) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(h)), 'supplier link hosts are plain host names');
  const isSupplierLink = (u) => {
    const m = /^https:\/\/([^/:?#]+)(\/|$)/.exec(u);
    return !!m && linkHosts.includes(m[1].toLowerCase());
  };
  const urls = (code.match(/https?:\/\/[^\s"'`)<>]+/g) || []).filter((u) => !allowed.test(u) && !isSupplierLink(u));
  assert.deepEqual(urls, [], 'unexpected external URLs: ' + urls.join(', '));
  // The supplier map is in the built file, and none of its links can end a script block early.
  assert.ok(fragment.includes('/* src/core/suppliers.js */'), 'the supplier map is built in before the catalog');
  assert.ok(fragment.indexOf('/* src/core/suppliers.js */') < fragment.indexOf('/* src/core/catalog.js */'));
  for (const l of LP.require('suppliers').allLinks()) assert.ok(!/<\/script/i.test(l.url), 'a supplier link contains a script end tag: ' + l.url);

  // Every storage access lives in ui.persist, which guards each one with try/catch.
  const scripts = fragment.split('<script>\n/* ').slice(1);
  for (const s of scripts) {
    const name = s.slice(0, s.indexOf(' */'));
    const body = s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
    // A property access or call on a storage object (mentions inside plain text are fine).
    if (/\b(localStorage|sessionStorage|indexedDB)\s*(\.|\[|\?\.)/.test(body)) assert.equal(name, 'src/ui/persist.js', name + ' touches browser storage directly');
  }
  assert.ok(LP, 'the core loader is available');
});
