/* Hold-to-confirm interaction adapted from UI Moments (https://github.com/guanmo-ai/ui-moments), Copyright (c) 2026 guanmo-ai, MIT License. */
(function (global) {
  'use strict';

  function bindHoldConfirm({
    button,
    hintEl = null,
    duration = 1100,
    tapThreshold = 240,
    hintDuration = 1400,
    doneDuration = 720,
    hintText = '长按以关闭全部',
    doneText = '',
    doneAriaLabel = '已关闭全部标签页',
    onBeforeConfirm = null,
    onConfirm = null,
    onDoneEnd = null,
  } = {}) {
    const doc = global.document ?? globalThis.document;
    const clock = global.performance ?? globalThis.performance;
    const motionQuery = global.matchMedia?.('(prefers-reduced-motion: reduce)');
    const setTimer = global.setTimeout?.bind(global) ?? globalThis.setTimeout;
    const clearTimer = global.clearTimeout?.bind(global) ?? globalThis.clearTimeout;
    const originalAriaLabel = button?.getAttribute?.('aria-label') ?? null;

    let fillEl = button?.querySelector?.('.ws-hold-fill');
    let holding = false;
    let done = false;
    let confirming = false;
    let destroyed = false;
    let generation = 0;
    let startedAt = 0;
    let activeSource = null;
    let activePointerId = null;
    let lastPointerType = '';
    let holdTimer = null;
    let hintTimer = null;
    let doneTimer = null;
    let springFrame = null;
    let progressAnim = null;
    let trembleAnim = null;

    const now = () => clock?.now?.() ?? Date.now();
    const isMotionReduced = () =>
      doc?.documentElement?.dataset?.motion === 'reduced' || Boolean(motionQuery?.matches);
    const canStart = () => !destroyed && button && !button.disabled && !holding && !done && !confirming;
    const clampScale = (scale) => Math.max(0, Math.min(1, scale));

    function setFillScale(scale) {
      if (fillEl?.style) fillEl.style.scale = `${scale} 1`;
    }

    function readFillScale() {
      if (!fillEl) return 0;
      const scale = global.getComputedStyle?.(fillEl)?.scale || fillEl.style?.scale;
      return clampScale(Number.parseFloat(scale) || 0);
    }

    function cancelAnimations() {
      progressAnim?.cancel();
      trembleAnim?.cancel();
      progressAnim = null;
      trembleAnim = null;
    }

    function cancelSpring() {
      if (springFrame !== null) global.cancelAnimationFrame?.(springFrame);
      springFrame = null;
    }

    function springResetFill(start) {
      if (!fillEl?.style) return;
      if (isMotionReduced() || typeof global.requestAnimationFrame !== 'function') {
        setFillScale(0);
        return;
      }

      const springGeneration = generation;
      const releasedAt = now();
      setFillScale(start);

      function step(frameTime) {
        if (springGeneration !== generation) return;
        const time = clock?.now && Number.isFinite(frameTime) ? frameTime : now();
        const t = Math.max(0, (time - releasedAt) / 1000);
        if (t >= 0.48) {
          springFrame = null;
          setFillScale(0);
          return;
        }

        const decay = Math.exp(-15 * t);
        const value = decay * (start * Math.cos(13 * t) + ((15 * start) / 13) * Math.sin(13 * t));
        setFillScale(clampScale(value));
        springFrame = global.requestAnimationFrame(step);
      }

      springFrame = global.requestAnimationFrame(step);
    }

    function clearHint() {
      if (hintTimer !== null) clearTimer(hintTimer);
      hintTimer = null;
      hintEl?.removeAttribute?.('data-show');
    }

    function say(text) {
      if (!hintEl) return;
      if (hintTimer !== null) clearTimer(hintTimer);
      hintEl.textContent = text;
      hintEl.setAttribute('data-show', '');
      hintTimer = setTimer(clearHint, hintDuration);
    }

    function start(source) {
      if (!canStart()) return;
      generation++;
      clearHint();
      cancelSpring();
      holding = true;
      activeSource = source;
      startedAt = now();
      button.setAttribute('data-holding', '');
      fillEl = button.querySelector?.('.ws-hold-fill');
      const labelEl = button.querySelector?.('.ws-hold-label');

      if (!isMotionReduced() && typeof fillEl?.animate === 'function') {
        progressAnim = fillEl.animate(
          [{ scale: fillEl.style?.scale || '0 1' }, { scale: '1 1' }],
          { duration, easing: 'cubic-bezier(0.45, 0, 0.6, 1)', fill: 'forwards' },
        );
        if (typeof labelEl?.animate === 'function') {
          trembleAnim = labelEl.animate(
            [{ translate: '0 0' }, { translate: '-0.6px 0' }, { translate: '0.6px 0' }, { translate: '0 0' }],
            { duration: 110, iterations: Infinity, delay: duration * 0.55 },
          );
        }
      } else {
        setFillScale(1);
      }
      holdTimer = setTimer(finishHold, duration);
    }

    function stopHold() {
      holding = false;
      activeSource = null;
      button?.removeAttribute('data-holding');
      if (holdTimer !== null) clearTimer(holdTimer);
      holdTimer = null;

      const pointerId = activePointerId;
      activePointerId = null;
      if (pointerId !== null) {
        try { button.releasePointerCapture?.(pointerId); } catch {}
      }
    }

    function release() {
      if (!holding) return;
      stopHold();
      // Read the animated scale before canceling the animation that supplies it.
      const currentScale = readFillScale();
      cancelAnimations();
      springResetFill(currentScale);
      if (now() - startedAt < tapThreshold && hintText) say(hintText);
    }

    function clearDone() {
      done = false;
      button?.removeAttribute('data-done');
      if (originalAriaLabel === null) button?.removeAttribute('aria-label');
      else button.setAttribute('aria-label', originalAriaLabel);
      setFillScale(0);
    }

    async function finishHold() {
      if (!holding || destroyed) return;
      const attempt = generation;
      holdTimer = null;
      stopHold();
      cancelAnimations();

      if (typeof onBeforeConfirm === 'function') {
        confirming = true;
        let allowed;
        try {
          allowed = await onBeforeConfirm();
        } catch {
          allowed = false;
        } finally {
          if (attempt === generation) confirming = false;
        }
        if (destroyed || attempt !== generation) return;
        if (allowed === false) {
          springResetFill(1);
          return;
        }
      }

      done = true;
      setFillScale(1);
      button.setAttribute('data-done', '');
      if (doneAriaLabel) button.setAttribute('aria-label', doneAriaLabel);
      if (lastPointerType === 'touch') {
        try { global.navigator?.vibrate?.(10); } catch {}
      }
      if (doneText) say(doneText);

      try { await onConfirm?.(); } catch {}
      if (destroyed || attempt !== generation) return;
      doneTimer = setTimer(() => {
        doneTimer = null;
        clearDone();
        onDoneEnd?.();
      }, doneDuration);
    }

    function reset() {
      // Invalidate springs and pending confirmation callbacks for the previous hold.
      generation++;
      confirming = false;
      stopHold();
      cancelAnimations();
      cancelSpring();
      clearHint();
      if (doneTimer !== null) clearTimer(doneTimer);
      doneTimer = null;
      clearDone();
    }

    function onPointerDown(event) {
      if (event.button !== 0 || event.isPrimary === false || event.ctrlKey || !canStart()) return;
      lastPointerType = event.pointerType || '';
      activePointerId = event.pointerId ?? null;
      button.focus?.({ preventScroll: true });
      try { button.setPointerCapture?.(event.pointerId); } catch {}
      if (event.pointerType === 'mouse') event.preventDefault?.();
      start('pointer');
    }

    function isActivePointer(pointerId) {
      return activeSource === 'pointer' && (activePointerId === null || pointerId === activePointerId);
    }

    function onPointerEnd(event) {
      if (isActivePointer(event.pointerId)) release();
    }

    function onLostPointerCapture(event) {
      if (!isActivePointer(event.pointerId ?? activePointerId)) return;
      activePointerId = null;
      release();
    }

    function onPointerMove(event) {
      if (isActivePointer(event.pointerId ?? activePointerId) && event.pointerType === 'mouse' &&
          typeof event.buttons === 'number' && (event.buttons & 1) === 0) release();
    }

    const isHoldKey = (key) => key === ' ' || key === 'Enter';
    const preventDefault = (event) => event.preventDefault?.();

    function onKeyDown(event) {
      if (!isHoldKey(event.key) || button.disabled) return;
      preventDefault(event);
      if (event.repeat || !canStart()) return;
      lastPointerType = 'keyboard';
      start('keyboard');
    }

    function onKeyUp(event) {
      if (!isHoldKey(event.key)) return;
      preventDefault(event);
      if (activeSource === 'keyboard') release();
    }

    function onContextMenu(event) {
      preventDefault(event);
      release();
    }

    function onVisibilityChange() {
      if (doc.hidden) release();
    }

    const listeners = [
      [button, 'pointerdown', onPointerDown],
      [button, 'pointerup', onPointerEnd],
      [button, 'pointercancel', onPointerEnd],
      [button, 'lostpointercapture', onLostPointerCapture],
      [button, 'pointermove', onPointerMove],
      [button, 'click', preventDefault],
      [button, 'contextmenu', onContextMenu],
      [button, 'keydown', onKeyDown],
      [button, 'keyup', onKeyUp],
      [button, 'blur', release],
      [global, 'blur', release],
      [doc, 'visibilitychange', onVisibilityChange],
    ];
    for (const [target, type, listener] of listeners) target?.addEventListener?.(type, listener);

    return {
      isHolding: () => holding,
      isDone: () => done,
      cancel: reset,
      reset,
      destroy() {
        if (destroyed) return;
        destroyed = true;
        reset();
        for (const [target, type, listener] of listeners) target?.removeEventListener?.(type, listener);
      },
    };
  }

  global.WSModules = global.WSModules || {};
  global.WSModules.bindHoldConfirm = bindHoldConfirm;
})(typeof window === 'undefined' ? globalThis : window);
