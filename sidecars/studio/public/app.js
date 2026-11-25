(function (global) {
  'use strict';

  const {
    renderDocxPreview,
    renderImagePreview,
    renderPdfPreview,
    renderPptxPreview,
    renderTextOrImagePreview,
    renderXlsxPreview,
    createTrajectoryController,
  } = global.WSModules || {};

  const $ = (id) => document.getElementById(id);
  const WSIcons = global.WSIcons;
  if (WSIcons?.hydrate) WSIcons.hydrate(document);

  function renderFileSvg(item, opts = {}) {
    if (WSIcons?.renderFile) return WSIcons.renderFile(item, opts);
    return '';
  }

  const MAX_STAGED_COMMENTS = 50;
  const STAGED_STORAGE_PREFIX = 'ws-studio-staged-comments:';

  const state = {
    mode: 'workbench',
    roots: [],
    activeRoot: '',
    workspaceGen: 0,
    workspaceRegSeq: 0,
    lastRegisteredUrisKey: null,
    showIgnored: false,
    searchQuery: '',
    expandedDirs: new Set(),
    dirCache: new Map(),
    watchRev: 0,
    activeFile: null,
    activeFileSig: '',
    activeController: null,
    activeCleanup: null,
    previewOpenSeq: 0,
    statPollInFlight: false,
    pollTimers: [],
    producedDocs: [],
    producedOnlyDocs: true,
    seenProducedPaths: new Set(),
    openTabs: [],
    dismissedPaths: new Map(),
    hasUserClosedAll: false,
    capabilities: {},
    conversationId:
      global.sidecar?.conversationId || new URLSearchParams(location.search).get('conversationId') || '',
    pendingQuote: null,
    stagedComments: [],
    stagedPopoverOpen: false,
    stagedStorageKeyLoaded: '',
    stagedSending: false,
    contextTarget: null,
    tabContextTarget: null,
    openTabsFilterQuery: '',
  };

  let toastTimer = null;
  function showToast(msg, duration = 2200) {
    const el = $('wsToast');
    el.textContent = msg;
    el.classList.remove('is-hidden');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('is-hidden'), duration);
  }

  // ---------- Host Theme Sync ----------
  function syncThemeScheme() {
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;color:var(--background, #0f1117)';
    document.documentElement.appendChild(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    const nums = (c.match(/[\d.]+/g) || []).map(Number);
    if (nums.length < 3) return;
    const scale = c.startsWith('color(') ? 1 : 255;
    const [r, g, b] = nums.slice(0, 3).map((v) => v / scale);
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const theme = lum < 0.5 ? 'dark' : 'light';
    if (document.documentElement.dataset.theme !== theme) {
      document.documentElement.dataset.theme = theme;
      const hljsLink = $('hljs-theme');
      if (hljsLink) {
        hljsLink.href = theme === 'dark' ? '/vendor/hljs-dark.css' : '/vendor/hljs-light.css';
      }
    }
  }

  syncThemeScheme();
  new MutationObserver(syncThemeScheme).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['style'],
  });

  // ---------- Helper HTTP wrappers ----------
  function apiFetch(url, options) {
    const f = global.sidecar && typeof global.sidecar.fetch === 'function'
      ? global.sidecar.fetch.bind(global.sidecar)
      : global.fetch.bind(global);
    return f(url, options);
  }

  async function postJson(url, body) {
    const res = await apiFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }

  async function getJson(url) {
    const res = await apiFetch(url, { method: 'GET' });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    return res.json();
  }

  function uint8ToBase64(bytes) {
    const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const chunkSize = 0x8000;
    const chunks = [];
    for (let i = 0; i < arr.length; i += chunkSize) {
      chunks.push(String.fromCharCode.apply(null, arr.subarray(i, i + chunkSize)));
    }
    return global.btoa(chunks.join(''));
  }

  global.WSModules = global.WSModules || {};
  global.WSModules.uint8ToBase64 = uint8ToBase64;

  function getFileIcon(item, opts = {}) {
    return renderFileSvg(item, opts);
  }

  // ---------- Mode & Responsive Drawer ----------
  const trajectoryCtrl = createTrajectoryController({
    listEl: $('trajList'),
    convLabelEl: $('trajConvLabel'),
    badgeEl: $('trajStepBadge'),
    followToggleEl: $('trajFollowToggle'),
    filterChipsEl: $('trajFilterChips'),
    searchInputEl: $('trajSearchInput'),
    refreshBtnEl: $('trajRefreshBtn'),
    getConversationId: () => state.conversationId,
    onOpenFile: (file) => {
      switchMode('workbench');
      openFilePreview(file);
    },
    showToast,
  });

  function switchMode(mode) {
    state.mode = mode;
    $('tabWorkbench').classList.toggle('is-active', mode === 'workbench');
    $('tabTrajectory').classList.toggle('is-active', mode === 'trajectory');
    $('tabWorkbench').setAttribute('aria-selected', String(mode === 'workbench'));
    $('tabTrajectory').setAttribute('aria-selected', String(mode === 'trajectory'));
    $('workbenchPane').classList.toggle('is-hidden', mode !== 'workbench');
    $('trajectoryPane').classList.toggle('is-hidden', mode !== 'trajectory');
    trajectoryCtrl.setVisible(mode === 'trajectory');
  }

  $('tabWorkbench').addEventListener('click', () => switchMode('workbench'));
  $('tabTrajectory').addEventListener('click', () => switchMode('trajectory'));

  function setTreeCollapsed(collapsed) {
    $('workbenchPane').classList.toggle('is-tree-collapsed', collapsed);
    $('toggleTreeBtn').classList.toggle('is-active', !collapsed);
  }

  setTreeCollapsed(global.innerWidth < 520);

  $('toggleTreeBtn').addEventListener('click', () => {
    if (state.mode !== 'workbench') switchMode('workbench');
    const next = !$('workbenchPane').classList.contains('is-tree-collapsed');
    setTreeCollapsed(next);
  });
  global.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.stagedPopoverOpen) {
      e.preventDefault();
      closeStagedPopover({ restoreFocus: true });
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === '\\') {
      e.preventDefault();
      if (state.mode !== 'workbench') switchMode('workbench');
      const next = !$('workbenchPane').classList.contains('is-tree-collapsed');
      setTreeCollapsed(next);
    }
  });
  $('drawerBackdrop').addEventListener('click', () => setTreeCollapsed(true));

  (function initSplitter() {
    const splitter = $('paneSplitter');
    const workbench = $('workbenchPane');
    let dragging = false;
    splitter.addEventListener('mousedown', (e) => {
      e.preventDefault();
      dragging = true;
      splitter.classList.add('is-dragging');
    });
    global.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const rect = workbench.getBoundingClientRect();
      const w = Math.min(Math.max(e.clientX - rect.left, 150), 460);
      workbench.style.setProperty('--ws-tree-width', `${Math.round(w)}px`);
    });
    global.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      splitter.classList.remove('is-dragging');
    });
  })();

  // ---------- File Tree ----------
  async function fetchDir(dirPath) {
    if (!state.activeRoot) return [];
    const data = await getJson(
      `/api/workspace/tree?root=${encodeURIComponent(state.activeRoot)}&dir=${encodeURIComponent(
        dirPath
      )}&showIgnored=${state.showIgnored ? '1' : '0'}`
    );
    const items = data.items || [];
    state.dirCache.set(dirPath, items);
    return items;
  }

  function makeTreeRow(item, depth, isSearchResult = false) {
    const row = document.createElement('div');
    const activeKey = pathKey(state.activeFile?.path);
    row.className = `ws-tree-row ${item.ignored ? 'is-ignored' : ''} ${
      Boolean(activeKey) && activeKey === pathKey(item.path) ? 'is-active' : ''
    }`;
    row.dataset.path = item.path;
    row.style.paddingLeft = `${8 + depth * 14}px`;
    row.title = item.path;

    const arrow = document.createElement('span');
    arrow.className = 'ws-tree-arrow';
    if (item.isDir && !isSearchResult) {
      arrow.textContent = state.expandedDirs.has(item.path) ? '▾' : '▸';
    }

    const icon = document.createElement('span');
    icon.className = 'ws-tree-icon';
    const isExpanded = Boolean(item.isDir && !isSearchResult && state.expandedDirs.has(item.path));
    icon.innerHTML = getFileIcon(item, { size: 17, expanded: isExpanded });

    const name = document.createElement('span');
    name.className = 'ws-tree-name';
    name.textContent = item.name;

    row.append(arrow, icon, name);

    if (isSearchResult && item.relPath !== item.name) {
      const sub = document.createElement('span');
      sub.className = 'ws-tree-sub';
      sub.textContent = item.relPath;
      row.appendChild(sub);
    }

    if (!item.isDir) {
      const actions = document.createElement('div');
      actions.className = 'ws-tree-row-actions';

      const btnNative = document.createElement('button');
      btnNative.type = 'button';
      btnNative.className = 'ws-tree-mini-btn';
      btnNative.textContent = '原生';
      btnNative.title = '在 Antigravity 原生标签页打开';
      btnNative.addEventListener('click', (e) => {
        e.stopPropagation();
        openInNativeTab(item);
      });

      const btnSend = document.createElement('button');
      btnSend.type = 'button';
      btnSend.className = 'ws-tree-mini-btn';
      btnSend.textContent = '引用';
      btnSend.title = '发送文件路径给 AI';
      btnSend.addEventListener('click', (e) => {
        e.stopPropagation();
        sendFilePathToAgent(item);
      });

      actions.append(btnNative, btnSend);
      row.appendChild(actions);
    }

    row.addEventListener('click', async () => {
      if (item.isDir) {
        if (state.expandedDirs.has(item.path)) {
          state.expandedDirs.delete(item.path);
        } else {
          state.expandedDirs.add(item.path);
          if (!state.dirCache.has(item.path)) {
            await fetchDir(item.path);
          }
        }
        renderTree();
      } else {
        await openFilePreview(item);
        if (global.innerWidth < 520) {
          setTreeCollapsed(true);
        }
      }
    });

    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (item.isDir) return;
      showContextMenu(e.clientX, e.clientY, item);
    });

    return row;
  }

  function renderDirNodes(container, dirPath, depth) {
    const items = state.dirCache.get(dirPath) || [];
    for (const item of items) {
      container.appendChild(makeTreeRow(item, depth, false));
      if (item.isDir && state.expandedDirs.has(item.path)) {
        renderDirNodes(container, item.path, depth + 1);
      }
    }
  }

  async function renderTree() {
    const container = $('treeContainer');
    container.innerHTML = '';

    if (!state.activeRoot) {
      $('treeRootMeta').textContent = '未检测到打开的工作区';
      container.innerHTML =
        '<div class="ws-tree-empty">当前对话未绑定工作区目录；有文件打开时将显示在上方标签栏。</div>';
      return;
    }

    const rootObj = state.roots.find((r) => r.path === state.activeRoot);
    $('treeRootMeta').textContent = `根目录: ${rootObj?.name || state.activeRoot}`;
    $('treeRootMeta').title = state.activeRoot;

    if (state.searchQuery) {
      try {
        const res = await getJson(
          `/api/workspace/search?root=${encodeURIComponent(state.activeRoot)}&q=${encodeURIComponent(
            state.searchQuery
          )}&showIgnored=${state.showIgnored ? '1' : '0'}`
        );
        const items = res.items || [];
        if (!items.length) {
          container.innerHTML = '<div class="ws-tree-empty">没有匹配的文件</div>';
          return;
        }
        for (const item of items) {
          container.appendChild(makeTreeRow(item, 0, true));
        }
        if (res.truncated) {
          const note = document.createElement('div');
          note.className = 'ws-tree-empty';
          note.textContent = `已显示前 ${items.length} 条匹配（共扫描 ${res.scanned} 项）`;
          container.appendChild(note);
        }
      } catch (err) {
        container.innerHTML = `<div class="ws-tree-empty">搜索失败: ${err.message}</div>`;
      }
      return;
    }

    if (!state.dirCache.has(state.activeRoot)) {
      await fetchDir(state.activeRoot);
    }
    const rootItems = state.dirCache.get(state.activeRoot) || [];
    if (!rootItems.length) {
      container.innerHTML = '<div class="ws-tree-empty">目录为空</div>';
      return;
    }
    renderDirNodes(container, state.activeRoot, 0);
    renderWelcomeRecents(rootItems);
  }

  function renderWelcomeRecents(rootItems) {
    const wrap = $('welcomeRecentDocs');
    if (!wrap || state.activeFile) return;
    const docs = rootItems.filter(
      (i) => !i.isDir && ['docx', 'xlsx', 'pptx', 'pdf', 'markdown'].includes(i.category)
    );
    wrap.innerHTML = '';
    for (const doc of docs.slice(0, 6)) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ws-doc-pill';
      const ic = document.createElement('span');
      ic.className = 'ws-pill-icon';
      ic.innerHTML = getFileIcon(doc, { size: 15 });
      const lbl = document.createElement('span');
      lbl.className = 'ws-doc-pill-name';
      lbl.textContent = doc.name;
      btn.append(ic, lbl);
      btn.addEventListener('click', () => openFilePreview(doc));
      wrap.appendChild(btn);
    }
  }

  async function reloadExpandedDirs() {
    if (!state.activeRoot) return;
    const dirs = [state.activeRoot, ...Array.from(state.expandedDirs)];
    state.dirCache.clear();
    for (const d of dirs) {
      try {
        await fetchDir(d);
      } catch {
        state.expandedDirs.delete(d);
      }
    }
    await renderTree();
  }

  let searchDebounce = null;
  $('treeSearchInput').addEventListener('input', (e) => {
    state.searchQuery = e.target.value.trim();
    $('treeSearchClearBtn').classList.toggle('is-hidden', !state.searchQuery);
    if (searchDebounce) clearTimeout(searchDebounce);
    searchDebounce = setTimeout(renderTree, 180);
  });
  $('treeSearchClearBtn').addEventListener('click', () => {
    $('treeSearchInput').value = '';
    state.searchQuery = '';
    $('treeSearchClearBtn').classList.add('is-hidden');
    renderTree();
  });
  $('toggleIgnoredBtn').addEventListener('click', () => {
    state.showIgnored = !state.showIgnored;
    $('toggleIgnoredBtn').classList.toggle('is-active', state.showIgnored);
    reloadExpandedDirs();
  });
  $('refreshTreeBtn').addEventListener('click', reloadExpandedDirs);

  // ---------- Context Menu & File Actions ----------
  function showContextMenu(x, y, item) {
    state.contextTarget = item;
    $('tabContextMenu')?.classList.add('is-hidden');
    closeOpenTabsPopover();
    closeStagedPopover();
    const menu = $('treeContextMenu');
    menu.classList.remove('is-hidden');
    const maxX = global.innerWidth - 205;
    const maxY = global.innerHeight - 175;
    menu.style.left = `${Math.max(6, Math.min(x, maxX))}px`;
    menu.style.top = `${Math.max(6, Math.min(y, maxY))}px`;
  }

  document.addEventListener('click', (e) => {
    $('treeContextMenu').classList.add('is-hidden');
    $('tabContextMenu')?.classList.add('is-hidden');
    if (!e.target.closest('#openTabsPopover, #openTabsPickerBtn')) {
      closeOpenTabsPopover();
    }
    if (state.stagedPopoverOpen) {
      const path = e.composedPath();
      if (!path.includes($('stagedCommentsPopover')) && !path.includes($('stagedCommentsBtn'))) {
        closeStagedPopover();
      }
    }
  });

  $('treeContextMenu').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn || !state.contextTarget) return;
    const item = state.contextTarget;
    const act = btn.dataset.action;
    if (act === 'preview') {
      await openFilePreview(item);
    } else if (act === 'native') {
      openInNativeTab(item);
    } else if (act === 'copy-rel') {
      await copyText(item.relPath || item.name, '已复制相对路径');
    } else if (act === 'copy-abs') {
      await copyText(item.path, '已复制绝对路径');
    } else if (act === 'send-path') {
      await sendFilePathToAgent(item);
    }
  });

  async function copyText(txt, toastLabel) {
    try {
      await navigator.clipboard.writeText(txt);
      showToast(toastLabel);
    } catch {
      showToast('剪贴板写入受限');
    }
  }

  function openInNativeTab(file) {
    if (!file?.uri) return;
    if (global.sidecar?.ui?.toggleAuxPane) {
      global.sidecar.ui.toggleAuxPane({ tabType: 'fileView', uri: file.uri });
      showToast(`已请求原生打开 ${file.name}`);
    } else {
      showToast('当前独立浏览器模式不支持原生标签页打开');
    }
  }

  async function sendToAgent(message) {
    try {
      let result;
      if (global.sidecar?.agent?.sendMessage && state.conversationId) {
        result = await global.sidecar.agent.sendMessage(message, state.conversationId);
      } else {
        result = await postJson('/api/agent/send', {
          message,
          conversationId: state.conversationId,
        });
        if (result?.success === true) result = result.result;
      }
      if (result === false || result?.success === false) {
        throw new Error(result?.error || result?.message || '宿主未确认发送');
      }
      showToast('已发送给当前对话');
      return true;
    } catch (err) {
      showToast(`发送失败: ${err?.message || String(err)}`);
      return false;
    }
  }

  async function sendFilePathToAgent(file) {
    const loc = file.relPath || file.path;
    await sendToAgent(`请查看文件 \`${loc}\`（路径：\`${file.path}\`）`);
  }

  function pathKey(p) {
    const raw = String(p || '');
    const isWin = /^[a-zA-Z]:[\\/]|^\\\\/.test(raw) || raw.includes('\\');
    const norm = raw.replace(/\\/g, '/');
    return isWin ? norm.toLowerCase() : norm;
  }

  function isPathDismissed(doc) {
    const dismissedMtime = state.dismissedPaths.get(pathKey(doc?.path));
    if (dismissedMtime === undefined) return false;
    return Math.floor(doc?.mtimeMs || 0) <= dismissedMtime;
  }

  function upsertOpenTab(file) {
    if (!file?.path) return;
    const key = pathKey(file.path);
    const idx = state.openTabs.findIndex((t) => pathKey(t.path) === key);
    if (idx >= 0) {
      state.openTabs[idx] = { ...state.openTabs[idx], ...file };
    } else {
      state.openTabs.push({ ...file });
    }
  }

  async function confirmDiscardIfDirty() {
    const ctrl = state.activeController;
    if (!ctrl?.isDirty?.()) return true;
    if (ctrl.flushSave && ctrl.isAutoSave?.()) {
      try {
        await ctrl.flushSave({ silent: true });
      } catch {}
    }
    if (!ctrl.isDirty?.()) return true;
    return global.confirm('当前文件有未保存的修改，确定放弃修改并继续吗？');
  }

  // ---------- Document Preview Engine ----------
  async function openFilePreview(file, { preserveState = false, skipDirtyCheck = false } = {}) {
    if (!file?.path) return;

    if (!skipDirtyCheck && state.activeController?.isDirty?.()) {
      const ok = await confirmDiscardIfDirty();
      if (!ok) return;
    }

    const openSeq = ++state.previewOpenSeq;

    state.dismissedPaths.delete(pathKey(file.path));
    state.hasUserClosedAll = false;
    upsertOpenTab(file);

    const prevState =
      preserveState && state.activeFile && pathKey(state.activeFile.path) === pathKey(file.path) && state.activeController?.getState
        ? state.activeController.getState()
        : null;

    if (state.activeController?.destroy) {
      try {
        state.activeController.destroy();
      } catch {}
      state.activeController = null;
    }
    if (state.activeCleanup) {
      try {
        state.activeCleanup();
      } catch {}
      state.activeCleanup = null;
    }

    const cleanups = [];
    let cleanedUp = false;
    const runCleanups = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      while (cleanups.length) {
        try {
          cleanups.pop()();
        } catch {}
      }
    };
    state.activeCleanup = runCleanups;

    if (!file.mtimeMs || !file.version) {
      try {
        const stData = await getJson(
          `/api/file/stat?path=${encodeURIComponent(file.path)}&conversationId=${encodeURIComponent(
            state.conversationId || ''
          )}&workspaceGen=${encodeURIComponent(String(state.workspaceGen))}`
        );
        if (openSeq !== state.previewOpenSeq) {
          runCleanups();
          return;
        }
        if (stData?.success && stData.exists) {
          file.mtimeMs = stData.mtimeMs;
          file.size = stData.size;
          file.version = stData.version || '';
          upsertOpenTab(file);
        }
      } catch {
        if (openSeq !== state.previewOpenSeq) {
          runCleanups();
          return;
        }
      }
    }

    state.activeFile = file;
    state.activeFileSig = file.version || `${Math.floor(file.mtimeMs || 0)}:${file.size || 0}`;

    $('previewHeader').classList.remove('is-hidden');
    $('previewFileIcon').innerHTML = getFileIcon(file, { size: 22 });
    $('previewFileName').textContent = file.name;
    $('previewFilePath').textContent = file.relPath || file.path;
    $('previewFilePath').title = file.path;

    const badge = $('previewEngineBadge');
    badge.classList.add('is-hidden');
    badge.textContent = '';

    const subtoolbar = $('previewSubtoolbar');
    subtoolbar.classList.add('is-hidden');
    subtoolbar.innerHTML = '';

    const stage = $('previewStage');
    stage.innerHTML = '<div class="ws-empty-welcome"><p>正在加载预览...</p></div>';

    const activeTreeKey = pathKey(file.path);
    for (const row of document.querySelectorAll('.ws-tree-row')) {
      row.classList.toggle('is-active', Boolean(activeTreeKey) && pathKey(row.dataset.path) === activeTreeKey);
    }
    renderProducedStrip();
    // 切换文件后自动把当前激活标签滚动到可视区，避免标签过多时看不到当前项
    const activePill = $('producedList')?.querySelector('.ws-doc-pill.is-active');
    activePill?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });

    const saveFile = async ({
      content,
      encoding = 'utf8',
      baseVersion = null,
      baseMtimeMs = null,
      force = false,
      expectedConflictMtimeMs = null,
      expectedConflictVersion = '',
      silent = false,
    } = {}) => {
      try {
        const activeMatches =
          state.activeFile && pathKey(state.activeFile.path) === pathKey(file.path);
        const currentMtime = activeMatches ? state.activeFile.mtimeMs : file.mtimeMs;
        const currentVersion = activeMatches
          ? state.activeFile.version || file.version || ''
          : file.version || '';
        const payload = {
          path: file.path,
          conversationId: state.conversationId,
          workspaceGen: state.workspaceGen,
          content,
          encoding,
          baseMtimeMs: baseMtimeMs ?? currentMtime,
          baseVersion: baseVersion ?? currentVersion,
          force,
        };
        if (force) {
          if (expectedConflictMtimeMs != null) {
            payload.expectedConflictMtimeMs = expectedConflictMtimeMs;
          }
          if (expectedConflictVersion) {
            payload.expectedConflictVersion = expectedConflictVersion;
          }
        }
        const res = await apiFetch('/api/file/save', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        let resData = null;
        try {
          resData = await res.json();
        } catch {}

        if (res.status === 409 && !force) {
          const conflictMtime = resData?.currentMtimeMs ?? null;
          const conflictVersion = resData?.currentVersion || '';
          const ok = global.confirm(
            '该文件在编辑期间已被外部或 AI 更新，是否仍用当前修改覆盖保存？'
          );
          if (ok) {
            return saveFile({
              content,
              encoding,
              baseVersion,
              baseMtimeMs,
              force: true,
              expectedConflictMtimeMs: conflictMtime,
              expectedConflictVersion: conflictVersion,
              silent,
            });
          }
          return { success: false, cancelled: true };
        }

        if (!res.ok || !resData?.success) {
          const errMsg = resData?.error || `HTTP ${res.status}`;
          showToast(`保存失败: ${errMsg}`, 2800);
          return { success: false, error: errMsg };
        }

        file.mtimeMs = resData.mtimeMs;
        file.size = resData.size;
        file.version = resData.version || '';
        if (state.activeFile && pathKey(state.activeFile.path) === pathKey(file.path)) {
          state.activeFile.mtimeMs = resData.mtimeMs;
          state.activeFile.size = resData.size;
          state.activeFile.version = resData.version || '';
          state.activeFileSig =
            resData.version || `${Math.floor(resData.mtimeMs || 0)}:${resData.size || 0}`;
          upsertOpenTab(state.activeFile);
        }
        if (!silent) {
          showToast(`已保存：${file.name}`, 1600);
        }
        return resData;
      } catch (err) {
        const msg = err?.message || String(err);
        showToast(`保存失败: ${msg}`, 2800);
        return { success: false, error: msg };
      }
    };

    const saveAsFile = async ({
      sourcePath = file.path, fileName, content, overwrite = false, autoRename = true,
    } = {}) => {
      try {
        const res = await apiFetch('/api/file/save-as', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sourcePath, fileName, content, encoding: 'base64', overwrite, autoRename,
            conversationId: state.conversationId,
            workspaceGen: state.workspaceGen,
          }),
        });
        const result = await res.json().catch(() => null);
        if (!res.ok || !result?.success) {
          const error = result?.error || 'HTTP ' + res.status;
          showToast('另存失败：' + error, 2800);
          return { success: false, error, status: res.status };
        }
        await reloadExpandedDirs().catch(() => {});
        return result;
      } catch (err) {
        const error = err?.message || String(err);
        showToast('另存失败：' + error, 2800);
        return { success: false, error };
      }
    };

    const ctx = {
      file,
      stageEl: stage,
      toolbarEl: subtoolbar,
      capabilities: state.capabilities,
      conversationId: state.conversationId,
      getWorkspaceGen: () => state.workspaceGen,
      prevState,
      showToast,
      isStale: () => openSeq !== state.previewOpenSeq,
      registerCleanup: (fn) => {
        if (typeof fn !== 'function') return;
        if (cleanedUp || openSeq !== state.previewOpenSeq) {
          try {
            fn();
          } catch {}
          return;
        }
        cleanups.push(fn);
      },
      onSaveFile: saveFile,
      onSaveAsFile: saveAsFile,
      onSendToAgent: sendToAgent,
      onStatusBadge: (label) => {
        if (openSeq !== state.previewOpenSeq) return;
        if (label) {
          badge.textContent = label;
          badge.classList.remove('is-hidden');
        } else {
          badge.classList.add('is-hidden');
        }
      },
      onQuoteRequest: ({ text, locationLabel }) => {
        openQuoteModal({ text, locationLabel });
      },
    };

    try {
      let ctrl = null;
      if (file.category === 'docx') {
        ctrl = await renderDocxPreview(ctx);
      } else if (file.category === 'xlsx') {
        ctrl = await renderXlsxPreview(ctx);
      } else if (file.category === 'pptx') {
        ctrl = await renderPptxPreview(ctx);
      } else if (file.category === 'pdf') {
        ctrl = await renderPdfPreview(ctx);
      } else if (file.category === 'image' && typeof renderImagePreview === 'function') {
        ctrl = await renderImagePreview(ctx);
      } else {
        ctrl = await renderTextOrImagePreview(ctx);
      }

      if (openSeq !== state.previewOpenSeq) {
        try {
          ctrl?.destroy?.();
        } catch {}
        runCleanups();
        return;
      }
      state.activeController = ctrl;
    } catch (err) {
      runCleanups();
      if (openSeq !== state.previewOpenSeq) return;
      const warnIcon = WSIcons?.render ? WSIcons.render('ui-warn', { size: 36 }) : '';
      stage.innerHTML = `<div class="ws-empty-welcome">
        <div class="ws-empty-hero" style="color:var(--ws-warn);">${warnIcon}</div>
        <h3>文档预览失败</h3>
        <p>${String(err?.message || err).replace(/</g, '&lt;')}</p>
      </div>`;
    }
  }

  $('previewRefreshBtn').addEventListener('click', () => {
    if (state.activeFile) openFilePreview(state.activeFile, { preserveState: true });
  });
  $('previewLocateTreeBtn')?.addEventListener('click', () => {
    if (state.activeFile) revealFileInTree(state.activeFile);
  });
  $('previewOpenNativeBtn').addEventListener('click', () => openInNativeTab(state.activeFile));
  $('previewSendPathBtn').addEventListener('click', () => {
    if (state.activeFile) sendFilePathToAgent(state.activeFile);
  });

  // ---------- 在工作区文件树中展开并高亮定位目标文件 ----------
  function stripTrailingSlashes(p) {
    return String(p || '').replace(/[\\/]+$/, '');
  }

  function findContainingRoot(filePath) {
    const fk = stripTrailingSlashes(pathKey(filePath));
    if (!fk) return null;
    let best = null;
    for (const r of state.roots) {
      const rk = stripTrailingSlashes(pathKey(r.path));
      if (!rk) continue;
      if (fk === rk || fk.startsWith(`${rk}/`)) {
        if (!best || rk.length > stripTrailingSlashes(pathKey(best.path)).length) {
          best = r;
        }
      }
    }
    return best;
  }

  async function revealFileInTree(file) {
    const targetKey = pathKey(file?.path);
    if (!targetKey) return;

    switchMode('workbench');
    setTreeCollapsed(false);

    const matchedRoot = findContainingRoot(file.path);
    if (!matchedRoot) {
      showToast('该文件不在当前工作区目录树中');
      return;
    }

    if (pathKey(matchedRoot.path) !== pathKey(state.activeRoot)) {
      state.activeRoot = matchedRoot.path;
      const sel = $('rootSelector');
      if (sel) sel.value = matchedRoot.path;
      state.expandedDirs.clear();
      state.dirCache.clear();
      state.watchRev = 0;
    }

    if (state.searchQuery) {
      $('treeSearchInput').value = '';
      state.searchQuery = '';
      $('treeSearchClearBtn')?.classList.add('is-hidden');
    }

    const rootSlash = stripTrailingSlashes(matchedRoot.path).replace(/\\/g, '/');
    const fileSlash = String(file.path || '').replace(/\\/g, '/');
    const relPart = fileSlash.slice(rootSlash.length).replace(/^\/+/, '');
    const segments = relPart.split('/').filter(Boolean);
    if (!segments.length) return;

    const dirSegments = segments.slice(0, -1);
    const targetFileName = segments[segments.length - 1];
    const isWinPath = /^[a-zA-Z]:[\\/]|^\\\\/.test(matchedRoot.path);
    const segKey = (s) => (isWinPath ? String(s || '').toLowerCase() : String(s || ''));

    // 逐级展开目标文件所在的所有父目录；遇到被忽略目录隐藏时自动放开一次重试
    let retriedWithIgnored = false;
    while (true) {
      let currentDir = state.activeRoot;
      if (!state.dirCache.has(currentDir)) {
        await fetchDir(currentDir);
      }
      let missingPotentiallyIgnored = false;
      for (const seg of dirSegments) {
        const children = state.dirCache.get(currentDir) || [];
        const dirItem = children.find((it) => it.isDir && segKey(it.name) === segKey(seg));
        if (!dirItem) {
          missingPotentiallyIgnored = true;
          break;
        }
        state.expandedDirs.add(dirItem.path);
        currentDir = dirItem.path;
        if (!state.dirCache.has(currentDir)) {
          await fetchDir(currentDir);
        }
      }
      if (!missingPotentiallyIgnored) {
        const finalItems = state.dirCache.get(currentDir) || [];
        const fileFound = finalItems.some(
          (it) => pathKey(it.path) === targetKey || (!it.isDir && segKey(it.name) === segKey(targetFileName))
        );
        if (!fileFound) missingPotentiallyIgnored = true;
      }
      if (missingPotentiallyIgnored && !state.showIgnored && !retriedWithIgnored) {
        retriedWithIgnored = true;
        state.showIgnored = true;
        $('toggleIgnoredBtn')?.classList.add('is-active');
        state.dirCache.clear();
        continue;
      }
      break;
    }

    await renderTree();
    const targetRow = Array.from($('treeContainer').querySelectorAll('.ws-tree-row')).find(
      (r) => pathKey(r.dataset.path) === targetKey
    );
    if (!targetRow) {
      showToast('未在工作区目录树中找到该文件');
      return;
    }
    targetRow.scrollIntoView({ block: 'center', behavior: 'smooth' });
    targetRow.classList.remove('is-located-flash');
    void targetRow.offsetWidth;
    targetRow.classList.add('is-located-flash');
    setTimeout(() => targetRow.classList.remove('is-located-flash'), 1600);
    showToast(`已在文件树中定位：${file.name}`, 1800);
  }

  // ---------- Quote Selection & Composer ----------
  const quoteFab = $('quoteFab');
  let selectedQuoteText = '';

  function checkPreviewSelection() {
    const ae = document.activeElement;
    if (ae && (ae.tagName === 'TEXTAREA' || ae.tagName === 'INPUT' || ae.isContentEditable)) {
      quoteFab.classList.add('is-hidden');
      return;
    }
    const stage = $('previewStage');
    const sel = global.getSelection();
    if (!sel || sel.isCollapsed || !state.activeFile) {
      quoteFab.classList.add('is-hidden');
      return;
    }
    const text = sel.toString().trim();
    if (!text || !stage.contains(sel.anchorNode)) {
      quoteFab.classList.add('is-hidden');
      return;
    }
    selectedQuoteText = text.slice(0, 3000);
    try {
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      const x = Math.min(Math.max(rect.left + rect.width / 2 - 55, 10), global.innerWidth - 130);
      const y = Math.max(rect.top - 36, 46);
      quoteFab.style.left = `${x}px`;
      quoteFab.style.top = `${y}px`;
      quoteFab.classList.remove('is-hidden');
    } catch {
      quoteFab.classList.add('is-hidden');
    }
  }

  document.addEventListener('mouseup', () => setTimeout(checkPreviewSelection, 10));
  document.addEventListener('keyup', () => setTimeout(checkPreviewSelection, 10));

  function openQuoteModal({ text, locationLabel = '' }) {
    if (!state.activeFile || !text) return;
    closeStagedPopover();
    quoteFab.classList.add('is-hidden');
    state.pendingQuote = { file: state.activeFile, text, locationLabel };
    const loc = locationLabel ? ` (${locationLabel})` : '';
    $('quoteSourceMeta').textContent = `来源：${state.activeFile.relPath || state.activeFile.name}${loc}`;
    $('quoteExcerptBox').textContent = text;
    $('quoteCommentInput').value = '';
    $('quoteModal').classList.remove('is-hidden');
    $('quoteCommentInput').focus();
  }

  $('quoteFabBtn').addEventListener('click', () => {
    if (selectedQuoteText) openQuoteModal({ text: selectedQuoteText });
  });

  $('quoteModalClose').addEventListener('click', () => $('quoteModal').classList.add('is-hidden'));
  $('quoteModal').addEventListener('click', (e) => {
    if (e.target === $('quoteModal')) $('quoteModal').classList.add('is-hidden');
  });

  $('quoteSendBtn').addEventListener('click', async () => {
    const q = state.pendingQuote;
    if (!q) return;
    const comment = $('quoteCommentInput').value.trim();
    const loc = q.locationLabel ? ` [${q.locationLabel}]` : '';
    const pathLabel = q.file.relPath || q.file.path;
    const quotedBlock = q.text
      .split('\n')
      .map((l) => `> ${l}`)
      .join('\n');
    const message = `引用文档 \`${pathLabel}\`${loc}：\n${quotedBlock}${
      comment ? `\n\n修改/处理意见：${comment}` : '\n\n请针对以上内容提供分析或修改建议。'
    }`;

    $('quoteModal').classList.add('is-hidden');
    await sendToAgent(message);
  });

  // ---------- Staged Document Comments ----------
  function getStagedStorageKey() {
    return `${STAGED_STORAGE_PREFIX}${state.conversationId || 'default'}`;
  }

  function normalizeStagedItem(raw) {
    if (!raw || typeof raw !== 'object' || typeof raw.text !== 'string' || !raw.text.trim()) return null;

    const file = raw.file && typeof raw.file === 'object' ? raw.file : {};
    const asString = (value) => typeof value === 'string' ? value : '';
    const createdAt = Number.isFinite(raw.createdAt) && raw.createdAt > 0 ? raw.createdAt : Date.now();
    const id = asString(raw.id).trim() || global.crypto?.randomUUID?.() ||
      `${createdAt}-${Math.random().toString(36).slice(2)}`;
    const uri = asString(file.uri);
    return {
      id,
      createdAt,
      file: {
        name: asString(file.name),
        path: asString(file.path),
        relPath: asString(file.relPath),
        ext: asString(file.ext),
        category: asString(file.category),
        uri: /^file:\/\//i.test(uri) ? uri : '',
      },
      locationLabel: asString(raw.locationLabel),
      text: raw.text,
      comment: asString(raw.comment),
    };
  }

  function loadStagedComments() {
    const key = getStagedStorageKey();
    if (key === state.stagedStorageKeyLoaded) return;
    const defaultKey = `${STAGED_STORAGE_PREFIX}default`;
    const fallbackItems = state.stagedStorageKeyLoaded === defaultKey ? state.stagedComments : [];
    let items = [];
    try {
      const stored = JSON.parse(global.localStorage.getItem(key));
      if (Array.isArray(stored)) {
        items = stored.map(normalizeStagedItem).filter(Boolean).slice(0, MAX_STAGED_COMMENTS);
      }
    } catch {}

    state.stagedComments = items;
    state.stagedStorageKeyLoaded = key;
    if (fallbackItems.length) {
      const loadedIds = new Set(items.map((item) => item.id));
      const pending = fallbackItems.filter((item) => !loadedIds.has(item.id));
      const available = MAX_STAGED_COMMENTS - items.length;
      const remaining = pending.slice(available);
      items.push(...pending.slice(0, available));
      // Keep the fallback copy until the conversation queue has been saved.
      if (saveStagedComments() && saveStagedComments(remaining, defaultKey) && remaining.length) {
        showToast(`当前对话已暂存 ${MAX_STAGED_COMMENTS} 条，另有 ${remaining.length} 条保留在默认暂存篮`);
      }
    }
    renderStagedCommentsUi();
  }

  function saveStagedComments(items = state.stagedComments, key = getStagedStorageKey()) {
    try {
      if (items.length) global.localStorage.setItem(key, JSON.stringify(items));
      else global.localStorage.removeItem(key);
      return true;
    } catch {
      return false;
    }
  }

  function formatStagedCommentsMessage(items, overallNote = '') {
    const header = `请处理以下 ${items.length} 条文档批注：`;
    const note = overallNote.trim();
    const noteLine = note ? `\n整体要求：${note}` : '';
    const blocks = items.map((item, idx) => {
      const pathLabel = item.file.relPath || item.file.path || item.file.name || '未知文档';
      const loc = item.locationLabel ? ` [${item.locationLabel}]` : '';
      const quoted = item.text.split(/\r?\n/).map((line) => `> ${line}`).join('\n');
      const comment = item.comment.trim() || '请参考此引用片段';
      return `### ${idx + 1}. \`${pathLabel}\`${loc}\n${quoted}\n- 批注：${comment}`;
    });
    return `${header}${noteLine}\n\n${blocks.join('\n\n')}`;
  }

  let stagedClearArmed = false;
  let stagedClearConfirmTimer = null;

  function resetStagedClearConfirm() {
    if (stagedClearConfirmTimer) {
      clearTimeout(stagedClearConfirmTimer);
      stagedClearConfirmTimer = null;
    }
    stagedClearArmed = false;
    const clearBtn = $('stagedCommentsClearBtn');
    if (clearBtn) {
      clearBtn.textContent = '清空';
      clearBtn.classList.remove('is-confirming');
    }
  }

  function renderStagedCommentsUi() {
    const n = state.stagedComments.length;
    if (n <= 1) resetStagedClearConfirm();
    const btn = $('stagedCommentsBtn');
    btn.classList.toggle('is-hidden', n === 0);
    btn.setAttribute('aria-label', `待发批注（${n} 条）`);
    $('stagedCommentsCount').textContent = String(n);
    $('stagedCommentsTitleCount').textContent = String(n);
    $('stagedCommentsSendText').textContent = n > 0 ? `合并发给 AI (${n})` : '合并发给 AI';
    $('stagedCommentsClearBtn').disabled = n === 0;
    $('stagedCommentsCopyBtn').disabled = n === 0;
    $('stagedCommentsSendBtn').disabled = n === 0 || state.stagedSending;

    const list = $('stagedCommentsList');
    list.replaceChildren();
    if (n === 0) {
      const empty = document.createElement('p');
      empty.className = 'ws-staged-empty';
      empty.textContent = '暂无待发批注，请在预览区划词或选表后点击「暂存为批注」。';
      list.appendChild(empty);
      return;
    }

    state.stagedComments.forEach((item, index) => {
      const card = document.createElement('div');
      card.className = 'ws-staged-card';
      const head = document.createElement('div');
      head.className = 'ws-staged-card-head';
      const number = document.createElement('span');
      number.className = 'ws-staged-index';
      number.textContent = `#${index + 1}`;

      const source = document.createElement('button');
      source.className = 'ws-staged-source';
      source.type = 'button';
      const location = item.locationLabel ? ` (${item.locationLabel})` : '';
      source.textContent = `${item.file.relPath || item.file.name || '文档'}${location}`;
      source.title = source.textContent;
      source.disabled = !item.file.path;
      source.addEventListener('click', () => {
        closeStagedPopover();
        if (state.mode !== 'workbench') switchMode('workbench');
        openFilePreview({ ...item.file });
      });

      const remove = document.createElement('button');
      remove.className = 'ws-staged-delete';
      remove.type = 'button';
      remove.textContent = '×';
      remove.setAttribute('aria-label', '删除此条批注');
      remove.addEventListener('click', () => {
        state.stagedComments = state.stagedComments.filter((entry) => entry.id !== item.id);
        saveStagedComments();
        renderStagedCommentsUi();
        if (!state.stagedComments.length) closeStagedPopover();
      });
      head.append(number, source, remove);

      const excerpt = document.createElement('pre');
      excerpt.className = 'ws-staged-excerpt';
      excerpt.textContent = item.text;
      const input = document.createElement('textarea');
      input.className = 'ws-staged-comment-input';
      input.rows = 2;
      input.value = item.comment;
      input.setAttribute('aria-label', `第 ${index + 1} 条批注`);
      input.addEventListener('input', () => {
        item.comment = input.value;
        saveStagedComments();
      });
      card.append(head, excerpt, input);
      list.appendChild(card);
    });
  }

  function openStagedPopover() {
    if (!state.stagedComments.length) return;
    closeOpenTabsPopover();
    $('treeContextMenu').classList.add('is-hidden');
    $('tabContextMenu')?.classList.add('is-hidden');
    state.stagedPopoverOpen = true;
    $('stagedCommentsPopover').classList.remove('is-hidden');
    const btn = $('stagedCommentsBtn');
    btn.setAttribute('aria-expanded', 'true');
    btn.classList.add('is-active');
    $('stagedCommentsCloseBtn').focus();
  }

  function closeStagedPopover({ restoreFocus = false } = {}) {
    resetStagedClearConfirm();
    if (!state.stagedPopoverOpen) return;
    state.stagedPopoverOpen = false;
    $('stagedCommentsPopover').classList.add('is-hidden');
    const btn = $('stagedCommentsBtn');
    btn.setAttribute('aria-expanded', 'false');
    btn.classList.remove('is-active');
    if (restoreFocus && !btn.classList.contains('is-hidden')) btn.focus();
  }

  $('quoteCommentBtn').addEventListener('click', () => {
    const q = state.pendingQuote;
    if (!q) return;
    if (state.stagedComments.length >= MAX_STAGED_COMMENTS) {
      showToast(`最多暂存 ${MAX_STAGED_COMMENTS} 条批注，请先发送或清理后再添加`);
      return;
    }
    const comment = $('quoteCommentInput').value.trim() || '请参考此引用片段';
    const item = normalizeStagedItem({ ...q, comment });
    if (!item) {
      showToast('请选择要引用的文档内容');
      return;
    }
    state.stagedComments.push(item);
    saveStagedComments();
    state.pendingQuote = null;
    $('quoteModal').classList.add('is-hidden');
    renderStagedCommentsUi();
    const btn = $('stagedCommentsBtn');
    btn.classList.remove('is-pulse');
    void btn.offsetWidth;
    btn.classList.add('is-pulse');
    btn.focus();
    showToast(`已暂存第 ${state.stagedComments.length} 条批注（点击右上角「待发批注」查看或合并发送）`);
  });

  $('stagedCommentsBtn').addEventListener('click', () => {
    if (state.stagedPopoverOpen) closeStagedPopover({ restoreFocus: true });
    else openStagedPopover();
  });
  $('stagedCommentsCloseBtn').addEventListener('click', () => closeStagedPopover({ restoreFocus: true }));

  $('stagedCommentsClearBtn').addEventListener('click', () => {
    const n = state.stagedComments.length;
    if (!n) return;
    if (n > 1 && !stagedClearArmed) {
      stagedClearArmed = true;
      const clearBtn = $('stagedCommentsClearBtn');
      clearBtn.textContent = '确认清空?';
      clearBtn.classList.add('is-confirming');
      stagedClearConfirmTimer = setTimeout(resetStagedClearConfirm, 3000);
      return;
    }
    resetStagedClearConfirm();
    state.stagedComments = [];
    saveStagedComments();
    renderStagedCommentsUi();
    closeStagedPopover();
    showToast('已清空待发批注');
  });

  $('stagedCommentsCopyBtn').addEventListener('click', () => {
    if (!state.stagedComments.length) return;
    const message = formatStagedCommentsMessage(state.stagedComments, $('stagedCommentsNote').value);
    return copyText(message, '已复制全部批注到剪贴板');
  });

  $('stagedCommentsSendBtn').addEventListener('click', async (e) => {
    if (!state.stagedComments.length || state.stagedSending) return;
    const btn = e.currentTarget;
    const noteInput = $('stagedCommentsNote');
    const note = noteInput.value;
    const message = formatStagedCommentsMessage(state.stagedComments, note);
    const sentComments = new Map(state.stagedComments.map((item) => [item.id, item.comment]));
    state.stagedSending = true;
    btn.disabled = true;
    const ok = await sendToAgent(message);
    state.stagedSending = false;
    if (!ok) {
      btn.disabled = state.stagedComments.length === 0;
      return;
    }

    // Preserve comments added or edited while the send was in flight.
    state.stagedComments = state.stagedComments.filter((item) => sentComments.get(item.id) !== item.comment);
    if (noteInput.value === note) noteInput.value = '';
    saveStagedComments();
    renderStagedCommentsUi();
    closeStagedPopover();
  });

  // ---------- Open Documents Tab Strip & Polling ----------
  function getVisibleTabDocs() {
    const filteredProduced = state.producedOnlyDocs
      ? state.producedDocs.filter((d) => d.isDoc)
      : state.producedDocs;
    const producedByKey = new Map();
    for (const d of filteredProduced) {
      producedByKey.set(pathKey(d.path), d);
    }

    const merged = [];
    const seenKeys = new Set();

    for (const tab of state.openTabs) {
      const k = pathKey(tab.path);
      if (seenKeys.has(k) || isPathDismissed(tab)) continue;
      const latestProduced = producedByKey.get(k);
      const item = latestProduced
        ? {
            ...latestProduced,
            ...tab,
            mtimeMs: Math.max(tab.mtimeMs || 0, latestProduced.mtimeMs || 0),
            size: latestProduced.size ?? tab.size,
          }
        : tab;
      seenKeys.add(k);
      merged.push(item);
    }

    for (const doc of filteredProduced) {
      const k = pathKey(doc.path);
      if (seenKeys.has(k) || isPathDismissed(doc)) continue;
      seenKeys.add(k);
      merged.push(doc);
    }

    return merged;
  }

  function closePreviewToEmpty() {
    ++state.previewOpenSeq;
    if (state.activeController?.destroy) {
      try {
        state.activeController.destroy();
      } catch {}
      state.activeController = null;
    }
    if (state.activeCleanup) {
      try {
        state.activeCleanup();
      } catch {}
      state.activeCleanup = null;
    }
    state.activeFile = null;
    state.activeFileSig = '';
    state.hasUserClosedAll = true;

    $('previewHeader').classList.add('is-hidden');
    $('previewEngineBadge').classList.add('is-hidden');
    $('previewEngineBadge').textContent = '';
    $('previewSubtoolbar').classList.add('is-hidden');
    $('previewSubtoolbar').innerHTML = '';
    $('quoteFab')?.classList.add('is-hidden');

    for (const row of document.querySelectorAll('.ws-tree-row')) {
      row.classList.remove('is-active');
    }

    const stage = $('previewStage');
    stage.innerHTML = `
      <div id="previewEmptyState" class="ws-empty-welcome">
        <div class="ws-empty-hero" data-ws-icon="hero-workspace" data-size="52"></div>
        <h3>Sidecar Studio 三合一工作台</h3>
        <p>从左侧文件树或上方文档标签栏点击任意文件即可实时高保真预览：<br>Word (<code>.docx</code>) · Excel (<code>.xlsx/.xls/.csv</code>) · PPT (<code>.pptx</code>) · PDF · Markdown · 图片 · 代码</p>
        <div id="welcomeRecentDocs" class="ws-welcome-recents"></div>
      </div>
    `;
    if (global.WSIcons?.hydrate) {
      global.WSIcons.hydrate($('previewEmptyState'));
    }
    const rootItems = state.activeRoot ? state.dirCache.get(state.activeRoot) || [] : [];
    renderWelcomeRecents(rootItems);
  }

  function getDismissMtime(doc) {
    const key = pathKey(doc?.path);
    const matchingProduced = key
      ? state.producedDocs.find((p) => pathKey(p.path) === key)
      : null;
    const mtime = Math.max(
      Math.floor(doc?.mtimeMs || 0),
      Math.floor(matchingProduced?.mtimeMs || 0)
    );
    return mtime > 0 ? mtime : Math.floor(Date.now());
  }

  async function closeTab(doc) {
    if (!doc?.path) return;
    const key = pathKey(doc.path);
    const visibleBefore = getVisibleTabDocs();
    const closedIdx = visibleBefore.findIndex((d) => pathKey(d.path) === key);
    const wasActive = pathKey(state.activeFile?.path) === key;

    if (wasActive && state.activeController?.isDirty?.()) {
      const ok = await confirmDiscardIfDirty();
      if (!ok) return;
    }

    state.dismissedPaths.set(key, getDismissMtime(doc));
    state.openTabs = state.openTabs.filter((t) => pathKey(t.path) !== key);

    const remaining = getVisibleTabDocs();
    if (wasActive) {
      if (remaining.length > 0) {
        const nextIdx = Math.min(closedIdx >= 0 ? closedIdx : 0, remaining.length - 1);
        const nextDoc = remaining[nextIdx];
        state.seenProducedPaths.add(nextDoc.path);
        openFilePreview(nextDoc, { skipDirtyCheck: true });
        return;
      }
      closePreviewToEmpty();
    }
    renderProducedStrip();
  }

  let closeAllInFlight = false;
  async function closeAllTabs() {
    if (closeAllInFlight) return;
    const initialDocs = getVisibleTabDocs();
    if (!initialDocs.length && !state.activeFile) return;

    closeAllInFlight = true;
    try {
      if (state.activeController?.isDirty?.()) {
        const ok = await confirmDiscardIfDirty();
        if (!ok) return;
      }

      const docsToClose = getVisibleTabDocs();
      const closedKeys = new Set();
      for (const doc of docsToClose) {
        const key = pathKey(doc?.path);
        if (!key) continue;
        state.dismissedPaths.set(key, getDismissMtime(doc));
        closedKeys.add(key);
      }
      if (state.activeFile?.path) {
        const activeKey = pathKey(state.activeFile.path);
        if (activeKey) {
          state.dismissedPaths.set(activeKey, getDismissMtime(state.activeFile));
          closedKeys.add(activeKey);
        }
      }

      state.openTabs = [];

      if (state.activeFile) {
        closePreviewToEmpty();
      } else {
        state.hasUserClosedAll = true;
      }

      renderProducedStrip();
      if (closedKeys.size > 0) {
        showToast(`已关闭 ${closedKeys.size} 个标签页`, 1800);
      }
    } finally {
      closeAllInFlight = false;
    }
  }

  // 批量关闭除指定标签之外的所有已打开标签
  async function closeOtherTabs(keepDoc) {
    if (closeAllInFlight || !keepDoc?.path) return;
    const keepKey = pathKey(keepDoc.path);
    const docsBefore = getVisibleTabDocs();
    const othersBefore = docsBefore.filter((d) => pathKey(d.path) !== keepKey);
    if (!othersBefore.length) return;

    const activeKey = pathKey(state.activeFile?.path);
    const activeWillClose = Boolean(activeKey) && activeKey !== keepKey;

    closeAllInFlight = true;
    try {
      if (activeWillClose && state.activeController?.isDirty?.()) {
        const ok = await confirmDiscardIfDirty();
        if (!ok) return;
      }

      const docsNow = getVisibleTabDocs();
      const toClose = docsNow.filter((d) => pathKey(d.path) !== keepKey);
      const closedKeys = new Set();
      for (const d of toClose) {
        const k = pathKey(d?.path);
        if (!k) continue;
        state.dismissedPaths.set(k, getDismissMtime(d));
        closedKeys.add(k);
      }

      state.dismissedPaths.delete(keepKey);
      state.openTabs = state.openTabs.filter((t) => pathKey(t.path) === keepKey);

      renderProducedStrip();
      if (activeWillClose || !state.activeFile) {
        state.seenProducedPaths.add(keepDoc.path);
        await openFilePreview(keepDoc, { skipDirtyCheck: true });
      }
      if (closedKeys.size > 0) {
        showToast(`已关闭其他 ${closedKeys.size} 个标签页`, 1800);
      }
    } finally {
      closeAllInFlight = false;
    }
  }

  // 批量关闭指定标签右侧的所有标签
  async function closeRightTabs(anchorDoc) {
    if (closeAllInFlight || !anchorDoc?.path) return;
    const anchorKey = pathKey(anchorDoc.path);
    const docsBefore = getVisibleTabDocs();
    const anchorIdx = docsBefore.findIndex((d) => pathKey(d.path) === anchorKey);
    if (anchorIdx < 0 || anchorIdx >= docsBefore.length - 1) return;

    const rightKeysBefore = new Set(docsBefore.slice(anchorIdx + 1).map((d) => pathKey(d.path)));
    const activeKey = pathKey(state.activeFile?.path);
    const activeWillClose = Boolean(activeKey) && rightKeysBefore.has(activeKey);

    closeAllInFlight = true;
    try {
      if (activeWillClose && state.activeController?.isDirty?.()) {
        const ok = await confirmDiscardIfDirty();
        if (!ok) return;
      }

      const docsNow = getVisibleTabDocs();
      const anchorIdxNow = docsNow.findIndex((d) => pathKey(d.path) === anchorKey);
      if (anchorIdxNow < 0 || anchorIdxNow >= docsNow.length - 1) return;

      const toClose = docsNow.slice(anchorIdxNow + 1);
      const closedKeys = new Set();
      for (const d of toClose) {
        const k = pathKey(d?.path);
        if (!k) continue;
        state.dismissedPaths.set(k, getDismissMtime(d));
        closedKeys.add(k);
      }

      state.openTabs = state.openTabs.filter((t) => !closedKeys.has(pathKey(t.path)));

      renderProducedStrip();
      if (activeWillClose) {
        state.seenProducedPaths.add(anchorDoc.path);
        await openFilePreview(anchorDoc, { skipDirtyCheck: true });
      }
      if (closedKeys.size > 0) {
        showToast(`已关闭右侧 ${closedKeys.size} 个标签页`, 1800);
      }
    } finally {
      closeAllInFlight = false;
    }
  }

  // ---------- 已打开标签页速查下拉面板 & 标签右键菜单 ----------
  function isOpenTabsPopoverOpen() {
    const pop = $('openTabsPopover');
    return Boolean(pop && !pop.classList.contains('is-hidden'));
  }

  function closeOpenTabsPopover() {
    const pop = $('openTabsPopover');
    const btn = $('openTabsPickerBtn');
    if (pop && !pop.classList.contains('is-hidden')) {
      pop.classList.add('is-hidden');
    }
    if (btn) btn.setAttribute('aria-expanded', 'false');
  }

  function renderOpenTabsPopoverList() {
    const listEl = $('openTabsPopoverList');
    if (!listEl) return;
    const docs = getVisibleTabDocs();
    const q = String(state.openTabsFilterQuery || '').trim().toLowerCase();
    const filtered = q
      ? docs.filter((d) => {
          const hay = `${d.name || ''} ${d.relPath || ''} ${d.path || ''}`.toLowerCase();
          return hay.includes(q);
        })
      : docs;

    listEl.innerHTML = '';
    if (!filtered.length) {
      listEl.innerHTML = `<div class="ws-tabs-popover-empty">${
        docs.length ? '没有匹配筛选条件的已打开标签' : '暂无已打开的标签'
      }</div>`;
      return;
    }

    const activeKey = pathKey(state.activeFile?.path);
    const closeSvg = WSIcons?.render ? WSIcons.render('ui-close', { size: 11 }) : '&times;';

    for (const doc of filtered) {
      const isActive = Boolean(activeKey) && activeKey === pathKey(doc.path);
      const row = document.createElement('div');
      row.className = `ws-tabs-popover-item ${isActive ? 'is-active' : ''}`;
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', isActive ? 'true' : 'false');
      row.tabIndex = 0;
      row.title = doc.path || doc.relPath || doc.name;

      const ic = document.createElement('span');
      ic.className = 'ws-pill-icon';
      ic.innerHTML = getFileIcon(doc, { size: 16 });

      const meta = document.createElement('div');
      meta.className = 'ws-tabs-popover-meta';
      const nameEl = document.createElement('span');
      nameEl.className = 'ws-tabs-popover-name';
      nameEl.textContent = doc.name;
      const pathEl = document.createElement('span');
      pathEl.className = 'ws-tabs-popover-path';
      pathEl.textContent = doc.relPath || doc.path || '';
      meta.append(nameEl, pathEl);

      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'ws-tabs-popover-close';
      closeBtn.title = `关闭 ${doc.name}`;
      closeBtn.setAttribute('aria-label', `关闭 ${doc.name}`);
      closeBtn.innerHTML = closeSvg;
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        closeTab(doc);
      });

      const openDoc = () => {
        state.seenProducedPaths.add(doc.path);
        closeOpenTabsPopover();
        switchMode('workbench');
        openFilePreview(doc);
      };
      row.addEventListener('click', openDoc);
      row.addEventListener('keydown', (e) => {
        if (e.target.closest('.ws-tabs-popover-close')) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openDoc();
        }
      });

      row.append(ic, meta, closeBtn);
      listEl.appendChild(row);
    }
  }

  function toggleOpenTabsPopover() {
    const pop = $('openTabsPopover');
    const btn = $('openTabsPickerBtn');
    if (!pop || !btn) return;
    if (isOpenTabsPopoverOpen()) {
      closeOpenTabsPopover();
      return;
    }
    const docs = getVisibleTabDocs();
    if (!docs.length) return;
    closeStagedPopover();
    $('treeContextMenu')?.classList.add('is-hidden');
    $('tabContextMenu')?.classList.add('is-hidden');
    state.openTabsFilterQuery = '';
    const inputEl = $('openTabsFilterInput');
    if (inputEl) inputEl.value = '';
    pop.classList.remove('is-hidden');
    btn.setAttribute('aria-expanded', 'true');
    renderOpenTabsPopoverList();
    inputEl?.focus();
  }

  function showTabContextMenu(x, y, doc) {
    if (!doc?.path) return;
    const menu = $('tabContextMenu');
    if (!menu) return;
    $('treeContextMenu')?.classList.add('is-hidden');
    closeOpenTabsPopover();
    closeStagedPopover();

    state.tabContextTarget = doc;
    const docs = getVisibleTabDocs();
    const docKey = pathKey(doc.path);
    const idx = docs.findIndex((d) => pathKey(d.path) === docKey);

    const btnOthers = menu.querySelector('[data-tab-action="close-others"]');
    const btnRight = menu.querySelector('[data-tab-action="close-right"]');
    const btnAll = menu.querySelector('[data-tab-action="close-all"]');
    if (btnOthers) btnOthers.disabled = docs.length <= 1;
    if (btnRight) btnRight.disabled = idx < 0 || idx >= docs.length - 1;
    if (btnAll) btnAll.disabled = docs.length === 0;

    menu.classList.remove('is-hidden');
    const mw = menu.offsetWidth || 195;
    const mh = menu.offsetHeight || 210;
    const maxX = Math.max(6, global.innerWidth - mw - 6);
    const maxY = Math.max(6, global.innerHeight - mh - 6);
    menu.style.left = `${Math.max(6, Math.min(x, maxX))}px`;
    menu.style.top = `${Math.max(6, Math.min(y, maxY))}px`;
  }

  $('tabContextMenu')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-tab-action]');
    if (!btn || btn.disabled || !state.tabContextTarget) return;
    const doc = state.tabContextTarget;
    const act = btn.dataset.tabAction;
    $('tabContextMenu')?.classList.add('is-hidden');
    if (act === 'locate-tree') {
      await revealFileInTree(doc);
    } else if (act === 'close-self') {
      await closeTab(doc);
    } else if (act === 'close-others') {
      await closeOtherTabs(doc);
    } else if (act === 'close-right') {
      await closeRightTabs(doc);
    } else if (act === 'close-all') {
      await closeAllTabs();
    }
  });

  function renderProducedStrip() {
    const listEl = $('producedList');
    const docs = getVisibleTabDocs();

    const pickerBtn = $('openTabsPickerBtn');
    const countEl = $('openTabsCountText');
    if (pickerBtn) {
      const hasTabs = docs.length > 0;
      pickerBtn.classList.toggle('is-hidden', !hasTabs);
      if (countEl) countEl.textContent = String(docs.length);
      pickerBtn.title = hasTabs
        ? `速查全部 ${docs.length} 个已打开标签页`
        : '搜索与快速切换已打开的标签页';
      if (!hasTabs) closeOpenTabsPopover();
    }
    if (isOpenTabsPopoverOpen()) {
      renderOpenTabsPopoverList();
    }

    const closeAllBtn = $('closeAllTabsBtn');
    if (closeAllBtn) {
      const hasTabs = docs.length > 0;
      closeAllBtn.classList.toggle('is-hidden', !hasTabs);
      closeAllBtn.disabled = !hasTabs;
      closeAllBtn.title = hasTabs
        ? `关闭当前 ${docs.length} 个已打开标签页`
        : '关闭所有已打开的标签页';
    }

    listEl.innerHTML = '';
    if (!docs.length) {
      const hasHiddenNonDocProduced =
        state.producedOnlyDocs &&
        state.producedDocs.some((d) => !d.isDoc && !isPathDismissed(d));
      listEl.innerHTML = `<span class="ws-produced-empty">${
        hasHiddenNonDocProduced ? '当前无文档标签（可点右侧查看全部文件）' : '暂无打开的文档'
      }</span>`;
      return;
    }

    const activeKey = pathKey(state.activeFile?.path);
    const closeSvg = WSIcons?.render ? WSIcons.render('ui-close', { size: 11 }) : '&times;';

    for (const doc of docs) {
      const docKey = pathKey(doc.path);
      const isActive = Boolean(activeKey) && activeKey === docKey;
      const isUnseen = !state.seenProducedPaths.has(doc.path) && !isActive;

      const tab = document.createElement('div');
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
      tab.tabIndex = 0;
      tab.className = `ws-doc-pill ${isActive ? 'is-active' : ''} ${isUnseen ? 'is-new' : ''}`;
      tab.title = `${doc.relPath || doc.path} (${doc.sourceTool || '打开的文档'})`;

      const ic = document.createElement('span');
      ic.className = 'ws-pill-icon';
      ic.innerHTML = getFileIcon(doc, { size: 15 });

      const lbl = document.createElement('span');
      lbl.className = 'ws-doc-pill-name';
      lbl.textContent = doc.name;

      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'ws-tab-close';
      closeBtn.title = `关闭 ${doc.name}`;
      closeBtn.setAttribute('aria-label', `关闭 ${doc.name}`);
      closeBtn.innerHTML = closeSvg;
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        closeTab(doc);
      });

      const activate = () => {
        state.seenProducedPaths.add(doc.path);
        switchMode('workbench');
        openFilePreview(doc);
      };
      tab.addEventListener('click', activate);
      tab.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        showTabContextMenu(e.clientX, e.clientY, doc);
      });
      tab.addEventListener('auxclick', (e) => {
        if (e.button === 1) {
          e.preventDefault();
          e.stopPropagation();
          closeTab(doc);
        }
      });
      tab.addEventListener('keydown', (e) => {
        if (e.target.closest('.ws-tab-close')) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          activate();
        }
      });

      tab.append(ic, lbl, closeBtn);
      listEl.appendChild(tab);
    }
  }

  $('producedFilterBtn').addEventListener('click', () => {
    state.producedOnlyDocs = !state.producedOnlyDocs;
    $('producedFilterBtn').textContent = state.producedOnlyDocs ? '仅看文档' : '全部文件';
    $('producedFilterBtn').classList.toggle('is-active', !state.producedOnlyDocs);
    renderProducedStrip();
  });

  $('openTabsPickerBtn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleOpenTabsPopover();
  });

  $('openTabsFilterInput')?.addEventListener('input', (e) => {
    state.openTabsFilterQuery = e.target.value;
    renderOpenTabsPopoverList();
  });

  $('openTabsFilterInput')?.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeOpenTabsPopover();
      $('openTabsPickerBtn')?.focus();
    } else if (e.key === 'Enter') {
      const firstItem = $('openTabsPopoverList')?.querySelector('.ws-tabs-popover-item');
      if (firstItem) {
        e.preventDefault();
        firstItem.click();
      }
    }
  });

  $('closeAllTabsBtn')?.addEventListener('click', () => {
    closeAllTabs();
  });

  async function pollProducedDocs() {
    try {
      const data = await getJson(
        `/api/doc/produced?conversationId=${encodeURIComponent(state.conversationId || '')}`
      );
      if (!data?.success) return;
      if (!state.conversationId && data.conversationId) {
        state.conversationId = data.conversationId;
        if (state.stagedStorageKeyLoaded !== getStagedStorageKey()) loadStagedComments();
      }
      const nextDocs = data.docs || [];
      const wasEmpty = state.producedDocs.length === 0;
      state.producedDocs = nextDocs;

      for (const doc of nextDocs) {
        const key = pathKey(doc.path);
        const dismissedMtime = state.dismissedPaths.get(key);
        if (dismissedMtime !== undefined && Math.floor(doc.mtimeMs || 0) > dismissedMtime) {
          state.dismissedPaths.delete(key);
        }
      }

      const activeProduced = nextDocs.filter((d) => !isPathDismissed(d));
      const qs = new URLSearchParams(location.search);
      const hasInitialFile = Boolean(qs.get('file') || qs.get('uri') || qs.get('path'));
      if (!state.activeFile && !state.hasUserClosedAll && !hasInitialFile && activeProduced.length > 0) {
        const target = state.producedOnlyDocs
          ? activeProduced.find((d) => d.isDoc)
          : activeProduced.find((d) => d.isDoc) || activeProduced[0];
        if (target) {
          state.seenProducedPaths.add(target.path);
          await openFilePreview(target);
          return;
        }
      }

      if (wasEmpty && nextDocs.length > 0 && state.activeFile) {
        state.seenProducedPaths.add(state.activeFile.path);
      }
      renderProducedStrip();
    } catch {}
  }

  async function pollActiveFileStat() {
    if (state.statPollInFlight || !state.activeFile?.path) return;
    const targetPath = state.activeFile.path;
    const targetSeq = state.previewOpenSeq;
    state.statPollInFlight = true;
    try {
      const data = await getJson(
        `/api/file/stat?path=${encodeURIComponent(targetPath)}&conversationId=${encodeURIComponent(
          state.conversationId || ''
        )}`
      );
      if (
        state.previewOpenSeq !== targetSeq ||
        !state.activeFile ||
        pathKey(state.activeFile.path) !== pathKey(targetPath)
      ) {
        return;
      }
      if (!data?.success || !data.exists) return;
      const nextSig =
        data.version || `${Math.floor(data.mtimeMs || 0)}:${data.size || 0}`;
      if (nextSig !== state.activeFileSig) {
        if (state.activeController?.isDirty?.()) {
          state.activeFileSig = nextSig;
          state.activeFile = {
            ...state.activeFile,
            mtimeMs: data.mtimeMs,
            size: data.size,
            version: data.version || state.activeFile.version || '',
          };
          showToast('检测到文件在外部有更新（当前有未保存修改，可手动保存或刷新）', 3200);
          return;
        }
        state.activeFile = {
          ...state.activeFile,
          mtimeMs: data.mtimeMs,
          size: data.size,
          version: data.version || '',
        };
        await openFilePreview(state.activeFile, { preserveState: true, skipDirtyCheck: true });
        showToast(`已自动刷新：${state.activeFile.name}`);
      }
    } catch {} finally {
      state.statPollInFlight = false;
    }
  }

  async function pollWatchState() {
    if (!state.activeRoot) return;
    try {
      const data = await getJson(
        `/api/workspace/watch-state?root=${encodeURIComponent(state.activeRoot)}`
      );
      if (data?.success && Number.isFinite(data.rev)) {
        if (state.watchRev && data.rev !== state.watchRev) {
          await reloadExpandedDirs();
        }
        state.watchRev = data.rev;
      }
    } catch {}
  }

  // ---------- Workspace Synchronization ----------
  async function applyWorkspaceUris(uris) {
    const norm = Array.isArray(uris) ? uris : [];
    const nextKey = JSON.stringify(norm);
    if (nextKey === state.lastRegisteredUrisKey) return;
    state.lastRegisteredUrisKey = nextKey;
    const regSeq = ++state.workspaceRegSeq;

    try {
      const res = await postJson('/api/workspace/register', {
        workspaceUris: norm,
        generation: state.workspaceGen,
      });
      if (Number.isFinite(res?.generation)) {
        state.workspaceGen = Math.max(state.workspaceGen, res.generation);
      }
      if (regSeq !== state.workspaceRegSeq || res?.applied === false) return;

      state.roots = res.roots || [];

      const sel = $('rootSelector');
      sel.innerHTML = '';
      for (const r of state.roots) {
        const opt = document.createElement('option');
        opt.value = r.path;
        opt.textContent = r.name;
        sel.appendChild(opt);
      }
      sel.classList.toggle('is-hidden', state.roots.length <= 1);

      if (!state.roots.some((r) => r.path === state.activeRoot)) {
        state.activeRoot = state.roots[0]?.path || '';
        state.expandedDirs.clear();
        state.dirCache.clear();
        state.watchRev = 0;
      }
      if (state.activeRoot) sel.value = state.activeRoot;

      await reloadExpandedDirs();
      await pollProducedDocs();
    } catch (err) {
      if (regSeq === state.workspaceRegSeq) {
        state.lastRegisteredUrisKey = null;
      }
      console.warn('Workspace sync failed:', err);
    }
  }

  $('rootSelector').addEventListener('change', async (e) => {
    state.activeRoot = e.target.value;
    state.expandedDirs.clear();
    state.dirCache.clear();
    state.watchRev = 0;
    await reloadExpandedDirs();
  });

  $('globalRefreshBtn').addEventListener('click', async () => {
    await reloadExpandedDirs();
    await pollProducedDocs();
    if (state.activeFile) await openFilePreview(state.activeFile, { preserveState: true });
    if (state.mode === 'trajectory') await trajectoryCtrl.refresh({ force: true });
    showToast('已刷新工作台');
  });

  // ---------- Bootstrap ----------
  (async function bootstrap() {
    loadStagedComments();
    try {
      const health = await getJson('/api/health');
      state.capabilities = health.converters || {};
      if (Number.isFinite(health?.generation)) {
        state.workspaceGen = Math.max(state.workspaceGen, health.generation);
      }
    } catch {}

    const params = new URLSearchParams(location.search);
    const initialFileParam = params.get('file') || params.get('uri') || params.get('path') || '';

    if (global.sidecar?.getWorkspaceUris) {
      global.sidecar.onWorkspaceChange((uris) => {
        applyWorkspaceUris(uris);
      });
      const initialUris = await global.sidecar.getWorkspaceUris();
      if (initialUris?.length) {
        await applyWorkspaceUris(initialUris);
      } else {
        await pollProducedDocs();
      }
    } else {
      await pollProducedDocs();
    }

    if (initialFileParam) {
      const clean = initialFileParam.replace(/^file:\/\//i, '');
      const name = clean.split(/[\\/]/).pop() || clean;
      const extMatch = /\.[^.]+$/.exec(name);
      const ext = extMatch ? extMatch[0].toLowerCase() : '';
      const catMap = {
        '.docx': 'docx',
        '.xlsx': 'xlsx',
        '.xls': 'xlsx',
        '.csv': 'xlsx',
        '.pptx': 'pptx',
        '.pdf': 'pdf',
        '.md': 'markdown',
        '.png': 'image',
        '.jpg': 'image',
        '.jpeg': 'image',
        '.webp': 'image',
        '.svg': 'image',
        '.gif': 'image',
        '.bmp': 'image',
        '.ico': 'image',
      };
      await openFilePreview({
        name,
        path: initialFileParam,
        relPath: name,
        ext,
        category: catMap[ext] || 'code',
        uri: initialFileParam.startsWith('file://') ? initialFileParam : '',
      });
    }

    state.pollTimers.push(
      setInterval(pollActiveFileStat, 2000),
      setInterval(pollWatchState, 2500),
      setInterval(pollProducedDocs, 3500)
    );

    global.addEventListener('pagehide', () => {
      for (const id of state.pollTimers) clearInterval(id);
      state.pollTimers = [];
      try {
        state.activeController?.destroy?.();
      } catch {}
      try {
        state.activeCleanup?.();
      } catch {}
      try {
        trajectoryCtrl?.destroy?.();
      } catch {}
    });
  })();
})(window);
