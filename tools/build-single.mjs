#!/usr/bin/env node
/**
 * Bundles the app into one self-contained `clipmind.html`: styles inline, every
 * module inline, icons and the manifest as data URIs. Nothing is fetched at
 * runtime, so the file works from a USB stick, an email attachment or any host
 * that can serve a single page.
 *
 *   node tools/build-single.mjs
 *
 * Each module keeps its own scope — it becomes an IIFE returning its exports —
 * so no two modules can clash over a name.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const dataUri = (p, type) => `data:${type};base64,${fs.readFileSync(path.join(ROOT, p)).toString('base64')}`;

// Dependency order: a module may only import ones listed before it.
const MODULES = ['store', 'media', 'audio', 'local-asr', 'md', 'transcribe', 'ai', 'prompts', 'app'];

const IMPORT_RE = /^import\s+(?:(\*\s+as\s+\w+)|(\{[^}]*\}))\s+from\s+['"]\.\/([\w-]+)\.js['"];?\s*$/;
const EXPORT_RE = /^export\s+(?=(?:async\s+)?(?:const|let|var|function|class)\b)/;
const EXPORT_NAME_RE = /^export\s+(?:async\s+)?(?:const|let|var|function|class)\s+(\w+)/;

function transform(name) {
  const source = read(`js/${name}.js`);
  const exports = [];
  const body = source.split('\n').map((line) => {
    const imported = line.match(IMPORT_RE);
    if (imported) {
      const [, namespace, named, from] = imported;
      if (!MODULES.includes(from)) throw new Error(`${name}.js imports unknown module ${from}`);
      if (MODULES.indexOf(from) >= MODULES.indexOf(name)) {
        throw new Error(`${name}.js imports ${from}.js, which is bundled later — reorder MODULES`);
      }
      return namespace
        ? `const ${namespace.replace(/^\*\s+as\s+/, '')} = MOD[${JSON.stringify(from)}];`
        : `const ${named.replace(/\bas\b/g, ':')} = MOD[${JSON.stringify(from)}];`;
    }
    if (/^\s*import\s/.test(line)) throw new Error(`${name}.js has an import this builder cannot inline: ${line}`);

    const named = line.match(EXPORT_NAME_RE);
    if (named) exports.push(named[1]);
    else if (/^export\b/.test(line)) throw new Error(`${name}.js has an export this builder cannot inline: ${line}`);
    return line.replace(EXPORT_RE, '');
  }).join('\n');

  return `MOD[${JSON.stringify(name)}] = (() => {\n${body}\nreturn { ${exports.join(', ')} };\n})();`;
}

const manifest = JSON.parse(read('manifest.webmanifest'));
manifest.icons = [
  { src: dataUri('icons/icon-192.png', 'image/png'), sizes: '192x192', type: 'image/png' },
  { src: dataUri('icons/icon-512.png', 'image/png'), sizes: '512x512', type: 'image/png' },
  { src: dataUri('icons/icon-maskable-512.png', 'image/png'), sizes: '512x512', type: 'image/png', purpose: 'maskable' },
];
// A page opened from disk has no base URL to resolve `./` against.
delete manifest.start_url;
delete manifest.scope;

let html = read('index.html');
html = html.replace('src="./icons/icon-192.png"', `src="${dataUri('icons/icon-192.png', 'image/png')}"`);

// Inserted with a replacer function, never a replacement string: file content
// contains `$$` (and `$&`), which a string replacement would eat.
function swap(haystack, needle, replacement) {
  if (!haystack.includes(needle)) throw new Error(`index.html no longer contains: ${needle}`);
  return haystack.replace(needle, () => replacement);
}

html = swap(html, '<link rel="manifest" href="./manifest.webmanifest" />',
  `<link rel="manifest" href="data:application/manifest+json;base64,${Buffer.from(JSON.stringify(manifest)).toString('base64')}" />`);
html = swap(html, '<link rel="apple-touch-icon" href="./icons/apple-touch-icon.png" />',
  `<link rel="apple-touch-icon" href="${dataUri('icons/apple-touch-icon.png', 'image/png')}" />`);
html = swap(html, '<link rel="icon" href="./icons/favicon-64.png" sizes="64x64" />',
  `<link rel="icon" href="${dataUri('icons/favicon-64.png', 'image/png')}" sizes="64x64" />`);
html = swap(html, '<link rel="stylesheet" href="./styles.css" />', `<style>\n${read('styles.css')}\n</style>`);
html = swap(html, '<script type="module" src="./js/app.js"></script>',
  ['<script>',
    'window.__CLIPMIND_SINGLE_FILE__ = true;',
    'const MOD = {};',
    ...MODULES.map(transform),
    '</script>'].join('\n'));

if (html.includes('src="./js/') || html.includes('href="./')) {
  throw new Error('something still points at a sibling file');
}

const out = path.join(ROOT, 'clipmind.html');
fs.writeFileSync(out, html);
console.log(`wrote clipmind.html — ${(fs.statSync(out).size / 1024).toFixed(0)} KB, ${MODULES.length} modules inlined`);
