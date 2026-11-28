(function (global) {
  'use strict';

  function apiFetch(url, options) {
    const f = global.sidecar && typeof global.sidecar.fetch === 'function'
      ? global.sidecar.fetch.bind(global.sidecar)
      : global.fetch.bind(global);
    return f(url, options);
  }

  function getPdfJs() {
    const lib = global.pdfjsLib;
    if (!lib) {
      const err = new Error('离线 PDF 引擎 (pdf.js) 未加载');
      err.code = 'VENDOR_MISSING';
      throw err;
    }
    if (lib.GlobalWorkerOptions && !lib.GlobalWorkerOptions.workerSrc) {
      lib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.js';
    }
    return lib;
  }

  async function mountPdfUrl({
    url,
    stageEl,
    toolbarEl,
    mode = 'document', // 'document' | 'slide'
    prevState = null,
    onSlideChange = null,
    extraToolbarRight = null,
    registerCleanup = null,
    isStale = null,
  }) {
    const pdfjs = getPdfJs();
    let destroyed = false;
    let pdfDoc = null;
    let loadingTask = null;
    let observer = null;
    let scrollEl = null;
    let slideStageEl = null;
    let keyHandler = null;
    let resizeTimer = null;
    let resizeObserver = null;
    const activeRenderTasks = new Set();
    const activeTextLayers = new Set();

    const checkDead = () => destroyed || Boolean(isStale?.());

    const cancelActiveTasks = () => {
      for (const t of activeRenderTasks) {
        try {
          t.cancel();
        } catch {}
      }
      activeRenderTasks.clear();
      for (const tl of activeTextLayers) {
        try {
          tl.cancel();
        } catch {}
      }
      activeTextLayers.clear();
    };

    const destroy = () => {
      if (destroyed) return;
      destroyed = true;
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeObserver?.disconnect();
      observer?.disconnect();
      if (keyHandler) global.removeEventListener('keydown', keyHandler);
      cancelActiveTasks();
      loadingTask?.destroy?.().catch(() => {});
      pdfDoc?.destroy?.().catch(() => {});
      for (const cv of stageEl.querySelectorAll('canvas')) {
        cv.width = 0;
        cv.height = 0;
      }
    };
    registerCleanup?.(destroy);

    if (checkDead()) {
      destroy();
      return { getState: () => ({}), destroy };
    }

    let zoomMode = prevState?.zoomMode || 'fit'; // 'fit' | 'custom'
    let customScale = prevState?.customScale || 1.0;
    let currentPage = Math.max(1, prevState?.page || 1);
    let showOutline = Boolean(prevState?.showOutline);
    const showFilmstrip = prevState?.showFilmstrip !== false;
    let slideContinuous = Boolean(prevState?.slideContinuous);

    const resp = await apiFetch(url, { method: 'GET' });
    if (checkDead()) {
      destroy();
      return { getState: () => ({}), destroy };
    }
    if (!resp.ok) {
      throw new Error(`加载 PDF 失败: HTTP ${resp.status}`);
    }
    const pdfBuffer = await resp.arrayBuffer();
    if (checkDead()) {
      destroy();
      return { getState: () => ({}), destroy };
    }

    loadingTask = pdfjs.getDocument({
      data: new Uint8Array(pdfBuffer),
      cMapUrl: '/vendor/pdfjs/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: '/vendor/pdfjs/standard_fonts/',
      isEvalSupported: false,
    });

    pdfDoc = await loadingTask.promise;
    if (checkDead()) {
      destroy();
      return { getState: () => ({}), destroy };
    }

    const numPages = pdfDoc.numPages;
    if (currentPage > numPages) currentPage = numPages;

    const firstPage = await pdfDoc.getPage(1);
    if (checkDead()) {
      destroy();
      return { getState: () => ({}), destroy };
    }
    const firstBaseViewport = firstPage.getViewport({ scale: 1 });
    const outline = await pdfDoc.getOutline().catch(() => null);
    if (checkDead()) {
      destroy();
      return { getState: () => ({}), destroy };
    }

    // Build toolbar UI
    toolbarEl.classList.remove('is-hidden');
    toolbarEl.innerHTML = '';

    const leftGroup = document.createElement('div');
    leftGroup.className = 'ws-toolbar-group';

    const prevBtn = document.createElement('button');
    prevBtn.type = 'button';
    prevBtn.className = 'ws-btn-ghost';
    prevBtn.textContent = '‹';
    prevBtn.title = '上一页';

    const pageInput = document.createElement('input');
    pageInput.type = 'number';
    pageInput.min = '1';
    pageInput.max = String(numPages);
    pageInput.value = String(currentPage);
    pageInput.style.cssText =
      'width:44px;text-align:center;background:var(--ws-bg);border:1px solid var(--ws-border);border-radius:5px;padding:2px 4px;font-size:11px;';

    const pageTotalSpan = document.createElement('span');
    pageTotalSpan.style.cssText = 'font-size:11px;color:var(--ws-muted);';
    pageTotalSpan.textContent = `/ ${numPages}`;

    const nextBtn = document.createElement('button');
    nextBtn.type = 'button';
    nextBtn.className = 'ws-btn-ghost';
    nextBtn.textContent = '›';
    nextBtn.title = '下一页';

    leftGroup.append(prevBtn, pageInput, pageTotalSpan, nextBtn);

    const zoomOutBtn = document.createElement('button');
    zoomOutBtn.type = 'button';
    zoomOutBtn.className = 'ws-btn-ghost';
    zoomOutBtn.textContent = '−';
    zoomOutBtn.title = '缩小';

    const zoomLabelBtn = document.createElement('button');
    zoomLabelBtn.type = 'button';
    zoomLabelBtn.className = 'ws-btn-ghost';
    zoomLabelBtn.textContent = zoomMode === 'fit' ? '适应' : `${Math.round(customScale * 100)}%`;
    zoomLabelBtn.title = '点击切换适应宽度 / 100%';

    const zoomInBtn = document.createElement('button');
    zoomInBtn.type = 'button';
    zoomInBtn.className = 'ws-btn-ghost';
    zoomInBtn.textContent = '+';
    zoomInBtn.title = '放大';

    leftGroup.append(zoomOutBtn, zoomLabelBtn, zoomInBtn);

    let outlineBtn = null;
    if (mode === 'document' && Array.isArray(outline) && outline.length > 0) {
      outlineBtn = document.createElement('button');
      outlineBtn.type = 'button';
      outlineBtn.className = `ws-chip-btn ${showOutline ? 'is-active' : ''}`;
      const listIcon = global.WSIcons?.render ? global.WSIcons.render('ui-list', { size: 12 }) : '';
      outlineBtn.innerHTML = `${listIcon}<span>目录</span>`;
      leftGroup.appendChild(outlineBtn);
    }

    let slideModeBtn = null;
    if (mode === 'slide') {
      slideModeBtn = document.createElement('button');
      slideModeBtn.type = 'button';
      slideModeBtn.className = `ws-chip-btn ${slideContinuous ? 'is-active' : ''}`;
      slideModeBtn.textContent = slideContinuous ? '单页放映' : '连续浏览';
      leftGroup.appendChild(slideModeBtn);
    }

    toolbarEl.appendChild(leftGroup);
    if (extraToolbarRight) {
      toolbarEl.appendChild(extraToolbarRight);
    }

    stageEl.innerHTML = '';

    function computeScaleForBox(pageViewport1x, containerEl) {
      if (zoomMode === 'custom') return customScale;
      const availW = Math.max((containerEl?.clientWidth || 440) - 32, 220);
      if (mode === 'slide' && !slideContinuous) {
        const availH = Math.max((containerEl?.clientHeight || 360) - 32, 180);
        return Math.min(availW / pageViewport1x.width, availH / pageViewport1x.height, 2.2);
      }
      return Math.min(Math.max(availW / pageViewport1x.width, 0.35), 2.2);
    }

    async function renderPageIntoBox(pageNum, pageBox, scale) {
      if (checkDead()) return;
      const page = await pdfDoc.getPage(pageNum);
      if (checkDead()) return;

      const viewport = page.getViewport({ scale });
      const dpr = Math.min(global.devicePixelRatio || 1, 2);
      const cssW = Math.max(1, Math.floor(viewport.width));
      const cssH = Math.max(1, Math.floor(viewport.height));

      pageBox.innerHTML = '';
      pageBox.style.width = `${cssW}px`;
      pageBox.style.height = `${cssH}px`;
      pageBox.style.setProperty('--scale-factor', String(scale));
      pageBox.style.setProperty('--user-unit', '1');
      pageBox.style.setProperty('--total-scale-factor', String(scale));

      const canvasWrap = document.createElement('div');
      canvasWrap.className = 'canvasWrapper';
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.floor(viewport.width * dpr));
      canvas.height = Math.max(1, Math.floor(viewport.height * dpr));
      canvas.style.width = `${cssW}px`;
      canvas.style.height = `${cssH}px`;
      canvasWrap.appendChild(canvas);

      const textLayerDiv = document.createElement('div');
      textLayerDiv.className = 'textLayer';
      textLayerDiv.style.setProperty('--scale-factor', String(scale));

      pageBox.append(canvasWrap, textLayerDiv);

      const ctx = canvas.getContext('2d', { alpha: false });
      const renderTask = page.render({
        canvasContext: ctx,
        viewport,
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
      });
      activeRenderTasks.add(renderTask);

      try {
        await renderTask.promise;
      } catch (err) {
        if (err?.name !== 'RenderingCancelledException') {
          console.warn('PDF render error:', err);
        }
        return;
      } finally {
        activeRenderTasks.delete(renderTask);
      }

      if (checkDead()) return;

      try {
        const textContent = await page.getTextContent();
        if (checkDead()) return;
        const tlTask = pdfjs.renderTextLayer({
          textContentSource: textContent,
          container: textLayerDiv,
          viewport,
          textDivs: [],
        });
        activeTextLayers.add(tlTask);
        await tlTask.promise;
        activeTextLayers.delete(tlTask);
      } catch (err) {
        if (err?.name !== 'AbortException') {
          console.warn('PDF textLayer error:', err);
        }
      }
    }

    async function resolveDestPage(dest) {
      try {
        const resolved = typeof dest === 'string' ? await pdfDoc.getDestination(dest) : dest;
        if (!Array.isArray(resolved) || !resolved[0]) return null;
        const idx = await pdfDoc.getPageIndex(resolved[0]);
        return idx + 1;
      } catch {
        return null;
      }
    }

    function renderOutlineItems(items, parentEl, depth) {
      for (const item of items) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ws-toc-item';
        btn.style.paddingLeft = `${6 + depth * 12}px`;
        btn.textContent = item.title || '(无标题)';
        btn.title = item.title || '';
        btn.addEventListener('click', async () => {
          const target = await resolveDestPage(item.dest);
          if (target) goToPage(target);
        });
        parentEl.appendChild(btn);
        if (Array.isArray(item.items) && item.items.length) {
          renderOutlineItems(item.items, parentEl, depth + 1);
        }
      }
    }

    function updatePageUi(pageNum) {
      currentPage = Math.min(Math.max(1, pageNum), numPages);
      pageInput.value = String(currentPage);
      prevBtn.disabled = currentPage <= 1;
      nextBtn.disabled = currentPage >= numPages;
      if (onSlideChange) onSlideChange(currentPage - 1);
    }

    async function renderDocumentOrContinuous() {
      cancelActiveTasks();
      if (observer) {
        observer.disconnect();
        observer = null;
      }
      stageEl.innerHTML = '';

      const layout = document.createElement('div');
      layout.className = 'ws-pdf-layout';

      if (outlineBtn && showOutline) {
        const outlineEl = document.createElement('aside');
        outlineEl.className = 'ws-pdf-outline';
        const title = document.createElement('div');
        title.className = 'ws-reader-toc-title';
        title.textContent = '文档目录';
        outlineEl.appendChild(title);
        renderOutlineItems(outline, outlineEl, 0);
        layout.appendChild(outlineEl);
      }

      scrollEl = document.createElement('div');
      scrollEl.className = 'ws-pdf-scroll';
      const viewerDiv = document.createElement('div');
      viewerDiv.className = 'pdfViewer';
      viewerDiv.style.display = 'flex';
      viewerDiv.style.flexDirection = 'column';
      viewerDiv.style.gap = '12px';
      scrollEl.appendChild(viewerDiv);
      layout.appendChild(scrollEl);
      stageEl.appendChild(layout);

      const scale = computeScaleForBox(firstBaseViewport, scrollEl);
      zoomLabelBtn.textContent =
        zoomMode === 'fit' ? `适应 (${Math.round(scale * 100)}%)` : `${Math.round(scale * 100)}%`;

      const pageBoxes = [];
      for (let p = 1; p <= numPages; p++) {
        const box = document.createElement('div');
        box.className = 'page';
        box.dataset.pageNumber = String(p);
        box.dataset.rendered = '0';
        box.style.width = `${Math.floor(firstBaseViewport.width * scale)}px`;
        box.style.height = `${Math.floor(firstBaseViewport.height * scale)}px`;
        box.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#64748b;font-size:12px;">第 ${p} 页</div>`;
        viewerDiv.appendChild(box);
        pageBoxes.push(box);
      }

      observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            const box = entry.target;
            const p = Number(box.dataset.pageNumber);
            if (box.dataset.rendered === '0') {
              box.dataset.rendered = '1';
              renderPageIntoBox(p, box, scale);
            }
            updatePageUi(p);
            if (numPages > 12) {
              for (const b of pageBoxes) {
                const bp = Number(b.dataset.pageNumber);
                if (b.dataset.rendered === '1' && Math.abs(bp - p) > 6) {
                  for (const cv of b.querySelectorAll('canvas')) {
                    cv.width = 0;
                    cv.height = 0;
                  }
                  b.dataset.rendered = '0';
                  b.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#64748b;font-size:12px;">第 ${bp} 页</div>`;
                }
              }
            }
          }
        },
        { root: scrollEl, rootMargin: '260px 0px', threshold: 0.15 }
      );

      for (const box of pageBoxes) observer.observe(box);

      if (prevState?.scrollTop > 0) {
        scrollEl.scrollTop = prevState.scrollTop;
      } else if (currentPage > 1 && pageBoxes[currentPage - 1]) {
        pageBoxes[currentPage - 1].scrollIntoView({ block: 'start' });
      }
    }

    const thumbCanvases = [];

    async function renderSlideStage() {
      cancelActiveTasks();
      if (observer) {
        observer.disconnect();
        observer = null;
      }
      stageEl.innerHTML = '';

      const shell = document.createElement('div');
      shell.className = 'ws-slide-shell';

      slideStageEl = document.createElement('div');
      slideStageEl.className = 'ws-slide-stage';
      const viewerWrap = document.createElement('div');
      viewerWrap.className = 'pdfViewer';
      const slideBox = document.createElement('div');
      slideBox.className = 'page';
      viewerWrap.appendChild(slideBox);
      slideStageEl.appendChild(viewerWrap);
      shell.appendChild(slideStageEl);

      const filmstrip = document.createElement('div');
      filmstrip.className = 'ws-slide-filmstrip';
      thumbCanvases.length = 0;

      for (let p = 1; p <= numPages; p++) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `ws-slide-thumb ${p === currentPage ? 'is-active' : ''}`;
        btn.dataset.page = String(p);
        const c = document.createElement('canvas');
        c.width = 96;
        c.height = 54;
        c.style.width = '96px';
        c.style.height = '54px';
        c.style.display = 'block';
        const lbl = document.createElement('div');
        lbl.className = 'ws-slide-thumb-label';
        lbl.textContent = String(p);
        btn.append(c, lbl);
        btn.addEventListener('click', () => goToPage(p));
        filmstrip.appendChild(btn);
        thumbCanvases.push({ pageNum: p, canvas: c, btn, rendered: false });
      }
      if (showFilmstrip) shell.appendChild(filmstrip);

      stageEl.appendChild(shell);

      const renderCurrentSlide = async () => {
        if (checkDead()) return;
        const page = await pdfDoc.getPage(currentPage);
        if (checkDead()) return;
        const vp1 = page.getViewport({ scale: 1 });
        const scale = computeScaleForBox(vp1, slideStageEl);
        zoomLabelBtn.textContent =
          zoomMode === 'fit' ? `适应 (${Math.round(scale * 100)}%)` : `${Math.round(scale * 100)}%`;
        await renderPageIntoBox(currentPage, slideBox, scale);
        if (checkDead()) return;
        for (const tc of thumbCanvases) {
          tc.btn.classList.toggle('is-active', tc.pageNum === currentPage);
        }
        const activeBtn = filmstrip.querySelector('.ws-slide-thumb.is-active');
        activeBtn?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
      };

      await renderCurrentSlide();
      if (checkDead()) return;

      (async () => {
        for (const tc of thumbCanvases) {
          if (checkDead()) break;
          if (tc.rendered) continue;
          tc.rendered = true;
          try {
            const p = await pdfDoc.getPage(tc.pageNum);
            if (checkDead()) break;
            const vp1 = p.getViewport({ scale: 1 });
            const tScale = Math.min(96 / vp1.width, 64 / vp1.height);
            const vp = p.getViewport({ scale: tScale });
            const thumbDpr = Math.min(global.devicePixelRatio || 1, 2);
            const tCssW = Math.max(1, Math.floor(vp.width));
            const tCssH = Math.max(1, Math.floor(vp.height));
            tc.canvas.width = Math.max(1, Math.floor(vp.width * thumbDpr));
            tc.canvas.height = Math.max(1, Math.floor(vp.height * thumbDpr));
            tc.canvas.style.width = `${tCssW}px`;
            tc.canvas.style.height = `${tCssH}px`;
            await p.render({
              canvasContext: tc.canvas.getContext('2d'),
              viewport: vp,
              transform: thumbDpr !== 1 ? [thumbDpr, 0, 0, thumbDpr, 0, 0] : undefined,
            }).promise;
          } catch {}
        }
      })();

      slideStageEl._renderCurrentSlide = renderCurrentSlide;
    }

    function goToPage(p) {
      const target = Math.min(Math.max(1, p), numPages);
      updatePageUi(target);
      if (mode === 'slide' && !slideContinuous) {
        slideStageEl?._renderCurrentSlide?.();
      } else if (scrollEl) {
        const box = scrollEl.querySelector(`.page[data-page-number="${target}"]`);
        box?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }

    async function rebuildView() {
      if (checkDead()) return;
      if (mode === 'slide' && !slideContinuous) {
        await renderSlideStage();
      } else {
        await renderDocumentOrContinuous();
      }
    }

    prevBtn.addEventListener('click', () => goToPage(currentPage - 1));
    nextBtn.addEventListener('click', () => goToPage(currentPage + 1));
    pageInput.addEventListener('change', () => {
      const v = Number(pageInput.value);
      if (Number.isFinite(v)) goToPage(v);
    });

    zoomOutBtn.addEventListener('click', () => {
      const cur =
        zoomMode === 'fit'
          ? computeScaleForBox(firstBaseViewport, scrollEl || slideStageEl)
          : customScale;
      zoomMode = 'custom';
      customScale = Math.max(0.35, Number((cur - 0.15).toFixed(2)));
      rebuildView();
    });

    zoomInBtn.addEventListener('click', () => {
      const cur =
        zoomMode === 'fit'
          ? computeScaleForBox(firstBaseViewport, scrollEl || slideStageEl)
          : customScale;
      zoomMode = 'custom';
      customScale = Math.min(2.5, Number((cur + 0.15).toFixed(2)));
      rebuildView();
    });

    zoomLabelBtn.addEventListener('click', () => {
      if (zoomMode === 'fit') {
        zoomMode = 'custom';
        customScale = 1.0;
      } else {
        zoomMode = 'fit';
      }
      rebuildView();
    });

    outlineBtn?.addEventListener('click', () => {
      showOutline = !showOutline;
      outlineBtn.classList.toggle('is-active', showOutline);
      rebuildView();
    });

    slideModeBtn?.addEventListener('click', () => {
      slideContinuous = !slideContinuous;
      slideModeBtn.classList.toggle('is-active', slideContinuous);
      slideModeBtn.textContent = slideContinuous ? '单页放映' : '连续浏览';
      rebuildView();
    });

    if (mode === 'slide') {
      keyHandler = (e) => {
        if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
        if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
          e.preventDefault();
          goToPage(currentPage - 1);
        } else if (e.key === 'ArrowRight' || e.key === 'PageDown') {
          e.preventDefault();
          goToPage(currentPage + 1);
        }
      };
      global.addEventListener('keydown', keyHandler);
    }

    resizeObserver = new ResizeObserver(() => {
      if (zoomMode !== 'fit' || checkDead()) return;
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (!checkDead() && zoomMode === 'fit') {
          if (mode === 'slide' && !slideContinuous) {
            slideStageEl?._renderCurrentSlide?.();
          } else {
            rebuildView();
          }
        }
      }, 180);
    });
    resizeObserver.observe(stageEl);

    await rebuildView();
    if (checkDead()) {
      destroy();
      return { getState: () => ({}), destroy };
    }

    return {
      goToPage,
      getState: () => ({
        zoomMode,
        customScale,
        page: currentPage,
        scrollTop: scrollEl?.scrollTop || 0,
        showOutline,
        slideContinuous,
      }),
      destroy,
    };
  }

  async function renderPdfPreview(ctx) {
    const {
      file,
      stageEl,
      toolbarEl,
      conversationId,
      prevState,
      onStatusBadge,
      registerCleanup,
      isStale,
    } = ctx;
    onStatusBadge?.('pdf.js 高保真');
    const rawUrl = `/api/file/raw?path=${encodeURIComponent(file.path)}&conversationId=${encodeURIComponent(
      conversationId || ''
    )}&t=${Math.floor(file.mtimeMs || Date.now())}`;

    return mountPdfUrl({
      url: rawUrl,
      stageEl,
      toolbarEl,
      mode: 'document',
      prevState,
      registerCleanup,
      isStale,
    });
  }

  global.WSModules = global.WSModules || {};
  global.WSModules.mountPdfUrl = mountPdfUrl;
  global.WSModules.renderPdfPreview = renderPdfPreview;
})(window);
