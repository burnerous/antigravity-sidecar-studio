import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  closeSync,
} from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, posix, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import tls from 'node:tls';
import * as zlib from 'node:zlib';

export const DEFAULT_REPO_SLUG = 'burnerous/antigravity-sidecar-studio';
export const DEFAULT_ALLOWED_DOWNLOAD_HOSTS = [
  'github.com',
  'api.github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'github-releases.githubusercontent.com',
  'codeload.github.com',
];
export const CHECK_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
export const MAX_UPDATE_ZIP_BYTES = 100 * 1024 * 1024; // 100 MiB
export const MAX_ZIP_ENTRIES = 10000;
export const MAX_ZIP_TOTAL_BYTES = 256 * 1024 * 1024; // 256 MiB
const REQUEST_TIMEOUT_MS = 12000;
const DOWNLOAD_TIMEOUT_MS = 120000;
const MAX_REDIRECTS = 5;
const STALE_WORK_AGE_MS = 24 * 60 * 60 * 1000;

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

export function computeCrc32(buf) {
  if (typeof zlib.crc32 === 'function') {
    return zlib.crc32(buf) >>> 0;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC32_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function normalizeVersion(v) {
  return String(v || '')
    .trim()
    .replace(/^v/i, '');
}

function parseSemver(raw) {
  const clean = normalizeVersion(raw);
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(clean);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ? m[4].split('.') : [],
  };
}

export function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) {
    const na = normalizeVersion(a);
    const nb = normalizeVersion(b);
    if (na === nb) return 0;
    return na > nb ? 1 : -1;
  }
  if (pa.major !== pb.major) return pa.major > pb.major ? 1 : -1;
  if (pa.minor !== pb.minor) return pa.minor > pb.minor ? 1 : -1;
  if (pa.patch !== pb.patch) return pa.patch > pb.patch ? 1 : -1;

  const aPre = pa.prerelease;
  const bPre = pb.prerelease;
  if (aPre.length === 0 && bPre.length === 0) return 0;
  if (aPre.length === 0) return 1;
  if (bPre.length === 0) return -1;

  const len = Math.max(aPre.length, bPre.length);
  for (let i = 0; i < len; i++) {
    if (i >= aPre.length) return -1;
    if (i >= bPre.length) return 1;
    const ai = aPre[i];
    const bi = bPre[i];
    if (ai === bi) continue;
    const aNum = /^\d+$/.test(ai);
    const bNum = /^\d+$/.test(bi);
    if (aNum && bNum) {
      const na = Number(ai);
      const nb = Number(bi);
      if (na !== nb) return na > nb ? 1 : -1;
    } else if (aNum !== bNum) {
      return aNum ? -1 : 1;
    } else {
      return ai > bi ? 1 : -1;
    }
  }
  return 0;
}

export function parseRepoSlug(pluginJson) {
  const raw =
    typeof pluginJson?.repository === 'string'
      ? pluginJson.repository
      : pluginJson?.repository?.url || pluginJson?.homepage || '';
  const m = /github\.com[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:[/?#]|$)/i.exec(
    String(raw || '')
  );
  if (m) {
    return { owner: m[1], repo: m[2], slug: `${m[1]}/${m[2]}` };
  }
  const [owner, repo] = DEFAULT_REPO_SLUG.split('/');
  return { owner, repo, slug: DEFAULT_REPO_SLUG };
}

export function extractChangelog(releaseBody) {
  const raw = String(releaseBody || '').replace(/\r\n/g, '\n').trim();
  if (!raw) return '';
  const headerRe = /(?:^|\n)###\s*(?:📝\s*)?更新内容[^\n]*\n([\s\S]*?)(?=\n---|\n###\s*(?:📦|🔐)|$)/i;
  const match = headerRe.exec(raw);
  const extracted = (match ? match[1] : raw).trim();
  return extracted.length > 8000 ? `${extracted.slice(0, 8000)}\n...` : extracted;
}

export function extractSha256FromBody(releaseBody) {
  const m = /(?:\*\*SHA-256\*\*|SHA-256)\s*[：:]\s*`?([0-9a-fA-F]{64})`?/i.exec(
    String(releaseBody || '')
  );
  return m ? m[1].toLowerCase() : '';
}

export function parseSha256Sums(text, assetName) {
  const lines = String(text || '').split(/\r?\n/);
  const targetLower = String(assetName || '').toLowerCase();
  for (const line of lines) {
    const m = /^\s*([0-9a-fA-F]{64})\s+[* ]?(.+?)\s*$/.exec(line);
    if (!m) continue;
    const fileToken = posix.basename(m[2].replace(/\\/g, '/')).toLowerCase();
    if (!targetLower || fileToken === targetLower) {
      return m[1].toLowerCase();
    }
  }
  return '';
}

function normalizeMirrorInput(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return '';
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw makeUpdaterError(400, '自定义镜像地址格式无效，请输入完整 HTTPS URL');
  }
  if (parsed.protocol !== 'https:') {
    throw makeUpdaterError(400, '出于安全限制，自定义镜像地址必须使用 https:// 协议');
  }
  return trimmed;
}

function makeUpdaterError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isNoProxyHost(hostname, noProxyRaw) {
  const host = String(hostname || '').toLowerCase();
  if (!host || host === '127.0.0.1' || host === 'localhost' || host === '::1') {
    return true;
  }
  if (!noProxyRaw) return false;
  const entries = String(noProxyRaw)
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  for (const entry of entries) {
    if (entry === '*') return true;
    const clean = entry.replace(/^\./, '');
    if (host === clean || host.endsWith(`.${clean}`)) return true;
  }
  return false;
}

function resolveProxyForUrl(targetUrl) {
  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return '';
  }
  const noProxy = process.env.NO_PROXY || process.env.no_proxy || '';
  if (isNoProxyHost(parsed.hostname, noProxy)) return '';
  if (parsed.protocol === 'https:') {
    return (
      process.env.HTTPS_PROXY ||
      process.env.https_proxy ||
      process.env.HTTP_PROXY ||
      process.env.http_proxy ||
      ''
    ).trim();
  }
  if (parsed.protocol === 'http:') {
    return (process.env.HTTP_PROXY || process.env.http_proxy || '').trim();
  }
  return '';
}

