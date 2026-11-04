import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../ui/app/03-connection.js', import.meta.url), 'utf8');

function setup(api) {
  const control = (value = '') => ({
    value, type: 'password', isConnected: true, disabled: false,
    textContent: '显示', events: {}, attributes: {},
    addEventListener(name, handler) { this.events[name] = handler; },
    setAttribute(name, value) { this.attributes[name] = value; }
  });
  const input = control('******');
  const button = control();
  const hint = control();
  const elements = { '#conn-wstoken': input, '#conn-wstoken-toggle': button, '#conn-save-hint': hint };
  const context = vm.createContext({ $: (id) => elements[id], $$: () => [], api });
  vm.runInContext(source, context);
  vm.runInContext('bindConnectionPage(null, {}, {})', context);
  return { input, button, hint, click: () => button.events.click(), edit: (value) => {
    input.value = value;
    input.events.input();
  } };
}

test('connection token reveal changes type and hide masks saved token without a request', async () => {
  let requests = 0;
  const ui = setup(async () => { requests++; return { token: 'saved-token' }; });
  await ui.click();
  assert.equal(ui.input.type, 'text');
  assert.equal(ui.input.value, 'saved-token');
  assert.equal(ui.button.textContent, '隐藏');
  assert.equal(ui.button.attributes['aria-label'], '隐藏 WebSocket 令牌');
  await ui.click();
  assert.equal(ui.input.type, 'password');
  assert.equal(ui.input.value, '******');
  assert.equal(requests, 1);
});

test('connection token toggle preserves new input and intentional clearing', async () => {
  const ui = setup(async () => { throw new Error('edited values must not request saved tokens'); });
  for (const value of ['new-token', '']) {
    ui.edit(value);
    await ui.click();
    assert.equal(ui.input.type, 'text');
    assert.equal(ui.input.value, value);
    await ui.click();
    assert.equal(ui.input.type, 'password');
    assert.equal(ui.input.value, value);
  }
});

test('connection token response cannot replace edits made while the request is pending', async () => {
  let resolve;
  const ui = setup(() => new Promise((done) => { resolve = done; }));
  const pending = ui.click();
  assert.equal(ui.button.disabled, true);
  ui.edit('typed-during-request');
  resolve({ token: 'old-token' });
  await pending;
  assert.equal(ui.input.value, 'typed-during-request');
  assert.equal(ui.input.type, 'text');
  assert.equal(ui.button.disabled, false);
});

test('empty saved tokens stay empty and request failure leaves a usable masked field', async () => {
  const empty = setup(async () => ({ token: '' }));
  await empty.click();
  await empty.click();
  assert.equal(empty.input.value, '');
  const failed = setup(async () => { throw new Error('unavailable'); });
  await failed.click();
  assert.equal(failed.input.type, 'password');
  assert.equal(failed.input.value, '******');
  assert.equal(failed.button.textContent, '显示');
  assert.equal(failed.button.disabled, false);
  assert.match(failed.hint.textContent, /读取令牌失败：unavailable/);
});
