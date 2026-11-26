---
name: sidecar-studio
description: 打开与使用 Sidecar Studio 三合一侧边栏工作台（工作区文件树、Word/Excel/PPT/PDF 实时高保真预览、划词引用反馈、只读对话轨迹查看器，以及应用内检查更新与一键升级）。当用户想预览文档、浏览项目文件、查看对话执行轨迹、在对话中刚生成/修改了 Office 或 PDF 文档，或要求「检查 Sidecar Studio 更新」「更新插件」「升级 Sidecar Studio」时触发。
---

# Sidecar Studio 侧边栏工作台

`antigravity-sidecar-studio` 是全局启用的 Antigravity 辅助面板插件，提供项目文件树、Word/Excel/PPT/PDF 离线高保真预览、当前对话轨迹查看器，以及内置自更新能力。

## 一键唤起侧边栏与直达指定文件

- **打开/切换侧边栏工作台**：
  ```markdown
  [📂 打开 Sidecar Studio](sidecar://antigravity-sidecar-studio/studio/)
  ```
- **直达预览指定文件**（支持 `.docx` / `.xlsx` / `.xls` / `.csv` / `.pptx` / `.pdf` / `.md` / 图片及常见代码文件）：
  ```markdown
  [📂 在 Sidecar Studio 中打开 <文件名>](sidecar://antigravity-sidecar-studio/studio/?file=<URL编码后的绝对路径>)
  ```
  - 路径统一使用正斜杠 `/`（Windows 如 `C:/path/to/file.md`，macOS/Linux 如 `/path/to/file.md`）。
  - 文件名或路径包含空格、括号、`#` 等特殊字符时需做 percent-encoding（空格→`%20`、`(`→`%28`、`)`→`%29`、`#`→`%23`），避免破坏 Markdown 链接或被截断。

## 核心能力与使用提示

1. **打开的文档实时预览**：面板顶部文档标签条会自动汇总当前对话创建或修改的 `.docx` / `.xlsx` / `.xls` / `.pptx` / `.pdf` / `.md` 等文件；当 AI 修改当前正在预览的文件时，面板会在 2 秒内自动无感刷新。
2. **划词引用发给 AI**：在 Word、PDF、PPT、Markdown 或代码预览中选中文字，或在 Excel 中选中单元格区域后，点击浮动「💬 引用发给 AI」即可立即发送给当前对话，或暂存为文档批注。
3. **项目文件树**：自动同步当前活跃工作区，支持模糊搜索、显示/隐藏忽略目录，并支持在 Antigravity 原生标签页中打开或一键发送文件路径。
4. **对话轨迹查看器**：切换到顶部「🧭 对话轨迹」可按时间线查看用户输入、模型回复、折叠的思考过程与工具调用；存在截断字段时可按需读取 `transcript_full.jsonl` 展开，轨迹中提到的文档可一键点击直达预览。

## 检查更新与一键升级

用户既可以在 **Sidecar Studio 侧边栏右上角**点击更新图标查看最新版本并一键热更新，也可以直接在对话中要求你协助检查或升级。

当用户在对话中请求检查更新或升级 Sidecar Studio 时，请优先使用插件内置更新脚本（共享同一套 SHA-256 校验、安全解压与回滚逻辑，不要自行拼装下载解压命令）：

- **定位插件目录**：通常位于 `~/.gemini/config/plugins/antigravity-sidecar-studio`（Windows PowerShell 为 `$env:USERPROFILE\.gemini\config\plugins\antigravity-sidecar-studio`；若不确定安装路径，可先通过插件列表确认）。
- **检查最新版本**（强制刷新 GitHub Releases）：
  ```bash
  node ~/.gemini/config/plugins/antigravity-sidecar-studio/sidecars/studio/scripts/update.mjs --check --force
  ```
  Windows (PowerShell)：
  ```powershell
  node "$env:USERPROFILE\.gemini\config\plugins\antigravity-sidecar-studio\sidecars\studio\scripts\update.mjs" --check --force
  ```
- **执行一键更新**（支持离线包 SHA-256 校验替换与干净 `main` 分支 `git pull --ff-only`）：
  ```bash
  node ~/.gemini/config/plugins/antigravity-sidecar-studio/sidecars/studio/scripts/update.mjs --apply
  ```
  Windows (PowerShell)：
  ```powershell
  node "$env:USERPROFILE\.gemini\config\plugins\antigravity-sidecar-studio\sidecars\studio\scripts\update.mjs" --apply
  ```
- 若用户网络访问 GitHub 受限，可提示附带 `--mirror <https-url>` 参数（仅在具备官方 SHA-256 校验摘要时允许通过镜像下载）。更新完成后，正在运行的 Sidecar 会在数秒内自动热重启；如未自动刷新，引导用户点开侧边栏或刷新面板即可。
