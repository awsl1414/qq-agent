import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Exercise the classic-script focus manager itself; no second implementation.
const source = fs.readFileSync(new URL('../ui/app/08-modals.js', import.meta.url), 'utf8');
const start = source.indexOf('const __focusTraps =');
const end = source.indexOf('function closeModelModal(', start);
function fixture() {
  const listeners = {};
  const document = {
    body: { children: [] }, activeElement: null,
    querySelector: () => null,
    addEventListener: (name, fn) => { listeners[name] = fn; }
  };
  const api = vm.runInNewContext(`${source.slice(start, end)}
    ({ registerFocusTrap, unregisterFocusTrap, top: __topModalOverlay })`, {
    document,
    getComputedStyle: (element) => ({ zIndex: String(element.z) }),
    MutationObserver: class { observe() {} }
  });
  function overlay(z = 900) {
    const layer = {
      z, closing: false, visible: true,
      classList: { contains: (name) => name === 'closing' && layer.closing },
      getClientRects: () => layer.visible ? [{}] : [],
      contains: (element) => layer.controls.includes(element),
      querySelectorAll: () => layer.controls,
      controls: [0, 1].map(() => ({ offsetParent: {}, focus() { document.activeElement = this; } }))
    };
    document.body.children.push(layer);
    api.registerFocusTrap(layer);
    return layer;
  }
  function tab(shiftKey = false) {
    let prevented = false;
    listeners.keydown({ key: 'Tab', shiftKey, preventDefault() { prevented = true; } });
    return prevented;
  }
  return { document, api, overlay, tab, listeners };
}

test('registered generic modal wraps Tab and Shift+Tab without model-modal class', () => {
  const f = fixture();
  const layer = f.overlay();
  layer.controls[1].focus();
  assert.equal(f.tab(), true);
  assert.equal(f.document.activeElement, layer.controls[0]);
  assert.equal(f.tab(true), true);
  assert.equal(f.document.activeElement, layer.controls[1]);
});

test('top modal uses z-index, then DOM order, and excludes closing or hidden layers', () => {
  const f = fixture();
  const high = f.overlay(910);
  const low = f.overlay(900);
  assert.equal(f.api.top(), high);
  const sibling = f.overlay(910);
  assert.equal(f.api.top(), sibling);
  sibling.closing = true;
  assert.equal(f.api.top(), high);
  high.visible = false;
  assert.equal(f.api.top(), low);
});

test('focus escaping a registered overlay returns inside; unregister releases it', () => {
  const f = fixture();
  const layer = f.overlay();
  const outside = {};
  f.document.activeElement = outside;
  f.listeners.focusin({ target: outside });
  assert.equal(f.document.activeElement, layer.controls[0]);
  f.api.unregisterFocusTrap(layer);
  f.document.activeElement = outside;
  f.listeners.focusin({ target: outside });
  assert.equal(f.document.activeElement, outside);
});
