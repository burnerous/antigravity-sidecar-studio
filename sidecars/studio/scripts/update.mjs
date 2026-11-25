#!/usr/bin/env node
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveAppDataDir } from '../lib/security.mjs';
import { PluginUpdater } from '../lib/updater.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEFAULT_STUDIO_DIR = resolve(__dirname, '..');
const DEFAULT_PLUGIN_ROOT = resolve(DEFAULT_STUDIO_DIR, '..', '..');

function printHelp(out = console.log) {
  out(`Sidecar Studio 更新工具 (sidecars/studio/scripts/update.mjs)

用法:
  node sidecars/studio/scripts/update.mjs [options]

选项:
  --check                 仅检查是否有可用更新（默认行为）
  --apply                 如有新版本则立即下载/拉取并更新插件
  --force                 忽略 6 小时检查缓存，强制请求最新 Release
  --mirror <https-url>    指定临时 HTTPS 下载镜像前缀
  --json                  以 JSON 格式输出结果
  -h, --help              显示此帮助信息
`);
}

function parseCliArgs(argv) {
  let checkOnly = true;
  let apply = false;
  let force = false;
  let json = false;
  let mirror;
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') {
      help = true;
    } else if (a === '--check') {
      checkOnly = true;
    } else if (a === '--apply') {
      apply = true;
      checkOnly = false;
    } else if (a === '--force') {
      force = true;
    } else if (a === '--json') {
      json = true;
    } else if (a === '--mirror') {
      mirror = argv[++i] ?? '';
    } else if (a.startsWith('--mirror=')) {
      mirror = a.slice('--mirror='.length);
    } else {
      throw new Error(`未知参数: ${a}`);
    }
  }

  return { checkOnly, apply, force, json, mirror, help };
}

export async function runUpdateCli(argv = [], deps = {}) {
  const stdout = deps.stdout || ((msg) => console.log(msg));
  const stderr = deps.stderr || ((msg) => console.error(msg));

  let opts;
  try {
    opts = parseCliArgs(argv);
  } catch (err) {
    stderr(`[sidecar-studio-update] ${err.message}`);
    return 1;
  }

  if (opts.help) {
    printHelp(stdout);
    return 0;
  }

  const pluginRoot = resolve(deps.pluginRoot || DEFAULT_PLUGIN_ROOT);
  const studioDir = resolve(deps.studioDir || join(pluginRoot, 'sidecars', 'studio'));
  const dataDir = resolve(
    deps.dataDir ||
      process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR ||
      join(resolveAppDataDir(), 'sidecar_data', 'antigravity-sidecar-studio-cli') ||
      join(tmpdir(), 'sidecar-studio-updater')
  );

  const updater = new PluginUpdater({
    pluginRoot,
    studioDir,
    dataDir,
    fetchImpl: deps.fetchImpl,
    apiBaseUrl: deps.apiBaseUrl,
    webBaseUrl: deps.webBaseUrl,
    allowedDownloadHosts: deps.allowedDownloadHosts,
    onRestart: deps.onRestart || (() => {}),
    checkTtlMs: deps.checkTtlMs,
  });

  try {
    const status = await updater.checkForUpdates({
      force: opts.force || opts.apply,
      background: false,
      customMirror: opts.mirror,
    });

    if (opts.apply && status.updateAvailable) {
      await updater.startUpdate({
        targetVersion: status.latest.version,
        customMirror: opts.mirror,
      });
      const job = await updater.waitForJob();
      const finalStatus = updater.getStatus();
      if (opts.json) {
        stdout(JSON.stringify({ ok: job?.state === 'completed', status: finalStatus, job }, null, 2));
      } else if (job?.state === 'completed') {
        stdout(
          `[Sidecar Studio] 更新成功：v${job.fromVersion} -> v${job.targetVersion} (${job.installMode})\n` +
            `提示：若侧边栏正在运行，将在数秒内自动热重启；如未自动刷新，请重新打开 Sidecar Studio 面板。`
        );
      } else {
        stderr(`[Sidecar Studio] ${job?.message || '更新失败'}`);
        return 1;
      }
      return job?.state === 'completed' ? 0 : 1;
    }

    if (opts.json) {
      stdout(JSON.stringify({ ok: true, status }, null, 2));
    } else if (status.updateAvailable) {
      stdout(
        `[Sidecar Studio] 发现新版本：v${status.currentVersion} -> v${status.latest.version}\n` +
          `安装模式：${status.installMode}${status.gitInfo?.blockReason ? `（受限：${status.gitInfo.blockReason}）` : ''}\n` +
          `发布页面：${status.latest.releaseUrl}\n` +
          (status.latest.changelog ? `\n更新内容：\n${status.latest.changelog}\n` : '') +
          `\n可执行 --apply 参数立即更新，或在 Sidecar Studio 侧边栏右上角点击更新按钮。`
      );
    } else {
      stdout(`[Sidecar Studio] 当前已是最新版本 v${status.currentVersion} (${status.installMode})。`);
    }
    return 0;
  } catch (err) {
    if (opts.json) {
      stdout(JSON.stringify({ ok: false, error: err?.message || String(err) }, null, 2));
    } else {
      stderr(`[Sidecar Studio] 检查/更新失败: ${err?.message || String(err)}`);
    }
    return 1;
  }
}

const isMain =
  process.argv[1] && resolve(process.argv[1]).toLowerCase() === __filename.toLowerCase();

if (isMain) {
  runUpdateCli(process.argv.slice(2)).then((code) => process.exit(code));
}
