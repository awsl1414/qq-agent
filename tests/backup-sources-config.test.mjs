import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-backup-config-'));
process.env.QQ_AGENT_DATA_DIR = root;
const { CONFIG_FILE, DEFAULT_CONFIG } = await import('../src/config.js');
const { CONFIG_FIELD_CATEGORIES, createConfigFieldSources } = await import('../src/backup/sources/config-fields.js');
after(() => fs.rmSync(root, { recursive: true, force: true }));

function fixture() {
  const config = structuredClone(DEFAULT_CONFIG);
  Object.assign(config, {
    persona: { ...config.persona, botName: '测试助手', roleText: '耐心回答', customRules: '简洁' },
    personaByChat: { '10001': { roleText: '会话独立人设', participation: 'low' } },
    personaUnified: false,
    customPersonas: [{ id: 'custom-one', name: '自定义人设', text: '自定义内容' }],
    allow: { groups: ['10001'], private: ['20001'] },
    deny: { groups: ['10002'], private: ['20002'] },
    blocklist: { '10001': ['30001'] },
    globalBlocklist: ['30002'],
    communityExemptions: ['30003'],
    tools: { ...config.tools, overrides: { send_message: false }, crossChatSend: true },
    extensions: { hotReload: false },
    skills: {
      'account-pool': {
        enabled: true,
        strategy: 'weighted',
        accounts: [{ id: 'private-pool-account', baseUrl: 'https://private-pool.invalid/v1', apiKey: 'sk-pool-secret', enabled: true, weight: 1 }]
      },
      'thinking-adapters': { enabled: true },
      'web-search': { enabled: false }
    },
    api: { ...config.api, apiKey: 'sk-main-secret' },
    dshProviderKeys: { deepseek: 'sk-provider-secret' },
    providers: [{ id: 'deepseek', baseUrl: 'https://provider.invalid/v1', apiKey: 'sk-inline-secret' }],
    protocol: { ...config.protocol, accessToken: 'private-protocol-token', httpAccessToken: 'private-http-token' },
    server: { ...config.server, token: 'private-server-token' },
    doctorApi: { ...config.doctorApi, apiKey: 'sk-doctor-secret' },
    devApi: { ...config.devApi, apiKey: 'sk-dev-secret' },
    backup: { targets: [{ id: 'private-target', credentials: 'private-backup-cipher' }] },
    update: { feedUrl: 'https://private-update.invalid/feed' }
  });
  config.webSearch.deepseek.apiKey = 'sk-search-secret';
  return config;
}

function writeConfig(config) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

function collect(key) {
  return createConfigFieldSources().sources.find((source) => source.key === key).collect();
}

function readFields(key) {
  const entries = collect(key);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, `config-fields/${key}.json`);
  assert.ok(Buffer.isBuffer(entries[0].data));
  return JSON.parse(entries[0].data.toString('utf8'));
}

test('config categories expose the four synchronous sources with default selection', () => {
  const { sources } = createConfigFieldSources();
  assert.deepEqual(CONFIG_FIELD_CATEGORIES.map((source) => source.key), ['persona', 'customPersonas', 'lists', 'configSafe']);
  assert.deepEqual(sources.map(({ collect: ignored, ...metadata }) => metadata), CONFIG_FIELD_CATEGORIES);
  assert.ok(sources.every((source) => source.defaultOn === true && typeof source.collect === 'function'));
});

test('persona extracts only global, per-chat and unified persona fields, preserving false', () => {
  const config = fixture();
  writeConfig(config);
  assert.deepEqual(readFields('persona'), {
    persona: config.persona, personaByChat: config.personaByChat, personaUnified: false
  });
});

test('customPersonas extracts the array in a mergeable configuration object', () => {
  const config = fixture();
  writeConfig(config);
  assert.deepEqual(readFields('customPersonas'), { customPersonas: config.customPersonas });
});

test('lists extracts all five list fields without other configuration', () => {
  const config = fixture();
  writeConfig(config);
  assert.deepEqual(readFields('lists'), {
    allow: config.allow, deny: config.deny, blocklist: config.blocklist,
    globalBlocklist: config.globalBlocklist, communityExemptions: config.communityExemptions
  });
});

