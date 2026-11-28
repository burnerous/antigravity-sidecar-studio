(function (global) {
  'use strict';

  const doc = global.document;
  const docEl = doc?.documentElement;
  const motionPreference = typeof global.matchMedia === 'function'
    ? global.matchMedia('(prefers-reduced-motion: reduce)')
    : null;
  const setTimer = global.setTimeout?.bind(global) ?? (typeof setTimeout === 'function' ? setTimeout : null);
  const clearTimer = global.clearTimeout?.bind(global) ?? (typeof clearTimeout === 'function' ? clearTimeout : null);

  const containerTypes = [
    { kind: 'mode', className: 'ws-mode-tabs', item: '.ws-mode-tab' },
    { kind: 'seg', className: 'ws-seg', item: 'button' },
    { kind: 'chip', className: 'ws-traj-chips', item: '.ws-chip-btn' },
  ];
  const indicatorClass = 'ws-prism-indicator';
  const pillClass = 'ws-prism-indicator-pill';
  const readyAttribute = 'data-prism-indicator';
  const segmentMemoryTTL = 800;
  const segmentMemoryLimit = 20;
  const containerStates = new WeakMap();
  const trackedContainers = new Set();
  const resizeTargets = new WeakMap();
  const segMemory = new Map();
  let rootObserver;
  let bodyObserver;
  let resizeObserver;
  let destroyed = false;

  const closingClass = 'is-prism-closing';
  const refreshClasses = ['is-prism-spinning', 'is-prism-pulse'];
  const shimmerClasses = ['is-prism-shimmer'];
  const badgeClasses = ['is-prism-badge-pop'];
  const paneClasses = ['is-prism-pane-enter-left', 'is-prism-pane-enter-right'];
  const squashClasses = ['is-gliding'];
  const effectFallback = 650;
  const overlayStates = new WeakMap();
  const spinStates = new WeakMap();
  const shimmerStates = new WeakMap();
  const badgeStates = new WeakMap();
  const paneStates = new WeakMap();
  const activeAnimations = new Set();

  function isPrismActive() {
    return docEl?.dataset?.skin === 'prism';
  }

  function isMotionEnabled() {
    return isPrismActive() && docEl?.dataset?.motion !== 'reduced' && !motionPreference?.matches;
  }

  function animationState() {
    return { gen: 0, timer: null, handler: null, cancel: null };
  }

  function getAnimationState(states, el) {
    let state = states.get(el);
    if (!state) {
      state = animationState();
      states.set(el, state);
    }
    return state;
  }

  function cancelAnimation(el, state) {
    state.gen++;
    if (state.handler) el.removeEventListener?.('animationend', state.handler);
    if (state.timer != null) clearTimer?.(state.timer);
    state.handler = null;
    state.timer = null;
    state.cancel = null;
    activeAnimations.delete(state);
  }

  function waitForAnimation(el, state, duration, { finish, cancel = finish, acceptsChild }) {
    const gen = state.gen;
    const onEnd = (event) => {
      if (state.gen !== gen) return;
      if (event && event.target !== el && !acceptsChild?.(event.target)) return;
      cancelAnimation(el, state);
      finish();
    };
    state.handler = onEnd;
    state.cancel = () => {
      cancelAnimation(el, state);
      cancel();
    };
    activeAnimations.add(state);
    el.addEventListener?.('animationend', onEnd);
    const timer = setTimer?.(onEnd, duration);
    if (state.gen === gen) state.timer = timer;
  }

  function restartAnimation(el, state, classes, className, duration, child = null) {
    const clear = () => classes.forEach((name) => el.classList.remove(name));
    cancelAnimation(el, state);
    clear();
    void el.offsetWidth;
    el.classList.add(className);
    waitForAnimation(el, state, duration, {
      finish: clear,
      acceptsChild: child ? (target) => target === child : undefined,
    });
  }

  function openOverlay(el) {
    if (!el) return;
    const state = overlayStates.get(el);
    if (state) {
      cancelAnimation(el, state);
      state.callbacks = null;
    }
    el.classList.remove(closingClass);
    el.classList.remove('is-hidden');
  }

  function closeOverlay(el, { onDone } = {}) {
    if (!el) return;
    const state = getAnimationState(overlayStates, el);
    const canAnimate = !destroyed && isMotionEnabled() && !el.classList.contains('is-hidden');
    if (onDone) (state.callbacks ??= []).push(onDone);
    if (state.handler) {
      if (!canAnimate) {
        state.handler();
        return;
      }
      if (el.classList.contains(closingClass)) return;
    }

    const clearClosing = () => el.classList.remove(closingClass);
    const hide = () => {
      const callbacks = state.callbacks;
      state.callbacks = null;
      clearClosing();
      el.classList.add('is-hidden');
      callbacks?.forEach((callback) => callback());
    };
    cancelAnimation(el, state);
    if (!canAnimate) {
      hide();
      return;
    }
    el.classList.add(closingClass);
    waitForAnimation(el, state, 180, {
      finish: hide,
      cancel: () => {
        state.callbacks = null;
        clearClosing();
      },
      acceptsChild: (target) => el.classList.contains('ws-modal-backdrop')
        && target?.classList?.contains('ws-modal'),
    });
  }

  function isOverlayOpen(el) {
    return Boolean(el && !el.classList.contains('is-hidden') && !el.classList.contains(closingClass));
  }

  function triggerRefreshSpin(btn) {
    if (!btn || destroyed || !isMotionEnabled()) return;
    const svg = btn.querySelector?.('svg');
    const className = svg ? refreshClasses[0] : refreshClasses[1];
    restartAnimation(btn, getAnimationState(spinStates, btn), refreshClasses, className, effectFallback, svg);
  }

  function triggerPrismShimmer(btn) {
    if (!btn || destroyed || !isMotionEnabled()) return;
    restartAnimation(btn, getAnimationState(shimmerStates, btn), shimmerClasses, shimmerClasses[0], effectFallback);
  }

  function popBadge(el) {
    if (!el || destroyed || !isMotionEnabled()) return;
    restartAnimation(el, getAnimationState(badgeStates, el), badgeClasses, badgeClasses[0], effectFallback);
  }

  function animatePaneSwitch(paneEl, direction) {
    if (!paneEl || destroyed || !isMotionEnabled()) return;
    const className = direction === 'left' ? paneClasses[0] : paneClasses[1];
    restartAnimation(paneEl, getAnimationState(paneStates, paneEl), paneClasses, className, 220);
  }

  function getContainerType(el) {
    return containerTypes.find(({ className }) => el?.classList?.contains(className));
  }

  function closestContainer(el) {
    for (let node = el; node; node = node.parentElement ?? node.parentNode) {
      if (trackedContainers.has(node) || getContainerType(node)) return node;
    }
    return null;
  }

  function collectContainers(root, found) {
    if (trackedContainers.has(root) || getContainerType(root)) found.add(root);
    for (const { className } of containerTypes) {
      for (const container of root?.querySelectorAll?.('.' + className) ?? []) found.add(container);
    }
  }

  function directIndicators(container) {
    const children = container.children ?? [container.firstElementChild];
    return Array.from(children).filter((child) => child?.classList?.contains(indicatorClass));
  }

  function cancelFlip(state) {
    state.flipToken = null;
    if (state.rafId != null) global.cancelAnimationFrame?.(state.rafId);
    if (state.glideTimer != null) clearTimer?.(state.glideTimer);
    state.rafId = null;
    state.glideTimer = null;
    state.indicator?.classList.remove('is-snapping');
  }

  function cancelSquash(state) {
    if (!state.indicator) return;
    cancelAnimation(state.indicator, state.squash);
    state.indicator.classList.remove('is-gliding');
  }

  function mountIndicator(container, state) {
    if (state.indicator && container.firstElementChild === state.indicator
      && state.indicator.firstElementChild === state.pill) return;

    cancelFlip(state);
    cancelSquash(state);
    const indicator = directIndicators(container)[0] ?? doc.createElement('span');
    indicator.classList.add(indicatorClass);
    indicator.setAttribute('data-indicator-kind', state.type.kind);
    indicator.setAttribute('aria-hidden', 'true');
    const firstChild = indicator.firstElementChild;
    let pill = firstChild;
    if (!pill?.classList?.contains(pillClass)) {
      pill = doc.createElement('span');
      pill.classList.add(pillClass);
      if (firstChild) indicator.insertBefore(pill, firstChild);
      else indicator.appendChild(pill);
    }
    if (container.firstElementChild !== indicator) {
      container.insertBefore(indicator, container.firstElementChild ?? null);
    }
    state.indicator = indicator;
    state.pill = pill;
    state.ready = false;
    state.rect = null;
  }

  function watchSize(el, container) {
    if (!resizeObserver || !el) return;
    resizeTargets.set(el, { container, width: el.offsetWidth, height: el.offsetHeight });
    resizeObserver.observe(el);
  }

  function unwatchSize(el) {
    if (!el) return;
    resizeTargets.delete(el);
    resizeObserver?.unobserve?.(el);
  }

  function onObservedResize(entries) {
    const changed = new Set();
    for (const { target } of entries) {
      const size = resizeTargets.get(target);
      if (!size) continue;
      const { offsetWidth: width, offsetHeight: height } = target;
      // Initial ResizeObserver notifications also arrive during a toolbar's FLIP.
      if (size.width === width && size.height === height) continue;
      size.width = width;
      size.height = height;
      changed.add(size.container);
    }
    for (const container of changed) {
      if (container.isConnected !== false) syncContainer(container, { snap: true });
    }
  }

  function forgetContainer(container) {
    const state = containerStates.get(container);
    if (state) {
      cancelFlip(state);
      cancelSquash(state);
      unwatchSize(state.active);
      unwatchSize(container);
      containerStates.delete(container);
      trackedContainers.delete(container);
    }
    container.removeAttribute?.(readyAttribute);
    for (const indicator of directIndicators(container)) {
      if (indicator.remove) indicator.remove();
      else container.removeChild(indicator);
    }
  }

  function getContainerState(container, type) {
    let state = containerStates.get(container);
    if (state?.type === type) return state;
    if (state) forgetContainer(container);
    state = {
      type, indicator: null, pill: null, active: null, rect: null, ready: false,
      segment: null, flipToken: null, rafId: null, glideTimer: null, squash: animationState(),
    };
    containerStates.set(container, state);
    trackedContainers.add(container);
    watchSize(container, container);
    return state;
  }

  function segmentSignature(container, buttons) {
    let parent = container.parentElement ?? container.parentNode;
    while (parent && !parent.id) parent = parent.parentElement ?? parent.parentNode;
    const labels = buttons.map((btn) => (btn.textContent || '').trim()).join('|');
    return JSON.stringify([parent?.id ?? '', labels]);
  }

  function rememberSegment(segment) {
    if (!segment) return;
    const { key, rect, activeIndex } = segment;
    segMemory.delete(key);
    segMemory.set(key, { ...rect, activeIndex, ts: Date.now() });
    if (segMemory.size > segmentMemoryLimit) segMemory.delete(segMemory.keys().next().value);
  }

  function applyRect(indicator, { left, top, width, height }) {
    indicator.style.setProperty('--ind-x', left + 'px');
    indicator.style.setProperty('--ind-y', top + 'px');
    indicator.style.setProperty('--ind-w', width + 'px');
    indicator.style.setProperty('--ind-h', height + 'px');
  }

  function sameRect(a, b) {
    return a && a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;
  }

  function placeIndicator(container, state, rect) {
    state.indicator.classList.add('is-snapping');
    applyRect(state.indicator, rect);
    container.setAttribute(readyAttribute, 'ready');
    void state.indicator.offsetWidth;
  }

  function glideIndicator(state, rect) {
    applyRect(state.indicator, rect);
    restartAnimation(state.indicator, state.squash, squashClasses, 'is-gliding', 360, state.pill);
  }

  function flipIndicator(container, state, previous, rect) {
    placeIndicator(container, state, previous);
    const token = {};
    state.flipToken = token;
    const glide = () => {
      if (state.flipToken !== token) return;
      cancelFlip(state);
      if (!isPrismActive() || container.isConnected === false) return;
      if (isMotionEnabled()) {
        glideIndicator(state, rect);
      } else {
        placeIndicator(container, state, rect);
        state.indicator.classList.remove('is-snapping');
      }
    };
    if (typeof global.requestAnimationFrame === 'function') {
      const id = global.requestAnimationFrame(glide);
      if (state.flipToken === token) state.rafId = id;
    } else if (setTimer) {
      const id = setTimer(glide, 16);
      if (state.flipToken === token) state.glideTimer = id;
    } else {
      glide();
    }
  }

  function syncContainer(container, { snap = false } = {}) {
    if (destroyed || !container) return;
    const type = getContainerType(container);
    if (!isPrismActive() || !type) {
      forgetContainer(container);
      return;
    }
    if (!doc?.createElement) return;

    const state = getContainerState(container, type);
    mountIndicator(container, state);
    const active = container.querySelector(type.item + '.is-active');
    if (state.active !== active) {
      unwatchSize(state.active);
      state.active = active;
      watchSize(active, container);
    }

    const visible = container.offsetWidth > 0 && container.offsetHeight > 0;
    if (!visible || !active || !(active.offsetWidth > 0 && active.offsetHeight > 0)) {
      cancelFlip(state);
      cancelSquash(state);
      state.indicator.classList.add('is-empty');
      state.rect = null;
      state.ready = false;
      rememberSegment(state.segment);
      if (visible && !active) container.setAttribute(readyAttribute, 'ready');
      else container.removeAttribute(readyAttribute);
      return;
    }

    const { offsetLeft: left, offsetTop: top, offsetWidth: width, offsetHeight: height } = active;
    const rect = { left, top, width, height };
    const canGlide = !snap && isMotionEnabled();
    let previousSegment;
    if (type.kind === 'seg') {
      const buttons = Array.from(container.querySelectorAll(type.item));
      const key = segmentSignature(container, buttons);
      const activeIndex = buttons.indexOf(active);
      const memory = segMemory.get(key);
      if (memory && memory.activeIndex !== activeIndex && Date.now() - memory.ts <= segmentMemoryTTL) {
        previousSegment = memory;
      }
      state.segment = { key, rect, activeIndex };
      rememberSegment(state.segment);
    }
    if (canGlide && state.ready && sameRect(state.rect, rect)) return;

    const wasReady = state.ready;
    state.ready = true;
    state.rect = rect;
    cancelFlip(state);
    state.indicator.classList.remove('is-empty');
    if (canGlide && wasReady) {
      glideIndicator(state, rect);
    } else if (canGlide && previousSegment) {
      flipIndicator(container, state, previousSegment, rect);
    } else {
      cancelSquash(state);
      placeIndicator(container, state, rect);
      state.indicator.classList.remove('is-snapping');
    }
  }

  function forgetDetached(container) {
    rememberSegment(containerStates.get(container)?.segment);
    forgetContainer(container);
  }

  function syncAll({ snap = false } = {}) {
    if (destroyed) return;
    if (isPrismActive()) {
      for (const container of trackedContainers) {
        if (container.isConnected === false) forgetDetached(container);
        else if (!getContainerType(container)) forgetContainer(container);
      }
      const containers = new Set();
      collectContainers(doc?.querySelectorAll ? doc : doc?.body, containers);
      for (const container of containers) syncContainer(container, { snap });
    } else {
      for (const container of trackedContainers) forgetContainer(container);
      segMemory.clear();
    }
    if (!isMotionEnabled()) {
      const finishes = Array.from(activeAnimations, (state) => state.handler);
      for (const finish of finishes) finish();
    }
  }

  function onBodyMutations(records) {
    if (destroyed || !isPrismActive()) return;
    const removed = new Set();
    const affected = new Set();
    for (const record of records) {
      const target = record.target;
      if (target?.classList?.contains(indicatorClass) || target?.classList?.contains(pillClass)) continue;
      const container = closestContainer(target);
      if (container) affected.add(container);
      for (const node of record.removedNodes ?? []) collectContainers(node, removed);
      for (const node of record.addedNodes ?? []) collectContainers(node, affected);
    }
    // A rebuild can remove the old toolbar and insert its replacement in the same batch.
    for (const container of removed) {
      if (!container.isConnected) {
        forgetDetached(container);
        affected.delete(container);
      }
    }
    for (const container of affected) {
      if (container.isConnected !== false) syncContainer(container);
    }
  }

  function onSegmentInput(event) {
    if (destroyed || !isPrismActive()) return;
    const container = closestContainer(event.target);
    rememberSegment(containerStates.get(container)?.segment);
  }

  function syncLayout() {
    syncAll({ snap: true });
  }

  function initBody() {
    doc.removeEventListener?.('DOMContentLoaded', initBody);
    if (destroyed) return;
    if (doc.body && typeof global.MutationObserver === 'function') {
      bodyObserver = new global.MutationObserver(onBodyMutations);
      bodyObserver.observe(doc.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class'],
      });
    }
    syncLayout();
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    rootObserver?.disconnect();
    bodyObserver?.disconnect();
    resizeObserver?.disconnect();
    doc?.removeEventListener?.('DOMContentLoaded', initBody);
    doc?.removeEventListener?.('pointerdown', onSegmentInput, true);
    doc?.removeEventListener?.('keydown', onSegmentInput, true);
    global.removeEventListener?.('resize', syncLayout);
    motionPreference?.removeEventListener?.('change', syncLayout);
    for (const container of trackedContainers) forgetContainer(container);
    for (const state of activeAnimations) state.cancel();
    segMemory.clear();
  }

  global.WSPrismMotion = {
    isPrismActive,
    isMotionEnabled,
    syncAll,
    syncContainer,
    openOverlay,
    closeOverlay,
    isOverlayOpen,
    triggerRefreshSpin,
    triggerPrismShimmer,
    popBadge,
    animatePaneSwitch,
    destroy,
  };

  if (doc) {
    if (docEl && typeof global.MutationObserver === 'function') {
      rootObserver = new global.MutationObserver(syncLayout);
      rootObserver.observe(docEl, {
        attributes: true,
        attributeFilter: ['data-skin', 'data-motion', 'data-prism-resolved'],
      });
    }
    if (typeof global.ResizeObserver === 'function') resizeObserver = new global.ResizeObserver(onObservedResize);
    doc.addEventListener?.('pointerdown', onSegmentInput, true);
    doc.addEventListener?.('keydown', onSegmentInput, true);
    global.addEventListener?.('resize', syncLayout);
    motionPreference?.addEventListener?.('change', syncLayout);
    if (doc.body) initBody();
    else doc.addEventListener?.('DOMContentLoaded', initBody);
  }
})(typeof window === 'undefined' ? globalThis : window);
