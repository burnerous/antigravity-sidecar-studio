(function (global) {
  'use strict';

  const MAX_HISTORY = 25;
  const MAX_RASTER_HISTORY_BYTES = 256 * 1024 * 1024;
  const MAX_CANVAS_SIDE = 32767;
  const MAX_CANVAS_PIXELS = 32 * 1024 * 1024;
  const MAX_EXPORT_BYTES = 128 * 1024 * 1024;
  const OVERWRITE_EXTS = ['.png', '.jpg', '.jpeg', '.webp'];
  const IMAGE_MIMES = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.gif': 'image/gif',
    '.bmp': 'image/bmp',
    '.ico': 'image/x-icon',
  };
  const IDENTITY = [1, 0, 0, 1, 0, 0];
  const PIN_COLOR = '#1677ff';
  const FONT = '"Segoe UI", "Microsoft YaHei", sans-serif';
  const CROP_HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(text, action, { icon, title, className = '' } = {}) {
    const node = element('button', ('ws-img-button ' + className).trim());
    node.type = 'button';
    if (icon && global.WSIcons?.render) node.innerHTML = global.WSIcons.render(icon, { size: 14 });
    node.append(document.createTextNode(text));
    if (title) node.title = title;
    node.addEventListener('click', action);
    return node;
  }

  function setPressed(node, selected) {
    node.classList.toggle('is-active', selected);
    node.setAttribute('aria-pressed', String(selected));
  }

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  function canvasFor(width, height) {
    if (
      !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
      width > MAX_CANVAS_SIDE || height > MAX_CANVAS_SIDE || width * height > MAX_CANVAS_PIXELS
    ) {
      throw new Error('图片尺寸超出画布限制（单边 32767 px，约 3355 万像素）');
    }
    const canvas = element('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }

  function decodeImage(url, signal) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      const finish = (error) => {
        signal.removeEventListener('abort', abort);
        image.onload = image.onerror = null;
        if (error) {
          image.removeAttribute('src');
          reject(error);
        } else {
          resolve(image);
        }
      };
      const abort = () => finish(signal.reason);
      if (signal.aborted) {
        abort();
        return;
      }
      signal.addEventListener('abort', abort, { once: true });
      image.onload = () => finish();
      image.onerror = () => finish(new Error('无法解码此图片'));
      image.src = url;
    });
  }

  function encodeCanvas(canvas, mime) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (!blob?.size || blob.type !== mime) {
          reject(new Error('当前浏览器无法用 ' + mime + ' 编码图片'));
        } else if (blob.size > MAX_EXPORT_BYTES) {
          reject(new Error('导出的图片超过 128 MiB'));
        } else {
          resolve(blob);
        }
      }, mime, 0.92);
    });
  }

  function blobBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(',')[1]);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  function rectBetween(a, b) {
    return {
      x: Math.min(a.x, b.x),
      y: Math.min(a.y, b.y),
      w: Math.abs(a.x - b.x),
      h: Math.abs(a.y - b.y),
    };
  }

  function clipRect(rect, width, height) {
    const x = clamp(rect.x, 0, width);
    const y = clamp(rect.y, 0, height);
    return { x, y, w: clamp(rect.x + rect.w, 0, width) - x, h: clamp(rect.y + rect.h, 0, height) - y };
  }

  function mapPoint(point, [a, b, c, d, e, f]) {
    return { x: a * point.x + c * point.y + e, y: b * point.x + d * point.y + f };
  }

  function mapRect(rect, matrix) {
    return rectBetween(
      mapPoint(rect, matrix),
      mapPoint({ x: rect.x + rect.w, y: rect.y + rect.h }, matrix)
    );
  }

  function transformPin(pin, matrix, width, height) {
    if (pin.region) {
      const region = clipRect(mapRect(pin.region, matrix), width, height);
      return region.w > 0 && region.h > 0 ? { ...pin, x: region.x, y: region.y, region } : null;
    }
    const point = mapPoint(pin, matrix);
    const x = clamp(point.x, 0, width);
    const y = clamp(point.y, 0, height);
    if (Math.abs(point.x - x) > 1e-7 || Math.abs(point.y - y) > 1e-7) return null;
    return { ...pin, x, y };
  }

  function cornerCrop(anchor, point, ratio, width, height, sx, sy) {
    const maxW = sx > 0 ? width - anchor.x : anchor.x;
    const maxH = sy > 0 ? height - anchor.y : anchor.y;
    let w = clamp(sx * (point.x - anchor.x), 0, maxW);
    let h = clamp(sy * (point.y - anchor.y), 0, maxH);
    if (ratio) {
      w = Math.min(Math.max(w, h * ratio), maxW, maxH * ratio);
      h = w / ratio;
    }
    return rectBetween(anchor, { x: anchor.x + sx * w, y: anchor.y + sy * h });
  }

  function resizeCrop(rect, handle, dx, dy, ratio, width, height) {
    const sx = handle.includes('w') ? -1 : Number(handle.includes('e'));
    const sy = handle.includes('n') ? -1 : Number(handle.includes('s'));
    const right = rect.x + rect.w;
    const bottom = rect.y + rect.h;
    if (ratio && sx && sy) {
      return cornerCrop(
        { x: sx > 0 ? rect.x : right, y: sy > 0 ? rect.y : bottom },
        { x: (sx > 0 ? right : rect.x) + dx, y: (sy > 0 ? bottom : rect.y) + dy },
        ratio, width, height, sx, sy
      );
    }
    if (ratio && sx) {
      const centerY = rect.y + rect.h / 2;
      const limit = Math.min(sx > 0 ? width - rect.x : right, 2 * ratio * Math.min(centerY, height - centerY));
      const w = clamp(rect.w + sx * dx, 0, limit);
      const h = w / ratio;
      return { x: sx > 0 ? rect.x : right - w, y: centerY - h / 2, w, h };
    }
    if (ratio && sy) {
      const centerX = rect.x + rect.w / 2;
      const limit = Math.min(sy > 0 ? height - rect.y : bottom, 2 * Math.min(centerX, width - centerX) / ratio);
      const h = clamp(rect.h + sy * dy, 0, limit);
      const w = h * ratio;
      return { x: centerX - w / 2, y: sy > 0 ? rect.y : bottom - h, w, h };
    }
    const x = sx < 0 ? clamp(rect.x + dx, 0, right) : rect.x;
    const y = sy < 0 ? clamp(rect.y + dy, 0, bottom) : rect.y;
    return {
      x, y,
      w: (sx > 0 ? clamp(right + dx, x, width) : right) - x,
      h: (sy > 0 ? clamp(bottom + dy, y, height) : bottom) - y,
    };
  }

  function annotationPaths(item) {
    const { kind, a, b, width } = item;
    const path = new Path2D();
    if (kind === 'pen') {
      const points = item.points;
      path.moveTo(a.x, a.y);
      for (let i = 1; i < points.length; i++) {
        const prev = points[i - 1];
        const next = points[i];
        path.quadraticCurveTo(prev.x, prev.y, (prev.x + next.x) / 2, (prev.y + next.y) / 2);
      }
      if (points.length > 1) {
        path.lineTo(b.x, b.y);
        return { stroke: path };
      }
      path.arc(a.x, a.y, width / 2, 0, 2 * Math.PI);
      return { fill: path };
    }
    if (kind === 'text' || kind === 'mosaic') {
      const { x, y, w, h } = item.rect;
      path.rect(x, y, w, h);
      return { fill: path };
    }
    if (kind === 'arrow') {
      const length = Math.hypot(b.x - a.x, b.y - a.y);
      if (!length) return {};
      const ux = (b.x - a.x) / length;
      const uy = (b.y - a.y) / length;
      const head = Math.min(length * 0.6, Math.max(9, width * 3.2));
      const cx = b.x - ux * head;
      const cy = b.y - uy * head;
      const wing = head * 0.44;
      path.moveTo(a.x, a.y);
      path.lineTo(b.x - ux * head * 0.72, b.y - uy * head * 0.72);
      const fill = new Path2D();
      fill.moveTo(b.x, b.y);
      fill.lineTo(cx - uy * wing, cy + ux * wing);
      fill.lineTo(cx + uy * wing, cy - ux * wing);
      fill.closePath();
      return { stroke: path, fill };
    }
    const { x, y, w, h } = rectBetween(a, b);
    if (kind === 'rect') path.rect(x, y, w, h);
    if (kind === 'ellipse') path.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
    return { stroke: path };
  }

  function setStroke(painter, width, color) {
    painter.lineCap = painter.lineJoin = 'round';
    painter.lineWidth = width;
    painter.strokeStyle = painter.fillStyle = color;
  }

  function positionRect(node, rect, width, height) {
    node.style.left = (rect.x / width * 100) + '%';
    node.style.top = (rect.y / height * 100) + '%';
    node.style.width = (rect.w / width * 100) + '%';
    node.style.height = (rect.h / height * 100) + '%';
  }

  function promptForImage(originalPath, annotatedPath, { width, height }, pins) {
    function inlineCode(path) {
      const length = (path.match(/\x60+/g) || []).reduce((max, run) => Math.max(max, run.length), 0);
      const fence = String.fromCharCode(96).repeat(length + 1);
      return fence + ' ' + path + ' ' + fence;
    }
    const lines = [
      '请查看我在图片中的圈选与修改意见：',
      '- 原图：' + inlineCode(originalPath),
      '- 标注图：' + inlineCode(annotatedPath) + '（尺寸 ' + width + 'x' + height + '）',
    ];
    if (!pins.length) {
      lines.push('- 已直接在标注图中用画笔/图形圈选，请结合图像上的标注处理');
    } else {
      lines.push('- 批注列表：');
      pins.forEach((pin, index) => {
        const r = pin.region;
        const location = r
          ? '区域 x:' + Math.round(r.x) + ', y:' + Math.round(r.y) + ', w:' + Math.round(r.w) + ', h:' + Math.round(r.h)
          : '点 x:' + Math.round(pin.x) + ', y:' + Math.round(pin.y);
        lines.push('  ' + (index + 1) + '. #' + pin.id + ' [' + location + ']：' +
          (pin.text.replace(/\r?\n/g, '\n     ') || '（无文字）'));
      });
    }
    return lines.join('\n');
  }

  async function renderImagePreview(ctx) {
    const {
      file, stageEl, toolbarEl, conversationId, getWorkspaceGen, prevState,
      onSaveFile, onSaveAsFile, onSendToAgent, onStatusBadge, isStale, showToast, registerCleanup,
    } = ctx;
    const lifetime = new AbortController();
    const { signal } = lifetime;
    const live = () => !signal.aborted && !isStale?.();
    const origExt = (file.ext || '').toLowerCase();
    const canOverwriteOriginal = OVERWRITE_EXTS.includes(origExt);
    const sourceName = file.name || file.path.split(/[\\/]/).pop();
    const stem = (origExt && sourceName.toLowerCase().endsWith(origExt)
      ? sourceName.slice(0, -origExt.length) : sourceName).replace(/[<>:"/\\|?*\0-\x1f]/g, '_').trim();
    let shell, leftToolbar, rightToolbar, resizeObserver;
    let objectUrl = '';

    function destroy() {
      if (signal.aborted) return;
      lifetime.abort();
      resizeObserver?.disconnect();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      shell?.remove();
      leftToolbar?.remove();
      rightToolbar?.remove();
    }

    registerCleanup?.(destroy);
    if (!live()) return null;
    let original, sourceVersion, sourceMtime;
    try {
      const apiFetch = global.sidecar?.fetch?.bind(global.sidecar) || global.fetch.bind(global);
      const query = new URLSearchParams({ path: file.path, conversationId: conversationId || '' });
      if (getWorkspaceGen) query.set('workspaceGen', String(getWorkspaceGen()));
      const response = await apiFetch('/api/file/raw?' + query, { signal });
      if (!response.ok) throw new Error('读取图片失败（HTTP ' + response.status + '）');
      sourceVersion = response.headers.get('X-File-Version') || file.version || '';
      sourceMtime = Number(response.headers.get('X-File-Mtime')) || file.mtimeMs;
      const raw = await response.blob();
      if (!live()) {
        destroy();
        return null;
      }
      const imageMime = IMAGE_MIMES[origExt] || raw.type;
      const imageBlob = raw.type === imageMime ? raw : new Blob([raw], { type: imageMime });
      objectUrl = URL.createObjectURL(imageBlob);
      const image = await decodeImage(objectUrl, signal);
      if (!live()) {
        destroy();
        return null;
      }
      original = canvasFor(image.naturalWidth, image.naturalHeight);
      original.getContext('2d').drawImage(image, 0, 0);
      image.removeAttribute('src');
    } catch (error) {
      const interrupted = !live();
      destroy();
      if (interrupted) return null;
      throw error;
    }

    // Raster canvases and committed items are immutable and shared by adjacent history entries.
    let history = [{ pixels: original, annotations: [], pins: [], revision: 0 }];
    let historyIndex = 0;
    let nextRevision = 1;
    let savedRevision = 0;
    let nextPin = 1;
    const current = () => history[historyIndex];
    let displayedPixels;
    let zoom = ['fit', '100', 'custom'].includes(prevState?.zoom) ? prevState.zoom : 'fit';
    let zoomScale = Number.isFinite(prevState?.zoomScale) ? clamp(prevState.zoomScale, 0.1, 5) : 1;
    let displayScale = 1;
    let checker = prevState?.checker !== false;
    let spaceHeld = false;
    let mode = '';
    let panelName = '';
    let annotationKind = 'pen';
    let strokeColor = '#ff4d4f';
    let strokeWidth = 4;
    let eraserMode = 'annotation';
    let eraserSize = 20;
    let transformMode = 'crop';
    let cropRatio = 0;
    let crop = null;
    let gesture = null;
    let editor = null;
    let exporting = false;

    shell = element('div', 'ws-img-editor-shell');
    const viewport = element('div', 'ws-img-viewport');
    viewport.tabIndex = 0;
    viewport.setAttribute('aria-label', '图片画布');
    const frame = element('div', 'ws-img-canvas-frame');
    const base = element('canvas', 'ws-img-base-canvas');
    const anno = element('canvas', 'ws-img-anno-canvas');
    const interaction = element('div', 'ws-img-interaction');
    const cropMask = element('div', 'ws-img-crop-mask');
    const cropBox = element('div', 'ws-img-crop-box');
    for (const handle of CROP_HANDLES) {
      const grip = element('span', 'ws-img-crop-handle');
      grip.dataset.handle = handle;
      cropBox.append(grip);
    }
    const dragRegion = element('div', 'ws-img-pin-region is-draft');
    interaction.append(cropMask, cropBox, dragRegion);
    const pinsLayer = element('div', 'ws-img-pins-layer');
    frame.append(base, anno, interaction, pinsLayer);
    viewport.append(frame);
    const dockStack = element('div', 'ws-img-dock-stack');
    const panels = element('div', 'ws-img-panels');
    const dock = element('div', 'ws-img-dock');
    dock.setAttribute('role', 'group');
    dock.setAttribute('aria-label', '图片工具');
    dockStack.append(panels, dock);
    shell.append(viewport, dockStack);

    const basePainter = base.getContext('2d');
    const annoPainter = anno.getContext('2d');
    const mosaic = element('canvas');
    const mosaicPainter = mosaic.getContext('2d');
    const isDirty = () => current().revision !== savedRevision ||
      Boolean(editor && editor.input.value.trim() !== editor.initialText) ||
      Boolean(gesture?.kind === 'pixel' || gesture?.kind === 'draw' || gesture?.kind === 'erase' && gesture.removed.size);

    function paintMosaic(painter, item) {
      const { x, y, w, h } = clipRect(mapRect(item.rect, item.matrix), base.width, base.height);
      if (w < 1 || h < 1) return;
      const cell = Math.max(6, item.width * 2);
      mosaic.width = Math.max(1, Math.ceil(w / cell));
      mosaic.height = Math.max(1, Math.ceil(h / cell));
      mosaicPainter.drawImage(base, x, y, w, h, 0, 0, mosaic.width, mosaic.height);
      painter.save();
      painter.imageSmoothingEnabled = false;
      painter.drawImage(mosaic, x, y, w, h);
      painter.restore();
    }

    function paintAnnotation(painter, item) {
      if (item.kind === 'mosaic') {
        paintMosaic(painter, item);
        return;
      }
      painter.save();
      painter.setTransform(...item.matrix);
      setStroke(painter, item.width, item.color);
      if (item.kind === 'text') {
        painter.font = item.fontSize + 'px ' + FONT;
        painter.textBaseline = 'top';
        item.lines.forEach((line, index) => {
          painter.fillText(line, item.rect.x, item.rect.y + index * item.lineHeight);
        });
      } else {
        const { stroke, fill } = annotationPaths(item);
        if (stroke) painter.stroke(stroke);
        if (fill) painter.fill(fill);
      }
      painter.restore();
    }

    function drawAnnotations() {
      annoPainter.clearRect(0, 0, anno.width, anno.height);
      const removed = gesture?.kind === 'erase' ? gesture.removed : null;
      for (const item of current().annotations) {
        if (!removed?.has(item)) paintAnnotation(annoPainter, item);
      }
      if (gesture?.kind === 'draw') paintAnnotation(annoPainter, gesture.item);
    }

    function drawPins() {
      const nodes = document.createDocumentFragment();
      for (const pin of current().pins) {
        const shown = gesture?.kind === 'pin' && gesture.pin.id === pin.id ? gesture.preview : pin;
        if (shown.region) {
          const region = element('div', 'ws-img-pin-region');
          positionRect(region, shown.region, base.width, base.height);
          nodes.append(region);
        }
        const marker = element('button', 'ws-img-pin', '#' + pin.id);
        marker.type = 'button';
        marker.dataset.pinId = String(pin.id);
        marker.title = pin.text || '评论 #' + pin.id;
        marker.setAttribute('aria-label', '评论 #' + pin.id);
        marker.style.left = (shown.x / base.width * 100) + '%';
        marker.style.top = (shown.y / base.height * 100) + '%';
        nodes.append(marker);
      }
      pinsLayer.replaceChildren(nodes);
    }

    function drawCrop() {
      cropMask.hidden = cropBox.hidden = !crop;
      if (!crop) return;
      positionRect(cropBox, crop, base.width, base.height);
      const left = (crop.x / base.width * 100) + '%';
      const top = (crop.y / base.height * 100) + '%';
      const right = ((crop.x + crop.w) / base.width * 100) + '%';
      const bottom = ((crop.y + crop.h) / base.height * 100) + '%';
      cropMask.style.clipPath = 'polygon(evenodd, 0 0, 100% 0, 100% 100%, 0 100%, 0 0, ' +
        [left + ' ' + top, right + ' ' + top, right + ' ' + bottom, left + ' ' + bottom, left + ' ' + top]
          .join(', ') + ')';
    }

    function layout(anchor) {
      const padding = getComputedStyle(viewport);
      const availableW = viewport.clientWidth - parseFloat(padding.paddingLeft) - parseFloat(padding.paddingRight);
      const availableH = viewport.clientHeight - parseFloat(padding.paddingTop) - parseFloat(padding.paddingBottom);
      const fit = Math.max(0.001, Math.min(1, availableW / base.width, availableH / base.height));
      displayScale = zoom === 'fit' ? fit : zoom === '100' ? 1 : zoomScale;
      frame.style.width = Math.max(1, Math.round(base.width * displayScale)) + 'px';
      frame.style.height = Math.max(1, Math.round(base.height * displayScale)) + 'px';
      if (anchor) {
        const rect = frame.getBoundingClientRect();
        viewport.scrollLeft += rect.left + anchor.xRatio * rect.width - anchor.x;
        viewport.scrollTop += rect.top + anchor.yRatio * rect.height - anchor.y;
      }
      frame.classList.toggle('is-checker', checker);
      zoomReadout.textContent = Math.max(1, Math.round(displayScale * 100)) + '%';
      setPressed(fitButton, zoom === 'fit');
      setPressed(actualSizeButton, zoom === '100');
      setPressed(checkerButton, checker);
      positionEditor();
    }

    function changeZoom(nextZoom, scale, clientX, clientY) {
      const frameRect = frame.getBoundingClientRect();
      const viewRect = viewport.getBoundingClientRect();
      const x = clientX ?? viewRect.left + viewRect.width / 2;
      const y = clientY ?? viewRect.top + viewRect.height / 2;
      const anchor = {
        x, y,
        xRatio: (x - frameRect.left) / frameRect.width,
        yRatio: (y - frameRect.top) / frameRect.height,
      };
      zoom = nextZoom;
      if (nextZoom === 'custom') zoomScale = clamp(scale, 0.1, 5);
      layout(nextZoom === 'fit' ? null : anchor);
    }

    function redraw() {
      const { pixels } = current();
      const changedSize = base.width !== pixels.width || base.height !== pixels.height;
      if (changedSize) {
        base.width = anno.width = pixels.width;
        base.height = anno.height = pixels.height;
      }
      if (displayedPixels !== pixels) {
        basePainter.clearRect(0, 0, base.width, base.height);
        basePainter.drawImage(pixels, 0, 0);
        displayedPixels = pixels;
      }
      if (changedSize || !frame.style.width) {
        dimensions.textContent = base.width + ' × ' + base.height + ' px';
        fillResizeInputs();
        layout();
      }
      drawAnnotations();
      drawPins();
      drawCrop();
      refreshControls();
    }

    function commit(changes) {
      const next = { ...current(), ...changes, revision: nextRevision++ };
      history.length = historyIndex + 1;
      history.push(next);
      const rasterSize = () => {
        const canvases = new Set(history.map((entry) => entry.pixels));
        let bytes = 0;
        for (const canvas of canvases) bytes += canvas.width * canvas.height * 4;
        return bytes;
      };
      while (history.length > 1 && (history.length > MAX_HISTORY || rasterSize() > MAX_RASTER_HISTORY_BYTES)) {
        history.shift();
      }
      historyIndex = history.length - 1;
      redraw();
    }

    function moveHistory(offset) {
      const index = historyIndex + offset;
      if (index < 0 || index >= history.length) return;
      cancelGesture();
      closeEditor(false);
      crop = null;
      historyIndex = index;
      redraw();
    }

    function transformImage(width, height, matrix) {
      try {
        const next = canvasFor(width, height);
        cancelGesture();
        closeEditor(true);
        const snapshot = current();
        const painter = next.getContext('2d');
        painter.imageSmoothingQuality = 'high';
        painter.setTransform(...matrix);
        painter.drawImage(snapshot.pixels, 0, 0);
        const transform = new DOMMatrix(matrix);
        const annotations = snapshot.annotations.map((item) => {
          const m = transform.multiply(new DOMMatrix(item.matrix));
          return { ...item, matrix: [m.a, m.b, m.c, m.d, m.e, m.f] };
        });
        const pins = snapshot.pins.map((pin) => transformPin(pin, matrix, width, height)).filter(Boolean);
        crop = null;
        commit({ pixels: next, annotations, pins });
      } catch (error) {
        showToast?.(error.message, 2800);
      }
    }

    function resetCrop() {
      closeEditor(true);
      cancelGesture();
      let w = base.width * 0.8;
      let h = base.height * 0.8;
      if (cropRatio) {
        w = Math.min(w, h * cropRatio);
        h = w / cropRatio;
      }
      crop = { x: (base.width - w) / 2, y: (base.height - h) / 2, w, h };
      drawCrop();
      refreshControls();
    }

    function applyCrop() {
      if (!crop?.w || !crop.h) return;
      const x = clamp(Math.round(crop.x), 0, base.width - 1);
      const y = clamp(Math.round(crop.y), 0, base.height - 1);
      const right = clamp(Math.round(crop.x + crop.w), x + 1, base.width);
      const bottom = clamp(Math.round(crop.y + crop.h), y + 1, base.height);
      transformImage(right - x, bottom - y, [1, 0, 0, 1, -x, -y]);
    }

    function positionEditor() {
      if (!editor) return;
      const box = shell.getBoundingClientRect();
      const rect = frame.getBoundingClientRect();
      const x = rect.left - box.left + editor.anchor.x * rect.width / base.width;
      const y = rect.top - box.top + editor.anchor.y * rect.height / base.height;
      const maxLeft = Math.max(8, box.width - editor.node.offsetWidth - 8);
      const maxTop = Math.max(8, Math.min(
        box.height - editor.node.offsetHeight - 8,
        dockStack.getBoundingClientRect().top - box.top - editor.node.offsetHeight - 8
      ));
      const top = y + 14 > maxTop ? y - editor.node.offsetHeight - 12 : y + 14;
      editor.node.style.left = clamp(x + 12, 8, maxLeft) + 'px';
      editor.node.style.top = clamp(top, 8, maxTop) + 'px';
    }

    function closeEditor(save) {
      if (!editor) return;
      const { node, input, anchor, pin, color, width } = editor;
      const text = input.value.trim();
      editor = null;
      node.remove();
      if (save && pin && text !== pin.text) {
        commit({ pins: current().pins.map((item) => item.id === pin.id ? { ...item, text } : item) });
      } else if (save && !pin && text) {
        const fontSize = Math.max(14, width * 4);
        const lineHeight = Math.ceil(fontSize * 1.25);
        const lines = text.split(/\r?\n/);
        annoPainter.save();
        annoPainter.font = fontSize + 'px ' + FONT;
        const w = lines.reduce((max, line) => Math.max(max, annoPainter.measureText(line).width), 0);
        annoPainter.restore();
        const item = {
          kind: 'text', matrix: IDENTITY, color, width, fontSize, lineHeight, lines,
          rect: { ...anchor, w, h: lineHeight * lines.length },
        };
        commit({ annotations: [...current().annotations, item] });
      } else {
        refreshControls();
      }
    }

    function openEditor(anchor, pin = null) {
      closeEditor(true);
      panelName = '';
      const node = element('div', 'ws-img-inline-editor');
      node.setAttribute('role', 'group');
      node.setAttribute('aria-label', pin ? '评论 #' + pin.id : '添加文字');
      const input = element('textarea', 'ws-img-input');
      input.rows = 3;
      input.placeholder = pin ? '写下这处修改意见…' : '输入标注文字…';
      input.setAttribute('aria-label', pin ? '评论内容' : '标注文字');
      input.value = pin?.text || '';
      const actions = element('div', 'ws-img-row ws-img-editor-actions');
      const save = button(pin ? '保存' : '确认', () => closeEditor(true), { className: 'ws-img-primary' });
      const dismiss = button(pin ? '删除' : '取消', () => {
        closeEditor(false);
        if (pin) commit({ pins: current().pins.filter((item) => item.id !== pin.id) });
      }, { className: pin ? 'ws-img-danger' : '' });
      actions.append(dismiss, save);
      if (pin) node.append(element('div', 'ws-img-editor-label', '评论 #' + pin.id));
      node.append(input, actions);
      editor = { node, input, anchor, pin, color: strokeColor, width: strokeWidth, initialText: input.value };
      shell.append(node);
      input.addEventListener('input', refreshControls);
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.isComposing && !event.shiftKey && (!pin || event.ctrlKey || event.metaKey)) {
          event.preventDefault();
          closeEditor(true);
        }
      });
      if (!pin) {
        input.addEventListener('blur', (event) => {
          if (editor?.node === node && !node.contains(event.relatedTarget)) closeEditor(true);
        });
      }
      refreshControls();
      positionEditor();
      input.focus({ preventScroll: true });
    }

    function renderCompositeCanvas({ includePins }) {
      const result = canvasFor(base.width, base.height);
      const painter = result.getContext('2d');
      painter.drawImage(base, 0, 0);
      painter.drawImage(anno, 0, 0);
      if (!includePins) return result;
      const labelSize = clamp(Math.round(Math.min(base.width, base.height) * 0.035), 14, 42);
      painter.font = '600 ' + labelSize + 'px ' + FONT;
      painter.textBaseline = 'middle';
      painter.textAlign = 'center';
      for (const pin of current().pins) {
        const label = '#' + pin.id;
        const boxW = Math.ceil(painter.measureText(label).width + labelSize * 0.9);
        const boxH = Math.ceil(labelSize * 1.55);
        const x = clamp(pin.x - boxW / 2, 0, Math.max(0, base.width - boxW));
        const y = clamp(pin.y - boxH / 2, 0, Math.max(0, base.height - boxH));
        painter.fillStyle = painter.strokeStyle = PIN_COLOR;
        painter.lineWidth = Math.max(2, Math.round(labelSize / 8));
        if (pin.region) painter.strokeRect(pin.region.x, pin.region.y, pin.region.w, pin.region.h);
        painter.beginPath();
        painter.roundRect(x, y, boxW, boxH, boxH / 2);
        painter.fill();
        painter.fillStyle = '#ffffff';
        painter.fillText(label, x + boxW / 2, y + boxH / 2);
      }
      return result;
    }

    async function exportImage(action) {
      if (!live() || exporting) return;
      cancelGesture();
      closeEditor(true);
      panelName = '';
      exporting = true;
      refreshControls();
      try {
        const snapshot = current();
        const composite = renderCompositeCanvas({ includePins: action === 'send' });
        if (action === 'copy') {
          if (!navigator.clipboard?.write || !global.ClipboardItem) {
            throw new Error('此环境无法写入图片剪贴板');
          }
          await navigator.clipboard.write([new global.ClipboardItem({ 'image/png': encodeCanvas(composite, 'image/png') })]);
          if (live()) showToast?.('图片已复制到剪贴板');
          return;
        }

        const overwrite = action === 'overwrite';
        if (overwrite && !canOverwriteOriginal) return;
        const blob = await encodeCanvas(composite, overwrite ? IMAGE_MIMES[origExt] : 'image/png');
        const content = await blobBase64(blob);
        if (!live()) return;
        if (overwrite) {
          const saved = await onSaveFile({
            content, encoding: 'base64', baseVersion: sourceVersion, baseMtimeMs: sourceMtime,
          });
          if (live() && saved?.success) {
            sourceVersion = saved.version || sourceVersion;
            sourceMtime = saved.mtimeMs ?? sourceMtime;
            savedRevision = snapshot.revision;
          }
          return;
        }

        const suffix = action === 'send' ? '_annotated.png' : '_edited.png';
        const name = (stem.slice(0, 180 - suffix.length) || 'image') + suffix;
        const saved = await onSaveAsFile({ sourcePath: file.path, fileName: name, content, autoRename: true });
        if (!live() || !saved?.success) return;
        if (action === 'send') {
          await onSendToAgent(promptForImage(file.path, saved.path, snapshot.pixels, snapshot.pins));
        } else {
          showToast?.('已另存为：' + saved.name);
        }
      } catch (error) {
        if (live()) showToast?.('图片操作失败：' + (error?.message || error), 2800);
      } finally {
        exporting = false;
        if (live()) refreshControls();
      }
    }

    function imagePoint(event) {
      const rect = frame.getBoundingClientRect();
      return {
        x: clamp((event.clientX - rect.left) * base.width / rect.width, 0, base.width),
        y: clamp((event.clientY - rect.top) * base.height / rect.height, 0, base.height),
      };
    }

    function erasePixels(from, to) {
      basePainter.save();
      basePainter.globalCompositeOperation = 'destination-out';
      setStroke(basePainter, eraserSize, '#000');
      basePainter.beginPath();
      if (from.x === to.x && from.y === to.y) {
        basePainter.arc(to.x, to.y, eraserSize / 2, 0, Math.PI * 2);
        basePainter.fill();
      } else {
        basePainter.moveTo(from.x, from.y);
        basePainter.lineTo(to.x, to.y);
        basePainter.stroke();
      }
      basePainter.restore();
      displayedPixels = null;
      drawAnnotations();
    }

    function eraseAnnotations(from, to, removed) {
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / (eraserSize / 4)));
      for (const item of current().annotations) {
        if (removed.has(item)) continue;
        const { stroke, fill } = annotationPaths(item);
        const [a, b, c, d] = item.matrix;
        const scale = Math.min(Math.hypot(a, b), Math.hypot(c, d));
        annoPainter.save();
        annoPainter.setTransform(...item.matrix);
        setStroke(annoPainter, item.width + eraserSize / scale, item.color);
        for (let step = 0; step <= steps; step++) {
          const x = from.x + dx * step / steps;
          const y = from.y + dy * step / steps;
          if (
            (stroke && annoPainter.isPointInStroke(stroke, x, y)) ||
            (fill && (annoPainter.isPointInPath(fill, x, y) || annoPainter.isPointInStroke(fill, x, y)))
          ) {
            removed.add(item);
            break;
          }
        }
        annoPainter.restore();
      }
      drawAnnotations();
    }

    function updateGesture(event) {
      const active = gesture;
      if (!active || active.pointerId !== event.pointerId) return;
      if (active.kind === 'pan') {
        viewport.scrollLeft = active.scrollX - (event.clientX - active.x);
        viewport.scrollTop = active.scrollY - (event.clientY - active.y);
        return;
      }

      const point = imagePoint(event);
      const dx = point.x - active.start.x;
      const dy = point.y - active.start.y;
      if (active.kind === 'crop') {
        const before = active.before;
        if (active.handle) {
          crop = resizeCrop(before, active.handle, dx, dy, cropRatio, base.width, base.height);
        } else if (active.move) {
          crop = {
            ...before,
            x: clamp(before.x + dx, 0, base.width - before.w),
            y: clamp(before.y + dy, 0, base.height - before.h),
          };
        } else {
          crop = cornerCrop(active.start, point, cropRatio, base.width, base.height, dx < 0 ? -1 : 1, dy < 0 ? -1 : 1);
        }
        drawCrop();
      } else if (active.kind === 'draw') {
        const item = active.item;
        if (item.points && Math.hypot(point.x - item.b.x, point.y - item.b.y) > 0.25) item.points.push(point);
        item.b = point;
        if (item.kind === 'mosaic') item.rect = rectBetween(item.a, point);
        drawAnnotations();
      } else if (active.kind === 'pixel') {
        erasePixels(active.last, point);
        active.last = point;
      } else if (active.kind === 'erase') {
        eraseAnnotations(active.last, point, active.removed);
        active.last = point;
      } else if (active.kind === 'drop-pin') {
        const region = rectBetween(active.start, point);
        active.region = Math.hypot(dx, dy) * displayScale >= 5 && region.w > 0 && region.h > 0 ? region : null;
        dragRegion.hidden = !active.region;
        if (active.region) positionRect(dragRegion, active.region, base.width, base.height);
      } else if (active.kind === 'pin' && (active.moved || Math.hypot(dx, dy) * displayScale >= 4)) {
        const pin = active.pin;
        const x = clamp(pin.x + dx, 0, base.width - (pin.region?.w || 0));
        const y = clamp(pin.y + dy, 0, base.height - (pin.region?.h || 0));
        active.moved = true;
        active.preview = { ...pin, x, y, region: pin.region ? { ...pin.region, x, y } : null };
        drawPins();
      }
      refreshControls();
    }

    function releaseGesture() {
      const active = gesture;
      gesture = null;
      if (!active) return null;
      if (viewport.hasPointerCapture(active.pointerId)) viewport.releasePointerCapture(active.pointerId);
      dragRegion.hidden = true;
      return active;
    }

    function cancelGesture() {
      const active = releaseGesture();
      if (!active) return;
      if (active.kind === 'crop') crop = active.before;
      redraw();
    }

    function finishGesture(event) {
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      updateGesture(event);
      const done = releaseGesture();
      if (done.kind === 'draw') {
        const { a, b, kind } = done.item;
        const changedX = a.x !== b.x;
        const changedY = a.y !== b.y;
        const hasGeometry = kind === 'arrow' ? changedX || changedY : changedX && changedY;
        if (kind === 'pen' || hasGeometry) {
          commit({ annotations: [...current().annotations, done.item] });
          return;
        }
      } else if (done.kind === 'pixel') {
        const pixels = canvasFor(base.width, base.height);
        pixels.getContext('2d').drawImage(base, 0, 0);
        displayedPixels = pixels;
        commit({ pixels });
        return;
      } else if (done.kind === 'erase' && done.removed.size) {
        commit({ annotations: current().annotations.filter((item) => !done.removed.has(item)) });
        return;
      } else if (done.kind === 'drop-pin') {
        const anchor = done.region || done.start;
        const pin = { id: nextPin++, x: anchor.x, y: anchor.y, region: done.region, text: '' };
        commit({ pins: [...current().pins, pin] });
        openEditor(pin, pin);
        return;
      } else if (done.kind === 'pin') {
        if (done.moved) {
          commit({ pins: current().pins.map((pin) => pin.id === done.pin.id ? done.preview : pin) });
        } else {
          openEditor(done.pin, done.pin);
        }
        return;
      } else if (done.kind === 'crop' && (!crop.w || !crop.h)) {
        crop = done.before;
      }
      redraw();
    }

    function startGesture(event) {
      if (gesture || (event.button !== 0 && event.button !== 1)) return;
      const marker = event.target.closest('.ws-img-pin');
      const onCanvas = interaction.contains(event.target);
      const pan = spaceHeld || event.button === 1;
      if (!pan && !marker && !onCanvas) return;
      if (!pan && !marker && !crop && !mode) return;

      event.preventDefault();
      closeEditor(true);
      if (panelName === 'save') panelName = '';
      const pointerId = event.pointerId;
      const start = imagePoint(event);
      if (pan) {
        gesture = {
          kind: 'pan', pointerId, x: event.clientX, y: event.clientY,
          scrollX: viewport.scrollLeft, scrollY: viewport.scrollTop,
        };
      } else if (marker) {
        const pin = current().pins.find((item) => String(item.id) === marker.dataset.pinId);
        if (!pin) return;
        gesture = { kind: 'pin', pointerId, start, pin, preview: pin, moved: false };
      } else if (crop) {
        gesture = {
          kind: 'crop', pointerId, start, before: crop,
          handle: event.target.dataset.handle, move: event.target === cropBox,
        };
      } else if (mode === 'annotate') {
        if (annotationKind === 'text') {
          openEditor(start);
          return;
        }
        const item = { kind: annotationKind, matrix: IDENTITY, color: strokeColor, width: strokeWidth, a: start, b: start };
        if (annotationKind === 'pen') item.points = [start];
        if (annotationKind === 'mosaic') item.rect = rectBetween(start, start);
        gesture = { kind: 'draw', pointerId, start, item };
      } else if (mode === 'eraser') {
        gesture = eraserMode === 'pixel'
          ? { kind: 'pixel', pointerId, last: start, start }
          : { kind: 'erase', pointerId, last: start, start, removed: new Set() };
      } else if (mode === 'comment') {
        gesture = { kind: 'drop-pin', pointerId, start, region: null };
      }
      if (!gesture) return;
      viewport.focus({ preventScroll: true });
      viewport.setPointerCapture(pointerId);
      if (pan) refreshControls();
      else updateGesture(event);
    }

    leftToolbar = element('div', 'ws-toolbar-group ws-img-view-controls');
    rightToolbar = element('div', 'ws-toolbar-group ws-img-status');
    const fitButton = button('适应窗口', () => changeZoom('fit', 1));
    const actualSizeButton = button('100% 原图', () => changeZoom('100', 1));
    const zoomControls = element('div', 'ws-img-zoom');
    const zoomOut = button('−', () => changeZoom('custom', displayScale / 1.2), { title: '缩小' });
    const zoomIn = button('+', () => changeZoom('custom', displayScale * 1.2), { title: '放大' });
    zoomOut.setAttribute('aria-label', '缩小');
    zoomIn.setAttribute('aria-label', '放大');
    const zoomReadout = element('span', 'ws-img-zoom-readout');
    zoomControls.append(zoomOut, zoomReadout, zoomIn);
    const checkerButton = button('透明棋盘格', () => {
      checker = !checker;
      layout();
    });
    const dimensions = element('span', 'ws-img-dimensions');
    const dirtyBadge = element('span', 'ws-img-dirty', '未保存修改');
    dirtyBadge.setAttribute('role', 'status');
    const hint = element('span', 'ws-img-shortcuts', 'Ctrl+滚轮缩放 · 空格拖拽 · Ctrl+Z 撤销');
    leftToolbar.append(fitButton, actualSizeButton, zoomControls, checkerButton, dimensions);
    rightToolbar.append(dirtyBadge, hint);

    const optionRefreshers = [];
    const toolPanels = new Map();
    const dockToggles = new Map();
    function addPanel(name, label) {
      const node = element('div', 'ws-img-panel');
      node.setAttribute('role', 'group');
      node.setAttribute('aria-label', label);
      node.hidden = true;
      toolPanels.set(name, node);
      panels.append(node);
      return node;
    }

    function addChoices(parent, choices, read, write, label, swatches = false) {
      const row = element('div', 'ws-img-row');
      if (label) row.append(element('span', 'ws-img-row-label', label));
      const controls = choices.map(([text, value]) => {
        const choice = button(swatches ? '' : text, () => {
          write(value);
          refreshControls();
        }, { className: swatches ? 'ws-img-swatch' : '' });
        if (swatches) {
          choice.title = text;
          choice.setAttribute('aria-label', text);
          choice.style.setProperty('--ws-img-swatch', value);
        }
        row.append(choice);
        return [choice, value];
      });
      optionRefreshers.push(() => {
        const selected = read();
        controls.forEach(([choice, value]) => setPressed(choice, selected === value));
      });
      parent.append(row);
    }

    const annotate = addPanel('annotate', '标注工具');
    addChoices(
      annotate, [['画笔', 'pen'], ['矩形', 'rect'], ['椭圆', 'ellipse'], ['箭头', 'arrow'], ['文字', 'text'], ['马赛克', 'mosaic']],
      () => annotationKind, (value) => { annotationKind = value; }
    );
    addChoices(
      annotate, [['红', '#ff4d4f'], ['黄', '#faad14'], ['绿', '#52c41a'], ['蓝', '#1677ff'], ['白', '#ffffff'], ['黑', '#1f1f1f']],
      () => strokeColor, (value) => { strokeColor = value; }, '颜色', true
    );
    addChoices(
      annotate, [['细 2', 2], ['中 4', 4], ['粗 8', 8], ['特粗 14', 14]],
      () => strokeWidth, (value) => { strokeWidth = value; }, '笔宽 px'
    );

    const comment = addPanel('comment', '评论工具');
    const commentRow = element('div', 'ws-img-row');
    const pinCount = element('span', 'ws-img-row-label');
    const clearPins = button('清空评论', () => {
      closeEditor(false);
      commit({ pins: [] });
    }, { className: 'ws-img-danger' });
    commentRow.append(pinCount, clearPins);
    comment.append(commentRow);

    const eraser = addPanel('eraser', '擦除工具');
    addChoices(
      eraser, [['擦除标注', 'annotation'], ['像素擦除', 'pixel']],
      () => eraserMode, (value) => { eraserMode = value; }
    );
    addChoices(
      eraser, [['10', 10], ['20', 20], ['36', 36]],
      () => eraserSize, (value) => { eraserSize = value; }, '刷宽 px'
    );

    const transform = addPanel('transform', '图片变换');
    const transformPages = new Map();
    addChoices(
      transform, [['裁剪', 'crop'], ['缩放', 'resize'], ['旋转/翻转', 'rotate']],
      () => transformMode, (value) => {
        if (transformMode === value) return;
        crop = null;
        transformMode = value;
        if (value === 'resize') fillResizeInputs();
        drawCrop();
      }
    );
    for (const name of ['crop', 'resize', 'rotate']) {
      const page = element('div', 'ws-img-transform-page');
      transformPages.set(name, page);
      transform.append(page);
    }

    const cropPage = transformPages.get('crop');
    addChoices(
      cropPage, [['自由', 0], ['1:1', 1], ['16:9', 16 / 9], ['4:3', 4 / 3]],
      () => cropRatio, (value) => {
        cropRatio = value;
        if (crop) resetCrop();
      }, '比例'
    );
    const cropActions = element('div', 'ws-img-row');
    const startCropButton = button('开始/重置选区', resetCrop);
    const applyCropButton = button('应用裁剪', applyCrop, { className: 'ws-img-primary' });
    const cancelCropButton = button('取消', () => {
      cancelGesture();
      crop = null;
      drawCrop();
      refreshControls();
    });
    cropActions.append(startCropButton, cancelCropButton, applyCropButton);
    cropPage.append(cropActions);

    function resizeInput(label) {
      const field = element('label', 'ws-img-size-field');
      const input = element('input', 'ws-img-input');
      input.type = 'number';
      input.min = '1';
      input.max = String(MAX_CANVAS_SIDE);
      input.step = '1';
      field.append(document.createTextNode(label), input);
      return { field, input };
    }

    const resizePage = transformPages.get('resize');
    const resizeRow = element('div', 'ws-img-row');
    const { field: widthField, input: widthInput } = resizeInput('宽');
    const { field: heightField, input: heightInput } = resizeInput('高');
    const lockField = element('label', 'ws-img-lock');
    const lockRatio = element('input');
    lockRatio.type = 'checkbox';
    lockRatio.checked = true;
    lockField.append(lockRatio, document.createTextNode('锁定比例'));
    resizeRow.append(widthField, element('span', 'ws-img-row-label', '×'), heightField, lockField);
    resizePage.append(resizeRow);
    const resizeActions = element('div', 'ws-img-row');
    for (const scale of [0.5, 0.75, 1.5]) {
      resizeActions.append(button(Math.round(scale * 100) + '%', () => {
        fillResizeInputs(scale);
      }));
    }
    resizeActions.append(button('应用缩放', () => {
      const w = widthInput.valueAsNumber;
      const h = heightInput.valueAsNumber;
      if (w === base.width && h === base.height) return;
      transformImage(w, h, [w / base.width, 0, 0, h / base.height, 0, 0]);
    }, { className: 'ws-img-primary' }));
    resizePage.append(resizeActions);
    widthInput.addEventListener('input', () => {
      if (lockRatio.checked && widthInput.valueAsNumber > 0) {
        heightInput.value = String(Math.max(1, Math.round(widthInput.valueAsNumber * base.height / base.width)));
      }
    });
    heightInput.addEventListener('input', () => {
      if (lockRatio.checked && heightInput.valueAsNumber > 0) {
        widthInput.value = String(Math.max(1, Math.round(heightInput.valueAsNumber * base.width / base.height)));
      }
    });
    lockRatio.addEventListener('change', () => {
      if (lockRatio.checked) widthInput.dispatchEvent(new Event('input'));
    });

    function fillResizeInputs(scale = 1) {
      widthInput.value = String(Math.max(1, Math.round(base.width * scale)));
      heightInput.value = String(Math.max(1, Math.round(base.height * scale)));
    }

    const rotateActions = element('div', 'ws-img-row');
    rotateActions.append(
      button('左转 90°', () => transformImage(base.height, base.width, [0, -1, 1, 0, 0, base.width])),
      button('右转 90°', () => transformImage(base.height, base.width, [0, 1, -1, 0, base.height, 0])),
      button('水平翻转', () => transformImage(base.width, base.height, [-1, 0, 0, 1, base.width, 0])),
      button('垂直翻转', () => transformImage(base.width, base.height, [1, 0, 0, -1, 0, base.height]))
    );
    transformPages.get('rotate').append(rotateActions);

    const savePanel = addPanel('save', '保存图片');
    savePanel.classList.add('ws-img-save-panel');
    const overwriteHint = 'SVG/GIF/BMP/ICO 请使用「另存为副本 (PNG)」或「发给 AI」';
    const overwriteButton = button('覆盖原图', () => exportImage('overwrite'), {
      title: canOverwriteOriginal ? '' : overwriteHint,
    });
    const saveCopyButton = button('另存为副本 (PNG)', () => exportImage('save-as'));
    const copyButton = button('复制图片到剪贴板', () => exportImage('copy'));
    savePanel.append(overwriteButton, saveCopyButton, copyButton);
    if (!canOverwriteOriginal) {
      savePanel.append(element('span', 'ws-img-row-label', overwriteHint));
    }

    function togglePanel(name) {
      cancelGesture();
      closeEditor(true);
      if (name !== 'save' && name !== mode) {
        mode = name;
        crop = null;
        drawCrop();
      }
      panelName = panelName === name ? '' : name;
      refreshControls();
    }

    function dockToggle(label, name, icon) {
      const control = button(label, () => togglePanel(name), { icon });
      dockToggles.set(name, control);
      return control;
    }

    const toolGroup = element('div', 'ws-img-dock-group');
    toolGroup.append(
      dockToggle('标注', 'annotate', 'ui-edit'),
      dockToggle('添加评论', 'comment'),
      dockToggle('擦除', 'eraser'),
      dockToggle('裁剪/缩放', 'transform')
    );
    const actionsGroup = element('div', 'ws-img-dock-group');
    const undoButton = button('撤销', () => moveHistory(-1), { title: '撤销 (Ctrl+Z)' });
    const redoButton = button('重做', () => moveHistory(1), { title: '重做 (Ctrl+Shift+Z)' });
    const saveButton = dockToggle('保存 ▾', 'save', 'ui-save');
    const sendButton = button('发给 AI', () => exportImage('send'), { icon: 'ui-send', className: 'ws-img-primary' });
    actionsGroup.append(undoButton, redoButton, saveButton, sendButton);
    const divider = element('span', 'ws-img-divider');
    divider.setAttribute('aria-hidden', 'true');
    dock.append(toolGroup, divider, actionsGroup);

    function refreshControls() {
      dirtyBadge.hidden = !isDirty();
      undoButton.disabled = historyIndex < 1;
      redoButton.disabled = historyIndex >= history.length - 1;
      saveButton.disabled = exporting;
      overwriteButton.disabled = exporting || !canOverwriteOriginal || typeof onSaveFile !== 'function';
      saveCopyButton.disabled = exporting || typeof onSaveAsFile !== 'function';
      copyButton.disabled = exporting;
      sendButton.disabled = exporting || typeof onSaveAsFile !== 'function' || typeof onSendToAgent !== 'function';
      dock.setAttribute('aria-busy', String(exporting));
      for (const [name, node] of toolPanels) node.hidden = name !== panelName;
      panels.hidden = !panelName;
      for (const [name, control] of dockToggles) {
        control.classList.toggle('is-active', name === mode || name === panelName);
        control.setAttribute('aria-expanded', String(name === panelName));
      }
      for (const [name, page] of transformPages) page.hidden = name !== transformMode;
      optionRefreshers.forEach((refresh) => refresh());
      const count = current().pins.length;
      pinCount.textContent = count + ' 条评论';
      clearPins.disabled = !count;
      applyCropButton.disabled = !crop?.w || !crop.h;
      cancelCropButton.disabled = !crop;
      interaction.dataset.mode = crop ? 'crop' : mode;
      viewport.classList.toggle('is-pannable', spaceHeld || gesture?.kind === 'pan');
      viewport.classList.toggle('is-panning', gesture?.kind === 'pan');
    }

    function onKeyDown(event) {
      if (!live() || event.defaultPrevented || event.isComposing) return;
      if (event.key === 'Escape') {
        if (gesture) {
          cancelGesture();
        } else if (editor) {
          closeEditor(false);
        } else if (crop) {
          crop = null;
          drawCrop();
        } else if (panelName) {
          panelName = '';
        } else {
          return;
        }
        refreshControls();
        event.preventDefault();
        return;
      }
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return;
      const modifier = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      if (modifier && !event.altKey && (key === 'z' || key === 'y')) {
        event.preventDefault();
        moveHistory(key === 'y' || event.shiftKey ? 1 : -1);
      } else if (event.code === 'Space' && !modifier && !target?.closest('button')) {
        event.preventDefault();
        spaceHeld = true;
        refreshControls();
      }
    }

    function stopSpace() {
      if (!spaceHeld) return;
      spaceHeld = false;
      refreshControls();
    }

    function refocusCanvas(event) {
      if (event.detail > 0 && event.target.closest('.ws-img-button') && !editor) {
        viewport.focus({ preventScroll: true });
      }
    }

    viewport.addEventListener('pointerdown', startGesture, { signal });
    viewport.addEventListener('pointermove', updateGesture, { signal });
    viewport.addEventListener('pointerup', finishGesture, { signal });
    for (const name of ['pointercancel', 'lostpointercapture']) {
      viewport.addEventListener(name, (event) => {
        if (gesture?.pointerId === event.pointerId) cancelGesture();
      }, { signal });
    }
    pinsLayer.addEventListener('click', (event) => {
      const marker = event.target.closest('.ws-img-pin');
      if (!marker || event.detail !== 0) return;
      const pin = current().pins.find((item) => String(item.id) === marker.dataset.pinId);
      if (pin) openEditor(pin, pin);
    }, { signal });
    viewport.addEventListener('wheel', (event) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const multiplier = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1;
      changeZoom('custom', displayScale * Math.exp(-event.deltaY * multiplier * 0.002), event.clientX, event.clientY);
    }, { passive: false, signal });
    viewport.addEventListener('scroll', positionEditor, { signal });
    shell.addEventListener('click', refocusCanvas, { signal });
    leftToolbar.addEventListener('click', refocusCanvas, { signal });
    // Handle editor chords before the host bridge sees them on window.
    document.addEventListener('keydown', onKeyDown, { signal });
    global.addEventListener('keyup', (event) => {
      if (event.code === 'Space') stopSpace();
    }, { signal });
    global.addEventListener('blur', stopSpace, { signal });

    const fitViewport = () => {
      // Two dock rows need additional scroll clearance in narrow panes.
      viewport.style.setProperty('--ws-img-bottom-space', Math.max(88, dock.offsetHeight + 28) + 'px');
      layout();
    };
    stageEl.replaceChildren(shell);
    toolbarEl.replaceChildren(leftToolbar, rightToolbar);
    toolbarEl.classList.remove('is-hidden');
    onStatusBadge?.('图片编辑');
    dragRegion.hidden = true;
    redraw();
    fitViewport();
    if (global.ResizeObserver) {
      resizeObserver = new ResizeObserver(fitViewport);
      resizeObserver.observe(viewport);
      resizeObserver.observe(dock);
    } else {
      global.addEventListener('resize', fitViewport, { signal });
    }
    return { getState: () => ({ zoom, zoomScale, checker }), isDirty, destroy };
  }

  global.WSModules = global.WSModules || {};
  global.WSModules.renderImagePreview = renderImagePreview;
})(window);
