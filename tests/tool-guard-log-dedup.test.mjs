// 同一条日志不能在终端出现两次。
//
// 背景：logger 默认 mirrorConsole（`#write` 自己镜像到 console）。护栏与 Electron
// 主进程又各自补了一次 `console.error` / `console.log`，实测终端上每次失败两行、
// 还多套一层 `[guard] [guard]`，排障时容易误认为失败了两次。
//
// 本测试钉住「一次事件 = 一行」：既不许丢日志（落盘与 console 都要有），
// 也不许重复。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

import { logger } from '../src/logger.js';
import { guardToolExecute, resetBreakers, TOOL_GUARD } from '../src/tool-guard.js';

/** 临时接管 console.*，收集本次调用产生的行。 */
async function captureConsole(fn) {
  const lines = [];
  const origin = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...a) => lines.push(['log', a.join(' ')]);
  console.warn = (...a) => lines.push(['warn', a.join(' ')]);
  console.error = (...a) => lines.push(['error', a.join(' ')]);
  try {
    await fn();
  } finally {
    console.log = origin.log;
    console.warn = origin.warn;
    console.error = origin.error;
  }
  return lines;
}

test('tool-guard 熔断：每次失败只在终端产生 1 行，且不带重复的 [guard] 前缀', async () => {
  const prevMirror = logger.mirrorConsole;
  logger.mirrorConsole = true;   // 显式钉住默认行为，防止测试环境里被别的开关影响
  const logged = [];
  const off = logger.onLog((e) => logged.push(e));
  resetBreakers();
  try {
    const boom = guardToolExecute(async () => { throw new Error('kaboom'); }, 'demo', 'boom');
    const lines = await captureConsole(async () => {
      for (let i = 0; i < TOOL_GUARD.failThreshold; i++) await boom({}, {});
    });

    // 5 次失败 + 1 次熔断提示 = 6 条事件 = 6 行；修复前是 12 行
    assert.equal(logged.length, TOOL_GUARD.failThreshold + 1);
    assert.equal(lines.length, logged.length, `终端 ${lines.length} 行 vs 落盘 ${logged.length} 条：${JSON.stringify(lines)}`);
    assert.ok(lines.every(([, text]) => !text.includes('[guard] [guard]')), '不应出现重复的 [guard] [guard] 前缀');
    assert.ok(lines.every(([, text]) => text.startsWith('[guard] ')), '模块名由 logger 镜像负责，正文不再自带前缀');
    assert.equal(logged.filter((e) => e.text.includes('熔断')).length, 1, '熔断提示只记一次');
  } finally {
    off();
    logger.mirrorConsole = prevMirror;
    resetBreakers();
  }
});

// ── Electron 主进程：logKey / logCritical ─────────────────────────────────
//
// 主进程入口不能在 node:test 里启动；按 tests/electron-backup-save.test.mjs 的做法
// 抽出日志函数块，注入 coreLogger / console / fallbackLog 依赖后执行。

const mainSource = fs.readFileSync(new URL('../electron/main.js', import.meta.url), 'utf8');
const logStart = mainSource.indexOf('function fallbackLog(');
const logEnd = mainSource.indexOf('/** 把任意 throw 值整理成可落盘的文本');
if (logStart < 0 || logEnd < 0) {
  throw new Error('无法从 electron/main.js 抽取日志函数块 —— 函数被重命名或改写了？');
}
const logBlock = mainSource.slice(logStart, logEnd);

function loadLogFns(coreLogger) {
  const calls = { console: [], fallback: [] };
  const sandbox = {
    coreLogger,
    process: { env: { QQ_AGENT_DATA_DIR: '/tmp/qq-agent-log-test' } },
    packagedDataDir: () => '/tmp/qq-agent-log-test',
    path,
    fs: { mkdirSync() {}, appendFileSync(file, text) { calls.fallback.push(text.trim()); } },
    console: {
      log: (...a) => calls.console.push(['log', ...a]),
      error: (...a) => calls.console.push(['error', ...a])
    }
  };
  vm.runInNewContext(`${logBlock}\nglobalThis.logKey = logKey; globalThis.logCritical = logCritical;`, sandbox);
  return { sandbox, calls };
}

test('electron logKey / logCritical：coreLogger 存在时不再 console.*（一次调用一行）', () => {
  const logged = [];
  const { sandbox, calls } = loadLogFns({
    info: (mod, text) => logged.push(['info', mod, text]),
    error: (mod, text) => logged.push(['error', mod, text])
  });
  sandbox.logKey('boot', '窗口已创建');
  sandbox.logCritical('boot', '数据目录不可写');

  assert.equal(logged.length, 2, 'logger 各收到一次');
  assert.equal(calls.console.length, 0, 'console 由 logger 镜像，主进程不再重复打印');
  assert.equal(calls.fallback.length, 0, 'logger 可用时不走兜底文件');
});

test('electron logKey / logCritical：logger 不可用时保留 fallbackLog + console 双出口', () => {
  const { sandbox, calls } = loadLogFns(null);
  sandbox.logKey('boot', '窗口已创建');
  sandbox.logCritical('boot', '数据目录不可写');

  assert.equal(calls.fallback.length, 2, 'logger 不可用时必须落盘到 boot-fallback.log');
  assert.equal(calls.console.length, 2, '这是唯一能看到输出的通道，不能连它一起删');
  assert.ok(calls.console.some(([, text]) => text.includes('窗口已创建')));
  assert.ok(calls.console.some(([, text]) => text.includes('数据目录不可写')));
});