function fetchViaHttpProxy(targetUrl, proxyUrl, { method = 'GET', headers = {}, timeoutMs = REQUEST_TIMEOUT_MS, signal } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const target = new URL(targetUrl);
    const proxy = new URL(proxyUrl);
    const proxyMod = proxy.protocol === 'https:' ? https : http;
    const proxyPort = Number(proxy.port) || (proxy.protocol === 'https:' ? 443 : 80);

    const proxyHeaders = {};
    if (proxy.username || proxy.password) {
      const creds = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
      proxyHeaders['Proxy-Authorization'] = `Basic ${Buffer.from(creds).toString('base64')}`;
    }

    let settled = false;
    let connectReq = null;
    let upstreamReq = null;
    let activeSocket = null;

    const cleanupListeners = () => {
      if (signal && onAbort) {
        signal.removeEventListener('abort', onAbort);
      }
    };

    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanupListeners();
      try { connectReq?.destroy(); } catch {}
      try { upstreamReq?.destroy(); } catch {}
      try { activeSocket?.destroy(); } catch {}
      rejectPromise(err instanceof Error ? err : new Error(String(err)));
    };

    const onAbort = () => fail(new Error('Proxy request aborted'));
    if (signal) {
      if (signal.aborted) {
        fail(new Error('Proxy request aborted'));
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    const wrapResponse = (res) => {
      if (settled) return;
      settled = true;
      cleanupListeners();
      const status = res.statusCode || 0;
      const webBody = Readable.toWeb(res);
      let cachedBufPromise = null;
      const readAllBuffer = () => {
        if (!cachedBufPromise) {
          cachedBufPromise = new Promise((resBuf, rejBuf) => {
            const chunks = [];
            const reader = webBody.getReader();
            const pump = () => {
              reader.read().then(({ done, value }) => {
                if (done) {
                  resBuf(Buffer.concat(chunks));
                  return;
                }
                chunks.push(Buffer.from(value));
                pump();
              }, rejBuf);
            };
            pump();
          });
        }
        return cachedBufPromise;
      };
      resolvePromise({
        ok: status >= 200 && status < 300,
        status,
        headers: {
          get(name) {
            const v = res.headers[String(name || '').toLowerCase()];
            if (Array.isArray(v)) return v.join(', ');
            return v === undefined ? null : String(v);
          },
        },
        body: webBody,
        async arrayBuffer() {
          const buf = await readAllBuffer();
          return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
        },
        async text() {
          return (await readAllBuffer()).toString('utf8');
        },
        async json() {
          return JSON.parse((await readAllBuffer()).toString('utf8'));
        },
      });
    };

    if (target.protocol === 'http:') {
      upstreamReq = proxyMod.request(
        {
          hostname: proxy.hostname,
          port: proxyPort,
          path: targetUrl,
          method,
          headers: { ...headers, ...proxyHeaders, Host: target.host },
          timeout: timeoutMs,
        },
        wrapResponse
      );
      upstreamReq.on('timeout', () => fail(new Error('Proxy HTTP request timed out')));
      upstreamReq.on('error', fail);
      upstreamReq.end();
      return;
    }

    const targetPort = Number(target.port) || 443;
    const authority = `${target.hostname}:${targetPort}`;
    connectReq = proxyMod.request({
      hostname: proxy.hostname,
      port: proxyPort,
      method: 'CONNECT',
      path: authority,
      headers: { Host: authority, ...proxyHeaders },
      timeout: timeoutMs,
    });
    connectReq.on('timeout', () => fail(new Error('Proxy CONNECT timed out')));
    connectReq.on('error', fail);
    connectReq.on('connect', (connectRes, socket) => {
      activeSocket = socket;
      socket.on('error', fail);
      if (connectRes.statusCode !== 200) {
        fail(new Error(`Proxy CONNECT failed: HTTP ${connectRes.statusCode}`));
        return;
      }
      const tlsSocket = tls.connect({ socket, servername: target.hostname });
      activeSocket = tlsSocket;
      tlsSocket.on('error', fail);

      upstreamReq = https.request(
        {
          hostname: target.hostname,
          port: targetPort,
          path: `${target.pathname}${target.search}`,
          method,
          headers: { ...headers, Host: target.host },
          createConnection: () => tlsSocket,
          agent: false,
          timeout: timeoutMs,
        },
        wrapResponse
      );
      upstreamReq.on('timeout', () => fail(new Error('Upstream HTTPS request timed out')));
      upstreamReq.on('error', fail);
      upstreamReq.end();
    });
    connectReq.end();
  });
}

function sha256File(filePath) {
  if (!existsSync(filePath)) return '';
  const h = createHash('sha256');
  const fd = openSync(filePath, 'r');
  try {
    const buf = Buffer.allocUnsafe(65536);
    while (true) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      h.update(n === buf.length ? buf : buf.subarray(0, n));
    }
    return h.digest('hex').toLowerCase();
  } finally {
    closeSync(fd);
  }
}

function readRangeSync(fd, length, position) {
  const buf = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const n = readSync(fd, buf, offset, length - offset, position + offset);
    if (n <= 0) break;
    offset += n;
  }
  if (offset !== length) {
    throw new Error(`Unexpected EOF while reading ZIP (${offset}/${length} bytes)`);
  }
  return buf;
}

function isSafeZipEntryName(name) {
  if (!name || typeof name !== 'string') return false;
  if (name.includes('\0') || name.includes('\\')) return false;
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) return false;
  const parts = name.split('/').filter((p) => p.length > 0);
  if (parts.some((p) => p === '.' || p === '..')) return false;
  return true;
}

