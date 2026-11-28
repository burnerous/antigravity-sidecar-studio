(function (global) {
  'use strict';

  function apiFetch(url, options) {
    const f = global.sidecar && typeof global.sidecar.fetch === 'function'
      ? global.sidecar.fetch.bind(global.sidecar)
      : global.fetch.bind(global);
    return f(url, options);
  }

  function makeVendorMissingError(message) {
    const err = new Error(message);
    err.code = 'VENDOR_MISSING';
    return err;
  }

  const WORD_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const XML_NS = 'http://www.w3.org/XML/1998/namespace';

  function hasDescendantLocal(node, namesSet) {
    if (!node) return false;
    for (const el of node.getElementsByTagName('*')) {
      if (namesSet.has(el.localName)) return true;
    }
    return false;
  }

  function getWpText(wpNode) {
    if (!wpNode) return '';
    let out = '';
    for (const el of wpNode.getElementsByTagName('*')) {
      if (el.localName === 't' || el.localName === 'delText') {
        out += el.textContent || '';
      } else if (el.localName === 'br' || el.localName === 'cr') {
        out += '\n';
      } else if (el.localName === 'tab') {
        out += '\t';
      }
    }
    return out;
  }

  function collectBodyParagraphs(bodyEl) {
    const out = [];
    if (!bodyEl) return out;
    for (const child of bodyEl.children) {
      const ln = child.localName;
      if (ln === 'p') {
        out.push(child);
      } else if (ln === 'tbl') {
        for (const tr of child.children) {
          if (tr.localName !== 'tr') continue;
          for (const tc of tr.children) {
            if (tc.localName !== 'tc') continue;
            for (const cellChild of tc.children) {
              if (cellChild.localName === 'p') out.push(cellChild);
            }
          }
        }
      }
    }
    return out;
  }

  function sanitizeDocxDom(root) {
    if (!root) return;
    for (const bad of root.querySelectorAll(
      'video, audio, source, picture, iframe, script, object, embed, form, base, meta, style, link'
    )) {
      bad.remove();
    }
    for (const el of root.querySelectorAll('*')) {
      if (el.attributes) {
        for (const attr of Array.from(el.attributes)) {
          const name = attr.name.toLowerCase();
          if (
            name.startsWith('on') ||
            name === 'srcset' ||
            name === 'ping' ||
            name === 'poster' ||
            name === 'background'
          ) {
            el.removeAttribute(attr.name);
          } else if (name === 'style' && /url\s*\(/i.test(attr.value || '')) {
            el.removeAttribute(attr.name);
          }
        }
      }
    }
    for (const img of root.querySelectorAll('img')) {
      const src = (img.getAttribute('src') || '').trim();
      if (!src.startsWith('blob:') && !src.startsWith('data:image/')) {
        const placeholder = document.createElement('span');
        placeholder.style.cssText = 'color:var(--ws-muted);font-size:11px;border:1px dashed var(--ws-border);padding:1px 5px;border-radius:4px;';
        placeholder.textContent = `[已屏蔽外部图片: ${img.getAttribute('alt') || src}]`;
        img.replaceWith(placeholder);
      }
    }
    for (const a of root.querySelectorAll('a')) {
      const href = (a.getAttribute('href') || '').trim();
      if (!/^(https?:|mailto:|#)/i.test(href)) {
        a.removeAttribute('href');
      } else {
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noopener noreferrer');
      }
    }
  }

  function inspectWpRuns(wpNode) {
    const directChildren = Array.from(wpNode.children);
    const disallowedChildren = new Set(['AlternateContent', 'ins', 'del', 'smartTag', 'fldSimple', 'sdt']);
    const disallowedDesc = new Set(['instrText', 'fldChar', 'fldSimple', 'txbxContent', 'AlternateContent', 'drawing', 'pict', 'object']);
    if (hasDescendantLocal(wpNode, disallowedDesc)) {
      return { editable: false };
    }
    const hasRangeMarkers = hasDescendantLocal(
      wpNode,
      new Set([
        'bookmarkStart',
        'bookmarkEnd',
        'commentRangeStart',
        'commentRangeEnd',
        'moveFromRangeStart',
        'moveFromRangeEnd',
        'moveToRangeStart',
        'moveToRangeEnd',
      ])
    );
    let hasHyperlink = false;
    let hasNonTextRun = false;
    const runs = [];
    const rPrSignatures = new Set();
    const serializer = new XMLSerializer();

    const inspectRunEl = (rEl) => {
      let rPrSig = '';
      const tNodes = [];
      for (const rc of rEl.children) {
        if (rc.localName === 'rPr') {
          rPrSig = serializer.serializeToString(rc);
        } else if (rc.localName === 't') {
          tNodes.push(rc);
        } else if (['br', 'cr', 'tab', 'sym', 'footnoteReference', 'endnoteReference'].includes(rc.localName)) {
          hasNonTextRun = true;
        }
      }
      if (tNodes.length === 1) {
        rPrSignatures.add(rPrSig);
        runs.push({ rNode: rEl, wtNode: tNodes[0], text: tNodes[0].textContent || '' });
      } else if (tNodes.length > 1) {
        hasNonTextRun = true;
      }
    };

    for (const child of directChildren) {
      const ln = child.localName;
      if (ln === 'pPr' || ln === 'bookmarkStart' || ln === 'bookmarkEnd' || ln === 'proofErr' || ln === 'commentRangeStart' || ln === 'commentRangeEnd') continue;
      if (disallowedChildren.has(ln)) return { editable: false };
      if (ln === 'r') {
        inspectRunEl(child);
      } else if (ln === 'hyperlink') {
        hasHyperlink = true;
        for (const hc of child.children) {
          if (hc.localName === 'r') inspectRunEl(hc);
        }
      } else {
        return { editable: false };
      }
    }

    if (hasRangeMarkers && (runs.length === 0 || hasNonTextRun)) {
      return { editable: false };
    }

    const mixedOrWrapped = hasRangeMarkers || hasHyperlink || hasNonTextRun || rPrSignatures.size > 1;
    return {
      editable: true,
      hasRangeMarkers,
      mixedOrWrapped,
      hasNonTextRun,
      runs,
    };
  }

  function updateSingleWordRunInPlace(xmlDoc, rNode, newText) {
    if (!xmlDoc || !rNode) return;
    const toRemove = [];
    for (const rc of rNode.children) {
      if (rc.localName !== 'rPr') {
        toRemove.push(rc);
      }
    }
    for (const n of toRemove) rNode.removeChild(n);

    const lines = String(newText ?? '').split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) {
        rNode.appendChild(xmlDoc.createElementNS(WORD_NS, 'w:br'));
      }
      const tEl = xmlDoc.createElementNS(WORD_NS, 'w:t');
      tEl.setAttributeNS(XML_NS, 'xml:space', 'preserve');
      tEl.textContent = lines[i];
      rNode.appendChild(tEl);
    }
  }

  function readEditableDomText(root) {
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

  function updateWordParagraphNode(xmlDoc, wpNode, newText) {
    if (!xmlDoc || !wpNode) return;
    let templateRPr = null;
    for (const child of wpNode.children) {
      if (child.localName === 'r') {
        for (const rc of child.children) {
          if (rc.localName === 'rPr') {
            templateRPr = rc.cloneNode(true);
            break;
          }
        }
        if (templateRPr) break;
      }
    }
    if (!templateRPr) {
      for (const child of wpNode.children) {
        if (child.localName === 'pPr') {
          for (const pc of child.children) {
            if (pc.localName === 'rPr') {
              templateRPr = pc.cloneNode(true);
              break;
            }
          }
          break;
        }
      }
    }

    const toRemove = [];
    for (const child of wpNode.children) {
      const ln = child.localName;
      if (ln === 'r') {
        if (!hasDescendantLocal(child, new Set(['drawing', 'pict', 'object']))) {
          toRemove.push(child);
        }
      } else if (ln === 'hyperlink' || ln === 'smartTag' || ln === 'ins') {
        toRemove.push(child);
      }
    }
    // Find earliest non-removed sibling after first removed node so insertion stays at original run slot
    let refNode = null;
    if (toRemove.length > 0) {
      let cur = toRemove[0].nextSibling;
      while (cur && toRemove.includes(cur)) cur = cur.nextSibling;
      refNode = cur;
    }
    for (const n of toRemove) wpNode.removeChild(n);

    const lines = String(newText ?? '').split('\n');
    const rEl = xmlDoc.createElementNS(WORD_NS, 'w:r');
    if (templateRPr) rEl.appendChild(templateRPr);
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) {
        rEl.appendChild(xmlDoc.createElementNS(WORD_NS, 'w:br'));
      }
      const tEl = xmlDoc.createElementNS(WORD_NS, 'w:t');
      tEl.setAttributeNS(XML_NS, 'xml:space', 'preserve');
      tEl.textContent = lines[i];
      rEl.appendChild(tEl);
    }
    if (refNode && refNode.parentNode === wpNode) {
      wpNode.insertBefore(rEl, refNode);
    } else {
      wpNode.appendChild(rEl);
    }
  }

  async function renderDocxPreview(ctx) {
    const {
      file,
      stageEl,
      toolbarEl,
      capabilities,
      conversationId,
      prevState,
      onStatusBadge,
      onSaveFile,
      onRenderError,
      showToast,
      registerCleanup,
    } = ctx;
    const mountPdfUrl = global.WSModules?.mountPdfUrl;
    let destroyed = false;
    let modeSeq = 0;
    let viewMode = prevState?.viewMode || 'native'; // 'native' | 'reader' | 'pdf'
    let zoomMode = prevState?.zoomMode || 'fit'; // 'fit' | 'custom'
    let customZoom = prevState?.customZoom || 1.0;
    let showToc = prevState?.showToc !== false;
    let editMode = Boolean(prevState?.editMode);
    let autoSave = prevState?.autoSave !== false;
    let dirty = false;
    let saving = false;
    let editSeq = 0;
    let autoSaveTimer = null;
    let justSavedTimer = null;
    let keyHandler = null;
    let pdfCtrl = null;
    let resizeObserver = null;
    let resizeRafId = 0;
    let lastObservedWidth = 0;

    let docxZip = null;
    let docxXmlDoc = null;
    let xmlParagraphs = [];
    const canEdit = Boolean(onSaveFile && global.JSZip);

    const destroy = () => {
      if (destroyed) return;
      destroyed = true;
      if (autoSaveTimer) clearTimeout(autoSaveTimer);
      if (justSavedTimer) clearTimeout(justSavedTimer);
      if (keyHandler) global.removeEventListener('keydown', keyHandler);
      if (resizeRafId) {
        global.cancelAnimationFrame(resizeRafId);
        resizeRafId = 0;
      }
      resizeObserver?.disconnect();
      pdfCtrl?.destroy();
    };
    registerCleanup?.(destroy);

    const hasPdfEngine = Boolean((capabilities?.word || capabilities?.libreoffice) && mountPdfUrl);

    const rawUrl = `/api/file/raw?path=${encodeURIComponent(file.path)}&conversationId=${encodeURIComponent(
      conversationId || ''
    )}&t=${Math.floor(file.mtimeMs || Date.now())}`;
    const resp = await apiFetch(rawUrl, { method: 'GET' });
    if (!resp.ok) throw new Error(`读取文档失败: HTTP ${resp.status}`);
    const buffer = await resp.arrayBuffer();
    if (destroyed) return { getState: () => ({}), destroy };
    let currentBuffer = buffer.slice(0);

    let saveBtn = null;
    let autoSaveBtn = null;
    let editBtn = null;

    function updateEditUi() {
      if (editBtn) {
        editBtn.classList.toggle('is-active', editMode && viewMode === 'native');
      }
      if (saveBtn) {
        saveBtn.classList.toggle('is-hidden', !editMode && !dirty);
        saveBtn.classList.toggle('is-dirty', dirty && !saving);
        saveBtn.disabled = saving;
        const saveIcon = global.WSIcons?.render ? global.WSIcons.render('ui-save', { size: 12 }) : '';
        const lbl = saving ? '保存中...' : dirty ? '保存 Word *' : '保存 Word';
        saveBtn.innerHTML = `${saveIcon}<span>${lbl}</span>`;
      }
      if (autoSaveBtn) {
        autoSaveBtn.classList.toggle('is-hidden', !editMode && !dirty);
        autoSaveBtn.classList.toggle('is-active', autoSave);
      }
      if (viewMode === 'native') {
        if (dirty) {
          onStatusBadge?.('编辑 · 未保存修改');
        } else if (editMode) {
          onStatusBadge?.('编辑（保留全部排版）');
        } else {
          onStatusBadge?.('docx-preview 原生排版');
        }
      }
    }

    async function buildModifiedDocxUint8() {
      if (!docxZip || !docxXmlDoc) return null;
      const xmlStr = new XMLSerializer().serializeToString(docxXmlDoc);
      docxZip.file('word/document.xml', xmlStr);
      const out = await docxZip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
      currentBuffer = out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
      return out;
    }

    async function saveDocxChanges({ silent = false } = {}) {
      if (!canEdit || saving) return;
      if (!dirty) {
        if (!silent) showToast?.('当前 Word 无未保存修改', 1200);
        return;
      }
      if (autoSaveTimer) {
        clearTimeout(autoSaveTimer);
        autoSaveTimer = null;
      }
      saving = true;
      updateEditUi();
      const seqAtStart = editSeq;
      try {
        const out = await buildModifiedDocxUint8();
        if (!out) throw new Error('OOXML 文档模型未初始化');
        const encoder = global.WSModules?.uint8ToBase64;
        if (!encoder) throw new Error('Base64 编码器未就绪');
        const res = await onSaveFile({
          content: encoder(out),
          encoding: 'base64',
          silent,
        });
        if (res?.success && !destroyed) {
          if (editSeq === seqAtStart) {
            dirty = false;
            onStatusBadge?.('编辑 · 已无损写回 DOCX');
            updateEditUi();
            if (saveBtn) {
              const saveIcon = global.WSIcons?.render ? global.WSIcons.render('ui-save', { size: 12 }) : '';
              saveBtn.innerHTML = `${saveIcon}<span>已保存</span>`;
              if (justSavedTimer) clearTimeout(justSavedTimer);
              justSavedTimer = setTimeout(() => {
                if (!destroyed) updateEditUi();
              }, 1300);
            }
          } else {
            dirty = true;
            updateEditUi();
            scheduleAutoSave();
          }
        }
      } catch (err) {
        showToast?.(`Word 保存失败: ${err?.message || err}`, 2800);
      } finally {
        saving = false;
        if (!destroyed) updateEditUi();
      }
    }

    function scheduleAutoSave() {
      if (!autoSave || !canEdit) return;
      if (autoSaveTimer) clearTimeout(autoSaveTimer);
      autoSaveTimer = setTimeout(() => {
        autoSaveTimer = null;
        if (!destroyed && dirty) saveDocxChanges({ silent: true });
      }, 1000);
    }

    async function ensureDocxXmlLoaded() {
      if (docxZip && docxXmlDoc) return;
      docxZip = await global.JSZip.loadAsync(currentBuffer);
      const xmlEntry = docxZip.file('word/document.xml');
      if (!xmlEntry) throw new Error('DOCX 缺少 word/document.xml');
      const xmlStr = await xmlEntry.async('string');
      docxXmlDoc = new DOMParser().parseFromString(xmlStr, 'application/xml');
      const bodyEl = Array.from(docxXmlDoc.documentElement?.children || []).find(
        (n) => n.localName === 'body'
      );
      xmlParagraphs = collectBodyParagraphs(bodyEl);
    }

    function bindInPlaceEditing(zoomBox) {
      if (!editMode || !docxXmlDoc || !xmlParagraphs.length) return;
      const domParagraphs = Array.from(
        zoomBox.querySelectorAll('article > p, article > table > tr > td > p, article > table > tbody > tr > td > p')
      );
      if (domParagraphs.length !== xmlParagraphs.length) {
        showToast?.('当前 Word 包含复杂分栏/文本框结构，已自动保护为只读以防样式错位', 2800);
        return;
      }

      const markDirtyAndSave = () => {
        dirty = true;
        editSeq += 1;
        updateEditUi();
        scheduleAutoSave();
      };

      const bindCtrlS = (el) => {
        el.addEventListener('keydown', (e) => {
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
            e.preventDefault();
            saveDocxChanges({ silent: false });
          }
        });
      };

      domParagraphs.forEach((domP, idx) => {
        const wpNode = xmlParagraphs[idx];
        if (!wpNode) return;
        const info = inspectWpRuns(wpNode);
        if (!info.editable) return;

        if (!info.mixedOrWrapped && !info.hasRangeMarkers) {
          domP.contentEditable = 'true';
          domP.spellcheck = false;
          domP.classList.add('ws-docx-editable');
          domP.title = '直接编辑段落文字（保留 Word 样式与排版）';
          domP.addEventListener('input', () => {
            const newText = readEditableDomText(domP);
            updateWordParagraphNode(docxXmlDoc, wpNode, newText);
            markDirtyAndSave();
          });
          bindCtrlS(domP);
          return;
        }

        if (info.hasRangeMarkers && info.runs.length === 1 && !info.hasNonTextRun) {
          domP.contentEditable = 'true';
          domP.spellcheck = false;
          domP.classList.add('ws-docx-editable');
          domP.title = '在书签/标记范围内原位编辑段落文字';
          domP.addEventListener('input', () => {
            const newText = readEditableDomText(domP);
            updateSingleWordRunInPlace(docxXmlDoc, info.runs[0].rNode, newText);
            markDirtyAndSave();
          });
          bindCtrlS(domP);
          return;
        }

        if (info.hasNonTextRun || info.runs.length === 0) return;

        // Bind mixed-style runs, bookmarked runs, or hyperlink runs 1-to-1 to their exact <w:t> nodes
        const domSpans = [];
        for (const ch of domP.children) {
          if (ch.tagName === 'SPAN') {
            domSpans.push(ch);
          } else if (ch.tagName === 'A') {
            for (const ac of ch.children) {
              if (ac.tagName === 'SPAN') domSpans.push(ac);
            }
          }
        }
        if (domSpans.length !== info.runs.length) return;
        for (let i = 0; i < domSpans.length; i++) {
          if (domSpans[i].textContent !== info.runs[i].text) return;
        }

        for (let i = 0; i < domSpans.length; i++) {
          const spanEl = domSpans[i];
          const runMeta = info.runs[i];
          spanEl.contentEditable = 'true';
          spanEl.spellcheck = false;
          spanEl.classList.add('ws-docx-editable');
          spanEl.title = '直接编辑此段样式片段（保留书签、混排与超链接格式）';
          spanEl.addEventListener('input', () => {
            const newText = readEditableDomText(spanEl);
            if (newText.includes('\n')) {
              updateSingleWordRunInPlace(docxXmlDoc, runMeta.rNode, newText);
            } else {
              runMeta.wtNode.setAttributeNS(XML_NS, 'xml:space', 'preserve');
              runMeta.wtNode.textContent = newText;
            }
            markDirtyAndSave();
          });
          bindCtrlS(spanEl);
        }
      });
    }

    function buildToolbar() {
      toolbarEl.classList.remove('is-hidden');
      toolbarEl.innerHTML = '';

      const seg = document.createElement('div');
      seg.className = 'ws-seg';

      const btnNative = document.createElement('button');
      btnNative.type = 'button';
      btnNative.textContent = '排版视图';
      btnNative.className = viewMode === 'native' ? 'is-active' : '';
      const runModeSwitch = () => {
        renderCurrentMode().catch((err) => {
          if (!destroyed && !ctx.isStale?.()) onRenderError?.(err);
        });
      };

      btnNative.addEventListener('click', () => {
        if (viewMode === 'native') return;
        viewMode = 'native';
        runModeSwitch();
      });

      const btnReader = document.createElement('button');
      btnReader.type = 'button';
      btnReader.textContent = '精简阅读';
      btnReader.className = viewMode === 'reader' ? 'is-active' : '';
      btnReader.addEventListener('click', async () => {
        if (viewMode === 'reader') return;
        if (dirty) await buildModifiedDocxUint8();
        viewMode = 'reader';
        runModeSwitch();
      });

      seg.append(btnNative, btnReader);

      if (hasPdfEngine) {
        const btnPdf = document.createElement('button');
        btnPdf.type = 'button';
        btnPdf.textContent = '像素级 PDF';
        btnPdf.className = viewMode === 'pdf' ? 'is-active' : '';
        btnPdf.addEventListener('click', async () => {
          if (viewMode === 'pdf') return;
          if (dirty) await saveDocxChanges({ silent: true });
          viewMode = 'pdf';
          runModeSwitch();
        });
        seg.appendChild(btnPdf);
      }

      const left = document.createElement('div');
      left.className = 'ws-toolbar-group';
      left.appendChild(seg);

      editBtn = null;
      autoSaveBtn = null;
      saveBtn = null;
      if (canEdit) {
        editBtn = document.createElement('button');
        editBtn.type = 'button';
        editBtn.className = `ws-chip-btn ${editMode && viewMode === 'native' ? 'is-active' : ''}`;
        const editIcon = global.WSIcons?.render ? global.WSIcons.render('ui-edit', { size: 12 }) : '';
        editBtn.innerHTML = `${editIcon}<span>编辑</span>`;
        editBtn.title = '在排版视图中直接点击段落或表格单元格改字（不破坏 Word 格式）';
        editBtn.addEventListener('click', async () => {
          if (viewMode !== 'native') {
            viewMode = 'native';
            editMode = true;
          } else {
            if (editMode && dirty) {
              await saveDocxChanges({ silent: true });
            }
            editMode = !editMode;
          }
          runModeSwitch();
        });

        autoSaveBtn = document.createElement('button');
        autoSaveBtn.type = 'button';
        autoSaveBtn.className = `ws-chip-btn ${autoSave ? 'is-active' : ''}`;
        autoSaveBtn.textContent = '自动保存';
        autoSaveBtn.addEventListener('click', () => {
          autoSave = !autoSave;
          updateEditUi();
          if (autoSave && dirty) scheduleAutoSave();
        });

        saveBtn = document.createElement('button');
        saveBtn.type = 'button';
        saveBtn.className = 'ws-chip-btn';
        saveBtn.title = '立即写回 DOCX 文件 (Ctrl+S)';
        saveBtn.addEventListener('click', () => saveDocxChanges({ silent: false }));

        left.append(editBtn, autoSaveBtn, saveBtn);
      }

      toolbarEl.appendChild(left);

      if (viewMode === 'native') {
        const right = document.createElement('div');
        right.className = 'ws-toolbar-group';

        const outBtn = document.createElement('button');
        outBtn.type = 'button';
        outBtn.className = 'ws-btn-ghost';
        outBtn.textContent = '−';

        const fitBtn = document.createElement('button');
        fitBtn.type = 'button';
        fitBtn.className = 'ws-btn-ghost';
        fitBtn.textContent = zoomMode === 'fit' ? '适应宽度' : `${Math.round(customZoom * 100)}%`;

        const inBtn = document.createElement('button');
        inBtn.type = 'button';
        inBtn.className = 'ws-btn-ghost';
        inBtn.textContent = '+';

        outBtn.addEventListener('click', () => {
          zoomMode = 'custom';
          customZoom = Math.max(0.35, Number((customZoom - 0.1).toFixed(2)));
          applyNativeZoom(fitBtn);
        });
        inBtn.addEventListener('click', () => {
          zoomMode = 'custom';
          customZoom = Math.min(1.8, Number((customZoom + 0.1).toFixed(2)));
          applyNativeZoom(fitBtn);
        });
        fitBtn.addEventListener('click', () => {
          zoomMode = zoomMode === 'fit' ? 'custom' : 'fit';
          if (zoomMode === 'custom') customZoom = 1.0;
          applyNativeZoom(fitBtn);
        });

        right.append(outBtn, fitBtn, inBtn);
        toolbarEl.appendChild(right);
        stageEl._fitBtn = fitBtn;
      } else if (viewMode === 'reader') {
        const right = document.createElement('div');
        right.className = 'ws-toolbar-group';
        const tocBtn = document.createElement('button');
        tocBtn.type = 'button';
        tocBtn.className = `ws-chip-btn ${showToc ? 'is-active' : ''}`;
        const tocIcon = global.WSIcons?.render ? global.WSIcons.render('ui-list', { size: 12 }) : '';
        tocBtn.innerHTML = `${tocIcon}<span>大纲</span>`;
        tocBtn.addEventListener('click', () => {
          showToc = !showToc;
          renderCurrentMode().catch((err) => {
            if (!destroyed && !ctx.isStale?.()) onRenderError?.(err);
          });
        });
        right.appendChild(tocBtn);
        toolbarEl.appendChild(right);
      }
    }

    let nativeZoomBox = null;

    function applyNativeZoom(fitBtn = stageEl._fitBtn) {
      if (!nativeZoomBox) return;
      const section = nativeZoomBox.querySelector('section');
      const naturalW = section ? section.offsetWidth || 794 : 794;
      let z = customZoom;
      if (zoomMode === 'fit') {
        const avail = Math.max((stageEl.clientWidth || 440) - 32, 220);
        z = Math.min(Math.max(avail / naturalW, 0.35), 1.15);
        customZoom = z;
        if (fitBtn) fitBtn.textContent = `适应 (${Math.round(z * 100)}%)`;
      } else if (fitBtn) {
        fitBtn.textContent = `${Math.round(z * 100)}%`;
      }
      nativeZoomBox.style.zoom = String(z);
    }

    async function renderNativeDocx() {
      updateEditUi();
      stageEl.innerHTML = '';
      const wrapper = document.createElement('div');
      wrapper.className = 'ws-docx-stage';

      const styleBox = document.createElement('div');
      const zoomBox = document.createElement('div');
      zoomBox.className = 'ws-docx-zoom-box';
      nativeZoomBox = zoomBox;
      wrapper.append(styleBox, zoomBox);
      stageEl.appendChild(wrapper);

      if (typeof global.docx?.renderAsync !== 'function' || !global.JSZip) {
        throw makeVendorMissingError('离线 Word 排版引擎 (docx-preview / JSZip) 未加载');
      }

      if (editMode && canEdit) {
        await ensureDocxXmlLoaded();
      }

      await global.docx.renderAsync(currentBuffer.slice(0), zoomBox, styleBox, {
        className: 'ws-docx',
        inWrapper: true,
        ignoreWidth: false,
        ignoreHeight: false,
        ignoreFonts: false,
        breakPages: !editMode,
        useBase64URL: true,
        renderHeaders: true,
        renderFooters: true,
        renderFootnotes: true,
        renderEndnotes: true,
        renderAltChunks: false,
      });

      if (destroyed) return;
      sanitizeDocxDom(zoomBox);
      if (editMode && canEdit) {
        bindInPlaceEditing(zoomBox);
      } else if (canEdit) {
        zoomBox.addEventListener('dblclick', () => {
          editMode = true;
          renderCurrentMode().catch((err) => {
            if (!destroyed && !ctx.isStale?.()) onRenderError?.(err);
          });
          showToast?.('已开启「编辑」，点击段落或表格即可直接修改', 1800);
        });
      }
      applyNativeZoom();
      if (prevState?.scrollTop) {
        stageEl.scrollTop = prevState.scrollTop;
      }
    }

    async function renderReaderDocx() {
      onStatusBadge?.('mammoth 精简阅读');
      stageEl.innerHTML = '';
      if (typeof global.mammoth?.convertToHtml !== 'function' || typeof global.DOMPurify?.sanitize !== 'function') {
        throw makeVendorMissingError('离线 Word 阅读引擎 (mammoth / DOMPurify) 未加载');
      }
      const res = await global.mammoth.convertToHtml({ arrayBuffer: currentBuffer.slice(0) });
      if (destroyed || ctx.isStale?.()) return;
      const safeHtml = global.DOMPurify.sanitize(res.value || '<p>（空白文档）</p>', {
        FORBID_TAGS: [
          'script',
          'iframe',
          'object',
          'embed',
          'style',
          'link',
          'base',
          'meta',
          'form',
          'video',
          'audio',
          'source',
          'picture',
        ],
        FORBID_ATTR: ['onerror', 'onload', 'onclick', 'srcset', 'ping', 'poster', 'background'],
      });

      const tpl = document.createElement('template');
      tpl.innerHTML = safeHtml;
      sanitizeDocxDom(tpl.content);

      const wrap = document.createElement('div');
      wrap.className = 'ws-reader-wrap';

      const paper = document.createElement('article');
      paper.className = 'ws-reader-paper';
      paper.appendChild(tpl.content);

      const headings = Array.from(paper.querySelectorAll('h1, h2, h3, h4'));
      if (showToc && headings.length > 0) {
        const toc = document.createElement('aside');
        toc.className = 'ws-reader-toc';
        const title = document.createElement('div');
        title.className = 'ws-reader-toc-title';
        title.textContent = '文档大纲';
        toc.appendChild(title);

        headings.forEach((h, idx) => {
          const level = Number(h.tagName.slice(1)) || 1;
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'ws-toc-item';
          btn.style.paddingLeft = `${6 + (level - 1) * 10}px`;
          btn.textContent = h.textContent?.trim() || `节 ${idx + 1}`;
          btn.addEventListener('click', () => {
            h.scrollIntoView({ behavior: 'smooth', block: 'start' });
          });
          toc.appendChild(btn);
        });
        wrap.appendChild(toc);
      }

      wrap.appendChild(paper);
      stageEl.appendChild(wrap);
      if (prevState?.scrollTop) {
        stageEl.scrollTop = prevState.scrollTop;
      }
    }

    async function renderPdfMode(myModeSeq = modeSeq) {
      const isPdfStale = () => destroyed || Boolean(ctx.isStale?.()) || myModeSeq !== modeSeq;
      onStatusBadge?.('正在转换 Word PDF...');
      stageEl.innerHTML =
        '<div class="ws-empty-welcome"><p>正在调用本地 Office / LibreOffice 转换高保真 PDF...</p></div>';
      const r = await apiFetch('/api/doc/convert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: file.path,
          conversationId: conversationId || '',
          workspaceGen: ctx.getWorkspaceGen?.(),
        }),
      });
      const data = await r.json();
      if (isPdfStale()) return;

      if (data?.mode === 'pdf' && data.pdfUrl && mountPdfUrl) {
        onStatusBadge?.(`${data.engine === 'cache' ? 'PDF 缓存' : data.engine} · 像素级`);
        buildToolbar();
        updateEditUi();
        const extraRight = document.createElement('div');
        extraRight.className = 'ws-toolbar-group';
        extraRight.append(...Array.from(toolbarEl.childNodes));
        toolbarEl.innerHTML = '';

        const nextCtrl = await mountPdfUrl({
          url: data.pdfUrl,
          stageEl,
          toolbarEl,
          mode: 'document',
          prevState: prevState?.pdfState,
          extraToolbarRight: extraRight,
          registerCleanup,
          isStale: isPdfStale,
        });
        if (isPdfStale()) {
          nextCtrl?.destroy?.();
          return;
        }
        pdfCtrl = nextCtrl;
      } else {
        onStatusBadge?.('PDF 转换不可用，已回退原生排版');
        viewMode = 'native';
        await renderCurrentMode();
      }
    }

    async function renderCurrentMode() {
      if (destroyed || ctx.isStale?.()) return;
      const myModeSeq = ++modeSeq;
      if (pdfCtrl) {
        pdfCtrl.destroy();
        pdfCtrl = null;
      }
      nativeZoomBox = null;
      buildToolbar();
      updateEditUi();
      if (viewMode === 'native') {
        await renderNativeDocx();
      } else if (viewMode === 'reader') {
        await renderReaderDocx();
      } else {
        await renderPdfMode(myModeSeq);
      }
    }

    keyHandler = (e) => {
      if (destroyed || !canEdit) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        if (editMode || dirty) {
          e.preventDefault();
          saveDocxChanges({ silent: false });
        }
      }
    };
    global.addEventListener('keydown', keyHandler);

    resizeObserver = new ResizeObserver(() => {
      if (destroyed || viewMode !== 'native' || zoomMode !== 'fit') return;
      const w = stageEl.clientWidth || 0;
      if (Math.abs(w - lastObservedWidth) < 2) return;
      lastObservedWidth = w;
      if (resizeRafId) global.cancelAnimationFrame(resizeRafId);
      resizeRafId = global.requestAnimationFrame(() => {
        resizeRafId = 0;
        if (!destroyed && viewMode === 'native' && zoomMode === 'fit') {
          applyNativeZoom();
        }
      });
    });
    resizeObserver.observe(stageEl);

    await renderCurrentMode();

    return {
      isDirty: () => dirty,
      isAutoSave: () => autoSave,
      flushSave: (opts) => saveDocxChanges(opts),
      getState: () => ({
        viewMode,
        zoomMode,
        customZoom,
        showToc,
        editMode,
        autoSave,
        scrollTop: stageEl.scrollTop,
        pdfState: pdfCtrl?.getState?.() || null,
      }),
      destroy,
    };
  }

  global.WSModules = global.WSModules || {};
  global.WSModules.renderDocxPreview = renderDocxPreview;
})(window);
