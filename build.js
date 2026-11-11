#!/usr/bin/env node
// Inlines src/ into two outputs:
//   dist/lightplan.artifact.html  fragment for the claude.ai Artifact viewer (no doctype/html/head/body)
//   dist/lightplan.html           standalone full document (open directly in any browser)
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = __dirname;
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const SCRIPTS = [
  'src/core/lp.js',
  'src/core/geometry.js', 'src/core/camera.js', 'src/core/exif.js', 'src/core/suppliers.js', 'src/core/catalog.js',
  'src/core/measure.js', 'src/core/design.js', 'src/core/power.js', 'src/core/bom.js',
  'src/core/schema.js', 'src/core/plan.js', 'src/core/sample.js',
  'src/ui/persist.js', 'src/ui/store.js', 'src/ui/imagesource.js', 'src/ui/actions.js',
  'src/ui/preview.js', 'src/ui/viewport.js', 'src/ui/export.js', 'src/ui/panels.js', 'src/ui/app.js',
];

function fail(msg) { console.error('build failed: ' + msg); process.exit(1); }

const missing = SCRIPTS.filter((f) => !fs.existsSync(path.join(ROOT, f)));
if (missing.length) fail('missing source files:\n  ' + missing.join('\n  '));

let template = read('src/template.html');
const css = read('src/styles.css');
if (!template.includes('<!-- @@STYLES -->')) fail('template is missing <!-- @@STYLES -->');
if (!template.includes('<!-- @@SCRIPTS -->')) fail('template is missing <!-- @@SCRIPTS -->');
if (/<!doctype|<html[\s>]|<head[\s>]|<body[\s>]/i.test(template)) fail('template must not contain doctype/html/head/body tags');

const parts = [];
for (const f of SCRIPTS) {
  const src = read(f);
  if (/<\/script/i.test(src)) fail(f + ' contains the literal "</script" — split the string');
  if (/<!--/.test(src) && f.endsWith('.js')) {
    // "<!--" inside a script can confuse HTML parsing in legacy modes; warn only.
    console.warn('warning: ' + f + ' contains "<!--"');
  }
  parts.push('<script>\n/* ' + f + ' */\n' + src + '\n</script>');
}
parts.push("<script>\n(function(){function go(){LP.require('ui.app').start();}\nif(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',go);}else{go();}})();\n</script>");

if (/<\/style/i.test(css)) fail('styles.css contains "</style"');
const fragment = template
  .replace('<!-- @@STYLES -->', () => '<style>\n' + css + '\n</style>')
  .replace('<!-- @@SCRIPTS -->', () => parts.join('\n'));

// Standalone: same skeleton the artifact viewer wraps the fragment in.
const standalone = '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">' +
  '<style>:root{color-scheme:light;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}' +
  'body{margin:0;font:14px system-ui,sans-serif}img{max-width:100%}[hidden]{display:none!important}</style>' +
  '</head><body>\n' + fragment + '\n</body></html>\n';

fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'dist/lightplan.artifact.html'), fragment);
fs.writeFileSync(path.join(ROOT, 'dist/lightplan.html'), standalone);
const kb = (s) => (Buffer.byteLength(s) / 1024).toFixed(1) + ' KB';
console.log('built dist/lightplan.html (' + kb(standalone) + ') and dist/lightplan.artifact.html (' + kb(fragment) + ')');
