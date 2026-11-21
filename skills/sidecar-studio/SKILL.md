---
name: sidecar-studio
description: 打开与使用 Sidecar Studio 三合一侧边栏工作台（工作区文件树、Word/Excel/PPT/PDF 实时高保真预览、划词引用反馈与只读对话轨迹查看器）。当用户想预览文档、浏览项目文件、查看对话执行轨迹，或在对话中刚生成/修改了 Office 或 PDF 文档时触发。
---

# Sidecar Studio 侧边栏工作台

`antigravity-sidecar-studio` 是全局启用的 Antigravity 辅助面板插件，提供项目文件树、Word/Excel/PPT/PDF 离线高保真预览以及当前对话轨迹查看器。

## 一键唤起侧边栏

向用户输出以下 `sidecar://` 胶囊链接即可直接打开或切换右侧工作台面板：

```markdown
[📂 打开 Sidecar Studio](sidecar://antigravity-sidecar-studio/studio/)
```

## 核心能力与使用提示

1. **打开的文档实时预览**：面板顶部文档标签条会自动汇总当前对话创建或修改的 `.docx` / `.xlsx` / `.xls` / `.pptx` / `.pdf` / `.md` 等文件；当 AI 修改当前正在预览的文件时，面板会在 2 秒内自动无感刷新。
2. **划词引用发给 AI**：在 Word、PDF、PPT、Markdown 或代码预览中选中文字，或在 Excel 中选中单元格区域后，点击浮动「💬 引用发给 AI」即可立即发送给当前对话，或暂存为文档批注。
3. **项目文件树**：自动同步当前活跃工作区，支持模糊搜索、显示/隐藏忽略目录，并支持在 Antigravity 原生标签页中打开或一键发送文件路径。
4. **对话轨迹查看器**：切换到顶部「🧭 对话轨迹」可按时间线查看用户输入、模型回复、折叠的思考过程与工具调用；存在截断字段时可按需读取 `transcript_full.jsonl` 展开，轨迹中提到的文档可一键点击直达预览。