test('configSafe preserves safe tool and extension settings and removes all sensitive top-level fields', () => {
  const config = fixture();
  writeConfig(config);
  const safe = readFields('configSafe');
  assert.deepEqual(safe, {
    tools: config.tools, extensions: config.extensions,
    skills: { 'thinking-adapters': { enabled: true }, 'web-search': { enabled: false } }
  });
  for (const key of ['api', 'dshProviderKeys', 'providers', 'protocol', 'server', 'doctorApi', 'devApi', 'backup', 'update']) {
    assert.equal(Object.hasOwn(safe, key), false, key);
  }
});

test('real config structure produces configSafe with no sk- strings or account-pool accounts', () => {
  const config = fixture();
  writeConfig(config);
  const [entry] = collect('configSafe');
  const serialized = entry.data.toString('utf8');
  assert.doesNotMatch(serialized, /"sk-/);
  assert.equal(serialized.includes('sk-'), false);
  assert.equal(Object.hasOwn(JSON.parse(serialized).skills, 'account-pool'), false);
  for (const account of config.skills['account-pool'].accounts) {
    assert.equal(serialized.includes(account.id), false);
    assert.equal(serialized.includes(account.baseUrl), false);
    assert.equal(serialized.includes(account.apiKey), false);
  }
});

test('all sources leave original config bytes and directory contents unchanged', () => {
  const config = fixture();
  const original = `\uFEFF${JSON.stringify(config, null, 2)}\n`;
  fs.writeFileSync(CONFIG_FILE, original);
  const before = fs.readdirSync(root);
  for (const source of createConfigFieldSources().sources) assert.equal(source.collect().length, 1);
  assert.equal(fs.readFileSync(CONFIG_FILE, 'utf8'), original);
  assert.deepEqual(fs.readdirSync(root), before);
});

test('missing config returns empty arrays and does not create a default file', () => {
  fs.rmSync(CONFIG_FILE, { force: true });
  for (const source of createConfigFieldSources().sources) assert.deepEqual(source.collect(), []);
  assert.equal(fs.existsSync(CONFIG_FILE), false);
});

test('damaged or non-object config returns empty arrays without changing the file', () => {
  for (const original of ['{broken-json', '', 'null', '[]', 'false', '"text"']) {
    fs.writeFileSync(CONFIG_FILE, original);
    const before = fs.readdirSync(root);
    for (const source of createConfigFieldSources().sources) assert.deepEqual(source.collect(), []);
    assert.equal(fs.readFileSync(CONFIG_FILE, 'utf8'), original);
    assert.deepEqual(fs.readdirSync(root), before);
  }
});

test('absent fields are empty categories and explicit empty collections are preserved', () => {
  writeConfig({});
  for (const source of createConfigFieldSources().sources) assert.deepEqual(source.collect(), []);
  writeConfig({ personaUnified: false, customPersonas: [], allow: { groups: [], private: [] }, skills: {} });
  assert.deepEqual(readFields('persona'), { personaUnified: false });
  assert.deepEqual(readFields('customPersonas'), { customPersonas: [] });
  assert.deepEqual(readFields('lists'), { allow: { groups: [], private: [] } });
  assert.deepEqual(readFields('configSafe'), { skills: {} });
});

test('invalid customPersonas and skills shapes are not exported', () => {
  for (const value of [null, false, 'sk-invalid-secret', []]) {
    writeConfig({ customPersonas: value, skills: value });
    assert.deepEqual(collect('configSafe'), []);
    if (!Array.isArray(value)) assert.deepEqual(collect('customPersonas'), []);
  }
});

test('collection reads the current file and propagates access errors instead of hiding incomplete backups', () => {
  const source = createConfigFieldSources().sources.find((item) => item.key === 'persona');
  writeConfig({ personaUnified: true });
  assert.equal(JSON.parse(source.collect()[0].data).personaUnified, true);
  writeConfig({ personaUnified: false });
  assert.equal(JSON.parse(source.collect()[0].data).personaUnified, false);
  const originalRead = fs.readFileSync;
  fs.readFileSync = (file, ...args) => {
    if (file === CONFIG_FILE) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    return originalRead(file, ...args);
  };
  try { assert.throws(() => source.collect(), { code: 'EACCES' }); }
  finally { fs.readFileSync = originalRead; }
});
