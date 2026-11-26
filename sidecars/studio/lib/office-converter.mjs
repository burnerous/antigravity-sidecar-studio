import { execFile, execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CACHE_KEY_RE, normalizeCase } from './security.mjs';

const MAX_CONVERT_BYTES = 64 * 1024 * 1024; // 64 MiB safety limit
const MAX_QUEUE_LENGTH = 8;

function findExeViaRegistry(exeName) {
  if (process.platform !== 'win32') return '';
  try {
    const ps = `(Get-ItemProperty -Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exeName}' -ErrorAction SilentlyContinue).'(default)'`;
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      encoding: 'utf8',
      timeout: 3000,
      windowsHide: true,
    }).trim();
    return out && existsSync(out) ? out : '';
  } catch {
    return '';
  }
}

function findFirstExisting(candidates) {
  for (const p of candidates) {
    if (p && existsSync(p)) return p;
  }
  return '';
}

function findOnPath(cmd) {
  try {
    const checker = process.platform === 'win32' ? 'where.exe' : 'which';
    const out = execFileSync(checker, [cmd], {
      encoding: 'utf8',
      timeout: 2500,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find(Boolean);
    return out && existsSync(out) ? out : '';
  } catch {
    return '';
  }
}

export function detectConverters() {
  const powerpoint =
    findFirstExisting([
      'C:\\Program Files\\Microsoft Office\\Root\\Office16\\POWERPNT.EXE',
      'C:\\Program Files (x86)\\Microsoft Office\\Root\\Office16\\POWERPNT.EXE',
      'C:\\Program Files\\Microsoft Office\\Office16\\POWERPNT.EXE',
      'C:\\Program Files\\Microsoft Office\\Office15\\POWERPNT.EXE',
    ]) || findExeViaRegistry('POWERPNT.EXE');

  const word =
    findFirstExisting([
      'C:\\Program Files\\Microsoft Office\\Root\\Office16\\WINWORD.EXE',
      'C:\\Program Files (x86)\\Microsoft Office\\Root\\Office16\\WINWORD.EXE',
      'C:\\Program Files\\Microsoft Office\\Office16\\WINWORD.EXE',
      'C:\\Program Files\\Microsoft Office\\Office15\\WINWORD.EXE',
    ]) || findExeViaRegistry('WINWORD.EXE');

  const libreoffice =
    findFirstExisting([
      'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
      'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
      '/Applications/LibreOffice.app/Contents/MacOS/soffice',
    ]) ||
    findOnPath('soffice') ||
    findOnPath('libreoffice');

  return {
    powerpoint: powerpoint || null,
    word: word || null,
    libreoffice: libreoffice || null,
  };
}

export class OfficeConverter {
  #scriptPath;
  #cacheDir;
  #timeoutMs;
  #inFlight = new Map();
  #engines;
  #metaByKey = new Map();
  #activeCount = 0;
  #maxConcurrent = 1;
  #queue = [];

  constructor({ scriptPath, cacheDir, timeoutMs = 25000 } = {}) {
    this.#scriptPath = scriptPath;
    this.#cacheDir = cacheDir;
    this.#timeoutMs = timeoutMs;
    this.#engines = detectConverters();
  }

  getCapabilities() {
    return { ...this.#engines, cacheDir: this.#cacheDir };
  }

  refreshCapabilities() {
    this.#engines = detectConverters();
    return this.getCapabilities();
  }

  #ensureCacheDir() {
    if (this.#cacheDir && !existsSync(this.#cacheDir)) {
      mkdirSync(this.#cacheDir, { recursive: true });
    }
  }

  #cacheKeyFor(absPath, st, preferredEngine = 'auto') {
    return createHash('sha256')
      .update(`${normalizeCase(absPath)}|${Math.floor(st.mtimeMs)}|${st.size}|${preferredEngine}`)
      .digest('hex')
      .slice(0, 32);
  }

  #metaPathFor(key) {
    return join(this.#cacheDir, `${key}.meta.json`);
  }

  #saveMeta(key, meta) {
    this.#metaByKey.set(key, meta);
    try {
      const mp = this.#metaPathFor(key);
      const tmp = `${mp}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(tmp, JSON.stringify(meta), 'utf8');
      renameSync(tmp, mp);
    } catch {}
  }

  getCachedPdfMeta(key) {
    if (!CACHE_KEY_RE.test(String(key || ''))) return null;
    if (this.#metaByKey.has(key)) return this.#metaByKey.get(key);
    const mp = this.#metaPathFor(key);
    if (!existsSync(mp)) return null;
    try {
      const meta = JSON.parse(readFileSync(mp, 'utf8'));
      if (meta && typeof meta.absPath === 'string') {
        this.#metaByKey.set(key, meta);
        return meta;
      }
    } catch {}
    return null;
  }

  #enqueue(taskFn, shouldCancel = null) {
    if (this.#activeCount >= this.#maxConcurrent && this.#queue.length >= MAX_QUEUE_LENGTH) {
      return Promise.resolve({
        mode: 'fallback',
        reason: `Office conversion queue is full (max ${MAX_QUEUE_LENGTH} pending tasks)`,
      });
    }
    return new Promise((resolve, reject) => {
      const run = () => {
        if (shouldCancel?.()) {
          const next = this.#queue.shift();
          if (next) next();
          resolve({ mode: 'fallback', reason: 'Conversion cancelled by caller' });
          return;
        }
        this.#activeCount++;
        Promise.resolve()
          .then(taskFn)
          .then(resolve, reject)
          .finally(() => {
            this.#activeCount--;
            const next = this.#queue.shift();
            if (next) next();
          });
      };
      if (this.#activeCount < this.#maxConcurrent) {
        run();
      } else {
        this.#queue.push(run);
      }
    });
  }

  async convertToPdf(absPath, { preferredEngine = 'auto', shouldCancel = null } = {}) {
    const ext = extname(absPath).toLowerCase();
    if (ext !== '.pptx' && ext !== '.docx') {
      return { mode: 'fallback', reason: `Unsupported conversion format: ${ext}` };
    }

    let st;
    try {
      st = statSync(absPath);
    } catch {
      return { mode: 'fallback', reason: 'Source file unavailable' };
    }

    if (st.size > MAX_CONVERT_BYTES) {
      return {
        mode: 'fallback',
        reason: `File too large for PDF conversion (${st.size} bytes > 64 MiB limit)`,
      };
    }

    this.#ensureCacheDir();
    const key = this.#cacheKeyFor(absPath, st, preferredEngine);
    const cachedPdf = join(this.#cacheDir, `${key}.pdf`);

    if (existsSync(cachedPdf)) {
      try {
        const cst = statSync(cachedPdf);
        if (cst.isFile() && cst.size > 0) {
          this.#saveMeta(key, {
            absPath,
            mtimeMs: st.mtimeMs,
            size: st.size,
            engine: this.getCachedPdfMeta(key)?.engine || 'cache',
          });
          return {
            mode: 'pdf',
            cached: true,
            key,
            pdfUrl: `/api/doc/cache-pdf?key=${key}`,
            engine: 'cache',
            size: cst.size,
          };
        }
      } catch {
        // Re-convert if cache stat fails
      }
    }

    if (this.#inFlight.has(key)) {
      return this.#inFlight.get(key);
    }

    const promise = this.#enqueue(
      () => this.#runConversion(absPath, st, ext, key, cachedPdf, preferredEngine),
      shouldCancel
    ).finally(() => {
      this.#inFlight.delete(key);
    });
    this.#inFlight.set(key, promise);
    return promise;
  }

  async #runConversion(absPath, st, ext, key, finalPdfPath, preferredEngine) {
    const errors = [];
    const wantCom = preferredEngine === 'auto' || preferredEngine === 'com';
    const wantLo = preferredEngine === 'auto' || preferredEngine === 'libreoffice';

    if (wantCom && process.platform === 'win32' && this.#scriptPath && existsSync(this.#scriptPath)) {
      const mode = ext === '.pptx' ? 'ppt' : 'word';
      const hasOfficeApp = mode === 'ppt' ? Boolean(this.#engines.powerpoint) : Boolean(this.#engines.word);
      if (hasOfficeApp) {
        const jobDir = join(this.#cacheDir, `com_${key}_${process.pid}_${Date.now()}`);
        const tmpPdf = join(jobDir, 'out.pdf');
        try {
          mkdirSync(jobDir, { recursive: true });
          await this.#runPowerShellCom(mode, absPath, tmpPdf);
          renameSync(tmpPdf, finalPdfPath);
          const engineLabel = mode === 'ppt' ? 'PowerPoint COM' : 'Word COM';
          this.#saveMeta(key, { absPath, mtimeMs: st.mtimeMs, size: st.size, engine: engineLabel });
          this.#pruneCache();
          const cst = statSync(finalPdfPath);
          return {
            mode: 'pdf',
            cached: false,
            key,
            pdfUrl: `/api/doc/cache-pdf?key=${key}`,
            engine: engineLabel,
            size: cst.size,
          };
        } catch (err) {
          errors.push(`COM(${mode}): ${err.message}`);
        } finally {
          try {
            rmSync(jobDir, { recursive: true, force: true });
          } catch {}
        }
      }
    }

    if (wantLo && this.#engines.libreoffice) {
      const tmpDir = join(this.#cacheDir, `lo_${key}_${Date.now()}`);
      try {
        mkdirSync(tmpDir, { recursive: true });
        await this.#runLibreOffice(absPath, tmpDir);
        const pdfName = readdirSync(tmpDir).find((f) => f.toLowerCase().endsWith('.pdf'));
        if (!pdfName) throw new Error('LibreOffice did not produce a PDF');
        renameSync(join(tmpDir, pdfName), finalPdfPath);
        this.#saveMeta(key, { absPath, mtimeMs: st.mtimeMs, size: st.size, engine: 'LibreOffice' });
        this.#pruneCache();
        const cst = statSync(finalPdfPath);
        return {
          mode: 'pdf',
          cached: false,
          key,
          pdfUrl: `/api/doc/cache-pdf?key=${key}`,
          engine: 'LibreOffice',
          size: cst.size,
        };
      } catch (err) {
        errors.push(`LibreOffice: ${err.message}`);
      } finally {
        try {
          rmSync(tmpDir, { recursive: true, force: true });
        } catch {}
      }
    }

    return {
      mode: 'fallback',
      reason: errors.length ? errors.join(' | ') : 'No local Office COM or LibreOffice converter available',
    };
  }

  #cleanupSpawnedComPids(procs) {
    if (process.platform !== 'win32' || !Array.isArray(procs) || !procs.length) return;
    const valid = procs.filter(
      (p) => p && Number.isInteger(p.pid) && p.pid > 0 && /^\d+$/.test(String(p.ticks || ''))
    );
    if (!valid.length) return;
    const pairsLiteral = valid.map((p) => `'${p.pid}:${p.ticks}'`).join(',');
    const psScript = `foreach ($pair in @(${pairsLiteral})) {
  $parts = $pair -split ':'
  $id = [int]$parts[0]; $ticks = $parts[1]
  try {
    $p = Get-Process -Id $id -ErrorAction SilentlyContinue
    if ($p -and $p.MainWindowHandle -eq 0 -and ([string]$p.StartTime.ToUniversalTime().ToFileTimeUtc() -eq $ticks)) {
      $cim = Get-CimInstance Win32_Process -Filter "ProcessId = $id" -ErrorAction SilentlyContinue
      if ($cim -and ($cim.CommandLine -match '(-Embedding|/Automation)')) {
        Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
      }
    }
  } catch {}
}`;
    try {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', psScript],
        { timeout: 3000, windowsHide: true },
        () => {}
      );
    } catch {}
  }

  #runPowerShellCom(mode, inputPath, outputPath) {
    return new Promise((resolve, reject) => {
      const child = spawn(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          this.#scriptPath,
          '-Mode',
          mode,
          '-InputPath',
          inputPath,
          '-OutputPath',
          outputPath,
        ],
        { windowsHide: true }
      );

      let stdout = '';
      let stdoutLineBuf = '';
      let stderr = '';
      let settled = false;
      const spawnedProcs = [];

      const handleStdoutLine = (rawLine) => {
        const line = rawLine.trim();
        const m = /^SPAWNED_PROC:(\d+):(\d+)$/.exec(line);
        if (m) {
          const pid = Number(m[1]);
          const ticks = m[2];
          if (
            Number.isInteger(pid) &&
            pid > 0 &&
            !spawnedProcs.some((x) => x.pid === pid && x.ticks === ticks)
          ) {
            spawnedProcs.push({ pid, ticks });
          }
        }
      };

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          child.kill('SIGKILL');
        } catch {}
        this.#cleanupSpawnedComPids(spawnedProcs);
        reject(new Error(`Office COM timed out after ${this.#timeoutMs}ms`));
      }, this.#timeoutMs);

      child.stdout?.on('data', (chunk) => {
        const str = chunk.toString('utf8');
        if (stdout.length < 64 * 1024) stdout += str;
        stdoutLineBuf += str;
        let nlIdx;
        while ((nlIdx = stdoutLineBuf.indexOf('\n')) !== -1) {
          handleStdoutLine(stdoutLineBuf.slice(0, nlIdx));
          stdoutLineBuf = stdoutLineBuf.slice(nlIdx + 1);
        }
      });

      child.stderr?.on('data', (chunk) => {
        if (stderr.length < 64 * 1024) stderr += chunk.toString('utf8');
      });

      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (stdoutLineBuf) handleStdoutLine(stdoutLineBuf);
        this.#cleanupSpawnedComPids(spawnedProcs);
        reject(err);
      });

      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (stdoutLineBuf) handleStdoutLine(stdoutLineBuf);
        if (code !== 0) {
          this.#cleanupSpawnedComPids(spawnedProcs);
          return reject(new Error(stderr.trim() || `PowerShell exited with code ${code}`));
        }
        if (!existsSync(outputPath)) {
          this.#cleanupSpawnedComPids(spawnedProcs);
          return reject(new Error(`Missing PDF output. stdout=${stdout}`));
        }
        resolve();
      });
    });
  }

  #runLibreOffice(inputPath, outDir) {
    return new Promise((resolve, reject) => {
      const profileDir = join(outDir, 'lo-profile');
      try {
        mkdirSync(profileDir, { recursive: true });
      } catch {}
      const args = [
        '--headless',
        '--nologo',
        '--nodefault',
        '--norestore',
        '--nolockcheck',
        `-env:UserInstallation=${pathToFileURL(profileDir).href}`,
        '--convert-to',
        'pdf',
        '--outdir',
        outDir,
        inputPath,
      ];
      const env = { ...process.env };
      if (process.platform === 'darwin') {
        const userFontsConf = join(homedir(), '.config', 'fontconfig', 'fonts.conf');
        if (!env.FONTCONFIG_FILE && existsSync(userFontsConf)) {
          env.FONTCONFIG_FILE = userFontsConf;
        }
        if (!env.LC_ALL || env.LC_ALL === 'C' || env.LC_ALL === 'C.UTF-8') {
          env.LC_ALL = 'zh_CN.UTF-8';
        }
      }
      execFile(
        this.#engines.libreoffice,
        args,
        {
          timeout: this.#timeoutMs,
          windowsHide: true,
          encoding: 'utf8',
          maxBuffer: 1024 * 1024,
          env,
        },
        (err, _stdout, stderr) => {
          if (err) {
            return reject(new Error(stderr?.trim() || err.message));
          }
          resolve();
        }
      );
    });
  }

  readCachedPdf(key) {
    if (!CACHE_KEY_RE.test(String(key || ''))) {
      return null;
    }
    const target = join(this.#cacheDir, `${key}.pdf`);
    if (!existsSync(target)) return null;
    try {
      const st = statSync(target);
      if (!st.isFile() || st.size <= 0) return null;
      return readFileSync(target);
    } catch {
      return null;
    }
  }

  #pruneCache(maxFiles = 60, maxTotalBytes = 250 * 1024 * 1024) {
    try {
      if (!existsSync(this.#cacheDir)) return;
      const entries = [];
      let totalBytes = 0;
      const now = Date.now();
      for (const name of readdirSync(this.#cacheDir)) {
        const full = join(this.#cacheDir, name);
        if (name.startsWith('com_') || name.startsWith('lo_')) {
          try {
            const dst = statSync(full);
            if (dst.isDirectory() && now - dst.mtimeMs > 10 * 60 * 1000) {
              rmSync(full, { recursive: true, force: true });
            }
          } catch {}
          continue;
        }
        if (!name.toLowerCase().endsWith('.pdf') || name.includes('.tmp.')) continue;
        try {
          const st = statSync(full);
          if (!st.isFile()) continue;
          entries.push({ full, name, size: st.size, time: Math.max(st.atimeMs || 0, st.mtimeMs || 0) });
          totalBytes += st.size;
        } catch {}
      }
      if (entries.length <= maxFiles && totalBytes <= maxTotalBytes) return;
      entries.sort((a, b) => a.time - b.time); // oldest first
      while (entries.length > maxFiles || totalBytes > maxTotalBytes) {
        const oldest = entries.shift();
        if (!oldest) break;
        try {
          unlinkSync(oldest.full);
          const key = oldest.name.slice(0, -4);
          this.#metaByKey.delete(key);
          const mp = this.#metaPathFor(key);
          if (existsSync(mp)) unlinkSync(mp);
          totalBytes -= oldest.size;
        } catch {}
      }
    } catch {
      // Ignore cache pruning errors
    }
  }
}
