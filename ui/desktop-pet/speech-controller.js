// Content-sized head-top speech. The native host can provide temporary space
// without scaling the character; text stays selectable and is never HTML.
export const SPEECH_EDGE_PAD = 6;
export const SPEECH_FADE_MS = 300;

const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, min, max) => Math.max(min, Math.min(value, Math.max(min, max)));

export function petSpeechLayout({ width, height, anchor, bubbleWidth = 137, bubbleHeight = 40, contentLength = 0, availableWidth, availableHeight }) {
  const w = Math.max(1, finite(width, 360));
  const h = Math.max(1, finite(height, 480));
  const pad = SPEECH_EDGE_PAD;
  const capacityWidth = Math.max(1, finite(availableWidth, w - pad * 2));
  const maxHeight = Math.max(1, finite(availableHeight, h - pad * 2));
  // Start compact, increasing both dimensions with the actual amount of text.
  // DOM measurements below widen further if the reply needs more vertical room.
  const preferredWidth = Math.max(137, Math.min(420, Math.ceil(Math.sqrt(Math.max(1, contentLength) * 13 * 20.8 * 1.6) + 42)));
  const maxWidth = Math.min(preferredWidth, capacityWidth);
  const measuredWidth = Math.max(1, finite(bubbleWidth, maxWidth));
  const measuredHeight = Math.max(1, finite(bubbleHeight, 40));
  const center = anchor ? finite(anchor.left, w / 2) + Math.max(0, finite(anchor.width, 0)) / 2 : w / 2;
  const headTop = anchor ? finite(anchor.top, h * .2) : h * .2;
  const positionedCenter = clamp(center, measuredWidth / 2 + pad, w - measuredWidth / 2 - pad);
  return {
    maxWidth, maxHeight, capacityWidth,
    center: positionedCenter,
    tail: clamp(center - (positionedCenter - measuredWidth / 2), 16, measuredWidth - 16),
    top: clamp(headTop - measuredHeight - pad, pad, h - measuredHeight - pad),
  };
}

