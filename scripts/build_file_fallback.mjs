#!/usr/bin/env node
/**
 * 生成供 file:// 协议直接双击 index.html 时使用的零依赖回退包 (js/file-fallback.js)。
 * 在 http:// / https:// 下浏览器直接加载原生 ES Modules (js/app.js)，不加载此文件；
 * 在 file:// 下 Chromium 会因 CORS 拦截 ES Module 与本地 JSON fetch，此时由 index.html
 * 动态插入 <script src="js/file-fallback.js">，即可在本地双击直接完整运行地图与所有功能。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const ORDER = [
  'format.js',
  'adapter.js',
  'mock-adapter.js',
  'http-adapter.js',
  'basemap.js',
  'map.js',
  'panel.js',
  'recommend.js',
  'chat.js',
  'app.js',
];

function transformModule(filename, code) {
  const exportedNames = [];
  let out = code;

  // 1. 替换 import.meta.url
  out = out.replace(/\bimport\.meta\.url\b/g, 'window.location.href');

  // 2. 替换 import { ... } from './xxx.js';
  out = out.replace(/import\s*\{([\s\S]*?)\}\s*from\s*['"]\.\/([^'"]+)['"]\s*;/g, (_, specifiers, modName) => {
    const normalized = specifiers.replace(/\s+as\s+/g, ': ');
    return `const {${normalized}} = __modules['./${modName}'];`;
  });

  // 3. 替换 export async function / export function / export class
  out = out.replace(/export\s+async\s+function\s+([A-Za-z0-9_$]+)/g, (_, name) => {
    exportedNames.push(name);
    return `async function ${name}`;
  });
  out = out.replace(/export\s+function\s+([A-Za-z0-9_$]+)/g, (_, name) => {
    exportedNames.push(name);
    return `function ${name}`;
  });
  out = out.replace(/export\s+class\s+([A-Za-z0-9_$]+)/g, (_, name) => {
    exportedNames.push(name);
    return `class ${name}`;
  });

  // 4. 替换 export const / let / var
  out = out.replace(/export\s+(const|let|var)\s+([A-Za-z0-9_$]+)/g, (_, kind, name) => {
    exportedNames.push(name);
    return `${kind} ${name}`;
  });

  // 5. 替换 export { a, b };
  out = out.replace(/export\s*\{([^}]+)\}\s*;/g, (_, list) => {
    for (const part of list.split(',')) {
      const trimmed = part.trim();
      if (trimmed) exportedNames.push(trimmed);
    }
    return '';
  });

  const uniqueExports = [...new Set(exportedNames)];
  return `
  __modules['./${filename}'] = (function() {
${out}
    return { ${uniqueExports.join(', ')} };
  })();`;
}

const stationsRaw = fs.readFileSync(path.join(ROOT, 'data', 'stations.json'), 'utf8').trim();
const basemapRaw = fs.readFileSync(path.join(ROOT, 'data', 'basemap.json'), 'utf8').trim();

const chunks = [];
chunks.push(`/* 自动生成的 file:// 协议离线回退包（由 scripts/build_file_fallback.mjs 生成） */
(function() {
  if (window.__JINDIANYUN_BOOTED__) return;
  window.__JINDIANYUN_BOOTED__ = true;

  const INLINE_STATIONS = ${stationsRaw};
  const INLINE_BASEMAP = ${basemapRaw};

  const origFetch = window.fetch ? window.fetch.bind(window) : null;
  window.fetch = async function(input, init) {
    const urlStr = typeof input === 'string' ? input : (input && input.url ? input.url : String(input));
    if (urlStr.includes('data/stations.json')) {
      return new Response(JSON.stringify(INLINE_STATIONS), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    if (urlStr.includes('data/basemap.json')) {
      return new Response(JSON.stringify(INLINE_BASEMAP), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    if (origFetch) return origFetch(input, init);
    throw new Error('当前环境不支持网络请求');
  };

  const __modules = Object.create(null);
`);

for (const file of ORDER) {
  const code = fs.readFileSync(path.join(ROOT, 'js', file), 'utf8');
  chunks.push(transformModule(file, code));
}

chunks.push(`\n})();\n`);

const outPath = path.join(ROOT, 'js', 'file-fallback.js');
fs.writeFileSync(outPath, chunks.join('\n'), 'utf8');
console.log(`Generated ${outPath} (${fs.statSync(outPath).size} bytes)`);
