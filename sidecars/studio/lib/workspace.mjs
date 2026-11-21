import { existsSync, lstatSync, readdirSync, realpathSync, statSync, watch } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { isUnderRoot, localPathToUri, normalizeCase } from './security.mjs';

export const DEFAULT_IGNORED_NAMES = new Set([
  '.git',
  'node_modules',
  '__pycache__',
  '.venv',
  'venv',
  'dist',
  'build',
  '.next',
  '.nuxt',
  '.cache',
  '.idea',
  '.vscode',
  '.DS_Store',
  'Thumbs.db',
  '.pytest_cache',
  '.mypy_cache',
]);

const OFFICE_TEMP_RE = /^~\$/;

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico']);
const CODE_EXTS = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.json', '.jsonl',
  '.html', '.htm', '.css', '.scss', '.less', '.xml', '.yaml', '.yml',
  '.toml', '.ini', '.conf', '.sh', '.bash', '.ps1', '.bat', '.cmd',
  '.sql', '.java', '.go', '.rs', '.c', '.cpp', '.h', '.hpp', '.cs',
  '.rb', '.php', '.vue', '.svelte', '.tex', '.bib', '.txt', '.log', '.env',
]);

export function classifyFile(filename) {
  const ext = extname(filename || '').toLowerCase();
  if (ext === '.docx') return 'docx';
  if (ext === '.xlsx' || ext === '.xls' || ext === '.csv') return 'xlsx';
  if (ext === '.pptx') return 'pptx';
  if (ext === '.pdf') return 'pdf';
  if (ext === '.md' || ext === '.mdx' || ext === '.markdown') return 'markdown';
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (CODE_EXTS.has(ext) || !ext) return 'code';
  return 'other';
}

export function isDocumentCategory(cat) {
  return cat === 'docx' || cat === 'xlsx' || cat === 'pptx' || cat === 'pdf' || cat === 'markdown';
}

export function isIgnoredName(name) {
  if (!name) return false;
  if (DEFAULT_IGNORED_NAMES.has(name)) return true;
  if (OFFICE_TEMP_RE.test(name)) return true;
  return false;
}

function sortEntries(a, b) {
  if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
  return a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' });
}

export function listDirectory(rootPath, dirPath, { showIgnored = false } = {}) {
  let rootReal = rootPath;
  try {
    rootReal = realpathSync(rootPath);
  } catch {}
  const entries = readdirSync(dirPath, { withFileTypes: true });
  const items = [];
  for (const entry of entries) {
    const ignored = isIgnoredName(entry.name);
    if (!showIgnored && ignored) continue;

    const fullPath = join(dirPath, entry.name);
    let isDir = entry.isDirectory();
    let size = 0;
    let mtimeMs = 0;
    try {
      const lst = lstatSync(fullPath);
      if (lst.isSymbolicLink()) {
        const realTarget = realpathSync(fullPath);
        if (!isUnderRoot(realTarget, rootReal)) continue;
        const st = statSync(realTarget);
        isDir = st.isDirectory();
        size = st.size;
        mtimeMs = st.mtimeMs;
      } else {
        isDir = lst.isDirectory();
        size = lst.size;
        mtimeMs = lst.mtimeMs;
      }
    } catch {
      continue;
    }

    const relPath = relative(rootPath, fullPath).replace(/\\/g, '/');
    const ext = isDir ? '' : extname(entry.name).toLowerCase();
    items.push({
      name: entry.name,
      path: fullPath,
      relPath: relPath || entry.name,
      isDir,
      ext,
      category: isDir ? 'dir' : classifyFile(entry.name),
      size,
      mtimeMs,
      uri: localPathToUri(fullPath),
      ignored,
    });
  }
  items.sort(sortEntries);
  return items;
}

function fuzzyScore(textLower, queryLower) {
  if (!queryLower) return 1;
  const idx = textLower.indexOf(queryLower);
  if (idx !== -1) {
    // Substring match: earlier index & shorter target score higher
    return 1000 - Math.min(idx * 4, 400) - Math.min(textLower.length, 200);
  }
  // Subsequence match
  let qi = 0;
  let score = 0;
  let consecutive = 0;
  for (let i = 0; i < textLower.length && qi < queryLower.length; i++) {
    if (textLower[i] === queryLower[qi]) {
      qi++;
      consecutive++;
      score += 10 + consecutive * 4;
    } else {
      consecutive = 0;
    }
  }
  return qi === queryLower.length ? score : 0;
}

