(function (global) {
  'use strict';

  const DRAW_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';

  function apiFetch(url, options) {
    const f = global.sidecar && typeof global.sidecar.fetch === 'function'
      ? global.sidecar.fetch.bind(global.sidecar)
      : global.fetch.bind(global);
    return f(url, options);
  }

  function readEditableText(root) {
    let out = '';
    function walk(node, isBlockStart) {
      if (!node) return;
      if (node.nodeType === 3) {
        out += node.nodeValue || '';
        return;
      }
      if (node.nodeType !== 1) return;
      const tag = node.tagName;
      if (tag === 'BR') {
        out += '\n';
        return;
      }
      const isBlock = tag === 'DIV' || tag === 'P' || tag === 'LI';
      if (isBlock && !isBlockStart && out.length > 0 && !out.endsWith('\n')) {
        out += '\n';
      }
      for (let i = 0; i < node.childNodes.length; i++) {
        walk(node.childNodes[i], false);
      }
    }
    walk(root, true);
    return out.replace(/\r\n/g, '\n');
  }

  function extractRPrFromParagraph(pNode) {
    for (const child of pNode.children) {
      if (child.localName === 'r') {
        const rPr = firstChild(child, 'rPr');
        if (rPr) return rPr.cloneNode(true);
      }
    }
    const pPr = firstChild(pNode, 'pPr');
    const defRPr = pPr ? firstChild(pPr, 'defRPr') : null;
    if (defRPr) {
      const rPr = pNode.ownerDocument.createElementNS(DRAW_NS, 'a:rPr');
      for (const attr of defRPr.attributes) {
        rPr.setAttribute(attr.name, attr.value);
      }
      for (const dc of defRPr.children) {
        rPr.appendChild(dc.cloneNode(true));
      }
      return rPr;
    }
    return null;
  }

  function updatePptxParagraphNode(xmlDoc, pNode, newText) {
    if (!xmlDoc || !pNode) return;
    const templateRPr = extractRPrFromParagraph(pNode);
    const endParaRPr = firstChild(pNode, 'endParaRPr');

    const toRemove = [];
    for (const child of pNode.children) {
      if (['r', 'br', 'fld'].includes(child.localName)) {
        toRemove.push(child);
      }
    }
    for (const n of toRemove) pNode.removeChild(n);

    const lines = String(newText ?? '').split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) {
        const brEl = xmlDoc.createElementNS(DRAW_NS, 'a:br');
        if (templateRPr) brEl.appendChild(templateRPr.cloneNode(true));
        if (endParaRPr) pNode.insertBefore(brEl, endParaRPr);
        else pNode.appendChild(brEl);
      }
      const rEl = xmlDoc.createElementNS(DRAW_NS, 'a:r');
      if (templateRPr) rEl.appendChild(templateRPr.cloneNode(true));
      const tEl = xmlDoc.createElementNS(DRAW_NS, 'a:t');
      tEl.textContent = lines[i];
      rEl.appendChild(tEl);
      if (endParaRPr) pNode.insertBefore(rEl, endParaRPr);
      else pNode.appendChild(rEl);
    }
  }

  function childElements(el, localName = null) {
    const out = [];
    if (!el) return out;
    for (const node of el.children) {
      if (!localName || node.localName === localName) out.push(node);
    }
    return out;
  }

  function firstChild(el, localName) {
    if (!el) return null;
    for (const node of el.children) {
      if (node.localName === localName) return node;
    }
    return null;
  }

  function findDescendant(el, localName) {
    if (!el) return null;
    for (const node of el.getElementsByTagName('*')) {
      if (node.localName === localName) return node;
    }
    return null;
  }

  function normalizeZipPath(baseDir, target) {
    if (!target) return '';
    if (target.startsWith('/')) return target.slice(1);
    const parts = (baseDir ? baseDir.split('/') : []).concat(target.split('/'));
    const stack = [];
    for (const p of parts) {
      if (!p || p === '.') continue;
      if (p === '..') stack.pop();
      else stack.push(p);
    }
    return stack.join('/');
  }

  function parseXml(xmlText) {
    return new DOMParser().parseFromString(xmlText, 'application/xml');
  }

  function parseRels(xmlText, baseDir) {
    const map = new Map();
    if (!xmlText) return map;
    const doc = parseXml(xmlText);
    for (const rel of doc.getElementsByTagName('*')) {
      if (rel.localName !== 'Relationship') continue;
      const id = rel.getAttribute('Id');
      const type = rel.getAttribute('Type') || '';
      const target = rel.getAttribute('Target') || '';
      const mode = rel.getAttribute('TargetMode') || '';
      if (id && target && mode !== 'External') {
        map.set(id, { type, target: normalizeZipPath(baseDir, target) });
      }
    }
    return map;
  }

  function parseThemeColors(xmlText) {
    const colors = {
      dk1: '#111827',
      lt1: '#ffffff',
      dk2: '#1f2937',
      lt2: '#f3f4f6',
      tx1: '#111827',
      bg1: '#ffffff',
      tx2: '#374151',
      bg2: '#f3f4f6',
      accent1: '#2563eb',
      accent2: '#ea580c',
      accent3: '#64748b',
      accent4: '#eab308',
      accent5: '#0ea5e9',
      accent6: '#16a34a',
    };
    if (!xmlText) return colors;
    const doc = parseXml(xmlText);
    const scheme = findDescendant(doc, 'clrScheme');
    if (!scheme) return colors;
    for (const child of scheme.children) {
      const srgb = findDescendant(child, 'srgbClr');
      const sys = findDescendant(child, 'sysClr');
      const hex = srgb?.getAttribute('val') || sys?.getAttribute('lastClr');
      if (hex && /^[0-9a-f]{6}$/i.test(hex)) {
        colors[child.localName] = `#${hex}`;
      }
    }
    colors.tx1 = colors.dk1;
    colors.bg1 = colors.lt1;
    colors.tx2 = colors.dk2;
    colors.bg2 = colors.lt2;
    return colors;
  }

  function resolveColor(containerEl, themeColors) {
    if (!containerEl) return '';
    const solid = firstChild(containerEl, 'solidFill') || containerEl;
    const srgb = firstChild(solid, 'srgbClr');
    if (srgb) {
      const v = srgb.getAttribute('val');
      if (v && /^[0-9a-fA-F]{6}$/.test(v)) return `#${v}`;
    }
    const scheme = firstChild(solid, 'schemeClr');
    if (scheme) {
      const v = scheme.getAttribute('val');
      if (v && themeColors[v]) return themeColors[v];
    }
    return '';
  }

  function readXfrm(node) {
    const spPr = firstChild(node, 'spPr');
    const xfrm = firstChild(spPr, 'xfrm') || firstChild(node, 'xfrm');
    if (!xfrm) return null;
    const off = firstChild(xfrm, 'off');
    const ext = firstChild(xfrm, 'ext');
    if (!off || !ext) return null;
    return {
      x: Number(off.getAttribute('x') || 0),
      y: Number(off.getAttribute('y') || 0),
      cx: Number(ext.getAttribute('cx') || 0),
      cy: Number(ext.getAttribute('cy') || 0),
    };
  }

  function extractParagraphs(txBody, themeColors) {
    const out = [];
    if (!txBody) return out;
    const serializer = new XMLSerializer();
    for (const p of childElements(txBody, 'p')) {
      const pPr = firstChild(p, 'pPr');
      const alignMap = { ctr: 'center', r: 'right', just: 'justify', l: 'left' };
      const align = alignMap[pPr?.getAttribute('algn')] || 'left';
      const lvl = Number(pPr?.getAttribute('lvl') || 0);
      const hasBullet = Boolean(firstChild(pPr, 'buChar') || firstChild(pPr, 'buAutoNum'));
      const buChar = firstChild(pPr, 'buChar')?.getAttribute('char') || (hasBullet ? '•' : '');

      const runs = [];
      let hasField = false;
      let hasLink = false;
      let hasUnsupportedNode = false;
      const rPrSigs = new Set();
      for (const child of p.children) {
        if (child.localName === 'pPr' || child.localName === 'endParaRPr') continue;
        if (child.localName === 'r') {
          const rPr = firstChild(child, 'rPr');
          const tNode = firstChild(child, 't');
          const t = tNode?.textContent ?? '';
          const sz = rPr?.getAttribute('sz') ? Number(rPr.getAttribute('sz')) / 100 : 16;
          const bold = rPr?.getAttribute('b') === '1';
          const italic = rPr?.getAttribute('i') === '1';
          const underline = rPr?.getAttribute('u') && rPr.getAttribute('u') !== 'none';
          const color = resolveColor(rPr, themeColors) || '';
          const rPrSig = rPr ? serializer.serializeToString(rPr) : '';
          rPrSigs.add(rPrSig);
          if (rPr && (findDescendant(rPr, 'hlinkClick') || findDescendant(rPr, 'hlinkMouseOver'))) {
            hasLink = true;
          }
          runs.push({ text: t, sz, bold, italic, underline, color, rNode: child, tNode, isField: false });
        } else if (child.localName === 'br') {
          runs.push({ text: '\n', sz: 16, rNode: child, tNode: null, isField: false });
        } else if (child.localName === 'fld') {
          hasField = true;
          const rPr = firstChild(child, 'rPr');
          const tNode = firstChild(child, 't');
          const t = tNode?.textContent ?? '';
          const sz = rPr?.getAttribute('sz') ? Number(rPr.getAttribute('sz')) / 100 : 14;
          const color = resolveColor(rPr, themeColors) || '';
          if (t) {
            runs.push({ text: t, sz, bold: false, italic: false, underline: false, color, rNode: child, tNode, isField: true });
          }
        } else {
          hasUnsupportedNode = true;
        }
      }
      out.push({
        pNode: p,
        align,
        lvl,
        bullet: buChar,
        runs,
        hasField,
        hasLink,
        hasUnsupportedNode,
        hasMixedStyles: rPrSigs.size > 1,
      });
    }
    return out;
  }

  async function parsePptxBuffer(buffer, { blobUrls = [], isDestroyed = null } = {}) {
    if (typeof global.JSZip?.loadAsync !== 'function') {
      const err = new Error('离线幻灯片解析引擎 (JSZip) 未加载');
      err.code = 'VENDOR_MISSING';
      throw err;
    }
    const zip = await global.JSZip.loadAsync(buffer);

    const readText = async (path) => {
      const entry = zip.file(path);
      return entry ? entry.async('text') : '';
    };

    const readImageUrl = async (path) => {
      if (isDestroyed?.()) return '';
      const entry = zip.file(path);
      if (!entry) return '';
      const blob = await entry.async('blob');
      const url = URL.createObjectURL(blob);
      if (isDestroyed?.()) {
        try {
          URL.revokeObjectURL(url);
        } catch {}
        return '';
      }
      blobUrls.push(url);
      return url;
    };

    const presXml = await readText('ppt/presentation.xml');
    if (!presXml) throw new Error('无效的 PPTX 文件（缺少 ppt/presentation.xml）');
    const presDoc = parseXml(presXml);
    const sldSz = findDescendant(presDoc, 'sldSz');
    const slideCx = Number(sldSz?.getAttribute('cx') || 9144000);
    const slideCy = Number(sldSz?.getAttribute('cy') || 5143500);

    const presRels = parseRels(await readText('ppt/_rels/presentation.xml.rels'), 'ppt');

    let themeColors = parseThemeColors('');
    for (const rel of presRels.values()) {
      if (rel.type.endsWith('/theme')) {
        themeColors = parseThemeColors(await readText(rel.target));
        break;
      }
    }

    const slideTargets = [];
    for (const node of presDoc.getElementsByTagName('*')) {
      if (node.localName !== 'sldId') continue;
      const rid =
        node.getAttribute('r:id') ||
        node.getAttributeNS(
          'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
          'id'
        );
      const rel = rid ? presRels.get(rid) : null;
      if (rel?.target) slideTargets.push(rel.target);
    }

    const slides = [];
    let hasMissingParts = false;
    for (let idx = 0; idx < slideTargets.length; idx++) {
      if (isDestroyed?.()) break;
      const sPath = slideTargets[idx];
      const sXml = await readText(sPath);
      if (!sXml) {
        hasMissingParts = true;
        continue;
      }
      const sDoc = parseXml(sXml);

      const sDir = sPath.split('/').slice(0, -1).join('/');
      const sName = sPath.split('/').pop();
      const relsPath = `${sDir}/_rels/${sName}.rels`;
      const sRels = parseRels(await readText(relsPath), sDir);

      let bgColor = '#ffffff';
      const bgPr = findDescendant(sDoc, 'bgPr');
      const resolvedBg = resolveColor(bgPr, themeColors);
      if (resolvedBg) bgColor = resolvedBg;

      let notes = '';
      let notesPath = '';
      let nDoc = null;
      let notesTxBodyNode = null;
      let notesParagraphs = [];
      for (const rel of sRels.values()) {
        if (rel.type.endsWith('/notesSlide')) {
          const nXml = await readText(rel.target);
          if (!nXml) {
            hasMissingParts = true;
          } else {
            notesPath = rel.target;
            nDoc = parseXml(nXml);
            let bodySp = null;
            for (const sp of nDoc.getElementsByTagName('*')) {
              if (sp.localName !== 'sp') continue;
              const nvSpPr = firstChild(sp, 'nvSpPr');
              const nvPr = firstChild(nvSpPr, 'nvPr');
              const ph = firstChild(nvPr, 'ph');
              const phType = ph?.getAttribute('type') || '';
              if (phType === 'body') {
                bodySp = sp;
                break;
              }
            }
            if (bodySp) {
              notesTxBodyNode = firstChild(bodySp, 'txBody');
              if (notesTxBodyNode) {
                notesParagraphs = extractParagraphs(notesTxBodyNode, themeColors);
                notes = notesParagraphs.map((p) => p.runs.map((r) => r.text).join('')).join('\n').trim();
              }
            } else {
              const texts = [];
              for (const tNode of nDoc.getElementsByTagName('*')) {
                if (tNode.localName === 't' && tNode.textContent) {
                  texts.push(tNode.textContent);
                }
              }
              notes = texts.join(' ').replace(/\s+/g, ' ').trim();
            }
          }
          break;
        }
      }

      const elements = [];
      const cSld = findDescendant(sDoc, 'cSld');
      const spTree = cSld ? firstChild(cSld, 'spTree') : null;

      const walkTree = async (container, offsetX = 0, offsetY = 0) => {
        if (!container || isDestroyed?.()) return;
        for (const child of container.children) {
          if (isDestroyed?.()) break;
          if (child.localName === 'sp') {
            const xfrm = readXfrm(child);
            if (!xfrm) continue;
            const spPr = firstChild(child, 'spPr');
            const fill = resolveColor(spPr, themeColors);
            const ln = firstChild(spPr, 'ln');
            const border = resolveColor(ln, themeColors);
            const txBody = firstChild(child, 'txBody');
            const paragraphs = extractParagraphs(txBody, themeColors);
            elements.push({
              kind: 'shape',
              x: offsetX + xfrm.x,
              y: offsetY + xfrm.y,
              cx: xfrm.cx,
              cy: xfrm.cy,
              fill,
              border,
              txBodyNode: txBody,
              paragraphs,
            });
          } else if (child.localName === 'pic') {
            const xfrm = readXfrm(child);
            if (!xfrm) continue;
            const blip = findDescendant(child, 'blip');
            const embedId =
              blip?.getAttribute('r:embed') ||
              blip?.getAttributeNS(
                'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
                'embed'
              );
            const rel = embedId ? sRels.get(embedId) : null;
            if (rel?.target) {
              const imgUrl = await readImageUrl(rel.target);
              if (imgUrl) {
                elements.push({
                  kind: 'image',
                  x: offsetX + xfrm.x,
                  y: offsetY + xfrm.y,
                  cx: xfrm.cx,
                  cy: xfrm.cy,
                  src: imgUrl,
                });
              }
            }
          } else if (child.localName === 'graphicFrame') {
            const xfrm = readXfrm(child);
            const tbl = findDescendant(child, 'tbl');
            if (xfrm && tbl) {
              const rows = [];
              for (const tr of childElements(tbl, 'tr')) {
                const cells = [];
                for (const tc of childElements(tr, 'tc')) {
                  const txBody = firstChild(tc, 'txBody');
                  const tcPr = firstChild(tc, 'tcPr');
                  const fill = resolveColor(tcPr, themeColors);
                  const paras = extractParagraphs(txBody, themeColors);
                  const text = paras.map((p) => p.runs.map((r) => r.text).join('')).join('\n');
                  cells.push({ text, fill, txBodyNode: txBody, paragraphs: paras });
                }
                rows.push(cells);
              }
              elements.push({
                kind: 'table',
                x: offsetX + xfrm.x,
                y: offsetY + xfrm.y,
                cx: xfrm.cx,
                cy: xfrm.cy,
                rows,
              });
            }
          } else if (child.localName === 'grpSp') {
            const grpPr = firstChild(child, 'grpSpPr');
            const xfrm = grpPr ? firstChild(grpPr, 'xfrm') : null;
            const off = xfrm ? firstChild(xfrm, 'off') : null;
            const chOff = xfrm ? firstChild(xfrm, 'chOff') : null;
            const dx =
              Number(off?.getAttribute('x') || 0) - Number(chOff?.getAttribute('x') || 0);
            const dy =
              Number(off?.getAttribute('y') || 0) - Number(chOff?.getAttribute('y') || 0);
            await walkTree(child, offsetX + dx, offsetY + dy);
          }
        }
      };

      await walkTree(spTree, 0, 0);
      slides.push({
        index: slides.length,
        sPath,
        sDoc,
        bgColor,
        elements,
        notes,
        notesPath,
        nDoc,
        notesTxBodyNode,
        notesParagraphs,
      });
    }

    return { zip, slideCx, slideCy, slides, blobUrls, themeColors, hasMissingParts };
  }

  async function renderPptxPreview(ctx) {
    const {
      file,
      stageEl,
      toolbarEl,
      conversationId,
      prevState,
      onStatusBadge,
      onSaveFile,
      showToast,
      registerCleanup,
    } = ctx;
    const mountPdfUrl = global.WSModules?.mountPdfUrl;
    let destroyed = false;
    let modeSeq = 0;
    const allocatedBlobUrls = [];
    let slideIndex = Math.max(0, prevState?.slideIndex || 0);
    let activeMode = prevState?.userLockedMode || 'auto'; // 'auto' | 'pdf' | 'ooxml'
    let showNotes = Boolean(prevState?.showNotes);
    let editMode = Boolean(prevState?.editMode);
    let autoSave = prevState?.autoSave !== false;
    let dirty = false;
    let saving = false;
    let editSeq = 0;
    let autoSaveTimer = null;
    let justSavedTimer = null;
    let pdfCtrl = null;
    let pdfResult = null;
    let resizeObserver = null;
    let resizeRafId = 0;
    let lastObservedW = 0;
    let lastObservedH = 0;
    let ooxmlKeyHandler = null;
    let globalKeyHandler = null;
    let parsed = null;

    const modifiedSlides = new Set();
    const modifiedNotesSlides = new Set();
    let currentEditBtn = null;
    let currentAutoSaveBtn = null;
    let currentSaveBtn = null;
    let refreshCurrentThumbFn = null;

    function clearOoxmlListeners() {
      if (resizeRafId) {
        global.cancelAnimationFrame(resizeRafId);
        resizeRafId = 0;
      }
      resizeObserver?.disconnect();
      resizeObserver = null;
      if (ooxmlKeyHandler) {
        global.removeEventListener('keydown', ooxmlKeyHandler);
        ooxmlKeyHandler = null;
      }
    }

    const revokeAllocatedBlobs = () => {
      while (allocatedBlobUrls.length) {
        try {
          URL.revokeObjectURL(allocatedBlobUrls.pop());
        } catch {}
      }
    };

    const destroy = () => {
      revokeAllocatedBlobs();
      if (destroyed) return;
      destroyed = true;
      modeSeq += 1;
      if (autoSaveTimer) clearTimeout(autoSaveTimer);
      if (justSavedTimer) clearTimeout(justSavedTimer);
      if (globalKeyHandler) global.removeEventListener('keydown', globalKeyHandler);
      clearOoxmlListeners();
      pdfCtrl?.destroy();
    };
    registerCleanup?.(destroy);

    onStatusBadge?.('正在解析幻灯片...');
    const rawUrl = `/api/file/raw?path=${encodeURIComponent(file.path)}&conversationId=${encodeURIComponent(
      conversationId || ''
    )}&t=${Math.floor(file.mtimeMs || Date.now())}`;
    const resp = await apiFetch(rawUrl, { method: 'GET' });
    if (!resp.ok) throw new Error(`读取 PPTX 失败: HTTP ${resp.status}`);
    const buffer = await resp.arrayBuffer();
    if (destroyed || ctx.isStale?.()) {
      destroy();
      return { getState: () => ({}), destroy };
    }

    parsed = await parsePptxBuffer(buffer, {
      blobUrls: allocatedBlobUrls,
      isDestroyed: () => destroyed || Boolean(ctx.isStale?.()),
    });
    if (destroyed || ctx.isStale?.()) {
      destroy();
      return { getState: () => ({}), destroy };
    }

    const canEdit = Boolean(onSaveFile && !parsed.hasMissingParts);
    if (parsed.hasMissingParts && onSaveFile) {
      editMode = false;
      showToast?.('检测到 PPTX 存在缺失部件，已禁用写回保护文件完整性', 3000);
    }

    const totalSlides = parsed.slides.length;
    if (slideIndex >= totalSlides) slideIndex = Math.max(0, totalSlides - 1);

    function updateEditControls() {
      if (currentEditBtn) {
        currentEditBtn.classList.toggle('is-active', editMode && activeMode === 'ooxml');
      }
      if (currentSaveBtn) {
        currentSaveBtn.classList.toggle('is-hidden', !editMode && !dirty);
        currentSaveBtn.classList.toggle('is-dirty', dirty && !saving);
        currentSaveBtn.disabled = saving;
        const saveIcon = global.WSIcons?.render ? global.WSIcons.render('ui-save', { size: 12 }) : '';
        const lbl = saving ? '保存中...' : dirty ? '保存 PPT *' : '保存 PPT';
        currentSaveBtn.innerHTML = `${saveIcon}<span>${lbl}</span>`;
      }
      if (currentAutoSaveBtn) {
        currentAutoSaveBtn.classList.toggle('is-hidden', !editMode && !dirty);
        currentAutoSaveBtn.classList.toggle('is-active', autoSave);
      }
      if (activeMode === 'ooxml') {
        if (dirty) {
          onStatusBadge?.('编辑 · 未保存修改');
        } else if (editMode) {
          onStatusBadge?.('纯 JS 原位编辑（保存后同步 PDF）');
        } else {
          onStatusBadge?.(
            pdfResult?.mode === 'pdf'
              ? '纯 JS OOXML（已就绪高保真 PDF）'
              : '纯 JS OOXML 渲染'
          );
        }
      }
    }

    async function requestDocConvert() {
      const r = await apiFetch('/api/doc/convert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: file.path,
          conversationId: conversationId || '',
          workspaceGen: ctx.getWorkspaceGen?.(),
        }),
      });
      return r.json();
    }

    async function refreshPdfCacheInBackground() {
      try {
        const res = await requestDocConvert();
        if (destroyed || ctx.isStale?.()) return null;
        if (res?.mode === 'pdf' && res.pdfUrl) {
          pdfResult = res;
          if (activeMode === 'ooxml') {
            updateEditControls();
          } else {
            const eng = res.engine === 'cache' ? 'PDF 缓存' : res.engine;
            onStatusBadge?.(`${eng} · 100% 像素级`);
          }
        }
        return res;
      } catch {
        return null;
      }
    }

    async function savePptxChanges({ silent = false, waitForPdf = false } = {}) {
      if (!canEdit || saving || !parsed?.zip) return;
      if (!dirty) {
        if (!silent) showToast?.('当前 PPT 无未保存修改', 1200);
        return;
      }
      if (autoSaveTimer) {
        clearTimeout(autoSaveTimer);
        autoSaveTimer = null;
      }
      saving = true;
      updateEditControls();

      const revAtStart = editSeq;
      const slidesToWrite = Array.from(modifiedSlides);
      const notesToWrite = Array.from(modifiedNotesSlides);

      try {
        const serializer = new XMLSerializer();
        for (const slide of slidesToWrite) {
          if (!slide?.sPath || !slide?.sDoc) throw new Error('幻灯片 XML 部件不可用');
          parsed.zip.file(slide.sPath, serializer.serializeToString(slide.sDoc));
        }
        for (const slide of notesToWrite) {
          if (!slide?.notesPath || !slide?.nDoc) throw new Error('备注 XML 部件不可用');
          parsed.zip.file(slide.notesPath, serializer.serializeToString(slide.nDoc));
        }

        const out = await parsed.zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
        const encoder = global.WSModules?.uint8ToBase64;
        if (!encoder) throw new Error('Base64 编码器未就绪');
        const res = await onSaveFile({
          content: encoder(out),
          encoding: 'base64',
          silent,
        });

        if (res?.success && !destroyed) {
          if (editSeq === revAtStart) {
            for (const s of slidesToWrite) modifiedSlides.delete(s);
            for (const s of notesToWrite) modifiedNotesSlides.delete(s);
            dirty = false;
            onStatusBadge?.('已保存 PPT · 后台同步像素级 PDF...');
            updateEditControls();
            if (currentSaveBtn) {
              const saveIcon = global.WSIcons?.render ? global.WSIcons.render('ui-save', { size: 12 }) : '';
              currentSaveBtn.innerHTML = `${saveIcon}<span>已保存</span>`;
              if (justSavedTimer) clearTimeout(justSavedTimer);
              justSavedTimer = setTimeout(() => {
                if (!destroyed) updateEditControls();
              }, 1300);
            }
          } else {
            dirty = true;
            updateEditControls();
            scheduleAutoSave();
          }

          if (slidesToWrite.length > 0) {
            const syncPromise = refreshPdfCacheInBackground();
            if (waitForPdf) await syncPromise;
          }
        }
      } catch (err) {
        showToast?.(`PPT 保存失败: ${err?.message || err}`, 2800);
      } finally {
        saving = false;
        if (!destroyed) updateEditControls();
      }
    }

    function scheduleAutoSave() {
      if (!autoSave || !canEdit) return;
      if (autoSaveTimer) clearTimeout(autoSaveTimer);
      autoSaveTimer = setTimeout(() => {
        autoSaveTimer = null;
        if (!destroyed && dirty) savePptxChanges({ silent: true });
      }, 1000);
    }

    function markDirty() {
      dirty = true;
      editSeq += 1;
      updateEditControls();
      scheduleAutoSave();
    }

    function renderParagraphsInto(
      containerEl,
      paragraphs,
      {
        xmlDoc,
        interactive = false,
        allowEdit = false,
        scaleFactor = 1,
        defaultSizePt = 16,
        isNotes = false,
        onEdited = null,
      } = {}
    ) {
      for (const p of paragraphs) {
        const pDiv = document.createElement('div');
        if (!isNotes) {
          pDiv.style.textAlign = p.align;
          pDiv.style.marginLeft = `${Math.round(p.lvl * 14 * scaleFactor)}px`;
          pDiv.style.lineHeight = '1.25';
          pDiv.style.marginBottom = `${Math.max(1, Math.round(3 * scaleFactor))}px`;
        } else {
          pDiv.style.lineHeight = '1.45';
          pDiv.style.marginBottom = '4px';
        }
        if (p.bullet) {
          const bSpan = document.createElement('span');
          bSpan.textContent = `${p.bullet} `;
          bSpan.contentEditable = 'false';
          bSpan.style.fontSize = isNotes ? '12px' : `${Math.max(8, Math.round(14 * scaleFactor))}px`;
          pDiv.appendChild(bSpan);
        }

        const textWrap = document.createElement('span');
        textWrap.className = 'ws-pptx-p-text';
        const baseStyle =
          p.runs.find((r) => r.text && r.text !== '\n') ||
          p.runs[0] || { sz: defaultSizePt, bold: false, italic: false, underline: false, color: '' };
        if (!isNotes) {
          const basePx = Math.max(8, (baseStyle.sz || defaultSizePt) * (96 / 72) * scaleFactor);
          textWrap.style.fontSize = `${basePx.toFixed(1)}px`;
          if (baseStyle.color) textWrap.style.color = baseStyle.color;
        } else {
          textWrap.style.fontSize = '12px';
        }
        if (baseStyle.bold) textWrap.style.fontWeight = '700';
        if (baseStyle.italic) textWrap.style.fontStyle = 'italic';
        if (baseStyle.underline) textWrap.style.textDecoration = 'underline';

        const canParaEdit = Boolean(interactive && allowEdit && p.pNode && xmlDoc && !p.hasUnsupportedNode);
        const perRunEditable =
          canParaEdit &&
          (p.hasField ||
            p.hasMixedStyles ||
            p.hasLink ||
            p.runs.some((r) => r.text !== '\n' && !r.isField && !r.tNode));

        for (const run of p.runs) {
          if (run.text === '\n') {
            textWrap.appendChild(document.createElement('br'));
            continue;
          }
          const span = document.createElement('span');
          span.textContent = run.text;
          if (!isNotes) {
            const pxSize = Math.max(8, (run.sz || defaultSizePt) * (96 / 72) * scaleFactor);
            span.style.fontSize = `${pxSize.toFixed(1)}px`;
            if (run.color) span.style.color = run.color;
          } else {
            span.style.fontSize = '12px';
          }
          if (run.bold) span.style.fontWeight = '700';
          if (run.italic) span.style.fontStyle = 'italic';
          if (run.underline) span.style.textDecoration = 'underline';
          if (perRunEditable) {
            if (run.isField) {
              span.contentEditable = 'false';
              span.title = '动态字段已保护为只读';
            } else if (run.tNode) {
              span.contentEditable = 'true';
              span.spellcheck = false;
              span.classList.add('ws-pptx-p-text');
              span.addEventListener('input', () => {
                const nextVal = readEditableText(span);
                run.text = nextVal;
                run.tNode.textContent = nextVal;
                onEdited?.();
              });
            }
          }
          textWrap.appendChild(span);
        }

        if (canParaEdit && !perRunEditable) {
          textWrap.contentEditable = 'true';
          textWrap.spellcheck = false;
          if (isNotes && p.runs.length === 0) {
            textWrap.style.minWidth = '100%';
            textWrap.style.display = 'inline-block';
          }
          textWrap.addEventListener('input', () => {
            const nextText = readEditableText(textWrap);
            if (p.runs.length === 1 && !p.runs[0].isField && p.runs[0].tNode && !nextText.includes('\n')) {
              p.runs[0].text = nextText;
              p.runs[0].tNode.textContent = nextText;
            } else {
              updatePptxParagraphNode(xmlDoc, p.pNode, nextText);
              const firstR = firstChild(p.pNode, 'r');
              const firstT = firstR ? firstChild(firstR, 't') : null;
              p.runs = [
                {
                  ...baseStyle,
                  text: nextText,
                  rNode: firstR || null,
                  tNode: !nextText.includes('\n') ? firstT : null,
                  isField: false,
                },
              ];
            }
            onEdited?.();
          });
        }

        pDiv.appendChild(textWrap);
        containerEl.appendChild(pDiv);
      }
    }

    function renderSlideDom(slide, widthPx, heightPx, { interactive = false } = {}) {
      const box = document.createElement('div');
      box.className = 'ws-slide-canvas-box';
      box.style.width = `${Math.round(widthPx)}px`;
      box.style.height = `${Math.round(heightPx)}px`;
      box.style.background = slide.bgColor || '#ffffff';

      const naturalPxW = parsed.slideCx / 9525;
      const scaleFactor = widthPx / Math.max(naturalPxW, 1);

      for (const el of slide.elements) {
        const leftPct = (el.x / parsed.slideCx) * 100;
        const topPct = (el.y / parsed.slideCy) * 100;
        const wPct = (el.cx / parsed.slideCx) * 100;
        const hPct = (el.cy / parsed.slideCy) * 100;

        const node = document.createElement('div');
        node.style.cssText = `position:absolute;left:${leftPct}%;top:${topPct}%;width:${wPct}%;height:${hPct}%;overflow:hidden;box-sizing:border-box;`;

        if (el.kind === 'image') {
          const img = document.createElement('img');
          img.src = el.src;
          img.style.cssText = 'width:100%;height:100%;object-fit:fill;display:block;';
          node.appendChild(img);
        } else if (el.kind === 'table') {
          const tbl = document.createElement('table');
          tbl.style.cssText =
            'width:100%;height:100%;border-collapse:collapse;table-layout:fixed;font-size:' +
            `${Math.max(8, Math.round(12 * scaleFactor))}px;`;
          for (const r of el.rows) {
            const tr = document.createElement('tr');
            for (const c of r) {
              const td = document.createElement('td');
              td.style.cssText = 'border:1px solid rgba(100,116,139,0.45);padding:3px 5px;word-break:break-word;';
              if (c.fill) td.style.backgroundColor = c.fill;
              const cellParas = Array.isArray(c.paragraphs) ? c.paragraphs : [];
              if (cellParas.length > 0 && c.txBodyNode && slide.sDoc) {
                const cellHasEditable = cellParas.some((p) => p.pNode && !p.hasUnsupportedNode);
                if (interactive && editMode && canEdit && cellHasEditable) {
                  td.classList.add('ws-pptx-editable');
                  td.title = '直接编辑单元格内容（保留多段与字段结构）';
                }
                renderParagraphsInto(td, cellParas, {
                  xmlDoc: slide.sDoc,
                  interactive,
                  allowEdit: editMode && canEdit,
                  scaleFactor,
                  defaultSizePt: 11,
                  onEdited: () => {
                    c.text = cellParas.map((p) => p.runs.map((r) => r.text).join('')).join('\n');
                    modifiedSlides.add(slide);
                    markDirty();
                    refreshCurrentThumbFn?.();
                  },
                });
              } else {
                td.textContent = c.text;
              }
              tr.appendChild(td);
            }
            tbl.appendChild(tr);
          }
          if (interactive && !editMode && canEdit) {
            tbl.title = '双击表格进入「编辑」模式';
            tbl.addEventListener('dblclick', (e) => {
              e.stopPropagation();
              editMode = true;
              mountOoxmlMode();
              showToast?.('已开启「编辑」，可直接修改单元格与文本框', 1800);
            });
          }
          node.appendChild(tbl);
        } else {
          if (el.fill) node.style.background = el.fill;
          if (el.border) node.style.border = `1px solid ${el.border}`;
          node.style.padding = `${Math.max(2, Math.round(4 * scaleFactor))}px`;
          if (interactive && !editMode && canEdit && el.paragraphs.length > 0) {
            node.title = '双击文本框进入「编辑」模式';
            node.addEventListener('dblclick', (e) => {
              e.stopPropagation();
              editMode = true;
              mountOoxmlMode();
              showToast?.('已开启「编辑」，可直接修改幻灯片文字', 1800);
            });
          }

          renderParagraphsInto(node, el.paragraphs, {
            xmlDoc: slide.sDoc,
            interactive,
            allowEdit: editMode && canEdit,
            scaleFactor,
            defaultSizePt: 16,
            onEdited: () => {
              modifiedSlides.add(slide);
              markDirty();
              refreshCurrentThumbFn?.();
            },
          });
        }
        box.appendChild(node);
      }
      return box;
    }

    function makeEngineToggleGroup() {
      const right = document.createElement('div');
      right.className = 'ws-toolbar-group';

      if (pdfResult?.mode === 'pdf' && mountPdfUrl) {
        const seg = document.createElement('div');
        seg.className = 'ws-seg';
        const btnPdf = document.createElement('button');
        btnPdf.type = 'button';
        btnPdf.textContent = '像素级 PDF';
        btnPdf.className = activeMode !== 'ooxml' ? 'is-active' : '';
        btnPdf.addEventListener('click', async () => {
          if (dirty) {
            await savePptxChanges({ silent: true, waitForPdf: true });
          }
          activeMode = 'pdf';
          mountPdfMode();
        });

        const btnJs = document.createElement('button');
        btnJs.type = 'button';
        btnJs.textContent = '纯 JS / 备注';
        btnJs.className = activeMode === 'ooxml' ? 'is-active' : '';
        btnJs.addEventListener('click', () => {
          activeMode = 'ooxml';
          mountOoxmlMode();
        });

        seg.append(btnPdf, btnJs);
        right.appendChild(seg);
      }

      currentEditBtn = null;
      currentAutoSaveBtn = null;
      currentSaveBtn = null;

      if (canEdit) {
        currentEditBtn = document.createElement('button');
        currentEditBtn.type = 'button';
        currentEditBtn.className = `ws-chip-btn ${editMode && activeMode === 'ooxml' ? 'is-active' : ''}`;
        const editIcon = global.WSIcons?.render ? global.WSIcons.render('ui-edit', { size: 12 }) : '';
        currentEditBtn.innerHTML = `${editIcon}<span>编辑</span>`;
        currentEditBtn.title = '在幻灯片上直接点击文本框或表格单元格修改文字（保存后自动更新像素级 PDF）';
        currentEditBtn.addEventListener('click', async () => {
          if (activeMode !== 'ooxml') {
            activeMode = 'ooxml';
            editMode = true;
            mountOoxmlMode();
            showToast?.('已切换至编辑模式，保存后将自动同步像素级 PDF', 2000);
            return;
          }
          if (editMode && dirty) {
            await savePptxChanges({ silent: true });
          }
          editMode = !editMode;
          mountOoxmlMode();
        });

        currentAutoSaveBtn = document.createElement('button');
        currentAutoSaveBtn.type = 'button';
        currentAutoSaveBtn.className = `ws-chip-btn ${autoSave ? 'is-active' : ''}`;
        currentAutoSaveBtn.textContent = '自动保存';
        currentAutoSaveBtn.addEventListener('click', () => {
          autoSave = !autoSave;
          updateEditControls();
          if (autoSave && dirty) scheduleAutoSave();
        });

        currentSaveBtn = document.createElement('button');
        currentSaveBtn.type = 'button';
        currentSaveBtn.className = 'ws-chip-btn';
        currentSaveBtn.title = '立即保存 PPT (Ctrl+S)';
        currentSaveBtn.addEventListener('click', () => savePptxChanges({ silent: false }));

        right.append(currentEditBtn, currentAutoSaveBtn, currentSaveBtn);
      }

      const notesBtn = document.createElement('button');
      notesBtn.type = 'button';
      notesBtn.className = `ws-chip-btn ${showNotes ? 'is-active' : ''}`;
      const noteIcon = global.WSIcons?.render ? global.WSIcons.render('ui-note', { size: 12 }) : '';
      notesBtn.innerHTML = `${noteIcon}<span>备注</span>`;
      notesBtn.addEventListener('click', () => {
        showNotes = !showNotes;
        notesBtn.classList.toggle('is-active', showNotes);
        const existing = stageEl.querySelector('.ws-notes-drawer');
        if (showNotes) {
          updateNotesDrawer();
        } else {
          existing?.remove();
        }
      });
      right.appendChild(notesBtn);
      setTimeout(() => {
        if (!destroyed) updateEditControls();
      }, 0);
      return right;
    }

    function updateNotesDrawer() {
      const slide = parsed.slides[slideIndex];
      let drawer = stageEl.querySelector('.ws-notes-drawer');
      if (!showNotes) {
        drawer?.remove();
        return;
      }
      if (!drawer) {
        drawer = document.createElement('div');
        drawer.className = 'ws-notes-drawer';
        const shell = stageEl.querySelector('.ws-slide-shell') || stageEl;
        shell.appendChild(drawer);
      }
      drawer.innerHTML = '';

      const title = document.createElement('div');
      title.innerHTML = `<strong style="color:var(--ws-muted);">第 ${slideIndex + 1} 页演讲者备注</strong>`;
      drawer.appendChild(title);

      const noteParas = Array.isArray(slide?.notesParagraphs) ? slide.notesParagraphs : [];
      if (slide?.notesTxBodyNode && slide?.nDoc && canEdit && noteParas.length > 0) {
        const editor = document.createElement('div');
        editor.className = 'ws-notes-editor';
        editor.style.boxSizing = 'border-box';
        renderParagraphsInto(editor, noteParas, {
          xmlDoc: slide.nDoc,
          interactive: true,
          allowEdit: true,
          scaleFactor: 1,
          defaultSizePt: 12,
          isNotes: true,
          onEdited: () => {
            slide.notes = noteParas.map((p) => p.runs.map((r) => r.text).join('')).join('\n').trim();
            modifiedNotesSlides.add(slide);
            markDirty();
          },
        });
        drawer.appendChild(editor);
      } else {
        const body = document.createElement('div');
        body.style.marginTop = '4px';
        body.innerHTML = slide?.notes
          ? slide.notes.replace(/</g, '&lt;').replace(/\n/g, '<br>')
          : '<span style="color:var(--ws-muted);">（本页无演讲备注）</span>';
        drawer.appendChild(body);
      }
    }

    function mountOoxmlMode() {
      if (destroyed || ctx.isStale?.()) return;
      modeSeq += 1;
      clearOoxmlListeners();
      if (pdfCtrl) {
        pdfCtrl.destroy();
        pdfCtrl = null;
      }

      onStatusBadge?.(
        dirty
          ? '编辑 · 未保存修改'
          : editMode
            ? '纯 JS 原位编辑（保存后同步 PDF）'
            : pdfResult?.mode === 'pdf'
              ? '纯 JS OOXML（已就绪高保真 PDF）'
              : '纯 JS OOXML 渲染'
      );

      toolbarEl.classList.remove('is-hidden');
      toolbarEl.innerHTML = '';
      const left = document.createElement('div');
      left.className = 'ws-toolbar-group';

      const prevBtn = document.createElement('button');
      prevBtn.type = 'button';
      prevBtn.className = 'ws-btn-ghost';
      prevBtn.textContent = '‹';

      const pageInfo = document.createElement('span');
      pageInfo.style.cssText = 'font-size:11.5px;color:var(--ws-muted);padding:0 4px;';

      const nextBtn = document.createElement('button');
      nextBtn.type = 'button';
      nextBtn.className = 'ws-btn-ghost';
      nextBtn.textContent = '›';

      left.append(prevBtn, pageInfo, nextBtn);
      toolbarEl.append(left, makeEngineToggleGroup());

      stageEl.innerHTML = '';
      const shell = document.createElement('div');
      shell.className = 'ws-slide-shell';

      const slideStage = document.createElement('div');
      slideStage.className = 'ws-slide-stage';

      const filmstrip = document.createElement('div');
      filmstrip.className = 'ws-slide-filmstrip';

      shell.append(slideStage, filmstrip);
      stageEl.appendChild(shell);

      const aspect = parsed.slideCy / Math.max(parsed.slideCx, 1);

      const drawCurrentSlide = () => {
        if (!totalSlides) {
          slideStage.innerHTML = '<div class="ws-empty-welcome"><p>空白演示文稿</p></div>';
          pageInfo.textContent = '0 / 0';
          return;
        }
        const availW = Math.max((slideStage.clientWidth || 440) - 30, 220);
        const availH = Math.max((slideStage.clientHeight || 300) - 24, 150);
        let w = availW;
        let h = w * aspect;
        if (h > availH) {
          h = availH;
          w = h / aspect;
        }
        slideStage.innerHTML = '';
        slideStage.appendChild(
          renderSlideDom(parsed.slides[slideIndex], w, h, { interactive: true })
        );
        pageInfo.textContent = `${slideIndex + 1} / ${totalSlides}`;
        prevBtn.disabled = slideIndex <= 0;
        nextBtn.disabled = slideIndex >= totalSlides - 1;
        for (const btn of filmstrip.querySelectorAll('.ws-slide-thumb')) {
          btn.classList.toggle('is-active', Number(btn.dataset.idx) === slideIndex);
        }
        updateNotesDrawer();
      };

      refreshCurrentThumbFn = () => {
        const thumbBtn = filmstrip.querySelector(`.ws-slide-thumb[data-idx="${slideIndex}"]`);
        if (!thumbBtn) return;
        const oldMini = thumbBtn.querySelector('.ws-slide-canvas-box');
        const nextMini = renderSlideDom(parsed.slides[slideIndex], 96, 96 * aspect, {
          interactive: false,
        });
        nextMini.style.boxShadow = 'none';
        nextMini.style.pointerEvents = 'none';
        if (oldMini) oldMini.replaceWith(nextMini);
      };

      parsed.slides.forEach((s, i) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `ws-slide-thumb ${i === slideIndex ? 'is-active' : ''}`;
        btn.dataset.idx = String(i);
        const mini = renderSlideDom(s, 96, 96 * aspect, { interactive: false });
        mini.style.boxShadow = 'none';
        mini.style.pointerEvents = 'none';
        const lbl = document.createElement('div');
        lbl.className = 'ws-slide-thumb-label';
        lbl.textContent = String(i + 1);
        btn.append(mini, lbl);
        btn.addEventListener('click', () => {
          slideIndex = i;
          drawCurrentSlide();
        });
        filmstrip.appendChild(btn);
      });

      prevBtn.addEventListener('click', () => {
        if (slideIndex > 0) {
          slideIndex--;
          drawCurrentSlide();
        }
      });
      nextBtn.addEventListener('click', () => {
        if (slideIndex < totalSlides - 1) {
          slideIndex++;
          drawCurrentSlide();
        }
      });

      ooxmlKeyHandler = (e) => {
        if (
          ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName) ||
          document.activeElement?.isContentEditable
        ) {
          return;
        }
        if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
          e.preventDefault();
          if (slideIndex > 0) {
            slideIndex--;
            drawCurrentSlide();
          }
        } else if (e.key === 'ArrowRight' || e.key === 'PageDown') {
          e.preventDefault();
          if (slideIndex < totalSlides - 1) {
            slideIndex++;
            drawCurrentSlide();
          }
        }
      };
      global.addEventListener('keydown', ooxmlKeyHandler);

      resizeObserver = new ResizeObserver(() => {
        if (destroyed) return;
        const w = slideStage.clientWidth || 0;
        const h = slideStage.clientHeight || 0;
        if (Math.abs(w - lastObservedW) < 2 && Math.abs(h - lastObservedH) < 2) return;
        lastObservedW = w;
        lastObservedH = h;
        if (resizeRafId) global.cancelAnimationFrame(resizeRafId);
        resizeRafId = global.requestAnimationFrame(() => {
          resizeRafId = 0;
          if (!destroyed && !slideStage.contains(document.activeElement)) {
            drawCurrentSlide();
          }
        });
      });
      drawCurrentSlide();
      lastObservedW = slideStage.clientWidth || 0;
      lastObservedH = slideStage.clientHeight || 0;
      resizeObserver.observe(slideStage);
    }

    async function mountPdfMode() {
      if (destroyed || ctx.isStale?.() || !pdfResult || pdfResult.mode !== 'pdf' || !mountPdfUrl) return;
      const myModeSeq = ++modeSeq;
      const isPdfStale = () => destroyed || Boolean(ctx.isStale?.()) || myModeSeq !== modeSeq;
      activeMode = 'pdf';
      refreshCurrentThumbFn = null;
      clearOoxmlListeners();
      if (pdfCtrl) {
        pdfCtrl.destroy();
        pdfCtrl = null;
      }

      const engineLabel = pdfResult.engine === 'cache' ? 'PDF 缓存' : pdfResult.engine;
      onStatusBadge?.(`${engineLabel} · 100% 像素级`);

      const nextCtrl = await mountPdfUrl({
        url: pdfResult.pdfUrl,
        stageEl,
        toolbarEl,
        mode: 'slide',
        prevState: { page: slideIndex + 1 },
        onSlideChange: (idx) => {
          slideIndex = idx;
          if (showNotes) updateNotesDrawer();
        },
        extraToolbarRight: makeEngineToggleGroup(),
        registerCleanup,
        isStale: isPdfStale,
      });
      if (isPdfStale()) {
        nextCtrl?.destroy?.();
        return;
      }
      pdfCtrl = nextCtrl;
      if (showNotes) updateNotesDrawer();
    }

    globalKeyHandler = (e) => {
      if (destroyed || !canEdit) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        if (editMode || dirty || stageEl.contains(document.activeElement)) {
          e.preventDefault();
          savePptxChanges({ silent: false });
        }
      }
    };
    global.addEventListener('keydown', globalKeyHandler);

    mountOoxmlMode();

    if (activeMode !== 'ooxml') {
      onStatusBadge?.('纯 JS 秒开 · 后台生成高保真 PDF...');
      requestDocConvert()
        .then(async (res) => {
          if (destroyed || ctx.isStale?.()) return;
          pdfResult = res;
          if (res?.mode === 'pdf' && res.pdfUrl && activeMode !== 'ooxml' && mountPdfUrl) {
            await mountPdfMode();
          } else {
            updateEditControls();
          }
        })
        .catch(() => {
          if (!destroyed && !ctx.isStale?.()) updateEditControls();
        });
    } else if (canEdit) {
      requestDocConvert()
        .then((res) => {
          if (destroyed || ctx.isStale?.()) return;
          pdfResult = res;
          if (activeMode === 'ooxml') mountOoxmlMode();
        })
        .catch(() => {});
    }

    return {
      isDirty: () => dirty,
      isAutoSave: () => autoSave,
      flushSave: (opts) => savePptxChanges(opts),
      getState: () => ({
        slideIndex,
        userLockedMode: activeMode === 'ooxml' ? 'ooxml' : 'auto',
        showNotes,
        editMode,
        autoSave,
      }),
      destroy,
    };
  }

  global.WSModules = global.WSModules || {};
  global.WSModules.renderPptxPreview = renderPptxPreview;
})(window);
