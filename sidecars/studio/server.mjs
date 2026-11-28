import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  cpSync,
  createReadStream,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  unlinkSync,
  unwatchFile,
  utimesSync,
  watchFile,
  writeFileSync,
} from 'node:fs';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deflateRawSync } from 'node:zlib';

import { OfficeConverter } from './lib/office-converter.mjs';
import {
  CONV_ID_RE,
  isUnderRoot,
  makeHttpError,
  resolveAppDataDir,
  SecurityManager,
} from './lib/security.mjs';
import {
  createDynamicVendorDirHandler,
  getVendorManifest,
  registerAllStaticAssets,
  STATIC_MIME_TYPES,
} from './lib/static-registry.mjs';
import {
  extractProducedDocs,
  readFullTranscriptStep,
  readTranscriptSteps,
  resolveConversationId,
} from './lib/transcript.mjs';
import { UiPrefsStore } from './lib/ui-prefs.mjs';
import {
  compareSemver,
  computeCrc32,
  extractZipSafely,
  PluginUpdater,
} from './lib/updater.mjs';
import { listDirectory, searchWorkspace, WorkspaceWatcher } from './lib/workspace.mjs';
import { runUpdateCli } from './scripts/update.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const FILE_MIME_TYPES = {
  ...STATIC_MIME_TYPES,
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.csv': 'text/csv; charset=utf-8',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.ts': 'text/plain; charset=utf-8',
  '.tsx': 'text/plain; charset=utf-8',
  '.jsx': 'text/plain; charset=utf-8',
  '.py': 'text/plain; charset=utf-8',
  '.ps1': 'text/plain; charset=utf-8',
  '.sh': 'text/plain; charset=utf-8',
  '.yaml': 'text/plain; charset=utf-8',
  '.yml': 'text/plain; charset=utf-8',
  '.toml': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
};

const VIDEO_STREAM_MIME_TYPES = { '.mp4': 'video/mp4' };
const ACTIVE_DOC_EXTS = new Set(['.html', '.htm', '.svg', '.xml', '.xhtml']);
const SAVE_AS_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const MAX_RAW_FILE_BYTES = 128 * 1024 * 1024; // 128 MB safety guard
const MAX_HASH_VERSION_BYTES = 32 * 1024 * 1024; // 32 MB version digest limit
const MAX_POST_BODY_BYTES = 180 * 1024 * 1024; // Early HTTP POST body limit (covers base64 up to 128 MiB)
const UI_PREFS_PATH = '/api/ui/prefs';
const BASE64_FLAT_RE = /^[A-Za-z0-9+/]+={0,2}$/;

function isValidBase64(str) {
  return (
    typeof str === 'string' &&
    str.length > 0 &&
    str.length % 4 === 0 &&
    BASE64_FLAT_RE.test(str)
  );
}

function versionFromBuffer(st, buf = null) {
  let digest = 'large';
  if (buf) {
    digest = createHash('sha256').update(buf).digest('hex').slice(0, 24);
  }
  return `${st.size}:${Math.round(st.mtimeMs * 1000)}:${digest}`;
}

function computeFileVersion(absPath, st) {
  if (!st || st.size > MAX_HASH_VERSION_BYTES) {
    return `${st?.size || 0}:${Math.round((st?.mtimeMs || 0) * 1000)}:large`;
  }
  try {
    const buf = readFileSync(absPath);
    return versionFromBuffer(st, buf);
  } catch {
    return `${st.size}:${Math.round(st.mtimeMs * 1000)}:unreadable`;
  }
}

function readRawSlice(filePath, maxBytes) {
  const fd = openSync(filePath, 'r');
  try {
    const buf = Buffer.allocUnsafe(maxBytes);
    let totalRead = 0;
    while (totalRead < maxBytes) {
      const n = readSync(fd, buf, totalRead, maxBytes - totalRead, totalRead);
      if (n <= 0) break;
      totalRead += n;
    }
    return totalRead === maxBytes ? buf : buf.subarray(0, totalRead);
  } finally {
    closeSync(fd);
  }
}

async function loadSdk() {
  try {
    return await import('sidecar_sdk');
  } catch (err) {
    if (err?.code !== 'ERR_MODULE_NOT_FOUND') throw err;
    const fallbackPath = join(
      homedir(),
      '.gemini',
      'antigravity',
      'lib',
      'node_modules',
      'sidecar_sdk',
      'index.mjs'
    );
    return import(pathToFileURL(fallbackPath).href);
  }
}

function jsonResponse(ResponseClass, payload, status = 200, extraHeaders = {}) {
  return new ResponseClass(JSON.stringify(payload), {
    contentType: 'application/json; charset=utf-8',
    status,
    headers: {
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  });
}

function handleApiError(ResponseClass, err) {
  const status = Number.isInteger(err?.status) ? err.status : 500;
  return jsonResponse(ResponseClass, { success: false, error: err?.message || 'Internal error' }, status);
}

function preserveUiPrefsPatch(req) {
  // The SDK merges JSON into an object. Wrap the original value so the route can validate its shape.
  const sdkRequest = Object.create(req);
  sdkRequest.on = (event, listener) => {
    if (event === 'data') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.prependListener('end', () => {
        try {
          JSON.parse(body);
        } catch {
          // Invalid JSON is rejected by the same validator as a missing JSON object.
          body = 'null';
        }
        listener(`{"uiPrefsPatch":${body}}`);
      });
    } else {
      req.on(event, listener);
    }
    return sdkRequest;
  };
  return sdkRequest;
}

