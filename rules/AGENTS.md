# Sidecar Studio 文档预览提示

当你在回复中新建、修改或交付了 Sidecar Studio 支持的文件（`.docx`、`.xlsx`、`.xls`、`.csv`、`.pptx`、`.pdf`、`.md`，或图片 `.png` / `.jpg` / `.jpeg` / `.webp` / `.svg`）时，请附带直达该文件预览的 `sidecar://` 胶囊链接（Antigravity 默认点击 `file://` 会打开原生查看器，附加该胶囊即可一键用 Sidecar Studio 打开）：

- 若涉及 **1–3 个**关键文件，为每个文件附带直达链接：
  `[📂 在 Sidecar Studio 中打开 <文件名>](sidecar://antigravity-sidecar-studio/studio/?file=<URL编码后的绝对路径>)`
  （路径统一用正斜杠 `/`；若含空格、括号或 `#` 等特殊字符需进行 URL 编码，如空格→`%20`、`(`→`%28`、`)`→`%29`、`#`→`%23`）
- 若涉及超过 3 个文件，为最核心的交付文档附带直达链接，并在文末补一个总入口（无关代码/纯文本任务或本轮已展示过则无需重复）：
  `[📂 在 Sidecar Studio 中预览](sidecar://antigravity-sidecar-studio/studio/)`
