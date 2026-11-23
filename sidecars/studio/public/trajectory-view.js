(function (global) {
  'use strict';

  function apiFetch(url, options) {
    const f = global.sidecar && typeof global.sidecar.fetch === 'function'
      ? global.sidecar.fetch.bind(global.sidecar)
      : global.fetch.bind(global);
    return f(url, options);
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[c]));
  }

  function fmtClock(iso) {
    if (!iso) return '';
    try {
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return iso;
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    } catch {
      return iso;
    }
  }

  const ROLE_META = {
    user: { icon: 'ui-user', label: '用户输入' },
    assistant: { icon: 'ui-bot', label: '模型回复' },
    error: { icon: 'ui-error', label: '错误' },
    tool_result: { icon: 'ui-inbox', label: '工具输出' },
    system: { icon: 'ui-gear', label: '系统' },
  };

  function iconHtml(name, size = 13) {
    return global.WSIcons?.render ? global.WSIcons.render(name, { size }) : '';
  }

  function fileIconHtml(file, size = 14) {
    return global.WSIcons?.renderFile ? global.WSIcons.renderFile(file, { size }) : '';
  }

  function createTrajectoryController({
    listEl,
    convLabelEl,
    badgeEl,
    followToggleEl,
    filterChipsEl,
    searchInputEl,
    refreshBtnEl,
    getConversationId,
    onOpenFile,
    showToast,
  }) {
    let steps = [];
    let sig = '';
    let resolvedConvId = '';
    let lastConvId = '';
    let convSource = '';
    let activeFilter = 'all';
    let searchQuery = '';
    let pollTimer = null;
    let searchDebounceTimer = null;
    let chunkRenderRaf = null;
    let renderSeq = 0;
    let visible = false;
    const fullCache = new Map();
    const openDetailsKeys = new Set(); // 记录已展开折叠框的 key，避免单卡替换或刷新后丢失展开状态

    const FIRST_BATCH_SIZE = 120;
    const NEXT_BATCH_SIZE = 250;

    function cancelChunkRender() {
      if (chunkRenderRaf !== null) {
        global.cancelAnimationFrame?.(chunkRenderRaf);
        chunkRenderRaf = null;
      }
    }

    function cacheKeyFor(convId, stepIndex) {
      return `${convId || ''}:${stepIndex}`;
    }

    function putFullCache(convId, stepIndex, detail) {
      const k = cacheKeyFor(convId, stepIndex);
      fullCache.delete(k);
      fullCache.set(k, detail);
      while (fullCache.size > 50) {
        const oldestKey = fullCache.keys().next().value;
        fullCache.delete(oldestKey);
      }
    }

    // 惰性缓存步骤的可检索小写文本，避免每次搜索或增量筛选都反复执行 JSON.stringify
    function getSearchHaystack(step) {
      if (typeof step._searchHay === 'string') return step._searchHay;
      const parts = [step.content, step.thinking, step.error, step.type];
      if (Array.isArray(step.tool_calls)) {
        for (const t of step.tool_calls) {
          parts.push(t.name, t.summary);
          if (t.args && typeof t.args === 'object') {
            for (const [k, v] of Object.entries(t.args)) {
              parts.push(k, typeof v === 'string' ? v : JSON.stringify(v));
            }
          }
        }
      }
      step._searchHay = parts.filter(Boolean).join('\n').toLowerCase();
      return step._searchHay;
    }

    function matchesFilter(step) {
      if (activeFilter === 'user' && step.kind !== 'user') return false;
      if (activeFilter === 'assistant' && step.kind !== 'assistant') return false;
      if (activeFilter === 'thinking' && !step.thinking) return false;
      if (activeFilter === 'tools' && !(step.tool_calls?.length || step.kind === 'tool_result')) return false;
      if (activeFilter === 'error' && step.kind !== 'error') return false;

      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        if (!getSearchHaystack(step).includes(q)) return false;
      }
      return true;
    }

    function updateBadge() {
      if (steps.length > 0) {
        badgeEl.textContent = String(steps.length);
        badgeEl.classList.remove('is-hidden');
      } else {
        badgeEl.classList.add('is-hidden');
      }
    }

    // 按需挂载折叠卡片正文：默认仅渲染 <summary>，用户真正点开时才生成正文节点与格式化 JSON
    function createLazyDetails({ detailKey, iconName, labelText, getBodyText }) {
      const det = document.createElement('details');
      det.className = 'ws-step-details';

      const sum = document.createElement('summary');
      sum.innerHTML = `${iconHtml(iconName, 13)}<span>${escapeHtml(labelText)}</span>`;
      det.appendChild(sum);

      let bodyEl = null;
      const ensureBodyMounted = () => {
        if (bodyEl) return;
        bodyEl = document.createElement('div');
        bodyEl.className = 'ws-step-details-body';
        bodyEl.textContent = getBodyText();
        det.appendChild(bodyEl);
      };

      if (openDetailsKeys.has(detailKey)) {
        det.open = true;
        ensureBodyMounted();
      }

      det.addEventListener('toggle', () => {
        if (det.open) {
          openDetailsKeys.add(detailKey);
          ensureBodyMounted();
        } else {
          openDetailsKeys.delete(detailKey);
        }
      });

      return det;
    }

    function renderStepCard(step) {
      const card = document.createElement('article');
      card.className = `ws-step-card kind-${step.kind}`;
      card.dataset.stepIndex = String(step.step_index);

      const head = document.createElement('div');
      head.className = 'ws-step-head';

      const meta = document.createElement('div');
      meta.className = 'ws-step-meta';
      const roleInfo = ROLE_META[step.kind] || { icon: 'ui-gear', label: step.type };
      meta.innerHTML = `<span class="ws-step-idx">#${step.step_index}</span>
        <span class="ws-step-role">${iconHtml(roleInfo.icon, 12)}<span>${escapeHtml(roleInfo.label)}</span></span>
        ${step.status ? `<span class="ws-step-time">${escapeHtml(step.status)}</span>` : ''}`;

      const time = document.createElement('span');
      time.className = 'ws-step-time';
      time.textContent = fmtClock(step.created_at);
      time.title = step.created_at || '';

      head.append(meta, time);
      card.appendChild(head);

      const fullDetail = fullCache.get(cacheKeyFor(resolvedConvId, step.step_index));
      const contentText = fullDetail ? fullDetail.content : step.content;
      const thinkingText = fullDetail ? fullDetail.thinking : step.thinking;

      if (thinkingText) {
        const heading = step.thinkingHeading ? ` · ${step.thinkingHeading}` : '';
        card.appendChild(
          createLazyDetails({
            detailKey: `${step.step_index}:thinking`,
            iconName: 'ui-thinking',
            labelText: `思考过程${heading}`,
            getBodyText: () => thinkingText,
          })
        );
      }

      if (step.tool_calls?.length) {
        step.tool_calls.forEach((tc, tcIdx) => {
          card.appendChild(
            createLazyDetails({
              detailKey: `${step.step_index}:tc:${tcIdx}`,
              iconName: 'ui-tool',
              labelText: tc.summary || tc.name,
              getBodyText: () => JSON.stringify(tc.args || {}, null, 2),
            })
          );
        });
      }

      if (step.kind === 'tool_result' && contentText) {
        card.appendChild(
          createLazyDetails({
            detailKey: `${step.step_index}:tool_result`,
            iconName: 'ui-inbox',
            labelText: `工具返回 (${contentText.length} 字符)`,
            getBodyText: () => contentText,
          })
        );
      } else if (contentText) {
        const body = document.createElement('div');
        body.className = 'ws-step-body';
        body.textContent = contentText;
        card.appendChild(body);
      }

      if (step.error) {
        const errDiv = document.createElement('div');
        errDiv.className = 'ws-step-body';
        errDiv.style.color = 'var(--ws-danger)';
        errDiv.textContent = step.error;
        card.appendChild(errDiv);
      }

      if (step.hasFull && !fullDetail) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ws-chip-btn';
        btn.style.marginTop = '6px';
        btn.innerHTML = `${iconHtml('ui-expand', 12)}<span>已截断 (${escapeHtml(step.truncated_fields.join(', '))}) · 点击按需加载全文</span>`;
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          btn.textContent = '正在读取 transcript_full.jsonl...';
          const reqConvId = resolvedConvId || getConversationId() || '';
          try {
            const r = await apiFetch(
              `/api/transcript/full?conversationId=${encodeURIComponent(
                reqConvId
              )}&stepIndex=${step.step_index}`,
              { method: 'GET' }
            );
            const json = await r.json();
            const returnedConv = json?.detail?.conversationId || reqConvId;
            if (resolvedConvId && returnedConv !== resolvedConvId) {
              return;
            }
            if (json?.success && json.detail) {
              putFullCache(resolvedConvId, step.step_index, json.detail);
              // 仅原地替换当前这一张步骤卡片，保留其余卡片 DOM 与折叠展开状态
              card.replaceWith(renderStepCard(step));
              showToast?.(
                json.detail.fromFullFile
                  ? '已从 transcript_full.jsonl 加载完整步骤'
                  : '已加载完整步骤'
              );
            } else {
              btn.textContent = '未找到完整记录';
            }
          } catch (err) {
            btn.disabled = false;
            btn.textContent = `加载失败: ${err.message}`;
          }
        });
        card.appendChild(btn);
      }

      if (step.files?.length) {
        const filesBar = document.createElement('div');
        filesBar.className = 'ws-step-files';
        for (const f of step.files) {
          const chip = document.createElement('button');
          chip.type = 'button';
          chip.className = 'ws-doc-pill';
          chip.title = `点击预览 ${f.path}`;
          chip.innerHTML = `<span class="ws-pill-icon">${fileIconHtml(f, 14)}</span><span class="ws-doc-pill-name">${escapeHtml(f.name)}</span>`;
          chip.addEventListener('click', () => onOpenFile?.(f));
          filesBar.appendChild(chip);
        }
        card.appendChild(filesBar);
      }

      return card;
    }

    function renderAll({ scrollBottom = false } = {}) {
      cancelChunkRender();
      const seq = ++renderSeq;
      const filtered = steps.filter(matchesFilter);
      listEl.innerHTML = '';
      updateBadge();

      if (!filtered.length) {
        const empty = document.createElement('div');
        empty.className = 'ws-traj-empty';
        empty.textContent = steps.length
          ? '当前筛选条件下没有匹配的轨迹步骤'
          : '当前会话暂无 transcript.jsonl 轨迹记录';
        listEl.appendChild(empty);
        return;
      }

      const firstEnd = Math.min(FIRST_BATCH_SIZE, filtered.length);
      const frag = document.createDocumentFragment();
      for (let i = 0; i < firstEnd; i++) {
        frag.appendChild(renderStepCard(filtered[i]));
      }
      listEl.appendChild(frag);

      if (firstEnd >= filtered.length) {
        if (scrollBottom && followToggleEl?.checked) {
          listEl.scrollTop = listEl.scrollHeight;
        }
        return;
      }

      // 超长会话分批挂载剩余步骤，避免一次性创建数万 DOM 节点卡死主线程
      let cursor = firstEnd;
      const mountNextBatch = () => {
        if (seq !== renderSeq) {
          chunkRenderRaf = null;
          return;
        }
        const batchEnd = Math.min(cursor + NEXT_BATCH_SIZE, filtered.length);
        const batchFrag = document.createDocumentFragment();
        for (let i = cursor; i < batchEnd; i++) {
          batchFrag.appendChild(renderStepCard(filtered[i]));
        }
        listEl.appendChild(batchFrag);
        cursor = batchEnd;

        if (cursor < filtered.length) {
          chunkRenderRaf = global.requestAnimationFrame(mountNextBatch);
        } else {
          chunkRenderRaf = null;
          if (scrollBottom && followToggleEl?.checked) {
            listEl.scrollTop = listEl.scrollHeight;
          }
        }
      };
      chunkRenderRaf = global.requestAnimationFrame(mountNextBatch);
    }

    function appendSteps(newSteps, { scrollBottom = false } = {}) {
      updateBadge();
      if (!Array.isArray(newSteps) || !newSteps.length) return;
      if (chunkRenderRaf !== null) {
        renderAll({ scrollBottom });
        return;
      }
      const matching = newSteps.filter(matchesFilter);
      if (!matching.length) return;
      const emptyEl = listEl.querySelector('.ws-traj-empty');
      if (emptyEl) emptyEl.remove();

      const frag = document.createDocumentFragment();
      for (const s of matching) {
        frag.appendChild(renderStepCard(s));
      }
      listEl.appendChild(frag);
      if (scrollBottom && followToggleEl?.checked) {
        listEl.scrollTop = listEl.scrollHeight;
      }
    }

    async function refresh({ force = false } = {}) {
      try {
        const convParam = getConversationId() || '';
        const afterLine = force ? 0 : steps.length;
        const sigParam = force ? '' : sig;
        const r = await apiFetch(
          `/api/transcript/steps?conversationId=${encodeURIComponent(
            convParam
          )}&afterLine=${afterLine}&sig=${encodeURIComponent(sigParam)}&force=${force ? '1' : '0'}`,
          { method: 'GET' }
        );
        if (!r.ok) return;
        const data = await r.json();
        if (!data?.success) return;

        const nextConvId = data.conversationId || '';
        const convChanged = nextConvId !== lastConvId;
        if (convChanged || force) {
          fullCache.clear();
          if (convChanged) {
            openDetailsKeys.clear();
            steps = [];
            sig = '';
          }
        }
        lastConvId = nextConvId;
        resolvedConvId = nextConvId;
        convSource = data.source || '';
        if (resolvedConvId) {
          const tag = convSource === 'host' ? '当前对话' : '最新活跃对话';
          convLabelEl.textContent = `${tag}: ${resolvedConvId.slice(0, 8)}… (${steps.length || data.totalLines || 0} 步)`;
          convLabelEl.title = resolvedConvId;
        } else {
          convLabelEl.textContent = '未检测到活跃会话日志';
        }

        if (data.unchanged && !convChanged) return;
        sig = data.sig || '';

        if (data.reset || convChanged) {
          fullCache.clear();
          steps = data.steps || [];
          renderAll({ scrollBottom: true });
        } else if (Array.isArray(data.steps) && data.steps.length > 0) {
          steps.push(...data.steps);
          // 轮询仅追加新增步骤，不重建已有卡片 DOM
          appendSteps(data.steps, { scrollBottom: true });
        }
        if (resolvedConvId) {
          const tag = convSource === 'host' ? '当前对话' : '最新活跃对话';
          convLabelEl.textContent = `${tag}: ${resolvedConvId.slice(0, 8)}… (${steps.length} 步)`;
        }
      } catch (err) {
        console.warn('Transcript poll failed:', err);
      }
    }

    filterChipsEl?.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-filter]');
      if (!btn) return;
      activeFilter = btn.dataset.filter;
      for (const b of filterChipsEl.querySelectorAll('button[data-filter]')) {
        b.classList.toggle('is-active', b === btn);
      }
      renderAll();
    });

    searchInputEl?.addEventListener('input', () => {
      if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
      searchDebounceTimer = setTimeout(() => {
        searchDebounceTimer = null;
        searchQuery = searchInputEl.value.trim();
        renderAll();
      }, 120);
    });

    refreshBtnEl?.addEventListener('click', () => refresh({ force: true }));

    function setVisible(v) {
      visible = Boolean(v);
      if (visible) {
        refresh();
        if (!pollTimer) {
          pollTimer = setInterval(() => {
            if (visible) refresh();
          }, 2500);
        }
      } else if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    }

    refresh();

    return {
      setVisible,
      refresh,
      destroy: () => {
        if (pollTimer) clearInterval(pollTimer);
        if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
        cancelChunkRender();
      },
    };
  }

  global.WSModules = global.WSModules || {};
  global.WSModules.createTrajectoryController = createTrajectoryController;
})(window);