export function createStudioServer({
  SidecarApp,
  Response: ResponseClass,
  appDataDir,
  cacheDir,
  studioDir = __dirname,
  pluginRoot,
  dataDir,
  updaterOptions,
  prepareForSelfUpdate,
  onRestart,
} = {}) {
  const app = new SidecarApp();
  const security = new SecurityManager();
  const watcher = new WorkspaceWatcher();
  const converter = new OfficeConverter({
    scriptPath: join(studioDir, 'scripts', 'office-to-pdf.ps1'),
    cacheDir,
    timeoutMs: 25000,
  });
  const bootId = randomBytes(8).toString('hex');
  const resolvedPluginRoot = resolve(pluginRoot || join(studioDir, '..', '..'));
  const resolvedDataDir = resolve(
    dataDir || (cacheDir ? join(dirname(cacheDir), 'updater-data') : join(tmpdir(), 'sidecar-studio-data'))
  );
  const updater = new PluginUpdater({
    pluginRoot: resolvedPluginRoot,
    studioDir,
    dataDir: resolvedDataDir,
    bootId,
    prepareForSelfUpdate: async () => {
      watcher.closeAll();
      if (prepareForSelfUpdate) await prepareForSelfUpdate();
    },
    onRestart,
    ...(updaterOptions || {}),
  });
  const uiPrefs = new UiPrefsStore({ dataDir: resolvedDataDir });

  const staticInfo = registerAllStaticAssets(app, ResponseClass, studioDir);
  const dynamicVendorDirHandler =
    staticInfo.missingVendorDirs.length > 0 ? createDynamicVendorDirHandler(studioDir) : null;

  const origRun = app.run.bind(app);
  app.run = async () => {
    const httpServer = await origRun();
    const existingListeners = httpServer.listeners('request').slice();
    httpServer.removeAllListeners('request');
    httpServer.on('request', (req, res) => {
      if (req.method === 'GET' || req.method === 'HEAD') {
        try {
          const parsedUrl = new URL(req.url || '/', 'http://127.0.0.1');
          if (parsedUrl.pathname === '/api/file/stream') {
            assertWorkspaceGen({ workspaceGen: parsedUrl.searchParams.get('workspaceGen') });
            const target = security.assertAllowedPath(parsedUrl.searchParams.get('path') || '', {
              appDataDir,
              convId: effectiveConvId(),
              mustExist: true,
              expectFile: true,
            });
            const ext = extname(target).toLowerCase();
            const contentType = VIDEO_STREAM_MIME_TYPES[ext];
            if (!contentType) throw makeHttpError(415, 'Unsupported media type for streaming');

            const st = statSync(target);
            const fileVersion = computeFileVersion(target, st);
            const baseHeaders = {
              'Content-Type': contentType,
              'Accept-Ranges': 'bytes',
              'Cache-Control': 'no-store',
              'X-Content-Type-Options': 'nosniff',
              'Content-Security-Policy': "default-src 'none'; sandbox",
              'X-File-Mtime': String(st.mtimeMs),
              'X-File-Size': String(st.size),
              'X-File-Version': fileVersion,
            };
            const rejectRange = () => {
              res.writeHead(416, {
                ...baseHeaders,
                'Content-Type': 'application/json; charset=utf-8',
                'Content-Range': `bytes */${st.size}`,
              });
              res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ success: false, error: 'Range Not Satisfiable' }));
            };
            const pipeFile = (options) => {
              const stream = createReadStream(target, options);
              res.once('close', () => {
                if (!stream.destroyed) stream.destroy();
              });
              stream.on('error', (streamErr) => {
                if (!res.headersSent) {
                  res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
                  res.end(JSON.stringify({ success: false, error: streamErr?.message || 'Stream error' }));
                } else {
                  res.destroy(streamErr);
                }
              });
              stream.pipe(res);
            };

            // Streaming deliberately bypasses the buffered /api/file/raw size limit.
            if (req.headers.range == null) {
              res.writeHead(200, { ...baseHeaders, 'Content-Length': String(st.size) });
              if (req.method === 'HEAD' || st.size === 0) res.end();
              else pipeFile();
              return;
            }

            const rangeHeader = req.headers.range.trim();
            const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader);
            if (rangeHeader.includes(',') || !match || st.size === 0 || (!match[1] && !match[2])) {
              rejectRange();
              return;
            }
            const [, startStr, endStr] = match;
            let start, end;
            if (startStr === '') {
              const suffixLen = Number(endStr);
              if (!Number.isSafeInteger(suffixLen) || suffixLen <= 0) {
                rejectRange();
                return;
              }
              start = Math.max(0, st.size - suffixLen);
              end = st.size - 1;
            } else {
              start = Number(startStr);
              end = endStr === '' ? st.size - 1 : Math.min(Number(endStr), st.size - 1);
              if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= st.size || start > end) {
                rejectRange();
                return;
              }
            }
            res.writeHead(206, {
              ...baseHeaders,
              'Content-Range': `bytes ${start}-${end}/${st.size}`,
              'Content-Length': String(end - start + 1),
            });
            if (req.method === 'HEAD') res.end();
            else pipeFile({ start, end });
            return;
          }
          if (dynamicVendorDirHandler && parsedUrl.pathname.startsWith('/vendor/pdfjs/')) {
            const vendorRes = dynamicVendorDirHandler(parsedUrl.pathname);
            if (vendorRes) {
              res.writeHead(vendorRes.status, {
                'Content-Type': vendorRes.contentType,
                ...vendorRes.headers,
              });
              res.end(req.method === 'HEAD' ? undefined : vendorRes.body);
              return;
            }
          }
        } catch (err) {
          if (res.headersSent) {
            res.destroy(err);
          } else {
            res.writeHead(Number.isInteger(err?.status) ? err.status : 500, {
              'Content-Type': 'application/json; charset=utf-8',
              'Cache-Control': 'no-store',
              'X-Content-Type-Options': 'nosniff',
            });
            res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ success: false, error: err?.message || 'Internal error' }));
          }
          return;
        }
      }
      if (req.method !== 'GET') {
        const declaredLen = Number(req.headers['content-length']);
        if (Number.isFinite(declaredLen) && declaredLen > MAX_POST_BODY_BYTES) {
          if (!res.headersSent) {
            res.writeHead(413, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Payload too large' }));
          }
          req.on('error', () => {});
          req.destroy();
          return;
        }
        // Set UTF-8 StringDecoder before SidecarApp reads chunks so multi-byte chars across packets don't corrupt
        req.setEncoding('utf8');
        let receivedBytes = 0;
        let aborted = false;
        const origWriteHead = res.writeHead.bind(res);
        res.writeHead = (...args) => {
          if (aborted || res.headersSent) return res;
          return origWriteHead(...args);
        };
        req.on('error', () => {});
        req.on('data', (chunk) => {
          receivedBytes += Buffer.byteLength(String(chunk), 'utf8');
          if (receivedBytes > MAX_POST_BODY_BYTES && !aborted) {
            aborted = true;
            if (!res.headersSent) {
              origWriteHead(413, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: false, error: 'Payload too large' }));
            }
            req.destroy();
          }
        });
      }
      const sdkRequest = req.method === 'POST' && new URL(req.url, 'http://127.0.0.1').pathname === UI_PREFS_PATH
        ? preserveUiPrefsPatch(req)
        : req;
      for (const listener of existingListeners) {
        listener.call(httpServer, sdkRequest, res);
      }
    });
    return httpServer;
  };

  const effectiveConvId = () => {
    const hostRaw =
      typeof app.config.conversationId === 'string' ? app.config.conversationId.trim() : '';
    return resolveConversationId(appDataDir, hostRaw).conversationId;
  };

  const assertWorkspaceGen = (data) => {
    if (data?.workspaceGen == null || data.workspaceGen === '') return;
    const reqGen = Number(data.workspaceGen);
    const curGen = security.getGeneration();
    if (!Number.isFinite(reqGen) || reqGen < curGen) {
      throw makeHttpError(409, `Workspace roots changed (reqGen=${data.workspaceGen}, curGen=${curGen})`);
    }
  };

  // GET /api/health
  app.api(
    '/api/health',
    () => {
      const caps = converter.getCapabilities();
      const upd = updater.getStatus();
      const missingVendorAssets = staticInfo.getMissingVendorAssets();
      return jsonResponse(ResponseClass, {
        success: true,
        status: 'ok',
        version: upd.currentVersion,
        installMode: upd.installMode,
        bootId,
        appDataDir,
        converters: caps,
        roots: security.getRoots(),
        generation: security.getGeneration(),
        hostLockedRoots: security.hasHostLockedRoots(),
        staticAssets: staticInfo.count,
        vendorReady: missingVendorAssets.length === 0,
        missingVendorCount: missingVendorAssets.length,
        missingVendorAssets,
      });
    },
    'GET'
  );

  // POST /api/workspace/register
  app.api('/api/workspace/register', (data) => {
    try {
      const uris = Array.isArray(data?.workspaceUris) ? data.workspaceUris : [];
      const reg = security.registerWorkspaceUris(uris, { generation: data?.generation });
      if (reg.applied) {
        watcher.syncRoots(reg.roots.map((r) => r.path));
      }
      return jsonResponse(ResponseClass, {
        success: true,
        applied: reg.applied,
        generation: reg.generation,
        roots: reg.roots,
      });
    } catch (err) {
      return handleApiError(ResponseClass, err);
    }
  });

  // GET /api/workspace/tree?root=...&dir=...&showIgnored=0|1
  app.api(
    '/api/workspace/tree',
    (data) => {
      try {
        assertWorkspaceGen(data);
        const rootPath = security.assertAllowedRoot(data?.root || '');
        const dirInput = typeof data?.dir === 'string' && data.dir.trim() ? data.dir.trim() : rootPath;
        const dirPath = security.assertAllowedPath(dirInput, {
          appDataDir,
          convId: effectiveConvId(),
          mustExist: true,
          expectDir: true,
          allowBrain: false,
        });
        if (!isUnderRoot(dirPath, rootPath)) {
          throw makeHttpError(403, 'Directory is outside the selected workspace root');
        }
        const showIgnored = data?.showIgnored === '1' || data?.showIgnored === 'true';
        const items = listDirectory(rootPath, dirPath, { showIgnored });
        return jsonResponse(ResponseClass, {
          success: true,
          root: rootPath,
          dir: dirPath,
          generation: security.getGeneration(),
          items,
        });
      } catch (err) {
        return handleApiError(ResponseClass, err);
      }
    },
    'GET'
  );

  // GET /api/workspace/search?root=...&q=...&showIgnored=0|1&limit=100
  app.api(
    '/api/workspace/search',
    (data) => {
      try {
        assertWorkspaceGen(data);
        const rootPath = security.assertAllowedRoot(data?.root || '');
        const query = typeof data?.q === 'string' ? data.q : '';
        const showIgnored = data?.showIgnored === '1' || data?.showIgnored === 'true';
        const limitRaw = Number(data?.limit);
        const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 300) : 100;
        const res = searchWorkspace(rootPath, query, { showIgnored, limit });
        return jsonResponse(ResponseClass, {
          success: true,
          root: rootPath,
          query,
          generation: security.getGeneration(),
          ...res,
        });
      } catch (err) {
        return handleApiError(ResponseClass, err);
      }
    },
    'GET'
  );

  // GET /api/workspace/watch-state?root=...
  app.api(
    '/api/workspace/watch-state',
    (data) => {
      try {
        const rootPath = security.assertAllowedRoot(data?.root || '');
        return jsonResponse(ResponseClass, {
          success: true,
          root: rootPath,
          ...watcher.getState(rootPath),
        });
      } catch (err) {
        return handleApiError(ResponseClass, err);
      }
    },
    'GET'
  );

  // GET /api/file/stat?path=...
  app.api(
    '/api/file/stat',
    (data) => {
      try {
        assertWorkspaceGen(data);
        const convId = effectiveConvId();
        const target = security.assertAllowedPath(data?.path || '', {
          appDataDir,
          convId,
          mustExist: false,
        });
        if (!existsSync(target)) {
          return jsonResponse(ResponseClass, { success: true, path: target, exists: false });
        }
        const st = statSync(target);
        const version = st.isFile() ? computeFileVersion(target, st) : '';
        return jsonResponse(ResponseClass, {
          success: true,
          path: target,
          exists: true,
          isFile: st.isFile(),
          size: st.size,
          mtimeMs: st.mtimeMs,
          version,
        });
      } catch (err) {
        return handleApiError(ResponseClass, err);
      }
    },
    'GET'
  );

  // GET /api/file/raw?path=...
  app.api(
    '/api/file/raw',
    (data) => {
      try {
        assertWorkspaceGen(data);
        const convId = effectiveConvId();
        const target = security.assertAllowedPath(data?.path || '', {
          appDataDir,
          convId,
          mustExist: true,
          expectFile: true,
        });
        const st = statSync(target);
        let maxBytes = null;
        if (data?.maxBytes != null) {
          const parsedMax = Number(data.maxBytes);
          if (Number.isFinite(parsedMax) && parsedMax > 0) {
            maxBytes = Math.min(Math.max(Math.floor(parsedMax), 1024), MAX_RAW_FILE_BYTES);
          }
        }
        let truncated = false;
        let buf;
        let fileVersion;
        if (maxBytes !== null && st.size > maxBytes) {
          buf = readRawSlice(target, maxBytes);
          truncated = true;
          fileVersion = computeFileVersion(target, st);
        } else {
          if (st.size > MAX_RAW_FILE_BYTES) {
            return jsonResponse(
              ResponseClass,
              { success: false, error: `File too large (${st.size} bytes)` },
              413
            );
          }
          buf = readFileSync(target);
          fileVersion =
            st.size <= MAX_HASH_VERSION_BYTES
              ? versionFromBuffer(st, buf)
              : versionFromBuffer(st, null);
        }
        const ext = extname(target).toLowerCase();
        const contentType = ACTIVE_DOC_EXTS.has(ext)
          ? 'text/plain; charset=utf-8'
          : FILE_MIME_TYPES[ext] || 'application/octet-stream';
        const headers = {
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          'Content-Disposition': 'attachment',
          'Content-Security-Policy': "default-src 'none'; sandbox",
          'Content-Length': String(buf.length),
          'X-File-Mtime': String(st.mtimeMs),
          'X-File-Size': String(st.size),
          'X-File-Version': fileVersion,
        };
        if (truncated) headers['X-File-Truncated'] = '1';
        return new ResponseClass(buf, {
          contentType,
          headers,
        });
      } catch (err) {
        return handleApiError(ResponseClass, err);
      }
    },
    'GET'
  );

  // POST /api/file/save
  app.api(
    '/api/file/save',
    (data) => {
      try {
        assertWorkspaceGen(data);
        const convId = effectiveConvId();
        const target = security.assertAllowedPath(data?.path || '', {
          appDataDir,
          convId,
          mustExist: true,
          expectFile: true,
          allowBrain: false,
        });

        if (typeof data?.content !== 'string') {
          return jsonResponse(ResponseClass, { success: false, error: 'Missing content' }, 400);
        }

        const encoding = data?.encoding;
        if (encoding !== 'utf8' && encoding !== 'base64') {
          return jsonResponse(
            ResponseClass,
            { success: false, error: 'Invalid encoding (expected utf8 or base64)' },
            400
          );
        }

        const force = data?.force === true;
        const currentSt = statSync(target);
        const currentVersion = computeFileVersion(target, currentSt);

        if (!force) {
          const baseVersion = typeof data?.baseVersion === 'string' ? data.baseVersion.trim() : '';
          const hasBaseMtime =
            data?.baseMtimeMs != null &&
            Number.isFinite(Number(data.baseMtimeMs)) &&
            Number(data.baseMtimeMs) > 0;
          if (!baseVersion && !hasBaseMtime) {
            return jsonResponse(
              ResponseClass,
              { success: false, error: 'Missing or invalid baseVersion / baseMtimeMs' },
              400
            );
          }
          const versionMismatch = Boolean(baseVersion && baseVersion !== currentVersion);
          const mtimeMismatch = Boolean(
            hasBaseMtime && Math.round(currentSt.mtimeMs) !== Math.round(Number(data.baseMtimeMs))
          );
          if (versionMismatch || mtimeMismatch) {
            return jsonResponse(
              ResponseClass,
              {
                success: false,
                conflict: true,
                currentMtimeMs: currentSt.mtimeMs,
                currentSize: currentSt.size,
                currentVersion,
                error: '文件已被外部或 AI 更新',
              },
              409
            );
          }
        } else {
          const expectedVersion =
            typeof data?.expectedConflictVersion === 'string'
              ? data.expectedConflictVersion.trim()
              : '';
          const hasExpectedMtime =
            data?.expectedConflictMtimeMs != null &&
            Number.isFinite(Number(data.expectedConflictMtimeMs)) &&
            Number(data.expectedConflictMtimeMs) > 0;
          if (!expectedVersion && !hasExpectedMtime) {
            return jsonResponse(
              ResponseClass,
              {
                success: false,
                error: 'Missing expectedConflictVersion or expectedConflictMtimeMs for force save',
              },
              400
            );
          }
          const versionMismatch = Boolean(expectedVersion && expectedVersion !== currentVersion);
          const mtimeMismatch = Boolean(
            hasExpectedMtime &&
              Math.round(currentSt.mtimeMs) !== Math.round(Number(data.expectedConflictMtimeMs))
          );
          if (versionMismatch || mtimeMismatch) {
            return jsonResponse(
              ResponseClass,
              {
                success: false,
                conflict: true,
                currentMtimeMs: currentSt.mtimeMs,
                currentSize: currentSt.size,
                currentVersion,
                error: '确认覆盖前文件再次发生变化，请刷新后重试',
              },
              409
            );
          }
        }

        let buf;
        if (encoding === 'utf8') {
          const rawBytes = Buffer.byteLength(data.content, 'utf8');
          if (rawBytes > MAX_RAW_FILE_BYTES) {
            return jsonResponse(
              ResponseClass,
              { success: false, error: `Payload too large (${rawBytes} bytes)` },
              413
            );
          }
          buf = Buffer.from(data.content, 'utf8');
        } else {
          const cleanB64 = data.content.replace(/\s+/g, '');
          if (!isValidBase64(cleanB64)) {
            return jsonResponse(
              ResponseClass,
              { success: false, error: 'Invalid base64 payload' },
              400
            );
          }
          const pad = cleanB64.endsWith('==') ? 2 : cleanB64.endsWith('=') ? 1 : 0;
          const exactBytes = (cleanB64.length / 4) * 3 - pad;
          if (exactBytes > MAX_RAW_FILE_BYTES) {
            return jsonResponse(
              ResponseClass,
              { success: false, error: `Payload too large (${exactBytes} bytes)` },
              413
            );
          }
          buf = Buffer.from(cleanB64, 'base64');
          if (buf.length === 0) {
            return jsonResponse(
              ResponseClass,
              { success: false, error: 'Refusing to write empty binary payload' },
              400
            );
          }
        }

        const tmpPath = `${target}.${process.pid}.${Date.now()}.${randomBytes(4).toString('hex')}.ws-tmp`;
        try {
          writeFileSync(tmpPath, buf, { flag: 'wx' });
          // Re-verify target identity and optimistic version immediately before atomic swap
          const preSwapLst = lstatSync(target);
          if (preSwapLst.isSymbolicLink() || realpathSync(target) !== target) {
            throw makeHttpError(403, 'Target path changed or became a symlink during save');
          }
          if (
            (currentSt.ino && preSwapLst.ino && preSwapLst.ino !== currentSt.ino) ||
            Math.round(preSwapLst.mtimeMs * 1000) !== Math.round(currentSt.mtimeMs * 1000) ||
            computeFileVersion(target, preSwapLst) !== currentVersion
          ) {
            const latestSt = statSync(target);
            return jsonResponse(
              ResponseClass,
              {
                success: false,
                conflict: true,
                currentMtimeMs: latestSt.mtimeMs,
                currentSize: latestSt.size,
                currentVersion: computeFileVersion(target, latestSt),
                error: '提交保存前文件发生变化，请刷新后重试',
              },
              409
            );
          }
          renameSync(tmpPath, target);
        } catch (err) {
          const code = err?.code || '';
          if (['EPERM', 'EBUSY', 'EACCES'].includes(code)) {
            return jsonResponse(
              ResponseClass,
              {
                success: false,
                locked: true,
                error: '文件正被其他程序占用，无法执行原子保存',
              },
              423
            );
          }
          throw err;
        } finally {
          try {
            if (existsSync(tmpPath)) unlinkSync(tmpPath);
          } catch {}
        }

        const nextSt = statSync(target);
        const nextVersion =
          nextSt.size <= MAX_HASH_VERSION_BYTES
            ? versionFromBuffer(nextSt, buf)
            : versionFromBuffer(nextSt, null);
        return jsonResponse(ResponseClass, {
          success: true,
          path: target,
          mtimeMs: nextSt.mtimeMs,
          size: nextSt.size,
          version: nextVersion,
        });
      } catch (err) {
        return handleApiError(ResponseClass, err);
      }
    },
    'POST'
  );

  // POST /api/file/save-as
  app.api(
    '/api/file/save-as',
    (data) => {
      let tmpPath = '';
      let ownsTemp = false;
      try {
        assertWorkspaceGen(data);
        const convId = effectiveConvId();
        const pathOptions = { appDataDir, convId, allowBrain: true };
        const brainDir = security.getBrainConvDir(appDataDir, convId);
        let brainRoot = appDataDir ? resolve(appDataDir, 'brain') : '';
        if (brainRoot) {
          try {
            brainRoot = realpathSync(brainRoot);
          } catch {
            // The brain directory is optional for workspace sources.
          }
        }
        const brainSysGenDir = brainDir ? join(brainDir, '.system_generated') : '';
        const assertNotBrainSystemGenerated = (p) => {
          if (brainSysGenDir && isUnderRoot(p, brainSysGenDir)) {
            throw makeHttpError(403, 'Access denied: cannot save into .system_generated directory');
          }
        };
        const assertSaveAsPath = (path, options) => {
          const allowedPath = security.assertAllowedPath(path, { ...pathOptions, ...options });
          assertNotBrainSystemGenerated(allowedPath);
          if (brainRoot && isUnderRoot(allowedPath, brainRoot) && (!brainDir || !isUnderRoot(allowedPath, brainDir))) {
            throw makeHttpError(403, 'Access denied: cannot save into another conversation brain directory');
          }
          return allowedPath;
        };
        const realSource = assertSaveAsPath(data?.sourcePath || '', {
          mustExist: true,
          expectFile: true,
        });

        const cleanName = typeof data?.fileName === 'string' ? data.fileName.trim() : '';
        const invalidWindowsName = process.platform === 'win32' && (
          /[<>"|?*\u0001-\u001f]/.test(cleanName) ||
          /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])\s*\./i.test(cleanName)
        );
        if (
          !cleanName || cleanName.length > 180 || /[\0/\\:]/.test(cleanName) ||
          cleanName === '.' || cleanName === '..' || basename(cleanName) !== cleanName ||
          invalidWindowsName
        ) {
          throw makeHttpError(400, 'Invalid image file name');
        }
        const ext = extname(cleanName);
        if (!SAVE_AS_IMAGE_EXTS.has(ext.toLowerCase())) {
          throw makeHttpError(400, 'Unsupported image extension (allowed: .png, .jpg, .jpeg, .webp)');
        }

        if (typeof data?.content !== 'string') {
          throw makeHttpError(400, 'Missing content');
        }
        if (data.encoding !== undefined && data.encoding !== 'base64') {
          throw makeHttpError(400, 'Invalid encoding (expected base64)');
        }
        const cleanB64 = data.content.replace(/\s+/g, '');
        if (!isValidBase64(cleanB64)) {
          throw makeHttpError(400, 'Invalid base64 payload');
        }
        const padding = cleanB64.endsWith('==') ? 2 : cleanB64.endsWith('=') ? 1 : 0;
        const byteLength = (cleanB64.length / 4) * 3 - padding;
        if (byteLength > MAX_RAW_FILE_BYTES) {
          throw makeHttpError(413, 'Payload too large (' + byteLength + ' bytes)');
        }
        const buf = Buffer.from(cleanB64, 'base64');
        if (!buf.length) throw makeHttpError(400, 'Refusing to write empty binary payload');

        const targetDir = dirname(realSource);
        const stem = cleanName.slice(0, -ext.length);
        const overwrite = data.overwrite === true;
        const autoRename = !overwrite && data.autoRename === true;
        const assertOriginalDirectory = () => {
          const directory = assertSaveAsPath(targetDir, { expectDir: true });
          if (directory !== targetDir) throw makeHttpError(403, 'Target directory changed during save');
        };
        const targetStatus = (targetPath) => {
          assertSaveAsPath(targetPath, { mustExist: false });
          const entry = lstatSync(targetPath, { throwIfNoEntry: false });
          if (overwrite && entry && (!entry.isFile() || realpathSync(targetPath) !== targetPath)) {
            throw makeHttpError(403, 'Target must be a regular file at the requested path');
          }
          return entry;
        };

        assertOriginalDirectory();
        for (let suffix = 1; suffix <= (autoRename ? 999 : 1); suffix++) {
          const name = suffix === 1 ? cleanName : stem + '_' + suffix + ext;
          const targetPath = join(targetDir, name);
          if (targetStatus(targetPath) && !overwrite) continue;

          if (!ownsTemp) {
            tmpPath = targetPath + '.' + process.pid + '.' + Date.now() + '.' +
              randomBytes(4).toString('hex') + '.ws-tmp';
            const tmpFd = openSync(tmpPath, 'wx');
            ownsTemp = true;
            try {
              writeFileSync(tmpFd, buf);
            } finally {
              closeSync(tmpFd);
            }
          }

          assertOriginalDirectory();
          if (overwrite) {
            targetStatus(targetPath);
            renameSync(tmpPath, targetPath);
            ownsTemp = false;
          } else {
            // Publishing a completed file with link is atomic and preserves concurrent creations.
            try {
              linkSync(tmpPath, targetPath);
            } catch (err) {
              if (err?.code === 'EEXIST') continue;
              throw err;
            }
          }

          const nextSt = statSync(targetPath);
          const root = security.getRootPaths().find((path) => isUnderRoot(targetPath, path));
          const relBase = root || (brainDir && isUnderRoot(targetPath, brainDir) ? brainDir : '');
          return jsonResponse(ResponseClass, {
            success: true,
            path: targetPath,
            relPath: relBase ? relative(relBase, targetPath).replace(/\\/g, '/') : name,
            name,
            mtimeMs: nextSt.mtimeMs,
            size: nextSt.size,
            version: versionFromBuffer(nextSt, nextSt.size <= MAX_HASH_VERSION_BYTES ? buf : null),
          });
        }
        return jsonResponse(ResponseClass, { success: false, conflict: true, error: '目标文件已存在' }, 409);
      } catch (err) {
        if (['EPERM', 'EBUSY', 'EACCES'].includes(err?.code)) {
          return jsonResponse(
            ResponseClass,
            { success: false, locked: true, error: '目标文件或目录无法写入，原子保存失败' },
            423
          );
        }
        if (['ENAMETOOLONG', 'EINVAL'].includes(err?.code)) {
          return jsonResponse(ResponseClass, { success: false, error: 'Invalid image file name' }, 400);
        }
        return handleApiError(ResponseClass, err);
      } finally {
        if (ownsTemp) {
          try { unlinkSync(tmpPath); } catch {}
        }
      }
    },
    'POST'
  );

  const handleDocConvert = async (data) => {
    try {
      assertWorkspaceGen(data);
      const reqGen =
        data?.workspaceGen != null && Number.isFinite(Number(data.workspaceGen))
          ? Number(data.workspaceGen)
          : null;
      const convId = effectiveConvId();
      const target = security.assertAllowedPath(data?.path || '', {
        appDataDir,
        convId,
        mustExist: true,
        expectFile: true,
      });
      const preferredEngine = typeof data?.engine === 'string' ? data.engine : 'auto';
      const result = await converter.convertToPdf(target, {
        preferredEngine,
        shouldCancel: () => reqGen !== null && security.getGeneration() !== reqGen,
      });
      return jsonResponse(ResponseClass, { success: true, path: target, ...result });
    } catch (err) {
      return handleApiError(ResponseClass, err);
    }
  };

  // POST /api/doc/convert (token-authenticated) + GET /api/doc/convert (compat)
  app.api('/api/doc/convert', handleDocConvert, 'POST');
  app.api('/api/doc/convert', handleDocConvert, 'GET');

  // GET /api/doc/cache-pdf?key=...
  app.api(
    '/api/doc/cache-pdf',
    (data) => {
      const key = typeof data?.key === 'string' ? data.key.trim() : '';
      if (!security.isValidCacheKey(key)) {
        return jsonResponse(ResponseClass, { success: false, error: 'Invalid cache key' }, 400);
      }
      const meta = converter.getCachedPdfMeta(key);
      if (!meta?.absPath) {
        return jsonResponse(ResponseClass, { success: false, error: 'Cached PDF not found' }, 404);
      }
      const convId = effectiveConvId();
      if (!security.isAllowedPath(meta.absPath, { appDataDir, convId, mustExist: false })) {
        return jsonResponse(
          ResponseClass,
          { success: false, error: 'Access denied: cached PDF outside active workspace' },
          403
        );
      }
      const buf = converter.readCachedPdf(key);
      if (!buf) {
        return jsonResponse(ResponseClass, { success: false, error: 'Cached PDF not found' }, 404);
      }
      return new ResponseClass(buf, {
        contentType: 'application/pdf',
        headers: {
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          'Content-Disposition': 'attachment',
          'Content-Security-Policy': "default-src 'none'; sandbox",
          'Content-Length': String(buf.length),
        },
      });
    },
    'GET'
  );

  // GET /api/doc/produced?conversationId=...
  app.api(
    '/api/doc/produced',
    (data) => {
      try {
        const res = extractProducedDocs(appDataDir, effectiveConvId(), {
          security,
          workspaceRoots: security.getRootPaths(),
        });
        return jsonResponse(ResponseClass, { success: true, ...res });
      } catch (err) {
        return handleApiError(ResponseClass, err);
      }
    },
    'GET'
  );

  // GET /api/transcript/steps?conversationId=...&afterLine=0&sig=...
  app.api(
    '/api/transcript/steps',
    (data) => {
      try {
        const afterLine = Number(data?.afterLine || 0);
        const prevSig = typeof data?.sig === 'string' ? data.sig : '';
        const force = data?.force === '1' || data?.force === 'true' || data?.force === true;
        const res = readTranscriptSteps(appDataDir, effectiveConvId(), {
          afterLine: Number.isFinite(afterLine) ? afterLine : 0,
          prevSig,
          force,
          security,
          workspaceRoots: security.getRootPaths(),
        });
        return jsonResponse(ResponseClass, { success: true, ...res });
      } catch (err) {
        return handleApiError(ResponseClass, err);
      }
    },
    'GET'
  );

  // GET /api/transcript/full?conversationId=...&stepIndex=...
  app.api(
    '/api/transcript/full',
    async (data) => {
      try {
        const stepIndex = Number(data?.stepIndex);
        if (!Number.isFinite(stepIndex) || stepIndex < 0) {
          return jsonResponse(ResponseClass, { success: false, error: 'Invalid stepIndex' }, 400);
        }
        const detail = await readFullTranscriptStep(
          appDataDir,
          effectiveConvId(),
          stepIndex
        );
        if (!detail) {
          return jsonResponse(ResponseClass, { success: false, error: 'Step not found' }, 404);
        }
        return jsonResponse(ResponseClass, { success: true, detail });
      } catch (err) {
        return handleApiError(ResponseClass, err);
      }
    },
    'GET'
  );

  // POST /api/agent/send
  app.api('/api/agent/send', (data) => {
    try {
      const message = typeof data?.message === 'string' ? data.message.trim() : '';
      if (!message) {
        return jsonResponse(ResponseClass, { success: false, error: 'Missing message' }, 400);
      }
      const convId = effectiveConvId();
      if (!convId) {
        return jsonResponse(
          ResponseClass,
          { success: false, error: 'No active conversationId found' },
          400
        );
      }
      let projectId = process.env.ANTIGRAVITY_PROJECT_ID || '';
      try {
        const metaData = app.getConversationMetadata(convId);
        const metaEvent =
          metaData?.response?.conversationMetadata || metaData?.response?.conversation_metadata;
        const meta = metaEvent?.metadata;
        projectId = meta?.projectId || meta?.project_id || projectId;
      } catch {
        // Fallback to env projectId
      }
      const result = app.sendMessage(convId, message, { projectId });
      return jsonResponse(ResponseClass, { success: true, conversationId: convId, result });
    } catch (err) {
      return handleApiError(ResponseClass, err);
    }
  });

  // GET /api/update/status
  app.api(
    '/api/update/status',
    () => {
      try {
        return jsonResponse(ResponseClass, { success: true, ...updater.getStatus() });
      } catch (err) {
        return handleApiError(ResponseClass, err);
      }
    },
    'GET'
  );

  // POST /api/update/check
  app.api('/api/update/check', async (data) => {
    try {
      const status = await updater.checkForUpdates({
        force: Boolean(data?.force),
        background: Boolean(data?.background),
        customMirror: data?.customMirror,
      });
      return jsonResponse(ResponseClass, { success: true, ...status });
    } catch (err) {
      return handleApiError(ResponseClass, err);
    }
  });

  // POST /api/update/apply
  app.api('/api/update/apply', async (data) => {
    try {
      const res = await updater.startUpdate({
        targetVersion: typeof data?.targetVersion === 'string' ? data.targetVersion : undefined,
        customMirror: data?.customMirror,
      });
      return jsonResponse(ResponseClass, { success: true, ...res }, 202);
    } catch (err) {
      return handleApiError(ResponseClass, err);
    }
  });

  // POST /api/update/prefs
  app.api('/api/update/prefs', (data) => {
    try {
      const status = updater.updatePreferences({
        autoCheck: typeof data?.autoCheck === 'boolean' ? data.autoCheck : undefined,
        dismissedVersion:
          typeof data?.dismissedVersion === 'string' ? data.dismissedVersion : undefined,
        customMirror: data?.customMirror !== undefined ? data.customMirror : undefined,
      });
      return jsonResponse(ResponseClass, { success: true, ...status });
    } catch (err) {
      return handleApiError(ResponseClass, err);
    }
  });

  // POST /api/update/ack-updated
  app.api('/api/update/ack-updated', () => {
    try {
      return jsonResponse(ResponseClass, { success: true, ...updater.acknowledgeUpdated() });
    } catch (err) {
      return handleApiError(ResponseClass, err);
    }
  });

  app.api(
    UI_PREFS_PATH,
    () => {
      try {
        return jsonResponse(ResponseClass, { success: true, prefs: uiPrefs.load() });
      } catch (err) {
        return handleApiError(ResponseClass, err);
      }
    },
    'GET'
  );

  app.api(
    UI_PREFS_PATH,
    (data) => {
      try {
        const prefs = uiPrefs.update(data.uiPrefsPatch);
        return jsonResponse(ResponseClass, { success: true, prefs });
      } catch (err) {
        return handleApiError(ResponseClass, err);
      }
    },
    'POST'
  );

  return {
    app,
    security,
    watcher,
    converter,
    updater,
    uiPrefs,
    staticInfo,
    close: async () => {
      watcher.closeAll();
      await app.close();
    },
  };
}

