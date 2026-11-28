(function (global) {
  'use strict';

  function apiFetch(url, options) {
    const f = global.sidecar && typeof global.sidecar.fetch === 'function'
      ? global.sidecar.fetch.bind(global.sidecar)
      : global.fetch.bind(global);
    return f(url, options);
  }

  function colIndexToName(col) {
    let n = col + 1;
    let out = '';
    while (n > 0) {
      const rem = (n - 1) % 26;
      out = String.fromCharCode(65 + rem) + out;
      n = Math.floor((n - 1) / 26);
    }
    return out;
  }

  try {
    Object.freeze(Object.prototype);
  } catch {}

  const MAX_XLSX_PARSE_BYTES = 32 * 1024 * 1024;

  function decodeCsvBuffer(buf) {
    const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    const hasBom = u8.length >= 3 && u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf;
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(u8);
      return { text, encoding: 'utf8', hasBom };
    } catch {
      try {
        const text = new TextDecoder('gb18030').decode(u8);
        return { text, encoding: 'gb18030', hasBom: false };
      } catch {
        const text = new TextDecoder('utf-8').decode(u8);
        return { text, encoding: 'utf8-lossy', hasBom };
      }
    }
  }

  function detectCsvDelimiter(text) {
    let inQuotes = false;
    const counts = { ',': 0, ';': 0, '\t': 0 };
    for (let i = 0; i < text.length && i < 8192; i++) {
      const ch = text[i];
      if (ch === '"') {
        if (inQuotes && text[i + 1] === '"') {
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (!inQuotes && (ch === '\n' || ch === '\r')) {
        break;
      } else if (!inQuotes && Object.prototype.hasOwnProperty.call(counts, ch)) {
        counts[ch]++;
      }
    }
    let best = ',';
    let bestCount = 0;
    for (const sep of [',', ';', '\t']) {
      if (counts[sep] > bestCount) {
        best = sep;
        bestCount = counts[sep];
      }
    }
    return best;
  }

  function parseCsvRaw(decoded) {
    const rawText = typeof decoded === 'string' ? decoded : decoded?.text || '';
    const encoding = typeof decoded === 'string' ? 'utf8' : decoded?.encoding || 'utf8';
    const hasBom = Boolean(
      (typeof decoded === 'object' && decoded?.hasBom) || rawText.startsWith('\uFEFF')
    );
    const body = rawText.startsWith('\uFEFF') ? rawText.slice(1) : rawText;
    const lineEnding = body.includes('\r\n') ? '\r\n' : '\n';
    const delimiter = detectCsvDelimiter(body);
    const trailingNewline = body.endsWith('\n') || body.endsWith('\r');

    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;

    for (let i = 0; i < body.length; i++) {
      const ch = body[i];
      if (inQuotes) {
        if (ch === '"') {
          if (body[i + 1] === '"') {
            field += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          field += ch;
        }
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === delimiter) {
        row.push(field);
        field = '';
      } else if (ch === '\r' || ch === '\n') {
        if (ch === '\r' && body[i + 1] === '\n') i++;
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
      } else {
        field += ch;
      }
    }
    row.push(field);
    rows.push(row);

    if (trailingNewline && rows.length > 1 && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === '') {
      rows.pop();
    }

    return {
      rows,
      meta: { delimiter, lineEnding, hasBom, encoding, trailingNewline },
    };
  }

  function serializeCsvRaw(rows, meta) {
    const delimiter = meta?.delimiter || ',';
    const lineEnding = meta?.lineEnding || '\n';
    const esc = (val) => {
      const s = String(val ?? '');
      if (s.includes('"') || s.includes(delimiter) || s.includes('\n') || s.includes('\r')) {
        return `"${s.replace(/"/g, '""')}"`;
      }
      return s;
    };
    let out = rows.map((r) => r.map(esc).join(delimiter)).join(lineEnding);
    if (meta?.trailingNewline && out.length > 0) out += lineEnding;
    if (meta?.hasBom) out = `\uFEFF${out}`;
    return out;
  }

  async function renderXlsxPreview(ctx) {
    const {
      file,
      stageEl,
      toolbarEl,
      conversationId,
      prevState,
      onQuoteRequest,
      onStatusBadge,
      onSaveFile,
      showToast,
      registerCleanup,
    } = ctx;
    let destroyed = false;
    let dirty = false;
    let saving = false;
    let editSeq = 0;
    let activeEditDirty = false;
    let autoSave = prevState?.autoSave !== false;
    let autoSaveTimer = null;
    let justSavedTimer = null;
    let keyHandler = null;
    let activeEditFinish = null;

    const isCsv = file.ext === '.csv';
    const isLegacyXls = file.ext === '.xls';
    let canEdit = Boolean(onSaveFile) && !isLegacyXls;

    const destroy = () => {
      destroyed = true;
      if (autoSaveTimer) clearTimeout(autoSaveTimer);
      if (justSavedTimer) clearTimeout(justSavedTimer);
      if (keyHandler) global.removeEventListener('keydown', keyHandler);
    };
    registerCleanup?.(destroy);

    onStatusBadge?.(
      isLegacyXls ? 'SheetJS · .xls 只读预览（防公式丢失）' : 'SheetJS · 双击单元格可编辑'
    );
    const rawUrl = `/api/file/raw?path=${encodeURIComponent(file.path)}&conversationId=${encodeURIComponent(
      conversationId || ''
    )}&t=${Math.floor(file.mtimeMs || Date.now())}`;
    const resp = await apiFetch(rawUrl, { method: 'GET' });
    if (!resp.ok) throw new Error(`读取表格失败: HTTP ${resp.status}`);
    const buf = await resp.arrayBuffer();
    if (destroyed || ctx.isStale?.()) return { getState: () => ({}), destroy };

    if (buf.byteLength > MAX_XLSX_PARSE_BYTES) {
      throw new Error(`表格文件过大（${Math.round(buf.byteLength / 1024 / 1024)} MB > 32 MB 解析上限）`);
    }

    if (typeof global.XLSX?.read !== 'function' || !global.XLSX?.utils) {
      const err = new Error('离线表格引擎 (SheetJS / xlsx) 未加载');
      err.code = 'VENDOR_MISSING';
      throw err;
    }

    let csvMeta = null;
    let csvAllRows = null;
    let wb;
    if (isCsv) {
      const parsedCsv = parseCsvRaw(decodeCsvBuffer(buf));
      csvMeta = parsedCsv.meta;
      csvAllRows = parsedCsv.rows;
      canEdit = Boolean(onSaveFile) && csvMeta.encoding === 'utf8';
      const ws = {};
      let maxColsCsv = 0;
      parsedCsv.rows.forEach((r, rIdx) => {
        if (r.length > maxColsCsv) maxColsCsv = r.length;
        r.forEach((cellVal, cIdx) => {
          const addr = global.XLSX.utils.encode_cell({ r: rIdx, c: cIdx });
          ws[addr] = { t: 's', v: cellVal };
        });
      });
      if (parsedCsv.rows.length > 0 && maxColsCsv > 0) {
        ws['!ref'] = global.XLSX.utils.encode_range({
          s: { r: 0, c: 0 },
          e: { r: parsedCsv.rows.length - 1, c: maxColsCsv - 1 },
        });
      }
      wb = { SheetNames: ['Sheet1'], Sheets: { Sheet1: ws } };
    } else {
      wb = global.XLSX.read(new Uint8Array(buf), {
        type: 'array',
        cellNF: true,
        cellDates: true,
        cellStyles: true,
        cellHTML: false,
        bookVBA: false,
        cellFormula: true,
      });
    }

    const sheetNames = wb.SheetNames || [];
    let activeSheet =
      prevState?.activeSheet && sheetNames.includes(prevState.activeSheet)
        ? prevState.activeSheet
        : sheetNames[0] || '';
    let searchQuery = prevState?.searchQuery || '';
    let filterCol = Number.isInteger(prevState?.filterCol) ? prevState.filterCol : -1;
    let filterQuery = prevState?.filterQuery || '';
    let freezeCol1 = Boolean(prevState?.freezeCol1);
    let rowLimit = prevState?.rowLimit || 500;
    let selectedRange = null;
    let matchCells = [];
    let matchCursor = -1;

    toolbarEl.classList.remove('is-hidden');
    toolbarEl.innerHTML = '';

    const left = document.createElement('div');
    left.className = 'ws-toolbar-group';

    const searchInput = document.createElement('input');
    searchInput.type = 'search';
    searchInput.placeholder = '表内搜索...';
    searchInput.value = searchQuery;
    searchInput.style.cssText =
      'width:120px;background:var(--ws-bg);border:1px solid var(--ws-border);border-radius:5px;padding:3px 7px;font-size:11.5px;outline:none;';

    const matchLabel = document.createElement('span');
    matchLabel.style.cssText = 'font-size:11px;color:var(--ws-muted);min-width:48px;';

    const prevMatchBtn = document.createElement('button');
    prevMatchBtn.type = 'button';
    prevMatchBtn.className = 'ws-btn-ghost';
    prevMatchBtn.textContent = '↑';
    prevMatchBtn.title = '上一个匹配';

    const nextMatchBtn = document.createElement('button');
    nextMatchBtn.type = 'button';
    nextMatchBtn.className = 'ws-btn-ghost';
    nextMatchBtn.textContent = '↓';
    nextMatchBtn.title = '下一个匹配';

    left.append(searchInput, matchLabel, prevMatchBtn, nextMatchBtn);

    const right = document.createElement('div');
    right.className = 'ws-toolbar-group';

    const colSelect = document.createElement('select');
    colSelect.className = 'ws-select';
    colSelect.style.maxWidth = '96px';
    colSelect.title = '选择筛选列';

    const filterInput = document.createElement('input');
    filterInput.type = 'search';
    filterInput.placeholder = '列筛选关键词...';
    filterInput.value = filterQuery;
    filterInput.style.cssText =
      'width:105px;background:var(--ws-bg);border:1px solid var(--ws-border);border-radius:5px;padding:3px 7px;font-size:11.5px;outline:none;';

    const freezeBtn = document.createElement('button');
    freezeBtn.type = 'button';
    freezeBtn.className = `ws-chip-btn ${freezeCol1 ? 'is-active' : ''}`;
    freezeBtn.textContent = '冻结首列';

    const addRowBtn = document.createElement('button');
    addRowBtn.type = 'button';
    addRowBtn.className = 'ws-chip-btn';
    addRowBtn.textContent = '+ 行';
    addRowBtn.title = '在当前工作表末尾追加一行';

    const addColBtn = document.createElement('button');
    addColBtn.type = 'button';
    addColBtn.className = 'ws-chip-btn';
    addColBtn.textContent = '+ 列';
    addColBtn.title = '在当前工作表右侧追加一列';

    const autoSaveBtn = document.createElement('button');
    autoSaveBtn.type = 'button';
    autoSaveBtn.className = `ws-chip-btn ${autoSave ? 'is-active' : ''}`;
    autoSaveBtn.textContent = '自动保存';
    autoSaveBtn.title = '修改单元格后 1 秒自动写回文件';

    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'ws-chip-btn';
    saveBtn.title = '立即保存表格 (Ctrl+S)';

    const quoteSelBtn = document.createElement('button');
    quoteSelBtn.type = 'button';
    quoteSelBtn.className = 'ws-chip-btn is-hidden';
    const quoteIcon = global.WSIcons?.render ? global.WSIcons.render('ui-quote', { size: 12 }) : '';
    const quoteIconWrap = document.createElement('span');
    quoteIconWrap.innerHTML = quoteIcon;
    const quoteSelLabel = document.createElement('span');
    quoteSelLabel.textContent = '引用选区';
    quoteSelBtn.append(quoteIconWrap, quoteSelLabel);

    if (canEdit) {
      right.append(colSelect, filterInput, freezeBtn, addRowBtn, addColBtn, autoSaveBtn, saveBtn, quoteSelBtn);
    } else {
      right.append(colSelect, filterInput, freezeBtn, quoteSelBtn);
    }
    toolbarEl.append(left, right);

    stageEl.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'ws-xlsx-wrap';
    const scrollEl = document.createElement('div');
    scrollEl.className = 'ws-xlsx-scroll';
    const tabsEl = document.createElement('div');
    tabsEl.className = 'ws-sheet-tabs';
    wrap.append(scrollEl, tabsEl);
    stageEl.appendChild(wrap);

    let currentMatrix = [];
    let currentMerges = [];
    let maxCol = 0;
    let sheetRStart = 0;
    let sheetCStart = 0;
    let fullRangeEndRow = 0;
    let fullRangeEndCol = 0;
    let isSheetTruncated = false;

    function updateSaveUi() {
      if (canEdit) {
        saveBtn.classList.toggle('is-dirty', dirty && !saving);
        saveBtn.disabled = saving;
        const saveIcon = global.WSIcons?.render ? global.WSIcons.render('ui-save', { size: 12 }) : '';
        const lbl = saving ? '保存中...' : dirty ? '保存 *' : '保存';
        saveBtn.innerHTML = `${saveIcon}<span>${lbl}</span>`;
      }
      if (isLegacyXls) {
        onStatusBadge?.('SheetJS · .xls 只读预览（防公式丢失）');
      } else if (isCsv && csvMeta?.encoding && csvMeta.encoding !== 'utf8') {
        onStatusBadge?.(`SheetJS · ${csvMeta.encoding.toUpperCase()} CSV 只读预览（防编码损坏）`);
      } else if (dirty) {
        onStatusBadge?.('SheetJS · 未保存修改');
      } else if (isSheetTruncated) {
        onStatusBadge?.('SheetJS · 大表已截断预览（禁止增删行列）');
      } else {
        onStatusBadge?.('SheetJS · 双击单元格可编辑');
      }
    }

    async function saveWorkbook({ silent = false } = {}) {
      if (!canEdit || saving) return;
      activeEditFinish?.(true);
      if (!dirty) {
        if (!silent) showToast?.('当前表格无未保存修改', 1200);
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
        let res;
        if (isCsv) {
          const rowsToSave = Array.isArray(csvAllRows)
            ? csvAllRows
            : currentMatrix.map((row) => row.cells.slice(0, maxCol));
          const csv = serializeCsvRaw(rowsToSave, csvMeta);
          res = await onSaveFile({ content: csv, encoding: 'utf8', silent });
        } else {
          const out = global.XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
          const encoder = global.WSModules?.uint8ToBase64;
          if (!encoder) throw new Error('Base64 编码器未就绪');
          res = await onSaveFile({
            content: encoder(new Uint8Array(out)),
            encoding: 'base64',
            silent,
          });
        }
        if (res?.success && !destroyed) {
          if (editSeq === seqAtStart) {
            dirty = false;
            updateSaveUi();
            const saveIcon = global.WSIcons?.render ? global.WSIcons.render('ui-save', { size: 12 }) : '';
            saveBtn.innerHTML = `${saveIcon}<span>已保存</span>`;
            if (justSavedTimer) clearTimeout(justSavedTimer);
            justSavedTimer = setTimeout(() => {
              if (!destroyed) updateSaveUi();
            }, 1300);
          } else {
            dirty = true;
            updateSaveUi();
            scheduleAutoSave();
          }
        }
      } catch (err) {
        showToast?.(`保存失败: ${err?.message || err}`, 2600);
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
        if (!destroyed && dirty) saveWorkbook({ silent: true });
      }, 1000);
    }

    function rebuildColSelect() {
      colSelect.innerHTML = '<option value="-1">全部列</option>';
      const headerRow = currentMatrix[0]?.cells || [];
      for (let c = 0; c < maxCol; c++) {
        const opt = document.createElement('option');
        opt.value = String(c);
        const colName = colIndexToName(c);
        const hint = headerRow[c] ? ` (${String(headerRow[c]).slice(0, 10)})` : '';
        opt.textContent = `${colName}列${hint}`;
        colSelect.appendChild(opt);
      }
      colSelect.value = filterCol >= 0 && filterCol < maxCol ? String(filterCol) : '-1';
    }

    function ensureSheetRef(ws, absR, absC) {
      let rng = ws['!ref']
        ? global.XLSX.utils.decode_range(ws['!ref'])
        : { s: { r: sheetRStart, c: sheetCStart }, e: { r: absR, c: absC } };
      rng.s.r = Math.min(rng.s.r, absR);
      rng.s.c = Math.min(rng.s.c, absC);
      rng.e.r = Math.max(rng.e.r, absR);
      rng.e.c = Math.max(rng.e.c, absC);
      ws['!ref'] = global.XLSX.utils.encode_range(rng);
      fullRangeEndRow = Math.max(fullRangeEndRow, rng.e.r);
      fullRangeEndCol = Math.max(fullRangeEndCol, rng.e.c);
    }

    function resolveMergeAnchor(origRow, colIdx) {
      for (const m of currentMerges) {
        if (origRow >= m.s.r && origRow <= m.e.r && colIdx >= m.s.c && colIdx <= m.e.c) {
          return { r: m.s.r, c: m.s.c, isMerged: true };
        }
      }
      return { r: origRow, c: colIdx, isMerged: false };
    }

    function loadSheetModel(sheetName) {
      let ws = wb.Sheets[sheetName];
      if (!ws) {
        ws = {};
        wb.Sheets[sheetName] = ws;
      }
      if (!ws['!ref']) {
        sheetRStart = 0;
        sheetCStart = 0;
        fullRangeEndRow = 4;
        fullRangeEndCol = 3;
        isSheetTruncated = false;
        currentMerges = [];
        maxCol = 4;
        currentMatrix = Array.from({ length: 5 }, (_, idx) => ({
          origRow: idx,
          cells: Array(maxCol).fill(''),
        }));
        addRowBtn.disabled = false;
        addColBtn.disabled = false;
        rebuildColSelect();
        return;
      }
      const range = global.XLSX.utils.decode_range(ws['!ref']);
      const rStart = range.s.r;
      const cStart = range.s.c;
      sheetRStart = rStart;
      sheetCStart = cStart;
      fullRangeEndRow = range.e.r;
      fullRangeEndCol = range.e.c;
      const rEnd = Math.min(range.e.r, rStart + 10000);
      const cEnd = Math.min(range.e.c, cStart + 200);
      isSheetTruncated = range.e.r > rEnd || range.e.c > cEnd;
      addRowBtn.disabled = isSheetTruncated;
      addColBtn.disabled = isSheetTruncated;
      if (isSheetTruncated) {
        addRowBtn.title = '工作表超过预览截断上限，已禁用追加行';
        addColBtn.title = '工作表超过预览截断上限，已禁用追加列';
      } else {
        addRowBtn.title = '在当前工作表末尾追加一行';
        addColBtn.title = '在当前工作表右侧追加一列';
      }
      maxCol = cEnd - cStart + 1;
      currentMerges = (ws['!merges'] || []).map((m) => ({
        s: { r: m.s.r - rStart, c: m.s.c - cStart },
        e: { r: m.e.r - rStart, c: m.e.c - cStart },
      }));

      const rows = [];
      for (let r = rStart; r <= rEnd; r++) {
        const rowArr = [];
        for (let c = cStart; c <= cEnd; c++) {
          const addr = global.XLSX.utils.encode_cell({ r, c });
          const cell = ws[addr];
          let val = '';
          if (cell) {
            if (cell.f && (cell.v == null || cell.v === '')) {
              val = `=${cell.f}`;
            } else {
              try {
                val = global.XLSX.utils.format_cell(cell);
              } catch {
                val = cell.v != null ? String(cell.v) : '';
              }
            }
          }
          rowArr.push(val);
        }
        rows.push({ origRow: r - rStart, cells: rowArr });
      }
      currentMatrix = rows;
      rebuildColSelect();
    }

    function commitCellEdit(origRow, colIdx, newValue) {
      const anchor = resolveMergeAnchor(origRow, colIdx);
      const targetRow = anchor.r;
      const targetCol = anchor.c;
      if (!currentMatrix[targetRow]) return false;
      const oldVal = String(currentMatrix[targetRow].cells[targetCol] ?? '');
      let ws = wb.Sheets[activeSheet];
      if (!ws) {
        ws = {};
        wb.Sheets[activeSheet] = ws;
      }
      const absR = sheetRStart + targetRow;
      const absC = sheetCStart + targetCol;
      const addr = global.XLSX.utils.encode_cell({ r: absR, c: absC });
      const prevCell = ws[addr];
      const oldFormulaOrVal = prevCell?.f ? `=${prevCell.f}` : oldVal;
      if (newValue === oldFormulaOrVal) return false;

      currentMatrix[targetRow].cells[targetCol] = newValue;
      const preserved = {};
      if (prevCell?.z != null) preserved.z = prevCell.z;
      if (prevCell?.s != null) preserved.s = prevCell.s;

      const trimmed = newValue.trim();
      if (isCsv) {
        if (Array.isArray(csvAllRows)) {
          while (csvAllRows.length <= absR) csvAllRows.push([]);
          while (csvAllRows[absR].length < absC) csvAllRows[absR].push('');
          csvAllRows[absR][absC] = newValue;
        }
        ws[addr] = { t: 's', v: newValue };
      } else if (newValue === '') {
        delete ws[addr];
      } else if (newValue.startsWith('=') && newValue.length > 1) {
        const nextFormula = newValue.slice(1);
        if (prevCell?.f === nextFormula && prevCell?.v != null && prevCell.v !== '') {
          ws[addr] = { ...preserved, t: prevCell.t || 'n', f: nextFormula, v: prevCell.v };
        } else {
          ws[addr] = { ...preserved, t: 'str', f: nextFormula, v: '' };
        }
      } else if (
        /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(trimmed) &&
        Number.isFinite(Number(trimmed)) &&
        trimmed.length <= 15
      ) {
        ws[addr] = { ...preserved, t: 'n', v: Number(trimmed) };
      } else {
        ws[addr] = { ...preserved, t: 's', v: newValue };
      }
      ensureSheetRef(ws, absR, absC);

      if (targetRow === 0) rebuildColSelect();
      dirty = true;
      editSeq += 1;
      updateSaveUi();
      scheduleAutoSave();
      return true;
    }

    function renderTabs() {
      tabsEl.innerHTML = '';
      for (const name of sheetNames) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `ws-sheet-tab ${name === activeSheet ? 'is-active' : ''}`;
        btn.textContent = name;
        btn.addEventListener('click', () => {
          if (activeSheet === name) return;
          activeEditFinish?.(true);
          activeSheet = name;
          rowLimit = 500;
          selectedRange = null;
          filterCol = -1;
          loadSheetModel(activeSheet);
          renderTabs();
          renderTable();
        });
        tabsEl.appendChild(btn);
      }
    }

    function buildSelectionMarkdown() {
      if (!selectedRange || !currentMatrix.length) return null;
      const rMin = Math.min(selectedRange.r1, selectedRange.r2);
      const rMax = Math.max(selectedRange.r1, selectedRange.r2);
      const cMin = Math.min(selectedRange.c1, selectedRange.c2);
      const cMax = Math.max(selectedRange.c1, selectedRange.c2);

      const rowsText = [];
      const lines = [];
      for (let r = rMin; r <= rMax; r++) {
        const rowObj = currentMatrix[r];
        if (!rowObj) continue;
        const vals = [];
        for (let c = cMin; c <= cMax; c++) {
          vals.push(String(rowObj.cells[c] ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' '));
        }
        rowsText.push(vals);
      }
      if (!rowsText.length) return null;

      if (rowsText.length === 1 && rowsText[0].length === 1) {
        const loc = `${activeSheet}!${colIndexToName(cMin)}${rMin + 1}`;
        return { text: rowsText[0][0], locationLabel: loc };
      }

      lines.push(`| ${rowsText[0].join(' | ')} |`);
      lines.push(`| ${rowsText[0].map(() => '---').join(' | ')} |`);
      for (let i = 1; i < rowsText.length; i++) {
        lines.push(`| ${rowsText[i].join(' | ')} |`);
      }
      const loc = `${activeSheet}!${colIndexToName(cMin)}${rMin + 1}:${colIndexToName(cMax)}${rMax + 1}`;
      return { text: lines.join('\n'), locationLabel: loc };
    }

    function applySelectionStyles(table) {
      for (const td of table.querySelectorAll('td.is-selected')) {
        td.classList.remove('is-selected');
      }
      if (!selectedRange) {
        quoteSelBtn.classList.add('is-hidden');
        return;
      }
      const rMin = Math.min(selectedRange.r1, selectedRange.r2);
      const rMax = Math.max(selectedRange.r1, selectedRange.r2);
      const cMin = Math.min(selectedRange.c1, selectedRange.c2);
      const cMax = Math.max(selectedRange.c1, selectedRange.c2);

      for (const td of table.querySelectorAll('td[data-r][data-c]')) {
        const r = Number(td.dataset.r);
        const c = Number(td.dataset.c);
        if (r >= rMin && r <= rMax && c >= cMin && c <= cMax) {
          td.classList.add('is-selected');
        }
      }
      const info = buildSelectionMarkdown();
      if (info) {
        quoteSelBtn.classList.remove('is-hidden');
        quoteSelLabel.textContent = `引用 ${info.locationLabel}`;
      }
    }

    function focusMatch(index) {
      if (!matchCells.length) return;
      for (const el of matchCells) el.classList.remove('is-match-current');
      matchCursor = ((index % matchCells.length) + matchCells.length) % matchCells.length;
      const target = matchCells[matchCursor];
      target.classList.add('is-match-current');
      target.scrollIntoView({ block: 'center', inline: 'center' });
      matchLabel.textContent = `${matchCursor + 1}/${matchCells.length}`;
    }

    function renderTable() {
      scrollEl.innerHTML = '';
      if (!currentMatrix.length || maxCol === 0) {
        scrollEl.innerHTML = '<div class="ws-empty-welcome"><p>此工作表暂无数据</p></div>';
        matchLabel.textContent = '';
        return;
      }

      const fQuery = filterQuery.trim().toLowerCase();
      const fCol = Number(colSelect.value);
      const isFiltering = Boolean(fQuery);

      const visibleRows = isFiltering
        ? currentMatrix.filter((row, idx) => {
            if (idx === 0) return true;
            if (fCol >= 0) {
              return String(row.cells[fCol] ?? '')
                .toLowerCase()
                .includes(fQuery);
            }
            return row.cells.some((cell) => String(cell ?? '').toLowerCase().includes(fQuery));
          })
        : currentMatrix;

      const slice = visibleRows.slice(0, rowLimit);
      const skipSet = new Set();
      const mergeMap = new Map();

      if (!isFiltering) {
        for (const m of currentMerges) {
          if (m.s.r >= slice.length) continue;
          const rSpan = Math.min(m.e.r, slice.length - 1) - m.s.r + 1;
          const cSpan = Math.min(m.e.c, maxCol - 1) - m.s.c + 1;
          if (rSpan <= 1 && cSpan <= 1) continue;
          mergeMap.set(`${m.s.r},${m.s.c}`, { rowspan: rSpan, colspan: cSpan });
          for (let r = m.s.r; r < m.s.r + rSpan; r++) {
            for (let c = m.s.c; c < m.s.c + cSpan; c++) {
              if (r !== m.s.r || c !== m.s.c) skipSet.add(`${r},${c}`);
            }
          }
        }
      }

      const table = document.createElement('table');
      table.className = `ws-xlsx-table ${freezeCol1 ? 'is-freeze-col1' : ''}`;

      const thead = document.createElement('thead');
      const headTr = document.createElement('tr');
      const corner = document.createElement('th');
      corner.className = 'ws-xlsx-corner ws-xlsx-row-idx';
      corner.textContent = '#';
      headTr.appendChild(corner);

      for (let c = 0; c < maxCol; c++) {
        const th = document.createElement('th');
        th.textContent = colIndexToName(c);
        if (c === 0) th.className = 'ws-col-1';
        th.style.cursor = 'pointer';
        th.title = '点击选中整列（已加载行）';
        th.addEventListener('click', () => {
          selectedRange = { r1: 0, c1: c, r2: slice.length - 1, c2: c };
          applySelectionStyles(table);
        });
        headTr.appendChild(th);
      }
      thead.appendChild(headTr);
      table.appendChild(thead);

      const tbody = document.createElement('tbody');
      const sQuery = searchQuery.trim().toLowerCase();
      matchCells = [];

      for (const rowObj of slice) {
        const r = rowObj.origRow;
        const tr = document.createElement('tr');

        const rowTh = document.createElement('td');
        rowTh.className = 'ws-xlsx-row-idx';
        rowTh.textContent = String(r + 1);
        rowTh.style.cursor = 'pointer';
        rowTh.title = '点击选中整行';
        rowTh.addEventListener('click', () => {
          selectedRange = { r1: r, c1: 0, r2: r, c2: maxCol - 1 };
          applySelectionStyles(table);
        });
        tr.appendChild(rowTh);

        for (let c = 0; c < maxCol; c++) {
          if (skipSet.has(`${r},${c}`)) continue;
          const td = document.createElement('td');
          td.dataset.r = String(r);
          td.dataset.c = String(c);
          if (c === 0) td.classList.add('ws-col-1');

          const m = mergeMap.get(`${r},${c}`);
          if (m) {
            if (m.rowspan > 1) td.rowSpan = m.rowspan;
            if (m.colspan > 1) td.colSpan = m.colspan;
          }

          const val = String(rowObj.cells[c] ?? '');
          td.textContent = val;

          if (sQuery && val.toLowerCase().includes(sQuery)) {
            td.classList.add('is-match');
            matchCells.push(td);
          }

          td.addEventListener('click', (e) => {
            if (td.querySelector('.ws-xlsx-cell-input')) return;
            if (e.shiftKey && selectedRange) {
              selectedRange = { r1: selectedRange.r1, c1: selectedRange.c1, r2: r, c2: c };
            } else {
              selectedRange = { r1: r, c1: c, r2: r, c2: c };
            }
            applySelectionStyles(table);
          });

          if (canEdit) {
            td.title = '双击直接编辑单元格';
            td.addEventListener('dblclick', (e) => {
              e.stopPropagation();
              startCellEdit(td, r, c, table);
            });
          }

          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      scrollEl.appendChild(table);

      if (visibleRows.length > slice.length) {
        const moreDiv = document.createElement('div');
        moreDiv.className = 'ws-xlsx-loadmore';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ws-btn-ghost';
        btn.textContent = `已加载 ${slice.length} / ${visibleRows.length} 行 · 继续加载 500 行`;
        btn.addEventListener('click', () => {
          rowLimit += 500;
          renderTable();
        });
        moreDiv.appendChild(btn);
        scrollEl.appendChild(moreDiv);
      }

      if (sQuery) {
        matchLabel.textContent = matchCells.length ? `0/${matchCells.length}` : '0 匹配';
        if (matchCells.length > 0) focusMatch(0);
      } else {
        matchLabel.textContent = `${visibleRows.length} 行`;
      }

      applySelectionStyles(table);
      if (prevState?.scrollTop && !sQuery) {
        scrollEl.scrollTop = prevState.scrollTop;
      }
    }

    function startCellEdit(td, origRow, colIdx, table) {
      if (!canEdit || !td) return;
      const anchor = resolveMergeAnchor(origRow, colIdx);
      if (anchor.isMerged && (anchor.r !== origRow || anchor.c !== colIdx)) {
        const anchorTd = table?.querySelector(
          `td[data-r="${anchor.r}"][data-c="${anchor.c}"]`
        );
        if (anchorTd) {
          startCellEdit(anchorTd, anchor.r, anchor.c, table);
        } else {
          showToast?.('当前为合并单元格的非主格，请清除筛选后编辑左上角主格', 2200);
        }
        return;
      }
      if (td.querySelector('.ws-xlsx-cell-input')) return;
      activeEditFinish?.(true);

      const ws = wb.Sheets[activeSheet] || {};
      const addr = global.XLSX.utils.encode_cell({ r: sheetRStart + origRow, c: sheetCStart + colIdx });
      const cellObj = ws[addr];
      const beforeDisplay = String(currentMatrix[origRow]?.cells[colIdx] ?? '');
      const initialVal = cellObj?.f ? `=${cellObj.f}` : beforeDisplay;

      selectedRange = { r1: origRow, c1: colIdx, r2: origRow, c2: colIdx };
      applySelectionStyles(table);

      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'ws-xlsx-cell-input';
      input.value = initialVal;
      td.textContent = '';
      td.appendChild(input);

      let done = false;
      activeEditDirty = false;
      input.addEventListener('input', () => {
        activeEditDirty = input.value !== initialVal;
      });
      const finish = (commit) => {
        if (done) return;
        done = true;
        activeEditFinish = null;
        activeEditDirty = false;
        const nextVal = input.value;
        if (commit) {
          commitCellEdit(origRow, colIdx, nextVal);
        }
        td.textContent = String(currentMatrix[origRow]?.cells[colIdx] ?? '');
      };
      activeEditFinish = finish;

      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          finish(true);
          const step = e.shiftKey ? -1 : 1;
          const nextTd = table?.querySelector(
            `td[data-r="${origRow + step}"][data-c="${colIdx}"]`
          );
          if (nextTd) {
            selectedRange = { r1: origRow + step, c1: colIdx, r2: origRow + step, c2: colIdx };
            applySelectionStyles(table);
          }
        } else if (e.key === 'Tab') {
          e.preventDefault();
          finish(true);
          const step = e.shiftKey ? -1 : 1;
          const nextTd = table?.querySelector(
            `td[data-r="${origRow}"][data-c="${colIdx + step}"]`
          );
          if (nextTd) {
            startCellEdit(nextTd, origRow, colIdx + step, table);
          }
        } else if (e.key === 'Escape') {
          e.preventDefault();
          finish(false);
        } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
          e.preventDefault();
          saveWorkbook({ silent: false });
        }
      });

      input.addEventListener('blur', () => finish(true));
      input.focus();
      input.select();
    }

    searchInput.addEventListener('input', () => {
      searchQuery = searchInput.value;
      renderTable();
    });
    prevMatchBtn.addEventListener('click', () => focusMatch(matchCursor - 1));
    nextMatchBtn.addEventListener('click', () => focusMatch(matchCursor + 1));

    colSelect.addEventListener('change', () => {
      filterCol = Number(colSelect.value);
      renderTable();
    });
    filterInput.addEventListener('input', () => {
      filterQuery = filterInput.value;
      renderTable();
    });

    freezeBtn.addEventListener('click', () => {
      freezeCol1 = !freezeCol1;
      freezeBtn.classList.toggle('is-active', freezeCol1);
      const tbl = scrollEl.querySelector('table.ws-xlsx-table');
      tbl?.classList.toggle('is-freeze-col1', freezeCol1);
    });

    addRowBtn.addEventListener('click', () => {
      if (!canEdit || isSheetTruncated) return;
      activeEditFinish?.(true);
      if (maxCol <= 0) maxCol = 4;
      const origRow = currentMatrix.length;
      currentMatrix.push({ origRow, cells: Array(maxCol).fill('') });
      if (isCsv && Array.isArray(csvAllRows)) {
        csvAllRows.push(Array(maxCol).fill(''));
      }
      if (origRow >= rowLimit) rowLimit = origRow + 100;
      let ws = wb.Sheets[activeSheet];
      if (!ws) {
        ws = {};
        wb.Sheets[activeSheet] = ws;
      }
      const nextAbsRow = Math.max(fullRangeEndRow + 1, sheetRStart + origRow);
      ensureSheetRef(ws, nextAbsRow, Math.max(fullRangeEndCol, sheetCStart + maxCol - 1));
      dirty = true;
      editSeq += 1;
      updateSaveUi();
      renderTable();
      scrollEl.scrollTop = scrollEl.scrollHeight;
      scheduleAutoSave();
    });

    addColBtn.addEventListener('click', () => {
      if (!canEdit || isSheetTruncated) return;
      activeEditFinish?.(true);
      maxCol += 1;
      for (const row of currentMatrix) {
        row.cells.push('');
      }
      if (isCsv && Array.isArray(csvAllRows)) {
        for (const r of csvAllRows) {
          while (r.length < maxCol) r.push('');
        }
      }
      let ws = wb.Sheets[activeSheet];
      if (!ws) {
        ws = {};
        wb.Sheets[activeSheet] = ws;
      }
      const nextAbsCol = Math.max(fullRangeEndCol + 1, sheetCStart + maxCol - 1);
      ensureSheetRef(
        ws,
        Math.max(fullRangeEndRow, sheetRStart + Math.max(0, currentMatrix.length - 1)),
        nextAbsCol
      );
      rebuildColSelect();
      dirty = true;
      editSeq += 1;
      updateSaveUi();
      renderTable();
      scrollEl.scrollLeft = scrollEl.scrollWidth;
      scheduleAutoSave();
    });

    autoSaveBtn.addEventListener('click', () => {
      autoSave = !autoSave;
      autoSaveBtn.classList.toggle('is-active', autoSave);
      if (autoSave && dirty) scheduleAutoSave();
    });

    saveBtn.addEventListener('click', () => saveWorkbook({ silent: false }));

    quoteSelBtn.addEventListener('click', () => {
      const info = buildSelectionMarkdown();
      if (info && onQuoteRequest) {
        onQuoteRequest(info);
      }
    });

    keyHandler = (e) => {
      if (destroyed || !canEdit) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        if (dirty || scrollEl.contains(document.activeElement)) {
          e.preventDefault();
          saveWorkbook({ silent: false });
        }
      } else if (
        (e.key === 'Enter' || e.key === 'F2') &&
        selectedRange &&
        !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)
      ) {
        const tbl = scrollEl.querySelector('table.ws-xlsx-table');
        const td = tbl?.querySelector(
          `td[data-r="${selectedRange.r1}"][data-c="${selectedRange.c1}"]`
        );
        if (td) {
          e.preventDefault();
          startCellEdit(td, selectedRange.r1, selectedRange.c1, tbl);
        }
      }
    };
    global.addEventListener('keydown', keyHandler);

    loadSheetModel(activeSheet);
    renderTabs();
    renderTable();
    updateSaveUi();

    return {
      isDirty: () => dirty || activeEditDirty,
      isAutoSave: () => autoSave,
      flushSave: (opts) => saveWorkbook(opts),
      getState: () => ({
        activeSheet,
        searchQuery,
        filterCol,
        filterQuery,
        freezeCol1,
        autoSave,
        rowLimit,
        scrollTop: scrollEl.scrollTop,
      }),
      destroy,
    };
  }

  global.WSModules = global.WSModules || {};
  global.WSModules.renderXlsxPreview = renderXlsxPreview;
})(window);