export function extractZipSafely(
  zipPath,
  destDir,
  {
    expectedRootPrefix = 'antigravity-sidecar-studio/',
    maxEntries = MAX_ZIP_ENTRIES,
    maxTotalBytes = MAX_ZIP_TOTAL_BYTES,
  } = {}
) {
  const st = statSync(zipPath);
  if (st.size < 22) {
    throw new Error('ZIP 文件过小或已损坏');
  }

  const fd = openSync(zipPath, 'r');
  try {
    const searchLen = Math.min(st.size, 65557);
    const tailStart = st.size - searchLen;
    const tail = readRangeSync(fd, searchLen, tailStart);

    let eocdPos = -1;
    for (let i = searchLen - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        const commentLen = tail.readUInt16LE(i + 20);
        if (i + 22 + commentLen === searchLen) {
          eocdPos = i;
          break;
        }
      }
    }
    if (eocdPos === -1) {
      throw new Error('无效的 ZIP 归档：未找到 End of Central Directory');
    }

    const diskNo = tail.readUInt16LE(eocdPos + 4);
    const cdDisk = tail.readUInt16LE(eocdPos + 6);
    const totalEntries = tail.readUInt16LE(eocdPos + 10);
    const cdSize = tail.readUInt32LE(eocdPos + 12);
    const cdOffset = tail.readUInt32LE(eocdPos + 16);

    if (
      diskNo !== 0 ||
      cdDisk !== 0 ||
      totalEntries === 0xffff ||
      cdSize === 0xffffffff ||
      cdOffset === 0xffffffff
    ) {
      throw new Error('不支持分卷或 Zip64 归档格式');
    }
    if (totalEntries > maxEntries) {
      throw new Error(`ZIP 条目数超出限制 (${totalEntries} > ${maxEntries})`);
    }
    if (cdOffset + cdSize > st.size) {
      throw new Error('ZIP Central Directory 越界');
    }

    const cdBuf = readRangeSync(fd, cdSize, cdOffset);
    mkdirSync(destDir, { recursive: true });
    const destRootResolved = resolve(destDir);
    const normalizedRoot = expectedRootPrefix
      ? expectedRootPrefix.endsWith('/')
        ? expectedRootPrefix
        : `${expectedRootPrefix}/`
      : '';
    const rootDirBare = normalizedRoot.replace(/\/$/, '');

    let cursor = 0;
    let totalUncompressed = 0;
    let extractedFiles = 0;

    for (let idx = 0; idx < totalEntries; idx++) {
      if (cursor + 46 > cdBuf.length || cdBuf.readUInt32LE(cursor) !== 0x02014b50) {
        throw new Error(`ZIP Central Directory 记录损坏 (index=${idx})`);
      }
      const method = cdBuf.readUInt16LE(cursor + 10);
      const crc32 = cdBuf.readUInt32LE(cursor + 16);
      const compSize = cdBuf.readUInt32LE(cursor + 20);
      const uncompSize = cdBuf.readUInt32LE(cursor + 24);
      const nameLen = cdBuf.readUInt16LE(cursor + 28);
      const extraLen = cdBuf.readUInt16LE(cursor + 30);
      const commentLen = cdBuf.readUInt16LE(cursor + 32);
      const externalAttr = cdBuf.readUInt32LE(cursor + 38);
      const lfhOffset = cdBuf.readUInt32LE(cursor + 42);

      const headerEnd = cursor + 46 + nameLen + extraLen + commentLen;
      if (headerEnd > cdBuf.length) {
        throw new Error('ZIP 文件头长度越界');
      }

      const rawName = cdBuf.subarray(cursor + 46, cursor + 46 + nameLen).toString('utf8');
      cursor = headerEnd;

      if (!isSafeZipEntryName(rawName)) {
        throw new Error(`检测到不安全的 ZIP 路径: ${rawName}`);
      }

      const unixMode = (externalAttr >>> 16) & 0o170000;
      if (unixMode === 0o120000) {
        throw new Error(`ZIP 归档包含禁止的符号链接: ${rawName}`);
      }

      let relPath = rawName;
      if (normalizedRoot) {
        if (rawName === rootDirBare || rawName === normalizedRoot) {
          continue;
        }
        if (!rawName.startsWith(normalizedRoot)) {
          throw new Error(`ZIP 目录层级异常（期望根目录 ${normalizedRoot}）: ${rawName}`);
        }
        relPath = rawName.slice(normalizedRoot.length);
      }
      if (!relPath) continue;

      if (relPath.endsWith('/')) {
        const targetDir = resolve(destRootResolved, relPath);
        if (targetDir !== destRootResolved && !targetDir.startsWith(destRootResolved + sep)) {
          throw new Error(`ZIP 解压目录越界: ${rawName}`);
        }
        mkdirSync(targetDir, { recursive: true });
        continue;
      }

      if (method !== 0 && method !== 8) {
        throw new Error(`不支持的 ZIP 压缩算法 (${method}): ${rawName}`);
      }

      totalUncompressed += uncompSize;
      if (totalUncompressed > maxTotalBytes) {
        throw new Error(`ZIP 解压总大小超出安全上限 (${maxTotalBytes} bytes)`);
      }

      if (lfhOffset + 30 > st.size) {
        throw new Error(`ZIP Local File Header 越界: ${rawName}`);
      }
      const lfh = readRangeSync(fd, 30, lfhOffset);
      if (lfh.readUInt32LE(0) !== 0x04034b50) {
        throw new Error(`ZIP Local File Header 签名无效: ${rawName}`);
      }
      const lfhNameLen = lfh.readUInt16LE(26);
      const lfhExtraLen = lfh.readUInt16LE(28);
      const dataOffset = lfhOffset + 30 + lfhNameLen + lfhExtraLen;
      if (dataOffset + compSize > st.size) {
        throw new Error(`ZIP 压缩数据越界: ${rawName}`);
      }

      const compBuf = compSize > 0 ? readRangeSync(fd, compSize, dataOffset) : Buffer.alloc(0);
      const outBuf =
        method === 0
          ? compBuf
          : zlib.inflateRawSync(compBuf, { maxOutputLength: Math.max(1, uncompSize) });

      if (outBuf.length !== uncompSize) {
        throw new Error(`ZIP 解压大小不匹配: ${rawName} (${outBuf.length} != ${uncompSize})`);
      }
      const actualCrc = computeCrc32(outBuf);
      if (actualCrc !== (crc32 >>> 0)) {
        throw new Error(`ZIP CRC-32 校验失败: ${rawName}`);
      }

      const targetPath = resolve(destRootResolved, relPath);
      if (!targetPath.startsWith(destRootResolved + sep)) {
        throw new Error(`ZIP 解压文件路径越界: ${rawName}`);
      }
      mkdirSync(dirname(targetPath), { recursive: true });
      writeFileSync(targetPath, outBuf);
      extractedFiles += 1;
    }

    return { totalEntries, extractedFiles, totalUncompressed };
  } finally {
    closeSync(fd);
  }
}

function syncDirInPlace(srcDir, dstDir) {
  mkdirSync(dstDir, { recursive: true });
  const srcEntries = readdirSync(srcDir, { withFileTypes: true });
  const srcNames = new Set(srcEntries.map((e) => e.name));

  for (const existing of readdirSync(dstDir, { withFileTypes: true })) {
    if (!srcNames.has(existing.name)) {
      rmSync(join(dstDir, existing.name), { recursive: true, force: true });
    }
  }

  for (const entry of srcEntries) {
    const srcPath = join(srcDir, entry.name);
    const dstPath = join(dstDir, entry.name);
    if (entry.isDirectory()) {
      if (existsSync(dstPath) && !statSync(dstPath).isDirectory()) {
        rmSync(dstPath, { recursive: true, force: true });
      }
      syncDirInPlace(srcPath, dstPath);
    } else if (entry.isFile()) {
      if (existsSync(dstPath) && statSync(dstPath).isDirectory()) {
        rmSync(dstPath, { recursive: true, force: true });
      }
      copyFileSync(srcPath, dstPath);
    }
  }
}

async function retryFsOp(fn, delays = [100, 250, 500]) {
  let lastErr;
  for (let i = 0; i <= delays.length; i++) {
    try {
      return fn();
    } catch (err) {
      lastErr = err;
      const retryable = err?.code === 'EPERM' || err?.code === 'EBUSY' || err?.code === 'EACCES';
      if (!retryable || i === delays.length) throw err;
      await sleep(delays[i]);
    }
  }
  throw lastErr;
}

async function replaceFileSafely(srcPath, dstPath, suffix = 'upd') {
  mkdirSync(dirname(dstPath), { recursive: true });
  const tmpPath = `${dstPath}.__new_${suffix}`;
  try {
    copyFileSync(srcPath, tmpPath);
    await retryFsOp(() => renameSync(tmpPath, dstPath));
  } catch {
    rmSync(tmpPath, { force: true });
    await retryFsOp(() => copyFileSync(srcPath, dstPath));
  }
}