export function searchWorkspace(
  rootPath,
  query,
  { showIgnored = false, limit = 100, maxVisited = 8000 } = {}
) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return { items: [], truncated: false, scanned: 0 };

  let rootReal = rootPath;
  try {
    rootReal = realpathSync(rootPath);
  } catch {}

  const matches = [];
  const queue = [rootPath];
  const visitedDirs = new Set([normalizeCase(rootReal)]);
  let scanned = 0;
  let truncated = false;

  while (queue.length > 0) {
    const dir = queue.shift();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (scanned >= maxVisited) {
        truncated = true;
        break;
      }
      const ignored = isIgnoredName(entry.name);
      if (!showIgnored && ignored) continue;

      const fullPath = join(dir, entry.name);
      let isDir = entry.isDirectory();
      let size = 0;
      let mtimeMs = 0;
      let realTarget = fullPath;
      try {
        const lst = lstatSync(fullPath);
        if (lst.isSymbolicLink()) {
          realTarget = realpathSync(fullPath);
          if (!isUnderRoot(realTarget, rootReal)) continue;
          const st = statSync(realTarget);
          isDir = st.isDirectory();
          size = st.size;
          mtimeMs = st.mtimeMs;
        } else {
          isDir = lst.isDirectory();
          size = lst.size;
          mtimeMs = lst.mtimeMs;
          realTarget = fullPath;
        }
      } catch {
        continue;
      }
      scanned++;

      const relPath = relative(rootPath, fullPath).replace(/\\/g, '/');
      const nameScore = fuzzyScore(entry.name.toLowerCase(), q);
      const pathScore = fuzzyScore(relPath.toLowerCase(), q);
      const score = Math.max(nameScore * 2, pathScore);

      if (score > 0) {
        matches.push({
          score,
          name: entry.name,
          path: fullPath,
          relPath,
          isDir,
          ext: isDir ? '' : extname(entry.name).toLowerCase(),
          category: isDir ? 'dir' : classifyFile(entry.name),
          size,
          mtimeMs,
          uri: localPathToUri(fullPath),
          ignored,
        });
      }

      if (isDir) {
        try {
          const dirReal = realTarget === fullPath ? realpathSync(fullPath) : realTarget;
          if (isUnderRoot(dirReal, rootReal)) {
            const dKey = normalizeCase(dirReal);
            if (!visitedDirs.has(dKey)) {
              visitedDirs.add(dKey);
              queue.push(fullPath);
            }
          }
        } catch {}
      }
    }
    if (truncated) break;
  }

  matches.sort((a, b) => b.score - a.score || sortEntries(a, b));
  const capped = matches.slice(0, limit).map(({ score: _s, ...item }) => item);
  return {
    items: capped,
    totalMatches: matches.length,
    truncated: truncated || matches.length > limit,
    scanned,
  };
}

export class WorkspaceWatcher {
  #watchers = new Map(); // normalizedRoot -> { rootPath, watcher, rev, lastChangedAt, timer, retryTimer, active, retries, degraded }

  syncRoots(rootPaths = []) {
    const wanted = new Map();
    for (const p of rootPaths) {
      if (typeof p === 'string' && existsSync(p)) {
        wanted.set(normalizeCase(p), p);
      }
    }

    for (const [key, entry] of this.#watchers.entries()) {
      if (!wanted.has(key)) {
        this.#stopEntry(entry);
        this.#watchers.delete(key);
      }
    }

    for (const [key, rootPath] of wanted.entries()) {
      const existing = this.#watchers.get(key);
      if (!existing) {
        this.#startEntry(key, rootPath, 0);
      } else if (!existing.active && !existing.retryTimer && existing.retries < 3) {
        existing.degraded = false;
        this.#scheduleRetry(key, existing);
      }
    }
  }

  #startEntry(key, rootPath, retries = 0) {
    const entry = {
      rootPath,
      watcher: null,
      rev: 1,
      lastChangedAt: Date.now(),
      timer: null,
      retryTimer: null,
      active: false,
      retries,
      degraded: false,
    };
    this.#watchers.set(key, entry);
    this.#attachWatcher(key, entry);
  }

  #attachWatcher(key, entry) {
    if (this.#watchers.get(key) !== entry || entry.degraded) return;
    this.#closeWatcherOnly(entry);
    try {
      const w = watch(entry.rootPath, { recursive: true }, () => {
        if (entry.timer) clearTimeout(entry.timer);
        entry.timer = setTimeout(() => {
          entry.timer = null;
          entry.rev += 1;
          entry.lastChangedAt = Date.now();
        }, 150);
      });
      w.on('error', () => {
        if (this.#watchers.get(key) !== entry) return;
        entry.active = false;
        this.#closeWatcherOnly(entry);
        this.#scheduleRetry(key, entry);
      });
      entry.watcher = w;
      entry.active = true;
    } catch {
      entry.active = false;
      this.#scheduleRetry(key, entry);
    }
  }

  #scheduleRetry(key, entry) {
    if (this.#watchers.get(key) !== entry || entry.retryTimer) return;
    if (entry.retries >= 3) {
      entry.degraded = true;
      return;
    }
    entry.retries += 1;
    const delay = 1000 * Math.pow(2, entry.retries - 1);
    entry.retryTimer = setTimeout(() => {
      entry.retryTimer = null;
      if (this.#watchers.get(key) === entry) {
        this.#attachWatcher(key, entry);
      }
    }, delay);
    entry.retryTimer.unref?.();
  }

  #closeWatcherOnly(entry) {
    try {
      entry.watcher?.close();
    } catch {
      // Ignore close error
    }
    entry.watcher = null;
  }

  #stopEntry(entry) {
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    if (entry.retryTimer) {
      clearTimeout(entry.retryTimer);
      entry.retryTimer = null;
    }
    entry.degraded = true;
    entry.active = false;
    this.#closeWatcherOnly(entry);
  }

  getState(rootPath) {
    const key = normalizeCase(rootPath);
    const entry = this.#watchers.get(key);
    if (!entry) {
      return { rev: 0, lastChangedAt: 0, active: false, degraded: false };
    }
    if (!entry.active && !entry.degraded && !entry.retryTimer && entry.retries < 3) {
      this.#scheduleRetry(key, entry);
    }
    return {
      rev: entry.rev,
      lastChangedAt: entry.lastChangedAt,
      active: entry.active,
      degraded: entry.degraded,
    };
  }

  closeAll() {
    for (const entry of this.#watchers.values()) {
      this.#stopEntry(entry);
    }
    this.#watchers.clear();
  }
}