export function createPetSpeechController({
  speech, text, close: closeButton, observe, pet,
  getAnchor, getViewport, requestSpace, detached = false,
  setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now,
  document: ownerDocument = speech?.ownerDocument ?? globalThis.document,
  window: ownerWindow = ownerDocument?.defaultView ?? globalThis.window,
  reducedMotion = () => Boolean(ownerWindow?.matchMedia?.('(prefers-reduced-motion: reduce)').matches),
} = {}) {
  if (!speech || !text) throw new Error('Speech controller requires a bubble and text element');
  let dismissTimer = null;
  let fadeTimer = null;
  let deadline = 0;
  let remaining = 0;
  let hovered = false;
  let focused = false;
  let selected = false;
  let closing = false;
  let destroyed = false;
  let anchor = null;
  let contentLength = 0;
  let requestedSize = '';
  const listeners = [];

  function listen(target, event, fn) {
    target?.addEventListener?.(event, fn);
    listeners.push(() => target?.removeEventListener?.(event, fn));
  }
  function clearDismiss() { if (dismissTimer !== null) clearTimer(dismissTimer); dismissTimer = null; }
  function clearFade() { if (fadeTimer !== null) clearTimer(fadeTimer); fadeTimer = null; }
  function pause() {
    if (dismissTimer === null) return;
    remaining = Math.max(0, deadline - now());
    clearDismiss();
  }
  function resume(grace = false) {
    if (destroyed || speech.hidden || closing || hovered || focused || selected || dismissTimer !== null) return;
    if (grace) remaining = Math.max(3000, remaining);
    deadline = now() + remaining;
    dismissTimer = setTimer(() => { dismissTimer = null; hide(); }, remaining);
  }
  function resizeSpace(width, height) {
    const value = { width: Math.ceil(width), height: Math.ceil(height) };
    const key = JSON.stringify(value);
    if (key === requestedSize || typeof requestSpace !== 'function') return;
    requestedSize = key;
    try { Promise.resolve(requestSpace(value)).catch(() => { if (requestedSize === key) requestedSize = ''; }); } catch { requestedSize = ''; }
  }
  function layout() {
    if (destroyed || speech.hidden) return;
    let bounds = anchor;
    if (typeof getAnchor === 'function') { try { bounds = getAnchor() || bounds; } catch { /* Model may still be loading. */ } }
    const viewport = getViewport?.() || { width: ownerWindow?.innerWidth || pet?.clientWidth || 360, height: ownerWindow?.innerHeight || pet?.clientHeight || 480 };
    const dimensions = { ...viewport, anchor: bounds, contentLength, availableWidth: viewport.speechLimit?.width, availableHeight: viewport.speechLimit?.height };
    const limits = petSpeechLayout(dimensions);
    speech.style.maxWidth = `${limits.maxWidth}px`;
    speech.style.width = 'max-content';
    speech.style.height = 'auto';
    speech.style.maxHeight = 'none';
    text.style.height = 'auto';
    text.style.maxHeight = 'none';
    text.style.columnCount = 'auto';
    text.style.columnGap = 'normal';
    text.style.columnFill = 'balance';
    text.style.whiteSpace = 'pre-wrap';
    text.style.lineHeight = 'inherit';
    // Measure only on a new reply, resize or changed model layout, never on each
    // animation frame. This also establishes the opacity transition's start.
    let measuredWidth = speech.offsetWidth || limits.maxWidth;
    let measuredHeight = speech.offsetHeight || 40;
    let candidate = limits.maxWidth;
    while (measuredHeight > limits.maxHeight && candidate < limits.capacityWidth) {
      candidate = Math.min(limits.capacityWidth, Math.max(candidate + 48, Math.ceil(candidate * 1.3)));
      speech.style.maxWidth = `${candidate}px`;
      measuredWidth = speech.offsetWidth || candidate;
      measuredHeight = speech.offsetHeight || measuredHeight;
    }
    // Hard line breaks cannot be made shorter just by widening the bubble.
    // Flow exceptionally tall replies into columns, preserving every character
    // and line break at the normal font size, without a scrollable viewport.
    if (measuredHeight > limits.maxHeight && limits.capacityWidth > 42) {
      const textHeight = Math.max(1, Math.floor(limits.maxHeight - 20));
      const maxColumns = Math.max(1, Math.floor((limits.capacityWidth - 30) / 25));
      let columns = Math.min(maxColumns, Math.max(2, Math.ceil((measuredHeight - 20) / textHeight)));
      speech.style.width = `${limits.capacityWidth}px`;
      text.style.height = `${textHeight}px`;
      text.style.columnFill = 'auto';
      text.style.columnGap = '12px';
      text.style.columnCount = String(columns);
      while (text.scrollWidth > text.clientWidth + 1 && columns < maxColumns) text.style.columnCount = String(++columns);
      if (text.scrollWidth > text.clientWidth + 1 || text.scrollHeight > text.clientHeight + 1) {
        // Thousands of blank/forced lines contain more vertical whitespace than
        // any screen can show. Compact that whitespace as a last resort while
        // preserving the complete original textContent for selection/copying.
        text.style.columnCount = 'auto';
        text.style.columnFill = 'balance';
        text.style.whiteSpace = 'normal';
        text.style.height = 'auto';
        speech.style.width = 'max-content';
        if (speech.offsetHeight > limits.maxHeight) text.style.lineHeight = '1.35';
      }
      measuredWidth = speech.offsetWidth || limits.capacityWidth;
      measuredHeight = speech.offsetHeight || limits.maxHeight;
    }
    const position = petSpeechLayout({ ...dimensions, bubbleWidth: measuredWidth, bubbleHeight: measuredHeight });
    speech.style.transform = detached ? 'none' : `translateX(calc(-50% + ${position.center}px))`;
    speech.style.left = detached ? '6px' : '0px';
    speech.style.top = detached ? '6px' : `${position.top}px`;
    speech.style['--speech-tail-x'] = `${position.tail}px`;
    speech.style.setProperty?.('--speech-tail-x', `${position.tail}px`);
    resizeSpace(measuredWidth, measuredHeight);
  }
  function setAnchor(bounds) {
    const next = bounds ? { left: finite(bounds.left ?? bounds.x, 0), top: finite(bounds.top ?? bounds.y, 0), width: Math.max(0, finite(bounds.width, 0)), height: Math.max(0, finite(bounds.height, 0)) } : null;
    if (JSON.stringify(next) === JSON.stringify(anchor)) return;
    anchor = next;
    layout();
  }
  function restoreFocus() {
    if (!speech.contains?.(ownerDocument?.activeElement)) return;
    const target = observe && !observe.hidden && !observe.disabled ? observe : pet;
    target?.focus?.({ preventScroll: true });
  }
  function hide(shouldRestoreFocus = false) {
    if (destroyed) return;
    clearDismiss();
    remaining = 0;
    if (speech.hidden || closing) { if (shouldRestoreFocus) restoreFocus(); return; }
    closing = true;
    if (shouldRestoreFocus) restoreFocus();
    speech.classList.remove('show');
    speech.classList.add('is-closing');
    speech.setAttribute('aria-hidden', 'true');
    speech.inert = true;
    const finish = () => {
      fadeTimer = null;
      speech.hidden = true;
      speech.classList.remove('is-closing');
      closing = false;
      resizeSpace(0, 0);
    };
    if (typeof reducedMotion === 'function' ? reducedMotion() : reducedMotion) finish();
    else fadeTimer = setTimer(finish, SPEECH_FADE_MS);
  }
  function show(value) {
    if (destroyed) return;
    const content = Array.from(String(value ?? '').trim()).slice(0, 1500).join('');
    if (!content) return;
    clearDismiss();
    clearFade();
    closing = false;
    contentLength = Array.from(content).length;
    requestedSize = '';
    text.textContent = content;
    text.scrollTop = 0;
    speech.classList.remove('show', 'is-closing');
    speech.hidden = false;
    speech.inert = false;
    speech.removeAttribute('aria-hidden');
    hovered = Boolean(speech.matches?.(':hover'));
    focused = Boolean(speech.contains?.(ownerDocument?.activeElement));
    selected = false;
    layout();
    speech.classList.add('show');
    remaining = Math.min(45000, Math.max(6000, contentLength * 120));
    resume();
  }
  function destroy() {
    if (destroyed) return;
    clearDismiss();
    clearFade();
    for (const remove of listeners) remove();
    speech.hidden = true;
    speech.classList.remove('show', 'is-closing');
    speech.setAttribute('aria-hidden', 'true');
    resizeSpace(0, 0);
    destroyed = true;
  }

  listen(closeButton, 'click', () => hide(true));
  listen(speech, 'pointerenter', () => { hovered = true; pause(); });
  listen(speech, 'pointerleave', () => { hovered = false; resume(true); });
  listen(speech, 'focusin', () => { focused = true; pause(); });
  listen(speech, 'focusout', (event) => { if (speech.contains?.(event.relatedTarget)) return; focused = false; resume(true); });
  listen(speech, 'keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    hide(true);
  });
  listen(ownerWindow, 'resize', layout);
  listen(ownerDocument, 'selectionchange', () => {
    const selection = ownerDocument?.getSelection?.();
    selected = Boolean(selection && !selection.isCollapsed && (speech.contains?.(selection.anchorNode) || speech.contains?.(selection.focusNode)));
    if (selected) pause(); else resume(true);
  });
  ownerDocument?.fonts?.ready?.then(() => { if (!destroyed) layout(); }).catch(() => {});
  return { show, close: hide, setAnchor, layout, destroy };
}

// The character renderer only publishes content and its model-space anchor.
// It owns neither a reply DOM surface nor a native frame resize.
export function createRemotePetSpeechController({ api } = {}) {
  let current = '';
  let anchorKey = '';
  const report = (error) => api?.reportError?.(`桌宠回复显示失败：${error?.message || error}`);
  return {
    isCurrent: (text) => current === text,
    show(text) { current = String(text); try { Promise.resolve(api?.showSpeech?.(current)).catch(report); } catch (error) { report(error); } },
    setAnchor(value) { const key = JSON.stringify(value); if (key !== anchorKey) { anchorKey = key; api?.setSpeechAnchor?.(value); } },
    layout() {},
    close() { current = ''; api?.closeSpeech?.(); },
    destroy() { current = ''; api?.closeSpeech?.(); },
  };
}