async function swapDirectorySafely(srcDir, dstDir, jobId) {
  if (!existsSync(srcDir)) {
    if (existsSync(dstDir)) {
      rmSync(dstDir, { recursive: true, force: true });
    }
    return;
  }
  mkdirSync(dirname(dstDir), { recursive: true });
  const tmpNew = `${dstDir}.__new_${jobId}`;
  const tmpOld = `${dstDir}.__old_${jobId}`;
  rmSync(tmpNew, { recursive: true, force: true });
  rmSync(tmpOld, { recursive: true, force: true });

  cpSync(srcDir, tmpNew, { recursive: true });
  let movedOld = false;
  try {
    if (existsSync(dstDir)) {
      await retryFsOp(() => renameSync(dstDir, tmpOld));
      movedOld = true;
    }
    await retryFsOp(() => renameSync(tmpNew, dstDir));
    if (movedOld) {
      rmSync(tmpOld, { recursive: true, force: true });
    }
  } catch (err) {
    if (movedOld && !existsSync(dstDir) && existsSync(tmpOld)) {
      try {
        renameSync(tmpOld, dstDir);
      } catch {}
    }
    rmSync(tmpNew, { recursive: true, force: true });
    const lockErr = err?.code === 'EPERM' || err?.code === 'EBUSY' || err?.code === 'EACCES';
    if (!lockErr) throw err;
    syncDirInPlace(srcDir, dstDir);
  }
}

function cleanupLeftoverSiblings(dir) {
  if (!existsSync(dir)) return;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (/\.__((?:new|old)_[A-Za-z0-9_-]+)$/.test(entry.name)) {
        rmSync(join(dir, entry.name), { recursive: true, force: true });
      }
    }
  } catch {}
}

export class PluginUpdater {
  #pluginRoot;
  #studioDir;
  #dataDir;
  #statePath;
  #workRoot;
  #bootId;
  #fetch;
  #apiBaseUrl;
  #webBaseUrl;
  #allowedHosts;
  #prepareForSelfUpdate;
  #onRestart;
  #checkTtlMs;
  #npmCmdTimeoutMs;
  #state;
  #checkPromise = null;
  #job = null;
  #jobPromise = null;

