import {
  closeSync,
  createReadStream,
  existsSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import {
  CONV_ID_RE,
  isUnderRoot,
  localPathToUri,
  normalizeCase,
  uriToLocalPath,
} from './security.mjs';
import { classifyFile, isDocumentCategory } from './workspace.mjs';

const UUID_FILE_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(?:lock|pbtxt)$/i;
const DOC_FILE_EXT_RE = /\.(docx|xlsx|xls|csv|pptx|pdf|md|markdown|png|jpe?g|gif|webp|svg)$/i;
const WIN_PATH_RE = /([A-Za-z]:\\[^\s"'`<>|*?]+?\.[A-Za-z0-9]{1,10})/g;
const UNIX_OR_URI_PATH_RE = /file:\/\/\/[^\s"'`<>)]+/gi;
const WRITE_TOOLS = new Set([
  'write_file',
  'edit_file',
  'replace_file_content',
  'multi_replace_file_content',
  'create_file',
  'save_file',
]);

export function unquoteArg(val) {
  if (typeof val !== 'string') return val == null ? '' : String(val);
  const s = val.trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    try {
      return String(JSON.parse(s));
    } catch {
      return s.slice(1, -1);
    }
  }
  return s;
}

export function resolveConversationId(appDataDir, requestedId = '') {
  const req = String(requestedId || '').trim();
  if (req) {
    if (!CONV_ID_RE.test(req)) {
      return { conversationId: '', source: 'invalid', exists: false };
    }
    const logs = join(appDataDir, 'brain', req, '.system_generated', 'logs', 'transcript.jsonl');
    const dir = join(appDataDir, 'brain', req);
    return {
      conversationId: req,
      source: 'host',
      exists: existsSync(logs) || existsSync(dir),
    };
  }

  if (process.env.ANTIGRAVITY_DISABLE_CONV_DISCOVERY === '1') {
    return { conversationId: '', source: 'none', exists: false };
  }

  const candidates = [];
  for (const [sub, ext, priority] of [
    ['presence', '.lock', 2],
    ['annotations', '.pbtxt', 1],
  ]) {
    const dir = join(appDataDir, sub);
    if (!existsSync(dir)) continue;
    try {
      for (const entry of readdirSync(dir)) {
        if (!entry.endsWith(ext)) continue;
        const m = UUID_FILE_RE.exec(entry);
        if (!m) continue;
        try {
          const st = statSync(join(dir, entry));
          candidates.push({ id: m[1], mtimeMs: st.mtimeMs, priority });
        } catch {}
      }
    } catch {}
  }

  const brainRoot = join(appDataDir, 'brain');
  if (existsSync(brainRoot)) {
    try {
      for (const id of readdirSync(brainRoot)) {
        if (!CONV_ID_RE.test(id)) continue;
        const tPath = join(brainRoot, id, '.system_generated', 'logs', 'transcript.jsonl');
        if (!existsSync(tPath)) continue;
        try {
          const st = statSync(tPath);
          candidates.push({ id, mtimeMs: st.mtimeMs, priority: 3 });
        } catch {}
      }
    } catch {}
  }

  if (!candidates.length) {
    return { conversationId: '', source: 'none', exists: false };
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs || b.priority - a.priority);
  return { conversationId: candidates[0].id, source: 'fallback', exists: true };
}

function getTranscriptFile(appDataDir, convId, full = false) {
  if (!CONV_ID_RE.test(String(convId || ''))) return '';
  const brainRoot = join(appDataDir, 'brain');
  const convDir = join(brainRoot, convId);
  const target = join(
    convDir,
    '.system_generated',
    'logs',
    full ? 'transcript_full.jsonl' : 'transcript.jsonl'
  );
  try {
    if (existsSync(brainRoot) && existsSync(convDir)) {
      const realBrain = realpathSync(brainRoot);
      const realConv = realpathSync(convDir);
      if (!isUnderRoot(realConv, realBrain)) return '';
      if (existsSync(target)) {
        const realTarget = realpathSync(target);
        if (!isUnderRoot(realTarget, realConv)) return '';
      }
    }
  } catch {
    return '';
  }
  return target;
}

function resolveCandidateFile(rawCandidate, { workspaceRoots = [], security, appDataDir, convId }) {
  if (!rawCandidate || typeof rawCandidate !== 'string') return null;
  let cleaned = rawCandidate.trim().replace(/^["'`(<]+|[>"'`),.;:!?]+$/g, '');
  if (!cleaned || cleaned.length > 512) return null;

  const tryPaths = [];
  if (/^file:\/\//i.test(cleaned)) {
    const local = uriToLocalPath(cleaned);
    if (local) tryPaths.push(local);
  } else if (isAbsolute(cleaned)) {
    tryPaths.push(resolve(cleaned));
  } else {
    for (const root of workspaceRoots) {
      tryPaths.push(resolve(root, cleaned));
    }
  }

  for (const cand of tryPaths) {
    try {
      const real = security.assertAllowedPath(cand, {
        appDataDir,
        convId,
        mustExist: true,
        expectFile: true,
      });
      return real;
    } catch {
      // Not allowed or missing
    }
  }
  return null;
}

function buildFileMeta(absPath, workspaceRoots) {
  let st;
  try {
    st = statSync(absPath);
  } catch {
    return null;
  }
  const name = basename(absPath);
  const category = classifyFile(name);
  let relPath = name;
  for (const root of workspaceRoots) {
    const rel = relative(root, absPath);
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) {
      relPath = rel.replace(/\\/g, '/');
      break;
    }
  }
  return {
    name,
    path: absPath,
    relPath,
    ext: extname(name).toLowerCase(),
    category,
    isDoc: isDocumentCategory(category) || category === 'image',
    size: st.size,
    mtimeMs: st.mtimeMs,
    uri: localPathToUri(absPath),
  };
}

function summarizeToolCall(tc) {
  const name = tc?.name || '';
  const args = tc?.args && typeof tc.args === 'object' ? tc.args : {};
  const explicit = unquoteArg(args.toolSummary) || unquoteArg(args.toolAction);
  if (explicit) return explicit;
  const target = unquoteArg(args.Path || args.AbsolutePath || args.TargetFile || args.DirectoryPath);
  if (target) return `${name}: ${basename(target)}`;
  const cmd = unquoteArg(args.CommandLine);
  if (cmd) return `${name}: ${cmd.slice(0, 72)}${cmd.length > 72 ? '…' : ''}`;
  const query = unquoteArg(args.Query || args.query);
  if (query) return `${name}: ${query}`;
  return name;
}

function extractThinkingHeading(thinking) {
  if (typeof thinking !== 'string' || !thinking) return '';
  const matches = [...thinking.matchAll(/(?:^|\n)\s*\*\*([^*\n]{2,96})\*\*\s*(?=\n|$)/g)];
  return matches.length ? matches[matches.length - 1][1].trim() : '';
}

function extractPathsFromText(text) {
  if (typeof text !== 'string' || !text) return [];
  const found = [];
  for (const m of text.matchAll(UNIX_OR_URI_PATH_RE)) found.push(m[0]);
  for (const m of text.matchAll(WIN_PATH_RE)) found.push(m[1]);
  // Quoted doc filenames/relative paths
  const relDocRe = /["'`]([^"'`\r\n]{1,220}\.(?:docx|xlsx|xls|csv|pptx|pdf|md))["'`]/gi;
  for (const m of text.matchAll(relDocRe)) found.push(m[1]);
  return found;
}

function extractFilesFromStep(step, ctx) {
  const seen = new Map();
  const addRaw = (raw, sourceTool = '') => {
    const resolved = resolveCandidateFile(raw, ctx);
    if (!resolved) return;
    const key = normalizeCase(resolved);
    if (!seen.has(key)) {
      const meta = buildFileMeta(resolved, ctx.workspaceRoots);
      if (meta) seen.set(key, { ...meta, sourceTool });
    }
  };

  if (Array.isArray(step.tool_calls)) {
    for (const tc of step.tool_calls) {
      const args = tc?.args && typeof tc.args === 'object' ? tc.args : {};
      for (const k of ['Path', 'AbsolutePath', 'TargetFile', 'FilePath', 'OutputPath']) {
        if (args[k]) addRaw(unquoteArg(args[k]), tc.name || '');
      }
      if (args.CommandLine) {
        const cmd = unquoteArg(args.CommandLine);
        for (const p of extractPathsFromText(cmd)) {
          if (DOC_FILE_EXT_RE.test(p)) addRaw(p, tc.name || '');
        }
      }
    }
  }

  if (Array.isArray(step.media)) {
    for (const m of step.media) {
      if (m?.uri) addRaw(m.uri, 'media');
    }
  }

  for (const p of extractPathsFromText(step.content || '')) {
    if (DOC_FILE_EXT_RE.test(p) || /\\/.test(p)) addRaw(p, 'content');
  }

  return Array.from(seen.values());
}

function classifyStepKind(step) {
  const t = String(step.type || '');
  const st = String(step.status || '');
  if (t === 'ERROR_MESSAGE' || st === 'ERROR') return 'error';
  if (t === 'USER_INPUT') return 'user';
  if (t === 'PLANNER_RESPONSE') return 'assistant';
  if (t === 'GENERIC' || t === 'TOOL_RESULT') return 'tool_result';
  return 'system';
}

function formatNormalizedStep(step, lineIndex, ctx) {
  const toolCalls = Array.isArray(step.tool_calls)
    ? step.tool_calls.map((tc) => {
        const cleanedArgs = {};
        if (tc?.args && typeof tc.args === 'object') {
          for (const [k, v] of Object.entries(tc.args)) {
            cleanedArgs[k] = typeof v === 'string' ? unquoteArg(v) : v;
          }
        }
        return {
          id: tc?.id || '',
          name: tc?.name || '',
          summary: summarizeToolCall(tc),
          args: cleanedArgs,
        };
      })
    : [];

  const truncatedFields = Array.isArray(step.truncated_fields) ? step.truncated_fields : [];
  return {
    lineIndex,
    step_index: Number.isFinite(step.step_index) ? step.step_index : lineIndex,
    source: String(step.source || ''),
    type: String(step.type || ''),
    status: String(step.status || ''),
    created_at: String(step.created_at || ''),
    kind: classifyStepKind(step),
    content: typeof step.content === 'string' ? step.content : '',
    thinking: typeof step.thinking === 'string' ? step.thinking : '',
    thinkingHeading: extractThinkingHeading(step.thinking),
    tool_calls: toolCalls,
    error: typeof step.error === 'string' ? step.error : '',
    media: Array.isArray(step.media) ? step.media : [],
    truncated_fields: truncatedFields,
    hasFull: truncatedFields.length > 0,
    files: extractFilesFromStep(step, ctx),
  };
}

const transcriptStepCache = new Map(); // convId -> { size, mtimeMs, byteOffset, headHex, tailHex, parsedObjects }

function readFileSlice(filePath, start, end) {
  const len = Math.max(0, end - start);
  if (!len) return Buffer.alloc(0);
  const fd = openSync(filePath, 'r');
  try {
    const buf = Buffer.allocUnsafe(len);
    let totalRead = 0;
    while (totalRead < len) {
      const n = readSync(fd, buf, totalRead, len - totalRead, start + totalRead);
      if (n <= 0) break;
      totalRead += n;
    }
    return totalRead === len ? buf : buf.subarray(0, totalRead);
  } finally {
    closeSync(fd);
  }
}

function parseJsonlLines(buf, baseOffset = 0) {
  const objs = [];
  let pos = 0;
  let consumedBytes = 0;
  while (pos < buf.length) {
    const nlIdx = buf.indexOf(0x0a, pos);
    const hasNl = nlIdx !== -1;
    const endPos = hasNl ? nlIdx : buf.length;
    const lineStr = buf.subarray(pos, endPos).toString('utf8').trim();
    if (lineStr) {
      try {
        const obj = JSON.parse(lineStr);
        if (obj && typeof obj === 'object') {
          objs.push(obj);
          consumedBytes = hasNl ? endPos + 1 : endPos;
        }
      } catch {
        // Incomplete/torn line at tail: stop advancing consumedBytes if at EOF
        if (hasNl) consumedBytes = endPos + 1;
      }
    } else if (hasNl) {
      consumedBytes = endPos + 1;
    }
    if (!hasNl) break;
    pos = endPos + 1;
  }
  return { objs, nextOffset: baseOffset + consumedBytes };
}

function getCachedTranscriptObjects(appDataDir, conversationId, file, st, { bypassCache = false } = {}) {
  const key = `${appDataDir}::${conversationId}`;
  if (bypassCache) {
    transcriptStepCache.delete(key);
  }
  const cached = bypassCache ? null : transcriptStepCache.get(key);
  const headLen = Math.min(64, st.size);
  const headHex = headLen > 0 ? readFileSlice(file, 0, headLen).toString('hex') : '';

  if (cached && headHex === cached.headHex && st.size >= cached.byteOffset) {
    const tailLen = Math.min(64, cached.byteOffset);
    const tailStart = cached.byteOffset - tailLen;
    const curTailHex = tailLen > 0 ? readFileSlice(file, tailStart, cached.byteOffset).toString('hex') : '';

    if (curTailHex === cached.tailHex) {
      if (st.size === cached.size && Math.abs(st.mtimeMs - cached.mtimeMs) < 0.001) {
        return cached.parsedObjects;
      }
      if (st.size > cached.size) {
        const appendBuf = readFileSlice(file, cached.byteOffset, st.size);
        const { objs: newObjs, nextOffset } = parseJsonlLines(appendBuf, cached.byteOffset);
        const parsedObjects = cached.parsedObjects.concat(newObjs);
        const nextTailLen = Math.min(64, nextOffset);
        const nextTailHex =
          nextTailLen > 0
            ? readFileSlice(file, nextOffset - nextTailLen, nextOffset).toString('hex')
            : '';
        transcriptStepCache.set(key, {
          size: st.size,
          mtimeMs: st.mtimeMs,
          byteOffset: nextOffset,
          headHex,
          tailHex: nextTailHex,
          parsedObjects,
        });
        return parsedObjects;
      }
    }
  }

  const fullBuf = readFileSlice(file, 0, st.size);
  const { objs: parsedObjects, nextOffset } = parseJsonlLines(fullBuf, 0);
  const nextTailLen = Math.min(64, nextOffset);
  const tailHex =
    nextTailLen > 0 ? fullBuf.subarray(nextOffset - nextTailLen, nextOffset).toString('hex') : '';
  if (transcriptStepCache.size > 20) transcriptStepCache.clear();
  transcriptStepCache.set(key, {
    size: st.size,
    mtimeMs: st.mtimeMs,
    byteOffset: nextOffset,
    headHex,
    tailHex,
    parsedObjects,
  });
  return parsedObjects;
}

export function readTranscriptSteps(
  appDataDir,
  requestedId,
  { afterLine = 0, prevSig = '', force = false, security, workspaceRoots = [] } = {}
) {
  const { conversationId, source } = resolveConversationId(appDataDir, requestedId);
  if (!conversationId) {
    return {
      conversationId: '',
      source,
      exists: false,
      sig: '',
      totalLines: 0,
      reset: true,
      steps: [],
    };
  }

  const file = getTranscriptFile(appDataDir, conversationId, false);
  if (!file || !existsSync(file)) {
    return {
      conversationId,
      source,
      exists: false,
      sig: '',
      totalLines: 0,
      reset: true,
      steps: [],
    };
  }

  let st;
  try {
    st = statSync(file);
  } catch {
    return {
      conversationId,
      source,
      exists: false,
      sig: '',
      totalLines: 0,
      reset: true,
      steps: [],
    };
  }

  const sig = `${conversationId}:${Math.round(st.mtimeMs * 1000)}:${st.size}`;
  const prevConvFromSig =
    typeof prevSig === 'string' && prevSig.includes(':')
      ? prevSig.slice(0, prevSig.indexOf(':'))
      : '';
  const convChanged = Boolean(prevConvFromSig && prevConvFromSig !== conversationId);

  if (!force && prevSig && prevSig === sig) {
    return {
      conversationId,
      source,
      exists: true,
      unchanged: true,
      sig,
    };
  }

  let parsedObjects = null;
  try {
    const bypassCache = force === true || (afterLine === 0 && !prevSig);
    parsedObjects = getCachedTranscriptObjects(appDataDir, conversationId, file, st, { bypassCache });
  } catch {
    return {
      conversationId,
      source,
      exists: false,
      sig: '',
      totalLines: 0,
      reset: true,
      steps: [],
    };
  }

  const ctx = { workspaceRoots, security, appDataDir, convId: conversationId };
  const startFrom = !convChanged && Number.isFinite(afterLine) && afterLine > 0 ? afterLine : 0;
  const reset = startFrom === 0 || parsedObjects.length < startFrom || convChanged;
  const slice = reset ? parsedObjects : parsedObjects.slice(startFrom);
  const steps = slice.map((obj, idx) =>
    formatNormalizedStep(obj, reset ? idx : startFrom + idx, ctx)
  );

  return {
    conversationId,
    source,
    exists: true,
    unchanged: false,
    sig,
    totalLines: parsedObjects.length,
    reset,
    steps,
  };
}

export async function readFullTranscriptStep(appDataDir, requestedId, stepIndex) {
  const { conversationId } = resolveConversationId(appDataDir, requestedId);
  if (!conversationId) return null;
  const targetIdx = Number(stepIndex);
  if (!Number.isFinite(targetIdx) || targetIdx < 0) return null;

  for (const useFull of [true, false]) {
    const path = getTranscriptFile(appDataDir, conversationId, useFull);
    if (!path || !existsSync(path)) continue;

    const stream = createReadStream(path, { encoding: 'utf8' });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    let lineCount = 0;
    try {
      for await (const rawLine of rl) {
        const line = rawLine.trim();
        if (!line) continue;
        let obj;
        try {
          obj = JSON.parse(line);
        } catch {
          lineCount++;
          continue;
        }
        const idx = Number.isFinite(obj?.step_index) ? obj.step_index : lineCount;
        if (idx === targetIdx) {
          rl.close();
          stream.destroy();
          return {
            conversationId,
            fromFullFile: useFull,
            step_index: idx,
            content: typeof obj.content === 'string' ? obj.content : '',
            thinking: typeof obj.thinking === 'string' ? obj.thinking : '',
            tool_calls: Array.isArray(obj.tool_calls) ? obj.tool_calls : [],
            error: typeof obj.error === 'string' ? obj.error : '',
          };
        }
        lineCount++;
      }
    } finally {
      try {
        rl.close();
        stream.destroy();
      } catch {}
    }
  }

  return null;
}

const producedCache = new Map(); // key -> { sig, docs }

export function extractProducedDocs(
  appDataDir,
  requestedId,
  { security, workspaceRoots = [] } = {}
) {
  const { conversationId, source } = resolveConversationId(appDataDir, requestedId);
  if (!conversationId) {
    return { conversationId: '', source, docs: [] };
  }

  const file = getTranscriptFile(appDataDir, conversationId, false);
  const brainDir = security.getBrainConvDir(appDataDir, conversationId);
  let brainSig = '0';
  if (brainDir) {
    try {
      brainSig = String(Math.round(statSync(brainDir).mtimeMs * 1000));
    } catch {}
  }
  const rootsSig = workspaceRoots.map((r) => normalizeCase(r)).join('|');
  const cacheKey = `${appDataDir}::${conversationId}`;
  let sig = `none|${brainSig}|${rootsSig}`;
  let parsedObjects = [];
  if (file && existsSync(file)) {
    try {
      const st = statSync(file);
      sig = `${Math.round(st.mtimeMs * 1000)}:${st.size}|${brainSig}|${rootsSig}`;
      const hit = producedCache.get(cacheKey);
      if (hit && hit.sig === sig) {
        const refreshed = [];
        for (const doc of hit.docs) {
          try {
            const dst = statSync(doc.path);
            if (dst.isFile()) {
              refreshed.push({ ...doc, size: dst.size, mtimeMs: dst.mtimeMs });
            }
          } catch {}
        }
        return { conversationId, source, docs: refreshed };
      }
      parsedObjects = getCachedTranscriptObjects(appDataDir, conversationId, file, st, {
        bypassCache: false,
      });
    } catch {}
  }

  const found = new Map(); // normalizedPath -> docInfo
  const ctx = { workspaceRoots, security, appDataDir, convId: conversationId };

  const upsertDoc = (absPath, { tool = '', createdAt = '', stepIndex = 0, priority = 1 }) => {
    const key = normalizeCase(absPath);
    const meta = buildFileMeta(absPath, workspaceRoots);
    if (!meta) return;
    const prev = found.get(key);
    if (!prev || priority >= prev.priority || meta.mtimeMs > prev.mtimeMs) {
      found.set(key, {
        ...meta,
        sourceTool: tool || prev?.sourceTool || '',
        createdAt: createdAt || prev?.createdAt || '',
        stepIndex: Math.max(stepIndex, prev?.stepIndex || 0),
        priority: Math.max(priority, prev?.priority || 0),
      });
    }
  };

  for (let i = 0; i < parsedObjects.length; i++) {
    const step = parsedObjects[i];
    if (!step || typeof step !== 'object') continue;
    const stepIndex = Number.isFinite(step.step_index) ? step.step_index : i;
    const createdAt = String(step.created_at || '');

    if (Array.isArray(step.tool_calls)) {
      for (const tc of step.tool_calls) {
        const toolName = String(tc?.name || '');
        const args = tc?.args && typeof tc.args === 'object' ? tc.args : {};
        const isWrite = WRITE_TOOLS.has(toolName);
        for (const k of ['Path', 'AbsolutePath', 'TargetFile', 'FilePath', 'OutputPath']) {
          if (!args[k]) continue;
          const resolved = resolveCandidateFile(unquoteArg(args[k]), ctx);
          if (!resolved) continue;
          if (isWrite || DOC_FILE_EXT_RE.test(resolved)) {
            upsertDoc(resolved, {
              tool: toolName,
              createdAt,
              stepIndex,
              priority: isWrite ? 3 : 1,
            });
          }
        }
        if (toolName === 'run_command' && args.CommandLine) {
          const cmd = unquoteArg(args.CommandLine);
          for (const p of extractPathsFromText(cmd)) {
            if (!DOC_FILE_EXT_RE.test(p)) continue;
            const resolved = resolveCandidateFile(p, ctx);
            if (resolved) {
              upsertDoc(resolved, {
                tool: 'run_command',
                createdAt,
                stepIndex,
                priority: 2,
              });
            }
          }
        }
      }
    }

    if (step.type === 'PLANNER_RESPONSE' && typeof step.content === 'string') {
      for (const p of extractPathsFromText(step.content)) {
        if (!DOC_FILE_EXT_RE.test(p)) continue;
        const resolved = resolveCandidateFile(p, ctx);
        if (resolved) {
          upsertDoc(resolved, {
            tool: 'reply',
            createdAt,
            stepIndex,
            priority: 2,
          });
        }
      }
    }
  }

  // Also include user-facing files in brain/<convId>/ (skip .system_generated)
  if (brainDir) {
    try {
      for (const entry of readdirSync(brainDir, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        const full = join(brainDir, entry.name);
        if (entry.isFile() && DOC_FILE_EXT_RE.test(entry.name)) {
          if (security.isAllowedPath(full, { appDataDir, convId: conversationId })) {
            upsertDoc(full, { tool: 'artifact', stepIndex: 0, priority: 2 });
          }
        }
      }
    } catch {}
  }

  const docs = Array.from(found.values()).sort((a, b) => {
    if (a.isDoc !== b.isDoc) return a.isDoc ? -1 : 1;
    if (b.mtimeMs !== a.mtimeMs) return b.mtimeMs - a.mtimeMs;
    return b.stepIndex - a.stepIndex;
  });

  if (producedCache.size > 20) producedCache.clear();
  producedCache.set(cacheKey, { sig, docs });
  return { conversationId, source, docs };
}