async function runSelfTests() {
  const { SidecarApp, Response: ResponseClass } = await loadSdk();
  assert.equal(typeof SidecarApp, 'function', 'SidecarApp must be a constructor');
  assert.equal(typeof ResponseClass, 'function', 'Response must be a constructor');

  const tmpRoot = mkdtempSync(join(tmpdir(), 'ws-studio-test-'));
  const wsDir = join(tmpRoot, 'workspace');
  const ignoredDir = join(wsDir, 'node_modules');
  const appDataDir = join(tmpRoot, 'appdata');
  const convId = '11111111-2222-3333-4444-555555555555';
  const logsDir = join(appDataDir, 'brain', convId, '.system_generated', 'logs');
  const cacheDir = join(tmpRoot, 'cache');
  const prefsDataDir = join(tmpRoot, 'updater-data');
  const prefsPath = join(prefsDataDir, 'ui-prefs.json');

  mkdirSync(wsDir, { recursive: true });
  mkdirSync(ignoredDir, { recursive: true });
  mkdirSync(logsDir, { recursive: true });
  mkdirSync(cacheDir, { recursive: true });

  const sampleMd = join(wsDir, 'README.md');
  const sampleDoc = join(wsDir, 'report.docx');
  const sampleVideo = join(wsDir, 'demo.mp4');
  const replyVideo = join(wsDir, 'reply.mp4');
  const videoBytes = Buffer.from(Array.from({ length: 64 }, (_, i) => i));
  const ignoredFile = join(ignoredDir, 'secret.js');
  writeFileSync(sampleMd, '# Hello Sidecar Studio\n', 'utf8');
  writeFileSync(sampleDoc, Buffer.from('PK\x03\x04dummy-docx'));
  writeFileSync(sampleVideo, videoBytes);
  writeFileSync(replyVideo, videoBytes);
  writeFileSync(ignoredFile, 'console.log(1);', 'utf8');

  const compactSteps = [
    {
      step_index: 0,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: '2026-11-19T10:00:00Z',
      content: 'Generate report.docx',
    },
    {
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-19T10:00:05Z',
      thinking: '**Drafting report**\nShort thinking preview...',
      content: 'Created `report.docx` and `reply.mp4`...',
      truncated_fields: ['content', 'thinking'],
      tool_calls: [
        {
          id: 'tc-1',
          name: 'write_file',
          args: { Path: JSON.stringify(sampleDoc) },
        },
        {
          id: 'tc-2',
          name: 'view_file',
          args: { Path: JSON.stringify(sampleVideo) },
        },
      ],
    },
  ];
  const fullSteps = [
    compactSteps[0],
    {
      ...compactSteps[1],
      thinking: '**Drafting report**\nFULL_THINKING_CONTENT_VERIFIED',
      content: 'FULL_CONTENT_VERIFIED for report.docx and `reply.mp4`',
      truncated_fields: undefined,
    },
  ];
  writeFileSync(
    join(logsDir, 'transcript.jsonl'),
    compactSteps.map((s) => JSON.stringify(s)).join('\n') + '\n',
    'utf8'
  );
  writeFileSync(
    join(logsDir, 'transcript_full.jsonl'),
    fullSteps.map((s) => JSON.stringify(s)).join('\n') + '\n',
    'utf8'
  );

  // Set test env for SidecarApp
  const token = 'ws-test-token';
  process.env.ANTIGRAVITY_LS_ADDRESS = '127.0.0.1:59999';
  process.env.ANTIGRAVITY_CSRF_TOKEN = 'test-csrf';
  process.env.ANTIGRAVITY_SIDECAR_WEB_PORT = '0';
  process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN = token;
  process.env.ANTIGRAVITY_CONVERSATION_ID = convId;

  const studio = createStudioServer({
    SidecarApp,
    Response: ResponseClass,
    appDataDir,
    cacheDir,
    studioDir: __dirname,
  });

  assert.equal(
    studio.staticInfo.missing.length,
    0,
    `Missing local vendor/static files: ${studio.staticInfo.missing.join(', ')}`
  );
  assert.ok(studio.staticInfo.count > 100, 'Expected local static + cmaps routes registered');

  let httpServer;
  let testSummary;
  try {
    httpServer = await studio.app.run();
    const port = httpServer.address().port;
    const base = `http://127.0.0.1:${port}`;

    // 1. Static HTML & preload.js
    const rHome = await fetch(`${base}/`);
    assert.equal(rHome.status, 200);
    const homeHtml = await rHome.text();
    assert.ok(homeHtml.includes('/preload.js'), 'index.html must include /preload.js');
    assert.ok(homeHtml.includes('id="wsVendorBanner"'), 'index.html must include #wsVendorBanner');
    assert.ok(homeHtml.includes('id="wsVendorReloadBtn"'), 'index.html must include #wsVendorReloadBtn');
    const imageScript = homeHtml.indexOf('<script src="/previewers/image-viewer.js"></script>');
    const appScript = homeHtml.indexOf('<script src="/app.js"></script>');
    assert.ok(imageScript >= 0 && imageScript < appScript, 'image previewer must load before app.js');
    const rImagePreviewer = await fetch(base + '/previewers/image-viewer.js');
    assert.equal(rImagePreviewer.status, 200);
    assert.match(rImagePreviewer.headers.get('content-type'), /^application\/javascript/);
    assert.match(await rImagePreviewer.text(), /WSModules\.renderImagePreview/);

    assert.ok(homeHtml.includes("media-src 'self' blob:;"), 'CSP must allow local video playback');
    const videoScript = homeHtml.indexOf('<script src="/previewers/video-viewer.js"></script>');
    const textScript = homeHtml.indexOf('<script src="/previewers/text-viewer.js"></script>');
    assert.ok(
      imageScript < videoScript && videoScript < textScript && textScript < appScript,
      'video previewer must load after image-viewer.js and before text-viewer.js and app.js'
    );
    const rVideoPreviewer = await fetch(`${base}/previewers/video-viewer.js`);
    assert.equal(rVideoPreviewer.status, 200);
    assert.match(rVideoPreviewer.headers.get('content-type'), /^application\/javascript/);
    const videoPreviewerSource = await rVideoPreviewer.text();
    assert.match(videoPreviewerSource, /WSModules\.renderVideoPreview/);

    // Exercise the real controller against a minimal media API adapter. Source
    // changes reset playbackRate to defaultPlaybackRate per the HTML standard;
    // this catches restoration order without adding a browser dependency.
    {
      const { runInNewContext } = await import('node:vm');
      const { setMaxListeners } = await import('node:events');
      class PreviewNode extends EventTarget {
        constructor(tagName) {
          super();
          this.tagName = tagName.toUpperCase();
          this.children = [];
          this.classList = { toggle() {}, remove() {} };
          this.currentTime = 0;
          this.duration = 90;
          this.playbackRate = 1;
          this.defaultPlaybackRate = 1;
          this.paused = true;
          this.videoWidth = 640;
          this.videoHeight = 360;
          this.loadCalls = 0;
        }
        get options() { return this.children; }
        get src() { return this.source || ''; }
        set src(value) {
          this.source = value;
          this.playbackRate = this.defaultPlaybackRate;
        }
        append(...nodes) { this.children.push(...nodes); }
        replaceChildren(...nodes) { this.children = nodes; }
        setAttribute() {}
        removeAttribute(name) { if (name === 'src') this.source = ''; }
        focus() {}
        remove() {}
        pause() { this.paused = true; }
        load() { this.loadCalls += 1; }
      }
      class PreviewAbortController extends AbortController {
        constructor() { super(); setMaxListeners(0, this.signal); }
      }
      let videoNode, cleanup;
      const previewGlobal = {};
      runInNewContext(videoPreviewerSource, {
        window: previewGlobal,
        document: { createElement: (tag) => {
          const node = new PreviewNode(tag);
          if (tag === 'video') videoNode = node;
          return node;
        } },
        URLSearchParams,
        AbortController: PreviewAbortController,
      });
      const controller = await previewGlobal.WSModules.renderVideoPreview({
        file: { path: '/fixtures/demo.mp4', name: 'demo.mp4', size: 64, mtimeMs: 1234 },
        stageEl: new PreviewNode('div'), toolbarEl: new PreviewNode('div'),
        getWorkspaceGen: () => 7,
        prevState: { currentTime: 125, playbackRate: 1.5, muted: true, loop: true },
        registerCleanup: (fn) => { cleanup = fn; },
      });
      assert.equal(controller.getState().playbackRate, 1.5, 'loading src must preserve the saved playback rate');
      const streamQuery = new URL(videoNode.src, 'http://127.0.0.1').searchParams;
      assert.equal(streamQuery.get('path'), '/fixtures/demo.mp4');
      assert.equal(streamQuery.get('workspaceGen'), '7');
      assert.equal(streamQuery.get('v'), '1234');
      videoNode.dispatchEvent(new Event('loadedmetadata'));
      assert.equal(controller.getState().currentTime, 90, 'saved position is clamped to the new duration');
      assert.equal(controller.getState().muted, true);
      assert.equal(controller.getState().loop, true);
      cleanup();
      controller.destroy();
      assert.equal(videoNode.src, '', 'cleanup releases the media URL');
      assert.equal(videoNode.loadCalls, 1, 'cleanup is idempotent');
    }

    const prismMotionScript = homeHtml.indexOf('<script src="/prism-motion.js"></script>');
    const trajectoryScript = homeHtml.indexOf('<script src="/trajectory-view.js"></script>');
    assert.ok(
      prismMotionScript >= 0 && textScript < prismMotionScript
        && prismMotionScript < trajectoryScript && prismMotionScript < appScript,
      'prism-motion.js must load after text-viewer.js and before trajectory-view.js and app.js'
    );
    const rPrismMotion = await fetch(`${base}/prism-motion.js`);
    assert.equal(rPrismMotion.status, 200);
    assert.match(rPrismMotion.headers.get('content-type'), /^application\/javascript/);
    const prismMotionSource = await rPrismMotion.text();
    assert.match(prismMotionSource, /WSPrismMotion/);

    const rPrismCss = await fetch(`${base}/themes/obsidian-prism.css`);
    assert.equal(rPrismCss.status, 200);
    assert.match(rPrismCss.headers.get('content-type'), /^text\/css/);
    const prismCss = await rPrismCss.text();
    for (const marker of [
      '.ws-prism-indicator',
      '.ws-prism-indicator.is-gliding .ws-prism-indicator-pill',
      '.is-prism-closing',
      'wsPrismRefreshSpin',
      '[data-motion="reduced"]',
    ]) {
      assert.ok(prismCss.includes(marker), `obsidian-prism.css must include ${marker}`);
    }

    // Exercise the served controller with Node events and timers in a minimal DOM.
    {
      const { runInNewContext } = await import('node:vm');
      class PrismNode extends EventTarget {
        constructor() {
          super();
          const classes = new Set();
          this.classList = {
            add: (name) => classes.add(name),
            remove: (name) => classes.delete(name),
            contains: (name) => classes.has(name),
          };
          this.dataset = {};
          this.style = {};
        }
        setAttribute() {}
        removeAttribute() {}
      }
      const documentElement = new PrismNode();
      const pendingTimers = new Set();
      const prismWindow = {
        document: { documentElement, body: new PrismNode() },
        matchMedia: () => ({ matches: false }),
        setTimeout(callback, delay) {
          const timer = setTimeout(() => {
            pendingTimers.delete(timer);
            callback();
          }, delay);
          pendingTimers.add(timer);
          return timer;
        },
        clearTimeout(timer) {
          pendingTimers.delete(timer);
          clearTimeout(timer);
        },
      };
      const assertOverlayState = (overlay, expected, message) => {
        assert.deepEqual({
          closing: overlay.classList.contains('is-prism-closing'),
          hidden: overlay.classList.contains('is-hidden'),
        }, expected, message);
      };
      runInNewContext(prismMotionSource, { window: prismWindow });
      const api = prismWindow.WSPrismMotion;
      assert.ok(api, 'prism-motion.js must expose window.WSPrismMotion');
      try {
        for (const [skin, motion, prismActive, motionEnabled] of [
          ['default', 'full', false, false],
          ['prism', 'full', true, true],
          ['prism', 'reduced', true, false],
        ]) {
          Object.assign(documentElement.dataset, { skin, motion });
          const setting = `${skin} skin with ${motion} motion`;
          assert.equal(api.isPrismActive(), prismActive, `Prism activation for ${setting}`);
          assert.equal(api.isMotionEnabled(), motionEnabled, `Motion enabled for ${setting}`);

          if (!motionEnabled) {
            const overlay = new PrismNode();
            let doneCalls = 0;
            api.closeOverlay(overlay, { onDone: () => { doneCalls++; } });
            assertOverlayState(overlay, { closing: false, hidden: true }, `Overlay must hide synchronously with ${setting}`);
            assert.equal(doneCalls, 1, `onDone must run synchronously with ${setting}`);
          }
        }

        Object.assign(documentElement.dataset, { skin: 'prism', motion: 'full' });
        const animatedOverlay = new PrismNode();
        let animatedDoneCalls = 0;
        api.closeOverlay(animatedOverlay, { onDone: () => { animatedDoneCalls++; } });
        assertOverlayState(animatedOverlay, { closing: true, hidden: false }, 'Overlay must stay visible while closing');
        assert.equal(animatedDoneCalls, 0, 'onDone must wait for the exit animation');
        animatedOverlay.dispatchEvent(new Event('animationend'));
        assertOverlayState(animatedOverlay, { closing: false, hidden: true }, 'animationend must finish the overlay exit');
        assert.equal(animatedDoneCalls, 1, 'animationend must call onDone once');

        const repeatedOverlay = new PrismNode();
        api.closeOverlay(repeatedOverlay);
        assert.equal(pendingTimers.size, 1, 'Closing must schedule one fallback timer');
        const [exitTimer] = pendingTimers;
        api.closeOverlay(repeatedOverlay);
        assert.deepEqual([...pendingTimers], [exitTimer], 'Repeated close must keep the original fallback timer');
        assertOverlayState(repeatedOverlay, { closing: true, hidden: false }, 'Repeated close must leave the exit in progress');

        const reopenedOverlay = new PrismNode();
        let cancelledDoneCalls = 0;
        api.closeOverlay(reopenedOverlay, { onDone: () => { cancelledDoneCalls++; } });
        assertOverlayState(reopenedOverlay, { closing: true, hidden: false }, 'Overlay must be closing before reopening');
        api.openOverlay(reopenedOverlay);
        assertOverlayState(reopenedOverlay, { closing: false, hidden: false }, 'Reopening must clear both classes immediately');
        assert.equal(cancelledDoneCalls, 0, 'Reopening must not call onDone');

        await new Promise((resolve) => setTimeout(resolve, 250));
        assertOverlayState(reopenedOverlay, { closing: false, hidden: false }, 'Reopened overlay must stay visible after the fallback');
        assert.equal(cancelledDoneCalls, 0, 'Cancelled exit must not call onDone after the fallback');
        assertOverlayState(repeatedOverlay, { closing: false, hidden: true }, 'One fallback must finish the repeated close');
        assert.equal(animatedDoneCalls, 1, 'The fallback must not repeat a completed exit callback');

        api.closeOverlay(new PrismNode());
      } finally {
        try {
          api.destroy();
          assert.equal(pendingTimers.size, 0, 'Destroy must cancel pending Prism motion timers');
        } finally {
          for (const timer of pendingTimers) clearTimeout(timer);
        }
      }
    }

    const holdConfirmScript = homeHtml.indexOf('<script src="/hold-confirm.js"></script>');
    assert.ok(
      prismMotionScript < holdConfirmScript && holdConfirmScript < trajectoryScript && holdConfirmScript < appScript,
      'hold-confirm.js must load after prism-motion.js and before trajectory-view.js and app.js'
    );
    assert.match(homeHtml, /id="closeAllTabsWrap"/);
    assert.match(homeHtml, /id="closeAllHoldHint"/);

    const rHoldConfirm = await fetch(`${base}/hold-confirm.js`);
    assert.equal(rHoldConfirm.status, 200);
    assert.match(rHoldConfirm.headers.get('content-type'), /^application\/javascript/);
    const holdConfirmSource = await rHoldConfirm.text();
    assert.match(holdConfirmSource, /bindHoldConfirm/);
    assert.match(holdConfirmSource, /Copyright \(c\) 2026 guanmo-ai/);

    const rStyles = await fetch(`${base}/styles.css`);
    assert.equal(rStyles.status, 200);
    assert.match(rStyles.headers.get('content-type'), /^text\/css/);
    const stylesSource = await rStyles.text();
    for (const marker of ['is-tree-resizing', 'margin-left: calc(-1 * clamp', '.ws-hold-btn', '.ws-hold-check']) {
      assert.ok(stylesSource.includes(marker), `styles.css must include ${marker}`);
    }

    // A virtual clock and reduced motion make hold thresholds and timer cleanup deterministic.
    {
      const { runInNewContext } = await import('node:vm');
      class HoldNode extends EventTarget {
        attributes = new Map();
        getAttribute(name) { return this.attributes.get(name) ?? null; }
        setAttribute(name, value) { this.attributes.set(name, value); }
        removeAttribute(name) { this.attributes.delete(name); }
      }
      const duration = 1100;
      const tapThreshold = 240;
      const hintDuration = 1400;
      const doneDuration = 720;
      const fill = { style: {} };
      const button = new HoldNode();
      const hintEl = new HoldNode();
      button.disabled = false;
      button.querySelector = (selector) => selector === '.ws-hold-fill' ? fill : null;
      button.setAttribute('aria-label', 'Hold to close all tabs');

      let time = 0;
      let nextTimerId = 0;
      const pendingTimers = new Map();
      const holdWindow = Object.assign(new EventTarget(), {
        document: new EventTarget(),
        matchMedia: () => ({ matches: true }),
        performance: { now: () => time },
        setTimeout(callback, delay) {
          const id = ++nextTimerId;
          pendingTimers.set(id, { callback, at: time + delay });
          return id;
        },
        clearTimeout(id) { pendingTimers.delete(id); },
      });
      async function advance(ms) {
        const end = time + ms;
        for (;;) {
          const next = [...pendingTimers].sort(([, a], [, b]) => a.at - b.at)[0];
          if (!next || next[1].at > end) break;
          const [id, { callback, at }] = next;
          time = at;
          pendingTimers.delete(id);
          await callback();
        }
        time = end;
      }
      const dispatch = (target, type, props) =>
        target.dispatchEvent(Object.assign(new Event(type, { cancelable: true }), props));
      const pointer = (type) => dispatch(button, type, { button: 0, isPrimary: true, pointerId: 1, pointerType: 'mouse' });
      const keyEvent = (type, key, repeat = false) => dispatch(button, type, { key, repeat });

      runInNewContext(holdConfirmSource, { window: holdWindow });
      let allowed = true;
      let confirmCalls = 0;
      let doneEndCalls = 0;
      const bind = () => holdWindow.WSModules.bindHoldConfirm({
        button, hintEl, duration, tapThreshold, hintDuration, doneDuration,
        onBeforeConfirm: async () => allowed,
        onConfirm: async () => { confirmCalls++; },
        onDoneEnd: () => { doneEndCalls++; },
      });
      const hold = bind();

      pointer('pointerdown');
      await advance(tapThreshold - 1);
      pointer('pointerup');
      assert.equal(hintEl.getAttribute('data-show'), '', 'A short tap must reveal the hold hint');
      assert.equal(dispatch(button, 'click'), false, 'A short tap must suppress the native click');
      assert.equal(confirmCalls, 0, 'A short tap must not confirm');
      await advance(hintDuration);
      assert.equal(hintEl.getAttribute('data-show'), null, 'The short-tap hint must expire');

      pointer('pointerdown');
      await advance(tapThreshold);
      pointer('pointerup');
      assert.equal(button.getAttribute('data-holding'), null, 'Early release must clear the holding state');
      assert.equal(fill.style.scale, '0 1', 'Early release must reset the progress fill');
      assert.equal(hintEl.getAttribute('data-show'), null, 'Release at the tap threshold must not show a hint');
      await advance(duration);
      assert.equal(confirmCalls, 0, 'Early release must cancel confirmation');

      pointer('pointerdown');
      await advance(duration);
      assert.equal(button.getAttribute('data-done'), '', 'A full hold must mark the button done');
      assert.equal(hold.isDone(), true, 'The app must be able to observe the done state');
      assert.equal(confirmCalls, 1, 'A full hold must confirm once');
      pointer('pointerup');
      await advance(doneDuration - 1);
      assert.equal(button.getAttribute('data-done'), '', 'The done state must persist for the configured duration');
      assert.equal(doneEndCalls, 0, 'onDoneEnd must wait for the done state to expire');
      await advance(1);
      assert.equal(button.getAttribute('data-done'), null, 'The done state must clear at the end of its duration');
      assert.equal(hold.isDone(), false);
      assert.equal(doneEndCalls, 1, 'onDoneEnd must fire once after the done state');
      assert.equal(button.getAttribute('aria-label'), 'Hold to close all tabs');

      for (const key of [' ', 'Enter']) {
        const before = confirmCalls;
        keyEvent('keydown', key, true);
        assert.equal(hold.isHolding(), false, 'A repeated keydown must not start a hold');
        keyEvent('keydown', key);
        assert.equal(hold.isHolding(), true, `${JSON.stringify(key)} must start a keyboard hold`);
        await advance(duration - 1);
        assert.equal(confirmCalls, before, 'Keyboard confirmation must wait for a full hold');
        keyEvent('keydown', key, true);
        await advance(1);
        assert.equal(confirmCalls, before + 1, 'Key repeat must not restart the hold timer');
        assert.equal(button.getAttribute('data-done'), '');
        keyEvent('keyup', key);
        await advance(doneDuration);
      }

      for (const target of [button, holdWindow]) {
        keyEvent('keydown', ' ');
        await advance(tapThreshold);
        dispatch(target, 'blur');
        assert.equal(button.getAttribute('data-holding'), null, 'Blur must clear the holding state');
        assert.equal(fill.style.scale, '0 1', 'Blur must reset the progress fill');
        await advance(duration);
        assert.equal(confirmCalls, 3, 'Blur must cancel confirmation');
      }

      allowed = false;
      pointer('pointerdown');
      await advance(duration);
      assert.equal(button.getAttribute('data-done'), null, 'Declined confirmation must not enter the done state');
      assert.equal(confirmCalls, 3, 'Declined confirmation must not call onConfirm');
      assert.equal(fill.style.scale, '0 1', 'Declined confirmation must reset the progress fill');
      hold.destroy();

      allowed = true;
      for (const [phase, elapsed] of [['hold', 0], ['hint', tapThreshold - 1], ['done', duration]]) {
        const controller = bind();
        pointer('pointerdown');
        await advance(elapsed);
        if (phase === 'hint') pointer('pointerup');
        assert.equal(pendingTimers.size, 1, `The ${phase} timer must be pending before destruction`);
        const before = [confirmCalls, doneEndCalls];
        controller.destroy();
        assert.equal(pendingTimers.size, 0, `Destroy must clear the ${phase} timer`);
        assert.equal(button.getAttribute('data-holding'), null);
        assert.equal(button.getAttribute('data-done'), null);
        assert.equal(hintEl.getAttribute('data-show'), null);
        pointer('pointerdown');
        await advance(duration + hintDuration + doneDuration);
        assert.deepEqual([confirmCalls, doneEndCalls], before, 'Destroy must disable further hold callbacks');
      }
    }

    const rPreload = await fetch(`${base}/preload.js`);
    assert.equal(rPreload.status, 200);

    // 2. Health
    const rHealth = await fetch(`${base}/api/health`);
    assert.equal(rHealth.status, 200);
    const healthJson = await rHealth.json();
    assert.equal(healthJson.success, true);
    assert.equal(healthJson.vendorReady, true, 'Healthy studio must report vendorReady=true');
    assert.equal(healthJson.missingVendorCount, 0, 'Healthy studio must report 0 missing vendors');
    assert.deepEqual(healthJson.missingVendorAssets, [], 'Healthy studio must report empty missingVendorAssets');

    // UI preferences (defaults, authentication, validation, and disk persistence).
    const prefsUrl = `${base}/api/ui/prefs`;
    const getUiPrefs = async () => {
      const response = await fetch(prefsUrl);
      assert.equal(response.status, 200, 'GET UI preferences');
      return response.json();
    };
    const postUiPrefsJson = (body, auth = true) =>
      fetch(prefsUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(auth ? { 'X-Sidecar-Token': token } : {}),
        },
        body,
      });
    const postUiPrefs = (patch, auth = true) => postUiPrefsJson(JSON.stringify(patch), auth);
    const defaultPrefs = { skin: 'default', prismVariant: 'auto', motion: 'full' };
    assert.deepEqual(await getUiPrefs(), { success: true, prefs: defaultPrefs });
    assert.equal(studio.uiPrefs.getFilePath(), prefsPath, 'UI preferences stay inside the test root');
    assert.equal(existsSync(prefsPath), false, 'reading defaults does not create a file');

    const customPrefs = { skin: 'prism', prismVariant: 'warm-charcoal', motion: 'reduced' };
    const prefsUnauth = await postUiPrefs(customPrefs, false);
    assert.equal(prefsUnauth.status, 401, 'POST UI preferences requires a token');
    assert.equal(existsSync(prefsPath), false, 'unauthorized POST does not create a file');

    const prefsSaved = await postUiPrefs(customPrefs);
    assert.equal(prefsSaved.status, 200, 'POST UI preferences');
    assert.deepEqual(await prefsSaved.json(), { success: true, prefs: customPrefs });
    assert.deepEqual(JSON.parse(readFileSync(prefsPath, 'utf8')), customPrefs);
    assert.deepEqual(await getUiPrefs(), { success: true, prefs: customPrefs });
    assert.deepEqual(new UiPrefsStore({ dataDir: prefsDataDir }).load(), customPrefs);

    const partialPrefs = await postUiPrefs({ prismVariant: 'daylight-crystal' });
    const mergedPrefs = { skin: 'prism', prismVariant: 'daylight-crystal', motion: 'reduced' };
    assert.equal(partialPrefs.status, 200, 'POST partial UI preferences');
    assert.deepEqual(await partialPrefs.json(), { success: true, prefs: mergedPrefs });
    const persistedPrefs = readFileSync(prefsPath, 'utf8');
    assert.deepEqual(JSON.parse(persistedPrefs), mergedPrefs);

    const invalidPrefs = [
      [{ skin: 'neon' }, 'Invalid skin value'],
      [{ prismVariant: 'bad' }, 'Invalid prismVariant value'],
      [{ skin: 'default', motion: 'turbo' }, 'Invalid motion value'],
      [{ foo: 'bar' }, 'Unsupported UI preference key: foo'],
      [null, 'Invalid UI preferences payload: expected a JSON object'],
      [[], 'Invalid UI preferences payload: expected a JSON object'],
    ];
    for (const [patch, error] of invalidPrefs) {
      const response = await postUiPrefs(patch);
      assert.equal(response.status, 400, `rejects UI preferences ${JSON.stringify(patch)}`);
      assert.deepEqual(await response.json(), { success: false, error });
      assert.equal(readFileSync(prefsPath, 'utf8'), persistedPrefs);
    }
    const malformedPrefs = await postUiPrefsJson('{not-json');
    assert.equal(malformedPrefs.status, 400, 'rejects malformed UI preferences JSON');
    const deepPrefs = await postUiPrefsJson(`{"foo":${'['.repeat(12_000)}null${']'.repeat(12_000)}}`);
    assert.equal(deepPrefs.status, 400, 'rejects deeply nested unknown preferences');
    assert.equal(readFileSync(prefsPath, 'utf8'), persistedPrefs);
    assert.deepEqual(await getUiPrefs(), { success: true, prefs: mergedPrefs });

    writeFileSync(prefsPath, JSON.stringify({ skin: 'prism', prismVariant: 'bad', foo: 'bar' }), 'utf8');
    assert.deepEqual(await getUiPrefs(), {
      success: true,
      prefs: { skin: 'prism', prismVariant: 'auto', motion: 'full' },
    });
    writeFileSync(prefsPath, '{not-json', 'utf8');
    assert.deepEqual(await getUiPrefs(), { success: true, prefs: defaultPrefs });

    // 3. Unauthorized POST must return 401
    const rUnauth = await fetch(`${base}/api/workspace/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceUris: [pathToFileURL(wsDir).href] }),
    });
    assert.equal(rUnauth.status, 401);

    // 4. Authorized POST register
    const rReg = await fetch(`${base}/api/workspace/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Sidecar-Token': token,
      },
      body: JSON.stringify({ workspaceUris: [pathToFileURL(wsDir).href] }),
    });
    assert.equal(rReg.status, 200);
    const regJson = await rReg.json();
    assert.equal(regJson.roots.length, 1);

    // 5. Tree & search (ignored hidden vs shown)
    const rTree = await fetch(
      `${base}/api/workspace/tree?root=${encodeURIComponent(wsDir)}&showIgnored=0`
    );
    assert.equal(rTree.status, 200);
    const treeJson = await rTree.json();
    assert.ok(treeJson.items.some((i) => i.name === 'README.md'));
    assert.ok(treeJson.items.some((i) => i.name === 'demo.mp4' && i.category === 'video'));
    assert.ok(!treeJson.items.some((i) => i.name === 'node_modules'));

    const rSearch = await fetch(
      `${base}/api/workspace/search?root=${encodeURIComponent(wsDir)}&q=report`
    );
    assert.equal(rSearch.status, 200);
    const searchJson = await rSearch.json();
    assert.equal(searchJson.items[0].name, 'report.docx');

    // 6. Raw file & path traversal rejection
    const rRawOk = await fetch(`${base}/api/file/raw?path=${encodeURIComponent(sampleMd)}`);
    assert.equal(rRawOk.status, 200);
    assert.equal(await rRawOk.text(), '# Hello Sidecar Studio\n');

    const escapePath = join(wsDir, '..', 'outside.txt');
    writeFileSync(escapePath, 'nope', 'utf8');
    const rRawDeny = await fetch(`${base}/api/file/raw?path=${encodeURIComponent(escapePath)}`);
    assert.equal(rRawDeny.status, 403);

    // 6a. MP4 streaming: full bodies, HEAD, byte ranges, and security boundaries.
    const streamUrl = `${base}/api/file/stream?path=${encodeURIComponent(sampleVideo)}`;
    const rVideo = await fetch(streamUrl);
    assert.equal(rVideo.status, 200);
    assert.equal(rVideo.headers.get('content-type'), 'video/mp4');
    assert.equal(rVideo.headers.get('accept-ranges'), 'bytes');
    assert.equal(rVideo.headers.get('content-length'), '64');
    assert.equal(rVideo.headers.get('cache-control'), 'no-store');
    assert.equal(rVideo.headers.get('content-security-policy'), "default-src 'none'; sandbox");
    assert.equal(rVideo.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(rVideo.headers.get('x-file-size'), '64');
    assert.equal(rVideo.headers.get('x-file-mtime'), String(statSync(sampleVideo).mtimeMs));
    assert.ok(rVideo.headers.get('x-file-version'));
    assert.deepEqual(Buffer.from(await rVideo.arrayBuffer()), videoBytes);

    const rVideoHead = await fetch(streamUrl, { method: 'HEAD' });
    assert.equal(rVideoHead.status, 200);
    assert.equal(rVideoHead.headers.get('content-length'), '64');
    assert.equal((await rVideoHead.arrayBuffer()).byteLength, 0);

    for (const [range, expectedRange, expectedBytes] of [
      ['bytes=0-9', 'bytes 0-9/64', videoBytes.subarray(0, 10)],
      ['bytes=-8', 'bytes 56-63/64', videoBytes.subarray(56)],
      ['bytes=60-', 'bytes 60-63/64', videoBytes.subarray(60)],
      ['bytes=60-999', 'bytes 60-63/64', videoBytes.subarray(60)],
      ['bytes=-999', 'bytes 0-63/64', videoBytes],
      ['  BYTES=0-0  ', 'bytes 0-0/64', videoBytes.subarray(0, 1)],
    ]) {
      const response = await fetch(streamUrl, { headers: { Range: range } });
      assert.equal(response.status, 206, range);
      assert.equal(response.headers.get('content-range'), expectedRange, range);
      assert.equal(response.headers.get('content-length'), String(expectedBytes.length), range);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), expectedBytes, range);
    }

    const rVideoHeadRange = await fetch(streamUrl, { method: 'HEAD', headers: { Range: 'bytes=0-9' } });
    assert.equal(rVideoHeadRange.status, 206);
    assert.equal(rVideoHeadRange.headers.get('content-range'), 'bytes 0-9/64');
    assert.equal(rVideoHeadRange.headers.get('content-length'), '10');
    assert.equal((await rVideoHeadRange.arrayBuffer()).byteLength, 0);

    for (const range of [
      'bytes=99999-', 'bytes=10-9', 'bytes=-0', 'bytes=-', 'bytes=0-1,4-5',
      'items=0-9', 'bytes=abc-9', 'bytes=9007199254740992-', 'bytes=-9007199254740992',
    ]) {
      const response = await fetch(streamUrl, { headers: { Range: range } });
      assert.equal(response.status, 416, range);
      assert.equal(response.headers.get('content-range'), 'bytes */64', range);
      assert.deepEqual(await response.json(), { success: false, error: 'Range Not Satisfiable' }, range);
    }
    const rVideoHeadInvalid = await fetch(streamUrl, { method: 'HEAD', headers: { Range: 'bytes=99999-' } });
    assert.equal(rVideoHeadInvalid.status, 416);
    assert.equal(rVideoHeadInvalid.headers.get('content-range'), 'bytes */64');
    assert.equal((await rVideoHeadInvalid.arrayBuffer()).byteLength, 0);

    const emptyVideo = join(wsDir, 'empty.MP4');
    writeFileSync(emptyVideo, Buffer.alloc(0));
    const emptyStreamUrl = `${base}/api/file/stream?path=${encodeURIComponent(emptyVideo)}`;
    const rVideoEmpty = await fetch(emptyStreamUrl);
    assert.equal(rVideoEmpty.status, 200);
    assert.equal(rVideoEmpty.headers.get('content-type'), 'video/mp4');
    assert.equal(rVideoEmpty.headers.get('content-length'), '0');
    assert.equal((await rVideoEmpty.arrayBuffer()).byteLength, 0);
    const rVideoEmptyRange = await fetch(emptyStreamUrl, { headers: { Range: 'bytes=0-' } });
    assert.equal(rVideoEmptyRange.status, 416);
    assert.equal(rVideoEmptyRange.headers.get('content-range'), 'bytes */0');
    await rVideoEmptyRange.arrayBuffer();

    // Files above /api/file/raw's 128 MiB cap remain streamable without buffering.
    const largeVideo = join(wsDir, 'large.mp4');
    writeFileSync(largeVideo, Buffer.alloc(0));
    truncateSync(largeVideo, 129 * 1024 * 1024);
    const largeStreamUrl = `${base}/api/file/stream?path=${encodeURIComponent(largeVideo)}`;
    const rVideoLargeHead = await fetch(largeStreamUrl, { method: 'HEAD' });
    assert.equal(rVideoLargeHead.status, 200);
    assert.equal(rVideoLargeHead.headers.get('content-length'), '135266304');
    assert.equal((await rVideoLargeHead.arrayBuffer()).byteLength, 0);
    const rVideoLargeTail = await fetch(largeStreamUrl, { headers: { Range: 'bytes=135266303-' } });
    assert.equal(rVideoLargeTail.status, 206);
    assert.equal(rVideoLargeTail.headers.get('content-range'), 'bytes 135266303-135266303/135266304');
    assert.deepEqual(Buffer.from(await rVideoLargeTail.arrayBuffer()), Buffer.from([0]));

    for (const [path, expectedStatus] of [[sampleMd, 415], [escapePath, 403], [join(wsDir, 'missing.mp4'), 404]]) {
      for (const method of ['GET', 'HEAD']) {
        const response = await fetch(`${base}/api/file/stream?path=${encodeURIComponent(path)}`, { method });
        assert.equal(response.status, expectedStatus, `${method} ${path}`);
        const body = await response.arrayBuffer();
        if (method === 'HEAD') assert.equal(body.byteLength, 0);
        else assert.equal(JSON.parse(Buffer.from(body).toString()).success, false);
      }
    }
    const rVideoStale = await fetch(`${streamUrl}&workspaceGen=0`);
    assert.equal(rVideoStale.status, 409);
    await rVideoStale.arrayBuffer();

    const brainVideo = join(appDataDir, 'brain', convId, 'clip.mp4');
    writeFileSync(brainVideo, videoBytes);
    const rBrainVideo = await fetch(`${base}/api/file/stream?path=${encodeURIComponent(brainVideo)}`);
    assert.equal(rBrainVideo.status, 200);
    assert.deepEqual(Buffer.from(await rBrainVideo.arrayBuffer()), videoBytes);
    const otherVideoConvId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const otherVideoDir = join(appDataDir, 'brain', otherVideoConvId);
    mkdirSync(otherVideoDir, { recursive: true });
    const otherVideo = join(otherVideoDir, 'clip.mp4');
    writeFileSync(otherVideo, videoBytes);
    const rOtherVideo = await fetch(
      `${base}/api/file/stream?path=${encodeURIComponent(otherVideo)}&conversationId=${otherVideoConvId}`
    );
    assert.equal(rOtherVideo.status, 403, 'query parameters cannot select a different conversation');
    await rOtherVideo.arrayBuffer();

    const sysHosts = 'C:\\Windows\\System32\\drivers\\etc\\hosts';
    if (existsSync(sysHosts)) {
      const rSysDeny = await fetch(`${base}/api/file/raw?path=${encodeURIComponent(sysHosts)}`);
      assert.equal(rSysDeny.status, 403);
    }

    const rBadCache = await fetch(`${base}/api/doc/cache-pdf?key=../../etc/passwd`);
    assert.equal(rBadCache.status, 400);

    // 7. Transcript steps, on-demand full step, and produced docs
    const rTr = await fetch(
      `${base}/api/transcript/steps?conversationId=${encodeURIComponent(convId)}`
    );
    assert.equal(rTr.status, 200);
    const trJson = await rTr.json();
    assert.equal(trJson.steps.length, 2);
    assert.equal(trJson.steps[1].hasFull, true);
    for (const name of ['demo.mp4', 'reply.mp4']) {
      assert.ok(trJson.steps[1].files.some((file) => file.name === name && file.category === 'video' && file.isDoc));
    }

    const rFull = await fetch(
      `${base}/api/transcript/full?conversationId=${encodeURIComponent(convId)}&stepIndex=1`
    );
    assert.equal(rFull.status, 200);
    const fullJson = await rFull.json();
    assert.ok(fullJson.detail.content.includes('FULL_CONTENT_VERIFIED'));
    assert.ok(fullJson.detail.thinking.includes('FULL_THINKING_CONTENT_VERIFIED'));

    const rProd = await fetch(
      `${base}/api/doc/produced?conversationId=${encodeURIComponent(convId)}`
    );
    assert.equal(rProd.status, 200);
    const prodJson = await rProd.json();
    assert.ok(prodJson.docs.some((d) => d.name === 'report.docx'));
    for (const name of ['demo.mp4', 'reply.mp4', 'clip.mp4']) {
      assert.ok(prodJson.docs.some((file) => file.name === name && file.category === 'video' && file.isDoc));
    }

    // 8. POST /api/file/save (auth, traversal, optimistic conflict, UTF-8 & Base64 atomic save)
    const rSaveUnauth = await fetch(`${base}/api/file/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: sampleMd, content: 'unauth' }),
    });
    assert.equal(rSaveUnauth.status, 401);

    const rSaveDeny = await fetch(`${base}/api/file/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Sidecar-Token': token },
      body: JSON.stringify({ path: escapePath, content: 'deny' }),
    });
    assert.equal(rSaveDeny.status, 403);

    const rSaveConflict = await fetch(`${base}/api/file/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Sidecar-Token': token },
      body: JSON.stringify({
        path: sampleMd,
        content: '# Stale',
        encoding: 'utf8',
        baseMtimeMs: 100,
        force: false,
      }),
    });
    assert.equal(rSaveConflict.status, 409);

    const mdStat = statSync(sampleMd);
    const rSaveMd = await fetch(`${base}/api/file/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Sidecar-Token': token },
      body: JSON.stringify({
        path: sampleMd,
        content: '# Updated Markdown\n',
        encoding: 'utf8',
        baseMtimeMs: mdStat.mtimeMs,
      }),
    });
    assert.equal(rSaveMd.status, 200);
    const saveMdJson = await rSaveMd.json();
    assert.equal(saveMdJson.success, true);
    assert.equal(readFileSync(sampleMd, 'utf8'), '# Updated Markdown\n');

    const docStat = statSync(sampleDoc);
    const updatedDocBytes = Buffer.from('PK\x03\x04updated-docx');
    const rSaveDoc = await fetch(`${base}/api/file/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Sidecar-Token': token },
      body: JSON.stringify({
        path: sampleDoc,
        content: updatedDocBytes.toString('base64'),
        encoding: 'base64',
        baseMtimeMs: docStat.mtimeMs,
      }),
    });
    assert.equal(rSaveDoc.status, 200);
    assert.equal(readFileSync(sampleDoc).equals(updatedDocBytes), true);

    // 9. Codex Security & Data-Integrity Regression Tests
    // 9a. Raw HTML serves as text/plain + nosniff + attachment + sandbox CSP; maxBytes truncates
    const sampleHtml = join(wsDir, 'evil.html');
    const bigTxt = join(wsDir, 'big.txt');
    writeFileSync(sampleHtml, '<script>alert(1)</script>', 'utf8');
    writeFileSync(bigTxt, 'A'.repeat(4096), 'utf8');
    const rRawHtml = await fetch(`${base}/api/file/raw?path=${encodeURIComponent(sampleHtml)}`);
    assert.equal(rRawHtml.status, 200);
    assert.equal(rRawHtml.headers.get('content-type'), 'text/plain; charset=utf-8');
    assert.equal(rRawHtml.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(rRawHtml.headers.get('content-disposition'), 'attachment');
    assert.ok((rRawHtml.headers.get('content-security-policy') || '').includes('sandbox'));

    const rRawTrunc = await fetch(
      `${base}/api/file/raw?path=${encodeURIComponent(bigTxt)}&maxBytes=1024`
    );
    assert.equal(rRawTrunc.status, 200);
    assert.equal(rRawTrunc.headers.get('x-file-truncated'), '1');
    assert.equal((await rRawTrunc.text()).length, 1024);

    // 9b. Tree refuses dir outside selected root even when another root is registered
    const wsDir2 = join(tmpRoot, 'workspace2');
    mkdirSync(wsDir2, { recursive: true });
    await fetch(`${base}/api/workspace/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Sidecar-Token': token },
      body: JSON.stringify({ workspaceUris: [pathToFileURL(wsDir).href, pathToFileURL(wsDir2).href] }),
    });
    const rCrossTree = await fetch(
      `${base}/api/workspace/tree?root=${encodeURIComponent(wsDir)}&dir=${encodeURIComponent(wsDir2)}`
    );
    assert.equal(rCrossTree.status, 403);

    // 9c. brain/<convId> is readable via raw, but blocked from /api/file/save
    const brainNote = join(appDataDir, 'brain', convId, 'note.md');
    writeFileSync(brainNote, '# Brain Note\n', 'utf8');
    const rBrainRead = await fetch(`${base}/api/file/raw?path=${encodeURIComponent(brainNote)}`);
    assert.equal(rBrainRead.status, 200);
    const brainStat = statSync(brainNote);
    const rBrainSave = await fetch(`${base}/api/file/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Sidecar-Token': token },
      body: JSON.stringify({
        path: brainNote,
        content: 'hijacked',
        encoding: 'utf8',
        baseMtimeMs: brainStat.mtimeMs,
      }),
    });
    assert.equal(rBrainSave.status, 403);

    // Host-bound conversationId cannot be overridden via query parameter
    const conv2 = '22222222-3333-4444-5555-666666666666';
    const logs2 = join(appDataDir, 'brain', conv2, '.system_generated', 'logs');
    mkdirSync(logs2, { recursive: true });
    writeFileSync(join(logs2, 'transcript.jsonl'), JSON.stringify(compactSteps[0]) + '\n', 'utf8');
    const rConvHijack = await fetch(
      `${base}/api/transcript/steps?conversationId=${encodeURIComponent(conv2)}`
    );
    assert.equal(rConvHijack.status, 200);
    assert.equal((await rConvHijack.json()).conversationId, convId);

    // 9d. Strict optimistic lock rejects 20ms stale timestamp, missing baseMtimeMs, & mismatched expectedConflictMtimeMs
    const latestMdStat = statSync(sampleMd);
    const r20ms = await fetch(`${base}/api/file/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Sidecar-Token': token },
      body: JSON.stringify({
        path: sampleMd,
        content: '# 20ms stale',
        encoding: 'utf8',
        baseMtimeMs: latestMdStat.mtimeMs - 20,
      }),
    });
    assert.equal(r20ms.status, 409);

    const rNoBase = await fetch(`${base}/api/file/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Sidecar-Token': token },
      body: JSON.stringify({ path: sampleMd, content: '# No Base', encoding: 'utf8' }),
    });
    assert.equal(rNoBase.status, 400);

    const rBadForce = await fetch(`${base}/api/file/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Sidecar-Token': token },
      body: JSON.stringify({
        path: sampleMd,
        content: '# Force stale',
        encoding: 'utf8',
        force: true,
        expectedConflictMtimeMs: latestMdStat.mtimeMs - 20,
      }),
    });
    assert.equal(rBadForce.status, 409);

    // 9e. Chunked multi-byte UTF-8 POST decodes cleanly without U+FFFD, invalid Base64 rejected
    const rBadB64 = await fetch(`${base}/api/file/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Sidecar-Token': token },
      body: JSON.stringify({
        path: sampleDoc,
        content: 'not@valid!base64',
        encoding: 'base64',
        baseMtimeMs: statSync(sampleDoc).mtimeMs,
      }),
    });
    assert.equal(rBadB64.status, 400);

    const chunkPayload = JSON.stringify({
      path: sampleMd,
      content: '中文分片测试OK',
      encoding: 'utf8',
      baseMtimeMs: statSync(sampleMd).mtimeMs,
    });
    const payloadBuf = Buffer.from(chunkPayload, 'utf8');
    const splitAt = payloadBuf.indexOf(Buffer.from('中', 'utf8')) + 1;
    const chunkRes = await new Promise((resolveReq, rejectReq) => {
      const req = httpRequest(
        `${base}/api/file/save`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Sidecar-Token': token,
            'Content-Length': String(payloadBuf.length),
          },
        },
        (res) => {
          let out = '';
          res.setEncoding('utf8');
          res.on('data', (c) => { out += c; });
          res.on('end', () => resolveReq({ status: res.statusCode, body: out }));
        }
      );
      req.on('error', rejectReq);
      req.write(payloadBuf.subarray(0, splitAt));
      setTimeout(() => {
        req.write(payloadBuf.subarray(splitAt));
        req.end();
      }, 10);
    });
    assert.equal(chunkRes.status, 200);
    assert.equal(readFileSync(sampleMd, 'utf8'), '中文分片测试OK');

    // 9f. Cached PDF authorization across root change
    const dummyKey = '0123456789abcdef0123456789abcdef';
    writeFileSync(join(cacheDir, `${dummyKey}.pdf`), '%PDF-1.4\n', 'utf8');
    writeFileSync(
      join(cacheDir, `${dummyKey}.meta.json`),
      JSON.stringify({ absPath: join(wsDir2, 'deck.pptx'), mtimeMs: 1, size: 1, engine: 'test' }),
      'utf8'
    );
    const rCacheOk = await fetch(`${base}/api/doc/cache-pdf?key=${dummyKey}`);
    assert.equal(rCacheOk.status, 200);
    assert.equal(rCacheOk.headers.get('x-content-type-options'), 'nosniff');
    // Unregister wsDir2 -> cache PDF for wsDir2 must now return 403
    await fetch(`${base}/api/workspace/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Sidecar-Token': token },
      body: JSON.stringify({ workspaceUris: [pathToFileURL(wsDir).href] }),
    });
    const rCacheDeny = await fetch(`${base}/api/doc/cache-pdf?key=${dummyKey}`);
    assert.equal(rCacheDeny.status, 403);

    // 10. Round-2 Final Review Regression Tests
    // 10a. Medium 1: 8 MiB Base64 save succeeds without RegExp stack overflow
    const bin8M = randomBytes(8 * 1024 * 1024);
    const bigBinPath = join(wsDir, 'big8m.bin');
    writeFileSync(bigBinPath, Buffer.from('init'));
    const rBigStat = await fetch(`${base}/api/file/stat?path=${encodeURIComponent(bigBinPath)}`);
    const bigStatJson = await rBigStat.json();
    const rBigSave = await fetch(`${base}/api/file/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Sidecar-Token': token },
      body: JSON.stringify({
        path: bigBinPath,
        content: bin8M.toString('base64'),
        encoding: 'base64',
        baseMtimeMs: bigStatJson.mtimeMs,
        baseVersion: bigStatJson.version,
      }),
    });
    assert.equal(rBigSave.status, 200);
    assert.equal(readFileSync(bigBinPath).equals(bin8M), true);

    // 10b. High 6: Same-mtimeMs external edit caught by baseVersion content hash; force requires baseline
    const verFile = join(wsDir, 'versioned.txt');
    writeFileSync(verFile, 'original-v1', 'utf8');
    const stV1 = statSync(verFile);
    const rVerStat = await fetch(`${base}/api/file/stat?path=${encodeURIComponent(verFile)}`);
    const verStatJson = await rVerStat.json();
    assert.ok(verStatJson.version);
    // Simulate backup overwrite with identical size & mtime
    writeFileSync(verFile, 'mutated--v2', 'utf8');
    utimesSync(verFile, new Date(stV1.atimeMs), new Date(stV1.mtimeMs));
    const rSameMtimeConflict = await fetch(`${base}/api/file/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Sidecar-Token': token },
      body: JSON.stringify({
        path: verFile,
        content: 'client-edit',
        encoding: 'utf8',
        baseMtimeMs: stV1.mtimeMs,
        baseVersion: verStatJson.version,
      }),
    });
    assert.equal(rSameMtimeConflict.status, 409);
    const conflictJson = await rSameMtimeConflict.json();
    assert.ok(conflictJson.currentVersion && conflictJson.currentVersion !== verStatJson.version);

    const rForceNoBase = await fetch(`${base}/api/file/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Sidecar-Token': token },
      body: JSON.stringify({
        path: verFile,
        content: 'blind-force',
        encoding: 'utf8',
        force: true,
      }),
    });
    assert.equal(rForceNoBase.status, 400);

    const rForceWithVer = await fetch(`${base}/api/file/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Sidecar-Token': token },
      body: JSON.stringify({
        path: verFile,
        content: 'confirmed-force',
        encoding: 'utf8',
        force: true,
        expectedConflictMtimeMs: conflictJson.currentMtimeMs,
        expectedConflictVersion: conflictJson.currentVersion,
      }),
    });
    assert.equal(rForceWithVer.status, 200);
    assert.equal(readFileSync(verFile, 'utf8'), 'confirmed-force');

    // 10c. High 7 & Medium 4: Stale workspace generation & token-authenticated POST /api/doc/convert
    const curGen = studio.security.getGeneration();
    const rStaleReg = await fetch(`${base}/api/workspace/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Sidecar-Token': token },
      body: JSON.stringify({
        workspaceUris: [pathToFileURL(wsDir2).href],
        generation: curGen - 1,
      }),
    });
    assert.equal(rStaleReg.status, 200);
    assert.equal((await rStaleReg.json()).applied, false);

    const lockedSec = new SecurityManager({ hostWorkspaceUris: [wsDir] });
    const lockedRes = lockedSec.registerWorkspaceUris([pathToFileURL(wsDir2).href]);
    assert.equal(lockedRes.roots.length, 0, 'Host-locked security must reject roots outside lock');

    const rConvUnauth = await fetch(`${base}/api/doc/convert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: sampleMd }),
    });
    assert.equal(rConvUnauth.status, 401);

    const rConvStale = await fetch(`${base}/api/doc/convert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Sidecar-Token': token },
      body: JSON.stringify({ path: sampleMd, workspaceGen: curGen - 1 }),
    });
    assert.equal(rConvStale.status, 409);

    // 10d. High 8 & Medium 2: Strict host conv binding, Aux Pane discovery opt-out, & same-size transcript rewrite detection
    const missingConv = '99999999-8888-7777-6666-555555555555';
    const resMissingHost = resolveConversationId(appDataDir, missingConv);
    assert.equal(resMissingHost.conversationId, missingConv);
    assert.equal(resMissingHost.source, 'host');
    assert.equal(resMissingHost.exists, false);

    process.env.ANTIGRAVITY_DISABLE_CONV_DISCOVERY = '1';
    try {
      const resDisabled = resolveConversationId(appDataDir, '');
      assert.equal(resDisabled.conversationId, '');
      assert.equal(resDisabled.source, 'none');
    } finally {
      delete process.env.ANTIGRAVITY_DISABLE_CONV_DISCOVERY;
    }

    const resDiscovered = resolveConversationId(appDataDir, '');
    assert.ok(resDiscovered.conversationId, 'Global Aux Pane mode discovers active local conversation when host ID is empty');
    assert.equal(resDiscovered.source, 'fallback');

    const trPath = join(logsDir, 'transcript.jsonl');
    const padA = 'A'.repeat(40);
    const padB = 'B'.repeat(40);
    const stepA = [
      compactSteps[0],
      { ...compactSteps[1], content: `prefix-${padA}-first` },
    ];
    const stepB = [
      compactSteps[0],
      { ...compactSteps[1], content: `prefix-${padB}-secnd` },
    ];
    const txtA = stepA.map((s) => JSON.stringify(s)).join('\n') + '\n';
    const txtB = stepB.map((s) => JSON.stringify(s)).join('\n') + '\n';
    assert.equal(Buffer.byteLength(txtA), Buffer.byteLength(txtB));
    writeFileSync(trPath, txtA, 'utf8');
    const rTrA = await fetch(`${base}/api/transcript/steps?force=1`);
    const trJsonA = await rTrA.json();
    assert.ok(trJsonA.steps[1].content.includes(padA));
    writeFileSync(trPath, txtB, 'utf8');
    const rTrB = await fetch(`${base}/api/transcript/steps?force=1`);
    const trJsonB = await rTrB.json();
    assert.ok(trJsonB.steps[1].content.includes(padB));

    // 10e. High 2 & High 10: SheetJS 0.20.3 persists formulas across two write-read cycles
    const reqLocal = createRequire(__filename);
    const XLSX = reqLocal('xlsx');
    assert.ok(XLSX.version.startsWith('0.20.'), `Expected SheetJS 0.20.x, got ${XLSX.version}`);
    const wbTest = XLSX.utils.book_new();
    const wsTest = XLSX.utils.aoa_to_sheet([['A', 'B', 'C'], [10, 20, 0]]);
    wsTest['C2'] = { t: 'str', f: 'A2+B2', v: '' };
    XLSX.utils.book_append_sheet(wbTest, wsTest, 'Sheet1');
    const outWb1 = XLSX.write(wbTest, { bookType: 'xlsx', type: 'array' });
    const wbReopen1 = XLSX.read(new Uint8Array(outWb1), {
      type: 'array',
      cellFormula: true,
      cellNF: true,
      cellStyles: true,
    });
    assert.equal(wbReopen1.Sheets.Sheet1['C2']?.f, 'A2+B2');
    wbReopen1.Sheets.Sheet1['A2'] = { t: 'n', v: 99 };
    const outWb2 = XLSX.write(wbReopen1, { bookType: 'xlsx', type: 'array' });
    const wbReopen2 = XLSX.read(new Uint8Array(outWb2), {
      type: 'array',
      cellFormula: true,
      cellNF: true,
      cellStyles: true,
    });
    assert.equal(wbReopen2.Sheets.Sheet1['C2']?.f, 'A2+B2');

    // 11. POST /api/file/save-as (auth, workspace scope, validation, and atomic save)
    const pngContent = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4H+DwHwAGcAKPWYT7MwAAAABJRU5ErkJggg==';
    const replacementPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGMQcPj/HwAEAgJPwWUUsQAAAABJRU5ErkJggg==';
    const samplePng = join(wsDir, 'sample.png');
    const editedPng = join(realpathSync(wsDir), 'sample_edited.png');
    writeFileSync(samplePng, Buffer.from(pngContent, 'base64'));
    const saveAs = (fields = {}, auth = true) =>
      fetch(base + '/api/file/save-as', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(auth ? { 'X-Sidecar-Token': token } : {}),
        },
        body: JSON.stringify({
          sourcePath: samplePng,
          fileName: 'sample_edited.png',
          encoding: 'base64',
          content: pngContent,
          workspaceGen: curGen,
          ...fields,
        }),
      });

    assert.equal((await saveAs({}, false)).status, 401, 'save-as requires a token');
    for (const fileName of ['../evil.png', 'sub/evil.png', 'a\\b.png', 'a:b.png', 'a\0b.png', '.', '..', '']) {
      assert.equal((await saveAs({ fileName })).status, 400, 'invalid save-as name: ' + fileName);
    }
    for (const fileName of ['evil.js', 'evil.svg', 'evil.html']) {
      const denied = await saveAs({ fileName });
      assert.equal(denied.status, 400);
      assert.match((await denied.json()).error, /Unsupported image extension/);
    }
    assert.equal((await saveAs({ sourcePath: escapePath })).status, 403);
    assert.equal((await saveAs({ sourcePath: trPath })).status, 403);
    assert.equal((await saveAs({ workspaceGen: curGen - 1 })).status, 409);
    for (const content of ['', '    ', 'not base64!', 123]) {
      assert.equal((await saveAs({ content })).status, 400);
    }
    assert.equal((await saveAs({ encoding: 'utf8' })).status, 400);
    assert.equal(existsSync(editedPng), false);

    const created = await saveAs({
      fileName: ' sample_edited.png ',
      content: pngContent.slice(0, 40) + '\n' + pngContent.slice(40),
    });
    assert.equal(created.status, 200);
    const createdJson = await created.json();
    const pngBytes = Buffer.from(pngContent, 'base64');
    assert.equal(createdJson.success, true);
    assert.equal(createdJson.path, editedPng);
    assert.equal(createdJson.relPath, 'sample_edited.png');
    assert.equal(createdJson.name, 'sample_edited.png');
    assert.equal(createdJson.size, pngBytes.length);
    assert.equal(createdJson.mtimeMs, statSync(editedPng).mtimeMs);
    assert.equal(createdJson.version, versionFromBuffer(statSync(editedPng), pngBytes));
    assert.deepEqual(readFileSync(editedPng), pngBytes);

    const duplicate = await saveAs({ overwrite: false, autoRename: false, content: replacementPng });
    assert.equal(duplicate.status, 409);
    assert.equal((await duplicate.json()).conflict, true);
    assert.deepEqual(readFileSync(editedPng), pngBytes);

    const renamed = await saveAs({ autoRename: true });
    assert.equal(renamed.status, 200);
    const renamedJson = await renamed.json();
    assert.equal(renamedJson.relPath, 'sample_edited_2.png');
    assert.equal(renamedJson.path, join(realpathSync(wsDir), 'sample_edited_2.png'));
    assert.deepEqual(readFileSync(renamedJson.path), pngBytes);

    const overwritten = await saveAs({ overwrite: true, content: replacementPng });
    assert.equal(overwritten.status, 200);
    assert.equal((await overwritten.json()).path, editedPng);
    assert.deepEqual(readFileSync(editedPng), Buffer.from(replacementPng, 'base64'));
    assert.deepEqual(readFileSync(samplePng), pngBytes, 'save-as must preserve the source');

    const brainDir = join(appDataDir, 'brain', convId);
    const brainCover = join(brainDir, 'ai_cover.png');
    const brainCopyName = 'ai_cover_annotated.png';
    writeFileSync(brainCover, pngBytes);
    const savedBrainCover = await saveAs({ sourcePath: brainCover, fileName: brainCopyName });
    assert.equal(savedBrainCover.status, 200, 'save-as allows images in the active conversation brain');
    const savedBrainCoverJson = await savedBrainCover.json();
    const expectedBrainCopy = join(realpathSync(brainDir), brainCopyName);
    assert.equal(savedBrainCoverJson.relPath, brainCopyName);
    assert.equal(savedBrainCoverJson.path, expectedBrainCopy);
    assert.deepEqual(readFileSync(expectedBrainCopy), pngBytes);

    const uploadDir = join(brainDir, '.user_uploaded');
    const uploadedImage = join(uploadDir, 'input.png');
    mkdirSync(uploadDir);
    writeFileSync(uploadedImage, pngBytes);
    const savedUpload = await saveAs({ sourcePath: uploadedImage, fileName: 'input_annotated.png' });
    assert.equal(savedUpload.status, 200, 'save-as allows images in active brain subdirectories');
    assert.equal((await savedUpload.json()).relPath, '.user_uploaded/input_annotated.png');
    assert.deepEqual(readFileSync(join(uploadDir, 'input_annotated.png')), pngBytes);

    const sysImg = join(logsDir, 'sys.png');
    writeFileSync(sysImg, pngBytes);
    const deniedSysImg = await saveAs({ sourcePath: sysImg, fileName: 'sys_annotated.png' });
    assert.equal(deniedSysImg.status, 403, 'save-as rejects images in .system_generated');
    assert.equal(existsSync(join(logsDir, 'sys_annotated.png')), false);

    const otherConvDir = join(appDataDir, 'brain', '22222222-2222-3333-4444-555555555555');
    const otherConvImg = join(otherConvDir, 'other.png');
    mkdirSync(otherConvDir);
    writeFileSync(otherConvImg, pngBytes);
    const deniedOtherConv = await saveAs({ sourcePath: otherConvImg, fileName: 'other_annotated.png' });
    assert.equal(deniedOtherConv.status, 403, 'save-as rejects images in other conversations');
    assert.equal(existsSync(join(otherConvDir, 'other_annotated.png')), false);

    const overlappingWorkspace = studio.security.registerWorkspaceUris([pathToFileURL(appDataDir).href]);
    assert.equal(overlappingWorkspace.roots.length, 1);
    const deniedInOverlappingRoot = await saveAs({
      sourcePath: otherConvImg,
      fileName: 'other_annotated.png',
      workspaceGen: overlappingWorkspace.generation,
    });
    assert.equal(deniedInOverlappingRoot.status, 403, 'a workspace root cannot grant access to another conversation');
    assert.equal(existsSync(join(otherConvDir, 'other_annotated.png')), false);

    assert.equal(typeof healthJson.version, 'string', 'health exposes version');
    assert.ok(healthJson.bootId, 'health exposes bootId');

    // 12. Degraded startup (missing node_modules) -> hot vendor restoration without server restart
    const degradedStudioDir = join(tmpRoot, 'degraded-studio');
    cpSync(join(__dirname, 'public'), join(degradedStudioDir, 'public'), { recursive: true });
    const degradedStudio = createStudioServer({
      SidecarApp,
      Response: ResponseClass,
      appDataDir,
      cacheDir,
      studioDir: degradedStudioDir,
    });
    assert.ok(degradedStudio.staticInfo.missing.length > 0, 'Degraded startup must record missing vendor assets');
    assert.equal(
      degradedStudio.staticInfo.missingVendorDirs.length,
      3,
      'Degraded startup must record all 3 missing pdfjs vendor dirs'
    );
    try {
      const degradedServer = await degradedStudio.app.run();
      const degradedBase = `http://127.0.0.1:${degradedServer.address().port}`;

      const rDegHealthBefore = await fetch(`${degradedBase}/api/health`);
      assert.equal(rDegHealthBefore.status, 200);
      const degHealthBefore = await rDegHealthBefore.json();
      assert.equal(degHealthBefore.vendorReady, false);
      assert.equal(degHealthBefore.missingVendorCount, 15);
      assert.equal(degHealthBefore.missingVendorAssets.length, 15);
      for (const route of degHealthBefore.missingVendorAssets) {
        assert.ok(route.startsWith('/vendor/'), `missingVendorAssets must only expose logical route: ${route}`);
        assert.equal(route.includes('\\'), false, 'missingVendorAssets must not expose Windows paths');
      }

      for (const route of [
        '/vendor/docx-preview.min.js',
        '/vendor/jszip.min.js',
        '/vendor/pdfjs/cmaps/Adobe-GB1-UCS2.bcmap',
      ]) {
        const res = await fetch(`${degradedBase}${route}`);
        assert.equal(res.status, 503, `Missing vendor route ${route} must return 503 before restore`);
        assert.equal(res.headers.get('cache-control'), 'no-store');
      }

      for (const badPath of [
        '/vendor/pdfjs/cmaps/..%2F..%2Fpackage.json',
        '/vendor/pdfjs/cmaps/..%5C..%5Cpackage.json',
      ]) {
        const res = await fetch(`${degradedBase}${badPath}`);
        assert.equal(res.status, 400, `Path traversal must be rejected: ${badPath}`);
      }

      // Populate vendor files on disk WITHOUT restarting degradedStudio
      const manifest = getVendorManifest(degradedStudioDir);
      for (const [route, diskPath] of manifest.vendorFiles) {
        mkdirSync(dirname(diskPath), { recursive: true });
        const content = route.endsWith('.js')
          ? `/* restored ${route} */`
          : `/* css ${route} */`;
        writeFileSync(diskPath, content, 'utf8');
      }
      const cmapBytes = Buffer.from([1, 2, 3, 4]);
      const cmapFile = join(manifest.vendorDirs[0][1], 'Adobe-GB1-UCS2.bcmap');
      mkdirSync(manifest.vendorDirs[0][1], { recursive: true });
      writeFileSync(cmapFile, cmapBytes);
      mkdirSync(manifest.vendorDirs[1][1], { recursive: true });
      writeFileSync(join(manifest.vendorDirs[1][1], 'FoxitFixed.pfb'), Buffer.from('pfb'));
      mkdirSync(manifest.vendorDirs[2][1], { recursive: true });
      writeFileSync(join(manifest.vendorDirs[2][1], 'annotation-note.svg'), '<svg/>', 'utf8');

      const rDocxVendor = await fetch(`${degradedBase}/vendor/docx-preview.min.js`);
      assert.equal(rDocxVendor.status, 200, 'Restored vendor bundle must serve 200 without restart');
      assert.match(rDocxVendor.headers.get('content-type'), /^application\/javascript/);
      assert.equal(await rDocxVendor.text(), '/* restored /vendor/docx-preview.min.js */');

      const rJszipVendor = await fetch(`${degradedBase}/vendor/jszip.min.js`);
      assert.equal(rJszipVendor.status, 200);

      const rCmap = await fetch(`${degradedBase}/vendor/pdfjs/cmaps/Adobe-GB1-UCS2.bcmap`);
      assert.equal(rCmap.status, 200, 'Restored pdfjs cmap must serve 200 without restart');
      assert.equal(rCmap.headers.get('content-type'), 'application/octet-stream');
      assert.deepEqual(Buffer.from(await rCmap.arrayBuffer()), cmapBytes);

      const rCmapHead = await fetch(`${degradedBase}/vendor/pdfjs/cmaps/Adobe-GB1-UCS2.bcmap`, {
        method: 'HEAD',
      });
      assert.equal(rCmapHead.status, 200);
      assert.equal((await rCmapHead.arrayBuffer()).byteLength, 0);

      const rCmapMissing = await fetch(`${degradedBase}/vendor/pdfjs/cmaps/does-not-exist.bcmap`);
      assert.equal(rCmapMissing.status, 404);

      const rTraversalAfter = await fetch(`${degradedBase}/vendor/pdfjs/cmaps/..%2Fpackage.json`);
      assert.equal(rTraversalAfter.status, 400);

      const rDegHealthAfter = await fetch(`${degradedBase}/api/health`);
      assert.equal(rDegHealthAfter.status, 200);
      const degHealthAfter = await rDegHealthAfter.json();
      assert.equal(degHealthAfter.vendorReady, true);
      assert.equal(degHealthAfter.missingVendorCount, 0);
      assert.deepEqual(degHealthAfter.missingVendorAssets, []);
    } finally {
      await degradedStudio.close();
    }

    // 13. Previewer missing-vendor guard check (docx-viewer.js throws VENDOR_MISSING instead of TypeError)
    {
      const { runInNewContext } = await import('node:vm');
      const rDocxViewer = await fetch(`${base}/previewers/docx-viewer.js`);
      assert.equal(rDocxViewer.status, 200);
      const docxViewerSource = await rDocxViewer.text();

      class MockEl {
        constructor(tag = 'div') {
          this.tagName = String(tag).toUpperCase();
          this.children = [];
          this.className = '';
          this.textContent = '';
          this.innerHTML = '';
          this.style = {};
          const cls = new Set();
          this.classList = {
            add: (c) => cls.add(c),
            remove: (c) => cls.delete(c),
            toggle: (c, f) => (f === undefined ? (cls.has(c) ? cls.delete(c) : cls.add(c)) : (f ? cls.add(c) : cls.delete(c))),
            contains: (c) => cls.has(c),
          };
        }
        append(...nodes) {
          this.children.push(...nodes);
        }
        appendChild(node) {
          this.children.push(node);
          return node;
        }
        addEventListener() {}
      }

      const docxWindow = {
        addEventListener() {},
        removeEventListener() {},
        fetch: async () => ({
          ok: true,
          arrayBuffer: async () => new Uint8Array([0x50, 0x4b, 0x03, 0x04]).buffer,
        }),
        ResizeObserver: class {
          observe() {}
          disconnect() {}
        },
        document: {
          createElement: (tag) => new MockEl(tag),
        },
      };
      runInNewContext(docxViewerSource, {
        window: docxWindow,
        document: docxWindow.document,
        ResizeObserver: docxWindow.ResizeObserver,
      });
      await assert.rejects(
        docxWindow.WSModules.renderDocxPreview({
          file: { path: sampleDoc, mtimeMs: Date.now() },
          stageEl: new MockEl(),
          toolbarEl: new MockEl(),
          capabilities: {},
          conversationId: '',
        }),
        (err) => err?.code === 'VENDOR_MISSING' && /docx-preview/.test(err.message)
      );
    }

    await runUpdaterSelfTests({ SidecarApp, ResponseClass });

    testSummary = `staticRoutes=${studio.staticInfo.count}, xlsx=${XLSX.version}, converters=${JSON.stringify(healthJson.converters)}`;
  } finally {
    await studio.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  }
  assert.equal(existsSync(prefsPath), false, 'test cleanup removes the UI preferences file');
  console.log(`[antigravity-sidecar-studio --test] ALL PASSED (${testSummary})`);
}

