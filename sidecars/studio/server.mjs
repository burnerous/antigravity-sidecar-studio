import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  watchFile,
  writeFileSync,
} from 'node:fs';
import { request as httpRequest } from 'node:http';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { OfficeConverter } from './lib/office-converter.mjs';
import {
  CONV_ID_RE,
  isUnderRoot,
  makeHttpError,
  resolveAppDataDir,
  SecurityManager,
} from './lib/security.mjs';
import { registerAllStaticAssets, STATIC_MIME_TYPES } from './lib/static-registry.mjs';
import {
  extractProducedDocs,
  readFullTranscriptStep,
  readTranscriptSteps,
  resolveConversationId,
} from './lib/transcript.mjs';
import { listDirectory, searchWorkspace, WorkspaceWatcher } from './lib/workspace.mjs';

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

const ACTIVE_DOC_EXTS = new Set(['.html', '.htm', '.svg', '.xml', '.xhtml']);
const MAX_RAW_FILE_BYTES = 128 * 1024 * 1024; // 128 MB safety guard
const MAX_HASH_VERSION_BYTES = 32 * 1024 * 1024; // 32 MB version digest limit
const MAX_POST_BODY_BYTES = 180 * 1024 * 1024; // Early HTTP POST body limit (covers base64 up to 128 MiB)
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

export function createStudioServer({
  SidecarApp,
  Response: ResponseClass,
  appDataDir,
  cacheDir,
  studioDir = __dirname,
} = {}) {
  const app = new SidecarApp();
  const security = new SecurityManager();
  const watcher = new WorkspaceWatcher();
  const converter = new OfficeConverter({
    scriptPath: join(studioDir, 'scripts', 'office-to-pdf.ps1'),
    cacheDir,
    timeoutMs: 25000,
  });

  const staticInfo = registerAllStaticAssets(app, ResponseClass, studioDir);

  const origRun = app.run.bind(app);
  app.run = async () => {
    const httpServer = await origRun();
    const existingListeners = httpServer.listeners('request').slice();
    httpServer.removeAllListeners('request');
    httpServer.on('request', (req, res) => {
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
      for (const listener of existingListeners) {
        listener.call(httpServer, req, res);
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
      return jsonResponse(ResponseClass, {
        success: true,
        status: 'ok',
        appDataDir,
        converters: caps,
        roots: security.getRoots(),
        generation: security.getGeneration(),
        hostLockedRoots: security.hasHostLockedRoots(),
        staticAssets: staticInfo.count,
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

  return {
    app,
    security,
    watcher,
    converter,
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

  mkdirSync(wsDir, { recursive: true });
  mkdirSync(ignoredDir, { recursive: true });
  mkdirSync(logsDir, { recursive: true });
  mkdirSync(cacheDir, { recursive: true });

  const sampleMd = join(wsDir, 'README.md');
  const sampleDoc = join(wsDir, 'report.docx');
  const ignoredFile = join(ignoredDir, 'secret.js');
  writeFileSync(sampleMd, '# Hello Sidecar Studio\n', 'utf8');
  writeFileSync(sampleDoc, Buffer.from('PK\x03\x04dummy-docx'));
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
      content: 'Created `report.docx`...',
      truncated_fields: ['content', 'thinking'],
      tool_calls: [
        {
          id: 'tc-1',
          name: 'write_file',
          args: { Path: JSON.stringify(sampleDoc) },
        },
      ],
    },
  ];
  const fullSteps = [
    compactSteps[0],
    {
      ...compactSteps[1],
      thinking: '**Drafting report**\nFULL_THINKING_CONTENT_VERIFIED',
      content: 'FULL_CONTENT_VERIFIED for report.docx',
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
  try {
    httpServer = await studio.app.run();
    const port = httpServer.address().port;
    const base = `http://127.0.0.1:${port}`;

    // 1. Static HTML & preload.js
    const rHome = await fetch(`${base}/`);
    assert.equal(rHome.status, 200);
    const homeHtml = await rHome.text();
    assert.ok(homeHtml.includes('/preload.js'), 'index.html must include /preload.js');

    const rPreload = await fetch(`${base}/preload.js`);
    assert.equal(rPreload.status, 200);

    // 2. Health
    const rHealth = await fetch(`${base}/api/health`);
    assert.equal(rHealth.status, 200);
    const healthJson = await rHealth.json();
    assert.equal(healthJson.success, true);

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

    console.log(
      `[antigravity-sidecar-studio --test] ALL PASSED (staticRoutes=${studio.staticInfo.count}, xlsx=${XLSX.version}, converters=${JSON.stringify(healthJson.converters)})`
    );
  } finally {
    await studio.close();
    rmSync(tmpRoot, { recursive: true, force: true });
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
    ];
    for (const f of watchTargets) {
      if (existsSync(f)) {
        watchFile(f, { interval: 2000 }, () => {
          console.log(`[antigravity-sidecar-studio] source changed (${f}), exiting for host restart...`);
          process.exit(0);
        });
      }
    }

    const studio = createStudioServer({
      SidecarApp,
      Response: ResponseClass,
      appDataDir,
      cacheDir,
      studioDir: __dirname,
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
