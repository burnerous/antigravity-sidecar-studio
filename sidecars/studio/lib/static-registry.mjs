import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { extname, join, posix, resolve, sep } from 'node:path';

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

const MAX_DYNAMIC_VENDOR_CACHE = 512;

function isExistingFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function isNonEmptyDir(p) {
  try {
    return statSync(p).isDirectory() && readdirSync(p).length > 0;
  } catch {
    return false;
  }
}

function isWithinDir(childPath, parentPath) {
  const isWin = process.platform === 'win32';
  const child = isWin ? childPath.toLowerCase() : childPath;
  const parent = isWin ? parentPath.toLowerCase() : parentPath;
  const prefix = parent.endsWith(sep) ? parent : `${parent}${sep}`;
  return child.startsWith(prefix);
}

export function getVendorManifest(studioDir) {
  const nm = join(studioDir, 'node_modules');
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
  const vendorDirs = [
    ['/vendor/pdfjs/cmaps', join(nm, 'pdfjs-dist', 'cmaps')],
    ['/vendor/pdfjs/standard_fonts', join(nm, 'pdfjs-dist', 'standard_fonts')],
    ['/vendor/pdfjs/images', join(nm, 'pdfjs-dist', 'web', 'images')],
  ];
  return { vendorFiles, vendorDirs };
}

/** Return logical `/vendor/...` routes currently missing or empty on disk without exposing host paths. */
export function inspectVendorAssets(studioDir) {
  const { vendorFiles, vendorDirs } = getVendorManifest(studioDir);
  const missingRoutes = [];
  for (const [route, diskPath] of vendorFiles) {
    if (!isExistingFile(diskPath)) missingRoutes.push(route);
  }
  for (const [prefix, dirPath] of vendorDirs) {
    if (!isNonEmptyDir(dirPath)) missingRoutes.push(prefix);
  }
  return missingRoutes;
}

