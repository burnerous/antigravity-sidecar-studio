import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, posix } from 'node:path';

export const STATIC_MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.wasm': 'application/wasm',
  '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.properties': 'text/plain; charset=utf-8',
};

function makeFileResponder(ResponseClass, diskPath, { cacheControl = 'no-store' } = {}) {
  const ext = extname(diskPath).toLowerCase();
  const contentType = STATIC_MIME_TYPES[ext] || 'application/octet-stream';
  let cachedBuf = null;
  const shouldCacheInMem = cacheControl !== 'no-store';

  return () => {
    try {
      const buf = shouldCacheInMem && cachedBuf ? cachedBuf : readFileSync(diskPath);
      if (shouldCacheInMem && !cachedBuf) cachedBuf = buf;
      return new ResponseClass(buf, {
        contentType,
        headers: {
          'Cache-Control': cacheControl,
          'Content-Length': String(buf.length),
        },
      });
    } catch (err) {
      return new ResponseClass(`Failed to read asset: ${err.message}`, {
        contentType: 'text/plain; charset=utf-8',
        status: 500,
      });
    }
  };
}

function walkDirFiles(rootDir, relPosix = '') {
  const out = [];
  if (!existsSync(rootDir)) return out;
  for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
    const full = join(rootDir, entry.name);
    const nextRel = relPosix ? posix.join(relPosix, entry.name) : entry.name;
    if (entry.isDirectory()) {
      out.push(...walkDirFiles(full, nextRel));
    } else if (entry.isFile()) {
      out.push({ relPosix: nextRel, diskPath: full });
    }
  }
  return out;
}

export function registerAllStaticAssets(app, ResponseClass, studioDir) {
  const publicDir = join(studioDir, 'public');
  const nm = join(studioDir, 'node_modules');
  const missing = [];
  let count = 0;

  // 1. Entry HTML pages
  const indexHtml = join(publicDir, 'index.html');
  if (existsSync(indexHtml)) {
    const serveIndex = makeFileResponder(ResponseClass, indexHtml, { cacheControl: 'no-store' });
    app.page('/', serveIndex);
    app.page('/index.html', serveIndex);
    count += 2;
  } else {
    missing.push(indexHtml);
  }

  // 2. Public frontend assets (registered as exact GET routes)
  const requiredPublic = ['icons.js', 'styles.css', 'app.js', 'trajectory-view.js'];
  for (const rel of requiredPublic) {
    const p = join(publicDir, rel);
    if (!existsSync(p) || !statSync(p).isFile()) missing.push(p);
  }
  if (existsSync(publicDir)) {
    for (const { relPosix, diskPath } of walkDirFiles(publicDir)) {
      if (relPosix === 'index.html') continue;
      const route = `/${relPosix}`;
      app.api(route, makeFileResponder(ResponseClass, diskPath, { cacheControl: 'no-store' }), 'GET');
      count += 1;
    }
  } else {
    missing.push(publicDir);
  }

  // 3. Explicit local vendor single-file bundles (zero CDN)
  const vendorFiles = [
    ['/vendor/jszip.min.js', join(nm, 'jszip', 'dist', 'jszip.min.js')],
    ['/vendor/docx-preview.min.js', join(nm, 'docx-preview', 'dist', 'docx-preview.min.js')],
    ['/vendor/mammoth.browser.min.js', join(nm, 'mammoth', 'mammoth.browser.min.js')],
    ['/vendor/xlsx.full.min.js', join(nm, 'xlsx', 'dist', 'xlsx.full.min.js')],
    ['/vendor/marked.umd.js', join(nm, 'marked', 'lib', 'marked.umd.js')],
    ['/vendor/purify.min.js', join(nm, 'dompurify', 'dist', 'purify.min.js')],
    ['/vendor/highlight.min.js', join(nm, '@highlightjs', 'cdn-assets', 'highlight.min.js')],
    ['/vendor/hljs-dark.css', join(nm, '@highlightjs', 'cdn-assets', 'styles', 'github-dark.min.css')],
    ['/vendor/hljs-light.css', join(nm, '@highlightjs', 'cdn-assets', 'styles', 'github.min.css')],
    ['/vendor/pdfjs/pdf.min.js', join(nm, 'pdfjs-dist', 'build', 'pdf.min.js')],
    ['/vendor/pdfjs/pdf.worker.min.js', join(nm, 'pdfjs-dist', 'build', 'pdf.worker.min.js')],
    ['/vendor/pdfjs/pdf_viewer.css', join(nm, 'pdfjs-dist', 'web', 'pdf_viewer.css')],
  ];

  for (const [route, diskPath] of vendorFiles) {
    if (!existsSync(diskPath) || !statSync(diskPath).isFile()) {
      missing.push(diskPath);
      continue;
    }
    app.api(
      route,
      makeFileResponder(ResponseClass, diskPath, { cacheControl: 'public, max-age=86400' }),
      'GET'
    );
    count += 1;
  }

  // 4. Vendor directories required by pdf.js (cmaps, standard_fonts, web images)
  const vendorDirs = [
    ['/vendor/pdfjs/cmaps', join(nm, 'pdfjs-dist', 'cmaps')],
    ['/vendor/pdfjs/standard_fonts', join(nm, 'pdfjs-dist', 'standard_fonts')],
    ['/vendor/pdfjs/images', join(nm, 'pdfjs-dist', 'web', 'images')],
  ];

  for (const [prefix, dirPath] of vendorDirs) {
    if (!existsSync(dirPath)) {
      missing.push(dirPath);
      continue;
    }
    for (const { relPosix, diskPath } of walkDirFiles(dirPath)) {
      const route = `${prefix}/${relPosix}`;
      app.api(
        route,
        makeFileResponder(ResponseClass, diskPath, { cacheControl: 'public, max-age=86400' }),
        'GET'
      );
      count += 1;
    }
  }

  return { count, missing };
}
