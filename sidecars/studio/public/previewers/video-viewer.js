(function (global) {
  'use strict';

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function formatTime(value) {
    if (!Number.isFinite(value) || value < 0) return '--:--';
    const seconds = Math.floor(value);
    const pad = (part) => String(part).padStart(2, '0');
    const minutes = Math.floor(seconds / 60);
    return minutes >= 60
      ? `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}:${pad(seconds % 60)}`
      : `${pad(minutes)}:${pad(seconds % 60)}`;
  }

  function formatBytes(value) {
    if (!Number.isFinite(value) || value < 0) return '';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const unit = Math.min(units.length - 1, Math.floor(Math.log2(Math.max(1, value)) / 10));
    const size = value / (1024 ** unit);
    return `${unit === 0 ? size : size.toFixed(1)} ${units[unit]}`;
  }

  async function renderVideoPreview(ctx) {
    const {
      file, stageEl, toolbarEl, conversationId, getWorkspaceGen, prevState,
      onStatusBadge, onQuoteRequest, isStale, showToast, registerCleanup,
    } = ctx;
    if (isStale?.()) return null;
    onStatusBadge?.('MP4 视频');

    const query = new URLSearchParams({ path: file.path, conversationId: conversationId || '' });
    if (getWorkspaceGen) query.set('workspaceGen', String(getWorkspaceGen()));
    query.set('v', String(Math.floor(file.mtimeMs || Date.now())));
    const streamUrl = '/api/file/stream?' + query;
    const lifetime = new AbortController();
    const { signal } = lifetime;
    const live = () => !signal.aborted && !isStale?.();

    const shell = element('div', 'ws-video-shell');
    shell.tabIndex = 0;
    shell.setAttribute('role', 'region');
    shell.setAttribute('aria-label', '视频预览（空格播放或暂停，左右键跳转，M 静音）');
    const viewport = element('div', 'ws-video-viewport');
    const frame = element('div', 'ws-video-frame');
    const video = element('video', 'ws-video-el');
    video.controls = true;
    video.playsInline = true;
    video.preload = 'metadata';
    video.setAttribute('aria-label', file.name || 'MP4 视频');
    frame.append(video);
    viewport.append(frame);
    shell.append(viewport);

    const leftToolbar = element('div', 'ws-toolbar-group');
    const rightToolbar = element('div', 'ws-toolbar-group');
    function button(text, action) {
      const node = element('button', 'ws-video-btn', text);
      node.type = 'button';
      node.addEventListener('click', () => { if (live()) action(); }, { signal });
      return node;
    }
    async function togglePlayback() {
      if (!live() || video.error) return;
      try {
        if (video.paused || video.ended) await video.play();
        else video.pause();
      } catch {
        if (live()) showToast?.('暂时无法播放视频，请重试或使用「原生打开」');
      }
    }
    const playButton = button('播放', togglePlayback);
    const speedSelect = element('select', 'ws-video-select');
    speedSelect.setAttribute('aria-label', '播放速度');
    for (const rate of [0.5, 0.75, 1, 1.25, 1.5, 2]) {
      const option = element('option', '', `${rate}x`);
      option.value = String(rate);
      speedSelect.append(option);
    }
    speedSelect.addEventListener('change', () => {
      if (live()) video.playbackRate = Number(speedSelect.value);
    }, { signal });
    const loopButton = button('循环', () => {
      video.loop = !video.loop;
      syncControls();
    });
    const muteButton = button('静音', () => { video.muted = !video.muted; });
    const meta = element('span', 'ws-video-meta');
    leftToolbar.append(playButton, speedSelect, loopButton, muteButton);
    rightToolbar.append(meta);
    if (typeof onQuoteRequest === 'function') {
      rightToolbar.append(button('引用时间点', () => {
        const time = formatTime(video.currentTime || 0);
        onQuoteRequest({
          text: `${file.name || file.path.split(/[\\/]/).pop()} @ ${time}`,
          locationLabel: `视频 ${time}`,
        });
      }));
    }

    function setPressed(node, value) {
      node.classList.toggle('is-active', value);
      node.setAttribute('aria-pressed', String(value));
    }
    function syncControls() {
      if (!live()) return;
      playButton.textContent = video.paused || video.ended ? '播放' : '暂停';
      setPressed(loopButton, video.loop);
      setPressed(muteButton, video.muted);
      const rate = String(video.playbackRate);
      // Native video controls may offer rates beyond the toolbar's defaults.
      if (![...speedSelect.options].some((option) => option.value === rate)) {
        const option = element('option', '', `${rate}x`);
        option.value = rate;
        speedSelect.append(option);
      }
      speedSelect.value = rate;
    }
    function updateMetadata() {
      if (!live()) return;
      const resolution = video.videoWidth && video.videoHeight ? `${video.videoWidth}×${video.videoHeight}` : '';
      meta.textContent = [resolution, formatTime(video.duration), formatBytes(file.size)].filter(Boolean).join(' · ');
      meta.title = meta.textContent;
    }
    for (const event of ['play', 'pause', 'ended', 'ratechange', 'volumechange']) {
      video.addEventListener(event, syncControls, { signal });
    }
    video.addEventListener('durationchange', updateMetadata, { signal });
    video.addEventListener('loadedmetadata', () => {
      if (!live()) return;
      if (Number.isFinite(prevState?.currentTime) && Number.isFinite(video.duration)) {
        video.currentTime = Math.min(video.duration, Math.max(0, prevState.currentTime));
      }
      updateMetadata();
    }, { once: true, signal });

    video.addEventListener('error', () => {
      if (!live()) return;
      video.hidden = true;
      playButton.disabled = true;
      speedSelect.disabled = true;
      const card = element('div', 'ws-video-error');
      card.setAttribute('role', 'status');
      card.append(
        element('strong', '', '视频加载或解码失败'),
        element('p', '', '文件可能无法访问，或使用了当前浏览器不支持的编码（如 HEVC/H.265）。请点击上方「原生打开」尝试播放。')
      );
      frame.querySelector('.ws-video-error')?.remove();
      frame.append(card);
    }, { signal });

    shell.addEventListener('keydown', (event) => {
      const target = event.target;
      if (!live() || event.defaultPrevented || event.ctrlKey || event.altKey || event.metaKey ||
          /^(INPUT|TEXTAREA|SELECT)$/.test(target?.tagName) || target?.isContentEditable) return;
      if (event.code === 'Space' || event.key === ' ') {
        event.preventDefault();
        if (!event.repeat) togglePlayback();
      } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        if (Number.isFinite(video.duration) && video.duration > 0) {
          const delta = event.key === 'ArrowLeft' ? -5 : 5;
          video.currentTime = Math.min(video.duration, Math.max(0, video.currentTime + delta));
        }
      } else if (event.key === 'm' || event.key === 'M') {
        event.preventDefault();
        video.muted = !video.muted;
      }
    }, { signal });

    video.muted = Boolean(prevState?.muted);
    video.loop = Boolean(prevState?.loop);
    if (Number.isFinite(prevState?.playbackRate) && prevState.playbackRate > 0) {
      try {
        // Loading a new source resets playbackRate to defaultPlaybackRate.
        video.defaultPlaybackRate = prevState.playbackRate;
        video.playbackRate = prevState.playbackRate;
      } catch {}
    }

    function destroy() {
      if (signal.aborted) return;
      lifetime.abort();
      try { video.pause(); } catch {}
      video.removeAttribute('src');
      try { video.load(); } catch {}
      shell.remove();
      // Remove only this controller's toolbar, including during a stale open.
      leftToolbar.remove();
      rightToolbar.remove();
    }
    registerCleanup?.(destroy);
    if (!live()) {
      destroy();
      return null;
    }
    stageEl.replaceChildren(shell);
    toolbarEl.replaceChildren(leftToolbar, rightToolbar);
    toolbarEl.classList.remove('is-hidden');
    syncControls();
    updateMetadata();
    video.src = streamUrl;
    shell.focus({ preventScroll: true });

    return {
      getState: () => ({
        currentTime: video.currentTime || 0,
        playbackRate: video.playbackRate || 1,
        muted: video.muted,
        loop: video.loop,
      }),
      destroy,
    };
  }

  global.WSModules = global.WSModules || {};
  global.WSModules.renderVideoPreview = renderVideoPreview;
})(window);