function makeFileResponder(ResponseClass, diskPath, { cacheControl = 'no-store', missingStatus = 500, routeLabel = '' } = {}) {
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
          'X-Content-Type-Options': 'nosniff',
        },
      });
    } catch (err) {
      if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR' || err?.code === 'EISDIR') {
        return new ResponseClass(`Offline vendor asset missing: ${routeLabel || 'asset'}`, {
          contentType: 'text/plain; charset=utf-8',
          status: missingStatus,
          headers: {
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
          },
        });
      }
      return new ResponseClass('Failed to read asset', {
        contentType: 'text/plain; charset=utf-8',
        status: 500,
        headers: {
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        },
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

/**
 * Fallback handler for pdf.js asset directories that were missing at startup so
 * post-startup `node_modules` restoration serves files immediately without restart.
 */
export function createDynamicVendorDirHandler(studioDir) {
  const { vendorDirs } = getVendorManifest(studioDir);
  const cache = new Map();

  const textRes = (status, msg) => ({
    status,
    contentType: 'text/plain; charset=utf-8',
    body: Buffer.from(msg, 'utf8'),
    headers: {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });

  return (pathname) => {
    let matchedPrefix = '';
    let baseDir = '';
    for (const [prefix, dirPath] of vendorDirs) {
      if (pathname.startsWith(`${prefix}/`)) {
        matchedPrefix = prefix;
        baseDir = dirPath;
        break;
      }
    }
    if (!matchedPrefix) return null;

    let rel;
    try {
      rel = decodeURIComponent(pathname.slice(matchedPrefix.length + 1));
    } catch {
      return textRes(400, 'Bad vendor path');
    }

    if (!rel || rel.includes('\0') || rel.includes('\\') || rel.startsWith('/')) {
      return textRes(400, 'Bad vendor path');
    }
    const segments = rel.split('/');
    if (segments.some((s) => !s || s === '.' || s === '..')) {
      return textRes(400, 'Bad vendor path');
    }

    const cached = cache.get(pathname);
    if (cached) {
      return {
        status: 200,
        contentType: cached.contentType,
        body: cached.body,
        headers: {
          'Cache-Control': 'public, max-age=86400',
          'Content-Length': String(cached.body.length),
          'X-Content-Type-Options': 'nosniff',
        },
      };
    }

    if (!existsSync(baseDir)) {
      return textRes(503, `Offline vendor directory missing: ${matchedPrefix}`);
    }

    let realBase;
    try {
      realBase = realpathSync(baseDir);
    } catch {
      return textRes(503, `Offline vendor directory missing: ${matchedPrefix}`);
    }

    const candidate = resolve(realBase, rel);
    if (!isWithinDir(candidate, realBase)) {
      return textRes(400, 'Bad vendor path');
    }
    if (!existsSync(candidate)) {
      return textRes(404, 'Not found');
    }

    let realFile;
    try {
      realFile = realpathSync(candidate);
    } catch {
      return textRes(404, 'Not found');
    }
    if (!isWithinDir(realFile, realBase)) {
      return textRes(403, 'Forbidden');
    }
    if (!isExistingFile(realFile)) {
      return textRes(404, 'Not found');
    }

    try {
      const body = readFileSync(realFile);
      const ext = extname(realFile).toLowerCase();
      const contentType = STATIC_MIME_TYPES[ext] || 'application/octet-stream';
      if (cache.size < MAX_DYNAMIC_VENDOR_CACHE) {
        cache.set(pathname, { contentType, body });
      }
      return {
        status: 200,
        contentType,
        body,
        headers: {
          'Cache-Control': 'public, max-age=86400',
          'Content-Length': String(body.length),
          'X-Content-Type-Options': 'nosniff',
        },
      };
    } catch {
      return textRes(500, 'Failed to read vendor asset');
    }
  };
}

export function registerAllStaticAssets(app, ResponseClass, studioDir) {
  const publicDir = join(studioDir, 'public');
  const { vendorFiles, vendorDirs } = getVendorManifest(studioDir);
  const missing = [];
  const missingVendorDirs = [];
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
    if (!isExistingFile(p)) missing.push(p);
  }
  if (existsSync(publicDir)) {
    for (const { relPosix, diskPath } of walkDirFiles(publicDir)) {
      if (relPosix === 'index.html') continue;
      const route = `/${relPosix}`;
      app.api(route, makeFileResponder(ResponseClass, diskPath, { cacheControl: 'no-store', routeLabel: route }), 'GET');
      count += 1;
    }
  } else {
    missing.push(publicDir);
  }

  // 3. Explicit local vendor single-file bundles (registered unconditionally so late node_modules installs work without restart)
  for (const [route, diskPath] of vendorFiles) {
    if (!isExistingFile(diskPath)) {
      missing.push(diskPath);
    }
    app.api(
      route,
      makeFileResponder(ResponseClass, diskPath, {
        cacheControl: 'public, max-age=86400',
        missingStatus: 503,
        routeLabel: route,
      }),
      'GET'
    );
    count += 1;
  }

  // 4. Vendor directories required by pdf.js (cmaps, standard_fonts, web images)
  for (const [prefix, dirPath] of vendorDirs) {
    if (!isNonEmptyDir(dirPath)) {
      missing.push(dirPath);
      missingVendorDirs.push(prefix);
      continue;
    }
    for (const { relPosix, diskPath } of walkDirFiles(dirPath)) {
      const route = `${prefix}/${relPosix}`;
      app.api(
        route,
        makeFileResponder(ResponseClass, diskPath, {
          cacheControl: 'public, max-age=86400',
          missingStatus: 503,
          routeLabel: route,
        }),
        'GET'
      );
      count += 1;
    }
  }

  return {
    count,
    missing,
    missingVendorDirs,
    getMissingVendorAssets: () => inspectVendorAssets(studioDir),
  };
}
