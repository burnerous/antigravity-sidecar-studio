(function (global) {
  'use strict';

  const {
    renderDocxPreview,
    renderImagePreview,
    renderVideoPreview,
    renderPdfPreview,
    renderPptxPreview,
    renderTextOrImagePreview,
    renderXlsxPreview,
    createTrajectoryController,
  } = global.WSModules || {};

  const $ = (id) => document.getElementById(id);
  const WSIcons = global.WSIcons;
  if (WSIcons?.hydrate) WSIcons.hydrate(document);

  function motionOpen(el) {
    if (global.WSPrismMotion?.openOverlay) global.WSPrismMotion.openOverlay(el);
    else el?.classList.remove('is-hidden');
  }

  function motionClose(el, opts) {
    if (global.WSPrismMotion?.closeOverlay) {
      global.WSPrismMotion.closeOverlay(el, opts);
    } else {
      el?.classList.add('is-hidden');
      opts?.onDone?.();
    }
  }

  function isMotionOverlayOpen(el) {
    return global.WSPrismMotion?.isOverlayOpen
      ? global.WSPrismMotion.isOverlayOpen(el)
      : Boolean(el && !el.classList.contains('is-hidden'));
  }

  function renderFileSvg(item, opts = {}) {
    if (WSIcons?.renderFile) return WSIcons.renderFile(item, opts);
    return '';
  }

  const MAX_STAGED_COMMENTS = 50;
  const STAGED_STORAGE_PREFIX = 'ws-studio-staged-comments:';
  const APPEARANCE_STORAGE_KEY = 'ws-studio-appearance';
  const VALID_SKINS = new Set(['default', 'prism']);
  const VALID_PRISM_VARIANTS = new Set(['auto', 'obsidian-dark', 'warm-charcoal', 'daylight-crystal', 'warm-alabaster']);
  const VALID_MOTIONS = new Set(['full', 'reduced']);
  const DEFAULT_APPEARANCE = { skin: 'default', prismVariant: 'auto', motion: 'full' };

  function normalizeAppearance(raw) {
    return {
      skin: VALID_SKINS.has(raw?.skin) ? raw.skin : DEFAULT_APPEARANCE.skin,
      prismVariant: VALID_PRISM_VARIANTS.has(raw?.prismVariant) ? raw.prismVariant : DEFAULT_APPEARANCE.prismVariant,
      motion: VALID_MOTIONS.has(raw?.motion) ? raw.motion : DEFAULT_APPEARANCE.motion,
    };
  }

  function loadStoredAppearance() {
    try {
      return normalizeAppearance(JSON.parse(global.localStorage.getItem(APPEARANCE_STORAGE_KEY)));
    } catch {
      return { ...DEFAULT_APPEARANCE };
    }
  }

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
    hasInitialFileParam: false,
    capabilities: {},
    conversationId:
      global.sidecar?.conversationId || new URLSearchParams(location.search).get('conversationId') || '',
    pendingQuote: null,
    stagedComments: [],
    stagedPopoverOpen: false,
    hostTheme: 'dark',
    appearance: loadStoredAppearance(),
    appearancePopoverOpen: false,
    appearanceDirtyLocal: false,
    stagedStorageKeyLoaded: '',
    stagedSending: false,
    contextTarget: null,
    tabContextTarget: null,
    openTabsFilterQuery: '',
    bootId: '',
    backendVendorReady: true,
    missingVendorAssets: [],
    vendorBannerDismissed: false,
    vendorRecoveryTimer: null,
    refreshDirtyConfirmUntil: 0,
    vendorForceReloadUntil: 0,
    updateStatus: null,
    updateModalOpen: false,
    updatePollTimer: null,
    updateReconnectTimer: null,
    updateDirtyConfirmUntil: 0,
    updateDirtyConfirmTimer: null,
    updateCheckingNow: false,
  };

  const VENDOR_AUTO_RELOAD_KEY = 'ws-studio-vendor-auto-reload-ts';
  const REQUIRED_VENDOR_GLOBALS = [
    { key: 'JSZip', label: 'JSZip', route: '/vendor/jszip.min.js', ready: () => typeof global.JSZip?.loadAsync === 'function' },
    { key: 'docx', label: 'docx-preview', route: '/vendor/docx-preview.min.js', ready: () => typeof global.docx?.renderAsync === 'function' },
    { key: 'mammoth', label: 'mammoth', route: '/vendor/mammoth.browser.min.js', ready: () => typeof global.mammoth?.convertToHtml === 'function' },
    { key: 'XLSX', label: 'SheetJS (xlsx)', route: '/vendor/xlsx.full.min.js', ready: () => typeof global.XLSX?.read === 'function' && Boolean(global.XLSX?.utils) },
    { key: 'marked', label: 'marked', route: '/vendor/marked.umd.js', ready: () => typeof global.marked?.parse === 'function' },
    { key: 'DOMPurify', label: 'DOMPurify', route: '/vendor/purify.min.js', ready: () => typeof global.DOMPurify?.sanitize === 'function' },
    { key: 'hljs', label: 'highlight.js', route: '/vendor/highlight.min.js', ready: () => Boolean(global.hljs) },
    { key: 'pdfjsLib', label: 'pdf.js', route: '/vendor/pdfjs/pdf.min.js', ready: () => typeof global.pdfjsLib?.getDocument === 'function' },
  ];
  const CATEGORY_VENDOR_KEYS = {
    docx: ['docx', 'JSZip', 'mammoth', 'DOMPurify'],
    xlsx: ['XLSX'],
    pptx: ['JSZip'],
    pdf: ['pdfjsLib'],
    markdown: ['marked', 'DOMPurify'],
  };

  function getMissingFrontendVendors() {
    return REQUIRED_VENDOR_GLOBALS.filter((v) => !v.ready());
  }

  function getMissingVendorsForCategory(category) {
    const keys = CATEGORY_VENDOR_KEYS[category];
    if (!keys?.length) return [];
    const keySet = new Set(keys);
    return REQUIRED_VENDOR_GLOBALS.filter((v) => keySet.has(v.key) && !v.ready());
  }

  function buildVendorRepairCommand() {
    const isWin = /win/i.test(navigator.platform || navigator.userAgent || '');
    if (isWin) {
      return 'cd "$env:USERPROFILE\\.gemini\\config\\plugins\\antigravity-sidecar-studio\\sidecars\\studio"; npm ci';
    }
    return 'cd ~/.gemini/config/plugins/antigravity-sidecar-studio/sidecars/studio && npm ci';
  }

  function stopVendorRecoveryWatcher() {
    if (state.vendorRecoveryTimer) {
      clearInterval(state.vendorRecoveryTimer);
      state.vendorRecoveryTimer = null;
    }
  }

  function syncVendorHealthUi(health) {
    if (health && typeof health.vendorReady === 'boolean') {
      state.backendVendorReady = health.vendorReady;
      state.missingVendorAssets = Array.isArray(health.missingVendorAssets)
        ? health.missingVendorAssets
        : [];
    }
    const banner = $('wsVendorBanner');
    const bannerText = $('wsVendorBannerText');
    const copyBtn = $('wsVendorCopyCmdBtn');
    const dismissBtn = $('wsVendorDismissBtn');
    if (!banner || !bannerText) return;

    const missingFrontend = getMissingFrontendVendors();
    if (!state.backendVendorReady) {
      banner.classList.remove('is-ready');
      copyBtn?.classList.remove('is-hidden');
      dismissBtn?.classList.remove('is-hidden');
      const missingCount = state.missingVendorAssets.length || missingFrontend.length;
      bannerText.textContent = `检测到缺少 ${missingCount} 项离线预览依赖（sidecars/studio/node_modules），请使用官方 Release 离线包覆盖安装或运行 npm ci 修复后再点击「重载面板」。`;
      banner.classList.toggle('is-hidden', state.vendorBannerDismissed);
      return;
    }

    if (missingFrontend.length > 0) {
      state.vendorBannerDismissed = false;
      banner.classList.add('is-ready');
      copyBtn?.classList.add('is-hidden');
      dismissBtn?.classList.add('is-hidden');
      bannerText.textContent = '离线前端依赖已就绪，点击「重载面板」即可恢复文档预览（无需重启 Antigravity）。';
      banner.classList.remove('is-hidden');
      return;
    }

    banner.classList.add('is-hidden');
    banner.classList.remove('is-ready');
    stopVendorRecoveryWatcher();
  }

  function tryAutoReloadForVendorRecovery() {
    if (!state.backendVendorReady || getMissingFrontendVendors().length === 0) return false;
    if (state.activeController?.isDirty?.()) return false;
    try {
      const lastTs = Number(global.sessionStorage?.getItem(VENDOR_AUTO_RELOAD_KEY) || 0);
      if (Number.isFinite(lastTs) && lastTs > 0 && Date.now() - lastTs < 15000) {
        return false;
      }
      global.sessionStorage?.setItem(VENDOR_AUTO_RELOAD_KEY, String(Date.now()));
    } catch {}
    showToast('检测到离线依赖已就绪，正在自动重载工作台...', 1800);
    global.location.reload();
    return true;
  }

  function startVendorRecoveryWatcher() {
    if (getMissingFrontendVendors().length === 0 && state.backendVendorReady) return;
    if (state.vendorRecoveryTimer) return;
    state.vendorRecoveryTimer = setInterval(async () => {
      try {
        const health = await getJson('/api/health');
        if (!health?.success) return;
        syncVendorHealthUi(health);
        if (health.vendorReady === true) {
          stopVendorRecoveryWatcher();
          tryAutoReloadForVendorRecovery();
        }
      } catch {}
    }, 3000);
  }

  async function requestPanelReload({ reason = 'manual', allowWhenMissing = false } = {}) {
    if (state.activeController?.isDirty?.() && Date.now() >= state.refreshDirtyConfirmUntil) {
      state.refreshDirtyConfirmUntil = Date.now() + 4000;
      showToast('当前文档有未保存修改，请在 4 秒内再次点击以重载工作台', 3200);
      return false;
    }
    state.refreshDirtyConfirmUntil = 0;

    if (!allowWhenMissing) {
      try {
        const health = await getJson('/api/health');
        if (health?.success) {
          syncVendorHealthUi(health);
          if (health.vendorReady === false) {
            if (Date.now() >= state.vendorForceReloadUntil) {
              state.vendorForceReloadUntil = Date.now() + 5000;
              startVendorRecoveryWatcher();
              const count = health.missingVendorCount || state.missingVendorAssets.length || getMissingFrontendVendors().length;
              showToast(`仍检测到缺少 ${count} 项离线依赖，请先完成安装（5 秒内再次点击可强制重载）`, 3500);
              return false;
            }
          }
        }
      } catch {}
    }

    state.vendorForceReloadUntil = 0;
    if (reason === 'vendor-ready' || reason === 'boot-changed') {
      showToast('检测到后台或依赖已更新，正在重载工作台...', 1500);
    }
    global.location.reload();
    return true;
  }

  async function reloadIfBackendOrVendorUpdated() {
    try {
      const health = await getJson('/api/health');
      if (health?.success) {
        syncVendorHealthUi(health);
        const bootChanged = Boolean(state.bootId && health.bootId && health.bootId !== state.bootId);
        const vendorNeedsReload = getMissingFrontendVendors().length > 0 && health.vendorReady === true;
        if (bootChanged || vendorNeedsReload) {
          return await requestPanelReload({
            reason: bootChanged ? 'boot-changed' : 'vendor-ready',
            allowWhenMissing: true,
          });
        }
      }
    } catch {}
    return false;
  }

  $('wsVendorCopyCmdBtn')?.addEventListener('click', () => {
    copyText(buildVendorRepairCommand(), '已复制离线依赖修复命令');
  });
  $('wsVendorReloadBtn')?.addEventListener('click', () => {
    requestPanelReload({ reason: 'banner-reload' });
  });
  $('wsVendorDismissBtn')?.addEventListener('click', () => {
    state.vendorBannerDismissed = true;
    $('wsVendorBanner')?.classList.add('is-hidden');
  });

  let toastTimer = null;
  function showToast(msg, duration = 2200) {
    const el = $('wsToast');
    el.textContent = msg;
    motionOpen(el);
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => motionClose(el), duration);
  }

  // ---------- Host Theme & Appearance Sync ----------
  function applyAppearanceToDom() {
    const { skin, prismVariant, motion } = state.appearance;
    const docEl = document.documentElement;
    docEl.dataset.skin = skin;
    docEl.dataset.prismVariant = prismVariant;
    docEl.dataset.motion = motion;

    let effectiveTheme = state.hostTheme;
    if (skin === 'prism') {
      const resolved = prismVariant === 'auto'
        ? (state.hostTheme === 'light' ? 'daylight-crystal' : 'obsidian-dark')
        : prismVariant;
      docEl.dataset.prismResolved = resolved;
      effectiveTheme = resolved === 'daylight-crystal' || resolved === 'warm-alabaster' ? 'light' : 'dark';
    } else {
      docEl.removeAttribute('data-prism-resolved');
    }

    if (docEl.dataset.theme !== effectiveTheme) docEl.dataset.theme = effectiveTheme;
    const hljsLink = $('hljs-theme');
    const hljsHref = effectiveTheme === 'light' ? '/vendor/hljs-light.css' : '/vendor/hljs-dark.css';
    if (hljsLink && hljsLink.getAttribute('href') !== hljsHref) hljsLink.href = hljsHref;

    $('appearancePopover')?.querySelectorAll('[data-appearance-skin]').forEach((btn) => {
      const selected = btn.dataset.appearanceSkin === skin
        && (skin === 'default' || btn.dataset.appearanceVariant === prismVariant);
      btn.setAttribute('aria-pressed', String(selected));
    });
    const motionInput = $('appearanceReducedMotionInput');
    if (motionInput) motionInput.checked = motion === 'reduced';
    $('appearanceBtn')?.classList.toggle('is-active', skin === 'prism' || state.appearancePopoverOpen);
    global.WSPrismMotion?.syncAll?.({ snap: true });
  }

  function syncThemeScheme() {
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;color:var(--background, #0f1117)';
    document.documentElement.appendChild(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    const nums = (c.match(/[\d.]+/g) || []).map(Number);
    if (nums.length >= 3) {
      const scale = c.startsWith('color(') ? 1 : 255;
      const [r, g, b] = nums.slice(0, 3).map((v) => v / scale);
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      state.hostTheme = lum < 0.5 ? 'dark' : 'light';
    }
    applyAppearanceToDom();
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

  // ---------- Appearance Preferences ----------
  let appearanceSave = Promise.resolve();

  function saveStoredAppearance() {
    try {
      global.localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify(state.appearance));
    } catch {}
  }

  function setAppearance(patch) {
    const previousAppearance = state.appearance;
    const appearance = normalizeAppearance({ ...previousAppearance, ...patch });
    state.appearance = appearance;
    state.appearanceDirtyLocal = true;
    applyAppearanceToDom();
    saveStoredAppearance();

    if (appearance.skin === 'prism'
      && (previousAppearance.skin !== appearance.skin || previousAppearance.prismVariant !== appearance.prismVariant)) {
      global.WSPrismMotion?.triggerPrismShimmer?.($('appearanceBtn'));
    }

    // Preserve selection order when the user makes rapid changes.
    appearanceSave = appearanceSave.then(() => postJson('/api/ui/prefs', appearance)).catch(() => {});
  }

  async function hydrateAppearanceFromServer() {
    try {
      const data = await getJson('/api/ui/prefs');
      if (data?.success !== true || !data.prefs || state.appearanceDirtyLocal) return;
      state.appearance = normalizeAppearance({ ...state.appearance, ...data.prefs });
      applyAppearanceToDom();
      saveStoredAppearance();
    } catch {}
  }

  function openAppearancePopover() {
    if (state.updateModalOpen) return;
    closeOpenTabsPopover();
    closeStagedPopover();
    motionClose($('treeContextMenu'));
    motionClose($('tabContextMenu'));
    state.appearancePopoverOpen = true;
    motionOpen($('appearancePopover'));
    $('appearanceBtn').setAttribute('aria-expanded', 'true');
    applyAppearanceToDom();
    $('appearanceCloseBtn').focus();
  }

  function closeAppearancePopover({ restoreFocus = false } = {}) {
    if (!state.appearancePopoverOpen) return;
    state.appearancePopoverOpen = false;
    motionClose($('appearancePopover'));
    const btn = $('appearanceBtn');
    btn.setAttribute('aria-expanded', 'false');
    applyAppearanceToDom();
    if (restoreFocus) btn.focus();
  }

  function toggleAppearancePopover() {
    if (state.appearancePopoverOpen) closeAppearancePopover({ restoreFocus: true });
    else openAppearancePopover();
  }

  $('appearanceBtn').addEventListener('click', toggleAppearancePopover);
  $('appearanceCloseBtn').addEventListener('click', () => closeAppearancePopover({ restoreFocus: true }));
  $('appearancePopover').querySelectorAll('[data-appearance-skin]').forEach((btn) => {
    btn.addEventListener('click', () => setAppearance({
      skin: btn.dataset.appearanceSkin,
      prismVariant: btn.dataset.appearanceVariant,
    }));
  });
  $('appearanceReducedMotionInput').addEventListener('change', (e) => {
    setAppearance({ motion: e.target.checked ? 'reduced' : 'full' });
  });

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
    const prevMode = state.mode;
    state.mode = mode;
    $('tabWorkbench').classList.toggle('is-active', mode === 'workbench');
    $('tabTrajectory').classList.toggle('is-active', mode === 'trajectory');
    $('tabWorkbench').setAttribute('aria-selected', String(mode === 'workbench'));
    $('tabTrajectory').setAttribute('aria-selected', String(mode === 'trajectory'));
    $('workbenchPane').classList.toggle('is-hidden', mode !== 'workbench');
    $('trajectoryPane').classList.toggle('is-hidden', mode !== 'trajectory');
    global.WSPrismMotion?.syncContainer?.(document.querySelector('.ws-mode-tabs'));
    if (prevMode !== mode) {
      global.WSPrismMotion?.animatePaneSwitch?.(
        mode === 'trajectory' ? $('trajectoryPane') : $('workbenchPane'),
        mode === 'trajectory' ? 'right' : 'left',
      );
    }
    trajectoryCtrl.setVisible(mode === 'trajectory');
  }

  $('tabWorkbench').addEventListener('click', () => switchMode('workbench'));
  $('tabTrajectory').addEventListener('click', () => switchMode('trajectory'));

  function setTreeCollapsed(collapsed) {
    $('workbenchPane').classList.toggle('is-tree-collapsed', collapsed);
    $('toggleTreeBtn').classList.toggle('is-active', !collapsed);
    $('toggleTreeBtn')?.setAttribute('aria-expanded', String(!collapsed));
    const treePane = $('treePane');
    if (treePane) {
      treePane.inert = Boolean(collapsed);
      treePane.setAttribute('aria-hidden', String(Boolean(collapsed)));
    }
    $('paneSplitter')?.setAttribute('aria-hidden', String(Boolean(collapsed)));
  }

  setTreeCollapsed(global.innerWidth < 520);

  $('toggleTreeBtn').addEventListener('click', () => {
    if (state.mode !== 'workbench') switchMode('workbench');
    const next = !$('workbenchPane').classList.contains('is-tree-collapsed');
    setTreeCollapsed(next);
  });
  global.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.updateModalOpen) {
      e.preventDefault();
      closeUpdateModal({ restoreFocus: true });
      return;
    }
    if (e.key === 'Escape' && state.appearancePopoverOpen) {
      e.preventDefault();
      closeAppearancePopover({ restoreFocus: true });
      return;
    }
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
      workbench.classList.add('is-tree-resizing');
    });
    global.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const rect = workbench.getBoundingClientRect();
      const w = Math.min(Math.max(e.clientX - rect.left, 150), 460);
      workbench.style.setProperty('--ws-tree-width', `${Math.round(w)}px`);
    });
    function finishDrag() {
      if (!dragging) return;
      dragging = false;
      splitter.classList.remove('is-dragging');
      workbench.classList.remove('is-tree-resizing');
    }
    global.addEventListener('mouseup', finishDrag);
    global.addEventListener('blur', finishDrag);
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
  $('refreshTreeBtn').addEventListener('click', () => {
    global.WSPrismMotion?.triggerRefreshSpin?.($('refreshTreeBtn'));
    reloadExpandedDirs();
  });

  // ---------- Context Menu & File Actions ----------
  function showContextMenu(x, y, item) {
    state.contextTarget = item;
    motionClose($('tabContextMenu'));
    closeOpenTabsPopover();
    closeStagedPopover();
    closeAppearancePopover();
    const menu = $('treeContextMenu');
    motionOpen(menu);
    const maxX = global.innerWidth - 205;
    const maxY = global.innerHeight - 175;
    menu.style.left = `${Math.max(6, Math.min(x, maxX))}px`;
    menu.style.top = `${Math.max(6, Math.min(y, maxY))}px`;
  }

  document.addEventListener('click', (e) => {
    motionClose($('treeContextMenu'));
    motionClose($('tabContextMenu'));
    if (!e.target.closest('#openTabsPopover, #openTabsPickerBtn')) {
      closeOpenTabsPopover();
    }
    const path = e.composedPath();
    if (state.stagedPopoverOpen && !path.includes($('stagedCommentsPopover')) && !path.includes($('stagedCommentsBtn'))) {
      closeStagedPopover();
    }
    if (state.appearancePopoverOpen && !path.includes($('appearancePopover')) && !path.includes($('appearanceBtn'))) {
      closeAppearancePopover();
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
          )}`
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
    state.activeFileSig =
      file.version || (file.mtimeMs ? `${Math.floor(file.mtimeMs)}:${file.size || 0}` : '');

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
      onRenderError: (err) => {
        if (openSeq === state.previewOpenSeq) {
          renderPreviewErrorCard(stage, err, file);
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
      } else if (file.category === 'video' && typeof renderVideoPreview === 'function') {
        ctrl = await renderVideoPreview(ctx);
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
      renderPreviewErrorCard(stage, err, file);
    }
  }

  function renderPreviewErrorCard(stage, err, file) {
    const msg = String(err?.message || err || '未知错误');
    const missingForCat = getMissingVendorsForCategory(file?.category);
    const missingAny = getMissingFrontendVendors();
    const looksLikeVendorCrash =
      err?.code === 'VENDOR_MISSING' ||
      missingForCat.length > 0 ||
      /reading '(?:renderAsync|convertToHtml|loadAsync|read|parse|sanitize)'/i.test(msg);

    const card = document.createElement('div');
    card.className = 'ws-empty-welcome';

    const hero = document.createElement('div');
    hero.className = 'ws-empty-hero';
    hero.style.color = 'var(--ws-warn)';
    if (WSIcons?.render) hero.innerHTML = WSIcons.render('ui-warn', { size: 36 });

    const title = document.createElement('h3');
    const desc = document.createElement('p');
    card.append(hero, title, desc);

    if (looksLikeVendorCrash) {
      startVendorRecoveryWatcher();
      const missingList = missingForCat.length ? missingForCat : missingAny;
      if (state.backendVendorReady) {
        title.textContent = '需要重载面板以启用文档预览';
        desc.textContent =
          '离线前端库已在磁盘就绪，但当前界面是在依赖补装前打开的。请点击下方「重载面板」或右上角刷新按钮完成加载（无需重启 Antigravity）。';
      } else {
        title.textContent = '缺少离线预览依赖 (node_modules)';
        desc.textContent =
          '检测到插件目录缺少离线前端依赖（常见于通过源码包或第三方市场安装）。请改用官方 Release 离线整合包覆盖安装，或在插件 sidecars/studio 目录运行 npm ci 后点击「重载面板」。';
      }

      if (missingList.length > 0) {
        const detail = document.createElement('p');
        detail.className = 'ws-error-detail';
        detail.textContent = `未加载组件：${missingList.map((v) => v.label).join('、')}`;
        card.appendChild(detail);
      }

      const actions = document.createElement('div');
      actions.className = 'ws-error-actions';

      const reloadBtn = document.createElement('button');
      reloadBtn.type = 'button';
      reloadBtn.className = 'ws-btn-primary ws-btn-xs';
      reloadBtn.textContent = '重载面板';
      reloadBtn.addEventListener('click', () => {
        requestPanelReload({ reason: 'error-card' });
      });
      actions.appendChild(reloadBtn);

      if (!state.backendVendorReady) {
        const copyBtn = document.createElement('button');
        copyBtn.type = 'button';
        copyBtn.className = 'ws-btn-ghost ws-btn-xs';
        copyBtn.textContent = '复制修复命令';
        copyBtn.addEventListener('click', () => {
          copyText(buildVendorRepairCommand(), '已复制离线依赖修复命令');
        });
        actions.appendChild(copyBtn);
      }

      if (file?.uri) {
        const nativeBtn = document.createElement('button');
        nativeBtn.type = 'button';
        nativeBtn.className = 'ws-btn-ghost ws-btn-xs';
        nativeBtn.textContent = '原生打开';
        nativeBtn.addEventListener('click', () => openInNativeTab(file));
        actions.appendChild(nativeBtn);
      }

      card.appendChild(actions);
    } else {
      title.textContent = '文档预览失败';
      desc.textContent = msg;
    }

    stage.replaceChildren(card);
  }

  $('previewRefreshBtn').addEventListener('click', async () => {
    global.WSPrismMotion?.triggerRefreshSpin?.($('previewRefreshBtn'));
    if (await reloadIfBackendOrVendorUpdated()) return;
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

  function hideQuoteFab() {
    if (isMotionOverlayOpen(quoteFab)) motionClose(quoteFab);
  }

  function checkPreviewSelection() {
    const ae = document.activeElement;
    if (ae && (ae.tagName === 'TEXTAREA' || ae.tagName === 'INPUT' || ae.isContentEditable)) {
      hideQuoteFab();
      return;
    }
    const stage = $('previewStage');
    const sel = global.getSelection();
    if (!sel || sel.isCollapsed || !state.activeFile) {
      hideQuoteFab();
      return;
    }
    const text = sel.toString().trim();
    if (!text || !stage.contains(sel.anchorNode)) {
      hideQuoteFab();
      return;
    }
    selectedQuoteText = text.slice(0, 3000);
    try {
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      const x = Math.min(Math.max(rect.left + rect.width / 2 - 55, 10), global.innerWidth - 130);
      const y = Math.max(rect.top - 36, 46);
      quoteFab.style.left = `${x}px`;
      quoteFab.style.top = `${y}px`;
      if (!isMotionOverlayOpen(quoteFab)) motionOpen(quoteFab);
    } catch {
      hideQuoteFab();
    }
  }

  document.addEventListener('mouseup', () => setTimeout(checkPreviewSelection, 10));
  document.addEventListener('keyup', () => setTimeout(checkPreviewSelection, 10));

  function openQuoteModal({ text, locationLabel = '' }) {
    if (!state.activeFile || !text) return;
    closeStagedPopover();
    motionClose(quoteFab);
    state.pendingQuote = { file: state.activeFile, text, locationLabel };
    const loc = locationLabel ? ` (${locationLabel})` : '';
    $('quoteSourceMeta').textContent = `来源：${state.activeFile.relPath || state.activeFile.name}${loc}`;
    $('quoteExcerptBox').textContent = text;
    $('quoteCommentInput').value = '';
    motionOpen($('quoteModal'));
    $('quoteCommentInput').focus();
  }

  $('quoteFabBtn').addEventListener('click', () => {
    if (selectedQuoteText) openQuoteModal({ text: selectedQuoteText });
  });

  $('quoteModalClose').addEventListener('click', () => motionClose($('quoteModal')));
  $('quoteModal').addEventListener('click', (e) => {
    if (e.target === $('quoteModal')) motionClose($('quoteModal'));
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

    motionClose($('quoteModal'));
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

  let lastRenderedStagedCount = null;

  function renderStagedCommentsUi() {
    const n = state.stagedComments.length;
    if (n <= 1) resetStagedClearConfirm();
    const btn = $('stagedCommentsBtn');
    btn.classList.toggle('is-hidden', n === 0);
    btn.setAttribute('aria-label', `待发批注（${n} 条）`);
    $('stagedCommentsCount').textContent = String(n);
    $('stagedCommentsTitleCount').textContent = String(n);
    if (lastRenderedStagedCount !== null && n !== lastRenderedStagedCount && n > 0) {
      global.WSPrismMotion?.popBadge?.($('stagedCommentsCount'));
      global.WSPrismMotion?.popBadge?.($('stagedCommentsTitleCount'));
    }
    lastRenderedStagedCount = n;
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
    closeAppearancePopover();
    motionClose($('treeContextMenu'));
    motionClose($('tabContextMenu'));
    state.stagedPopoverOpen = true;
    motionOpen($('stagedCommentsPopover'));
    const btn = $('stagedCommentsBtn');
    btn.setAttribute('aria-expanded', 'true');
    btn.classList.add('is-active');
    $('stagedCommentsCloseBtn').focus();
  }

  function closeStagedPopover({ restoreFocus = false } = {}) {
    resetStagedClearConfirm();
    if (!state.stagedPopoverOpen) return;
    state.stagedPopoverOpen = false;
    motionClose($('stagedCommentsPopover'));
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
    motionClose($('quoteModal'));
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
    motionClose(quoteFab);

    for (const row of document.querySelectorAll('.ws-tree-row')) {
      row.classList.remove('is-active');
    }

    const stage = $('previewStage');
    stage.innerHTML = `
      <div id="previewEmptyState" class="ws-empty-welcome">
        <div class="ws-empty-hero" data-ws-icon="hero-workspace" data-size="52"></div>
        <h3>Sidecar Studio 三合一工作台</h3>
        <p>从左侧文件树或上方文档标签栏点击任意文件即可实时高保真预览：<br>Word (<code>.docx</code>) · Excel (<code>.xlsx/.xls/.csv</code>) · PPT (<code>.pptx</code>) · PDF · Markdown · 图片 · 视频 (<code>.mp4</code>) · 代码</p>
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
  async function closeAllTabs({ skipDirtyCheck = false } = {}) {
    if (closeAllInFlight) return;
    const initialDocs = getVisibleTabDocs();
    if (!initialDocs.length && !state.activeFile) return;

    closeAllInFlight = true;
    try {
      if (!skipDirtyCheck && state.activeController?.isDirty?.()) {
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
    return isMotionOverlayOpen($('openTabsPopover'));
  }

  function closeOpenTabsPopover() {
    motionClose($('openTabsPopover'));
    $('openTabsPickerBtn')?.setAttribute('aria-expanded', 'false');
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
    closeAppearancePopover();
    motionClose($('treeContextMenu'));
    motionClose($('tabContextMenu'));
    state.openTabsFilterQuery = '';
    const inputEl = $('openTabsFilterInput');
    if (inputEl) inputEl.value = '';
    motionOpen(pop);
    btn.setAttribute('aria-expanded', 'true');
    renderOpenTabsPopoverList();
    inputEl?.focus();
  }

  function showTabContextMenu(x, y, doc) {
    if (!doc?.path) return;
    const menu = $('tabContextMenu');
    if (!menu) return;
    motionClose($('treeContextMenu'));
    closeOpenTabsPopover();
    closeStagedPopover();
    closeAppearancePopover();

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

    motionOpen(menu);
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
    motionClose($('tabContextMenu'));
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
    const hasTabs = docs.length > 0;

    const pickerBtn = $('openTabsPickerBtn');
    const countEl = $('openTabsCountText');
    if (pickerBtn) {
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

    const closeAllWrap = $('closeAllTabsWrap');
    const closeAllBtn = $('closeAllTabsBtn');
    const keepForDone = Boolean(closeAllHoldCtrl?.isDone?.());
    const showCloseAll = hasTabs || keepForDone;
    closeAllWrap?.classList.toggle('is-hidden', !showCloseAll);
    if (closeAllBtn) {
      closeAllBtn.classList.toggle('is-hidden', !showCloseAll);
      closeAllBtn.disabled = !showCloseAll;
      closeAllBtn.title = hasTabs
        ? `长按关闭当前 ${docs.length} 个已打开标签页`
        : '长按关闭所有已打开的标签页';
    }
    if (!showCloseAll) closeAllHoldCtrl?.cancel?.();

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

  const bindHoldConfirm = global.WSModules?.bindHoldConfirm;
  const closeAllHoldCtrl = bindHoldConfirm?.({
    button: $('closeAllTabsBtn'),
    hintEl: $('closeAllHoldHint'),
    duration: 1100,
    tapThreshold: 240,
    hintDuration: 1400,
    doneDuration: 720,
    hintText: '长按以关闭全部',
    doneText: '',
    doneAriaLabel: '已关闭全部标签页',
    async onBeforeConfirm() {
      if (state.activeController?.isDirty?.()) return await confirmDiscardIfDirty();
      return true;
    },
    async onConfirm() {
      await closeAllTabs({ skipDirtyCheck: true });
    },
    onDoneEnd: renderProducedStrip,
  });
  if (!bindHoldConfirm) {
    $('closeAllTabsBtn')?.addEventListener('click', () => closeAllTabs());
  }

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
      const hasInitialFile =
        state.hasInitialFileParam || Boolean(qs.get('file') || qs.get('uri') || qs.get('path'));
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
      if (!state.activeFileSig) {
        state.activeFileSig = nextSig;
        state.activeFile = {
          ...state.activeFile,
          mtimeMs: data.mtimeMs,
          size: data.size,
          version: data.version || '',
        };
        upsertOpenTab(state.activeFile);
        return;
      }
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
    global.WSPrismMotion?.triggerRefreshSpin?.($('globalRefreshBtn'));
    if (await reloadIfBackendOrVendorUpdated()) return;
    await reloadExpandedDirs();
    await pollProducedDocs();
    if (state.activeFile) await openFilePreview(state.activeFile, { preserveState: true });
    if (state.mode === 'trajectory') await trajectoryCtrl.refresh({ force: true });
    showToast('已刷新工作台');
  });

  // ---------- Update Center ----------
  const ACTIVE_UPDATE_STATES = new Set([
    'checking',
    'downloading',
    'verifying',
    'extracting',
    'backing-up',
    'applying',
    'verifying-install',
    'restarting',
  ]);

  function parseApiErrorMessage(err) {
    const raw = String(err?.message || err || '请求失败');
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.error === 'string' && parsed.error) {
        return parsed.error;
      }
    } catch {}
    return raw;
  }

  function isUpdateJobBusy() {
    return Boolean(
      (state.updateStatus?.job && ACTIVE_UPDATE_STATES.has(state.updateStatus.job.state)) ||
        state.updateReconnectTimer
    );
  }

  function resetUpdateDirtyConfirm() {
    state.updateDirtyConfirmUntil = 0;
    if (state.updateDirtyConfirmTimer) {
      clearTimeout(state.updateDirtyConfirmTimer);
      state.updateDirtyConfirmTimer = null;
    }
  }

  function renderMarkdownSafe(mdText) {
    const raw = String(mdText || '').trim();
    if (!raw) return '<p>暂无更新说明。</p>';
    let html = '';
    if (global.marked?.parse) {
      html = global.marked.parse(raw, { gfm: true, breaks: true });
    } else {
      html = `<pre>${raw.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</pre>`;
    }
    if (global.DOMPurify?.sanitize) {
      html = global.DOMPurify.sanitize(html, {
        FORBID_TAGS: ['img', 'iframe', 'object', 'embed', 'form', 'script', 'style'],
      });
    }
    return html;
  }

  function hardenRenderedLinks(container) {
    if (!container) return;
    for (const a of container.querySelectorAll('a')) {
      const href = a.getAttribute('href') || '';
      if (/^https?:\/\//i.test(href)) {
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noopener noreferrer');
      } else {
        a.removeAttribute('href');
      }
    }
  }

  function formatAssetSize(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '';
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KiB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
  }

  function formatCheckTime(ts) {
    if (!ts) return '';
    try {
      return new Date(ts).toLocaleString([], {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return '';
    }
  }

  function buildManualUpdateCommand(status) {
    const isWin = /win/i.test(navigator.platform || navigator.userAgent || '');
    if (status?.installMode === 'git') {
      return isWin
        ? 'git -C "$env:USERPROFILE\\.gemini\\config\\plugins\\antigravity-sidecar-studio" pull --ff-only'
        : 'git -C ~/.gemini/config/plugins/antigravity-sidecar-studio pull --ff-only';
    }
    return isWin
      ? 'node "$env:USERPROFILE\\.gemini\\config\\plugins\\antigravity-sidecar-studio\\sidecars\\studio\\scripts\\update.mjs" --apply'
      : 'node ~/.gemini/config/plugins/antigravity-sidecar-studio/sidecars/studio/scripts/update.mjs --apply';
  }

  function renderUpdateCenterUi() {
    const st = state.updateStatus;
    const btn = $('updateCenterBtn');
    const dot = $('updateDot');
    if (btn && dot) {
      const hasUpdate = Boolean(st?.updateAvailable);
      const hasUnseen = Boolean(st?.hasUnseenUpdate);
      btn.classList.toggle('has-update', hasUpdate);
      dot.classList.toggle('is-hidden', !hasUnseen);
      btn.title = hasUpdate
        ? `发现新版本 v${st.latest?.version}（点击查看并更新）`
        : st?.currentVersion
          ? `Sidecar Studio v${st.currentVersion} · 检查更新`
          : '检查 Sidecar Studio 更新';
    }

    if (!st || !state.updateModalOpen) return;

    $('updateCurrentBadge').textContent = `v${st.currentVersion || '—'}`;
    $('updateInstallModeBadge').textContent = st.installMode === 'git' ? 'Git 源码版' : '离线安装包';

    const statusPill = $('updateStatusPill');
    statusPill.classList.remove('is-available', 'is-latest', 'is-error');
    const versionRow = $('updateVersionRow');

    if (state.updateCheckingNow) {
      statusPill.textContent = '检查中...';
      versionRow.textContent = `当前版本 v${st.currentVersion}`;
    } else if (st.updateAvailable && st.latest) {
      statusPill.textContent = '有新版本';
      statusPill.classList.add('is-available');
      versionRow.textContent = `v${st.currentVersion} → v${st.latest.version}`;
    } else if (st.lastError && !st.latest) {
      statusPill.textContent = '检查失败';
      statusPill.classList.add('is-error');
      versionRow.textContent = `当前版本 v${st.currentVersion}`;
    } else if (st.latest) {
      statusPill.textContent = '已是最新';
      statusPill.classList.add('is-latest');
      versionRow.textContent = `当前已是最新版 v${st.currentVersion}`;
    } else {
      statusPill.textContent = '未检查';
      versionRow.textContent = `当前版本 v${st.currentVersion}`;
    }

    const metaEl = $('updateReleaseMeta');
    const metaParts = [];
    if (st.latest?.publishedAt) {
      metaParts.push(`发布于 ${formatCheckTime(Date.parse(st.latest.publishedAt))}`);
    }
    if (st.latest?.assetSize) {
      metaParts.push(`离线包 ${formatAssetSize(st.latest.assetSize)}`);
    }
    if (st.latest?.sha256) {
      metaParts.push(`SHA-256 已就绪`);
    } else if (st.latest) {
      metaParts.push(`无 SHA-256 摘要`);
    }
    if (st.lastCheckAt) {
      metaParts.push(`上次检查 ${formatCheckTime(st.lastCheckAt)}`);
    }
    metaEl.textContent = metaParts.join(' · ');
    metaEl.classList.toggle('is-hidden', metaParts.length === 0);

    const alertEl = $('updateAlertBox');
    alertEl.classList.remove('is-warn', 'is-danger', 'is-hidden');
    let alertText = '';
    let alertKind = '';
    if (st.job?.state === 'failed' && st.job.message) {
      alertText = st.job.message;
      alertKind = 'is-danger';
    } else if (st.installMode === 'git' && st.gitInfo && !st.gitInfo.canAutoUpdate) {
      alertText = st.gitInfo.blockReason;
      alertKind = 'is-warn';
    } else if (st.lastError && !state.updateCheckingNow) {
      alertText = `最近检查异常：${st.lastError}`;
      alertKind = 'is-danger';
    }
    if (alertText) {
      alertEl.textContent = alertText;
      if (alertKind) alertEl.classList.add(alertKind);
    } else {
      alertEl.classList.add('is-hidden');
    }

    const releaseLink = $('updateReleaseLink');
    if (st.latest?.releaseUrl && /^https?:\/\//i.test(st.latest.releaseUrl)) {
      releaseLink.href = st.latest.releaseUrl;
      releaseLink.classList.remove('is-hidden');
    } else {
      releaseLink.classList.add('is-hidden');
    }

    const changelogEl = $('updateChangelogBody');
    if (st.latest?.changelog) {
      changelogEl.innerHTML = renderMarkdownSafe(st.latest.changelog);
      hardenRenderedLinks(changelogEl);
    } else if (st.latest) {
      changelogEl.innerHTML = `<p>最新版本 <code>${st.latest.tagName || st.latest.version}</code> 已发布，暂无详细更新说明。</p>`;
    } else {
      changelogEl.textContent = '点击下方「检查更新」即可获取 GitHub Releases 最新版本信息。';
    }

    const job = st.job;
    const progressBox = $('updateProgressBox');
    const showProgress = Boolean(
      job && (ACTIVE_UPDATE_STATES.has(job.state) || state.updateReconnectTimer)
    );
    progressBox.classList.toggle('is-hidden', !showProgress);
    if (showProgress && job) {
      $('updateProgressLabel').textContent = job.message || '正在更新...';
      $('updateProgressDetail').textContent = `${Math.min(100, Math.max(0, job.progress || 0))}%`;
      $('updateProgressFill').style.width = `${Math.min(100, Math.max(4, job.progress || 0))}%`;
    }

    const autoCheckInput = $('updateAutoCheckInput');
    if (autoCheckInput) autoCheckInput.checked = st.autoCheck !== false;
    const mirrorInput = $('updateMirrorInput');
    if (mirrorInput && document.activeElement !== mirrorInput) {
      mirrorInput.value = st.customMirror || '';
    }

    const busy = isUpdateJobBusy() || state.updateCheckingNow;
    $('updateModalClose').disabled = isUpdateJobBusy();
    $('updateCheckNowBtn').disabled = busy;
    $('updateCheckNowBtn').textContent = state.updateCheckingNow ? '检查中...' : '检查更新';

    const canDismiss = Boolean(
      st.updateAvailable && st.latest?.version && st.dismissedVersion !== st.latest.version && !busy
    );
    $('updateDismissBtn').classList.toggle('is-hidden', !canDismiss);

    const applyBtn = $('updateApplyBtn');
    const canShowApply = Boolean(st.updateAvailable && st.latest);
    applyBtn.classList.toggle('is-hidden', !canShowApply);
    const gitBlocked = st.installMode === 'git' && st.gitInfo && !st.gitInfo.canAutoUpdate;
    applyBtn.disabled = busy || gitBlocked;
    if (isUpdateJobBusy()) {
      applyBtn.textContent = '更新中...';
    } else if (Date.now() < state.updateDirtyConfirmUntil) {
      applyBtn.textContent = '仍有未保存修改，确认更新?';
    } else {
      applyBtn.textContent = st.installMode === 'git' ? '拉取并更新' : '立即更新';
    }
  }

  async function refreshUpdateStatus() {
    try {
      const data = await getJson('/api/update/status');
      if (data?.success) {
        state.updateStatus = data;
        renderUpdateCenterUi();
      }
      return data;
    } catch {
      return null;
    }
  }

  function stopUpdatePolling() {
    if (state.updatePollTimer) {
      clearInterval(state.updatePollTimer);
      state.updatePollTimer = null;
    }
    if (state.updateReconnectTimer) {
      clearInterval(state.updateReconnectTimer);
      state.updateReconnectTimer = null;
    }
  }

  function startReconnectWatcher(targetVersion) {
    if (state.updatePollTimer) {
      clearInterval(state.updatePollTimer);
      state.updatePollTimer = null;
    }
    if (state.updateReconnectTimer) return;

    const startedAt = Date.now();
    $('updateProgressLabel').textContent = '正在等待 Sidecar Studio 重启并重新连接...';
    $('updateProgressDetail').textContent = '99%';
    $('updateProgressFill').style.width = '99%';
    $('updateReconnectRow').classList.add('is-hidden');

    const tryReconnect = async () => {
      try {
        const res = await apiFetch('/api/health', { method: 'GET' });
        if (res.ok) {
          const health = await res.json();
          const bootChanged = Boolean(state.bootId && health?.bootId && health.bootId !== state.bootId);
          const versionMatched = Boolean(targetVersion && health?.version === targetVersion);
          if (bootChanged || versionMatched) {
            stopUpdatePolling();
            $('updateProgressLabel').textContent = '重启完成，正在刷新工作台...';
            $('updateProgressFill').style.width = '100%';
            global.location.reload();
            return;
          }
        }
      } catch {}

      if (Date.now() - startedAt > 25000) {
        clearInterval(state.updateReconnectTimer);
        state.updateReconnectTimer = null;
        $('updateProgressLabel').textContent =
          '更新已写入磁盘，等待自动重连超时。请点击「重新连接」或关闭后重新打开 Sidecar Studio 面板。';
        $('updateReconnectRow').classList.remove('is-hidden');
        renderUpdateCenterUi();
      }
    };

    state.updateReconnectTimer = setInterval(tryReconnect, 600);
    tryReconnect();
  }

  function startUpdateJobPolling(targetVersion) {
    if (state.updatePollTimer) clearInterval(state.updatePollTimer);
    $('updateReconnectRow').classList.add('is-hidden');

    const pollOnce = async () => {
      try {
        const data = await getJson('/api/update/status');
        if (!data?.success) return;
        state.updateStatus = data;
        renderUpdateCenterUi();
        const job = data.job;
        if (!job) return;
        if (job.state === 'restarting' || job.state === 'completed') {
          startReconnectWatcher(targetVersion || job.targetVersion);
        } else if (job.state === 'failed') {
          stopUpdatePolling();
          renderUpdateCenterUi();
        }
      } catch {
        // Server exited during restart
        startReconnectWatcher(targetVersion);
      }
    };

    state.updatePollTimer = setInterval(pollOnce, 500);
    pollOnce();
  }

  async function openUpdateModal() {
    closeStagedPopover();
    closeAppearancePopover();
    state.updateModalOpen = true;
    motionOpen($('updateModal'));
    $('updateCenterBtn').setAttribute('aria-expanded', 'true');
    renderUpdateCenterUi();
    await refreshUpdateStatus();
    if (!state.updateStatus?.lastCheckAt && !state.updateCheckingNow) {
      runManualUpdateCheck({ force: false });
    }
  }

  function closeUpdateModal({ restoreFocus = false } = {}) {
    if (isUpdateJobBusy()) return;
    resetUpdateDirtyConfirm();
    state.updateModalOpen = false;
    motionClose($('updateModal'));
    const btn = $('updateCenterBtn');
    btn.setAttribute('aria-expanded', 'false');
    if (restoreFocus) btn.focus();
  }

  async function runManualUpdateCheck({ force = true } = {}) {
    if (state.updateCheckingNow || isUpdateJobBusy()) return;
    state.updateCheckingNow = true;
    renderUpdateCenterUi();
    try {
      const data = await postJson('/api/update/check', { force, background: false });
      if (data?.success) {
        state.updateStatus = data;
        if (data.updateAvailable && data.latest?.version) {
          showToast(`发现新版本 v${data.latest.version}`);
        } else {
          showToast(`当前已是最新版本 v${data.currentVersion}`);
        }
      }
    } catch (err) {
      const msg = parseApiErrorMessage(err);
      showToast(`检查更新失败: ${msg}`, 3200);
      await refreshUpdateStatus();
    } finally {
      state.updateCheckingNow = false;
      renderUpdateCenterUi();
    }
  }

  $('updateCenterBtn').addEventListener('click', () => openUpdateModal());
  $('updateModalClose').addEventListener('click', () => closeUpdateModal({ restoreFocus: true }));
  $('updateModal').addEventListener('click', (e) => {
    if (e.target === $('updateModal')) closeUpdateModal({ restoreFocus: true });
  });
  $('updateCheckNowBtn').addEventListener('click', () => runManualUpdateCheck({ force: true }));

  $('updateApplyBtn').addEventListener('click', async () => {
    if (isUpdateJobBusy() || !state.updateStatus?.updateAvailable) return;
    if (state.activeController?.isDirty?.() && Date.now() >= state.updateDirtyConfirmUntil) {
      state.updateDirtyConfirmUntil = Date.now() + 4000;
      if (state.updateDirtyConfirmTimer) clearTimeout(state.updateDirtyConfirmTimer);
      state.updateDirtyConfirmTimer = setTimeout(() => {
        resetUpdateDirtyConfirm();
        renderUpdateCenterUi();
      }, 4100);
      showToast('当前文档有未保存修改，请在 4 秒内再次点击确认更新', 3200);
      renderUpdateCenterUi();
      return;
    }
    resetUpdateDirtyConfirm();

    const targetVersion = state.updateStatus.latest?.version || '';
    const mirrorVal = $('updateMirrorInput').value.trim();
    try {
      const res = await postJson('/api/update/apply', {
        targetVersion,
        customMirror: mirrorVal,
      });
      if (res?.job) {
        state.updateStatus = { ...state.updateStatus, job: res.job };
        renderUpdateCenterUi();
      }
      startUpdateJobPolling(targetVersion);
    } catch (err) {
      showToast(`启动更新失败: ${parseApiErrorMessage(err)}`, 3400);
      await refreshUpdateStatus();
    }
  });

  $('updateDismissBtn').addEventListener('click', async () => {
    const v = state.updateStatus?.latest?.version;
    if (!v) return;
    try {
      const data = await postJson('/api/update/prefs', { dismissedVersion: v });
      if (data?.success) {
        state.updateStatus = data;
        renderUpdateCenterUi();
        showToast(`已忽略 v${v} 提醒（仍可在更新面板中手动更新）`);
      }
    } catch (err) {
      showToast(parseApiErrorMessage(err));
    }
  });

  $('updateAutoCheckInput').addEventListener('change', async (e) => {
    try {
      const data = await postJson('/api/update/prefs', { autoCheck: Boolean(e.target.checked) });
      if (data?.success) {
        state.updateStatus = data;
        showToast(e.target.checked ? '已开启自动静默检查更新' : '已关闭自动检查更新');
      }
    } catch (err) {
      showToast(parseApiErrorMessage(err));
      renderUpdateCenterUi();
    }
  });

  $('updateMirrorSaveBtn').addEventListener('click', async () => {
    const val = $('updateMirrorInput').value.trim();
    try {
      const data = await postJson('/api/update/prefs', { customMirror: val });
      if (data?.success) {
        state.updateStatus = data;
        renderUpdateCenterUi();
        showToast(val ? '已保存自定义 HTTPS 镜像前缀' : '已清除自定义镜像，恢复官方直连');
      }
    } catch (err) {
      showToast(parseApiErrorMessage(err), 3200);
    }
  });

  $('updateCopyCmdBtn').addEventListener('click', () => {
    copyText(buildManualUpdateCommand(state.updateStatus), '已复制终端更新命令');
  });

  $('updateCopyUrlBtn').addEventListener('click', () => {
    const url =
      state.updateStatus?.latest?.releaseUrl ||
      `https://github.com/${state.updateStatus?.repo?.slug || 'burnerous/antigravity-sidecar-studio'}/releases/latest`;
    copyText(url, '已复制 GitHub Release 链接');
  });

  $('updateAskAiBtn').addEventListener('click', async () => {
    const v = state.updateStatus?.latest?.version;
    const msg = v
      ? `请帮我检查并更新 Sidecar Studio 插件到最新版本 v${v}。`
      : '请帮我检查并更新 Sidecar Studio 插件到最新版本。';
    closeUpdateModal();
    await sendToAgent(msg);
  });

  $('updateReconnectBtn').addEventListener('click', async () => {
    try {
      const res = await apiFetch('/api/health', { method: 'GET' });
      if (res.ok) {
        global.location.reload();
        return;
      }
    } catch {}
    showToast('Sidecar Studio 尚未就绪，请稍候再试或重新打开面板');
  });

  function parseDeepLinkFileParam(rawParam) {
    let clean = String(rawParam || '').trim();
    if (!clean) return null;
    clean = clean.replace(/#.*$/, '');
    if (!clean) return null;
    const hadFileScheme = /^file:\/\//i.test(clean);
    clean = clean.replace(/^file:\/\/(?:localhost)?/i, '');
    try {
      clean = decodeURIComponent(clean);
    } catch {}
    clean = clean.replace(/^\/([A-Za-z]:[\\/])/, '$1');
    if (!clean) return null;

    const isAbs = /^(?:[A-Za-z]:[\\/]|\/|\\\\)/.test(clean);
    if (!isAbs && state.activeRoot) {
      const root = state.activeRoot.replace(/[\\/]+$/, '');
      const sep = root.includes('\\') && !root.includes('/') ? '\\' : '/';
      const relClean = clean.replace(/^\.[\\/]+/, '').replace(/[\\/]+/g, sep);
      clean = `${root}${sep}${relClean}`;
    }

    const name = clean.split(/[\\/]/).filter(Boolean).pop() || clean;
    const extMatch = /\.[^.]+$/.exec(name);
    const ext = extMatch ? extMatch[0].toLowerCase() : '';
    const catMap = {
      '.docx': 'docx',
      '.xlsx': 'xlsx',
      '.xls': 'xlsx',
      '.csv': 'xlsx',
      '.pptx': 'pptx',
      '.pdf': 'pdf',
      '.mp4': 'video',
      '.md': 'markdown',
      '.markdown': 'markdown',
      '.png': 'image',
      '.jpg': 'image',
      '.jpeg': 'image',
      '.webp': 'image',
      '.svg': 'image',
      '.gif': 'image',
      '.bmp': 'image',
      '.ico': 'image',
    };

    let relPath = name;
    if (state.activeRoot) {
      const rootNorm = state.activeRoot.replace(/\\/g, '/').replace(/\/+$/, '');
      const cleanNorm = clean.replace(/\\/g, '/');
      const isWinPath = /^[A-Za-z]:\//.test(rootNorm) || cleanNorm.startsWith('//');
      const rootCmp = isWinPath ? rootNorm.toLowerCase() : rootNorm;
      const cleanCmp = isWinPath ? cleanNorm.toLowerCase() : cleanNorm;
      if (cleanCmp.startsWith(`${rootCmp}/`)) {
        relPath = cleanNorm.slice(rootNorm.length + 1) || name;
      }
    }

    return {
      name,
      path: clean,
      relPath,
      ext,
      category: catMap[ext] || 'code',
      uri: hadFileScheme ? String(rawParam).trim() : '',
    };
  }

  async function openDeepLinkFile(rawParam) {
    const fileObj = parseDeepLinkFileParam(rawParam);
    if (!fileObj) return false;
    await openFilePreview(fileObj);
    try {
      const url = new URL(global.location.href);
      if (url.searchParams.has('file') || url.searchParams.has('uri') || url.searchParams.has('path')) {
        url.searchParams.delete('file');
        url.searchParams.delete('uri');
        url.searchParams.delete('path');
        const nextSearch = url.searchParams.toString();
        const nextUrl = `${url.pathname}${nextSearch ? `?${nextSearch}` : ''}${url.hash || ''}`;
        global.history?.replaceState?.(global.history.state, '', nextUrl);
      }
    } catch {}
    return true;
  }

  // ---------- Bootstrap ----------
  (async function bootstrap() {
    loadStagedComments();
    void hydrateAppearanceFromServer();
    try {
      const health = await getJson('/api/health');
      state.capabilities = health.converters || {};
      state.bootId = health.bootId || '';
      if (Number.isFinite(health?.generation)) {
        state.workspaceGen = Math.max(state.workspaceGen, health.generation);
      }
      syncVendorHealthUi(health);
      if (getMissingFrontendVendors().length > 0 || health?.vendorReady === false) {
        if (health?.vendorReady === true && tryAutoReloadForVendorRecovery()) {
          return;
        }
        startVendorRecoveryWatcher();
      }
    } catch {
      if (getMissingFrontendVendors().length > 0) {
        startVendorRecoveryWatcher();
      }
    }

    const initialUpdateStatus = await refreshUpdateStatus();
    if (initialUpdateStatus?.justUpdated && initialUpdateStatus.lastUpdate?.toVersion) {
      showToast(`✅ Sidecar Studio 已更新至 v${initialUpdateStatus.lastUpdate.toVersion}`, 3800);
      postJson('/api/update/ack-updated', {}).catch(() => {});
    }
    if (initialUpdateStatus?.autoCheck !== false) {
      const stale =
        !initialUpdateStatus?.lastCheckAt ||
        Date.now() - initialUpdateStatus.lastCheckAt >= 6 * 60 * 60 * 1000;
      if (stale) {
        setTimeout(() => {
          postJson('/api/update/check', { force: false, background: true })
            .then((data) => {
              if (data?.success && !data.backgroundError) {
                state.updateStatus = data;
                renderUpdateCenterUi();
              }
            })
            .catch(() => {});
        }, 1500);
      }
    }

    const params = new URLSearchParams(location.search);
    const initialFileParam = params.get('file') || params.get('uri') || params.get('path') || '';
    state.hasInitialFileParam = Boolean(initialFileParam);

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
      await openDeepLinkFile(initialFileParam);
      state.hasInitialFileParam = false;
    }

    const onPopState = () => {
      const qs = new URLSearchParams(location.search);
      const nextFileParam = qs.get('file') || qs.get('uri') || qs.get('path') || '';
      if (nextFileParam) {
        openDeepLinkFile(nextFileParam);
      }
    };
    global.addEventListener('popstate', onPopState);

    state.pollTimers.push(
      setInterval(pollActiveFileStat, 2000),
      setInterval(pollWatchState, 2500),
      setInterval(pollProducedDocs, 3500)
    );

    global.addEventListener('pagehide', () => {
      global.removeEventListener('popstate', onPopState);
      for (const id of state.pollTimers) clearInterval(id);
      state.pollTimers = [];
      stopVendorRecoveryWatcher();
      stopUpdatePolling();
      resetUpdateDirtyConfirm();
      try {
        state.activeController?.destroy?.();
      } catch {}
      try {
        state.activeCleanup?.();
      } catch {}
      try {
        trajectoryCtrl?.destroy?.();
      } catch {}
      try {
        closeAllHoldCtrl?.destroy?.();
      } catch {}
    });
  })();
})(window);
