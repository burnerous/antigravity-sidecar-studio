import { existsSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const CONV_ID_RE = /^[0-9a-f-]{8,64}$/i;
export const CACHE_KEY_RE = /^[a-f0-9]{16,64}$/i;
const IS_WIN = process.platform === 'win32';

export function resolveAppDataDir() {
  const execDataDir = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  if (execDataDir) {
    for (let d = execDataDir; d !== dirname(d); d = dirname(d)) {
      if (basename(d) === 'sidecar_data') {
        return dirname(d);
      }
    }
  }
  const geminiDir = process.env.ANTIGRAVITY_GEMINI_DIR || join(homedir(), '.gemini');
  return resolve(geminiDir, process.env.ANTIGRAVITY_APP_DATA_DIR || 'antigravity');
}

export function normalizeCase(p) {
  return IS_WIN ? p.toLowerCase() : p;
}

export function uriToLocalPath(input) {
  if (typeof input !== 'string') return '';
  let s = input.trim();
  if (!s) return '';
  if (s.includes('\0') || s.length > 4096) return '';
  if (/^file:\/\//i.test(s)) {
    try {
      s = fileURLToPath(s);
    } catch {
      return '';
    }
  }
  try {
    return resolve(s);
  } catch {
    return '';
  }
}

export function localPathToUri(p) {
  try {
    return pathToFileURL(p).href;
  } catch {
    return '';
  }
}

export function isUnderRoot(targetReal, rootReal) {
  const t = normalizeCase(targetReal);
  const r = normalizeCase(rootReal);
  if (t === r) return true;
  const prefix = r.endsWith(sep) ? r : r + sep;
  return t.startsWith(prefix);
}

export function makeHttpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function parseEnvWorkspaceList() {
  const out = [];
  for (const key of [
    'ANTIGRAVITY_WORKSPACE_ROOTS',
    'ANTIGRAVITY_WORKSPACE_DIR',
    'ANTIGRAVITY_PROJECT_ROOT',
  ]) {
    const raw = process.env[key];
    if (!raw || typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (key === 'ANTIGRAVITY_WORKSPACE_ROOTS' && trimmed.startsWith('[')) {
      try {
        const arr = JSON.parse(trimmed);
        if (Array.isArray(arr)) {
          out.push(...arr);
          continue;
        }
      } catch {}
    }
    const parts = trimmed.split(/[;\r\n,]+/);
    for (const p of parts) {
      const s = p.trim();
      if (s) out.push(s);
    }
  }
  return out;
}

export class SecurityManager {
  #roots = new Map(); // normalizedRealPath -> { path, uri, name }
  #hostLockedRoots = new Map(); // normalizedRealPath -> { path, uri, name }
  #generation = 0;

  constructor({ hostWorkspaceUris } = {}) {
    const envUris = Array.isArray(hostWorkspaceUris) ? hostWorkspaceUris : parseEnvWorkspaceList();
    for (const raw of envUris) {
      const local = uriToLocalPath(raw);
      if (!local || !isAbsolute(local)) continue;
      try {
        if (!existsSync(local)) continue;
        const real = realpathSync(local);
        if (!statSync(real).isDirectory()) continue;
        const key = normalizeCase(real);
        if (!this.#hostLockedRoots.has(key)) {
          const entry = {
            path: real,
            uri: localPathToUri(real),
            name: basename(real) || real,
          };
          this.#hostLockedRoots.set(key, entry);
          this.#roots.set(key, entry);
        }
      } catch {}
    }
    if (this.#roots.size > 0) {
      this.#generation = 1;
    }
  }

  getGeneration() {
    return this.#generation;
  }

  hasHostLockedRoots() {
    return this.#hostLockedRoots.size > 0;
  }

  registerWorkspaceUris(uris = [], { generation } = {}) {
    if (generation != null) {
      const genNum = Number(generation);
      if (!Number.isInteger(genNum) || genNum < this.#generation) {
        return {
          applied: false,
          generation: this.#generation,
          roots: this.getRoots(),
        };
      }
    }

    const next = new Map();
    const list = Array.isArray(uris) ? uris : [];
    const lockedList = Array.from(this.#hostLockedRoots.values());

    for (const raw of list) {
      const local = uriToLocalPath(raw);
      if (!local || !isAbsolute(local)) continue;
      try {
        if (!existsSync(local)) continue;
        const real = realpathSync(local);
        const st = statSync(real);
        if (!st.isDirectory()) continue;
        if (lockedList.length > 0 && !lockedList.some((hr) => isUnderRoot(real, hr.path))) {
          continue;
        }
        const key = normalizeCase(real);
        if (!next.has(key)) {
          next.set(key, {
            path: real,
            uri: localPathToUri(real),
            name: basename(real) || real,
          });
        }
      } catch {
        // Ignore unreadable/missing workspace folder
      }
    }
    this.#roots = next;
    this.#generation += 1;
    return {
      applied: true,
      generation: this.#generation,
      roots: this.getRoots(),
    };
  }

  getRoots() {
    return Array.from(this.#roots.values());
  }

  getAllowedRoots() {
    return this.getRoots();
  }

  getRootPaths() {
    return this.getRoots().map((r) => r.path);
  }

  getBrainConvDir(appDataDir, convId) {
    if (!appDataDir || !convId || !CONV_ID_RE.test(String(convId).trim())) {
      return null;
    }
    const brainRootPath = join(appDataDir, 'brain');
    const candidate = join(brainRootPath, String(convId).trim());
    try {
      if (!existsSync(brainRootPath) || !existsSync(candidate)) return null;
      const brainRootReal = realpathSync(brainRootPath);
      const real = realpathSync(candidate);
      if (!isUnderRoot(real, brainRootReal)) return null;
      return statSync(real).isDirectory() ? real : null;
    } catch {
      return null;
    }
  }

  #allowedRoots(appDataDir, convId, { allowBrain = true } = {}) {
    const roots = this.getRootPaths();
    if (allowBrain) {
      const brain = this.getBrainConvDir(appDataDir, convId);
      if (brain) roots.push(brain);
    }
    return roots;
  }

  assertAllowedRoot(rawRoot) {
    const local = uriToLocalPath(rawRoot);
    if (!local || !isAbsolute(local)) {
      throw makeHttpError(403, 'Invalid or unregistered workspace root');
    }
    let real;
    try {
      real = realpathSync(local);
    } catch {
      throw makeHttpError(403, 'Workspace root does not exist');
    }
    const entry = this.#roots.get(normalizeCase(real));
    if (!entry) {
      throw makeHttpError(403, 'Workspace root is not registered');
    }
    return entry.path;
  }

  assertAllowedPath(
    rawPath,
    {
      appDataDir = '',
      convId = '',
      mustExist = true,
      expectDir = false,
      expectFile = false,
      allowBrain = true,
    } = {}
  ) {
    if (typeof rawPath !== 'string' || !rawPath.trim()) {
      throw makeHttpError(400, 'Missing path parameter');
    }
    if (rawPath.includes('\0') || rawPath.length > 4096) {
      throw makeHttpError(403, 'Invalid path characters or length');
    }
    const local = uriToLocalPath(rawPath);
    if (!local || !isAbsolute(local)) {
      throw makeHttpError(403, 'Path must be an absolute local path or file URI');
    }

    const roots = this.#allowedRoots(appDataDir, convId, { allowBrain });
    if (roots.length === 0) {
      throw makeHttpError(403, 'No workspace roots or active brain directory registered');
    }

    let real;
    if (existsSync(local)) {
      try {
        real = realpathSync(local);
      } catch {
        throw makeHttpError(403, 'Failed to resolve path');
      }
    } else {
      if (mustExist) {
        // Distinguish 403 outside sandbox vs 404 inside sandbox
        const inSandbox = roots.some((r) => isUnderRoot(local, r));
        if (!inSandbox) {
          throw makeHttpError(403, 'Access denied: path outside allowed workspace');
        }
        throw makeHttpError(404, 'File or directory not found');
      }
      real = local;
    }

    const allowed = roots.some((r) => isUnderRoot(real, r));
    if (!allowed) {
      throw makeHttpError(403, 'Access denied: path outside allowed workspace or conversation brain');
    }

    if (mustExist) {
      let st;
      try {
        st = statSync(real);
      } catch {
        throw makeHttpError(404, 'Unable to stat path');
      }
      if (expectDir && !st.isDirectory()) {
        throw makeHttpError(400, 'Expected a directory');
      }
      if (expectFile && !st.isFile()) {
        throw makeHttpError(400, 'Expected a regular file');
      }
    }

    return real;
  }

  isAllowedPath(rawPath, opts) {
    try {
      this.assertAllowedPath(rawPath, opts);
      return true;
    } catch {
      return false;
    }
  }

  isValidCacheKey(key) {
    return typeof key === 'string' && CACHE_KEY_RE.test(key);
  }
}
