# Sidecar Studio (`antigravity-sidecar-studio`) — Repo Guide

Google Antigravity global Aux Pane plugin (`main` branch · `github.com/burnerous/antigravity-sidecar-studio`).

## Hard Constraints
- **Stack**: Node.js `>= 20` ESM backend (`sidecars/studio/server.mjs` + `lib/*.mjs`) + pure vanilla HTML/CSS/JS frontend (`sidecars/studio/public/`), zero build step.
- **100% Offline & Zero CDN**: All frontend libs live in `sidecars/studio/node_modules/` and are exposed locally via `lib/static-registry.mjs`; strictly pure JS dependencies (0 native `.node` / `.dll` / `.exe` / `.so` / `.dylib` binaries).
- **Security & Privacy Boundaries**:
  - Validate file access with `SecurityManager.assertAllowedPath`; keep `POST /api/file/save` (`allowBrain: false`), and for `POST /api/file/save-as` allow active-conversation `brain/` while strictly blocking `.system_generated/` and cross-conversation brain directories.
  - Respect strict CSP in `sidecars/studio/public/index.html` and attachment/sandbox headers on `/api/file/raw` & `/api/doc/cache-pdf`.
  - Never commit local OS usernames, absolute machine user paths, or personal raw emails.
- **Sandboxed Iframe Caveat**: Sidecar Studio runs inside a sandboxed Antigravity iframe where `window.confirm()` / `window.alert()` may be silently blocked—always use inline UI confirmations instead.

## Core Entry Points
- **Backend & Self-Tests**: `sidecars/studio/server.mjs`, `sidecars/studio/lib/{security,static-registry,workspace,office-converter,transcript,updater}.mjs`
- **Frontend Shell**: `sidecars/studio/public/{index.html,styles.css,app.js,trajectory-view.js,icons.js}`
- **Previewers**: `sidecars/studio/public/previewers/{docx,xlsx,pptx,pdf,image,text}-viewer.js`
- **Plugin Rules Separation**: Keep maintainer instructions in this root `AGENTS.md` (not packaged into offline release zips); `rules/AGENTS.md` is injected globally into end users' workspaces when the plugin is enabled.

## Verification & Release
- **Full Backend & Route Self-Tests**: `npm --prefix sidecars/studio test` (runs `node server.mjs --test`; verify `ALL PASSED`).
- **Frontend Syntax Check**: `node --check sidecars/studio/public/<file>.js`.
- **Release**: `node scripts/release.mjs <x.y.z> --dry-run --notes-file <path>` then without `--dry-run`. Use local Git identity `Lu0H1N <128958606+burnerous@users.noreply.github.com>` and set `HTTP_PROXY` / `HTTPS_PROXY` to `http://127.0.0.1:7897` when pushing or invoking `gh`.
