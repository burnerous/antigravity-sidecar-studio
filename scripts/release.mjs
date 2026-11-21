#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');
const STUDIO_DIR = join(REPO_ROOT, 'sidecars', 'studio');

function printHelp() {
  console.log(`Sidecar Studio 一键发版脚本 (scripts/release.mjs)

用法:
  node scripts/release.mjs <version> [options]

参数:
  <version>               语义化版本号，如 1.0.1 或 v1.0.1

选项:
  --notes "<text>"        本次版本更新说明（写入 GitHub Release 描述）
  --notes-file <path>     从 Markdown 文件读取本次版本更新说明
  --dry-run               试运行：校验环境、扫描隐私、跑 npm test 并试打离线包与校验 SHA-256，不修改文件也不推送远端
  --allow-dirty           允许在存在未提交改动时执行正式发版（默认要求工作区干净）
  -h, --help              显示此帮助信息

示例:
  node scripts/release.mjs 1.0.1 --dry-run --notes "试运行验证"
  node scripts/release.mjs 1.0.1 --notes "修复部分文档边界兼容性问题"
`);
}

function fail(msg) {
  console.error(`\n[release ERROR] ${msg}`);
  process.exit(1);
}

function runCmd(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    cwd: opts.cwd || REPO_ROOT,
    encoding: 'utf8',
    shell: false,
    stdio: opts.capture ? 'pipe' : 'inherit',
  });
  if (res.error) {
    fail(`执行命令失败 (${cmd} ${args.join(' ')}): ${res.error.message}`);
  }
  if (res.status !== 0) {
    const errText = opts.capture ? (res.stderr || res.stdout || '').trim() : '';
    fail(`命令退出码 ${res.status}: ${cmd} ${args.join(' ')}${errText ? `\n${errText}` : ''}`);
  }
  return opts.capture ? (res.stdout || '').trim() : '';
}

function tryCmd(cmd, args, opts = {}) {
  return spawnSync(cmd, args, {
    cwd: opts.cwd || REPO_ROOT,
    encoding: 'utf8',
    shell: false,
    stdio: 'pipe',
  });
}

function runNpm(npmArgs, opts = {}) {
  const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (existsSync(npmCli)) {
    return runCmd(process.execPath, [npmCli, ...npmArgs], opts);
  }
  if (process.platform === 'win32') {
    return runCmd('cmd.exe', ['/d', '/c', 'npm', ...npmArgs], opts);
  }
  return runCmd('npm', npmArgs, opts);
}

function parseArgs(argv) {
  let versionArg = '';
  let notes = '';
  let notesFile = '';
  let dryRun = false;
  let allowDirty = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') {
      printHelp();
      process.exit(0);
    } else if (a === '--dry-run') {
      dryRun = true;
    } else if (a === '--allow-dirty') {
      allowDirty = true;
    } else if (a === '--notes') {
      notes = argv[++i] ?? '';
    } else if (a.startsWith('--notes=')) {
      notes = a.slice('--notes='.length);
    } else if (a === '--notes-file') {
      notesFile = argv[++i] ?? '';
    } else if (a.startsWith('--notes-file=')) {
      notesFile = a.slice('--notes-file='.length);
    } else if (!a.startsWith('-') && !versionArg) {
      versionArg = a;
    } else {
      fail(`未知参数: ${a}（使用 --help 查看用法）`);
    }
  }

  if (!versionArg) {
    printHelp();
    fail('请提供目标版本号，例如: node scripts/release.mjs 1.0.1 --dry-run');
  }

  const normalized = versionArg.replace(/^v/i, '');
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(normalized)) {
    fail(`版本号格式不合法 "${versionArg}"，请使用 x.y.z（如 1.0.1 或 v1.1.0-beta.1）`);
  }

  if (notesFile) {
    const resolvedNotesFile = resolve(process.cwd(), notesFile);
    if (!existsSync(resolvedNotesFile)) {
      fail(`找不到 --notes-file 指定的文件: ${resolvedNotesFile}`);
    }
    notes = readFileSync(resolvedNotesFile, 'utf8').trim();
  }

  return {
    version: normalized,
    tag: `v${normalized}`,
    notes: notes.trim(),
    dryRun,
    allowDirty,
  };
}