function buildTestZipBuffer(entries) {
  const localParts = [];
  const cdParts = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const rawBuf = Buffer.isBuffer(entry.data)
      ? entry.data
      : Buffer.from(String(entry.data || ''), 'utf8');
    const isDir = entry.name.endsWith('/');
    const method = !isDir && entry.deflate ? 8 : 0;
    const compBuf = isDir
      ? Buffer.alloc(0)
      : method === 8
        ? deflateRawSync(rawBuf)
        : rawBuf;
    const crc = isDir ? 0 : computeCrc32(rawBuf);

    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(0x0800, 6);
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(compBuf.length, 18);
    lfh.writeUInt32LE(isDir ? 0 : rawBuf.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);

    localParts.push(lfh, nameBuf, compBuf);

    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(0x031e, 4);
    cdh.writeUInt16LE(20, 6);
    cdh.writeUInt16LE(0x0800, 8);
    cdh.writeUInt16LE(method, 10);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(compBuf.length, 20);
    cdh.writeUInt32LE(isDir ? 0 : rawBuf.length, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt32LE(offset, 42);

    cdParts.push(cdh, nameBuf);
    offset += lfh.length + nameBuf.length + compBuf.length;
  }

  const cdBuf = Buffer.concat(cdParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...localParts, cdBuf, eocd]);
}

