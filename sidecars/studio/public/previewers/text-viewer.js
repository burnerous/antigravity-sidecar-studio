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

  function lexMarkdownBlocks(source) {
    const marked = global.marked;
    if (!marked?.lexer) return null;

    const spans = [];
    let offset = 0;
    let tokenCount = 0;
    let lastRaw;
    let observed = false;
    function recordSpan(end, tokens) {
      if (end === offset) return;
      const raw = source.slice(offset, end);
      const token = tokens.at(-1);
      if (tokens.length > tokenCount) {
        spans.push({ raw, type: token.type, depth: token.depth || 0, token });
      } else if (token && token.raw !== lastRaw) {
        spans.at(-1).raw += raw;
      } else {
        spans.push({ raw, type: 'def', depth: 0, token: null });
      }
      tokenCount = tokens.length;
      lastRaw = token?.raw;
      offset = end;
    }

    // Observe each top-level lexer step without consuming anything. Marked can
    // rewrite token.raw inside containers or omit raw link definitions entirely.
    function observe(rest, tokens) {
      if (tokens !== this.lexer.tokens) return;
      observed = true;
      recordSpan(source.length - rest.length, tokens);
    }
    const extensions = marked.defaults?.extensions;
    const tokens = marked.lexer(source, {
      ...marked.defaults,
      extensions: { ...extensions, block: [observe, ...(extensions?.block || [])] },
    });
    if (observed && tokens) {
      recordSpan(source.length, tokens);
      return spans;
    }
    if (tokens?.map((token) => token.raw).join('') !== source) return null;
    return tokens.map((token) => ({ raw: token.raw, type: token.type, depth: token.depth || 0, token }));
  }

  function parseMarkdownBlocks(source) {
    const eol = source.includes('\r\n') ? '\r\n' : source.includes('\r') ? '\r' : '\n';
    const crlfOffsets = [];
    const normalized = source.replace(/\r\n?/g, (ending, offset) => {
      if (ending.length === 2) crlfOffsets.push(offset - crlfOffsets.length);
      return '\n';
    });
    let leadingSpace = normalized.startsWith('\uFEFF') ? '\uFEFF' : '';
    const input = normalized.slice(leadingSpace.length);
    const blocks = [];
    const tokens = lexMarkdownBlocks(input);
    if (/^[ \t\n]*$/.test(input)) {
      leadingSpace += input;
    } else if (!tokens?.length) {
      blocks.push({ raw: input, type: 'raw', depth: 0, token: null });
    } else {
      for (const span of tokens) {
        if (span.type === 'space') {
          if (blocks.length) blocks.at(-1).raw += span.raw;
          else leadingSpace += span.raw;
        } else {
          blocks.push(span);
        }
      }
    }

    // Map the normalized token boundaries back to the original string. This
    // also preserves mixed EOLs and whitespace-only lines between blocks.
    let crlfIndex = 0;
    function sourceOffset(offset) {
      while (crlfOffsets[crlfIndex] < offset) crlfIndex += 1;
      return offset + crlfIndex;
    }
    let offset = leadingSpace.length;
    const leadingSource = source.slice(0, sourceOffset(offset));
    for (const block of blocks) {
      let lastContent = block.raw.length;
      while (lastContent && ' \t\n'.includes(block.raw[lastContent - 1])) lastContent -= 1;
      const trailingStart = block.raw.indexOf('\n', lastContent);
      const contentLength = trailingStart === -1 ? block.raw.length : trailingStart;
      const start = sourceOffset(offset);
      const contentEnd = sourceOffset(offset + contentLength);
      offset += block.raw.length;
      block.content = block.initialContent = block.raw.slice(0, contentLength);
      block.sourceContent = source.slice(start, contentEnd);
      block.trailing = source.slice(contentEnd, sourceOffset(offset));
      block.start = start;
    }
    return { eol, leadingSpace, leadingSource, blocks };
  }

  function joinMarkdownBlocks(doc) {
    const parts = [doc.leadingSource];
    let offset = doc.leadingSource.length;
    let previous = null;
    for (const block of doc.blocks) {
      const changed = block.content !== block.initialContent;
      if ((changed || block.inserted) && !block.content.trim()) continue;

      if (!previous && block.inserted && /[ \t]$/.test(doc.leadingSpace)) {
        // Complete an existing blank line before writing the first paragraph.
        parts.push(doc.eol);
        offset += doc.eol.length;
      } else if (previous && (previous.inserted || block.inserted)) {
        const tail = parts.at(-1);
        const newline = /(?:\r\n?|\n)[ \t]*$/;
        const lastBreak = newline.exec(tail);
        const separator = !lastBreak ? doc.eol.repeat(2)
          : newline.test(tail.slice(0, lastBreak.index)) ? '' : doc.eol;
        parts.push(separator);
        offset += separator.length;
      }

      block.start = offset;
      const content = changed ? block.content.replace(/\n/g, doc.eol) : block.sourceContent;
      const raw = content + block.trailing;
      parts.push(raw);
      offset += raw.length;
      previous = block;
    }
    return !previous && doc.blocks.some((block) => !block.inserted) ? '' : parts.join('');
  }

  function markdownTaskOffsets(token, source = token?.raw) {
    const tasks = new Map();
    const taskMarker = /^([ \t]*(?:[-*+]|\d+[.)])[ \t]+\[)[ xX]\]/;
    const stateMarker = /\[[ xX]\]/g;

    function visit(block, locate, raw = block.raw) {
      if (block.type === 'list') {
        let offset = 0;
        for (const item of block.items) {
          const start = offset;
          visit(item, (index) => locate(start + index));
          offset += item.raw.length;
        }
        return;
      }
      if (block.type !== 'list_item' && block.type !== 'blockquote') return;

      const marker = block.task && taskMarker.exec(raw);
      if (marker) {
        const offset = locate(marker[1].length);
        if (offset >= 0) tasks.set(block, offset);
      }

      // The lexer strips container prefixes from nested blocks. Match the
      // marker from the end of its original line, where the two texts agree.
      let cursor = 0;
      let textLineStart = 0;
      let rawLineStart = 0;
      for (const child of block.tokens) {
        const start = block.text.indexOf(child.raw, cursor);
        if (start === -1) continue;
        cursor = start + child.raw.length;
        visit(child, (index) => {
          const offset = start + index;
          let textLineEnd = block.text.indexOf('\n', textLineStart);
          while (textLineEnd !== -1 && textLineEnd < offset) {
            textLineStart = textLineEnd + 1;
            textLineEnd = block.text.indexOf('\n', textLineStart);
            const rawLineEnd = raw.indexOf('\n', rawLineStart);
            if (rawLineEnd === -1) return -1;
            rawLineStart = rawLineEnd + 1;
          }
          const rawLineEnd = raw.indexOf('\n', rawLineStart);
          const rawLine = raw.slice(rawLineStart, rawLineEnd === -1 ? undefined : rawLineEnd);
          const tail = block.text.slice(offset - 1, textLineEnd === -1 ? undefined : textLineEnd);
          const count = Array.from(tail.matchAll(stateMarker)).length;
          const match = count && Array.from(rawLine.matchAll(stateMarker)).at(-count);
          return match ? locate(rawLineStart + match.index + 1) : -1;
        });
      }
    }

    if (token) visit(token, (offset) => offset, source);
    return tasks;
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
      onRenderError,
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
    let disposeLiveView = null;
    let flushActiveLiveBlock = null;

    const textDestroy = () => {
      destroyed = true;
      disposeLiveView?.();
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
    const isMarkdown = file.category === 'markdown';
    let truncated = resp.headers.get('X-File-Truncated') === '1';
    let text = isMarkdown && typeof resp.arrayBuffer === 'function'
      ? new TextDecoder('utf-8', { ignoreBOM: true }).decode(await resp.arrayBuffer())
      : await resp.text();
    if (destroyed) return { getState: () => ({}), destroy: textDestroy };

    if (text.length > MAX_TEXT_BYTES) {
      text = text.slice(0, MAX_TEXT_BYTES);
      truncated = true;
    }

    const canEdit = Boolean(onSaveFile) && !truncated;
    let mdMode = prevState?.mdMode || 'rendered'; // 'rendered' | 'live' | 'edit' | 'split' | 'source'
    if (!canEdit && mdMode !== 'source') mdMode = 'rendered';
    let codeMode = prevState?.codeMode || 'view'; // 'view' | 'edit'
    let softWrap = prevState?.softWrap !== false;
    let autoSave = prevState?.autoSave !== false;
    let dirty = false;
    let saveInFlight = null;
    let editSeq = 0;

    const baseBadge = isMarkdown
      ? 'Markdown 渲染'
      : file.ext
        ? `${file.ext.slice(1).toUpperCase()} 代码`
        : '纯文本';

    let saveBtn = null;
    let autoSaveBtn = null;

    function updateSaveUi() {
      if (saveBtn) {
        const saving = Boolean(saveInFlight);
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

    async function performSave({ silent = false, keepEditing = false } = {}) {
      if (!canEdit || destroyed || flushActiveLiveBlock?.({ keepEditing }) === false) return;
      if (saveInFlight) {
        await saveInFlight;
        if (dirty && !destroyed) return performSave({ silent, keepEditing });
        return;
      }
      if (!dirty) {
        if (!silent) showToast?.('当前无未保存修改', 1200);
        return;
      }
      if (autoSaveTimer) {
        clearTimeout(autoSaveTimer);
        autoSaveTimer = null;
      }
      const seqAtStart = editSeq;
      const content = text;
      saveInFlight = Promise.resolve().then(() => onSaveFile({ content, encoding: 'utf8', silent }));
      updateSaveUi();
      try {
        const res = await saveInFlight;
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
        saveInFlight = null;
        if (!destroyed) updateSaveUi();
      }
    }

    function scheduleAutoSave() {
      if (!autoSave || !canEdit) return;
      if (autoSaveTimer) clearTimeout(autoSaveTimer);
      autoSaveTimer = setTimeout(() => {
        autoSaveTimer = null;
        if (!destroyed && autoSave && dirty) {
          performSave({ silent: true, keepEditing: true });
        }
      }, 1000);
    }

    function renderMarkdownInto(article, sourceText = text, { token, renderer } = {}) {
      const marked = global.marked;
      if (typeof marked?.parse !== 'function' || typeof global.DOMPurify?.sanitize !== 'function') {
        const err = new Error('离线 Markdown 渲染引擎 (marked / DOMPurify) 未加载');
        err.code = 'VENDOR_MISSING';
        throw err;
      }
      const rawHtml = token?.type === 'def' ? ''
        : token && marked.parser ? marked.parser([token], renderer ? { ...marked.defaults, renderer } : undefined)
        : marked.parse(sourceText.replace(/^\uFEFF/, ''));
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
    };

    function renderMarkdownView() {
      const scrollTop = stageEl.scrollTop;
      const article = document.createElement('article');
      article.className = 'ws-md-body';
      article.classList.toggle('is-editable', canEdit);
      const { blocks } = parseMarkdownBlocks(text);
      const openLive = (options) => {
        mdMode = 'live';
        syncToolbarActiveState();
        renderLiveMarkdownView(options);
      };
      if (!blocks.length) {
        const empty = document.createElement(canEdit ? 'button' : 'p');
        empty.className = 'ws-md-empty';
        empty.textContent = '当前 Markdown 文档为空';
        if (canEdit) {
          empty.type = 'button';
          empty.addEventListener('click', () => openLive({ insertAtOffset: text.length }));
        }
        article.appendChild(empty);
      }
      blocks.forEach((block, index) => {
        if (block.type === 'def') return;
        const blockEl = document.createElement('div');
        blockEl.className = 'ws-md-rendered-block';
        blockEl.dataset.blockIndex = index;
        renderMarkdownInto(blockEl, block.content, { token: block.token });
        article.appendChild(blockEl);
      });
      if (canEdit) {
        article.title = '双击任意段落进入预览直编';
        article.addEventListener('dblclick', (e) => {
          if (e.target.closest?.('a, input, button')) return;
          const blockEl = e.target.closest?.('.ws-md-rendered-block');
          if (blockEl?.parentElement === article) {
            openLive({ focusBlockIndex: Number(blockEl.dataset.blockIndex) });
          }
        });
      }
      stageEl.replaceChildren(article);
      stageEl.scrollTop = scrollTop;
    }

    function renderLiveMarkdownView({ focusBlockIndex = -1, focusOffset = -1, insertAtOffset = -1, caretPos = 'end' } = {}) {
      const scrollTop = stageEl.scrollTop;
      disposeLiveView?.();
      const doc = parseMarkdownBlocks(text);
      const article = document.createElement('article');
      article.className = 'ws-md-body ws-md-live';
      const blockEls = [];
      let activeEdit = null;

      if (insertAtOffset >= 0) {
        const index = doc.blocks.findIndex((block) => block.start >= insertAtOffset);
        focusBlockIndex = index === -1 ? doc.blocks.length : index;
        doc.blocks.splice(focusBlockIndex, 0, {
          type: 'paragraph',
          content: '',
          initialContent: '',
          sourceContent: '',
          trailing: '',
          inserted: true,
        });
      } else if (focusOffset >= 0) {
        // An edit can split or remove earlier blocks. Follow the original
        // target's source offset through tokenization instead of its index.
        focusBlockIndex = doc.blocks.findLastIndex((block) => block.start <= focusOffset);
      }

      function syncDocToText() {
        const nextText = joinMarkdownBlocks(doc);
        if (nextText === text) return;
        text = nextText;
        dirty = true;
        editSeq += 1;
        updateSaveUi();
        scheduleAutoSave();
      }

      function syncActiveEditor() {
        activeEdit.block.content = activeEdit.textarea.value;
        syncDocToText();
      }

      function commitActiveBlock({ relex = true, nextBlock = null, caretPos = 'end' } = {}) {
        if (!activeEdit) return;
        if (activeEdit.composing) activeEdit.textarea.blur();
        syncActiveEditor();
        activeEdit = null;
        if (relex) renderLiveMarkdownView({ focusOffset: nextBlock?.start, caretPos });
      }

      function insertBlock(beforeBlock) {
        commitActiveBlock({ relex: false });
        renderLiveMarkdownView({ insertAtOffset: beforeBlock?.start ?? text.length });
      }

      function renderBlockPreview(blockEl, block, index) {
        const renderedEl = document.createElement('div');
        renderedEl.className = 'ws-md-live-rendered';
        renderedEl.tabIndex = 0;
        const offsets = markdownTaskOffsets(block.token, block.content);
        const tasks = new Map(Array.from(offsets, ([item, offset]) => [offset, item]));
        let renderer;
        if (tasks.size) {
          renderer = new global.marked.Renderer();
          const renderListItem = renderer.listitem;
          const renderCheckbox = renderer.checkbox;
          let taskOffset;
          renderer.listitem = function (item) {
            taskOffset = offsets.get(item);
            if (item.task && item.loose) {
              // Marked adds the checkbox to loose list tokens in place.
              // Keep the original tokens reusable when only a check changes.
              const [first, ...rest] = item.tokens;
              const tokens = first?.type === 'paragraph'
                ? [{ ...first, tokens: first.tokens?.map((child) => ({ ...child })) }, ...rest]
                : [...item.tokens];
              return renderListItem.call(this, { ...item, tokens });
            }
            return renderListItem.call(this, item);
          };
          renderer.checkbox = function (state) {
            const html = renderCheckbox.call(this, state);
            return taskOffset === undefined ? html
              : html.replace('<input ', `<input data-ws-md-task="${taskOffset}" `);
          };
        }

        if (!block.content.trim() || block.type === 'def') {
          renderedEl.classList.add('ws-md-live-empty');
          renderedEl.textContent = block.type === 'def' ? '（链接定义，点击编辑）' : '（空段落，点击编辑）';
        } else {
          renderMarkdownInto(renderedEl, block.content, { token: block.token, renderer });
        }

        for (const checkbox of renderedEl.querySelectorAll('input[type="checkbox"][data-ws-md-task]')) {
          const offset = Number(checkbox.dataset.wsMdTask);
          const task = tasks.get(offset);
          if (!task || !/^\[[ xX]\]$/.test(block.content.slice(offset - 1, offset + 2))) continue;
          checkbox.disabled = false;
          checkbox.addEventListener('click', (e) => {
            e.stopPropagation();
            const state = checkbox.checked ? 'x' : ' ';
            let sourceIndex = offset;
            for (const match of block.sourceContent.matchAll(/\r\n/g)) {
              if (match.index >= sourceIndex) break;
              sourceIndex += 1;
            }
            block.sourceContent = block.sourceContent.slice(0, sourceIndex) + state + block.sourceContent.slice(sourceIndex + 1);
            block.content = block.initialContent = block.content.slice(0, offset) + state + block.content.slice(offset + 1);
            task.checked = checkbox.checked;
            syncDocToText();
            if (activeEdit) {
              commitActiveBlock();
            } else {
              const focused = document.activeElement === checkbox;
              renderBlockPreview(blockEl, block, index);
              if (focused) blockEl.querySelector(`input[data-ws-md-task="${offset}"]`)?.focus({ preventScroll: true });
            }
          });
        }

        renderedEl.addEventListener('click', (e) => {
          if (e.target.closest?.('a, input, button') || global.getSelection()?.toString().trim()) return;
          activateBlockEdit(index);
        });
        renderedEl.addEventListener('keydown', (e) => {
          if (e.target === renderedEl && e.key === 'Enter') {
            e.preventDefault();
            activateBlockEdit(index);
          }
        });
        blockEl.classList.remove('is-editing');
        blockEl.replaceChildren(renderedEl);
      }

      function activateBlockEdit(index, caretPos = 'end') {
        if (destroyed) return;
        const block = doc.blocks[index];
        const blockEl = blockEls[index];
        if (activeEdit) {
          if (activeEdit.block === block) activeEdit.textarea.focus();
          else commitActiveBlock({ nextBlock: block, caretPos });
          return;
        }

        const bar = document.createElement('div');
        bar.className = 'ws-md-block-bar';
        const ta = document.createElement('textarea');
        ta.className = 'ws-md-block-editor';
        if (block.type === 'heading') ta.classList.add(`is-heading-${block.depth}`);
        if (block.type === 'code') ta.classList.add('is-code');
        if (block.type === 'blockquote') ta.classList.add('is-quote');
        ta.rows = 1;
        ta.spellcheck = false;
        ta.setAttribute('aria-label', '编辑 Markdown 段落');
        ta.value = block.content;
        const edit = { block, blockEl, textarea: ta, composing: false };
        activeEdit = edit;

        function autoResize() {
          ta.style.height = 'auto';
          ta.style.height = `${Math.max(28, ta.scrollHeight)}px`;
        }

        function applyInput() {
          if (activeEdit !== edit) return;
          autoResize();
          if (!edit.composing) syncActiveEditor();
        }

        function wrapSelection(marker) {
          const { selectionStart: start, selectionEnd: end, value } = ta;
          ta.setRangeText(marker + value.slice(start, end) + marker, start, end, 'end');
          ta.setSelectionRange(start + marker.length, end + marker.length);
          applyInput();
        }

        function toggleLines(prefix, heading = false) {
          const { selectionStart: start, selectionEnd: end, value } = ta;
          const from = start === 0 ? 0 : value.lastIndexOf('\n', start - 1) + 1;
          const last = heading || start === end ? start : end - 1;
          const lineEnd = value.indexOf('\n', last);
          const to = lineEnd === -1 ? value.length : lineEnd;
          const lines = value.slice(from, to).split('\n');
          const remove = lines.every((line) => line.startsWith(prefix));
          const updated = lines.map((line) => {
            if (remove) return line.slice(prefix.length);
            if (heading) return prefix + line.replace(/^#{1,6}(?:[ \t]+|$)/, '');
            return line.startsWith(prefix) ? line : prefix + line;
          }).join('\n');
          ta.setRangeText(updated, from, to, 'select');
          if (start === end) {
            const caret = Math.max(from, start + updated.length - (to - from));
            ta.setSelectionRange(caret, caret);
          }
          applyInput();
        }

        function addButton(label, action, className = '') {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'ws-md-block-btn';
          if (className) button.classList.add(className);
          button.textContent = label;
          button.addEventListener('mousedown', (e) => e.preventDefault());
          button.addEventListener('click', () => {
            if (!edit.composing && activeEdit === edit) action();
          });
          bar.appendChild(button);
        }

        addButton('B', () => wrapSelection('**'));
        addButton('I', () => wrapSelection('*'));
        addButton('`', () => wrapSelection('`'));
        addButton('H2', () => toggleLines('## ', true));
        addButton('H3', () => toggleLines('### ', true));
        addButton('列表', () => toggleLines('- '));
        addButton('引用', () => toggleLines('> '));
        addButton('+ 插块', () => insertBlock(doc.blocks[index + 1]));
        addButton('删除', () => {
          ta.value = '';
          commitActiveBlock();
        }, 'is-danger');
        addButton('完成', () => commitActiveBlock(), 'is-primary');

        ta.addEventListener('compositionstart', () => { edit.composing = true; });
        ta.addEventListener('compositionend', () => {
          edit.composing = false;
          applyInput();
          if (activeEdit === edit && dirty && !autoSaveTimer) scheduleAutoSave();
        });
        ta.addEventListener('input', (e) => {
          if (e.isComposing) autoResize();
          else applyInput();
        });
        ta.addEventListener('keydown', (e) => {
          if (e.isComposing || e.keyCode === 229 || edit.composing) return;
          const command = e.ctrlKey || e.metaKey;
          const key = e.key.toLowerCase();
          if (key === 'tab' && !e.shiftKey) {
            e.preventDefault();
            ta.setRangeText('  ', ta.selectionStart, ta.selectionEnd, 'end');
            applyInput();
          } else if (command && (key === 'b' || key === 'i' || key === 'e')) {
            e.preventDefault();
            wrapSelection({ b: '**', i: '*', e: '`' }[key]);
          } else if (command && key === 's') {
            e.preventDefault();
            performSave({ silent: false });
          } else if (key === 'escape' || (command && key === 'enter')) {
            e.preventDefault();
            commitActiveBlock();
          } else if (!command && !e.shiftKey && !e.altKey && ta.selectionStart === ta.selectionEnd) {
            if (key === 'arrowup' && ta.selectionStart === 0 && index > 0) {
              e.preventDefault();
              commitActiveBlock({ nextBlock: doc.blocks[index - 1] });
            } else if (key === 'arrowdown' && ta.selectionEnd === ta.value.length && index < doc.blocks.length - 1) {
              e.preventDefault();
              commitActiveBlock({ nextBlock: doc.blocks[index + 1], caretPos: 'start' });
            }
          }
        });

        blockEl.classList.add('is-editing');
        blockEl.replaceChildren(bar, ta);
        autoResize();
        ta.focus({ preventScroll: true });
        const caret = caretPos === 'start' ? 0 : ta.value.length;
        ta.setSelectionRange(caret, caret);
        blockEl.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }

      doc.blocks.forEach((block, index) => {
        const blockEl = document.createElement('div');
        blockEl.className = 'ws-md-live-block';
        blockEls.push(blockEl);
        renderBlockPreview(blockEl, block, index);
        article.appendChild(blockEl);
      });
      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'ws-md-live-add';
      add.textContent = '+ 添加新段落';
      add.addEventListener('click', () => insertBlock());
      article.appendChild(add);

      const commitOutsidePointer = (e) => {
        if (!activeEdit || activeEdit.composing || activeEdit.blockEl.contains(e.target)) return;
        // Leave other blocks and controls mounted until they receive their click.
        if (!e.target.closest?.('.ws-md-live-block, .ws-md-live-add')) commitActiveBlock();
      };
      stageEl.addEventListener('pointerdown', commitOutsidePointer);
      article.addEventListener('click', (e) => {
        if (activeEdit && !e.composedPath().includes(activeEdit.blockEl) && !global.getSelection()?.toString().trim()) {
          commitActiveBlock();
        }
      });
      flushActiveLiveBlock = ({ keepEditing = false, relex = true } = {}) => {
        if (!activeEdit) return;
        if (keepEditing) {
          if (activeEdit.composing) return false;
          syncActiveEditor();
        } else {
          commitActiveBlock({ relex });
        }
      };
      disposeLiveView = () => {
        stageEl.removeEventListener('pointerdown', commitOutsidePointer);
        activeEdit = null;
        flushActiveLiveBlock = null;
        disposeLiveView = null;
      };
      stageEl.replaceChildren(article);
      stageEl.scrollTop = scrollTop;
      if (doc.blocks[focusBlockIndex]) activateBlockEdit(focusBlockIndex, caretPos);
    }

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
    function isEditingMode() {
      return isMarkdown ? (mdMode === 'live' || mdMode === 'edit' || mdMode === 'split') : codeMode === 'edit';
    }

    function syncToolbarActiveState() {
      const currentKey = isMarkdown ? mdMode : codeMode;
      for (const [k, btn] of modeButtons.entries()) {
        btn.classList.toggle('is-active', k === currentKey);
      }
      const hideSaveControls = !isEditingMode() && !dirty;
      saveBtn?.classList.toggle('is-hidden', hideSaveControls);
      autoSaveBtn?.classList.toggle('is-hidden', hideSaveControls);
    }

    function renderActiveView(autoFocus = false) {
      if (isMarkdown) {
        if (mdMode === 'live' && canEdit) {
          renderLiveMarkdownView();
        } else if (mdMode === 'edit' && canEdit) {
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
              { key: 'live', label: `${editIcon}<span>预览直编</span>`, html: true },
              { key: 'edit', label: '源码编辑' },
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
          if (mdMode === m.key) return;
          flushActiveLiveBlock?.({ relex: false });
          disposeLiveView?.();
          mdMode = m.key;
          syncToolbarActiveState();
          try {
            renderActiveView(m.key === 'edit' || m.key === 'split');
          } catch (err) {
            if (typeof onRenderError === 'function') {
              textDestroy();
              onRenderError(err);
            } else {
              throw err;
            }
          }
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
      if (destroyed || e.defaultPrevented || e.isComposing || e.keyCode === 229) return;
      if (e.target?.classList?.contains('ws-md-block-editor')) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        if (isEditingMode() || dirty) {
          e.preventDefault();
          performSave({ silent: false });
        }
      }
    };
    global.addEventListener('keydown', keyHandler);

    updateSaveUi();
    syncToolbarActiveState();
    renderActiveView(false);
    if (prevState?.scrollTop) stageEl.scrollTop = prevState.scrollTop;

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