function collectFiles(dir, ignoreDirs = new Set()) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (ignoreDirs.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectFiles(full, ignoreDirs));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function runPrivacyAudit() {
  console.log('[1/6] 执行源码隐私与卫生扫描...');
  const files = collectFiles(REPO_ROOT, new Set(['.git', 'node_modules', 'cache', '.cache', 'tmp']));
  const binaryExts = new Set(['.png', '.svg', '.jpg', '.jpeg', '.webp', '.woff', '.woff2', '.ttf', '.wasm', '.bin', '.zip', '.bcmap']);
  const osUsername = (() => {
    try {
      return userInfo().username || '';
    } catch {
      return '';
    }
  })();

  const checks = [
    { name: 'legacy-slug', re: new RegExp('workspace' + '-studio', 'i') },
    { name: 'legacy-title', re: new RegExp('Workspace' + ' Studio', 'i') },
    { name: 'win-user-path', re: /[A-Za-z]:\\Users\\[^\\\s"'`<>]+\\/i },
    { name: 'mac-user-path', re: /\/Users\/[^/\s"'`<>]+\// },
    { name: 'linux-home-path', re: /\/home\/[^/\s"'`<>]+\// },
  ];

  if (
    osUsername &&
    osUsername.length >= 3 &&
    !['burnerous', 'lu0h1n', 'user', 'admin', 'root', 'node'].includes(osUsername.toLowerCase())
  ) {
    const escaped = osUsername.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    checks.push({ name: 'local-os-username', re: new RegExp(escaped, 'i') });
  }

  const emailRe = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
  const hits = [];

  for (const full of files) {
    const rel = relative(REPO_ROOT, full).replace(/\\/g, '/');
    if (
      rel === 'scripts/release.mjs' ||
      rel === 'sidecars/studio/package-lock.json' ||
      rel.startsWith('sidecars/studio/public/previewers/')
    ) {
      continue;
    }
    const extIdx = rel.lastIndexOf('.');
    if (extIdx !== -1 && binaryExts.has(rel.slice(extIdx).toLowerCase())) {
      continue;
    }

    const lines = readFileSync(full, 'utf8').split(/\r?\n/);
    lines.forEach((line, idx) => {
      for (const chk of checks) {
        if (chk.re.test(line)) {
          hits.push(`${rel}:${idx + 1} [${chk.name}] ${line.trim()}`);
        }
      }
      const emails = line.match(emailRe) || [];
      for (const email of emails) {
        const lower = email.toLowerCase();
        if (!lower.endsWith('@users.noreply.github.com') && !lower.endsWith('@example.com')) {
          hits.push(`${rel}:${idx + 1} [raw-email] ${email}`);
        }
      }
    });
  }

  if (hits.length > 0) {
    fail(`隐私与卫生扫描发现 ${hits.length} 处异常:\n  - ${hits.join('\n  - ')}`);
  }
  console.log('  ✓ 隐私与卫生扫描通过（0 异常）');
}

function checkNativeBinaries(nmDir) {
  if (!existsSync(nmDir)) return [];
  const nativeExts = new Set(['.node', '.dll', '.exe', '.so', '.dylib']);
  return collectFiles(nmDir).filter((f) => {
    const idx = f.lastIndexOf('.');
    return idx !== -1 && nativeExts.has(f.slice(idx).toLowerCase());
  });
}

function syncVersionFiles(version, tag) {
  console.log(`[3/6] 同步版本号至 ${version} (${tag})...`);

  const pluginJsonPath = join(REPO_ROOT, 'plugin.json');
  const pluginJson = JSON.parse(readFileSync(pluginJsonPath, 'utf8'));
  pluginJson.version = version;
  writeFileSync(pluginJsonPath, `${JSON.stringify(pluginJson, null, 2)}\n`, 'utf8');

  const pkgPath = join(STUDIO_DIR, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  pkg.version = version;
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');

  const lockPath = join(STUDIO_DIR, 'package-lock.json');
  if (existsSync(lockPath)) {
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
    lock.version = version;
    if (lock.packages && lock.packages['']) {
      lock.packages[''].version = version;
    }
    writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
  }

  const readmePath = join(REPO_ROOT, 'README.md');
  let readme = readFileSync(readmePath, 'utf8');
  readme = readme.replace(/Release-v[0-9A-Za-z._-]+-3b82f6/g, `Release-${tag}-3b82f6`);
  readme = readme.replace(
    /antigravity-sidecar-studio-v[0-9A-Za-z._-]+-offline\.zip/g,
    `antigravity-sidecar-studio-${tag}-offline.zip`
  );
  writeFileSync(readmePath, readme, 'utf8');
  console.log('  ✓ 已更新 plugin.json, package.json, package-lock.json, README.md');
}

function createCrossPlatformZip(stageParent, pluginFolderName, zipPath) {
  const stageDir = join(stageParent, pluginFolderName);
  if (process.platform === 'win32') {
    const psScriptPath = join(stageParent, '_pack.ps1');
    const esc = (s) => s.replace(/'/g, "''");
    const psContent = `
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zipOut = '${esc(zipPath)}'
$stageDir = '${esc(stageDir)}'
$parentLen = '${esc(stageParent)}'.TrimEnd('\\').Length + 1
if (Test-Path -LiteralPath $zipOut) { Remove-Item -LiteralPath $zipOut -Force }
$fs = [System.IO.File]::Open($zipOut, [System.IO.FileMode]::Create)
$archive = New-Object System.IO.Compression.ZipArchive($fs, [System.IO.Compression.ZipArchiveMode]::Create)
Get-ChildItem -LiteralPath $stageDir -Recurse -File | ForEach-Object {
  $rel = $_.FullName.Substring($parentLen).Replace('\\', '/')
  [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $_.FullName, $rel, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
}
$archive.Dispose()
$fs.Dispose()

$check = [System.IO.Compression.ZipFile]::OpenRead($zipOut)
$bad = @($check.Entries | Where-Object { $_.FullName -match '\\\\' }).Count
$hasManifest = @($check.Entries | Where-Object { $_.FullName -eq '${pluginFolderName}/plugin.json' }).Count
$total = $check.Entries.Count
$check.Dispose()
Write-Output ("ZIP_CHECK total=$total backslashes=$bad hasManifest=$hasManifest")
if ($bad -ne 0 -or $hasManifest -ne 1) {
  throw "Invalid zip layout: backslashes=$bad hasManifest=$hasManifest"
}
`;
    writeFileSync(psScriptPath, psContent, 'utf8');
    const out = runCmd(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psScriptPath],
      { capture: true }
    );
    const match = /total=(\d+)\s+backslashes=(\d+)\s+hasManifest=(\d+)/.exec(out);
    return match
      ? { total: Number(match[1]), backslashes: Number(match[2]), hasManifest: Number(match[3]) }
      : { total: 0, backslashes: 0, hasManifest: 1 };
  }

  runCmd('zip', ['-rq', zipPath, pluginFolderName], { cwd: stageParent });
  const listOut = runCmd('unzip', ['-Z1', zipPath], { capture: true });
  const lines = listOut ? listOut.split(/\r?\n/) : [];
  const backslashes = lines.filter((l) => l.includes('\\')).length;
  const hasManifest = lines.includes(`${pluginFolderName}/plugin.json`) ? 1 : 0;
  if (backslashes !== 0 || hasManifest !== 1) {
    fail(`无效的 zip 结构: backslashes=${backslashes}, hasManifest=${hasManifest}`);
  }
  return { total: lines.length, backslashes, hasManifest };
}

function buildReleaseNotes({ version, tag, userNotes, zipName, zipBytes, sha256, testSummary }) {
  const mib = (zipBytes / (1024 * 1024)).toFixed(2);
  const changelogSection = userNotes
    ? `### 📝 更新内容\n\n${userNotes}\n`
    : `### 📝 更新内容\n\n- 发布 Sidecar Studio ${tag} 维护更新。\n`;

  return `## Sidecar Studio (\`antigravity-sidecar-studio\`) ${tag}

${changelogSection}
---

### 📦 开箱即用离线整合包（推荐大多数用户下载）

附件 \`${zipName}\` 已预先打包全部纯 JS 离线前端依赖（跨 **Windows / macOS / Linux** 通用，免 \`npm install\`）：

1. 下载下方资产：\`${zipName}\`
2. 解压至 Antigravity 全局插件目录：
   - **Windows**：\`%USERPROFILE%\\.gemini\\config\\plugins\\\`
   - **macOS / Linux**：\`~/.gemini/config/plugins/\`
3. 确保解压后的结构为 \`.../.gemini/config/plugins/antigravity-sidecar-studio/plugin.json\`（仅一层同名目录），本机需有 **Node.js \`>= 20.0.0\`**。
4. 打开或重启 Antigravity，在插件管理确认 **\`Sidecar Studio\`** 已启用即可。

---

### 🔐 离线包校验信息

- **版本**：\`${version}\` (\`${tag}\`)
- **文件名**：\`${zipName}\`
- **大小**：\`${mib} MiB\` (\`${zipBytes.toLocaleString('en-US')} bytes\`)
- **SHA-256**：\`${sha256}\`
- **自测结果**：\`${testSummary}\`
`;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const { version, tag, dryRun, allowDirty } = opts;

  console.log(`\n=== Sidecar Studio 一键发版 ${dryRun ? '(DRY-RUN 试运行)' : '(正式发布)'}: ${tag} ===\n`);

  // Preflight checks
  runCmd('git', ['--version'], { capture: true });
  runCmd('gh', ['--version'], { capture: true });
  const authCheck = tryCmd('gh', ['auth', 'status']);
  if (authCheck.status !== 0) {
    fail(`GitHub CLI 未登录，请先运行: gh auth login\n${(authCheck.stderr || authCheck.stdout || '').trim()}`);
  }

  const branch = runCmd('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { capture: true });
  if (branch !== 'main') {
    fail(`当前分支为 "${branch}"，请在 main 分支执行发版`);
  }

  const dirty = runCmd('git', ['status', '--porcelain'], { capture: true });
  if (dirty && !dryRun && !allowDirty) {
    fail(`工作区存在未提交改动，请先提交或传入 --allow-dirty：\n${dirty}`);
  }

  const localTag = runCmd('git', ['tag', '-l', tag], { capture: true });
  if (localTag === tag) {
    fail(`本地已存在 Tag "${tag}"，请使用新的递增版本号`);
  }
  const remoteTag = runCmd('git', ['ls-remote', '--tags', 'origin', `refs/tags/${tag}`], {
    capture: true,
  });
  if (remoteTag) {
    fail(`远程仓库 origin 已存在 Tag "${tag}"，请使用新的递增版本号`);
  }

  runPrivacyAudit();

  // Ensure dependencies exist cleanly before tests & packaging
  console.log('[2/6] 检查离线依赖与原生二进制数量...');
  const nmDir = join(STUDIO_DIR, 'node_modules');
  if (!existsSync(nmDir)) {
    if (dryRun) {
      fail(`未检测到 ${nmDir}，试运行前请先在 sidecars/studio 下运行 npm ci`);
    }
    console.log('  未检测到 node_modules，正在执行 npm ci...');
    runNpm(['ci'], { cwd: STUDIO_DIR });
  }
  const nativeBins = checkNativeBinaries(nmDir);
  if (nativeBins.length > 0) {
    fail(`node_modules 发现非纯 JS 二进制文件，无法跨平台直接打包:\n${nativeBins.join('\n')}`);
  }
  console.log('  ✓ 依赖完整且纯 JS（0 个原生二进制）');

  if (!dryRun) {
    syncVersionFiles(version, tag);
  } else {
    console.log(`[3/6] [dry-run] 跳过写入版本号修改（将同步目标设为 ${version}）`);
  }

  console.log('[4/6] 运行 sidecars/studio 自动化自测 (npm test)...');
  const testOut = runNpm(['test'], { cwd: STUDIO_DIR, capture: true });
  const testLine =
    testOut
      .split(/\r?\n/)
      .find((l) => l.includes('ALL PASSED'))
      ?.trim() || 'npm test ALL PASSED';
  const metricMatch = /staticRoutes=\d+,\s*xlsx=[^\s,)]+/.exec(testLine);
  const safeTestSummary = metricMatch
    ? `npm test ALL PASSED (${metricMatch[0]})`
    : 'npm test ALL PASSED';
  console.log(`  ✓ ${safeTestSummary}`);

  const tempRoot = mkdtempSync(join(tmpdir(), 'sidecar-release-'));
  try {
    const stageParent = join(tempRoot, 'stage');
    const stagePlugin = join(stageParent, 'antigravity-sidecar-studio');
    const zipName = `antigravity-sidecar-studio-${tag}-offline.zip`;
    const zipPath = join(tempRoot, zipName);

    console.log(`[5/6] 在临时目录打包跨平台离线 zip (${zipName})...`);
    mkdirSync(stagePlugin, { recursive: true });
    for (const fileName of ['plugin.json', 'LICENSE', 'README.md']) {
      cpSync(join(REPO_ROOT, fileName), join(stagePlugin, fileName));
    }
    if (dryRun) {
      // Reflect candidate version inside staged plugin.json for realistic manifest verification
      const pj = JSON.parse(readFileSync(join(stagePlugin, 'plugin.json'), 'utf8'));
      pj.version = version;
      writeFileSync(join(stagePlugin, 'plugin.json'), `${JSON.stringify(pj, null, 2)}\n`, 'utf8');
    }
    for (const dirName of ['assets', 'rules', 'skills']) {
      cpSync(join(REPO_ROOT, dirName), join(stagePlugin, dirName), { recursive: true });
    }
    cpSync(STUDIO_DIR, join(stagePlugin, 'sidecars', 'studio'), {
      recursive: true,
      filter: (src) => !/(?:^|[\\/])(\.DS_Store|Thumbs\.db|Desktop\.ini|cache|\.cache|tmp)$/i.test(src),
    });

    const zipStats = createCrossPlatformZip(stageParent, 'antigravity-sidecar-studio', zipPath);
    const zipBytes = statSync(zipPath).size;
    const sha256 = createHash('sha256').update(readFileSync(zipPath)).digest('hex').toUpperCase();
    console.log(
      `  ✓ 打包完成: ${(zipBytes / (1024 * 1024)).toFixed(2)} MiB (${zipBytes} bytes), ${zipStats.total} 条目, 反斜杠=${zipStats.backslashes}, HasManifest=${zipStats.hasManifest}`
    );
    console.log(`  ✓ SHA-256: ${sha256}`);

    const releaseNotes = buildReleaseNotes({
      version,
      tag,
      userNotes: opts.notes,
      zipName,
      zipBytes,
      sha256,
      testSummary: safeTestSummary,
    });

    if (dryRun) {
      console.log('\n[6/6] [dry-run] 试运行全部校验通过！未修改仓库文件、未创建 Tag、未推送远端。\n');
      console.log('--- 预览 Release 说明 ---\n' + releaseNotes.trim() + '\n-----------------------');
      return;
    }

    console.log('[6/6] 提交、打 Tag、推送并发布 GitHub Release...');
    runCmd('git', ['add', '-A']);
    const staged = runCmd('git', ['diff', '--cached', '--name-only'], { capture: true })
      .split(/\r?\n/)
      .filter(Boolean);
    const forbidden = staged.filter((p) => /(^|\/)node_modules\/|\.zip$|\.log$/i.test(p));
    if (forbidden.length > 0) {
      fail(`暂存区发现禁止提交的构建/依赖文件:\n${forbidden.join('\n')}`);
    }
    if (staged.length > 0) {
      runCmd('git', ['commit', '-m', `chore(release): ${tag}`]);
    }
    runCmd('git', ['tag', '-a', tag, '-m', `Sidecar Studio ${tag}`]);
    runCmd('git', ['push', 'origin', 'main', '--follow-tags']);

    const notesTmp = join(tempRoot, 'release-notes.md');
    writeFileSync(notesTmp, releaseNotes, 'utf8');
    const releaseUrl = runCmd(
      'gh',
      [
        'release',
        'create',
        tag,
        zipPath,
        '--title',
        `Sidecar Studio ${tag}`,
        '--notes-file',
        notesTmp,
      ],
      { capture: true }
    );
    console.log(`\n🎉 发版成功！Release 页面：${releaseUrl}\n`);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  fail(err?.stack || String(err));
});