function makeFakePluginEntries({ version, serverBody, readmeBody, lockBody, deflate = true }) {
  const prefix = 'antigravity-sidecar-studio/';
  return [
    { name: prefix, data: '' },
    {
      name: `${prefix}plugin.json`,
      data: JSON.stringify(
        {
          name: 'antigravity-sidecar-studio',
          version,
          repository: 'https://github.com/burnerous/antigravity-sidecar-studio',
        },
        null,
        2
      ),
      deflate,
    },
    { name: `${prefix}LICENSE`, data: 'MIT\n', deflate },
    { name: `${prefix}README.md`, data: readmeBody || `# v${version}\n`, deflate },
    { name: `${prefix}assets/logo.svg`, data: '<svg></svg>', deflate },
    { name: `${prefix}rules/AGENTS.md`, data: '# Rules\n', deflate },
    { name: `${prefix}skills/sidecar-studio/SKILL.md`, data: '# Skill\n', deflate },
    { name: `${prefix}sidecars/studio/sidecar.json`, data: '{"has_web_ui":true}', deflate },
    {
      name: `${prefix}sidecars/studio/package.json`,
      data: JSON.stringify({ name: 'antigravity-sidecar-studio', version }),
      deflate,
    },
    {
      name: `${prefix}sidecars/studio/package-lock.json`,
      data: lockBody || '{"lockfileVersion":3}',
      deflate,
    },
    { name: `${prefix}sidecars/studio/lib/helper.mjs`, data: `export const v = '${version}';\n`, deflate },
    { name: `${prefix}sidecars/studio/public/index.html`, data: '<html></html>', deflate },
    { name: `${prefix}sidecars/studio/public/app.js`, data: `console.log('${version}');\n`, deflate },
    { name: `${prefix}sidecars/studio/scripts/update.mjs`, data: '// cli\n', deflate },
    {
      name: `${prefix}sidecars/studio/node_modules/xlsx/dist/xlsx.full.min.js`,
      data: '// xlsx mock\n',
      deflate,
    },
    {
      name: `${prefix}sidecars/studio/server.mjs`,
      data: serverBody || `export const version = '${version}';\n`,
      deflate,
    },
  ];
}

