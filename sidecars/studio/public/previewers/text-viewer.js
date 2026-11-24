(function (global) {
  'use strict';

  function apiFetch(url, options) {
    const f = global.sidecar && typeof global.sidecar.fetch === 'function'
      ? global.sidecar.fetch.bind(global.sidecar)
      : global.fetch.bind(global);
    return f(url, options);
  }

  function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[c]));
  }

  async function renderTextOrImagePreview(ctx) {
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
    let destroyed = false;
    const rawUrl = `/api/file/raw?path=${encodeURIComponent(file.path)}&conversationId=${encodeURIComponent(
      conversationId || ''
    )}&t=${Math.floor(file.mtimeMs || Date.now())}`;

    let autoSaveTimer = null;
    let splitPreviewTimer = null;
    let justSavedTimer = null;
    let keyHandler = null;

    const textDestroy = () => {
      destroyed = true;
      if (autoSaveTimer) clearTimeout(autoSaveTimer);
      if (splitPreviewTimer) clearTimeout(splitPreviewTimer);
      if (justSavedTimer) clearTimeout(justSavedTimer);
      if (keyHandler) global.removeEventListener('keydown', keyHandler);
    };
    registerCleanup?.(textDestroy);

    const MAX_TEXT_BYTES = 2 * 1024 * 1024;
    const resp = await apiFetch(`${rawUrl}&maxBytes=${MAX_TEXT_BYTES}`, { method: 'GET' });
    if (!resp.ok) throw new Error(`读取文件失败: HTTP ${resp.status}`);
    const hdrMtime = Number(resp.headers.get('X-File-Mtime'));
    if (!file.mtimeMs && Number.isFinite(hdrMtime) && hdrMtime > 0) {
      file.mtimeMs = hdrMtime;
    }
    let truncated = resp.headers.get('X-File-Truncated') === '1';
    let text = await resp.text();
    if (destroyed) return { getState: () => ({}), destroy: textDestroy };

    if (text.length > MAX_TEXT_BYTES) {
      text = text.slice(0, MAX_TEXT_BYTES);
      truncated = true;
    }

    const isMarkdown = file.category === 'markdown';
    let mdMode = prevState?.mdMode || 'rendered'; // 'rendered' | 'edit' | 'split' | 'source'
    let codeMode = prevState?.codeMode || 'view'; // 'view' | 'edit'
    let softWrap = prevState?.softWrap !== false;
    let autoSave = prevState?.autoSave !== false;
    let dirty = false;
    let saving = false;
    let editSeq = 0;
    const canEdit = Boolean(onSaveFile) && !truncated;

    const baseBadge = isMarkdown
      ? 'Markdown 渲染'
      : file.ext
        ? `${file.ext.slice(1).toUpperCase()} 代码`
        : '纯文本';

    let saveBtn = null;
    let autoSaveBtn = null;

    function updateSaveUi() {
      if (saveBtn) {
        saveBtn.classList.toggle('is-dirty', dirty && !saving);
        saveBtn.disabled = saving || !canEdit;
        const saveIcon = global.WSIcons?.render ? global.WSIcons.render('ui-save', { size: 12 }) : '';
        const label = saving ? '保存中...' : dirty ? '保存 *' : '保存';
        saveBtn.innerHTML = `${saveIcon}<span>${label}</span>`;
      }
      if (dirty) {
        onStatusBadge?.(`${baseBadge} · 未保存`);
      } else {
        onStatusBadge?.(baseBadge);
      }
    }

    async function performSave({ silent = false } = {}) {
      if (!canEdit || saving) return;
      if (!dirty) {
        if (!silent) showToast?.('当前无未保存修改', 1200);
        return;
      }
      if (autoSaveTimer) {
        clearTimeout(autoSaveTimer);
        autoSaveTimer = null;
      }
      saving = true;
      updateSaveUi();
      const seqAtStart = editSeq;
      try {
        const res = await onSaveFile({ content: text, encoding: 'utf8', silent });
        if (res?.success && !destroyed) {
          if (editSeq === seqAtStart) {
            dirty = false;
            updateSaveUi();
            if (saveBtn) {
              const saveIcon = global.WSIcons?.render ? global.WSIcons.render('ui-save', { size: 12 }) : '';
              saveBtn.innerHTML = `${saveIcon}<span>已保存</span>`;
              if (justSavedTimer) clearTimeout(justSavedTimer);
              justSavedTimer = setTimeout(() => {
                if (!destroyed) updateSaveUi();
              }, 1300);
            }
          } else {
            dirty = true;
            updateSaveUi();
            scheduleAutoSave();
          }
        }
      } finally {
        saving = false;
        if (!destroyed) updateSaveUi();
      }
    }

    function scheduleAutoSave() {
      if (!autoSave || !canEdit) return;
      if (autoSaveTimer) clearTimeout(autoSaveTimer);
      autoSaveTimer = setTimeout(() => {
        autoSaveTimer = null;
        if (!destroyed && dirty) {
          performSave({ silent: true });
        }
      }, 1000);
    }

    function renderMarkdownInto(article) {
      const rawHtml = global.marked.parse(text);
      const html = global.DOMPurify.sanitize(rawHtml, {
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
      tpl.innerHTML = html;
      const frag = tpl.content;

      for (const bad of frag.querySelectorAll(
        'video, audio, source, picture, iframe, object, embed, script, style, link, meta, base, form'
      )) {
        bad.remove();
      }

      for (const el of frag.querySelectorAll('*')) {
        if (el.hasAttribute('srcset')) el.removeAttribute('srcset');
        if (el.hasAttribute('ping')) el.removeAttribute('ping');
        if (el.hasAttribute('poster')) el.removeAttribute('poster');
        if (el.hasAttribute('background')) el.removeAttribute('background');
        const stVal = el.getAttribute('style');
        if (stVal && /url\s*\(/i.test(stVal)) {
          el.removeAttribute('style');
        }
      }

      for (const img of frag.querySelectorAll('img')) {
        const src = (img.getAttribute('src') || '').trim();
        const allowedImg = src.startsWith('data:image/') || src.startsWith('blob:');
        if (!allowedImg) {
          const placeholder = document.createElement('span');
          placeholder.style.cssText =
            'color:var(--ws-muted);font-size:11.5px;border:1px dashed var(--ws-border);padding:2px 6px;border-radius:4px;';
          placeholder.textContent = `[已屏蔽外部图片: ${img.getAttribute('alt') || src}]`;
          img.replaceWith(placeholder);
        }
      }

      for (const a of frag.querySelectorAll('a')) {
        const href = (a.getAttribute('href') || '').trim();
        if (!/^(https?:|mailto:|#)/i.test(href)) {
          a.removeAttribute('href');
        } else {
          a.setAttribute('target', '_blank');
          a.setAttribute('rel', 'noopener noreferrer');
        }
      }

      if (global.hljs) {
        for (const block of frag.querySelectorAll('pre code')) {
          try {
            global.hljs.highlightElement(block);
          } catch {}
        }
      }

      article.innerHTML = '';
      article.appendChild(frag);
    }

    const renderCodeView = () => {
      stageEl.innerHTML = '';
      if (truncated) {
        const warn = document.createElement('div');
        warn.style.cssText =
          'display:flex;align-items:center;gap:6px;padding:6px 12px;background:rgba(245,158,11,0.16);border-bottom:1px solid var(--ws-border);font-size:11.5px;';
        const warnIcon = global.WSIcons?.render ? global.WSIcons.render('ui-warn', { size: 13 }) : '';
        warn.innerHTML = `${warnIcon}<span>文件超过 2MB，已安全截断显示前 2MB（大文件禁用在线编辑）。</span>`;
        stageEl.appendChild(warn);
      }

      const lines = text.split(/\r?\n/);
      const extLang = file.ext?.replace(/^\./, '') || '';
      let highlightedHtml = '';
      if (global.hljs && lines.length <= 4000) {
        try {
          if (extLang && global.hljs.getLanguage(extLang)) {
            highlightedHtml = global.hljs.highlight(text, { language: extLang }).value;
          } else {
            highlightedHtml = global.hljs.highlightAuto(text).value;
          }
        } catch {
          highlightedHtml = escapeHtml(text);
        }
      } else {
        highlightedHtml = escapeHtml(text);
      }

      const htmlLines = highlightedHtml.split(/\r?\n/);
      const tbl = document.createElement('table');
      tbl.className = `ws-code-table ${softWrap ? 'is-wrap' : ''}`;
      const tbody = document.createElement('tbody');

      const renderLimit = Math.min(htmlLines.length, 6000);
      for (let i = 0; i < renderLimit; i++) {
        const tr = document.createElement('tr');
        const ln = document.createElement('td');
        ln.className = 'ws-ln';
        ln.textContent = String(i + 1);
        const codeTd = document.createElement('td');
        codeTd.className = 'ws-code-line';
        codeTd.innerHTML = htmlLines[i] || ' ';
        tr.append(ln, codeTd);
        tbody.appendChild(tr);
      }
      tbl.appendChild(tbody);
      if (canEdit) {
        tbl.title = '双击任意行进入实时编辑';
        tbl.addEventListener('dblclick', () => {
          if (isMarkdown) {
            mdMode = 'edit';
          } else {
            codeMode = 'edit';
          }
          syncToolbarActiveState();
          renderActiveView(true);
        });
      }
      stageEl.appendChild(tbl);
      if (prevState?.scrollTop) stageEl.scrollTop = prevState.scrollTop;
    };

    const renderMarkdownView = () => {
      stageEl.innerHTML = '';
      const article = document.createElement('article');
      article.className = 'ws-md-body';
      renderMarkdownInto(article);
      if (canEdit) {
        article.title = '双击正文进入实时编辑';
        article.addEventListener('dblclick', () => {
          mdMode = 'edit';
          syncToolbarActiveState();
          renderActiveView(true);
        });
      }
      stageEl.appendChild(article);
      if (prevState?.scrollTop) stageEl.scrollTop = prevState.scrollTop;
    };

    const renderEditorView = ({ splitMarkdown = false, autoFocus = false } = {}) => {
      stageEl.innerHTML = '';
      const shell = document.createElement('div');
      shell.className = splitMarkdown ? 'ws-editor-split' : 'ws-editor-shell';

      const ta = document.createElement('textarea');
      ta.className = 'ws-text-editor';
      ta.spellcheck = false;
      ta.value = text;

      let previewArticle = null;
      if (splitMarkdown) {
        const leftPane = document.createElement('div');
        leftPane.className = 'ws-editor-pane';
        leftPane.appendChild(ta);

        const rightPane = document.createElement('div');
        rightPane.className = 'ws-editor-pane';
        previewArticle = document.createElement('article');
        previewArticle.className = 'ws-md-body';
        renderMarkdownInto(previewArticle);
        rightPane.appendChild(previewArticle);

        shell.append(leftPane, rightPane);
      } else {
        shell.appendChild(ta);
      }

      const handleTextUpdate = () => {
        text = ta.value;
        dirty = true;
        editSeq += 1;
        updateSaveUi();
        scheduleAutoSave();
        if (splitMarkdown && previewArticle) {
          if (splitPreviewTimer) clearTimeout(splitPreviewTimer);
          splitPreviewTimer = setTimeout(() => {
            if (!destroyed && previewArticle) renderMarkdownInto(previewArticle);
          }, 60);
        }
      };

      ta.addEventListener('input', handleTextUpdate);
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Tab') {
          e.preventDefault();
          const start = ta.selectionStart ?? 0;
          const end = ta.selectionEnd ?? 0;
          ta.setRangeText('  ', start, end, 'end');
          handleTextUpdate();
        } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
          e.preventDefault();
          performSave({ silent: false });
        }
      });

      stageEl.appendChild(shell);
      if (autoFocus) ta.focus();
    };

    toolbarEl.classList.remove('is-hidden');
    toolbarEl.innerHTML = '';
    const left = document.createElement('div');
    left.className = 'ws-toolbar-group';

    const modeButtons = new Map();
    function syncToolbarActiveState() {
      const currentKey = isMarkdown ? mdMode : codeMode;
      for (const [k, btn] of modeButtons.entries()) {
        btn.classList.toggle('is-active', k === currentKey);
      }
      if (saveBtn) {
        const editing = isMarkdown ? (mdMode === 'edit' || mdMode === 'split') : codeMode === 'edit';
        saveBtn.classList.toggle('is-hidden', !editing && !dirty);
      }
      if (autoSaveBtn) {
        const editing = isMarkdown ? (mdMode === 'edit' || mdMode === 'split') : codeMode === 'edit';
        autoSaveBtn.classList.toggle('is-hidden', !editing && !dirty);
      }
    }

    function renderActiveView(autoFocus = false) {
      if (isMarkdown) {
        if (mdMode === 'edit' && canEdit) {
          renderEditorView({ splitMarkdown: false, autoFocus });
        } else if (mdMode === 'split' && canEdit) {
          renderEditorView({ splitMarkdown: true, autoFocus });
        } else if (mdMode === 'source') {
          renderCodeView();
        } else {
          renderMarkdownView();
        }
      } else if (codeMode === 'edit' && canEdit) {
        renderEditorView({ splitMarkdown: false, autoFocus });
      } else {
        renderCodeView();
      }
    }

    const editIcon = global.WSIcons?.render ? global.WSIcons.render('ui-edit', { size: 12 }) : '';

    if (isMarkdown) {
      const seg = document.createElement('div');
      seg.className = 'ws-seg';
      const modes = [
        { key: 'rendered', label: '排版预览' },
        ...(canEdit
          ? [
              { key: 'edit', label: `${editIcon}<span>实时编辑</span>`, html: true },
              { key: 'split', label: '双栏同屏' },
            ]
          : []),
        { key: 'source', label: '源码' },
      ];
      for (const m of modes) {
        const btn = document.createElement('button');
        btn.type = 'button';
        if (m.html) btn.innerHTML = m.label;
        else btn.textContent = m.label;
        btn.className = mdMode === m.key ? 'is-active' : '';
        btn.addEventListener('click', () => {
          mdMode = m.key;
          syncToolbarActiveState();
          renderActiveView(m.key === 'edit' || m.key === 'split');
        });
        modeButtons.set(m.key, btn);
        seg.appendChild(btn);
      }
      left.appendChild(seg);
    } else {
      if (canEdit) {
        const seg = document.createElement('div');
        seg.className = 'ws-seg';
        const bView = document.createElement('button');
        bView.type = 'button';
        bView.textContent = '只读高亮';
        bView.className = codeMode === 'view' ? 'is-active' : '';
        const bEdit = document.createElement('button');
        bEdit.type = 'button';
        bEdit.innerHTML = `${editIcon}<span>实时编辑</span>`;
        bEdit.className = codeMode === 'edit' ? 'is-active' : '';

        bView.addEventListener('click', () => {
          codeMode = 'view';
          syncToolbarActiveState();
          renderActiveView(false);
        });
        bEdit.addEventListener('click', () => {
          codeMode = 'edit';
          syncToolbarActiveState();
          renderActiveView(true);
        });
        modeButtons.set('view', bView);
        modeButtons.set('edit', bEdit);
        seg.append(bView, bEdit);
        left.appendChild(seg);
      }

      const wrapBtn = document.createElement('button');
      wrapBtn.type = 'button';
      wrapBtn.className = `ws-chip-btn ${softWrap ? 'is-active' : ''}`;
      wrapBtn.textContent = '自动换行';
      wrapBtn.addEventListener('click', () => {
        softWrap = !softWrap;
        wrapBtn.classList.toggle('is-active', softWrap);
        stageEl.querySelector('.ws-code-table')?.classList.toggle('is-wrap', softWrap);
      });
      left.appendChild(wrapBtn);
    }

    const right = document.createElement('div');
    right.className = 'ws-toolbar-group';

    if (canEdit) {
      autoSaveBtn = document.createElement('button');
      autoSaveBtn.type = 'button';
      autoSaveBtn.className = `ws-chip-btn ${autoSave ? 'is-active' : ''}`;
      autoSaveBtn.textContent = '自动保存';
      autoSaveBtn.title = '输入停止 1 秒后自动保存回磁盘';
      autoSaveBtn.addEventListener('click', () => {
        autoSave = !autoSave;
        autoSaveBtn.classList.toggle('is-active', autoSave);
        if (autoSave && dirty) scheduleAutoSave();
      });

      saveBtn = document.createElement('button');
      saveBtn.type = 'button';
      saveBtn.className = 'ws-chip-btn';
      saveBtn.title = '立即保存回磁盘 (Ctrl+S)';
      saveBtn.addEventListener('click', () => performSave({ silent: false }));

      right.append(autoSaveBtn, saveBtn);
    }

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'ws-btn-ghost';
    const copyIcon = global.WSIcons?.render ? global.WSIcons.render('ui-copy', { size: 12 }) : '';
    const setCopyLabel = (label) => {
      copyBtn.innerHTML = `${copyIcon}<span>${label}</span>`;
    };
    setCopyLabel('复制全文');
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(text);
        copyBtn.textContent = '✓ 已复制';
        setTimeout(() => {
          setCopyLabel('复制全文');
        }, 1400);
      } catch {}
    });

    right.appendChild(copyBtn);
    toolbarEl.append(left, right);

    keyHandler = (e) => {
      if (destroyed) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        const editing = isMarkdown ? (mdMode === 'edit' || mdMode === 'split') : codeMode === 'edit';
        if (editing || dirty) {
          e.preventDefault();
          performSave({ silent: false });
        }
      }
    };
    global.addEventListener('keydown', keyHandler);

    updateSaveUi();
    syncToolbarActiveState();
    renderActiveView(false);

    return {
      isDirty: () => dirty,
      isAutoSave: () => autoSave,
      flushSave: (opts) => performSave(opts),
      getState: () => ({
        mdMode,
        codeMode,
        softWrap,
        autoSave,
        scrollTop: stageEl.scrollTop,
      }),
      destroy: textDestroy,
    };
  }

  global.WSModules = global.WSModules || {};
  global.WSModules.renderTextOrImagePreview = renderTextOrImagePreview;
})(window);