  constructor({
    pluginRoot,
    studioDir,
    dataDir,
    bootId = '',
    fetchImpl = globalThis.fetch,
    apiBaseUrl = 'https://api.github.com',
    webBaseUrl = 'https://github.com',
    allowedDownloadHosts = DEFAULT_ALLOWED_DOWNLOAD_HOSTS,
    prepareForSelfUpdate = null,
    onRestart = null,
    checkTtlMs = CHECK_CACHE_TTL_MS,
    npmCmdTimeoutMs = 120000,
  } = {}) {
    this.#pluginRoot = resolve(pluginRoot);
    this.#studioDir = resolve(studioDir || join(this.#pluginRoot, 'sidecars', 'studio'));
    this.#dataDir = resolve(dataDir || join(tmpdir(), 'antigravity-sidecar-studio-updater'));
    this.#statePath = join(this.#dataDir, 'updater-state.json');
    this.#workRoot = join(this.#dataDir, 'updater-work');
    this.#bootId = String(bootId || '');
    this.#fetch = fetchImpl;
    this.#apiBaseUrl = String(apiBaseUrl || 'https://api.github.com').replace(/\/+$/, '');
    this.#webBaseUrl = String(webBaseUrl || 'https://github.com').replace(/\/+$/, '');
    this.#allowedHosts = new Set(
      (allowedDownloadHosts || DEFAULT_ALLOWED_DOWNLOAD_HOSTS).map((h) => String(h).toLowerCase())
    );
    this.#prepareForSelfUpdate = prepareForSelfUpdate;
    this.#onRestart = onRestart;
    this.#checkTtlMs = checkTtlMs;
    this.#npmCmdTimeoutMs = npmCmdTimeoutMs;
    this.#state = this.#loadState();
    this.#cleanupStaleArtifacts();
  }

  #cleanupStaleArtifacts() {
    cleanupLeftoverSiblings(this.#pluginRoot);
    cleanupLeftoverSiblings(join(this.#pluginRoot, 'sidecars'));
    cleanupLeftoverSiblings(this.#studioDir);

    if (!existsSync(this.#workRoot)) return;
    const now = Date.now();
    try {
      for (const entry of readdirSync(this.#workRoot, { withFileTypes: true })) {
        const full = join(this.#workRoot, entry.name);
        try {
          const st = statSync(full);
          if (now - st.mtimeMs > STALE_WORK_AGE_MS) {
            rmSync(full, { recursive: true, force: true });
          }
        } catch {}
      }
    } catch {}
  }

  #loadState() {
    const defaults = {
      autoCheck: true,
      customMirror: '',
      dismissedVersion: '',
      lastCheckAt: 0,
      lastError: null,
      latest: null,
      lastUpdate: null,
    };
    if (!existsSync(this.#statePath)) return defaults;
    try {
      const parsed = JSON.parse(readFileSync(this.#statePath, 'utf8'));
      return {
        ...defaults,
        autoCheck: typeof parsed?.autoCheck === 'boolean' ? parsed.autoCheck : true,
        customMirror: typeof parsed?.customMirror === 'string' ? parsed.customMirror : '',
        dismissedVersion: typeof parsed?.dismissedVersion === 'string' ? parsed.dismissedVersion : '',
        lastCheckAt: Number.isFinite(parsed?.lastCheckAt) ? parsed.lastCheckAt : 0,
        lastError: typeof parsed?.lastError === 'string' ? parsed.lastError : null,
        latest: parsed?.latest && typeof parsed.latest === 'object' ? parsed.latest : null,
        lastUpdate:
          parsed?.lastUpdate && typeof parsed.lastUpdate === 'object' ? parsed.lastUpdate : null,
      };
    } catch {
      return defaults;
    }
  }

  #saveState() {
    try {
      mkdirSync(dirname(this.#statePath), { recursive: true });
      const tmp = `${this.#statePath}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.#state, null, 2), 'utf8');
      renameSync(tmp, this.#statePath);
    } catch {}
  }

  #readCurrentManifest() {
    const pjPath = join(this.#pluginRoot, 'plugin.json');
    try {
      return JSON.parse(readFileSync(pjPath, 'utf8'));
    } catch {
      return { name: 'antigravity-sidecar-studio', version: '0.0.0' };
    }
  }

  #detectInstallMode() {
    const isGit = existsSync(join(this.#pluginRoot, '.git'));
    if (!isGit) {
      return {
        installMode: 'offline-zip',
        gitInfo: null,
      };
    }

    let branch = '';
    let dirty = false;
    let commit = '';
    let gitError = '';
    try {
      branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: this.#pluginRoot,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 4000,
      }).trim();
      const statusOut = execFileSync('git', ['status', '--porcelain'], {
        cwd: this.#pluginRoot,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 4000,
      }).trim();
      dirty = statusOut.length > 0;
      commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
        cwd: this.#pluginRoot,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 4000,
      }).trim();
    } catch (err) {
      gitError = err?.message || '无法读取 Git 状态';
    }

    let blockReason = '';
    if (gitError) {
      blockReason = `Git 状态检测失败：${gitError}`;
    } else if (branch !== 'main') {
      blockReason = `当前 Git 分支为 "${branch}"，仅支持在干净的 main 分支自动更新`;
    } else if (dirty) {
      blockReason = '检测到工作区存在未提交改动，请先提交或暂存后再自动更新';
    }

    return {
      installMode: 'git',
      gitInfo: {
        branch,
        commit,
        dirty,
        canAutoUpdate: !blockReason,
        blockReason,
      },
    };
  }

  getStatus() {
    const manifest = this.#readCurrentManifest();
    const currentVersion = normalizeVersion(manifest.version || '0.0.0');
    const repo = parseRepoSlug(manifest);
    const { installMode, gitInfo } = this.#detectInstallMode();

    const latest = this.#state.latest;
    const latestVersion = latest?.version ? normalizeVersion(latest.version) : '';
    const updateAvailable = Boolean(latestVersion && compareSemver(latestVersion, currentVersion) > 0);
    const dismissed = normalizeVersion(this.#state.dismissedVersion || '');
    const hasUnseenUpdate = Boolean(updateAvailable && latestVersion !== dismissed);

    const lastUpdate = this.#state.lastUpdate;
    const justUpdated = Boolean(
      lastUpdate &&
        lastUpdate.acknowledged === false &&
        normalizeVersion(lastUpdate.toVersion) === currentVersion
    );

    return {
      currentVersion,
      bootId: this.#bootId,
      repo,
      installMode,
      gitInfo,
      autoCheck: this.#state.autoCheck,
      customMirror: this.#state.customMirror,
      dismissedVersion: this.#state.dismissedVersion,
      lastCheckAt: this.#state.lastCheckAt,
      checkInFlight: Boolean(this.#checkPromise),
      latest,
      updateAvailable,
      hasUnseenUpdate,
      lastError: this.#state.lastError,
      job: this.#job ? { ...this.#job } : null,
      lastUpdate,
      justUpdated,
    };
  }

  updatePreferences({ autoCheck, dismissedVersion, customMirror } = {}) {
    if (typeof autoCheck === 'boolean') {
      this.#state.autoCheck = autoCheck;
    }
    if (typeof dismissedVersion === 'string') {
      this.#state.dismissedVersion = dismissedVersion.trim() ? normalizeVersion(dismissedVersion) : '';
    }
    if (customMirror !== undefined) {
      this.#state.customMirror = normalizeMirrorInput(customMirror);
    }
    this.#saveState();
    return this.getStatus();
  }

  acknowledgeUpdated() {
    if (this.#state.lastUpdate) {
      this.#state.lastUpdate = { ...this.#state.lastUpdate, acknowledged: true };
      this.#saveState();
    }
    return this.getStatus();
  }

  #isLocalTestOrigin(urlObj) {
    const host = urlObj.hostname.toLowerCase();
    return (
      (host === '127.0.0.1' || host === 'localhost') &&
      this.#allowedHosts.has(host) &&
      (this.#apiBaseUrl.startsWith('http://') || this.#webBaseUrl.startsWith('http://'))
    );
  }

  #assertAllowedDownloadUrl(rawUrl, extraHosts = []) {
    let parsed;
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw makeUpdaterError(400, `无效的下载地址: ${rawUrl}`);
    }
    const host = parsed.hostname.toLowerCase();
    const allowHttpLocal = this.#isLocalTestOrigin(parsed);
    if (parsed.protocol !== 'https:' && !allowHttpLocal) {
      throw makeUpdaterError(403, `拒绝非 HTTPS 下载地址: ${rawUrl}`);
    }
    const allowed = this.#allowedHosts.has(host) || extraHosts.includes(host);
    if (!allowed) {
      throw makeUpdaterError(403, `下载地址域名不在允许列表内: ${host}`);
    }
    return parsed;
  }

  async #doFetch(url, opts = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
    if (this.#fetch === globalThis.fetch) {
      const proxyUrl = resolveProxyForUrl(url);
      if (proxyUrl) {
        return fetchViaHttpProxy(url, proxyUrl, {
          method: opts.method || 'GET',
          headers: opts.headers || {},
          timeoutMs,
          signal: opts.signal,
        });
      }
    }
    return this.#fetch(url, opts);
  }

  async #fetchSafeWithRedirects(rawUrl, { timeoutMs = REQUEST_TIMEOUT_MS, extraHosts = [], headers = {} } = {}) {
    let currentUrl = rawUrl;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      this.#assertAllowedDownloadUrl(currentUrl, extraHosts);
      const res = await this.#doFetch(
        currentUrl,
        {
          method: 'GET',
          redirect: 'manual',
          headers,
          signal: AbortSignal.timeout(timeoutMs),
        },
        timeoutMs
      );
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        try {
          await res.body?.cancel?.();
        } catch {}
        if (!loc) throw new Error(`HTTP ${res.status} 重定向缺少 Location 头`);
        currentUrl = new URL(loc, currentUrl).href;
        continue;
      }
      return { res, finalUrl: currentUrl };
    }
    throw new Error('下载重定向次数过多');
  }

  async #checkViaGitHubApi(repoSlug, currentVersion) {
    const apiUrl = `${this.#apiBaseUrl}/repos/${repoSlug}/releases/latest`;
    const res = await this.#doFetch(
      apiUrl,
      {
        method: 'GET',
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': `antigravity-sidecar-studio/${currentVersion}`,
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
      REQUEST_TIMEOUT_MS
    );

    if (!res.ok) {
      const err = new Error(`GitHub API HTTP ${res.status}`);
      err.httpStatus = res.status;
      throw err;
    }

    const rel = await res.json();
    if (!rel || rel.draft || rel.prerelease) {
      throw new Error('未找到已发布的正式 Release');
    }

    const tagName = String(rel.tag_name || '').trim();
    const version = normalizeVersion(tagName);
    if (!version) {
      throw new Error('Release 缺少有效的版本号 Tag');
    }

    const assets = Array.isArray(rel.assets) ? rel.assets : [];
    const zipAsset =
      assets.find((a) => /^antigravity-sidecar-studio-.*-offline\.zip$/i.test(a?.name || '')) ||
      assets.find((a) => /\.zip$/i.test(a?.name || ''));

    const digestRaw = typeof zipAsset?.digest === 'string' ? zipAsset.digest.trim() : '';
    const digestMatch = /^sha256:([0-9a-fA-F]{64})$/i.exec(digestRaw);
    const assetSha256 = digestMatch ? digestMatch[1].toLowerCase() : '';
    const bodySha256 = extractSha256FromBody(rel.body);

    if (assetSha256 && bodySha256 && assetSha256 !== bodySha256) {
      throw makeUpdaterError(
        502,
        `Release 校验摘要不一致（资产摘要 ${assetSha256.slice(0, 12)}... 与正文 ${bodySha256.slice(0, 12)}... 不匹配）`
      );
    }

    let sha256 = assetSha256 || bodySha256 || '';
    if (!sha256 && zipAsset?.name) {
      const sumsAsset = assets.find((a) => /^SHA256SUMS\.txt$/i.test(a?.name || ''));
      if (sumsAsset?.browser_download_url) {
        try {
          const { res: sumsRes } = await this.#fetchSafeWithRedirects(
            sumsAsset.browser_download_url,
            { timeoutMs: 8000 }
          );
          if (sumsRes.ok) {
            sha256 = parseSha256Sums(await sumsRes.text(), zipAsset.name);
          }
        } catch {}
      }
    }

    return {
      tagName,
      version,
      name: String(rel.name || tagName),
      publishedAt: rel.published_at || '',
      releaseUrl: rel.html_url || `${this.#webBaseUrl}/${repoSlug}/releases/tag/${tagName}`,
      changelog: extractChangelog(rel.body),
      assetName: zipAsset?.name || `antigravity-sidecar-studio-${tagName}-offline.zip`,
      assetSize: Number(zipAsset?.size || 0),
      downloadUrl: zipAsset?.browser_download_url || '',
      sha256,
      source: 'github-api',
    };
  }

  async #checkViaWebRedirectFallback(repoSlug, currentVersion) {
    const latestUrl = `${this.#webBaseUrl}/${repoSlug}/releases/latest`;
    const res = await this.#doFetch(
      latestUrl,
      {
        method: 'GET',
        redirect: 'manual',
        headers: {
          'User-Agent': `antigravity-sidecar-studio/${currentVersion}`,
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
      REQUEST_TIMEOUT_MS
    );

    if (res.status < 300 || res.status >= 400) {
      throw new Error(`GitHub Release 重定向检查失败: HTTP ${res.status}`);
    }
    const loc = res.headers.get('location') || '';
    const tagMatch = /\/releases\/tag\/(v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/i.exec(loc);
    if (!tagMatch) {
      throw new Error(`无法从重定向地址解析版本号: ${loc}`);
    }

    const tagName = tagMatch[1];
    const version = normalizeVersion(tagName);
    const assetName = `antigravity-sidecar-studio-${tagName}-offline.zip`;
    const downloadUrl = `${this.#webBaseUrl}/${repoSlug}/releases/download/${tagName}/${assetName}`;
    const releaseUrl = `${this.#webBaseUrl}/${repoSlug}/releases/tag/${tagName}`;

    let sha256 = '';
    try {
      const sumsUrl = `${this.#webBaseUrl}/${repoSlug}/releases/download/${tagName}/SHA256SUMS.txt`;
      const { res: sumsRes } = await this.#fetchSafeWithRedirects(sumsUrl, { timeoutMs: 8000 });
      if (sumsRes.ok) {
        sha256 = parseSha256Sums(await sumsRes.text(), assetName);
      }
    } catch {}

    return {
      tagName,
      version,
      name: `Sidecar Studio ${tagName}`,
      publishedAt: '',
      releaseUrl,
      changelog: `检测到新版本 ${tagName}（当前通过备用通道获取，完整更新日志请查看 GitHub Release 页面）。`,
      assetName,
      assetSize: 0,
      downloadUrl,
      sha256,
      source: 'redirect-fallback',
    };
  }

  async checkForUpdates({ force = false, background = false, customMirror } = {}) {
    if (customMirror !== undefined) {
      this.#state.customMirror = normalizeMirrorInput(customMirror);
      this.#saveState();
    }

    if (
      !force &&
      this.#state.latest &&
      this.#state.lastCheckAt > 0 &&
      Date.now() - this.#state.lastCheckAt < this.#checkTtlMs
    ) {
      return this.getStatus();
    }

    if (this.#checkPromise) {
      return this.#checkPromise;
    }

    this.#checkPromise = (async () => {
      const manifest = this.#readCurrentManifest();
      const currentVersion = normalizeVersion(manifest.version || '0.0.0');
      const repo = parseRepoSlug(manifest);

      try {
        let latest;
        try {
          latest = await this.#checkViaGitHubApi(repo.slug, currentVersion);
        } catch (apiErr) {
          if (apiErr?.status === 502 && /校验摘要不一致/.test(apiErr.message)) {
            throw apiErr;
          }
          latest = await this.#checkViaWebRedirectFallback(repo.slug, currentVersion);
        }

        this.#state.latest = latest;
        this.#state.lastCheckAt = Date.now();
        this.#state.lastError = null;
        this.#saveState();
        return this.getStatus();
      } catch (err) {
        const msg = err?.message || '检查更新失败';
        if (background) {
          return {
            ...this.getStatus(),
            backgroundError: msg,
          };
        }
        this.#state.lastError = msg;
        this.#saveState();
        throw makeUpdaterError(err?.status || 502, msg);
      } finally {
        this.#checkPromise = null;
      }
    })();

    return this.#checkPromise;
  }

  #buildDownloadUrl(rawUrl, customMirror) {
    if (!customMirror) return rawUrl;
    if (customMirror.includes('{url}')) {
      return customMirror.replace(/\{url\}/g, rawUrl);
    }
    const base = customMirror.endsWith('/') ? customMirror : `${customMirror}/`;
    return `${base}${rawUrl}`;
  }

  async #downloadReleaseZip(release, zipPath, effectiveMirror, job) {
    const requestUrl = this.#buildDownloadUrl(release.downloadUrl, effectiveMirror);
    const extraHosts = [];
    if (effectiveMirror) {
      extraHosts.push(new URL(effectiveMirror).hostname.toLowerCase());
    }

    const { res } = await this.#fetchSafeWithRedirects(requestUrl, {
      timeoutMs: DOWNLOAD_TIMEOUT_MS,
      extraHosts,
      headers: {
        'User-Agent': `antigravity-sidecar-studio/${job.fromVersion}`,
      },
    });

    if (!res.ok) {
      throw new Error(`下载更新包失败: HTTP ${res.status}`);
    }

    const contentLen = Number(res.headers.get('content-length') || release.assetSize || 0);
    if (contentLen > MAX_UPDATE_ZIP_BYTES) {
      throw new Error(`更新包大小超出安全限制 (${contentLen} bytes)`);
    }

    mkdirSync(dirname(zipPath), { recursive: true });
    const chunks = [];
    let received = 0;

    if (res.body && typeof res.body.getReader === 'function') {
      const reader = res.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const buf = Buffer.from(value);
        received += buf.length;
        if (received > MAX_UPDATE_ZIP_BYTES) {
          try {
            await reader.cancel();
          } catch {}
          throw new Error('下载流大小超出安全限制');
        }
        chunks.push(buf);
        job.bytesDownloaded = received;
        job.totalBytes = contentLen;
        if (contentLen > 0) {
          const pct = Math.min(50, 10 + Math.round((received / contentLen) * 40));
          job.progress = pct;
          job.message = `正在下载更新包 (${Math.round((received / contentLen) * 100)}%)...`;
        } else {
          job.progress = 30;
          job.message = `正在下载更新包 (${(received / (1024 * 1024)).toFixed(1)} MiB)...`;
        }
      }
    } else {
      const ab = await res.arrayBuffer();
      const buf = Buffer.from(ab);
      received = buf.length;
      if (received > MAX_UPDATE_ZIP_BYTES) {
        throw new Error('更新包大小超出安全限制');
      }
      chunks.push(buf);
    }

    writeFileSync(zipPath, Buffer.concat(chunks));
  }

  #validateStagedPlugin(stageDir, expectedVersion) {
    const required = [
      'plugin.json',
      join('sidecars', 'studio', 'server.mjs'),
      join('sidecars', 'studio', 'sidecar.json'),
      join('sidecars', 'studio', 'public', 'index.html'),
      join('sidecars', 'studio', 'public', 'app.js'),
      join('sidecars', 'studio', 'node_modules', 'xlsx', 'dist', 'xlsx.full.min.js'),
    ];
    for (const rel of required) {
      const p = join(stageDir, rel);
      if (!existsSync(p)) {
        throw new Error(`更新包结构不完整，缺少关键文件: ${rel}`);
      }
    }
    const manifest = JSON.parse(readFileSync(join(stageDir, 'plugin.json'), 'utf8'));
    if (manifest.name !== 'antigravity-sidecar-studio') {
      throw new Error(`更新包插件名不匹配: ${manifest.name}`);
    }
    if (normalizeVersion(manifest.version) !== normalizeVersion(expectedVersion)) {
      throw new Error(
        `更新包版本与目标不一致 (${manifest.version} != ${expectedVersion})`
      );
    }
  }

  async #applyOfflineZipUpdate(job, release, effectiveMirror) {
    const workDir = join(this.#workRoot, job.id);
    const zipPath = join(workDir, release.assetName || 'update.zip');
    const stageDir = join(workDir, 'stage');
    const backupDir = join(workDir, 'backup');

    const managedDirs = [
      'assets',
      'rules',
      'skills',
      join('sidecars', 'studio', 'lib'),
      join('sidecars', 'studio', 'public'),
      join('sidecars', 'studio', 'scripts'),
    ];
    const managedFiles = [
      'LICENSE',
      'README.md',
      join('sidecars', 'studio', 'sidecar.json'),
      join('sidecars', 'studio', 'package.json'),
      join('sidecars', 'studio', 'package-lock.json'),
    ];

    try {
      job.state = 'downloading';
      job.progress = 10;
      job.message = '正在下载更新包...';
      await this.#downloadReleaseZip(release, zipPath, effectiveMirror, job);

      job.state = 'verifying';
      job.progress = 55;
      job.message = '正在校验 SHA-256 完整性...';
      const actualSha = sha256File(zipPath);
      if (release.sha256) {
        if (actualSha !== release.sha256.toLowerCase()) {
          throw new Error(
            `SHA-256 校验失败（期望 ${release.sha256.slice(0, 12)}...，实际 ${actualSha.slice(0, 12)}...）`
          );
        }
      } else if (effectiveMirror) {
        throw new Error('自定义镜像更新必须有官方 SHA-256 校验值');
      }

      job.state = 'extracting';
      job.progress = 65;
      job.message = '正在解压并校验文件布局...';
      extractZipSafely(zipPath, stageDir, {
        expectedRootPrefix: 'antigravity-sidecar-studio/',
      });
      this.#validateStagedPlugin(stageDir, release.version);

      const stageLockHash = sha256File(join(stageDir, 'sidecars', 'studio', 'package-lock.json'));
      const currentLockHash = sha256File(join(this.#studioDir, 'package-lock.json'));
      const skipNodeModules =
        Boolean(stageLockHash) &&
        stageLockHash === currentLockHash &&
        existsSync(join(this.#studioDir, 'node_modules', 'xlsx', 'dist', 'xlsx.full.min.js'));

      const dirsToSwap = skipNodeModules
        ? managedDirs
        : [...managedDirs, join('sidecars', 'studio', 'node_modules')];

      if (this.#prepareForSelfUpdate) {
        await this.#prepareForSelfUpdate();
      }

      job.state = 'backing-up';
      job.progress = 75;
      job.message = '正在备份当前版本...';
      mkdirSync(backupDir, { recursive: true });
      for (const rel of dirsToSwap) {
        const src = join(this.#pluginRoot, rel);
        if (existsSync(src)) {
          cpSync(src, join(backupDir, rel), { recursive: true });
        }
      }
      for (const rel of [
        ...managedFiles,
        join('sidecars', 'studio', 'server.mjs'),
        'plugin.json',
      ]) {
        const src = join(this.#pluginRoot, rel);
        if (existsSync(src)) {
          const dst = join(backupDir, rel);
          mkdirSync(dirname(dst), { recursive: true });
          copyFileSync(src, dst);
        }
      }

      let committed = false;
      try {
        job.state = 'applying';
        job.progress = 85;
        job.message = skipNodeModules
          ? '正在替换插件文件（依赖无变化，已跳过 node_modules）...'
          : '正在替换插件文件与依赖...';

        for (const rel of dirsToSwap) {
          await swapDirectorySafely(join(stageDir, rel), join(this.#pluginRoot, rel), job.id);
        }
        for (const rel of managedFiles) {
          const src = join(stageDir, rel);
          if (existsSync(src)) {
            await replaceFileSafely(src, join(this.#pluginRoot, rel), job.id);
          }
        }
        // Write server.mjs second-to-last and plugin.json last as commit marker
        await replaceFileSafely(
          join(stageDir, 'sidecars', 'studio', 'server.mjs'),
          join(this.#studioDir, 'server.mjs'),
          job.id
        );
        await replaceFileSafely(
          join(stageDir, 'plugin.json'),
          join(this.#pluginRoot, 'plugin.json'),
          job.id
        );

        job.state = 'verifying-install';
        job.progress = 92;
        job.message = '正在校验新版本语法与清单...';
        this.#validateStagedPlugin(this.#pluginRoot, release.version);

        const syntaxCheck = spawnSync(
          process.execPath,
          ['--check', join(this.#studioDir, 'server.mjs')],
          { encoding: 'utf8', windowsHide: true }
        );
        if (syntaxCheck.status !== 0) {
          throw new Error(`新版本 server.mjs 语法检查失败: ${syntaxCheck.stderr || ''}`);
        }
        committed = true;
      } catch (applyErr) {
        if (!committed) {
          try {
            for (const rel of dirsToSwap) {
              await swapDirectorySafely(
                join(backupDir, rel),
                join(this.#pluginRoot, rel),
                `${job.id}_rb`
              );
            }
            for (const rel of [
              ...managedFiles,
              join('sidecars', 'studio', 'server.mjs'),
              'plugin.json',
            ]) {
              const b = join(backupDir, rel);
              if (existsSync(b)) {
                await replaceFileSafely(b, join(this.#pluginRoot, rel), `${job.id}_rb`);
              }
            }
            job.rolledBack = true;
          } catch {}
        }
        throw applyErr;
      }

      this.#state.lastUpdate = {
        fromVersion: job.fromVersion,
        toVersion: release.version,
        method: 'offline-zip',
        updatedAt: new Date().toISOString(),
        acknowledged: false,
      };
      this.#state.lastError = null;
      this.#saveState();

      // Remove temporary zip/stage/backup BEFORE onRestart() exits the process
      try {
        rmSync(workDir, { recursive: true, force: true });
      } catch {}

      job.state = 'restarting';
      job.progress = 98;
      job.message = '更新已应用，正在重启 Sidecar Studio...';
      await sleep(500);
      await this.#onRestart?.();

      job.state = 'completed';
      job.progress = 100;
      job.message = `已更新至 v${release.version}`;
      job.finishedAt = Date.now();
    } finally {
      try {
        rmSync(workDir, { recursive: true, force: true });
      } catch {}
    }
  }

  #runGit(args, opts = {}) {
    const res = spawnSync('git', args, {
      cwd: opts.cwd || this.#pluginRoot,
      encoding: 'utf8',
      windowsHide: true,
      timeout: opts.timeoutMs || 45000,
    });
    if (res.error) throw res.error;
    if (res.status !== 0) {
      throw new Error((res.stderr || res.stdout || `git ${args[0]} failed`).trim());
    }
    return (res.stdout || '').trim();
  }

  #runNpmCi() {
    const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    const res = existsSync(npmCli)
      ? spawnSync(process.execPath, [npmCli, 'ci'], {
          cwd: this.#studioDir,
          encoding: 'utf8',
          windowsHide: true,
          timeout: this.#npmCmdTimeoutMs,
        })
      : process.platform === 'win32'
        ? spawnSync('cmd.exe', ['/d', '/c', 'npm', 'ci'], {
            cwd: this.#studioDir,
            encoding: 'utf8',
            windowsHide: true,
            timeout: this.#npmCmdTimeoutMs,
          })
        : spawnSync('npm', ['ci'], {
            cwd: this.#studioDir,
            encoding: 'utf8',
            windowsHide: true,
            timeout: this.#npmCmdTimeoutMs,
          });
    if (res.error) throw res.error;
    if (res.status !== 0) {
      throw new Error((res.stderr || res.stdout || 'npm ci failed').trim());
    }
  }

  async #applyGitUpdate(job, release) {
    const { gitInfo } = this.#detectInstallMode();
    if (!gitInfo?.canAutoUpdate) {
      throw makeUpdaterError(409, gitInfo?.blockReason || 'Git 仓库状态不允许自动更新');
    }

    const prevHead = this.#runGit(['rev-parse', 'HEAD']);
    const prevLockHash = sha256File(join(this.#studioDir, 'package-lock.json'));

    if (this.#prepareForSelfUpdate) {
      await this.#prepareForSelfUpdate();
    }

    try {
      job.state = 'downloading';
      job.progress = 30;
      job.message = '正在从 Git 远程仓库拉取最新提交与标签...';
      this.#runGit(['fetch', '--tags', 'origin']);

      job.state = 'applying';
      job.progress = 60;
      job.message = '正在快进合并 origin/main...';
      this.#runGit(['pull', '--ff-only', 'origin', 'main']);

      const newLockHash = sha256File(join(this.#studioDir, 'package-lock.json'));
      const nmMissing = !existsSync(join(this.#studioDir, 'node_modules', 'xlsx', 'dist', 'xlsx.full.min.js'));
      if (newLockHash !== prevLockHash || nmMissing) {
        job.progress = 78;
        job.message = '检测到依赖变更，正在运行 npm ci...';
        this.#runNpmCi();
      }

      job.state = 'verifying-install';
      job.progress = 90;
      job.message = '正在校验新版本语法...';
      const syntaxCheck = spawnSync(
        process.execPath,
        ['--check', join(this.#studioDir, 'server.mjs')],
        { encoding: 'utf8', windowsHide: true }
      );
      if (syntaxCheck.status !== 0) {
        throw new Error(`新版本 server.mjs 语法检查失败: ${syntaxCheck.stderr || ''}`);
      }
    } catch (err) {
      try {
        const dirtyNow = this.#runGit(['status', '--porcelain']);
        if (!dirtyNow) {
          this.#runGit(['reset', '--hard', prevHead]);
          job.rolledBack = true;
        }
      } catch {}
      throw err;
    }

    const updatedManifest = this.#readCurrentManifest();
    const toVersion = normalizeVersion(updatedManifest.version || release?.version || job.fromVersion);

    this.#state.lastUpdate = {
      fromVersion: job.fromVersion,
      toVersion,
      method: 'git',
      updatedAt: new Date().toISOString(),
      acknowledged: false,
    };
    this.#state.lastError = null;
    this.#saveState();

    job.targetVersion = toVersion;
    job.state = 'restarting';
    job.progress = 98;
    job.message = 'Git 更新完成，正在重启 Sidecar Studio...';
    await sleep(500);
    await this.#onRestart?.();

    job.state = 'completed';
    job.progress = 100;
    job.message = `已更新至 v${toVersion}`;
    job.finishedAt = Date.now();
  }

  async startUpdate({ targetVersion, customMirror } = {}) {
    const activeStates = new Set([
      'checking',
      'downloading',
      'verifying',
      'extracting',
      'backing-up',
      'applying',
      'verifying-install',
      'restarting',
    ]);
    if (this.#job && activeStates.has(this.#job.state)) {
      throw makeUpdaterError(409, '已有更新任务正在进行中');
    }

    const effectiveMirror =
      customMirror !== undefined ? normalizeMirrorInput(customMirror) : this.#state.customMirror;

    const { installMode, gitInfo } = this.#detectInstallMode();
    if (installMode === 'git' && !gitInfo?.canAutoUpdate) {
      throw makeUpdaterError(409, gitInfo?.blockReason || 'Git 状态不允许自动更新');
    }

    if (!this.#state.latest) {
      await this.checkForUpdates({ force: true, background: false });
    }

    const latest = this.#state.latest;
    const manifest = this.#readCurrentManifest();
    const currentVersion = normalizeVersion(manifest.version || '0.0.0');

    if (!latest?.version || compareSemver(latest.version, currentVersion) <= 0) {
      throw makeUpdaterError(400, `当前已是最新版本 v${currentVersion}`);
    }
    if (targetVersion && normalizeVersion(targetVersion) !== normalizeVersion(latest.version)) {
      throw makeUpdaterError(409, `目标版本已变更为 v${latest.version}，请先刷新检查`);
    }

    if (installMode === 'offline-zip') {
      if (!latest.downloadUrl) {
        throw makeUpdaterError(400, '最新 Release 未包含可用的离线安装包资产');
      }
      if (effectiveMirror && !latest.sha256) {
        throw makeUpdaterError(
          400,
          '使用自定义镜像时必须具备官方 SHA-256 校验值；当前版本缺少校验信息，已拒绝下载'
        );
      }
    }

    const jobId = `upd_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const job = {
      id: jobId,
      state: 'checking',
      progress: 5,
      message: '准备开始更新...',
      fromVersion: currentVersion,
      targetVersion: latest.version,
      installMode,
      rolledBack: false,
      bytesDownloaded: 0,
      totalBytes: latest.assetSize || 0,
      error: null,
      startedAt: Date.now(),
      finishedAt: null,
    };
    this.#job = job;

    this.#jobPromise = (async () => {
      try {
        if (installMode === 'git') {
          await this.#applyGitUpdate(job, latest);
        } else {
          await this.#applyOfflineZipUpdate(job, latest, effectiveMirror);
        }
      } catch (err) {
        job.state = 'failed';
        job.error = err?.message || '更新失败';
        job.message = job.rolledBack ? `更新失败（已自动回滚）：${job.error}` : `更新失败：${job.error}`;
        job.finishedAt = Date.now();
        this.#state.lastError = job.error;
        this.#saveState();
      }
    })();

    return {
      started: true,
      job: { ...job },
    };
  }

  async waitForJob() {
    if (this.#jobPromise) {
      await this.#jobPromise;
    }
    return this.#job ? { ...this.#job } : null;
  }
}