function seedPluginDir(rootDir, opts) {
  for (const e of makeFakePluginEntries(opts)) {
    const rel = e.name.replace(/^antigravity-sidecar-studio\//, '');
    if (!rel) continue;
    const target = join(rootDir, rel);
    if (rel.endsWith('/')) {
      mkdirSync(target, { recursive: true });
    } else {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, e.data, 'utf8');
    }
  }
}

async function runUpdaterSelfTests({ SidecarApp, ResponseClass }) {
  assert.equal(compareSemver('1.3.0', '1.3.0'), 0);
  assert.ok(compareSemver('v1.4.0', '1.3.9') > 0);
  assert.ok(compareSemver('2.0.0-beta.1', '2.0.0') < 0);
  assert.ok(compareSemver('2.0.0-beta.2', '2.0.0-beta.10') < 0);
  assert.ok(compareSemver('2.0.0-alpha', '2.0.0-1') > 0);

  const tmpUpdRoot = mkdtempSync(join(tmpdir(), 'ws-updater-test-'));
  let mockMode = 'api-ok';
  let apiCalls = 0;
  let currentZipBuf = Buffer.alloc(0);
  let currentSha256 = '';
  let currentSumsSha256 = '';
  let currentBodySha256 = '';
  let currentDigestSha256 = '';

  const mockServer = createHttpServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/repos/burnerous/antigravity-sidecar-studio/releases/latest') {
      apiCalls += 1;
      if (mockMode === 'rate-limit-403') {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'API rate limit exceeded' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          tag_name: 'v9.9.9',
          name: 'Sidecar Studio v9.9.9',
          published_at: '2026-11-25T12:00:00Z',
          html_url: `http://127.0.0.1:${mockPort}/burnerous/antigravity-sidecar-studio/releases/tag/v9.9.9`,
          body:
            `## Sidecar Studio v9.9.9\n\n### 📝 更新内容\n\n- 新增应用内自动更新\n\n---\n` +
            (currentBodySha256 ? `- **SHA-256**：\`${currentBodySha256}\`\n` : ''),
          assets: [
            {
              name: 'antigravity-sidecar-studio-v9.9.9-offline.zip',
              size: currentZipBuf.length,
              digest: currentDigestSha256 ? `sha256:${currentDigestSha256}` : '',
              browser_download_url: `http://127.0.0.1:${mockPort}/burnerous/antigravity-sidecar-studio/releases/download/v9.9.9/antigravity-sidecar-studio-v9.9.9-offline.zip`,
            },
          ],
        })
      );
      return;
    }
    if (url.pathname === '/burnerous/antigravity-sidecar-studio/releases/latest') {
      res.writeHead(302, {
        Location: `http://127.0.0.1:${mockPort}/burnerous/antigravity-sidecar-studio/releases/tag/v9.9.9`,
      });
      res.end();
      return;
    }
    if (
      url.pathname ===
      '/burnerous/antigravity-sidecar-studio/releases/download/v9.9.9/antigravity-sidecar-studio-v9.9.9-offline.zip'
    ) {
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Length': String(currentZipBuf.length),
      });
      res.end(currentZipBuf);
      return;
    }
    if (
      url.pathname ===
      '/burnerous/antigravity-sidecar-studio/releases/download/v9.9.9/SHA256SUMS.txt'
    ) {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`${currentSumsSha256}  antigravity-sidecar-studio-v9.9.9-offline.zip\n`);
      return;
    }
    res.writeHead(404);
    res.end('Not found');
  });

  await new Promise((r) => mockServer.listen(0, '127.0.0.1', r));
  const mockPort = mockServer.address().port;
  const mockBase = `http://127.0.0.1:${mockPort}`;

  try {
    // 1. Zip-Slip protection check
    const slipZip = join(tmpUpdRoot, 'slip.zip');
    writeFileSync(
      slipZip,
      buildTestZipBuffer([{ name: 'antigravity-sidecar-studio/../../evil.txt', data: 'bad' }])
    );
    assert.throws(
      () => extractZipSafely(slipZip, join(tmpUpdRoot, 'slip-out')),
      /不安全的 ZIP 路径/
    );
    assert.equal(existsSync(join(tmpUpdRoot, 'evil.txt')), false);

    // 2. Prepare good offline-zip plugin copy & release archive
    const pluginCopy = join(tmpUpdRoot, 'plugin-offline');
    const sharedLock = '{"lockfileVersion":3,"packages":{"xlsx":"0.20.3"}}';
    seedPluginDir(pluginCopy, { version: '1.3.0', lockBody: sharedLock });
    const nmSentinel = join(pluginCopy, 'sidecars', 'studio', 'node_modules', '.keep-sentinel');
    writeFileSync(nmSentinel, 'keep-me', 'utf8');

    currentZipBuf = buildTestZipBuffer(
      makeFakePluginEntries({
        version: '9.9.9',
        lockBody: sharedLock,
        readmeBody: '# Updated v9.9.9\n',
        deflate: true,
      })
    );
    currentSha256 = createHash('sha256').update(currentZipBuf).digest('hex');
    currentDigestSha256 = currentSha256;
    currentBodySha256 = currentSha256;
    currentSumsSha256 = currentSha256;

    const updaterDataDir = join(tmpUpdRoot, 'upd-data');
    let preparedCalled = 0;
    let restartedCalled = 0;
    let workDirCleanedBeforeRestart = false;
    const updStudio = createStudioServer({
      SidecarApp,
      Response: ResponseClass,
      appDataDir: join(tmpUpdRoot, 'appdata'),
      cacheDir: join(tmpUpdRoot, 'cache'),
      studioDir: join(pluginCopy, 'sidecars', 'studio'),
      pluginRoot: pluginCopy,
      dataDir: updaterDataDir,
      prepareForSelfUpdate: () => {
        preparedCalled += 1;
      },
      onRestart: () => {
        restartedCalled += 1;
        const wr = join(updaterDataDir, 'updater-work');
        workDirCleanedBeforeRestart = !existsSync(wr) || readdirSync(wr).length === 0;
      },
      updaterOptions: {
        apiBaseUrl: mockBase,
        webBaseUrl: mockBase,
        allowedDownloadHosts: ['127.0.0.1', 'localhost'],
      },
    });
    const updHttp = await updStudio.app.run();
    const updBase = `http://127.0.0.1:${updHttp.address().port}`;
    const updToken = process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN;
    const updPost = (path, body) =>
      fetch(`${updBase}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(updToken ? { 'X-Sidecar-Token': updToken } : {}),
        },
        body: JSON.stringify(body),
      });

    try {
      // Check + cache behavior
      const st0 = await (await fetch(`${updBase}/api/update/status`)).json();
      assert.equal(st0.currentVersion, '1.3.0');
      assert.equal(st0.installMode, 'offline-zip');
      assert.equal(st0.updateAvailable, false);

      const chk1 = await (await updPost('/api/update/check', { force: true })).json();
      assert.equal(chk1.updateAvailable, true);
      assert.equal(chk1.latest.version, '9.9.9');
      assert.match(chk1.latest.changelog, /新增应用内自动更新/);
      assert.equal(chk1.latest.sha256, currentSha256);
      assert.equal(apiCalls, 1);

      // Cached check should not hit server again
      await updPost('/api/update/check', { force: false });
      assert.equal(apiCalls, 1);

      // Force check under 403 rate limit falls back to redirect + SHA256SUMS.txt
      mockMode = 'rate-limit-403';
      const chkFallback = await (await updPost('/api/update/check', { force: true })).json();
      assert.equal(chkFallback.latest.source, 'redirect-fallback');
      assert.equal(chkFallback.latest.sha256, currentSha256);
      mockMode = 'api-ok';

      // Custom mirror without SHA-256 must be refused
      currentDigestSha256 = '';
      currentBodySha256 = '';
      currentSumsSha256 = '';
      const noShaUpdater = new PluginUpdater({
        pluginRoot: pluginCopy,
        studioDir: join(pluginCopy, 'sidecars', 'studio'),
        dataDir: join(tmpUpdRoot, 'nosha-data'),
        apiBaseUrl: mockBase,
        webBaseUrl: mockBase,
        allowedDownloadHosts: ['127.0.0.1', 'localhost'],
      });
      await noShaUpdater.checkForUpdates({ force: true });
      await assert.rejects(
        () => noShaUpdater.startUpdate({ customMirror: 'https://mirror.example.com/' }),
        /必须具备官方 SHA-256/
      );
      currentDigestSha256 = currentSha256;
      currentBodySha256 = currentSha256;
      currentSumsSha256 = currentSha256;

      // SHA-256 mismatch rejects update & leaves plugin untouched
      const badUpdater = new PluginUpdater({
        pluginRoot: pluginCopy,
        studioDir: join(pluginCopy, 'sidecars', 'studio'),
        dataDir: join(tmpUpdRoot, 'badsha-data'),
        apiBaseUrl: mockBase,
        webBaseUrl: mockBase,
        allowedDownloadHosts: ['127.0.0.1', 'localhost'],
      });
      await badUpdater.checkForUpdates({ force: true });
      currentZipBuf = buildTestZipBuffer(
        makeFakePluginEntries({ version: '9.9.9', lockBody: sharedLock, readmeBody: 'tampered' })
      );
      await badUpdater.startUpdate({ targetVersion: '9.9.9' });
      const badJob = await badUpdater.waitForJob();
      assert.equal(badJob.state, 'failed');
      assert.match(badJob.error, /SHA-256 校验失败/);
      assert.equal(JSON.parse(readFileSync(join(pluginCopy, 'plugin.json'), 'utf8')).version, '1.3.0');

      // Rollback test: broken server.mjs syntax inside valid-SHA zip must roll back cleanly
      currentZipBuf = buildTestZipBuffer(
        makeFakePluginEntries({
          version: '9.9.9',
          lockBody: sharedLock,
          serverBody: 'this is not valid javascript syntax ((((',
        })
      );
      currentSha256 = createHash('sha256').update(currentZipBuf).digest('hex');
      currentDigestSha256 = currentSha256;
      currentBodySha256 = currentSha256;
      currentSumsSha256 = currentSha256;

      await updPost('/api/update/check', { force: true });
      const rbStart = await updPost('/api/update/apply', { targetVersion: '9.9.9' });
      assert.equal(rbStart.status, 202);
      const rbJob = await updStudio.updater.waitForJob();
      assert.equal(rbJob.state, 'failed');
      assert.equal(rbJob.rolledBack, true);
      assert.equal(JSON.parse(readFileSync(join(pluginCopy, 'plugin.json'), 'utf8')).version, '1.3.0');

      // Successful offline-zip apply + skip unchanged node_modules + lastUpdate persistence
      currentZipBuf = buildTestZipBuffer(
        makeFakePluginEntries({
          version: '9.9.9',
          lockBody: sharedLock,
          readmeBody: '# Updated v9.9.9\n',
        })
      );
      currentSha256 = createHash('sha256').update(currentZipBuf).digest('hex');
      currentDigestSha256 = currentSha256;
      currentBodySha256 = currentSha256;
      currentSumsSha256 = currentSha256;

      await updPost('/api/update/check', { force: true });
      const applyRes = await updPost('/api/update/apply', { targetVersion: '9.9.9' });
      assert.equal(applyRes.status, 202);
      const okJob = await updStudio.updater.waitForJob();
      assert.equal(okJob.state, 'completed');
      assert.equal(JSON.parse(readFileSync(join(pluginCopy, 'plugin.json'), 'utf8')).version, '9.9.9');
      assert.equal(readFileSync(join(pluginCopy, 'README.md'), 'utf8'), '# Updated v9.9.9\n');
      assert.equal(readFileSync(nmSentinel, 'utf8'), 'keep-me', 'unchanged node_modules should be skipped');
      assert.ok(preparedCalled >= 1);
      assert.equal(restartedCalled, 1);
      assert.equal(workDirCleanedBeforeRestart, true, 'workDir must be cleaned up before onRestart');

      const postRestartUpdater = new PluginUpdater({
        pluginRoot: pluginCopy,
        studioDir: join(pluginCopy, 'sidecars', 'studio'),
        dataDir: updaterDataDir,
      });
      assert.equal(postRestartUpdater.getStatus().justUpdated, true);
      postRestartUpdater.acknowledgeUpdated();
      assert.equal(postRestartUpdater.getStatus().justUpdated, false);
    } finally {
      await updStudio.close();
    }

    // 3. CLI tests (in-process JSON check & --help subprocess)
    const cliCheckPlugin = join(tmpUpdRoot, 'cli-plugin');
    seedPluginDir(cliCheckPlugin, { version: '1.3.0', lockBody: sharedLock });
    let cliOut = '';
    const cliCode = await runUpdateCli(['--check', '--force', '--json'], {
      pluginRoot: cliCheckPlugin,
      studioDir: join(cliCheckPlugin, 'sidecars', 'studio'),
      dataDir: join(tmpUpdRoot, 'cli-data'),
      apiBaseUrl: mockBase,
      webBaseUrl: mockBase,
      allowedDownloadHosts: ['127.0.0.1', 'localhost'],
      stdout: (s) => {
        cliOut += s;
      },
    });
    assert.equal(cliCode, 0);
    const cliParsed = JSON.parse(cliOut);
    assert.equal(cliParsed.ok, true);
    assert.equal(cliParsed.status.updateAvailable, true);
    assert.equal(cliParsed.status.latest.version, '9.9.9');

    const helpRes = spawnSync(
      process.execPath,
      [join(__dirname, 'scripts', 'update.mjs'), '--help'],
      { encoding: 'utf8', windowsHide: true }
    );
    assert.equal(helpRes.status, 0);
    assert.match(helpRes.stdout, /--apply/);

    // 4. Git install mode tests (bare origin + dirty/branch/clean main)
    const bareOrigin = join(tmpUpdRoot, 'origin.git');
    const seedWork = join(tmpUpdRoot, 'git-seed');
    const gitClone = join(tmpUpdRoot, 'git-clone');
    execFileSync('git', ['init', '--bare', bareOrigin], { windowsHide: true });
    mkdirSync(seedWork, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: seedWork, windowsHide: true });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: seedWork, windowsHide: true });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], {
      cwd: seedWork,
      windowsHide: true,
    });
    seedPluginDir(seedWork, { version: '1.3.0', lockBody: sharedLock });
    execFileSync('git', ['add', '-A'], { cwd: seedWork, windowsHide: true });
    execFileSync('git', ['commit', '-m', 'init v1.3.0'], { cwd: seedWork, windowsHide: true });
    execFileSync('git', ['remote', 'add', 'origin', bareOrigin], { cwd: seedWork, windowsHide: true });
    execFileSync('git', ['push', '-u', 'origin', 'main'], { cwd: seedWork, windowsHide: true });

    execFileSync('git', ['clone', bareOrigin, gitClone], { windowsHide: true });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: gitClone, windowsHide: true });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], {
      cwd: gitClone,
      windowsHide: true,
    });

    // Advance origin to v9.9.9
    seedPluginDir(seedWork, { version: '9.9.9', lockBody: sharedLock, readmeBody: '# Git v9.9.9\n' });
    execFileSync('git', ['add', '-A'], { cwd: seedWork, windowsHide: true });
    execFileSync('git', ['commit', '-m', 'release v9.9.9'], { cwd: seedWork, windowsHide: true });
    execFileSync('git', ['push', 'origin', 'main'], { cwd: seedWork, windowsHide: true });

    let gitRestarted = 0;
    const gitUpdater = new PluginUpdater({
      pluginRoot: gitClone,
      studioDir: join(gitClone, 'sidecars', 'studio'),
      dataDir: join(tmpUpdRoot, 'git-data'),
      apiBaseUrl: mockBase,
      webBaseUrl: mockBase,
      allowedDownloadHosts: ['127.0.0.1', 'localhost'],
      onRestart: () => {
        gitRestarted += 1;
      },
    });
    await gitUpdater.checkForUpdates({ force: true });

    // Dirty tree must be refused (409) and local file preserved
    const dirtyFile = join(gitClone, 'local-note.txt');
    writeFileSync(dirtyFile, 'keep local', 'utf8');
    await assert.rejects(() => gitUpdater.startUpdate({ targetVersion: '9.9.9' }), (e) => e.status === 409);
    assert.equal(readFileSync(dirtyFile, 'utf8'), 'keep local');
    rmSync(dirtyFile);

    // Non-main branch must be refused (409)
    execFileSync('git', ['checkout', '-b', 'feature/x'], { cwd: gitClone, windowsHide: true });
    await assert.rejects(() => gitUpdater.startUpdate({ targetVersion: '9.9.9' }), (e) => e.status === 409);
    execFileSync('git', ['checkout', 'main'], { cwd: gitClone, windowsHide: true });

    // Clean main fast-forwards cleanly
    await gitUpdater.startUpdate({ targetVersion: '9.9.9' });
    const gitJob = await gitUpdater.waitForJob();
    assert.equal(gitJob.state, 'completed');
    assert.equal(JSON.parse(readFileSync(join(gitClone, 'plugin.json'), 'utf8')).version, '9.9.9');
    assert.equal(readFileSync(join(gitClone, 'README.md'), 'utf8').replace(/\r\n/g, '\n'), '# Git v9.9.9\n');
    assert.equal(gitRestarted, 1);
  } finally {
    mockServer.close();
    rmSync(tmpUpdRoot, { recursive: true, force: true });
  }
}

const isMain =
  process.argv[1] && resolve(process.argv[1]).toLowerCase() === __filename.toLowerCase();

if (isMain) {
  if (process.argv.includes('--test')) {
    runSelfTests()
      .then(() => process.exit(0))
      .catch((err) => {
        console.error('[antigravity-sidecar-studio --test] FAILED:', err);
        process.exit(1);
      });
  } else {
    const { SidecarApp, Response: ResponseClass } = await loadSdk();
    const execDataDir = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
    const appDataDir = resolveAppDataDir();
    const cacheDir = join(
      execDataDir || join(tmpdir(), 'sidecar-studio-cache'),
      'cache',
      'office-pdf'
    );

    if (execDataDir) {
      try {
        mkdirSync(execDataDir, { recursive: true });
        process.chdir(execDataDir);
      } catch {
        // Non-fatal if chdir fails
      }
    }

    const watchTargets = [
      __filename,
      join(__dirname, 'lib', 'security.mjs'),
      join(__dirname, 'lib', 'static-registry.mjs'),
      join(__dirname, 'lib', 'workspace.mjs'),
      join(__dirname, 'lib', 'office-converter.mjs'),
      join(__dirname, 'lib', 'transcript.mjs'),
      join(__dirname, 'lib', 'ui-prefs.mjs'),
      join(__dirname, 'lib', 'updater.mjs'),
    ];
    for (const f of watchTargets) {
      if (existsSync(f)) {
        watchFile(f, { interval: 2000 }, () => {
          console.log(`[antigravity-sidecar-studio] source changed (${f}), exiting for host restart...`);
          process.exit(0);
        });
      }
    }

    let studio = null;
    studio = createStudioServer({
      SidecarApp,
      Response: ResponseClass,
      appDataDir,
      cacheDir,
      studioDir: __dirname,
      dataDir: execDataDir || join(tmpdir(), 'sidecar-studio-data'),
      prepareForSelfUpdate: () => {
        for (const f of watchTargets) {
          try {
            unwatchFile(f);
          } catch {}
        }
      },
      onRestart: async () => {
        if (studio) await studio.close();
        process.exit(0);
      },
    });

    process.on('SIGINT', async () => {
      await studio.close();
      process.exit(0);
    });
    process.on('SIGTERM', async () => {
      await studio.close();
      process.exit(0);
    });

    await studio.app.run();
  }
}
