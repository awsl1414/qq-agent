// API 路由表：把 handleHttp 的巨型 if-else 链拆成声明式路由。
//
// 每个路由：{ method, pattern, handler }
//   - method: 'GET' | 'POST' | 'PUT' | 'DELETE' | '*'（'*' 匹配任意方法）
//   - pattern: 字符串（精确匹配）或 RegExp（exec 捕获组传给 handler）
//   - handler: async (ctx) => 结果
//       ctx = { req, res, url, pathname, method, match, body?, ...deps }
//       handler 返回 undefined 表示"已自行写响应"（如 SSE）；否则框架统一 json() 返回。
//
// 依赖（store/memory/sessions/onebot/orchestrator/…）通过 createRoutes(deps) 注入，
// handler 通过闭包取用，避免在 app.js 里反复传参。

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { getConfig, updateConfig, deepMerge as deepMergeConfig, DATA_DIR, ROOT } from './config.js';
// 从 wsUrl 取端口探测目标（host + port）。以前各处只取端口、主机写死 127.0.0.1，
// 协议端在局域网另一台机器时状态永远是"端口未监听"。
import { parseProbeTarget } from './protocol-endpoint.js';
import { customSearch } from './web-search.js';
import { listModels, chatCompletion, chatCompletionWithRetry, resolveApiKey, estimateCost, cacheHitRate } from './llm.js';
import { resolveOfficialPrice, listOfficialPrices } from './model-prices.js';
import { refreshPriceFeed, priceFeedStatus, initPriceFeed } from './price-feed.js';
import {
  currentProviders, setProviderKey, setProviderProtocol, setProviderDisplayName, providerDisplayLabel,
  testAllProviders, testOneProvider,
  testModelChat, fetchModelsFrom, upsertProvider, addModelsToProvider, removeModelFromProvider, removeProvider
} from './providers.js';
import { normalizeProtocol, protocolLabel } from './api-protocols.js';
import { scanModelsVision, visionResults, modelImageVerdict } from './vision-scan.js';
import { builtinVisionResults } from './model-vision-docs.js';
import { todayKey } from './util.js';
import { logger } from './logger.js';
import { skillManager } from './skills/manager.js';
import { buildPluginUsage } from './plugin-usage.js';
import { getSkillConfig, setSkillConfig, setSkillEnabled, listConfiguredSkillIds } from './skills/config.js';
import { availabilityOf, listTools, CATEGORY_META } from './tool-registry.js';
import { safeFetchBinary, browseLockState } from './safe-fetch.js';
import { getGlobalBlocklist, updateGlobalBlocklist, FIXED_PRICE_FEED_URL } from './community.js';
import { listAccounts, removeAccount, loginAccount, publishModule, verifyInstallCodes, downloadModuleZip, listMarketItems, clearMarketListCache, listPersonaItems, fetchPersonaPrompt } from './market.js';
import { importModules } from './module-import.js';
import { applyImport, rollbackImport, listBackups } from './migrate.js';
import * as backup from './backup/index.js';
import { encryptCredential } from './backup/crypto.js';
import { TARGET_TYPES } from './backup/targets/index.js';

import { listBundleOptions, exportBundle, inspectBundle, moduleZipOf, dataDirOf, discardBundle } from './bundle.js';
import { SKILLS_DIR, PLUGINS_DIR, isBuiltinModuleDir } from './plugin-loader.js';
import { toOpenAiTools, executeTool } from './tools.js';
// 探测结果的"可对外"视图：删掉两枚令牌，只留有无标记。
// 令牌不越过 HTTP 边界的保证在这个纯函数里，路由只负责调它。
import { publicView as protocolDetectView } from './protocol-detect.js';

const BACKUP_SECRET_FIELDS = ['credentials', 'secretAccessKeyCipher', 'accessKeyId', 'username', 'password', 'secretAccessKey'];
const BACKUP_TARGET_FIELDS = ['id', 'name', 'type', 'enabled', 'dir', 'url', 'endpoint', 'region', 'bucket', 'forcePathStyle', 'categories'];
function publicBackupConfig(config = {}) {
  return { ...config, targets: (config.targets || []).map((target) => {
    const out = Object.fromEntries(BACKUP_TARGET_FIELDS.filter((key) => key in target).map((key) => [key, target[key]]));
    for (const key of BACKUP_SECRET_FIELDS) {
      delete out[key];
      out['has' + key[0].toUpperCase() + key.slice(1)] = Boolean(target[key]);
    }
    return out;
  }) };
}
function prepareBackupConfig(patch = {}) {
  const current = getConfig().backup || {};
  const out = {};
  for (const key of ['enabled', 'includeSecrets']) if (key in patch) {
    if (typeof patch[key] !== 'boolean') throw new Error('备份开关必须是布尔值');
    out[key] = patch[key];
  }
  for (const key of ['intervalHours', 'retention']) if (key in patch) {
    if (!Number.isFinite(patch[key]) || patch[key] <= 0 || (key === 'retention' && !Number.isInteger(patch[key]))) throw new Error('备份间隔和保留数量必须为正数');
    out[key] = patch[key];
  }
  if ('targets' in patch) {
    if (!Array.isArray(patch.targets)) throw new Error('targets 必须是数组');
    const ids = new Set();
    out.targets = patch.targets.map((target) => {
      if (!target || !target.id || ids.has(target.id) || !TARGET_TYPES.includes(target.type)) throw new Error('备份目标类型或 ID 无效');
      ids.add(target.id);
      const previous = (current.targets || []).find((item) => item.id === target.id && item.type === target.type) || {};
      const entry = {};
      for (const key of BACKUP_TARGET_FIELDS) if (key in target) entry[key] = target[key];
      for (const key of ['url', 'endpoint']) if (entry[key]) {
        const url = new URL(entry[key]);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('目标 URL 不允许内嵌凭据');
      }
      for (const key of ['username', 'accessKeyId']) entry[key] = typeof target[key] === 'string' && target[key] ? target[key] : previous[key] || '';
      // 空输入表示保留已存凭据，客户端永远不需要拿到密文再回传。
      entry.credentials = target.password ? encryptCredential(String(target.password)) : previous.credentials || '';
      entry.secretAccessKeyCipher = target.secretAccessKey ? encryptCredential(String(target.secretAccessKey)) : previous.secretAccessKeyCipher || '';
      return entry;
    });
  }
  return out;
}

// 更新源健康状态：远端 version.json 落后于当前安装版本时，「hasUpdate=false」和
// 「已经是最新」长得一模一样，源荒废了也不会有人发现。同一进程里只告警一次，
// 避免用户每开一次设置页就刷一条日志。
const updateFeedState = { staleWarned: false };

// ── ffmpeg 能力体检缓存 ────────────────────────────────────────────────
// checkFfmpegCapabilities 要跑 -encoders / -filters 两条子进程，比 -version 慢
// 一个数量级，而 /api/ffmpeg/status 会被设置页轮询。按「可执行文件路径 + mtime」
// 缓存：同一份文件不重复查，用户换了一份（下载/手填/切来源）才重查。
const FFMPEG_HEALTH_TTL_MS = 10 * 60 * 1000;
const ffmpegHealthCache = new Map();   // key -> { at, result }

async function cachedFfmpegHealth(exe) {
  const { checkFfmpegCapabilities } = await import('./ffmpeg-resolve.js');
  let stamp = '';
  try { stamp = String(fs.statSync(exe).mtimeMs); } catch { /* 文件读不到就按路径缓存 */ }
  const key = `${exe}\u0000${stamp}`;
  const hit = ffmpegHealthCache.get(key);
  if (hit && Date.now() - hit.at < FFMPEG_HEALTH_TTL_MS) return hit.result;
  const result = await checkFfmpegCapabilities(exe);
  // 只留最新一份，避免用户反复切换来源时无限增长
  ffmpegHealthCache.clear();
  ffmpegHealthCache.set(key, { at: Date.now(), result });
  return result;
}

/**
 * 用系统文件管理器打开一个目录。
 *
 * 三个平台的"打开目录"不是同一个命令：Windows 是 explorer.exe、macOS 是 open、
 * Linux 桌面是 xdg-open。写死 explorer.exe 会让 macOS / Linux 上 spawn 直接 ENOENT，
 * 用户看到的是"点了没反应"。
 *
 * 固定路径参数（导出目录 / DATA_DIR），不接受任何用户输入，没有命令注入面。
 */
function openDirNative(dir) {
  const opener = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open';
  // spawn 是异步的：命令不存在时错误走 'error' 事件而不是抛错。不挂监听器会
  // 变成未处理的 error 事件把进程带崩；这里只记日志，调用方仍按已发起处理。
  const child = spawn(opener, [dir], { detached: true, stdio: 'ignore' });
  child.on('error', (e) => {
    logger.warn('routes', `打开目录失败（${opener}）：${String(e?.message ?? e)}`);
  });
  child.unref();
}

/**
 * 构建路由表。
 * @param {object} deps 依赖注入
 */
export function createRoutes(deps) {
  const {
    store, memory, sessions, onebot, orchestrator,
    emit, log,
    // app.js 内部的过程/状态
    localVersion, compareSemver,
    sanitizeConfig, keyEndpointAllowed, sanitizeProvider,
    // 注意：这里刻意不取 authorize。鉴权在 app.js 统一执行，留一个没用到的
    // 解构会误导后来者以为某条路由漏鉴权。
    readBody,
    qqPortableStatus, qqPortableLogs, launchPortableQQ, stopPortableQQ,
    showPortableQQ, setupPortableQQFromLocal,
    visionScan,
    buildUsageStats, buildUsageBreakdown,
    reloadSkills,
    // 协议端配置探测（见 app.js autoFillProtocol）
    autoFillProtocol, detectProtocol
  } = deps;

  // 小工具：读请求体（容错：没 body 当空对象）。
  // readBody 明确标记的可暴露错误（400 非法 JSON / 413 过大）必须透传，
  // 否则会从"应返回 400"退化成静默当成空 patch。
  const bodyOf = (req) => readBody(req).catch((e) => { if (e?.expose) throw e; return {}; });

  /**
   * Skill 可用性判断的运行期上下文。
   * 必须和 orchestrator 用同一份输入，否则会出现
   * "设置页说可用、运行时空工具列表"的口径分裂。
   */
  const skillRuntimeContext = () => {
    const cfg = getConfig();
    return {
      skills: skillManager,
      toolsCfg: cfg.tools || {},
      // 与 orchestrator 同款判定：vision 开关开着，且当前模型没有被
      // 视觉扫描判定为 no-vision（曾经只看前半项，模型不支持时
      // 设置页仍显示视觉工具可用，运行时却剔除）
      visionEnabled: cfg.api?.vision !== false
        && modelImageVerdict(cfg.api?.provider, cfg.api?.model) !== 'no-vision',
      searchEnabled: cfg.webSearch?.enabled !== false,
      runtimeContext: {
        model: cfg.api?.model || '',
        provider: cfg.api?.provider || '',
        source: 'api'
      }
    };
  };

  const backupHooks = {
    storeInvalidate: (key) => store?.invalidate(key),
    memoryInvalidate: (key) => memory?.invalidate(key),
    rebuildChat: async (chatKey) => {
      const providers = skillManager.getCapabilityProviders('memory.rebuild', skillRuntimeContext());
      return providers.length ? providers[0].fn({ chatKey }) : null;
    }
  };
  const sanitizedConfig = (config) => ({ ...sanitizeConfig(config), backup: publicBackupConfig(config.backup) });
  return [
    // app.js 在路由分发前统一执行 authorize 和 originAllowed，与其他写接口相同。
    { method: 'GET', pattern: '/api/backup/config', handler: async ({ res, json }) => json(res, 200, { ok: true, config: publicBackupConfig(getConfig().backup) }) },
    { method: 'POST', pattern: '/api/backup/config', handler: async ({ req, res, json }) => {
      try {
        const patch = prepareBackupConfig(await bodyOf(req));
        updateConfig({ backup: patch });
        emit('status', { configUpdated: true });
        return json(res, 200, { ok: true, config: publicBackupConfig(getConfig().backup) });
      } catch { return json(res, 400, { ok: false, error: '备份配置无效，保存失败' }); }
    } },
    { method: 'GET', pattern: '/api/backup/targets', handler: async ({ res, json }) => json(res, 200, { ...backup.getStatus(), rollbacks: listBackups() }) },
    { method: 'GET', pattern: '/api/backup/list', handler: async ({ res, json, url }) => {
      const targetId = url.searchParams.get('targetId');
      return json(res, 200, await backup.listBackups({ targetIds: targetId ? [targetId] : null }));
    } },
    ...['test', 'run', 'preview', 'restore', 'rollback'].map((action) => ({
      method: 'POST', pattern: '/api/backup/' + action,
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        try {
          let result;
          if (action === 'test') result = await backup.testTarget(String(body.targetId || ''));
          if (action === 'run') result = await backup.runBackup({ targetIds: body.targetIds });
          if (action === 'preview') result = await backup.restorePreview({ targetId: body.targetId, key: body.key });
          if (action === 'restore') result = await backup.runRestore({ targetId: body.targetId, key: body.key, hooks: backupHooks });
          if (action === 'rollback') result = await rollbackImport(body.backupId, backupHooks);
          const targetErrors = (result.targets || []).filter((target) => !target.ok)
            .map((target) => `${target.id}：${target.error || '操作失败'}`).join('；');
          if (action === 'run' && result.ok) result = { ...result, partial: Boolean(targetErrors) };
          return json(res, result.ok ? 200 : 400, result.ok ? result : { ...result, error: result.error || result.message || targetErrors || '备份操作失败' });
        } catch { return json(res, 400, { ok: false, error: '备份操作失败，请检查目标配置' }); }
      }
    })),
    // ── 系统自检（self-doctor 插件提供的 doctor.report 能力）────────────────
    // 三条路由都是"能力代理"：核心不 import 那个插件，靠能力名问它要结果，
    // 关掉 self-doctor 后这些接口会明确报"未启用"，而不是 500 或空数据。
    {
      method: 'GET', pattern: '/api/doctor',
      handler: async ({ res, json }) => {
        const ctx = skillRuntimeContext();
        const providers = skillManager.getCapabilityProviders('doctor.report', ctx);
        if (!providers.length) {
          return json(res, 200, {
            ok: false, available: false,
            // 「插件」是顶部一个独立页签，不在设置里；self-doctor 是插件页里的条目。
            error: '「系统自检」插件未启用（顶部「插件」页 → self-doctor）'
          });
        }
        try {
          // 复用插件侧 5 分钟内的上次结果，不强制重扫
          const force = false;
          const out = providers[0].fn({ run: force });
          const report = out?.report || null;
          return json(res, 200, { ok: true, available: true, report, text: out?.text || '' });
        } catch (error) {
          return json(res, 500, { ok: false, available: true, error: `自检执行失败：${String(error?.message ?? error)}` });
        }
      }
    },
    {
      method: 'POST', pattern: '/api/doctor/run',
      handler: async ({ req, res, json }) => {
        const ctx = skillRuntimeContext();
        const providers = skillManager.getCapabilityProviders('doctor.report', ctx);
        if (!providers.length) {
          return json(res, 200, { ok: false, available: false, error: '「系统自检」插件未启用' });
        }
        // body 可选：{ project: true } 时附带全项目扫描
        let body = {};
        try { body = (await bodyOf(req)) || {}; } catch { body = {}; }
        try {
          const out = providers[0].fn({ run: true, project: body.project === true });
          return json(res, 200, { ok: true, available: true, report: out?.report || null, text: out?.text || '' });
        } catch (error) {
          return json(res, 500, { ok: false, available: true, error: `自检执行失败：${String(error?.message ?? error)}` });
        }
      }
    },
    {
      // 忽略 / 恢复体检单上的条目（self-doctor 的 doctor.ack 能力）。
      // 体检单的问题都是从磁盘现状推导的，用户自查后确认某条无妨时需要一个
      // "我知道了"的标记，否则下次体检原样回来，一直挂在警告位。
      // 忽略清单落盘在 self-doctor 自己的 plugin-data 下，跨重启生效，可随时恢复。
      method: 'POST', pattern: '/api/doctor/ack',
      handler: async ({ req, res, json }) => {
        const ctx = skillRuntimeContext();
        const providers = skillManager.getCapabilityProviders('doctor.ack', ctx);
        if (!providers.length) {
          return json(res, 200, { ok: false, available: false, error: '「系统自检」插件未启用' });
        }
        let body = {};
        try { body = (await bodyOf(req)) || {}; } catch { body = {}; }
        try {
          // body: { action: 'ignore'|'restore'|'restore-all', items: [{area,id}] }
          const out = providers[0].fn({
            action: String(body.action || 'ignore'),
            items: Array.isArray(body.items) ? body.items : []
          });
          return json(res, 200, { ok: true, available: true, acked: out?.acked || [] });
        } catch (error) {
          return json(res, 500, { ok: false, available: true, error: `忽略操作失败：${String(error?.message ?? error)}` });
        }
      }
    },
    {
      // 全项目静态扫描（self-doctor 的 doctor.scan-project 能力）。
      // 与 /api/doctor 分开：这个明显更慢（~200ms），不该被页面轮询带着跑。
      method: 'POST', pattern: '/api/doctor/scan-project',
      handler: async ({ req, res, json }) => {
        const ctx = skillRuntimeContext();
        const providers = skillManager.getCapabilityProviders('doctor.scan-project', ctx);
        if (!providers.length) {
          return json(res, 200, { ok: false, available: false, error: '「系统自检」插件未启用' });
        }
        let body = {};
        try { body = (await bodyOf(req)) || {}; } catch { body = {}; }
        try {
          const out = providers[0].fn({
            rule: body.rule ? String(body.rule) : undefined,
            dir: body.dir ? String(body.dir) : undefined
          });
          return json(res, 200, { ok: true, available: true, result: out?.result || null, text: out?.text || '' });
        } catch (error) {
          return json(res, 500, { ok: false, available: true, error: `项目扫描失败：${String(error?.message ?? error)}` });
        }
      }
    },
    {
      // 前缀缓存哨兵（self-doctor 的 doctor.cache-sentinel 能力）。
      // 取数 + 静态前缀体检，**不调模型**，分析由前端拿文本再走 /api/doctor/ask，
      // 这样"看数"免费、"让模型解读"才花 token。
      // 要读 24 个 session + 十几个插件源码（实测约 300ms），所以只由按钮触发，不进页面轮询。
      method: 'POST', pattern: '/api/doctor/cache-sentinel',
      handler: async ({ req, res, json }) => {
        const ctx = skillRuntimeContext();
        const providers = skillManager.getCapabilityProviders('doctor.cache-sentinel', ctx);
        if (!providers.length) {
          return json(res, 200, { ok: false, available: false, error: '「系统自检」未启用（顶部「插件」页 → self-doctor）' });
        }
        let body = {};
        try { body = (await bodyOf(req)) || {}; } catch { body = {}; }
        try {
          const out = providers[0].fn({ limit: Number(body.limit) || 16 });
          return json(res, 200, { ok: true, available: true, sentinel: out?.sentinel || null, text: out?.text || '' });
        } catch (error) {
          return json(res, 500, { ok: false, available: true, error: `哨兵取数失败：${String(error?.message ?? error)}` });
        }
      }
    },
    {
      // 自检专用模型的配置读取。
      // key 用 hasApiKey 布尔（sanitizeConfig 已自动脱敏），前端要显示明文走下面的 key 端点。
      method: 'GET', pattern: '/api/doctor/config',      handler: async ({ res, json }) => {
        const cfg = getConfig();
        const d = cfg.doctorApi || {};
        return json(res, 200, {
          ok: true,
          config: {
            enabled: d.enabled === true,
            baseUrl: String(d.baseUrl || ''),
            model: String(d.model || ''),
            hasApiKey: Boolean(String(d.apiKey || '').trim())
          },
          // 全局那份（供前端展示"跟随全局"时的实际值，不暴露 key）
          global: {
            baseUrl: String(cfg.api?.baseUrl || ''),
            model: String(cfg.api?.model || ''),
            hasApiKey: Boolean(resolveApiKey(cfg))
          }
        });
      }
    },
    {
      // 自检专用配置写入：只 patch doctorApi 这一段，不碰全局 api。
      // ⚠️ apiKey 留空 = 保留原值（前端永远拿不到明文，不能靠"回传原值"来不修改）。
      method: 'POST', pattern: '/api/doctor/config',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const patch = {};
        if (body.enabled !== undefined) patch.enabled = body.enabled === true;
        if (body.baseUrl !== undefined) patch.baseUrl = String(body.baseUrl || '').trim();
        if (body.model !== undefined) patch.model = String(body.model || '').trim();
        // 空串 / 掩码 = 不修改；要清空得显式传 clearApiKey:true
        const rawKey = String(body.apiKey ?? '').trim();
        if (body.clearApiKey === true) patch.apiKey = '';
        else if (rawKey && rawKey !== '******') patch.apiKey = rawKey;
        if (!Object.keys(patch).length) return json(res, 400, { ok: false, error: '没有可写入的字段' });

        updateConfig({ doctorApi: patch });
        const d = getConfig().doctorApi || {};
        return json(res, 200, {
          ok: true,
          config: {
            enabled: d.enabled === true,
            baseUrl: String(d.baseUrl || ''),
            model: String(d.model || ''),
            hasApiKey: Boolean(String(d.apiKey || '').trim())
          }
        });
      }
    },
    {
      // 自检专用 Key 明文读取：与 /api/search-key、/api/onebot-token 同一套来源校验
      // （keyEndpointAllowed 只放行控制台来源，挡的是外部网页冒用 127.0.0.1）。
      method: 'GET', pattern: '/api/doctor/config-key',
      handler: async ({ req, res, json }) => {
        if (!keyEndpointAllowed(req)) return json(res, 403, { error: '请求来源不被信任，已拒绝读取明文密钥。' });
        const d = getConfig().doctorApi || {};
        return json(res, 200, { apiKey: String(d.apiKey || ''), hasApiKey: Boolean(String(d.apiKey || '').trim()) });
      }
    },
    {
      // 对话式排查（工具循环版）：模型可以**自己去读**项目文件与日志，而不是"盲答体检单"。
      //
      // 只把一张预先算好的体检单塞进 system prompt 时，模型是"盲"的：体检单没覆盖的
      // 问题（某插件为何没加载、昨天 3 点报了什么错）它只能猜。
      //
      // 分工：**工具层（doctor.tools 能力，由 self-doctor 插件提供）负责"给证据"**，
      //       **本层负责"调模型 + 跑循环"**，核心不 import 那个插件。
      //
      // 只读保证：工具定义里没有写/删/执行类工具；插件侧的沙箱（白名单目录 + realpath
      // 校验 + 后缀白名单 + 字节/行数限额）是第二道闸。本层不额外造文件访问能力。
      method: 'POST', pattern: '/api/doctor/ask',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const question = String(body.question || '').trim();
        if (!question) return json(res, 400, { ok: false, error: '缺少 question' });
        if (question.length > 2000) return json(res, 400, { ok: false, error: '问题过长（上限 2000 字）' });
        // ── 附加上下文 ────────────────────────────────────────────────
        // 单独开一个字段而不是放宽 question：2000 字是给**人手输入**设的防呆，
        // 但哨兵的整份快照是程序生成的、动辄两三千字，塞进 question 会被校验打回
        // （现场表现：点「哨兵分析」→ ⚠ 请求失败：问题过长（上限 2000 字））。
        // 分开之后两边各管各的：提问 ≤2000，上下文单独放到 12000。
        const contextText = String(body.context || '').trim();
        if (contextText.length > 12000) {
          return json(res, 400, { ok: false, error: '附加上下文过长（上限 12000 字）' });
        }
        // 数据在前、指令在后：模型对消息末尾的指令更敏感，反过来容易"读完数据忘了要干什么"。
        const userContent = contextText ? `${contextText}\n\n${question}` : question;

        const ctx = skillRuntimeContext();
        const providers = skillManager.getCapabilityProviders('doctor.report', ctx);
        if (!providers.length) {
          return json(res, 200, { ok: false, available: false, error: '「系统自检」插件未启用' });
        }
        let reportText = '';
        try { reportText = providers[0].fn({ run: false })?.text || ''; } catch { /* 用空报告兜底 */ }

        // ── 取证工具（可选能力）：插件没提供 doctor.tools 时自动降级为"只有体检单"的老行为 ──
        // 这样即使装了旧版 self-doctor，这条接口也不会 500，只是少了"自己去看"的能力。
        let toolDefs = [];
        let toolCtx = null;
        try {
          const toolProviders = skillManager.getCapabilityProviders('doctor.tools', ctx);
          if (toolProviders.length) {
            const out = toolProviders[0].fn({});
            toolDefs = Array.isArray(out?.defs) ? out.defs : [];
            toolCtx = out?.ctx || null;
          }
        } catch (error) {
          logger.warn('doctor', `取证工具加载失败，降级为纯体检单模式：${String(error?.message ?? error)}`);
          toolDefs = [];
        }
        // 只放行 doctor_ 前缀的工具，兜住"插件不小心把写文件工具也报上来"的情况。
        // 这是第三道闸（前两道：插件沙箱、本层不造能力）：白名单前缀 + 显式排除非只读名。
        toolDefs = toolDefs.filter((d) => {
          const id = String(d?.id || d?.name || '');
          if (!id.startsWith('doctor_')) return false;
          return !/(write|delete|remove|exec|spawn|kill|mkdir|rename|move|chmod)/i.test(id);
        });

        const cfg = getConfig();
        // ── 选哪套凭据 ──────────────────────────────────────────────────
        // doctorApi.enabled=true 且填了 model 时用自检专用（隔离，不走账号池）；
        // 否则跟随全局 api（与原行为一致）。
        // ⚠️ 传了 overrides 就绕开账号池与专用模型切换（见 llm.js 的 `protocolForProvider`），
        //    这正是"独立配置"该有的隔离语义：用户在自检页指定什么就用什么。
        const d = cfg.doctorApi || {};
        const useOwn = d.enabled === true && String(d.model || '').trim();
        const overrides = useOwn ? {
          baseUrl: String(d.baseUrl || cfg.api?.baseUrl || ''),
          apiKey: String(d.apiKey || '').trim() || resolveApiKey(cfg),
          model: String(d.model).trim()
        } : null;
        const modelName = useOwn ? overrides.model : cfg.api?.model;
        if (!modelName) {
          return json(res, 200, {
            ok: false, available: true,
            error: useOwn
              ? '自检专用模型未填 model（自检页 → 模型设置）'
              : '尚未配置聊天模型（设置 → 模型与搜索 → 模型 API）'
          });
        }
        if (useOwn && !overrides.baseUrl) {
          return json(res, 200, { ok: false, available: true, error: '自检专用端点未填 Base URL' });
        }

        const hasTools = toolDefs.length > 0;
        const sys = [
          '你是 QQ Agent 的运行期诊断助手。你只做**只读分析**：解释问题、给出根因假设与证据、指出下一步去哪儿看。',
          '你没有修改任何文件的能力，也不要建议直接改核心代码 —— 建议要落到"用户在 UI 的哪一页调什么"。',
          '',
          '下面是刚刚生成的系统体检单（确定性检查结果，可信）：',
          '────────',
          reportText || '（体检单为空：可能插件刚启用还没跑过）',
          '────────'
        ];
        if (hasTools) {
          sys.push(
            '',
            '你还可以**自己去读项目里的真实文件**（源码 / 日志 / 插件数据）来核实。可用工具：',
            toolDefs.map((d) => `  · ${d.id}：${String(d.description || '').split('\n')[0]}`).join('\n'),
            '使用要求：',
            '  1) 先想清楚"要验证什么"，再决定查哪个文件 —— 不要漫无目的地列目录。',
            '  2) 体检单与工具读到的内容冲突时，**以文件内容为准**（体检单是静态规则，文件是事实）。',
            '  3) 引用证据要给出**具体位置**（文件路径 + 行号 / 日志时间戳），不要只说"日志里好像有"。',
            '  4) 工具最多调用若干轮，够用就停 —— 拿到证据就直接给结论，不要为了显得勤奋而多查。',
            '  5) 工具报错（越界/不存在/被拒）是正常反馈，换个路径再试或如实说明，不要反复重试同一个。'
          );
        }
        sys.push(
          '',
          '回答要求：先给结论（一句话），再给依据（引用你**实际读到**的内容与位置），最后给可执行的动作。',
          '不确定就说不确定。**绝对不要编造你没读过的日志内容或代码行** —— 没查到的就说没查到。'
        );

        try {
          // overrides 为 null 时跟随全局 api（与原行为一致）；非 null 时用自检专用配置。
          // 超时用 AbortSignal（chatCompletion 不接受 timeoutMs，只有 signal 能中断）。
          const ac = new AbortController();
          // 总预算 180s：比原来的 120s 放宽，因为现在可能要跑若干轮工具。
          const timer = setTimeout(() => ac.abort(new Error('诊断请求超时（180s）')), 180000);

          const messages = [
            { role: 'system', content: sys.join('\n') },
            { role: 'user', content: userContent }
          ];
          const openAiTools = hasTools ? toOpenAiTools(toolDefs) : undefined;
          // 轮次上限：每轮可并行多个工具调用，6 轮足够"查文件→看日志→再确认"这种三跳推理，
          // 又不会让失控的模型无限烧 token。实测 5 轮偏紧（模型查到一半就被截断），故留 6。
          const MAX_ROUNDS = 6;
          const trace = [];        // 给 UI 看的工具调用轨迹（谁、参数、结果摘要）
          let answer = '';
          let rounds = 0;

          try {
            for (let round = 0; round < MAX_ROUNDS; round++) {
              rounds = round + 1;
              // ── 收口提醒（学 orchestrator 的"剩余轮次提醒"）──
              // 没有它时模型会**一直查**：日志有几千行，它翻到第 5 轮还在 grep，
              // 最后给不出结论（真跑过一次：5 轮 10 次工具调用，最终回答为空）。
              // 倒数第 2 轮起明确告诉它"该收口了"。
              const left = MAX_ROUNDS - round;
              if (hasTools && left <= 2 && left > 0) {
                messages.push({
                  role: 'user',
                  content: `【系统提醒】取证轮次只剩 ${left} 轮。请**立刻停止调用工具**，用你已经读到的内容直接给出结论。`
                    + `如果证据不足以回答，就如实说明"已查到的部分是什么、还缺什么"，不要继续翻找。`
                });
              }
              const r = await chatCompletionWithRetry({
                messages,
                tools: openAiTools,
                temperature: 0.2,
                signal: ac.signal,
                overrides,
                // ⚠️ 取证场景必须关思考，理由与 /api/doctor/triage 完全相同（见该处注释）：
                //    deepseek-flash 等服务端强制思考的模型，reasoning token 从 max_tokens 里扣，
                //    不关的话每轮都在为"想"付费，而取证要的是"读文件"。
                skillContext: { thinkingMode: 'off' },
                tag: `doctor-ask:r${round}`
              });
              // ⚠️ chatCompletion 返回 { message: { content, tool_calls } }，顶层没有 content。
              const msg = r?.message || {};
              const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];

              if (!calls.length) {
                // 没有工具调用 = 模型认为证据够了，这一轮的正文就是答案。
                answer = typeof msg.content === 'string' ? msg.content : '';
                break;
              }

              // 把 assistant 这一轮（含 tool_calls）回填进历史，不回填的话下一轮
              // 请求会缺 tool 消息对应的 tool_call_id，OpenAI 协议直接 400。
              messages.push({ role: 'assistant', content: msg.content ?? null, tool_calls: calls });
              for (const call of calls) {
                if (ac.signal.aborted) break;
                const name = call?.function?.name || '';
                const argsRaw = call?.function?.arguments ?? '{}';
                let args = {};
                try { args = JSON.parse(argsRaw); } catch { args = { _raw: argsRaw }; }
                const result = await executeTool(toolDefs, toolCtx, name, argsRaw);
                const text = typeof result.content === 'string'
                  ? result.content
                  : (Array.isArray(result.content)
                    ? result.content.filter((p) => p.type === 'text').map((p) => p.text).join('\n')
                    : String(result.content ?? ''));
                messages.push({
                  role: 'tool',
                  tool_call_id: call.id,
                  name,
                  content: text
                });
                trace.push({
                  round: rounds,
                  tool: name,
                  args,
                  isError: !!result.isError,
                  summary: text.replace(/\s+/g, ' ').slice(0, 200),
                  bytes: text.length
                });
              }
            }
          } finally {
            clearTimeout(timer);
          }

          if (!String(answer).trim()) {
            // 到轮次上限还没收口（模型一直在查不写结论），用最后一次工具轨迹说明情况，
            // 而不是返回空字符串让用户面对一片空白。这种情况已加"收口提醒"缓解，
            // 但小模型仍偶发，所以兜底文案要**告诉用户下一步怎么办**，而不是只报个失败。
            if (trace.length) {
              const used = [...new Set(trace.map((t) => t.tool))].join('、');
              answer = `（模型在 ${MAX_ROUNDS} 轮取证后仍未给出结论。它已调用 ${trace.length} 次工具：${used}。`
                + `可以追问"直接给结论"，或缩小问题范围——比如指定文件名/时间段，减少它需要翻找的范围。）`;
            } else {
              answer = '（模型没有返回内容）';
            }
          }
          return json(res, 200, {
            ok: true, available: true, answer, model: modelName,
            ownConfig: useOwn, cachedReport: Boolean(reportText),
            toolsEnabled: hasTools, toolCount: toolDefs.length,
            rounds, trace
          });
        } catch (error) {
          return json(res, 500, { ok: false, available: true, error: `模型调用失败：${String(error?.message ?? error)}` });
        }
      }
    },

    {
      // 模型逐个审（triage）：把静态扫描的候选交给模型，读**该文件真实源码**判断真伪。
      //
      // 为什么在这里（而不是插件里）调模型：LLM 访问是本层（routes.js）的职责，
      // 插件层保持零 LLM 依赖，只负责扫/分组/读源码/拼 prompt（doctor.triage 能力）。
      // 这样"换成别的模型渠道/加缓存/billing tag"都只需动这一处。
      //
      // 成本控制：按文件分组（多命中合成一次调用）、只审 warning+、串行、可中断。
      // 每审完一个文件就往 SSE 推一条进度，UI 不必干等全部完成。
      method: 'POST', pattern: '/api/doctor/triage',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const ctx = skillRuntimeContext();
        const providers = skillManager.getCapabilityProviders('doctor.triage', ctx);
        if (!providers.length) {
          return json(res, 200, { ok: false, available: false, error: '「系统自检」插件未启用（或版本过旧，缺 doctor.triage 能力）' });
        }

        // ① 准备待审批（插件侧：扫描 + 分组 + 读源码 + 拼 prompt，不碰模型）
        let prep;
        try { prep = providers[0].fn({ severities: body.severities }); } catch (error) {
          return json(res, 500, { ok: false, available: true, error: `准备待审批失败：${String(error?.message ?? error)}` });
        }
        if (!prep.batches.length) {
          return json(res, 200, {
            ok: true, available: true, verdicts: {}, stats: { ...prep.stats, reviewed: 0, failed: 0 },
            note: '没有 warning 及以上的候选，无需模型介入'
          });
        }

        // ② 选凭据（与 /api/doctor/ask 完全同源，保证"模型设置"对两者都生效）
        const cfg = getConfig();
        const d = cfg.doctorApi || {};
        const useOwn = d.enabled === true && String(d.model || '').trim();
        const overrides = useOwn ? {
          baseUrl: String(d.baseUrl || cfg.api?.baseUrl || ''),
          apiKey: String(d.apiKey || '').trim() || resolveApiKey(cfg),
          model: String(d.model).trim()
        } : null;
        const modelName = useOwn ? overrides.model : cfg.api?.model;
        if (!modelName) {
          return json(res, 200, {
            ok: false, available: true,
            error: useOwn ? '自检专用模型未填 model（自检页 → 模型设置）' : '尚未配置聊天模型（设置 → 模型与搜索 → 模型 API）'
          });
        }

        // ③ 串行逐个审（串行 = 成本可控 + 可中途中断；并发会让费用和限流都不可控）
        const rawReplies = {};
        let reviewed = 0, failed = 0, aborted = false;
        const maxCalls = Math.max(1, Math.min(Number(body.maxCalls) || 60, 200));   // 硬上限
        const queue = prep.batches.slice(0, maxCalls);
        for (const batch of queue) {
          if (req.destroyed || res.writableEnded) { aborted = true; break; }   // 客户端断开就停
          const ac = new AbortController();
          const timer = setTimeout(() => ac.abort(new Error('单文件审阅超时（60s）')), 60000);
          try {
            const r = await chatCompletion({
              messages: [
                { role: 'system', content: batch.sys },
                { role: 'user', content: batch.user }
              ],
              temperature: 0,
              signal: ac.signal,
              overrides,
              maxTokens: 1200,
              // ⚠️ 判分类请求**必须**关思考。不关的话 thinking-adapters 会给 body 加上
              //    reasoning 参数，而 DeepSeek 系推理模型的 reasoning token 从 max_tokens
              //    里扣，实测 maxTokens:1200 时 reasoning 就吃掉 1200，finish_reason=length、
              //    content 为空字符串，表现是"审阅完成但一条结论都没有"。
              //    thinking-adapters 为此提供了按次覆盖的口子（context.thinkingMode）。
              skillContext: { thinkingMode: 'off' },
              tag: 'doctor-triage'
            });
            // ⚠️ 必须同时看 message.content 和顶层 content：chatCompletion 返回的是
            //    { message: {content}, finishReason, usage, ... }，顶层没有 content。
            //    只取 r.content 会永远拿到 undefined。
            const text = r?.message?.content || r?.content || '';
            // 空正文 = 这次没判出东西（多半是被 reasoning 吃光了 max_tokens），
            // 记为失败而不是"成功但无结论"，否则问题会被静默吞掉。
            if (!String(text).trim()) {
              failed++;
              try {
                emit?.('doctor-triage', {
                  file: batch.file,
                  error: `模型返回空正文（finishReason=${r?.finishReason || '?'}，可能是思考 token 吃光了 max_tokens）`,
                  done: reviewed + failed, total: queue.length
                });
              } catch { /* ignore */ }
              continue;
            }
            rawReplies[batch.file] = text;
            reviewed++;
            // 进度推送：UI 可实时看到审到哪了（不必干等全部审完）
            try { emit?.('doctor-triage', { file: batch.file, done: reviewed + failed, total: queue.length }); } catch { /* 推送失败不影响结果 */ }
          } catch (error) {
            failed++;
            try { emit?.('doctor-triage', { file: batch.file, error: String(error?.message ?? error), done: reviewed + failed, total: queue.length }); } catch { /* ignore */ }
          } finally {
            clearTimeout(timer);
          }
        }

        // ④ 解析 + 合并（解析逻辑归插件，输出格式的所有权在定义 prompt 的那一方）
        const parseProviders = skillManager.getCapabilityProviders('doctor.triage-parse', ctx);
        const parsed = parseProviders.length
          ? parseProviders[0].fn({ batches: queue, replies: rawReplies })
          : { files: {}, entries: [] };

        return json(res, 200, {
          ok: true, available: true, model: modelName, ownConfig: useOwn,
          verdicts: parsed.files,               // { 文件相对路径: [{index, verdict, reason}] }
          entries: parsed.entries,              // 扁平 [{key, verdict, reason}]，UI 标注用
          stats: { ...prep.stats, reviewed, failed, aborted, capped: prep.batches.length > maxCalls }
        });
      }
    },

    // ── 状态 / 数据目录 / 重置 ─────────────────────────────────────────
    {
      method: 'GET', pattern: '/api/status',
      handler: async ({ res, json }) => {
        const dayKey = todayKey();
        const usage = sessions.todayUsage(dayKey);
        const cfgNow = getConfig();
        const cost = estimateCost(usage, { model: cfgNow.api?.model });
        // 协议端（OneBot v11）运行判定用 WS 端口是否在监听。
        // 协议端由用户自行安装运行（SnowLuma / NapCat 任选其一），本软件只负责连。
        // 探测目标必须取自配置的 wsUrl：固定 127.0.0.1 会让"协议端在局域网另一台
        // 机器"的用户永远看到「端口未监听」，而 OneBot 客户端按完整 wsUrl 连是通的。
        const obTarget = parseProbeTarget(cfgNow.protocol?.wsUrl);
        const obPortOpen = await deps.isPortOpen(obTarget.host, obTarget.port);
        // 诊断：把"连不上"拆成用户能看懂的原因（给 UI 就绪度体检用）。
        let onebotDiagnosis = '';
        if (!onebot.connected) {
          if (!obPortOpen) onebotDiagnosis = `协议端未运行或未监听 WS 端口：请确认你安装的 SnowLuma 或 NapCat 已在运行（当前 ${String(getConfig().protocol?.wsUrl || '') || '未设置地址'}）`;
          else if (String(onebot.lastConnectError || '').includes('401')) onebotDiagnosis = '连接密码不一致（OneBot 访问令牌）：正在自动重试；若持续出现，去「设置 → 连接 QQ」重新填写访问令牌';
          else onebotDiagnosis = onebot.lastConnectError ? `连接失败：${String(onebot.lastConnectError).slice(0, 120)}` : '协议端已在运行，等待 OneBot 就绪（QQ 登录后数秒内会自动连上）…';
        }
        return json(res, 200, {
          onebot: {
            connected: onebot.connected,
            everConnected: onebot.everConnected,
            error: onebot.lastConnectError,
            diagnosis: onebotDiagnosis,
            self: onebot.selfInfo ? { userId: onebot.selfId, nickname: onebot.selfNickname } : null
          },
          protocol: {
            wsUrl: String(getConfig().protocol?.wsUrl || ''),
            httpUrl: String(getConfig().protocol?.httpUrl || ''),
            // WS 端口是否在监听（协议端是否在跑）。与 connected 分开：
            // 端口开着但连不上 = 令牌/账号问题；端口没开 = 协议端没起来。
            portOpen: obPortOpen
          },
          qqPortable: await qqPortableStatus(),
          orchestrator: orchestrator.statusSummary(),
          usage,
          cost,
          cacheHitRate: cacheHitRate(usage),
          webSearchCount: usage.webSearchCount || 0,
          paused: orchestrator.paused,
          pauseReason: orchestrator.pauseReason ?? null,
          dataDir: DATA_DIR
        });
      }
    },

    // ── 扩展锻造台（extension-forge 插件）──────────────────────────────────
    //
    // 这几条路由是**纯传输层**：核心不知道 "forge" 是什么，只按能力名问
    // "谁提供 forge.draft / forge.gate / forge.install"。真正的写盘 confinement、
    // 三道闸门、落地逻辑全在模块里（src/harness/forge/）。
    //
    // ⚠️ 插件无法注册 HTTP 路由（createSkillApi 只给了 registerTool / config /
    //    capability / log / fetch），所以必须在核心补这几行。
    //    这与 /api/doctor/* 完全同构，是既定的扩展模式。
    {
      // 状态：插件是否启用 + 暂存区里有哪些草稿
      method: 'GET', pattern: '/api/forge',
      handler: async ({ res, json }) => {
        const ctx = skillRuntimeContext();
        const provs = skillManager.getCapabilityProviders('forge.list', ctx);
        if (!provs.length) {
          return json(res, 200, {
            ok: false, available: false,
            error: '「扩展锻造台」插件未启用（顶部「插件」页 → extension-forge）'
          });
        }
        try {
          const out = provs[0].fn({}) || {};
          return json(res, 200, { ok: true, available: true, drafts: out.drafts || [] });
        } catch (error) {
          return json(res, 500, { ok: false, available: true, error: `读取草稿列表失败：${String(error?.message ?? error)}` });
        }
      }
    },
    {
      // 读一个草稿的全部文件内容（给 UI 展示生成的代码）
      method: 'POST', pattern: '/api/forge/read',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const ctx = skillRuntimeContext();
        const provs = skillManager.getCapabilityProviders('forge.read-draft', ctx);
        if (!provs.length) return json(res, 200, { ok: false, available: false, error: '「扩展锻造台」插件未启用' });
        try {
          return json(res, 200, { available: true, ...provs[0].fn({ draftId: body.draftId }) });
        } catch (error) {
          return json(res, 500, { ok: false, available: true, error: String(error?.message ?? error) });
        }
      }
    },
    {
      // 导入第三方扩展包：zip → 暂存区 → 拍快照 → 过闸门。**不安装**。
      //
      // 与 /api/skills/import 的关键差别：那条是"校验后直接落地、落地即执行"，
      // 这条只把内容读进暂存区，让人先看过。第三方代码不该有"导入即运行"的旁路。
      //
      // 快照（forge.snapshot）是给后面的"适配"用的：有了适配前的底片，
      // 才能算出模型到底改了什么并展示 diff。
      method: 'POST', pattern: '/api/forge/import',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const zipBase64 = typeof body.zipBase64 === 'string' ? body.zipBase64 : '';
        if (!zipBase64) return json(res, 400, { ok: false, error: '没有收到 zip 内容' });

        const ctx = skillRuntimeContext();
        const impProv = skillManager.getCapabilityProviders('forge.import-zip', ctx)[0];
        if (!impProv) {
          return json(res, 200, {
            ok: false, available: false,
            error: '「扩展锻造台」插件未启用（顶部「插件」页 → extension-forge）'
          });
        }

        let out;
        try {
          out = impProv.fn({ zipBase64, zipName: String(body.zipName || '') });
        } catch (error) {
          return json(res, 500, { ok: false, available: true, error: `导入失败：${String(error?.message ?? error)}` });
        }
        if (!out.ok) {
          return json(res, 200, { ok: false, available: true, rejected: !!out.rejected, error: out.error });
        }

        // 拍适配前快照（失败不阻断，没有快照只是后面看不到 diff）
        try {
          skillManager.getCapabilityProviders('forge.snapshot', ctx)[0]?.fn({ draftId: out.draftId, label: 'pre' });
        } catch { /* ignore */ }

        // 跑闸门：让用户一眼看到"这个包现在能不能直接装"
        let gate = null;
        try {
          gate = skillManager.getCapabilityProviders('forge.gate', ctx)[0]?.fn({ draftId: out.draftId }) || null;
        } catch (error) { gate = { ok: false, error: String(error?.message ?? error) }; }

        return json(res, 200, {
          ok: true, available: true,
          draftId: out.draftId, zipName: out.zipName, kind: out.kind,
          files: out.files, skipped: out.skipped, gate
        });
      }
    },
    {
      // 适配：把导入的（或任何）草稿交给模型改到"能装上、装完能工作"。
      //
      // 约束（界面上选的「清单为主 + 代码最小修补」）：
      //   · 优先改清单（apiVersion / entry / name / tools 声明 / permissions / requires）
      //   · 代码只在"不改就跑不起来"时做最小修补，且每处必须能说出"不改会怎么坏"
      //   · **不许借适配之名重写业务逻辑**
      //
      // 完成后重跑闸门 + 算 diff，把"改了什么"如实回给前端。
      method: 'POST', pattern: '/api/forge/adapt',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const draftId = String(body.draftId || '').trim();
        if (!draftId) return json(res, 400, { ok: false, error: '缺少 draftId' });
        const note = String(body.note || '').trim().slice(0, 1000);

        const ctx = skillRuntimeContext();
        const provs = skillManager.getCapabilityProviders('forge.draft', ctx);
        if (!provs.length) return json(res, 200, { ok: false, available: false, error: '「扩展锻造台」插件未启用' });

        // ── 收集上下文：草稿内容 + 当前闸门结论 + 本地环境简报 ──
        let draftFiles = [];
        try {
          const rd = skillManager.getCapabilityProviders('forge.read-draft', ctx)[0]?.fn({ draftId }) || {};
          draftFiles = Array.isArray(rd.files) ? rd.files : [];
        } catch { /* ignore */ }
        if (!draftFiles.length) return json(res, 200, { ok: false, available: true, error: '草稿不存在或为空' });

        let gate = null;
        try { gate = skillManager.getCapabilityProviders('forge.gate', ctx)[0]?.fn({ draftId }) || null; } catch { /* ignore */ }

        let env = null;
        try { env = skillManager.getCapabilityProviders('forge.env', ctx)[0]?.fn({}) || null; } catch { /* ignore */ }

        // 工具集（写回草稿用；draftId 已给定，模型不用自己管草稿）
        let toolDefs = [], toolCtx = null;
        try {
          const out = provs[0].fn({ draftId }) || {};
          toolDefs = Array.isArray(out.defs) ? out.defs : [];
          toolCtx = out.ctx || null;
        } catch (error) {
          return json(res, 500, { ok: false, available: true, error: `写工具加载失败：${String(error?.message ?? error)}` });
        }

        // 凭据（与起草同源）
        const cfg = getConfig();
        const d = cfg.doctorApi || {};
        const useOwn = d.enabled === true && String(d.model || '').trim();
        const overrides = useOwn ? {
          baseUrl: String(d.baseUrl || cfg.api?.baseUrl || ''),
          apiKey: String(d.apiKey || '').trim() || resolveApiKey(cfg),
          model: String(d.model).trim()
        } : null;
        const modelName = useOwn ? overrides.model : cfg.api?.model;
        if (!modelName) {
          return json(res, 200, { ok: false, available: true, error: '尚未配置聊天模型（设置 → 模型与搜索 → 模型 API）' });
        }

        // 闸门问题清单（就是"要修什么"）
        const issueText = (gate?.issues || []).length
          ? gate.issues.map((i, n) => {
            const lv = i.level === 'block' ? '⛔阻断' : (i.level === 'confirm' ? '⚠️需确认' : '💡提示');
            return `${n + 1}. [${lv}] ${i.title}${i.why ? `\n     原因：${i.why}` : ''}`;
          }).join('\n')
          : '（没有发现问题 —— 这个包可以直接装）';

        // 提示词体积：单文件截 12K 字符，整包总量封顶 12 万字符。超过时优先保留
        // "清单 + 入口"（装不装得上就看它们），其余文件只列名，由模型用
        // forge_read_file 按需读取（工具本来就在工具集里）。
        const PROMPT_FILE_CHARS = 12000;
        const PROMPT_TOTAL_CHARS = 120000;
        const promptRankOf = (p) => (/^(skill|plugin)\.json$/i.test(p) ? 0 : (/(^|\/)index\.(js|mjs|cjs)$/i.test(p) ? 1 : 2));
        const promptParts = [];
        const promptOmitted = [];
        let promptChars = 0;
        for (const f of [...draftFiles].sort((a, b) => promptRankOf(a.path) - promptRankOf(b.path) || String(a.path).localeCompare(String(b.path)))) {
          const piece = `── ${f.path} ──\n${String(f.content).slice(0, PROMPT_FILE_CHARS)}`;
          if (promptParts.length && promptChars + piece.length > PROMPT_TOTAL_CHARS) { promptOmitted.push(f.path); continue; }
          promptParts.push(piece);
          promptChars += piece.length;
        }
        const fileText = promptParts.join('\n\n')
          + (promptOmitted.length
            ? `\n\n（为控制请求体积，以下 ${promptOmitted.length} 个文件未附正文，可用 forge_read_file 按需读取：\n${promptOmitted.map((p) => `  ${p}`).join('\n')}）`
            : '');

        const sys = [
          '你在**适配**一个别人写好的 QQ Agent 扩展，让它能在本机正常安装与工作。',
          '',
          '── 铁律（先读这条）──',
          '你的任务是**适配**，不是**重写**。这份代码是别人写的，作者的原意必须保住。',
          '  1. **优先改清单**（skill.json / plugin.json）：apiVersion、entry、name、description、',
          '     tools 声明、permissions、requires —— 绝大多数"装不上"都能靠改清单解决。',
          '  2. **代码只在"不改就跑不起来"时动**，且只做**最小必要修补**。',
          '  3. **绝对不要**借适配之名重构、优化、美化、或改掉它的业务逻辑。',
          '     如果你觉得必须大改代码才能用，**停下来如实说明**，不要硬改。',
          '  4. 每处代码改动都要能说出"不改会怎么坏"。说不出来就别改。',
          '',
          '── 本地环境（改之前必须对齐这些）──',
          '清单必须有：id（[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}）、name、apiVersion: 1、entry。',
          `本地 createSkillApi 提供的成员：${(env?.knownApis || []).join(' / ')}`,
          `本地认的权限只有：${(env?.knownPermissions || []).join(' / ')}`,
          `本机已装的扩展 id（撞车会被自动加 _1，但写死 id 的代码会错位）：${(env?.existingIds || []).slice(0, 40).join('、') || '（无）'}`,
          '',
          '── 注册样板（补写 / 修补工具注册时照抄结构，键名一个都不能错）──',
          '```js',
          'api.registerTool({',
          "  id: 'tool_id',                    // 必须与清单 tools[].id 一字不差",
          "  name: '工具名',",
          "  description: '给模型看的一句话说明',",
          '  parameters: { /* 与清单 tools[].parameters 一致 */ },',
          '  async execute(ctx, args) {        // ⚠️ 回调键名是 execute —— 写成 handler /',
          "    return { content: '结果文本' };  //    run / callback 等任何别的名字，工具都会",
          '  }                                 //    注册失败，整个扩展加载失败',
          '});',
          '```',
          '原包如果用的是别的框架风格（如 handler 键名），必须改成上面的 execute 形态 ——',
          '这是本机运行时的硬契约，闸门与加载器都按它校验。',
          '',
          '── 当前闸门结论（要修的就是这些）──',
          issueText,
          '',
          '── 草稿当前内容 ──',
          fileText,
          '',
          '── 怎么改 ──',
          '用工具把**改好的完整文件**写回去（forge_write_file 是覆盖写，不是追加）。',
          '改完用一段话说明：改了哪几个文件、每处为什么改、有没有你无法确定的地方。',
          '如果这个包根本没法安全适配（比如核心逻辑依赖一个本机没有的 API），',
          '就**明说做不到**并说明原因 —— 这比硬改出一个跑不了的东西诚实得多。',
          note ? `\n── 用户的补充说明 ──\n${note}` : ''
        ].join('\n');

        // ── 适配的预算口径（改这里之前先读这条）─────────────────────────────
        // · 单段墙 240s；一段用满且**有进展**时自动续一段，最多 2 段。原实现
        //   "单段 240s 对不封顶的多轮工作量"，第三方大包必现超时。
        // · 无进展（请求全挂死/端点不通）**不续段**：那种情况下续段只是把同一笔
        //   预算再烧一遍，直接报错。
        // · ⚠️ 改这里的任何数字，必须同步 ui/app/13-doctor.js 里适配按钮的客户端超时
        //   （560000ms ≈ 前置闸门 + 2×240s + 后置闸门/diff + 余量）。三层（客户端 /
        //   本段墙 / llm.js 单请求 180s）互有耦合，别让它们漂移。
        const ADAPT_SEGMENT_MS = 240000;
        const ADAPT_MAX_SEGMENTS = 2;
        const ADAPT_MAX_ROUNDS = 12;

        const t0 = Date.now();
        let round = 0;              // 跨段累计轮次（1 起；日志 tag 用它）
        let timedOut = false;       // 段墙中止但**有进展**（进度已保留，可再次点击继续）
        let noProgressWall = false; // 段墙中止且**毫无进展**（环境问题，按失败处理）
        let summary = '';
        const trace = [];
        let lastError = null;

        try {
          const messages = [
            { role: 'system', content: sys },
            { role: 'user', content: `请把这个扩展适配到本机环境（草稿 ${draftId}）。` }
          ];
          const openAiTools = toOpenAiTools(toolDefs);

          segments: for (let seg = 1; seg <= ADAPT_MAX_SEGMENTS; seg++) {
            const ac = new AbortController();
            const segStart = Date.now();
            const timer = setTimeout(() => ac.abort(new Error(`适配超时（${ADAPT_SEGMENT_MS / 1000}s）`)), ADAPT_SEGMENT_MS);
            let wallHit = false;
            try {
              while (round < ADAPT_MAX_ROUNDS) {
                // 提醒：轮次/时间任一接近枯竭就打招呼。模型对时间没有感知，
                // 不告诉它"还剩多少"，它会把预算花在细节上。
                const leftRounds = ADAPT_MAX_ROUNDS - round;
                const leftSec = Math.max(0, Math.round((ADAPT_SEGMENT_MS - (Date.now() - segStart)) / 1000));
                if (leftRounds <= 2 || leftSec <= 60) {
                  const tips = [];
                  if (leftRounds <= 2) tips.push(`总轮次只剩 ${leftRounds} 轮`);
                  if (leftSec <= 60) tips.push(`本段剩余时间约 ${leftSec} 秒`);
                  if (seg >= ADAPT_MAX_SEGMENTS) tips.push('之后不再续段');
                  messages.push({
                    role: 'user',
                    content: `【系统提醒】${tips.join('；')}。请立刻停止调用工具，用一段话说明你改了什么、为什么改；优先保证闸门阻断项已清零。`
                  });
                }
                round += 1;
                const r = await chatCompletionWithRetry({
                  messages,
                  tools: openAiTools,
                  temperature: 0.2,
                  signal: ac.signal,
                  overrides,
                  skillContext: { thinkingMode: 'off' },
                  tag: `forge-adapt:r${round}`
                });
                const msg = r?.message || {};
                const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
                if (!calls.length) { summary = typeof msg.content === 'string' ? msg.content : ''; break segments; }
                messages.push({ role: 'assistant', content: msg.content ?? null, tool_calls: calls });
                for (const call of calls) {
                  if (ac.signal.aborted) break;
                  const name = call?.function?.name || '';
                  const argsRaw = call?.function?.arguments ?? '{}';
                  let args = {};
                  try { args = JSON.parse(argsRaw); } catch { args = { _raw: argsRaw }; }
                  const result = await executeTool(toolDefs, toolCtx, name, argsRaw);
                  const text = typeof result.content === 'string' ? result.content : String(result.content ?? '');
                  messages.push({ role: 'tool', tool_call_id: call.id, name, content: text });
                  trace.push({ round, tool: name, args, isError: !!result.isError, summary: text.replace(/\s+/g, ' ').slice(0, 200) });
                }
              }
            } catch (error) {
              lastError = error;
              // 段墙（ac 被 abort）或"单请求超时"（180s，防重复计费不重试），两者都算
              // "本段被时间打断"，交给下面统一决定：有进展就续段 / 交付现场，无进展原样报错。
              // 其它错误（网络/端点/配置/坏响应）原样上抛。
              const isTimeoutLike = ac.signal.aborted || /模型请求超时|适配超时/.test(String(error?.message ?? error));
              if (!isTimeoutLike) throw error;
              wallHit = true;
            } finally {
              clearTimeout(timer);
            }

            if (!wallHit) break;                          // 段内正常收尾（拿到总结/轮次用满）→ 不续段
            if (!trace.length) { noProgressWall = true; break; }   // 毫无进展 → 环境问题，不续段
            timedOut = true;                              // 有进展但时间用尽 → 进度保留
            if (seg >= ADAPT_MAX_SEGMENTS || round >= ADAPT_MAX_ROUNDS) break;
            messages.push({
              role: 'user',
              content: '（系统）上一段因时间用尽而中止。请基于当前草稿继续修改：优先清除闸门阻断项，每轮尽量一次把要改的文件写全。'
            });
          }

          // 请求全挂死（一段都没跑动）→ 直接报错，不做任何"完成"假象。
          if (noProgressWall) throw lastError ?? new Error(`适配超时（${ADAPT_SEGMENT_MS / 1000}s）`);

          // 总结缺省：没给收尾说明时，给界面一段可读的话（不再回空串）
          if (!summary) {
            summary = timedOut
              ? `（本轮时间用尽：已完成 ${round} 轮、改动已保留在草稿里。可再次点击「让模型适配到本机」从当前草稿接着改。）`
              : `（已完成 ${round} 轮，模型未给出总结 —— 请查看下方 diff 与闸门结论。）`;
          }

          // 改完 / 时间用尽但**有进展**：都要重跑闸门 + 算 diff，超时也要交付"现场"
          let gate2 = null, diff = null;
          try { gate2 = skillManager.getCapabilityProviders('forge.gate', ctx)[0]?.fn({ draftId }) || null; } catch { /* ignore */ }
          try { diff = skillManager.getCapabilityProviders('forge.diff', ctx)[0]?.fn({ draftId, label: 'pre' }) || null; } catch { /* ignore */ }

          // 落一条结果日志：耗时/轮次/改动数/阻断数，复盘不靠猜（配合 llm.js 的失败日志）
          try {
            const sm = diff?.summary || {};
            const changed = Number(sm.added || 0) + Number(sm.changed || 0) + Number(sm.removed || 0);
            logger.info('forge-adapt', `草稿 ${draftId} ${timedOut ? '分段超时中止（有进展，进度已保留）' : '完成'}：${round} 轮 / ${Math.round((Date.now() - t0) / 1000)}s，改动 ${changed} 个文件，闸门阻断 ${gate2?.blocking ?? '?'} 项`);
          } catch { /* 日志失败不影响结果 */ }

          return json(res, 200, {
            ok: true, available: true,
            draftId, summary, model: modelName, rounds: round, trace, timedOut,
            gateBefore: gate, gate: gate2, diff
          });
        } catch (error) {
          // 失败也要留痕（含已跑轮次与耗时），用户问"卡在哪"时，日志能自证
          try {
            logger.warn('forge-adapt', `草稿 ${draftId} 适配失败：${String(error?.message ?? error)}（已跑 ${round} 轮 / ${Math.round((Date.now() - t0) / 1000)}s）`);
          } catch { /* ignore */ }
          return json(res, 500, { ok: false, available: true, error: `适配失败：${String(error?.message ?? error)}`, rounds: round });
        }
      }
    },
    {
      // 起草：模型用写工具把草稿写进暂存区（多轮工具循环，复用 /api/doctor/ask 的模式）
      //
      // 与「对话排查」的关键差别：那个是**只读**的，这个是**写**的，
      // 但写盘被插件的 confinement 关在暂存区内，出不了 plugin-data/extension-forge/staging/。
      // 起草完成后**不自动安装**，必须用户在前面点确认（见下面 /api/forge/install）。
      method: 'POST', pattern: '/api/forge/draft',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        // 修改模式（带 draftId）下 requirement 允许为空，原始需求从草稿元数据里取，
        // 输入框里装的是"本轮补充说明"（note）。新建模式 requirement 仍然必填。
        const requirement = String(body.requirement || '').trim();
        const note = String(body.note || '').trim().slice(0, 1000);
        const reviseDraftId = body.draftId ? String(body.draftId).trim() : '';
        if (!requirement && !reviseDraftId) return json(res, 400, { ok: false, error: '缺少 requirement' });
        if (requirement.length > 2000) return json(res, 400, { ok: false, error: '需求描述过长（上限 2000 字）' });

        const ctx = skillRuntimeContext();
        const provs = skillManager.getCapabilityProviders('forge.draft', ctx);
        if (!provs.length) {
          return json(res, 200, {
            ok: false, available: false,
            error: '「扩展锻造台」插件未启用（顶部「插件」页 → extension-forge）'
          });
        }

        // 工具集 + 运行环境（含 draftId）
        let toolDefs = [], toolCtx = null, draftId = '';
        try {
          const out = provs[0].fn({ draftId: reviseDraftId || null }) || {};
          toolDefs = Array.isArray(out.defs) ? out.defs : [];
          toolCtx = out.ctx || null;
          draftId = out.draftId || '';
        } catch (error) {
          return json(res, 500, { ok: false, available: true, error: `起草工具加载失败：${String(error?.message ?? error)}` });
        }
        if (!toolDefs.length) return json(res, 500, { ok: false, available: true, error: '锻造台没有提供写工具' });

        // 凭据（与自检页同源：doctorApi 开关对这里也生效，因为它就是"这套模型配置"）
        const cfg = getConfig();
        const d = cfg.doctorApi || {};
        const useOwn = d.enabled === true && String(d.model || '').trim();
        const overrides = useOwn ? {
          baseUrl: String(d.baseUrl || cfg.api?.baseUrl || ''),
          apiKey: String(d.apiKey || '').trim() || resolveApiKey(cfg),
          model: String(d.model).trim()
        } : null;
        const modelName = useOwn ? overrides.model : cfg.api?.model;
        if (!modelName) {
          return json(res, 200, {
            ok: false, available: true,
            error: useOwn ? '自检专用模型未填 model（harness → 模型设置）' : '尚未配置聊天模型（设置 → 模型与搜索 → 模型 API）'
          });
        }

        // ── 修改模式上下文（draftId 已给定）──────────────────────────────────
        // 起草接口天然支持"在同一个草稿上继续写"（forge.draft 的 draftId 参数 + 覆盖写），
        // 但"从零起草"的教学 prompt 会把修改轮带偏，模型需要的是问题清单，不是格式课。
        // 这里喂给它三样东西：现有文件清单、上一轮闸门问题明细、原始需求。
        let reviseCtx = null;
        if (reviseDraftId) {
          let draftFiles = [];
          try {
            const rd = skillManager.getCapabilityProviders('forge.read-draft', ctx)[0]?.fn({ draftId: reviseDraftId }) || {};
            draftFiles = Array.isArray(rd.files) ? rd.files.map((f) => f.path) : [];
          } catch { /* ignore */ }
          if (!draftFiles.length) {
            return json(res, 200, { ok: false, available: true, error: `草稿 ${reviseDraftId} 不存在或为空（可能已被丢弃）` });
          }
          let gate = null;
          try { gate = skillManager.getCapabilityProviders('forge.gate', ctx)[0]?.fn({ draftId: reviseDraftId }) || null; } catch { /* ignore */ }
          let meta = null;
          try { meta = skillManager.getCapabilityProviders('forge.load-meta', ctx)[0]?.fn({ draftId: reviseDraftId }) || null; } catch { /* ignore */ }
          reviseCtx = {
            files: draftFiles,
            gate,
            // 原始需求：草稿元数据优先（跨会话持久化），前端回传兜底（老草稿可能没有元数据）
            requirement: String(meta?.requirement || requirement || '')
          };
        }

        // ── 起草的三块内部构件 ──
        // 抽成局部函数：闸门失败后要**自动修复**（把问题清单喂回去重跑），
        // 修复轮的 sys 与工具循环必须能在同一请求内复用，复制粘贴两份迟早分叉。

        /** 金标准示例（few-shot）：给模型看"好扩展长什么样"，比十条规则更有效。 */
        const buildGoldenSection = () => {
          try {
            // ⚠️ extension-forge 已内置化到 src/harness/forge/（见 src/harness/index.js），
            //    旧路径 plugins/extension-forge/examples 已删除。路径写错不会报错，
            //    下面的 catch 会静默返回空串，只是起草质量悄悄变差。
            //    用 ROOT 而不是 DATA_DIR：后者可被 QQ_AGENT_DATA_DIR 指到任意目录。
            const exDir = path.join(ROOT, 'src', 'harness', 'forge', 'examples');
            const j = fs.readFileSync(path.join(exDir, 'golden-skill.json'), 'utf8').trim();
            const js = fs.readFileSync(path.join(exDir, 'golden-skill.js'), 'utf8').trim();
            return [
              '',
              '── 金标准示例（照这个水准与风格写）──',
              '下面是一个真实可跑、五道闸门全过的技能。学它的**味道**：description 具体到触发场景、',
              'execute 先校验参数且错误信息告诉用户怎么改、返回短小、零危险依赖。',
              '（示例本身也遵守全部禁区 —— 不要模仿示例里没出现的写法。）',
              '── golden-skill.json ──',
              j,
              '── golden-skill.js（入口 index.js）──',
              js,
              ''
            ].join('\n');
          } catch {
            return '';   // 示例缺失只降质量，不阻塞起草
          }
        };

        /** 修改/修复轮 sys：草稿现状 + 最新闸门问题清单 + 原始需求。 */
        const buildReviseSys = (gateNow, noteNow) => {
          let files = [];
          try {
            const rd = skillManager.getCapabilityProviders('forge.read-draft', ctx)[0]?.fn({ draftId }) || {};
            files = Array.isArray(rd.files) ? rd.files.map((f) => f.path) : [];
          } catch { /* 读失败时文件清单为空，模型按问题清单自行判断 */ }
          let requirement0 = '';
          try {
            const meta = skillManager.getCapabilityProviders('forge.load-meta', ctx)[0]?.fn({ draftId }) || null;
            requirement0 = String(meta?.requirement || requirement || '');
          } catch { requirement0 = requirement; }

          const issues = (gateNow?.issues || []);
          const issueText = issues.length
            ? issues.map((i, n) => {
              const lv = i.level === 'block' ? '⛔阻断' : (i.level === 'confirm' ? '⚠️需确认' : '💡提示');
              const snip = i.snippet ? `\n   片段：\n   ${String(i.snippet).slice(0, 800).replace(/\n/g, '\n   ')}` : '';
              return `${n + 1}. [${lv}] ${i.title}${i.why ? `\n   原因：${i.why}` : ''}${snip}`;
            }).join('\n')
            : '（上一轮没有留下结构化结论 —— 请自己读文件找问题）';

          return [
            '你是 QQ Agent 的扩展锻造师。暂存区里已有一个扩展草稿，你的任务是**在这个草稿上继续修改**，把它修到能用、能过闸门。',
            '',
            '── 草稿现状 ──',
            `draftId：${draftId}`,
            '文件（改之前先用 forge_read_file 读，不要凭想象改）：',
            ...files.map((p) => `  ${p}`),
            '',
            '── 这个扩展的原始需求 ──',
            requirement0 || '（没有记录 —— 从草稿内容与问题清单推断它该做什么）',
            '',
            '── 上一轮闸门结论（要修的就是这些）──',
            issueText,
            ...(noteNow ? ['', '── 用户本轮的补充说明（优先按这个改）──', noteNow] : []),
            '',
            '── 修改纪律 ──',
            '1. **不要推倒重来**：保留已写对的部分，只修问题。',
            '2. forge_write_file 是**覆盖写**，必须写**完整文件**，不是补丁片段。',
            '3. 需要删文件用 forge_delete_file，不要留死文件。',
            '4. 仍然不要写会被闸门一票否决的东西：child_process / execSync / spawn /',
            '   process.exit() / 读 account.json 等凭据 / 路径带 .. / 生成 .exe .bat .sh 等文件。',
            '5. 尽量把"⚠️需确认"的项也一并修掉（如 eval / fetch）—— 拿不准就保留并在说明里讲清用途。',
            '6. 改完用一段话说明改了什么、为什么。不要再调工具 —— 闸门与确认由界面负责。',
            '',
            '── 格式底线（闸门会查）──',
            '清单：id（[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}）/ name / version / apiVersion: 1 / entry / description；',
            'tools[].id 必须与 registerTool 的 id 一致；permissions 只认 web_fetch；enabledByDefault 固定 false。'
          ].join('\n');
        };

        /** 新建轮 sys：格式教学 + 金标准示例 + 禁区 + 工作方式 + 计划 + 需求。 */
        const buildCreateSys = (req, planText) => [
          '你是 QQ Agent 的扩展锻造师。你的工作是把用户的需求变成一份**可用的扩展**（技能或插件），',
          '写好草稿文件，交给闸门检查，最后由用户确认安装。',
          '',
          '── 你能做什么 ──',
          '用工具把文件写进**当前草稿**（暂存区）。写进去不会立刻生效 —— 要用户确认后才安装。',
          '所以你只管把文件写对，不需要考虑"会不会影响正在运行的系统"。',
          '',
          '── 两种扩展的区别（先判断用户要哪一种）──',
          '· **技能（skill）**：用 skill.json + index.js。适合"给模型新增一个能调用的工具"，',
          '  例如查询、计算、读某个数据源。模型会因为 prompt.when 描述的场景而主动调用。',
          '· **插件（plugin）**：用 plugin.json + index.js。适合"改变系统行为"，',
          '  例如拦截消息、改写回复、提供能力给别的扩展。靠 providers / hooks 工作。',
          '  绝大多数需求应该是**技能** —— 除非用户明确说要改变行为而不是加工具。',
          '',
          '── skill.json 的格式（照抄字段名，值按需改）──',
          JSON.stringify({
            id: 'my-tool', name: '我的工具', version: '1.0.0', apiVersion: 1,
            category: 'utility',
            description: '一句话说明这个扩展做什么（会显示在扩展列表里）',
            author: 'AI 生成',
            // ⚠️ 固定写 false：自创扩展**装完默认是关闭的**，用户去扩展列表里亲自开启。
            //    这是刻意的安全默认：生成的代码会真的在本机执行，
            //    "装上了但还没开"给了人一个在它生效前再看一眼的机会。
            //    （即使这里写成 true，安装时也会被强制关掉，见 /api/forge/install。）
            enabledByDefault: false,
            entry: 'index.js',
            settings: {},
            configSchema: {},
            prompt: {
              when: '当用户……时（描述调用场景，这段会进系统提示词）',
              examples: ['示例请求 1', '示例请求 2'],
              instruction: '调用 my_tool 工具，参数……'
            },
            tools: [{
              id: 'my_tool', name: '我的工具', description: '工具做什么',
              category: 'system', icon: '🔧',
              parameters: {
                type: 'object',
                properties: { input: { type: 'string', description: '参数说明' } },
                required: ['input']
              }
            }]
          }, null, 2),
          '',
          '── index.js 的格式（技能）──',
          '```js',
          'export function register(api) {',
          '  api.registerTool({',
          "    id: 'my_tool',            // 必须与 skill.json 里 tools[].id 一致",
          "    name: '我的工具',",
          "    description: '工具做什么（模型靠这句话决定何时调用）',",
          '    parameters: { /* 与清单里一致 */ },',
          '    async execute(ctx, args) {',
          "      return { content: '给模型看的文本结果' };",
          '      // 失败时：return { content: \'错误：...\', isError: true };',
          '    }',
          '  });',
          '}',
          '```',
          '可用的 api：`api.registerTool(def)`、`api.config()`（读清单 settings 里声明的配置）、',
          '`api.log(...)` / `api.warn(...)` / `api.error(...)`、`api.isSkillActive(id)`、',
          '`api.capability(name, args)`（软依赖别的扩展提供的能力）。',
          buildGoldenSection(),
          // plan-then-write：计划是模型在计划轮**自己定的方向**，对"自己说过的话"的
          // 服从性远高于对外部规则，这正是单独跑一轮计划的价值所在。
          ...(planText ? [
            '',
            '── 已批准的起草计划（上一轮定下的方向，动笔必须与它一致；',
            '   确实发现计划有硬伤才允许偏离，且必须在收尾说明里讲清为什么）──',
            planText,
            ''
          ] : []),
          '── ⛔ 绝对不要写的（会被闸门一票否决，白费一轮）──',
          '· `child_process` / `execSync` / `spawn` —— shell 执行，禁止',
          '· `process.exit()` —— 会杀掉整个应用，禁止',
          '· 读 `account.json` / `.env` 等凭据文件 —— 禁止',
          '· 路径里出现 `..` —— 禁止',
          '· 生成 `.exe` / `.bat` / `.sh` 等文件 —— 禁止（只允许 js/json/md/txt/css/html）',
          '',
          '── ⚠️ 会被标红要求用户确认的（尽量避开，能不用就不用）──',
          '· `eval` / `new Function`（若确实要算表达式，务必先用正则把入参限制成数字与运算符）',
          '· `fetch` / 联网（除非需求本身就要联网，且要写进 permissions: ["web_fetch"]）',
          '· `fs.unlinkSync` 等删除操作（不要删文件）',
          '· 读 `process.env`（环境变量里有机密；要配置用 api.config()）',
          '· 动态 `import(变量)`（所有静态检查都会失效；用静态 import 或 import 字符串字面量）',
          '· 向 `plugins/` / `skills/` / `config.json` 等应用路径写文件（等于自装后门，会被拦下）',
          '· `setInterval` 不配 `clearInterval`（定时器泄漏；创建与清理要成对出现）',
          '',
          '── 工作方式 ──',
          '1. 先想清楚要几个文件。正常情况**只需要 2 个**：清单 + index.js。不要过度设计。',
          '2. 用 forge_write_file 把文件写进去。写完可以用 forge_read_file 读回来确认。',
          '3. 不确定用户意图时，**先按最合理的假设做出来** —— 不要停下来追问，这里没有对话轮次，',
          '   返工靠用户看完说明点"继续修改"。',
          '4. 全部写完后给用户的说明**固定三段、假设放最前面**（很多用户不会写提示词，',
          '   你的假设就是他唯一能核对的东西 —— 必须一眼看到）：',
          '   ❶ ❓假设：最多 2 条，每条一行，只列影响功能方向的关键决定（参数怎么触发、数据从哪来等）；',
          '   ❷ 做了什么（一两句话，说清装上后怎么用）；',
          '   ❸ 需要注意什么（比如要联网、要在哪里开启）。',
          '   不要再调用工具 —— 闸门与确认由界面负责。',
          '5. 收尾时**提醒一句**：它装完是**关闭状态**，要去顶部的「技能」/「插件」页里手动开启才会生效。',
          '',
          '── 需求 ──',
          req
        ].join('\n');

        /**
         * 跑一轮"模型 + 写工具"循环（240s 自杀钟）。
         * 返回 { summary, rounds, trace }；summary 为空表示轮次耗尽模型没给收尾话。
         */
        const runDraftLoop = async (sysText, userText, tagPrefix) => {
          const ac = new AbortController();
          const timer = setTimeout(() => ac.abort(new Error('起草超时（240s）')), 240000);
          const messages = [
            { role: 'system', content: sysText },
            { role: 'user', content: userText }
          ];
          const openAiTools = toOpenAiTools(toolDefs);
          const MAX_ROUNDS = 8;
          const trace = [];
          let summary = '';
          let rounds = 0;

          try {
            for (let round = 0; round < MAX_ROUNDS; round++) {
              rounds = round + 1;
              const left = MAX_ROUNDS - round;
              if (left <= 2 && left > 0) {
                messages.push({
                  role: 'user',
                  content: `【系统提醒】起草轮次只剩 ${left} 轮。请立刻停止调用工具，用一段话说明你写了什么、有什么假设。`
                });
              }
              const r = await chatCompletionWithRetry({
                messages,
                tools: openAiTools,
                temperature: 0.2,
                signal: ac.signal,
                overrides,
                // 起草要写代码，思考有帮助，但服务端强制思考时 reasoning 会吃 max_tokens，
                // 且这里有多轮兜底（没工具调用时正文才重要），所以关掉换取确定性。
                skillContext: { thinkingMode: 'off' },
                tag: `${tagPrefix}:r${round}`
              });
              const msg = r?.message || {};
              const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
              if (!calls.length) {
                summary = typeof msg.content === 'string' ? msg.content : '';
                break;
              }
              messages.push({ role: 'assistant', content: msg.content ?? null, tool_calls: calls });
              for (const call of calls) {
                if (ac.signal.aborted) break;
                const name = call?.function?.name || '';
                const argsRaw = call?.function?.arguments ?? '{}';
                let args = {};
                try { args = JSON.parse(argsRaw); } catch { args = { _raw: argsRaw }; }
                const result = await executeTool(toolDefs, toolCtx, name, argsRaw);
                const text = typeof result.content === 'string' ? result.content : String(result.content ?? '');
                messages.push({ role: 'tool', tool_call_id: call.id, name, content: text });
                trace.push({
                  round: rounds, tool: name, args,
                  isError: !!result.isError,
                  summary: text.replace(/\s+/g, ' ').slice(0, 200)
                });
              }
            }
          } finally {
            clearTimeout(timer);
          }
          return { summary, rounds, trace };
        };

        try {
          // ── plan-then-write（仅新建模式）：先让模型出一份 3-5 行起草计划 ──
          // 为什么单独一轮：模型"上来就写"最容易写错方向（工具怎么拆、放几个），
          // 方向错了修复轮极贵。用一次极小的调用（30s 自杀钟、无工具）把方向定下来，
          // 起草轮再被自己批准的计划约束。计划失败/为空 → 退回直接起草，不阻塞。
          let plan = '';
          if (!reviseCtx) {
            try {
              const ac = new AbortController();
              const timer = setTimeout(() => ac.abort(new Error('计划超时（30s）')), 30000);
              try {
                const rp = await chatCompletionWithRetry({
                  messages: [
                    { role: 'system', content: '你是 QQ Agent 的扩展锻造师。用户会给你一个扩展需求，你**只输出起草计划**，不写任何代码、不调用任何工具。' },
                    { role: 'user', content: `需求：${requirement}\n\n输出 3-5 行计划，覆盖：\n1. 扩展类型（技能/插件）与建议 id\n2. 工具数量与各自职责（一行一个）\n3. 关键假设（最多 2 条，❓开头）\n只输出计划本身，不要寒暄、不要输出代码。` }
                  ],
                  temperature: 0.2,
                  signal: ac.signal,
                  overrides,
                  skillContext: { thinkingMode: 'off' },
                  tag: 'forge-plan'
                });
                plan = typeof rp?.message?.content === 'string' ? rp.message.content.trim().slice(0, 1200) : '';
              } finally {
                clearTimeout(timer);
              }
            } catch { /* 计划失败不阻塞起草 */ }
          }

          // 首轮：修改模式喂闸门问题清单 + 补充说明；新建模式喂教学 prompt + 计划 + 需求
          const first = await runDraftLoop(
            reviseCtx ? buildReviseSys(reviseCtx.gate, note) : buildCreateSys(requirement, plan),
            reviseCtx ? (note || '请按上面的闸门问题清单修复这个草稿。') : requirement,
            'forge-draft'
          );
          let summary = first.summary;
          let rounds = first.rounds;
          const trace = [...first.trace];

          // 原始需求持久化：修改轮 / 跨会话打开老草稿时，模型才知道"当初要做什么"。
          // 只在新草稿时写：修改轮需求没变（变化的部分走 note），重写反而可能覆盖掉更早的记录。
          if (!reviseCtx && draftId) {
            try {
              skillManager.getCapabilityProviders('forge.save-meta', ctx)[0]?.fn({ draftId, requirement });
            } catch { /* 元数据失败不影响起草结果 */ }
          }

          // 起草完立刻跑闸门，让用户看到的是"已经检查过的"草稿
          const gateProv = skillManager.getCapabilityProviders('forge.gate', ctx)[0];
          const runGate = () => {
            try { return gateProv ? gateProv.fn({ draftId }) : null; }
            catch (error) { return { ok: false, error: String(error?.message ?? error) }; }
          };
          let gate = runGate();

          // ── 自动修复：把平台的反馈回路转起来 ──
          // 闸门有 ⛔阻断 项时不再等用户点"继续修改"，问题清单本来就是修复 prompt，
          // 模型看到行号和原因就能修。上限 2 轮 + 总时限 8 分钟（防无限循环烧钱）。
          // confirm 项不算失败，那是留给用户的放行决定，机器不该替人点头。
          let autoFixAttempts = 0;
          const fixDeadline = Date.now() + 8 * 60000;
          while (gate && Number(gate.blocking) > 0 && autoFixAttempts < 2 && Date.now() < fixDeadline) {
            autoFixAttempts += 1;
            const fix = await runDraftLoop(
              buildReviseSys(gate, ''),
              '请按上面的闸门问题清单修复这个草稿。逐项修，修完不要再调工具。',
              `forge-autofix${autoFixAttempts}`
            );
            trace.push(...fix.trace);
            rounds += fix.rounds;
            if (fix.summary) summary = fix.summary;
            gate = runGate();
          }

          return json(res, 200, {
            ok: true, available: true,
            draftId, summary, model: modelName, rounds,
            trace, gate, autoFixAttempts, plan
          });
        } catch (error) {
          return json(res, 500, { ok: false, available: true, error: `起草失败：${String(error?.message ?? error)}` });
        }
      }
    },
    {
      // 重跑闸门（用户手改过草稿、或只想复核时）
      method: 'POST', pattern: '/api/forge/gate',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const ctx = skillRuntimeContext();
        const provs = skillManager.getCapabilityProviders('forge.gate', ctx);
        if (!provs.length) return json(res, 200, { ok: false, available: false, error: '「扩展锻造台」插件未启用' });
        try {
          return json(res, 200, { available: true, gate: provs[0].fn({ draftId: body.draftId }) });
        } catch (error) {
          return json(res, 500, { ok: false, available: true, error: String(error?.message ?? error) });
        }
      }
    },
    {
      // 签发「人工确认票据」，安装的唯一钥匙。
      //
      // 单独一条路由，而不是让 install 自己判断"是不是人在点"：后端看不见"人"，
      // 它能看见的只有"这个请求是不是控制台自己发的"，那正是 keyEndpointAllowed
      // 在判的事（渲染进程私有的 32 字节凭据，由主进程 webRequest 注入、不落盘、
      // 不进 DOM；或用户自配的 server.token）。签票与用票分开，票再绑内容摘要，
      // 于是"人看到的那份 == 将要落盘的那份"才成立。
      method: 'POST', pattern: '/api/forge/confirm',
      handler: async ({ req, res, json }) => {
        if (!keyEndpointAllowed(req)) {
          return json(res, 403, {
            ok: false,
            error: '确认安装只能从控制台窗口发起（当前请求没有控制台凭据）。'
              + '用外部浏览器打开控制台的话，先在设置里配置「服务 token」，'
              + '再用 控制台地址?token=<你的token> 打开 —— 那道凭据就是"人在现场"的依据。'
          });
        }
        const body = await bodyOf(req);
        const ctx = skillRuntimeContext();
        const provs = skillManager.getCapabilityProviders('forge.confirm-ticket', ctx);
        if (!provs.length) return json(res, 200, { ok: false, available: false, error: '「扩展锻造台」未就绪' });
        try {
          const out = provs[0].fn({
            draftId: body.draftId,
            digest: String(body.digest || ''),
            // 走到这里 = 控制台里有人点了按钮。这不是"系统自动确认"，
            // 而是"能拿到控制台私有凭据的那一端说人点了"。
            human: true
          });
          if (out?.ok) {
            log('info', `[forge] 人工确认：草稿 ${String(body.draftId)}（摘要 ${String(out.digest || '').slice(0, 12)}…，10 分钟内有效）`);
          }
          return json(res, 200, { available: true, ...out });
        } catch (error) {
          return json(res, 500, { ok: false, available: true, error: String(error?.message ?? error) });
        }
      }
    },
    {
      // 安装：把放行过的草稿搬进 skills/ 或 plugins/（之后热重载自动装载）
      //
      // ⚠️ 插件内部会**再跑一次闸门**，不信任"前端说它检查过了"。
      //    闸门结论与安装之间隔着人工确认，期间草稿可能被改动。
      // ⚠️ 还必须带 /api/forge/confirm 签发的票据：闸门通过 ≠ 有人同意装。
      method: 'POST', pattern: '/api/forge/install',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const ctx = skillRuntimeContext();
        const provs = skillManager.getCapabilityProviders('forge.install', ctx);
        if (!provs.length) return json(res, 200, { ok: false, available: false, error: '「扩展锻造台」插件未启用' });
        // 兜底：确认票据能力必须存在。缺了说明跑的是旧版锻造台（plugins/ 下还留着旧副本，
        // 或应用没重启），那种 install 不验票，不能让它承载"人工确认"这条链路。
        if (!skillManager.getCapabilityProviders('forge.confirm-ticket', ctx).length) {
          return json(res, 503, {
            ok: false,
            error: '扩展锻造台版本过旧（缺少「确认票据」能力）—— 请重启应用后再安装。本次未做任何改动。'
          });
        }
        try {
          const out = provs[0].fn({
            draftId: body.draftId,
            confirmIssues: body.confirmIssues === true,
            approvalToken: String(body.approvalToken || '')
          });

          // ── 装上之后**强制置为关闭** ──────────────────────────────────
          //
          // 为什么在核心做、而不是交给插件或靠模型自觉：
          //   1. 模型写清单时基本会照抄提示词模板，它给不给 enabledByDefault:false 不可靠，
          //      写配置是"无论生成物怎么写都生效"的那条路。
          //   2. 配置的优先级高于清单（`isSkillEnabledInConfig`：有配置看配置，没配置才看清单），
          //      所以写一条 `skills.<id>.enabled = false` 就能盖过清单里写死的 true。
          //   3. 写 skills 配置本来就是核心的职责（UI 的开关走的也是 setSkillEnabled），
          //      插件不该去动别家扩展的配置。
          //
          // 语义是"装好后先别跑，等你亲自开"：用户去扩展列表点一下开启即可，之后一切照旧。
          let autoDisabled = false;
          if (out?.ok && out.id) {
            try {
              setSkillEnabled(out.id, false);
              autoDisabled = true;
            } catch { /* 写配置失败不该让安装整体算失败，如实告诉前端即可 */ }
          }

          return json(res, 200, { available: true, ...out, autoDisabled });
        } catch (error) {
          return json(res, 500, { ok: false, available: true, error: String(error?.message ?? error) });
        }
      }
    },
    {
      // 丢弃草稿
      method: 'POST', pattern: '/api/forge/discard',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const ctx = skillRuntimeContext();
        const provs = skillManager.getCapabilityProviders('forge.discard', ctx);
        if (!provs.length) return json(res, 200, { ok: false, available: false, error: '「扩展锻造台」插件未启用' });
        try {
          return json(res, 200, { available: true, ...provs[0].fn({ draftId: body.draftId }) });
        } catch (error) {
          return json(res, 500, { ok: false, available: true, error: String(error?.message ?? error) });
        }
      }
    },

    // ── 升级已有扩展（harness → 升级扩展）──────────────────────────────────
    // 与 forge.install 的分界：install 靠"撞车加 _1"永不覆盖；升级靠 manifest.id
    // 一致性覆盖原目录（插件侧强制备份 + 失败自恢复）。详见 src/harness/forge/。

    {
      // 已装扩展清单（可升级对象）。不读内存注册表读磁盘清单：升级要对的是"目录里的版本"
      method: 'GET', pattern: '/api/forge/installed',
      handler: async ({ res, json }) => {
        const ctx = skillRuntimeContext();
        const provs = skillManager.getCapabilityProviders('forge.installed', ctx);
        if (!provs.length) return json(res, 200, { ok: false, available: false, error: '「扩展锻造台」插件未启用' });
        try { return json(res, 200, { available: true, ...provs[0].fn({}) }); }
        catch (error) { return json(res, 500, { ok: false, available: true, error: String(error?.message ?? error) }); }
      }
    },
    {
      // 以某个已装扩展为底，复制进暂存区作为升级草稿
      method: 'POST', pattern: '/api/forge/upgrade-start',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const ctx = skillRuntimeContext();
        const provs = skillManager.getCapabilityProviders('forge.upgrade-start', ctx);
        if (!provs.length) return json(res, 200, { ok: false, available: false, error: '「扩展锻造台」插件未启用' });
        try {
          return json(res, 200, {
            available: true,
            ...provs[0].fn({ kind: body.kind, dir: body.dir })
          });
        } catch (error) {
          return json(res, 500, { ok: false, available: true, error: String(error?.message ?? error) });
        }
      }
    },
    {
      // 对话升级：模型读草稿副本、按用户的升级要求修改，改完自动跑闸门 + 对比原版
      method: 'POST', pattern: '/api/forge/upgrade',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const draftId = String(body.draftId || '').trim();
        const note = String(body.note || '').trim().slice(0, 2000);
        if (!draftId) return json(res, 400, { ok: false, error: '缺少 draftId' });
        if (!note) return json(res, 400, { ok: false, error: '缺少升级要求（note）' });

        const ctx = skillRuntimeContext();
        const provs = skillManager.getCapabilityProviders('forge.draft', ctx);
        if (!provs.length) return json(res, 200, { ok: false, available: false, error: '「扩展锻造台」插件未启用' });

        // ── 收集上下文：草稿现状 + 原版信息 + 本地环境 ──
        let draftFiles = [];
        try {
          const rd = skillManager.getCapabilityProviders('forge.read-draft', ctx)[0]?.fn({ draftId }) || {};
          draftFiles = Array.isArray(rd.files) ? rd.files : [];
        } catch { /* ignore */ }
        if (!draftFiles.length) return json(res, 200, { ok: false, available: true, error: '草稿不存在或为空' });

        let meta = null;
        try { meta = skillManager.getCapabilityProviders('forge.load-meta', ctx)[0]?.fn({ draftId }) || null; } catch { /* ignore */ }
        const up = meta?.upgradeOf || null;

        let env = null;
        try { env = skillManager.getCapabilityProviders('forge.env', ctx)[0]?.fn({}) || null; } catch { /* ignore */ }

        let toolDefs = [], toolCtx = null;
        try {
          const out = provs[0].fn({ draftId }) || {};
          toolDefs = Array.isArray(out.defs) ? out.defs : [];
          toolCtx = out.ctx || null;
        } catch (error) {
          return json(res, 500, { ok: false, available: true, error: `写工具加载失败：${String(error?.message ?? error)}` });
        }

        const cfg = getConfig();
        const d = cfg.doctorApi || {};
        const useOwn = d.enabled === true && String(d.model || '').trim();
        const overrides = useOwn ? {
          baseUrl: String(d.baseUrl || cfg.api?.baseUrl || ''),
          apiKey: String(d.apiKey || '').trim() || resolveApiKey(cfg),
          model: String(d.model).trim()
        } : null;
        const modelName = useOwn ? overrides.model : cfg.api?.model;
        if (!modelName) return json(res, 200, { ok: false, available: true, error: '尚未配置聊天模型（设置 → 模型与搜索 → 模型 API）' });

        // 草稿全文（总量截断，大扩展靠文件清单 + forge_read_file 兜底）
        let budget = 40000;
        const fileText = draftFiles.map((f) => {
          const content = String(f.content || '').slice(0, Math.max(0, budget));
          budget -= content.length;
          return `── ${f.path} ──\n${content}${String(f.content || '').length > content.length ? '\n…（已截断）' : ''}`;
        }).join('\n\n');

        const sys = [
          '你在**升级**一个已安装的 QQ Agent 扩展。暂存区里已有一份它的完整副本（草稿），',
          '你的任务是按用户的要求修改这份副本 —— 改完后由闸门检查、用户确认，才会覆盖安装回原位。',
          '',
          '── 扩展现状 ──',
          up ? `目标扩展：${up.id}（${up.kind === 'plugin' ? '插件' : '技能'}）当前版本 v${up.version || '?'}，目录 ${up.dir}` : '（缺少升级目标信息）',
          '草稿文件：',
          ...draftFiles.map((f) => `  ${f.path}`),
          '',
          '── 草稿当前内容 ──',
          fileText,
          '',
          '── 本地环境（改之前必须对齐）──',
          `本地 createSkillApi 提供的成员：${(env?.knownApis || []).join(' / ')}`,
          `本地认的权限只有：${(env?.knownPermissions || []).join(' / ')}`,
          `本机已装的扩展 id：${(env?.existingIds || []).slice(0, 40).join('、') || '（无）'}`,
          '',
          '── 升级纪律（违反会造成真实损失）──',
          '1. **manifest.id 绝对不能改** —— id 变了等于装了个新扩展：旧配置、启用状态、',
          '   会话里的调用习惯全部失联。这是升级场景的铁律。',
          '2. version 按语义递增：小修 +0.0.1，新增能力 +0.1.0，大改 +1.0.0。',
          '3. **工具向后兼容**：已有工具的 id 与参数结构尽量保持；新增随意，改旧签名要慎重。',
          '4. 不要写会被闸门一票否决的东西：child_process / execSync / spawn / process.exit() /',
          '   读 account.json 等凭据 / 路径带 .. / 生成 .exe .bat .sh 等文件。',
          '5. forge_write_file 是覆盖写，必须写**完整文件**；不要的文件用 forge_delete_file 删。',
          '6. **清单字段一个都不能丢**：重写 skill.json / plugin.json 时**逐字段对照上面的原文**，',
          '   必填：id / name / version / apiVersion: 1 / entry / description / enabledByDefault: false。',
          '   丢任何一个（最常见是 apiVersion）都会被闸门结构检查一票否决 —— 不要凭记忆重打清单。',
          '7. 改完用一段话说明：改了什么、为什么、版本号为什么这么递增。',
          '   不要再调工具 —— 闸门与确认由界面负责。',
          '',
          '── 用户的升级要求 ──',
          note
        ].join('\n');

        try {
          const ac = new AbortController();
          const timer = setTimeout(() => ac.abort(new Error('升级超时（240s）')), 240000);
          const messages = [
            { role: 'system', content: sys },
            { role: 'user', content: note }
          ];
          const openAiTools = toOpenAiTools(toolDefs);
          const MAX_ROUNDS = 8;
          const trace = [];
          let summary = '';
          let rounds = 0;

          /**
           * 一段"模型 + 写工具"循环。首轮与自动修复轮共用同一 messages 上下文
           * （模型记得自己改过什么），各有独立的 240s 自杀钟（signal 注入）。
           */
          const runLoop = async (tagPrefix, signal) => {
            for (let round = 0; round < MAX_ROUNDS; round++) {
              rounds += 1;
              const left = MAX_ROUNDS - round;
              if (left <= 2 && left > 0) {
                messages.push({
                  role: 'user',
                  content: `【系统提醒】本轮轮次只剩 ${left} 轮。请立刻停止调用工具，用一段话说明你改了什么、为什么改。`
                });
              }
              const r = await chatCompletionWithRetry({
                messages,
                tools: openAiTools,
                temperature: 0.2,
                signal,
                overrides,
                skillContext: { thinkingMode: 'off' },
                tag: `${tagPrefix}:r${round}`
              });
              const msg = r?.message || {};
              const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
              if (!calls.length) { summary = typeof msg.content === 'string' ? msg.content : ''; break; }
              messages.push({ role: 'assistant', content: msg.content ?? null, tool_calls: calls });
              for (const call of calls) {
                if (signal.aborted) break;
                const name = call?.function?.name || '';
                const argsRaw = call?.function?.arguments ?? '{}';
                let args = {};
                try { args = JSON.parse(argsRaw); } catch { args = { _raw: argsRaw }; }
                const result = await executeTool(toolDefs, toolCtx, name, argsRaw);
                const text = typeof result.content === 'string' ? result.content : String(result.content ?? '');
                messages.push({ role: 'tool', tool_call_id: call.id, name, content: text });
                trace.push({ round: rounds, tool: name, args, isError: !!result.isError, summary: text.replace(/\s+/g, ' ').slice(0, 200) });
              }
            }
          };

          try {
            await runLoop('forge-upgrade', ac.signal);
          } finally {
            clearTimeout(timer);
          }

          // 改完：跑闸门 + 与已装原版对比（"更新了什么"）
          const runGateDiff = () => {
            let g = null, df = null;
            try { g = skillManager.getCapabilityProviders('forge.gate', ctx)[0]?.fn({ draftId }) || null; } catch { /* ignore */ }
            try { df = skillManager.getCapabilityProviders('forge.compare-installed', ctx)[0]?.fn({ draftId }) || null; } catch { /* ignore */ }
            return { gate: g, diff: df };
          };
          let { gate, diff } = runGateDiff();

          // ── 自动修复：升级路径与 draft 同款反馈回路 ──
          // 闸门有 ⛔阻断 时把问题清单喂回同一上下文重跑（模型记得自己刚改了什么），
          // 上限 2 轮 / 总时限 8 分钟。confirm 项不算失败，那是留给用户的放行决定。
          let autoFixAttempts = 0;
          const fixDeadline = Date.now() + 8 * 60000;
          while (gate && Number(gate.blocking) > 0 && autoFixAttempts < 2 && Date.now() < fixDeadline) {
            autoFixAttempts += 1;
            const issueText = (gate.issues || [])
              .map((i, n) => `${n + 1}. [${i.level === 'block' ? '⛔阻断' : i.level === 'confirm' ? '⚠️需确认' : '💡提示'}] ${i.title}${i.why ? ` —— ${String(i.why).slice(0, 300).replace(/\n/g, ' ')}` : ''}`)
              .join('\n');
            messages.push({
              role: 'user',
              content: `【系统】闸门仍有 ${gate.blocking} 项阻断，请逐项修复。要点：forge_write_file 是覆盖写（必须写完整文件）；`
                + `manifest.id 绝对不能改；清单必填字段（id / name / version / apiVersion: 1 / entry / description / enabledByDefault: false）一个都不能丢。\n`
                + `${issueText}\n修完用一句话说明改了什么，不要再调工具。`
            });
            const ac2 = new AbortController();
            const t2 = setTimeout(() => ac2.abort(new Error('修复轮超时（240s）')), 240000);
            try {
              await runLoop(`forge-upgrade-fix${autoFixAttempts}`, ac2.signal);
            } catch { break; }   // 修复轮 LLM 失败就停，别死循环
            finally { clearTimeout(t2); }
            ({ gate, diff } = runGateDiff());
          }

          return json(res, 200, {
            ok: true, available: true,
            draftId, summary, model: modelName, rounds, trace,
            gate, diff, autoFixAttempts
          });
        } catch (error) {
          return json(res, 500, { ok: false, available: true, error: `升级失败：${String(error?.message ?? error)}` });
        }
      }
    },
    {
      // 草稿 vs 已装原版的逐文件 diff（zip 升级路径：导入后先看"更新了什么"）
      method: 'POST', pattern: '/api/forge/compare',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const ctx = skillRuntimeContext();
        const provs = skillManager.getCapabilityProviders('forge.compare-installed', ctx);
        if (!provs.length) return json(res, 200, { ok: false, available: false, error: '「扩展锻造台」插件未启用' });
        try {
          return json(res, 200, { available: true, ...provs[0].fn({ draftId: body.draftId }) });
        } catch (error) {
          return json(res, 500, { ok: false, available: true, error: String(error?.message ?? error) });
        }
      }
    },
    {
      // 升级落地：备份原版 → 覆盖安装（id 一致性 + 闸门由插件强制校验）
      method: 'POST', pattern: '/api/forge/upgrade-install',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const ctx = skillRuntimeContext();
        const provs = skillManager.getCapabilityProviders('forge.upgrade-install', ctx);
        if (!provs.length) return json(res, 200, { ok: false, available: false, error: '「扩展锻造台」插件未启用' });
        if (!skillManager.getCapabilityProviders('forge.confirm-ticket', ctx).length) {
          return json(res, 503, {
            ok: false,
            error: '扩展锻造台版本过旧（缺少「确认票据」能力）—— 请重启应用后再升级。本次未做任何改动。'
          });
        }
        try {
          return json(res, 200, {
            available: true,
            ...provs[0].fn({
              draftId: body.draftId,
              kind: body.kind,
              dir: body.dir,
              confirmIssues: body.confirmIssues === true,
              // 覆盖已装扩展比装新的更不可逆，同样要人工确认票据（见 /api/forge/confirm）
              approvalToken: String(body.approvalToken || '')
            })
          });
        } catch (error) {
          return json(res, 500, { ok: false, available: true, error: String(error?.message ?? error) });
        }
      }
    },
    {
      // 回滚：恢复到最近一次升级前的备份
      method: 'POST', pattern: '/api/forge/rollback',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const ctx = skillRuntimeContext();
        const provs = skillManager.getCapabilityProviders('forge.rollback', ctx);
        if (!provs.length) return json(res, 200, { ok: false, available: false, error: '「扩展锻造台」插件未启用' });
        try {
          return json(res, 200, { available: true, ...provs[0].fn({ kind: body.kind, dir: body.dir }) });
        } catch (error) {
          return json(res, 500, { ok: false, available: true, error: String(error?.message ?? error) });
        }
      }
    },
    // ── 开发工单（dev-orders 插件）── 「开发模式」的传输层 ──────────────────
    // 纯传输层（与 /api/forge/* 同构）：核心不知道 "dev-orders" 是什么，按能力名问
    // "谁提供 dev.xxx"。白名单 / 会话存储 / 开发执行全在插件里。
    // 对话的**回复**不走这里，由 onMessage 钩子里核心递进来的发送队列直发 QQ；
    // 这里只管页面侧的读与写：看会话（snapshot/detail）、本机说话（send/new）、归档（close）。
    {
      method: 'GET', pattern: '/api/dev/snapshot',
      handler: async ({ res, json, url }) => {
        const ctx = skillRuntimeContext();
        const provs = skillManager.getCapabilityProviders('dev.snapshot', ctx);
        if (!provs.length) return json(res, 200, { ok: false, available: false, error: '「开发工单」插件未启用（顶部「插件」页 → dev-orders）' });
        try {
          // selected 透传：选中会话若不在服务端截断的最新 100 条里，由插件兜底追加，
          // 否则前端"选中项不在列表就复位"会每秒把用户选中清掉。
          const selected = String(url.searchParams.get('selected') || '');
          return json(res, 200, { available: true, ...provs[0].fn({ selected }) });
        } catch (error) { return json(res, 500, { ok: false, available: true, error: String(error?.message ?? error) }); }
      }
    },
    {
      method: 'POST', pattern: '/api/dev/whitelist',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const action = String(body.action || '');
        const cap = action === 'add' ? 'dev.whitelist-add' : (action === 'remove' ? 'dev.whitelist-remove' : '');
        if (!cap) return json(res, 400, { ok: false, error: 'action 必须是 add / remove' });
        const ctx = skillRuntimeContext();
        const provs = skillManager.getCapabilityProviders(cap, ctx);
        if (!provs.length) return json(res, 200, { ok: false, available: false, error: '「开发工单」插件未启用' });
        try { return json(res, 200, { available: true, ...provs[0].fn({ qq: body.qq }) }); }
        catch (error) { return json(res, 500, { ok: false, available: true, error: String(error?.message ?? error) }); }
      }
    },
    {
      // 本机对着一个会话说话（会并进同一个开发会话；回复留在页面，不发 QQ）。
      method: 'POST', pattern: '/api/dev/send',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const ctx = skillRuntimeContext();
        const provs = skillManager.getCapabilityProviders('dev.send', ctx);
        if (!provs.length) return json(res, 200, { ok: false, available: false, error: '「开发工单」插件未启用' });
        try { return json(res, 200, { available: true, ...provs[0].fn({ id: body.id, text: body.text }) }); }
        catch (error) { return json(res, 500, { ok: false, available: true, error: String(error?.message ?? error) }); }
      }
    },
    {
      // 本机开一个新会话（可带第一句话）。
      method: 'POST', pattern: '/api/dev/new',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const ctx = skillRuntimeContext();
        const provs = skillManager.getCapabilityProviders('dev.new-session', ctx);
        if (!provs.length) return json(res, 200, { ok: false, available: false, error: '「开发工单」插件未启用' });
        try { return json(res, 200, { available: true, ...provs[0].fn({ text: body.text }) }); }
        catch (error) { return json(res, 500, { ok: false, available: true, error: String(error?.message ?? error) }); }
      }
    },
    {
      // 归档一个会话（QQ 侧对等的命令是「退出开发」）。
      method: 'POST', pattern: '/api/dev/close',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const ctx = skillRuntimeContext();
        const provs = skillManager.getCapabilityProviders('dev.close', ctx);
        if (!provs.length) return json(res, 200, { ok: false, available: false, error: '「开发工单」插件未启用' });
        try { return json(res, 200, { available: true, ...provs[0].fn({ id: body.id }) }); }
        catch (error) { return json(res, 500, { ok: false, available: true, error: String(error?.message ?? error) }); }
      }
    },
    {
      // 重开旧工单：归档的工单回到 active，带着追加式上下文继续干。
      // QQ 侧对应「开发#6」。
      method: 'POST', pattern: '/api/dev/reopen',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const ctx = skillRuntimeContext();
        const provs = skillManager.getCapabilityProviders('dev.reopen', ctx);
        if (!provs.length) return json(res, 200, { ok: false, available: false, error: '「开发工单」插件未启用' });
        try { return json(res, 200, { available: true, ...provs[0].fn({ id: body.id }) }); }
        catch (error) { return json(res, 500, { ok: false, available: true, error: String(error?.message ?? error) }); }
      }
    },
    {
      // 中止正在跑的那一轮。
      // 没有它的话，跑飞的一轮最长要等 turnTimeoutSec（默认 1 小时），而且调度是全局单飞，
      // 那一轮不结束，**所有**会话都排队，界面只显示"模型正在干活…"，用户以为卡死。
      method: 'POST', pattern: '/api/dev/abort',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const ctx = skillRuntimeContext();
        const provs = skillManager.getCapabilityProviders('dev.abort', ctx);
        if (!provs.length) return json(res, 200, { ok: false, available: false, error: '「开发工单」插件未启用' });
        try { return json(res, 200, { available: true, ...provs[0].fn({ id: body.id }) }); }
        catch (error) { return json(res, 500, { ok: false, available: true, error: String(error?.message ?? error) }); }
      }
    },
    {
      // 永久删除一个会话（含开发记录与对话历史；沙箱产出文件保留）。
      method: 'POST', pattern: '/api/dev/delete',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const ctx = skillRuntimeContext();
        const provs = skillManager.getCapabilityProviders('dev.delete', ctx);
        if (!provs.length) return json(res, 200, { ok: false, available: false, error: '「开发工单」插件未启用' });
        try { return json(res, 200, { available: true, ...provs[0].fn({ id: body.id }) }); }
        catch (error) { return json(res, 500, { ok: false, available: true, error: String(error?.message ?? error) }); }
      }
    },
    {
      // 「开发工单」专用模型配置（与自检页同款：patch devApi 段；apiKey 留空=保留原值）。
      method: 'GET', pattern: '/api/dev/config',      handler: async ({ res, json }) => {
        const cfg = getConfig();
        const d = cfg.devApi || {};
        return json(res, 200, {
          ok: true,
          config: {
            enabled: d.enabled === true,
            baseUrl: String(d.baseUrl || ''),
            model: String(d.model || ''),
            hasApiKey: Boolean(String(d.apiKey || '').trim())
          },
          global: {
            baseUrl: String(cfg.api?.baseUrl || ''),
            model: String(cfg.api?.model || ''),
            hasApiKey: Boolean(resolveApiKey(cfg))
          },
          doctorApi: {
            enabled: (cfg.doctorApi || {}).enabled === true,
            model: String((cfg.doctorApi || {}).model || '')
          }
        });
      }
    },
    {
      method: 'POST', pattern: '/api/dev/config',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const patch = {};
        if (body.enabled !== undefined) patch.enabled = body.enabled === true;
        if (body.baseUrl !== undefined) patch.baseUrl = String(body.baseUrl || '').trim();
        if (body.model !== undefined) patch.model = String(body.model || '').trim();
        const rawKey = String(body.apiKey ?? '').trim();
        if (body.clearApiKey === true) patch.apiKey = '';
        else if (rawKey && rawKey !== '******') patch.apiKey = rawKey;
        if (!Object.keys(patch).length) return json(res, 400, { ok: false, error: '没有可写入的字段' });

        updateConfig({ devApi: patch });
        const d = getConfig().devApi || {};
        return json(res, 200, {
          ok: true,
          config: {
            enabled: d.enabled === true,
            baseUrl: String(d.baseUrl || ''),
            model: String(d.model || ''),
            hasApiKey: Boolean(String(d.apiKey || '').trim())
          }
        });
      }
    },
    {
      // 开发专用 Key 明文读取：与 /api/doctor/config-key 同一套来源校验（只放行控制台）。
      method: 'GET', pattern: '/api/dev/config-key',
      handler: async ({ req, res, json }) => {
        if (!keyEndpointAllowed(req)) return json(res, 403, { error: '请求来源不被信任，已拒绝读取明文密钥。' });
        const d = getConfig().devApi || {};
        return json(res, 200, { apiKey: String(d.apiKey || ''), hasApiKey: Boolean(String(d.apiKey || '').trim()) });
      }
    },
    {
      // 对话视图：增量读一个会话的"开发记录"（transcript）。
      // from = 不透明游标（插件侧语义是**字节偏移**，前端原样回传 nextFrom）；跑单时每秒拉一次，
      //   开销只有新增的那一段（整文件重读会让大文件把主线程拖死）。
      // before = 「载入更早」：往前翻一页（此时忽略 from）。
      method: 'GET', pattern: '/api/dev/detail',
      handler: async ({ res, json, url }) => {
        const ctx = skillRuntimeContext();
        const provs = skillManager.getCapabilityProviders('dev.order-detail', ctx);
        if (!provs.length) return json(res, 200, { ok: false, available: false, error: '「开发工单」插件未启用' });
        try {
          const id = String(url.searchParams.get('id') || '');
          const from = Number(url.searchParams.get('from') || 0) || 0;
          const before = Number(url.searchParams.get('before') || 0) || 0;
          return json(res, 200, { available: true, ...provs[0].fn({ id, from, before }) });
        } catch (error) {
          return json(res, 500, { ok: false, available: true, error: String(error?.message ?? error) });
        }
      }
    },
    // ── 导入备份与回滚（数据入口只剩「打包 / 接收」，但它的收尾能力留在这里）──
    // 「数据移植」页已删除（被「打包 / 接收」取代），/api/migrate/scan 与
    // /api/migrate/apply 一并下线：那个页面是它们唯一的调用方，留着就是一条
    // 没人用、也没人测的写盘入口。备份与回滚保留，整包导入的数据落地仍然走
    // migrate.applyImport，它写出的 backup 必须能在界面上回滚。
    {
      method: 'POST', pattern: '/api/migrate/rollback',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const rebuildChat = async (chatKey) => {
          const ctx = skillRuntimeContext();
          const provs = skillManager.getCapabilityProviders('memory.rebuild', ctx);
          if (!provs.length || typeof provs[0].fn !== 'function') return null;
          const out = provs[0].fn({ chatKey });
          return out?.ok ? { mode: out.mode, added: out.added, chunks: out.chunks } : null;
        };
        try {
          const report = await rollbackImport(body.backupId, {
            storeInvalidate: (chatKey) => { try { store?.invalidate(chatKey); } catch { /* ignore */ } },
            memoryInvalidate: (chatKey) => { try { memory?.invalidate(chatKey); } catch { /* ignore */ } },
            rebuildChat
          });
          return json(res, report.ok ? 200 : 400, report);
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'GET', pattern: '/api/migrate/backups',
      handler: async ({ res, json }) => {
        try {
          return json(res, 200, { ok: true, backups: listBackups() });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    // ── 整包：打包带走 / 接收（harness → 打包 / 接收）──────────────────────
    //
    // 边界：数据落地复用 migrate.applyImport（一套合并/去重/备份逻辑），但入口
    // 只有"收一个别人发来的 zip"这一条，没有"直接读另一个 data 目录"的路径。
    // 接收侧**绝不直接安装**扩展：解包只进 data/import-bundles/<id>/ 临时区，
    // 扩展逐个送锻造台过闸，最后由一次人工确认批量落地（每个草稿仍各签一张票）。
    {
      method: 'GET', pattern: '/api/bundle/options',
      handler: async ({ res, json }) => {
        try { return json(res, 200, listBundleOptions()); }
        catch (error) { return json(res, 500, { ok: false, error: String(error?.message ?? error) }); }
      }
    },
    {
      method: 'POST', pattern: '/api/bundle/export',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        try {
          const r = exportBundle({
            modules: Array.isArray(body.modules) ? body.modules : [],
            data: body.data,
            note: body.note,
            appVersion: String(localVersion() || '')
          });
          return json(res, r.ok ? 200 : 400, r);
        } catch (error) {
          return json(res, 500, { ok: false, error: `打包失败：${String(error?.message ?? error)}` });
        }
      }
    },
    {
      // 打开导出目录。固定路径、不接受任何用户参数，没有路径穿越面。
      method: 'POST', pattern: '/api/bundle/reveal',
      handler: async ({ res, json }) => {
        try {
          const dir = listBundleOptions().exportsDir;
          openDirNative(dir);
          return json(res, 200, { ok: true, dir });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      // 读包：{ path } 优先（存档包动辄几十 MB，本机直接读盘比 upload 实在），
      // { zipBase64 } 兜底给小包 / 拖拽。只解到临时区，不装任何东西。
      method: 'POST', pattern: '/api/bundle/inspect',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        try {
          const base64 = typeof body.zipBase64 === 'string' ? body.zipBase64 : '';
          const r = inspectBundle({
            filePath: String(body.path || ''),
            buffer: base64 ? Buffer.from(base64, 'base64') : null
          });
          return json(res, r.ok ? 200 : 400, r);
        } catch (error) {
          return json(res, 500, { ok: false, error: `读取失败：${String(error?.message ?? error)}` });
        }
      }
    },
    {
      // 把包里的扩展送进锻造台暂存区（**不安装**，只产出草稿 + 闸门结论）
      method: 'POST', pattern: '/api/bundle/stage',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const bundleId = String(body.bundleId || '');
        const keys = Array.isArray(body.keys) ? body.keys.map(String) : [];
        if (!bundleId || !keys.length) return json(res, 400, { ok: false, error: '缺少 bundleId / keys' });

        const ctx = skillRuntimeContext();
        const imp = skillManager.getCapabilityProviders('forge.import-zip', ctx)[0];
        if (!imp) return json(res, 200, { ok: false, available: false, error: '扩展锻造台未就绪（内置模块异常）' });

        const drafts = [];
        for (const key of keys) {
          const zip = moduleZipOf(bundleId, key);
          if (!zip) { drafts.push({ key, ok: false, error: '模块缺失或为空' }); continue; }
          let out;
          try { out = imp.fn({ zipBase64: zip.toString('base64'), zipName: `${key.replace(':', '-')}.zip` }); }
          catch (error) { drafts.push({ key, ok: false, error: String(error?.message ?? error) }); continue; }
          if (!out?.ok) { drafts.push({ key, ok: false, rejected: !!out?.rejected, error: out?.error || '导入暂存区失败' }); continue; }

          try { skillManager.getCapabilityProviders('forge.snapshot', ctx)[0]?.fn({ draftId: out.draftId, label: 'pre' }); } catch { /* 快照失败不阻断 */ }
          try {
            skillManager.getCapabilityProviders('forge.save-meta', ctx)[0]?.fn({
              draftId: out.draftId,
              source: 'bundle',
              originName: String(key).split(':')[1] || '',
              requirement: `接收整包导入：${String(key)}`
            });
          } catch { /* 元数据失败只影响展示 */ }

          let gate = null;
          try { gate = skillManager.getCapabilityProviders('forge.gate', ctx)[0]?.fn({ draftId: out.draftId }) || null; }
          catch (error) { gate = { ok: false, error: String(error?.message ?? error) }; }
          drafts.push({ key, ok: true, draftId: out.draftId, gate });
        }
        log('info', `[bundle] 解包登台：${drafts.filter((d) => d.ok).length}/${keys.length} 个扩展进入暂存区（bundle ${bundleId}）`);
        return json(res, 200, { ok: true, drafts });
      }
    },
    {
      // 一次确认，批量安装。
      // 每个草稿仍然单独签票（票据绑内容摘要、一次性、10 分钟），批量省的只是"点几次"。
      // 带上 keyEndpointAllowed：只有控制台发起的请求能签票。
      method: 'POST', pattern: '/api/bundle/install',
      handler: async ({ req, res, json }) => {
        if (!keyEndpointAllowed(req)) {
          return json(res, 403, {
            ok: false,
            error: '确认安装只能从控制台窗口发起（当前请求没有控制台凭据）。'
              + '用外部浏览器打开控制台的话，先在设置里配置「服务 token」，再用 控制台地址?token=<你的token> 打开。'
          });
        }
        const body = await bodyOf(req);
        const items = Array.isArray(body.items) ? body.items : [];
        const enable = body.enable === true;   // 装完是否直接启用（默认不启）
        const ctx = skillRuntimeContext();
        const conf = skillManager.getCapabilityProviders('forge.confirm-ticket', ctx)[0];
        const inst = skillManager.getCapabilityProviders('forge.install', ctx)[0];
        if (!conf || !inst) {
          return json(res, 200, { ok: false, available: false, error: '扩展锻造台版本过旧（缺少「确认票据」能力）—— 请重启应用后再试' });
        }

        const results = [];
        let installed = 0;
        for (const it of items) {
          const draftId = String(it?.draftId || '');
          if (!draftId) continue;
          const ticket = conf.fn({ draftId, human: true });
          if (!ticket?.ok) { results.push({ draftId, ok: false, error: ticket?.error || '签票失败' }); continue; }
          let out;
          try {
            out = inst.fn({ draftId, confirmIssues: it?.confirmIssues === true, approvalToken: ticket.approvalToken });
          } catch (error) { out = { ok: false, error: String(error?.message ?? error) }; }
          if (out?.ok) {
            installed += 1;
            // 与 /api/forge/install 同口径：默认装成"关闭"，由用户决定何时启用。
            // 整包场景下用户已经在清单里挑过一遍，界面上给了"装完直接启用"开关。
            try { setSkillEnabled(out.id, enable === true); } catch { /* 写配置失败不算安装失败 */ }
          }
          results.push({ draftId, ok: !!out?.ok, id: out?.id, dir: out?.dir, error: out?.error });
        }
        if (installed) {
          try { await reloadSkills({ reason: 'bundle-install' }); } catch { /* 重扫失败不影响安装结果 */ }
        }
        log('info', `[bundle] 批量安装：${installed}/${results.length} 成功（${enable ? '已启用' : '装后关闭'}）`);
        return json(res, 200, { ok: installed > 0, installed, total: results.length, results });
      }
    },
    {
      // 导入包里的数据（会话存档 / 群友印象 / 统计…）。落地逻辑与 migrate.applyImport 同一套：
      // 先备份、可回滚、导入的历史消息一律置已读。
      method: 'POST', pattern: '/api/bundle/import-data',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const dir = dataDirOf(String(body.bundleId || ''));
        if (!fs.existsSync(dir)) return json(res, 400, { ok: false, error: '解包临时区已失效（可能被清理），请重新选择包' });
        const rebuildChat = async (chatKey) => {
          const ctx = skillRuntimeContext();
          const provs = skillManager.getCapabilityProviders('memory.rebuild', ctx);
          if (!provs.length || typeof provs[0].fn !== 'function') return null;
          const out = provs[0].fn({ chatKey });
          return out?.ok ? { mode: out.mode, added: out.added, chunks: out.chunks } : null;
        };
        try {
          const report = await applyImport(dir, body.selection || {}, {
            storeInvalidate: (chatKey) => { try { store?.invalidate(chatKey); } catch { /* ignore */ } },
            memoryInvalidate: (chatKey) => { try { memory?.invalidate(chatKey); } catch { /* ignore */ } },
            rebuildChat
          });
          return json(res, report.ok ? 200 : 400, report);
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'POST', pattern: '/api/bundle/discard',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        try { return json(res, 200, discardBundle(body.bundleId)); }
        catch (error) { return json(res, 500, { ok: false, error: String(error?.message ?? error) }); }
      }
    },
    {
      method: 'POST', pattern: '/api/open-data-dir',
      handler: async ({ res, json }) => {
        try {
          openDirNative(DATA_DIR);
          return json(res, 200, { ok: true, dir: DATA_DIR });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      // 界面背景图。
      // 图片由 Electron 主进程经原生文件对话框选好后**复制**进 data/ui/ 下，
      // 这里只按 config.ui.bgImage 记录的文件名把它读出来，不接受任何路径参数，
      // 所以不存在"传 ../../ 读任意文件"的穿越面。
      // ⚠️ 必须走同源 HTTP（img-src 'self'），file:// 图片会被 Chromium 拦下。
      // ⚠️ 路径必须带 /api/ 前缀：app.js 只对 /api/* 做路由表分发，
      //    其余路径一律走 ui/ 静态文件（会 404）。
      method: 'GET', pattern: '/api/ui-bg',
      handler: async ({ res }) => {
        const name = String(getConfig().ui?.bgImage || '').trim();
        const extOk = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp' };
        const ext = path.extname(name).toLowerCase();
        if (!name || !extOk[ext] || /[/\\]/.test(name)) {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('No background');
          return;
        }
        const file = path.join(DATA_DIR, 'ui', name);
        // 二次校验：解析后必须仍在 data/ui/ 内（防配置被写进奇怪的值）
        const rel = path.relative(path.join(DATA_DIR, 'ui'), file);
        if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
          res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('Forbidden');
          return;
        }
        try {
          const data = fs.readFileSync(file);
          res.writeHead(200, { 'content-type': extOk[ext], 'cache-control': 'no-cache' });
          res.end(data);
        } catch {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('No background');
        }
      }
    },
    {
      method: 'POST', pattern: '/api/reset-data',
      handler: async ({ res, json }) => {
        try {
          // 安全闸：只允许重置"看起来确实是数据目录"的路径。
          // QQ_AGENT_DATA_DIR 被误设成 C:\ 或用户目录时，无闸直接 rmSync 就是删盘。
          const resolved = path.resolve(DATA_DIR);
          const looksLikeDataDir = path.basename(resolved).toLowerCase().startsWith('data')
            || fs.existsSync(path.join(resolved, 'config.json'));
          if (!looksLikeDataDir || resolved === path.parse(resolved).root) {
            return json(res, 400, { ok: false, error: `数据目录不像 QQ Agent 数据目录，已拒绝重置：${resolved}` });
          }

          await orchestrator.abortAll();
          onebot.close();

          // 删前先备份：同级带时间戳的副本，出问题还能捞回来；备份失败则中止重置。
          let backupDir = '';
          try {
            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            backupDir = `${resolved}.backup-${stamp}`;
            fs.cpSync(resolved, backupDir, { recursive: true, force: true });
          } catch (error) {
            return json(res, 500, { ok: false, error: `备份失败，已中止重置：${String(error?.message ?? error)}` });
          }

          // 只清内容，不删目录本身（目录可能被占用/是挂载点）；
          // 跳过 qq-agent.lock：那是本进程活着的凭证，删了会让第二个实例误判无锁启动。
          for (const name of fs.readdirSync(resolved)) {
            if (name === 'qq-agent.lock') continue;
            fs.rmSync(path.join(resolved, name), { recursive: true, force: true });
          }
          const { loadConfig } = await import('./config.js');
          updateConfig(loadConfig());
          return json(res, 200, { ok: true, backupDir, message: `已重置为初始形态（原数据已备份到 ${backupDir}），请重启应用` });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },

    // ── 成本看板 ─────────────────────────────────────────────────────
    {
      method: 'GET', pattern: '/api/usage/stats',
      handler: async ({ res, json, url }) => {
        try {
          const raw = String(url.searchParams.get('range') || url.searchParams.get('days') || '7');
          // force=1：绕过 3 小时结果缓存，当场重算（用户点「刷新」时前端带这个参数）。
          // 统计结果本身有缓存，但"用户明确要求现在算"必须被尊重，否则那个刷新
          // 按钮按下去没反应，比慢更让人困惑。
          const force = ['1', 'true', 'yes', 'force'].includes(
            String(url.searchParams.get('force') || '').trim().toLowerCase());
          const stats = await buildUsageStats({ range: raw, force });
          return json(res, 200, { ok: true, range: raw, ...stats });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'GET', pattern: '/api/usage/plugins',
      // 「按插件」统计：token 归因到插件与具体功能 + 对缓存命中率的影响。
      // 口径见 src/plugin-usage.js 头部注释（估算值；调用明细来自会话文件的
      // message.toolCall，会话被裁剪后只覆盖磁盘上还在的部分）。
      handler: async ({ res, json, url }) => {
        try {
          const range = String(url.searchParams.get('range') || '7');
          const result = buildPluginUsage({ range, context: skillRuntimeContext() });
          return json(res, 200, { ok: true, ...result });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'GET', pattern: '/api/usage/breakdown',
      handler: async ({ res, json, url }) => {
        try {
          const raw = String(url.searchParams.get('range') || '7');
          const dim = String(url.searchParams.get('dim') || '');
          const key = String(url.searchParams.get('key') || '');
          const by = String(url.searchParams.get('by') || '');
          const r = await buildUsageBreakdown({ range: raw, dim, key, by });
          return json(res, 200, { ok: true, ...r });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },

    // ── 价格表 ───────────────────────────────────────────────────────
    {
      method: 'GET', pattern: '/api/model-prices',
      handler: async ({ res, json, url }) => json(res, 200, {
        prices: listOfficialPrices(),
        current: resolveOfficialPrice(String(url.searchParams.get('model') || getConfig().api?.model || '')),
        remote: { ...priceFeedStatus(), url: FIXED_PRICE_FEED_URL }
      })
    },
    {
      method: 'POST', pattern: '/api/model-prices/refresh',
      handler: async ({ res, json }) => {
        const st = await refreshPriceFeed(FIXED_PRICE_FEED_URL);
        return json(res, 200, {
          ok: st.ok, remote: st,
          prices: listOfficialPrices(),
          current: resolveOfficialPrice(getConfig().api?.model || '')
        });
      }
    },

    // ── 人设市场 ───────────────────────────────────────────────────────
    // 人设**不是代码**，所以装法与技能 / 插件完全不同：没有 zip、没有安装口令，
    // 而是"取正文 → 写进 config.customPersonas → 用户自己切过去"。
    // 三步各自一个端点，分别对应 UI 上的「预览 → 试用 → 应用」。
    {
      // 列表：⚠️ 刻意**不含 prompt 正文**（官网整包 3.7MB / 70 万字，
      // 一屏 123 张卡全带正文必卡）。只回元信息 + promptLength。
      method: 'GET', pattern: '/api/persona-market/list',
      handler: async ({ res, json }) => {
        try {
          const r = await listPersonaItems();
          return json(res, 200, { ok: true, categories: r.categories, items: r.items });
        } catch (error) {
          return json(res, 502, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      // 单条正文：用户点开一张卡（预览 / 试用 / 应用）时才取。
      method: 'GET', pattern: /^\/api\/persona-market\/item\/([^/]+)$/,
      handler: async ({ res, json, match }) => {
        // 参数非法用 400，别用 502：502 是"上游失败"的语义，正文却写着"人设 id 非法"，
        // 前端按状态码分流时会把它当成市场不可用。
        const pid = decodeURIComponent(match[1]);
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(String(pid).trim())) {
          return json(res, 400, { ok: false, error: '人设 id 非法' });
        }
        try {
          const r = await fetchPersonaPrompt(pid);
          if (!r) return json(res, 404, { ok: false, error: '没找到这个人设' });
          return json(res, 200, { ok: true, item: r });
        } catch (error) {
          return json(res, 502, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      // 应用（= 安装）：把正文落成一条自定义人设。
      // ⚠️ 幂等：同一 id 重复应用时**覆盖**同名旧条目，不追加，否则用户每次点
      //   「应用」都会多一条。落点用 customPersonas，不动 persona.roleText，
      //   当前生效的人设由设置页自己管，市场只负责"往库里放"。
      method: 'POST', pattern: '/api/persona-market/apply',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const id = String(body?.id || '').trim();
        const applyNow = body?.applyNow === true;      // true = 落库后立刻切成当前人设
        try {
          const item = await fetchPersonaPrompt(id);
          const list = Array.isArray(getConfig().customPersonas) ? [...getConfig().customPersonas] : [];
          const entry = {
            id,                                   // 记来源，市场卡片才能显示"已应用"
            name: String(body?.name || item.title || item.id).trim().slice(0, 50),
            text: item.prompt,
            source: 'market',
            sourceId: id,
            appliedAt: new Date().toISOString()
          };
          const at = list.findIndex((p) => p && (p.sourceId === id || p.marketId === id));
          if (at >= 0) list[at] = { ...list[at], ...entry };
          else list.push(entry);
          const patch = { customPersonas: list };
          // 立即生效：只改 roleText / customRules，不动 botName，
          //   名字是账号身份，@ 判定与存档称呼都依赖它，换名会串。
          if (applyNow) {
            patch.persona = { ...(getConfig().persona || {}), roleText: item.prompt };
          }
          updateConfig(patch);
          return json(res, 200, {
            ok: true,
            id,
            index: at >= 0 ? at : list.length - 1,
            appliedNow: !!applyNow,
            promptLength: item.prompt.length
          });
        } catch (error) {
          return json(res, 502, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },

    // ── 便携 QQ 进程管理 ─────────────────────────────────────────────
    {
      method: 'POST', pattern: '/api/qq-portable/launch',
      handler: async ({ res, json }) => {
        try {
          const result = await launchPortableQQ();
          return json(res, result.ok ? 200 : 400, result);
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'POST', pattern: '/api/qq-portable/stop',
      handler: async ({ res, json }) => {
        try {
          const result = await stopPortableQQ();
          return json(res, result.ok ? 200 : 400, result);
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'GET', pattern: '/api/qq-portable/logs',
      handler: async ({ res, json }) => json(res, 200, { logs: qqPortableLogs.slice(-200) })
    },
    {
      // 唤起便携 QQ 主窗口
      method: 'POST', pattern: '/api/qq-portable/show',
      handler: async ({ res, json }) => {
        try {
          const result = await showPortableQQ();
          return json(res, result.ok ? 200 : 400, result);
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      // 一键安装便携 QQ：从本机已安装的 QQNT 复制。
      // body 可带 { sourceDir }（注册表/常见路径都找不到时的手动兜底），一般为空。
      // 复制以分钟计，前端轮询 /api/status 的 qqPortable.setup 显示进度。
      method: 'POST', pattern: '/api/qq-portable/setup',
      handler: async ({ req, res, json }) => {
        try {
          const body = await bodyOf(req);
          const result = await setupPortableQQFromLocal(body || {});
          return json(res, result.ok ? 200 : 400, result);
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      // ?force=1 跳过「本机 QQ 探测」的 30s 缓存
      method: 'GET', pattern: '/api/qq-portable/status',
      handler: async ({ res, json, url }) => {
        const force = String(url?.searchParams?.get('force') || '') === '1';
        return json(res, 200, await qqPortableStatus({ force }));
      }
    },

    // ── 体检 / 引导 ──────────────────────────────────────────────────
    {
      method: 'GET', pattern: '/api/onebot/groups',
      handler: async ({ res, json }) => {
        try {
          const list = await onebot.call('get_group_list');
          const groups = (Array.isArray(list) ? list : (list?.data ?? []))
            .map((g) => ({ id: String(g.group_id), name: String(g.group_name ?? g.group_id) }));
          return json(res, 200, { groups });
        } catch (error) {
          return json(res, 502, { error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'GET', pattern: '/api/onebot/friends',
      handler: async ({ res, json }) => {
        try {
          const list = await onebot.call('get_friend_list');
          const friends = (Array.isArray(list) ? list : (list?.data ?? []))
            .map((f) => ({ id: String(f.user_id), name: String(f.remark || f.nickname || f.user_id) }));
          return json(res, 200, { friends });
        } catch (error) {
          return json(res, 502, { error: String(error?.message ?? error) });
        }
      }
    },

    // ── 人设模板 ─────────────────────────────────────────────────────
    {
      method: 'GET', pattern: '/api/persona-templates',
      handler: async ({ res, json }) => {
        const { PERSONAS } = await import('./personas.js');
        const builtins = Object.entries(PERSONAS).map(([id, p]) => ({ id, name: p.name, text: p.text, builtin: true }));
        const customs = (getConfig().customPersonas || []).map((p, i) => ({
          id: `custom_${i}`, name: p.name, text: p.text, customRules: p.customRules || '', builtin: false
        }));
        return json(res, 200, { templates: [...builtins, ...customs] });
      }
    },
    {
      method: 'POST', pattern: '/api/persona-templates',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const name = String(body.name ?? '').trim().slice(0, 50);
        const text = String(body.text ?? '').trim();
        if (!name || !text) return json(res, 400, { ok: false, error: '人设名称和角色设定都不能为空' });
        const customRules = String(body.customRules ?? '').trim();

        // ── 带 id = 修改已有的自定义人设（供人设卡上的「编辑」用）──
        // 只认 custom_N：内置人设的正文写死在 src/personas.js 里，改不了。
        const editId = String(body.id ?? '').trim();
        if (editId) {
          const m = /^custom_(\d+)$/.exec(editId);
          if (!m) return json(res, 400, { ok: false, error: '内置人设不能修改（可以另存为自定义人设）' });
          const idx = Number(m[1]);
          const list = [...(getConfig().customPersonas || [])];
          const old = list[idx];
          if (!old) return json(res, 404, { ok: false, error: '这个人设已经不存在了，请刷新列表' });
          const entry = { ...old, name, text };
          if (customRules) entry.customRules = customRules;
          else delete entry.customRules;
          list[idx] = entry;

          const patch = { customPersonas: list };
          // ⚠️ 改的正是**当前生效**的那套 → 必须同步 persona.roleText / customRules。
          // 否则界面上显示的是新人设，机器人却还拿着旧正文说话。语义放服务端，
          // 随同一次 updateConfig 落盘。
          if (String(old.text ?? '') && String(old.text) === String(getConfig().persona?.roleText ?? '')) {
            patch.persona = { ...(getConfig().persona || {}), roleText: text };
            // 清空「额外规矩」时也要把当前生效人设上的旧规则一起清掉：
            // patch.persona 是从旧对象展开的，不显式写空串，旧规则会原样留下，
            // 表现为模板里已删掉的规矩仍在每轮注入提示词。
            // 显式写空串而不是 delete：updateConfig 是深合并，delete 删不掉已存在的键。
            patch.persona.customRules = customRules || '';
          }
          updateConfig(patch);
          return json(res, 200, { ok: true, id: editId, appliedNow: !!patch.persona });
        }

        const entry = { name, text };
        if (customRules) entry.customRules = customRules;
        const next = [...(getConfig().customPersonas || []), entry];
        updateConfig({ customPersonas: next });
        return json(res, 200, { ok: true, templates: next });
      }
    },
    {
      method: 'DELETE', pattern: /^\/api\/persona-templates\/(custom_\d+)$/,
      handler: async ({ res, json, match }) => {
        const idx = Number(match[1].replace('custom_', ''));
        const list = getConfig().customPersonas || [];
        const removed = list[idx];
        const next = list.filter((_, i) => i !== idx);
        const patch = { customPersonas: next };
        // ⚠️ 被删的正是**当前生效**的那套时，只过滤 customPersonas 会让界面显示
        //    "未选人设"而机器人继续拿被删掉的角色卡说话，前后不一致且极难排查。
        //    UI 侧那段复位操作依赖的 #cfg-roletext / #cfg-customrules 已随人设编辑器
        //    搬进弹窗、不在 DOM 里，存在性守卫让它变成了空操作。所以语义放服务端，
        //    随同一次 updateConfig 落盘。
        if (removed && String(removed.text ?? '')
          && String(removed.text) === String(getConfig().persona?.roleText ?? '')) {
          const { PERSONAS } = await import('./personas.js');
          patch.persona = { ...(getConfig().persona || {}), roleText: PERSONAS.xiaojingyu?.text || '' };
        }
        updateConfig(patch);
        return json(res, 200, { ok: true, resetPersona: !!patch.persona });
      }
    },

    // ── 多提供商模型目录 ─────────────────────────────────────────────
    {
      method: 'GET', pattern: '/api/providers',
      handler: async ({ res, json }) => {
        const providers = currentProviders().map((p) => ({
          // label = 「名称 · 端点」的完整显示标识（规则见 providers.js 的
          // providerDisplayLabel）。前端列表与破坏性确认框都用它，
          // 这样同名服务商也能被指认清楚。
          id: p.id, displayName: p.displayName, baseURL: p.baseURL,
          label: providerDisplayLabel(p),
          apiKey: '', apiKeyFrom: p.apiKeyFrom || '', needsBaseUrl: p.needsBaseUrl === true,
          hasKey: !!p.apiKey, anthropicOrigin: p.anthropicOrigin === true,
          // API 协议：旧数据无 apiProtocol → openai；label 供前端直接显示
          apiProtocol: normalizeProtocol(p.apiProtocol || p.api),
          protocolLabel: protocolLabel(p.apiProtocol || p.api),
          models: p.models, modelNames: p.modelNames || {}
        }));
        return json(res, 200, { providers, source: getConfig().providersSourceYaml });
      }
    },
    {
      method: 'GET', pattern: '/api/providers/key',
      handler: async ({ req, res, json, url }) => {
        if (!keyEndpointAllowed(req)) return json(res, 403, { error: '请求来源不被信任，已拒绝读取明文密钥。' });
        const pid = String(url.searchParams.get('providerId') || '');
        const p = currentProviders().find((x) => x.id === pid);
        return json(res, 200, { apiKey: p?.apiKey || '' });
      }
    },
    {
      method: 'GET', pattern: '/api/api-key',
      handler: async ({ req, res, json }) => {
        if (!keyEndpointAllowed(req)) return json(res, 403, { error: '请求来源不被信任，已拒绝读取明文密钥。' });
        return json(res, 200, { apiKey: String(getConfig().api.apiKey || '') });
      }
    },
    {
      method: 'GET', pattern: '/api/search-key',
      handler: async ({ req, res, json, url }) => {
        if (!keyEndpointAllowed(req)) return json(res, 403, { error: '请求来源不被信任，已拒绝读取明文密钥。' });
        const field = String(url.searchParams.get('field') || '');
        const allowed = ['deepseek', 'zhipu', 'bocha', 'baidu', 'metaso'];
        // 各家对应的环境变量名：Key 没存进配置但环境里有时，也算"有 Key"
        //（web-search.js 的取值优先级就是 cfg.apiKey > env），UI 的掩码/显示
        // 口径必须与之一致，否则会出现"明明能搜，Key 框却显示空"的错觉。
        const ENV_OF = {
          deepseek: 'DEEPSEEK_API_KEY',
          zhipu: 'ZHIPU_API_KEY',
          bocha: 'BOCHA_API_KEY',
          baidu: 'BAIDU_SEARCH_API_KEY',
          metaso: 'METASO_API_KEY'
        };
        if (allowed.includes(field)) {
          const fromCfg = String(getConfig().webSearch?.[field]?.apiKey || '');
          return json(res, 200, { apiKey: fromCfg, hasApiKey: Boolean(fromCfg || (ENV_OF[field] && process.env[ENV_OF[field]])) });
        }
        // 自定义搜索服务：field 形如 custom:<id>，按 id 在 providers 数组里找
        if (field.startsWith('custom:')) {
          const id = field.slice('custom:'.length);
          const entry = (getConfig().webSearch?.providers || []).find((p) => String(p.id) === id);
          const k = String(entry?.apiKey || '');
          return json(res, 200, { apiKey: k, hasApiKey: Boolean(k) });
        }
        return json(res, 400, { error: `未知搜索服务：${field}` });
      }
    },
    {
      // 协议端配置探测（只读）─────────────────────────────────────────────
      // 给连接页用：告诉 UI「能不能自动填、填的是哪个账号、端口在不在」。
      // 典型调用时机是"装好并登录了，重新检测"。
      //
      // ⚠️ 响应里**没有令牌**：detectProtocol 的原始结果带明文，必须过 publicView。
      //    这条是令牌不越过 HTTP 边界的关键，改动时别把 hit 直接 json 出去。
      method: 'GET', pattern: '/api/protocol/detect',
      handler: async ({ res, json }) => {
        const hit = await detectProtocol({ isPortOpen });
        return json(res, 200, protocolDetectView(hit));
      }
    },
    {
      // 自动填端点/令牌 ──────────────────────────────────────────────────
      // 与「保存并重连」走**同一条**落盘 + setEndpoint 路径，不另写一套连接逻辑。
      //   · force=true  → 手动点「自动读取协议端配置」，以探测结果为准覆盖；
      //   · 不带 force  → 启动兜底，只补空字段（用户手填过的值不动）。
      // body 可带 dir（"我知道装在哪"），留空则由探测自己找。
      method: 'POST', pattern: '/api/protocol/autofill',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const dir = String(body.dir || '').trim();
        const r = await autoFillProtocol({ force: body.force === true, dir });
        return json(res, 200, r);
      }
    },
    {
      // 协议端端点：保存并立即生效（协议端解耦配套）。
      //
      // 为什么需要专用端点：协议端由用户自行安装（SnowLuma / NapCat），端点地址与
      // 令牌是第一次配置就要填的；而 OneBotClient 在构造时快照了 wsUrl/httpUrl/令牌，
      // 改配置不重建连接就等于没改。以前只能"改完重启应用"，这里把"落配置 +
      // 换端点重连"合成一步。
      //
      // 令牌口径与设置页一致：空串 / '******' = 保持原值不变（脱敏回传的常态），
      // 只有真的输入了新明文才更新，否则"保存一次地址就把令牌清空"。
      method: 'POST', pattern: '/api/protocol/apply',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const next = {};
        if (typeof body.wsUrl === 'string' && body.wsUrl.trim()) {
          const v = body.wsUrl.trim();
          if (!/^wss?:\/\//i.test(v)) return json(res, 400, { ok: false, error: 'WebSocket 地址要以 ws:// 或 wss:// 开头' });
          next.wsUrl = v;
        }
        if (typeof body.httpUrl === 'string' && body.httpUrl.trim()) {
          const v = body.httpUrl.trim();
          if (!/^https?:\/\//i.test(v)) return json(res, 400, { ok: false, error: 'HTTP 地址要以 http:// 或 https:// 开头' });
          next.httpUrl = v.replace(/\/+$/, '');
        }
        const wsToken = String(body.accessToken ?? '').trim();
        if (wsToken && wsToken !== '******') next.accessToken = wsToken;
        const httpToken = String(body.httpAccessToken ?? '').trim();
        if (httpToken && httpToken !== '******') next.httpAccessToken = httpToken;
        // 清空令牌要显式传 clearTokens，避免"空输入框"被当成"我要清空"。
        if (body.clearAccessToken === true) next.accessToken = '';
        if (body.clearHttpAccessToken === true) next.httpAccessToken = '';

        if (!Object.keys(next).length) {
          return json(res, 400, { ok: false, error: '没有要保存的改动' });
        }
        const cfg = updateConfig({ protocol: next });
        try {
          await onebot.setEndpoint({
            wsUrl: cfg.protocol?.wsUrl,
            httpUrl: cfg.protocol?.httpUrl,
            accessToken: cfg.protocol?.accessToken,
            httpToken: cfg.protocol?.httpAccessToken
          });
        } catch (e) {
          // 配置已经落盘（下次启动仍会用新值），只是本次重连没跑起来，如实说
          return json(res, 200, { ok: true, applied: false, error: String(e?.message || e) });
        }
        return json(res, 200, {
          ok: true,
          applied: true,
          protocol: {
            wsUrl: String(cfg.protocol?.wsUrl || ''),
            httpUrl: String(cfg.protocol?.httpUrl || '')
          }
        });
      }
    },
    {
      // OneBot 令牌明文读取：控制台「显示」按钮专用（与 /api/search-key 同一套来源校验）。
      // 必须有这个端点：配置经 sanitizeConfig 脱敏后前端只拿得到掩码，
      // 用户想"看一眼现有令牌"只能走这里。
      method: 'GET', pattern: '/api/onebot-token',
      handler: async ({ req, res, json, url }) => {
        if (!keyEndpointAllowed(req)) return json(res, 403, { error: '请求来源不被信任，已拒绝读取明文密钥。' });
        const which = String(url.searchParams.get('which') || '');
        const proto = getConfig().protocol || {};
        if (which === 'ws') return json(res, 200, { token: String(proto.accessToken || '') });
        if (which === 'http') return json(res, 200, { token: String(proto.httpAccessToken || proto.accessToken || '') });
        return json(res, 400, { error: `未知令牌类型：${which}` });
      }
    },
    {
      method: 'POST', pattern: '/api/providers/fetch-models',
      handler: async ({ req, res, json }) => {
        try {
          const body = await bodyOf(req);
          const cfgNow = getConfig();
          const baseUrl = String(body.baseUrl || cfgNow.api.baseUrl || '');
          // API 协议口径：显式传入 > 按 providerId 查已存 > 主提供商的
          const pid0 = String(body.providerId ?? '').trim();
          const proto = normalizeProtocol(
            body.apiProtocol
            || (currentProviders().find((x) => x.id === pid0)?.apiProtocol)
            || (currentProviders().find((x) => x.id === cfgNow.api?.provider)?.apiProtocol)
            || 'openai'
          );
          // Key 解析顺序：显式明文 > 按 providerId 查该提供商保存的 Key
          // （dshProviderKeys / providers[].apiKey）> 顶层 api.apiKey。
          // 只看顶层 Key 会在多提供商场景下拿错 Key（顶层只存"当前选中那个"），全部 401。
          let apiKey = '';
          if (body.apiKey !== undefined && String(body.apiKey ?? '').trim() && body.apiKey !== '******') {
            apiKey = String(body.apiKey).trim();
          } else {
            const p = pid0 ? currentProviders().find((x) => x.id === pid0) : null;
            apiKey = String(p?.apiKey ?? '').trim();
            if (!apiKey) apiKey = String(cfgNow.api.apiKey || '').trim();
            if (apiKey === '******') apiKey = '';
          }
          const models = await fetchModelsFrom(baseUrl, apiKey, 15000, proto);
          return json(res, 200, { ok: true, models, apiProtocol: proto });
        } catch (error) {
          return json(res, 502, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'POST', pattern: '/api/providers/test-one',
      handler: async ({ req, res, json }) => {
        try {
          const body = await bodyOf(req);
          const result = await testOneProvider({
            providerId: String(body.providerId ?? ''),
            baseUrl: String(body.baseUrl ?? ''),
            apiKey: String(body.apiKey ?? ''),
            protocol: String(body.apiProtocol ?? '')
          });
          return json(res, 200, { ok: true, result });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'POST', pattern: '/api/providers/test-chat',
      handler: async ({ req, res, json }) => {
        try {
          const body = await bodyOf(req);
          const submitted = String(body.apiKey ?? '').trim();
          // Key 解析顺序：本次提交的明文 > 按 providerId 查该提供商已保存的 Key > 当前选中提供商的 Key。
          // 多提供商场景下只看「当前选中的」会拿错 Key（弹窗里选的是另一家时的典型症状：
          // 配置本身没问题，测试却 401）。providerId 由前端在选中服务商时带上。
          const pid = String(body.providerId ?? '').trim();
          let apiKey = (submitted && submitted !== '******') ? submitted : '';
          if (!apiKey && pid) {
            const p = currentProviders().find((x) => x.id === pid);
            apiKey = String(p?.apiKey ?? '').trim();
          }
          if (!apiKey) apiKey = resolveApiKey(getConfig());
          const baseUrl = String(body.baseUrl ?? '');
          const model = String(body.model ?? '');
          // 测试协议必须与实跑同源：显式传入 > providerId 对应提供商 > 主提供商
          const cfgNow = getConfig();
          const proto = normalizeProtocol(
            body.apiProtocol
            || currentProviders().find((x) => x.id === pid)?.apiProtocol
            || currentProviders().find((x) => x.id === cfgNow.api?.provider)?.apiProtocol
            || 'openai'
          );
          const result = await testModelChat({ baseUrl, apiKey, model, protocol: proto });
          // 「思考方言」是 model.thinking-detect 能力（thinking-adapters Skill 提供）。
          // 接在这里是为了让用户在"测试连通性"时就能看到这个模型会走哪套思考参数，
          // 而不是开了思考模式后默默不生效、只能去翻日志。
          let thinking = null;
          try {
            const fn = skillManager.getCapabilityProviders('model.thinking-detect')[0]?.fn;
            if (fn) thinking = fn({ baseUrl, model }) || null;
          } catch { /* 识别失败不影响连通性测试结论 */ }
          return json(res, 200, { ok: true, result: { ...result, thinking } });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'POST', pattern: '/api/providers',
      handler: async ({ req, res, json }) => {
        try {
          const body = await bodyOf(req);
          const r = upsertProvider({
            baseUrl: String(body.baseUrl ?? ''), apiKey: String(body.apiKey ?? ''), models: body.models || [],
            protocol: body.apiProtocol,
            displayName: String(body.displayName ?? '')
          });
          return json(res, 200, { ok: true, ...r, provider: sanitizeProvider(r.provider) });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'POST', pattern: '/api/providers/models',
      handler: async ({ req, res, json }) => {
        try {
          const body = await bodyOf(req);
          const p = addModelsToProvider(String(body.providerId ?? ''), body.models || []);
          if (!p) return json(res, 404, { ok: false, error: '提供商不存在' });
          return json(res, 200, { ok: true, provider: sanitizeProvider(p) });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'DELETE', pattern: '/api/providers/models',
      handler: async ({ req, res, json }) => {
        try {
          const body = await bodyOf(req);
          const p = removeModelFromProvider(String(body.providerId ?? ''), String(body.modelId ?? ''));
          if (!p) return json(res, 404, { ok: false, error: '提供商或模型不存在' });
          return json(res, 200, { ok: true, provider: sanitizeProvider(p) });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'POST', pattern: '/api/providers/set-key',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const updated = setProviderKey(String(body.providerId ?? ''), String(body.apiKey ?? ''));
        if (!updated) return json(res, 404, { ok: false, error: '提供商不存在' });
        return json(res, 200, { ok: true, hasKey: !!updated.apiKey });
      }
    },
    {
      // 修改已有提供商的 API 协议（「API 协议」下拉）
      method: 'POST', pattern: '/api/providers/protocol',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const updated = setProviderProtocol(String(body.providerId ?? ''), body.apiProtocol);
        if (!updated) return json(res, 404, { ok: false, error: '提供商不存在' });
        return json(res, 200, { ok: true, apiProtocol: normalizeProtocol(updated.apiProtocol), protocolLabel: protocolLabel(updated.apiProtocol) });
      }
    },
    {
      // 修改已有提供商的显示名（「管理服务商」右列「名称」的保存按钮）。
      // 空名称明确拒绝：存空串会让提供商列表里出现一行空白，用户既认不出也点不准。
      // 想回到"按域名显示"就让用户自己填一个名字，而不是靠清空来隐式恢复。
      method: 'POST', pattern: '/api/providers/display-name',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        try {
          const updated = setProviderDisplayName(String(body.providerId ?? ''), String(body.displayName ?? ''));
          if (!updated) return json(res, 404, { ok: false, error: '提供商不存在' });
          return json(res, 200, { ok: true, displayName: updated.displayName });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      // 删除整个提供商（含 Key 与模型目录；当前选中它时一并清空选中态）
      method: 'DELETE', pattern: '/api/providers',
      handler: async ({ req, res, json }) => {
        try {
          const body = await bodyOf(req);
          const removed = removeProvider(String(body.providerId ?? ''));
          if (!removed) return json(res, 404, { ok: false, error: '提供商不存在' });
          return json(res, 200, { ok: true });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'POST', pattern: '/api/providers/test-all',
      handler: async ({ res, json }) => {
        const results = await testAllProviders(currentProviders());
        const okCount = Object.values(results).filter((r) => r.ok).length;
        return json(res, 200, { ok: true, results, okCount, total: Object.keys(results).length });
      }
    },

    // ── 视觉能力 ─────────────────────────────────────────────────────
    {
      method: 'GET', pattern: '/api/vision/results',
      handler: async ({ res, json }) => json(res, 200, {
        results: { ...builtinVisionResults(currentProviders()), ...visionResults() },
        scanning: visionScan.running
      })
    },
    {
      method: 'POST', pattern: '/api/vision/scan',
      handler: async ({ req, res, json }) => {
        if (visionScan.running) return json(res, 409, { ok: false, error: '已有一次扫描正在进行' });
        const body = await bodyOf(req);
        const onlyProviderIds = Array.isArray(body?.providerIds) ? body.providerIds.map(String) : null;
        visionScan.running = true;
        emit('vision-scan', { phase: 'start' });
        scanModelsVision({ providers: currentProviders(), emit, onlyProviderIds, timeoutMs: 25000, limit: 3 })
          .then(({ total }) => emit('vision-scan', { phase: 'done', total }))
          .catch((error) => emit('vision-scan', { phase: 'error', error: String(error?.message ?? error) }))
          .finally(() => { visionScan.running = false; });
        return json(res, 202, { ok: true, started: true });
      }
    },

    // ── 自定义搜索提供商 ─────────────────────────────────────────────
    {
      method: 'GET', pattern: '/api/search-providers',
      handler: async ({ res, json }) => {
        const list = (getConfig().webSearch?.providers || []).map((p) => ({
          id: p.id, name: p.name, type: p.type, baseUrl: p.baseUrl, model: p.model,
          count: p.count, timeoutMs: p.timeoutMs, hasApiKey: Boolean(String(p.apiKey || '').trim())
        }));
        return json(res, 200, { providers: list });
      }
    },
    {
      method: 'POST', pattern: '/api/search-providers',
      handler: async ({ req, res, json }) => {
        try {
          const body = await bodyOf(req);
          const baseUrl = String(body.baseUrl ?? '').trim();
          const type = String(body.type ?? 'openai').trim() === 'bing' ? 'bing' : 'openai';
          if (!baseUrl) return json(res, 400, { ok: false, error: '接口地址不能为空' });
          const list = [...(getConfig().webSearch?.providers || [])];
          const existing = list.find((p) => p.baseUrl === baseUrl && p.type === type);
          let entry;
          if (existing) {
            existing.name = String(body.name ?? existing.name ?? '').trim() || existing.name;
            existing.baseUrl = baseUrl;
            existing.type = type;
            existing.model = String(body.model ?? existing.model ?? '').trim();
            existing.count = Math.min(20, Math.max(1, Number(body.count) || existing.count || 6));
            existing.timeoutMs = Math.max(5000, Number(body.timeoutMs) || existing.timeoutMs || 20000);
            // apiKey 语义（与「清除密钥」按钮配套）：
            //   undefined / '******' → 不动（保持原 Key）
            //   非空字符串           → 覆盖为新 Key
            //   ''（显式空串）        → 清除
            if (body.apiKey === undefined) {
              /* 未提交：保持原值 */
            } else if (String(body.apiKey) === '******') {
              /* 掩码回传：保持原值 */
            } else {
              existing.apiKey = String(body.apiKey).trim();
            }
            entry = existing;
          } else {
            entry = {
              id: `sp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
              name: String(body.name ?? '').trim() || baseUrl,
              type, baseUrl,
              apiKey: String(body.apiKey ?? '').trim() === '******' ? '' : String(body.apiKey ?? '').trim(),
              model: String(body.model ?? '').trim(),
              count: Math.min(20, Math.max(1, Number(body.count) || 6)),
              timeoutMs: Math.max(5000, Number(body.timeoutMs) || 20000)
            };
            list.push(entry);
          }
          updateConfig({ webSearch: { providers: list } });
          return json(res, 200, { ok: true, provider: { ...entry, apiKey: '', hasApiKey: Boolean(String(entry.apiKey || '').trim()) } });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'DELETE', pattern: '/api/search-providers',
      handler: async ({ req, res, json }) => {
        try {
          const body = await bodyOf(req);
          const id = String(body.id ?? '').trim();
          if (!id) return json(res, 400, { ok: false, error: '缺少 id' });
          const list = (getConfig().webSearch?.providers || []).filter((p) => String(p.id) !== id);
          updateConfig({ webSearch: { providers: list } });
          const cur = String(getConfig().webSearch?.provider || '');
          if (cur === `custom:${id}`) updateConfig({ webSearch: { provider: 'bing' } });
          return json(res, 200, { ok: true });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'POST', pattern: '/api/search-providers/test',
      handler: async ({ req, res, json }) => {
        const startedAt = Date.now();
        try {
          const body = await bodyOf(req);
          const provId = String(body.providerId ?? '').trim();
          const r = await customSearch('qq agent 测试', provId || null);
          return json(res, 200, { ok: true, result: { ok: true, count: r.results.length, sample: r.results[0]?.title || '', latencyMs: Date.now() - startedAt } });
        } catch (error) {
          return json(res, 200, { ok: true, result: { ok: false, note: String(error?.message ?? error), latencyMs: Date.now() - startedAt } });
        }
      }
    },

    // ── 连通性测试 ───────────────────────────────────────────────────
    {
      method: 'POST', pattern: '/api/test/api',
      handler: async ({ res, json }) => {
        const startedAt = Date.now();
        try {
          const r = await chatCompletion({ messages: [{ role: 'user', content: '请只回复两个字符：pong' }], tools: null, temperature: 0 });
          const reply = typeof r.message.content === 'string' ? r.message.content.slice(0, 100) : '';
          return json(res, 200, { ok: true, model: r.model, reply, latencyMs: Date.now() - startedAt });
        } catch (error) {
          return json(res, 200, { ok: false, error: String(error?.message ?? error), latencyMs: Date.now() - startedAt });
        }
      }
    },

    // ── 配置 ─────────────────────────────────────────────────────────
    {
      method: 'GET', pattern: '/api/config',
      handler: async ({ res, json }) => json(res, 200, sanitizedConfig(getConfig()))
    },
    {
      // 完整系统提示词预览：按**当前**插件/技能/工具启用状态组装（没开的不出现），
      // 供设置-工具与技能页和技能页右侧预览共用。走后端而不是前端拼：组装逻辑
      // 就是运行时的 buildSystemPrompt + getToolAvailability，前端另写一份迟早漂移。
      //
      // POST + 可选 overrides：前端自动保存有 600ms 防抖，用户刚点的开关还没落盘；
      // 调用方把"当前工具面板状态"随请求发来，这里先 deepMerge 到临时副本上组装
      // （绝不写回 currentConfig），预览就能立即反映未保存的开关。
      method: '*', pattern: '/api/prompt-preview',
      handler: async ({ req, res, json }) => {
        const cfg = getConfig();
        let overrides = {};
        try {
          if (req.method === 'POST') overrides = (await bodyOf(req)) || {};
        } catch { overrides = {}; }
        const effective = Object.keys(overrides).length
          ? deepMergeConfig(structuredClone(cfg), structuredClone(overrides))
          : cfg;
        const skillContext = {
          skills: skillManager,
          toolsCfg: effective.tools || {},
          visionEnabled: effective.api?.vision !== false
            && modelImageVerdict(effective.api?.provider, effective.api?.model) !== 'no-vision',
          searchEnabled: effective.webSearch?.enabled !== false,
          runtimeContext: { model: effective.api?.model || '', provider: effective.api?.provider || '', source: 'api' },
          // ⚠️ 必须与 orchestrator 的 skillContext **同口径**：
          //    thinking-adapters 的 promptSections(context) 要从这里取 model/baseUrl/
          //    thinking* 才能写出与真实请求一致的"当前思考模式/方言"。只给
          //    runtimeContext.model 的话插件读不到，预览里恒显示"通用（不发送思考参数）"，
          //    而真实运行用的是 DeepSeek/通义等。
          model: effective.api?.model || '',
          provider: effective.api?.provider || '',
          baseUrl: effective.api?.baseUrl || '',
          thinkingMode: effective.api?.thinkingMode,
          thinkingEffort: effective.api?.thinkingEffort,
          thinkingBudget: effective.api?.thinkingBudget
        };
        const { buildSystemPrompt, renderVolatileSections } = await import('./prompt.js');
        const { buildToolDefs } = await import('./tools.js');
        const { getToolAvailability } = await import('./tool-registry.js');
        // 可用工具清单与 orchestrator 同一口径（tools.js 的 def → OpenAI 函数名）
        const tools = buildToolDefs()
          .filter((d) => getToolAvailability(d.id, skillContext).enabled)
          .map((d) => ({ id: d.id, name: d.name, description: d.description, category: d.category }));
        // ⚠️ 必须与 orchestrator 的**真实组装口径**一致：
        //    易变片段已从系统提示拆出、改注入用户提示词末尾。预览若仍把易变片段
        //    混在 systemPrompt 里，用户看到的就与实际发给模型的不符。
        //    这里把两部分**分别**给出：systemPrompt（实际系统提示）+ 尾注说明。
        const volatileOut = { sections: [] };
        const systemPrompt = buildSystemPrompt({ skillContext, deferVolatile: true, volatileOut });
        const volatileNote = renderVolatileSections(volatileOut.sections);
        return json(res, 200, {
          systemPrompt,
          // 易变片段（思考模式/系统自检/开发模式）实际拼在用户提示词末尾，单独返回供预览
          volatileNote,
          tools
        });
      }
    },
    {
      method: 'GET', pattern: '/api/community/blocklist',
      handler: async ({ res, json }) => json(res, 200, { ok: true, ids: getGlobalBlocklist() })
    },
    {
      method: 'POST', pattern: '/api/community/blocklist',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const ids = Array.isArray(body?.ids) ? body.ids : [];
        try {
          const { ids: actual, warning } = await updateGlobalBlocklist(ids, { mode: String(body?.mode || 'replace') });
          emit('status', { communityBlocklistUpdated: true });
          return json(res, 200, { ok: true, ids: actual, warning: warning || '' });
        } catch (error) {
          return json(res, 502, { ok: false, error: `云端屏蔽名单更新失败：${String(error?.message ?? error)}` });
        }
      }
    },

    // ── 社区市场：账号 + 发布 + 口令安装（全部代理官网，浏览器不直连）──────
    // 凭据存 data/account.json（不走 config：GET /api/config 会脱敏回传整个配置，
    // 塞进 config 等于自造泄露面）。所有端点失败都返回 502 + 服务器原始文案。
    {
      method: 'GET', pattern: '/api/market/accounts',
      handler: async ({ res, json }) => {
        const accounts = listAccounts().map((a) => ({ username: a.username, savedAt: a.savedAt }));
        return json(res, 200, { ok: true, accounts });
      }
    },
    {
      // 市场列表（应用内「市场」页）：代理官网 GET /skills | /plugins。
      // 浏览器直连会被 CORS 拦，与其它市场端点走同一条 marketFetch 通道。
      // 返回 { ok, categories, items }；items 已在 market.js 做过字段白名单裁剪。
      method: 'GET', pattern: '/api/market/list',
      handler: async ({ req, res, json, url }) => {
        const kind = url?.searchParams?.get('kind') === 'plugin' ? 'plugin' : 'skill';
        // force=1 = 跳过内存与磁盘列表缓存（装完/删完点「刷新」时前端会带上）
        const force = url?.searchParams?.get('force') === '1';
        if (force) clearMarketListCache(kind);
        try {
          const r = await listMarketItems(kind, { force });
          return json(res, 200, { ok: true, kind, categories: r.categories, items: r.items });
        } catch (error) {
          // 只回 502 不落日志时，用户报"市场加载不出来"后台干干净净，无法复盘
          // （是 DNS / WAF 挡了 / 上游 5xx / 超时？）。这里把原因写进应用日志。
          logger.warn('market', `市场列表拉取失败：${kind} · ${String(error?.message ?? error)}`);
          return json(res, 502, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      // 登录 / 注册。mode: login | register。注册三要素：登录 ID + 展示用户名 + 密码。
      // 成功后凭据自动落盘。
      method: 'POST', pattern: '/api/market/login',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        try {
          const r = await loginAccount({
            loginId: String(body?.loginId || ''),
            displayName: String(body?.displayName || ''),
            password: String(body?.password || ''),
            mode: body?.mode === 'register' ? 'register' : 'login'
          });
          return json(res, 200, { ok: true, account: r.account, accounts: r.accounts.map((a) => ({ username: a.username, savedAt: a.savedAt })) });
        } catch (error) {
          return json(res, 502, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      // 登出（删本地凭据 + 吊销远端 token）
      method: 'POST', pattern: '/api/market/logout',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const username = String(body?.username || '');
        if (!username) return json(res, 400, { ok: false, error: '缺少 username' });
        const accounts = await removeAccount(username);
        return json(res, 200, { ok: true, accounts: accounts.map((a) => ({ username: a.username, savedAt: a.savedAt })) });
      }
    },
    {
      // 发布一个已安装的 skill/plugin 到市场（待审核）。
      // body: { kind: 'skill'|'plugin', id, displayName, description, accountUsername }
      method: 'POST', pattern: '/api/market/publish',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const kind = body?.kind === 'plugin' ? 'plugin' : 'skill';
        const id = String(body?.id || '');
        if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(id)) {
          return json(res, 400, { ok: false, error: `无效的 ${kind} id：${id}` });
        }
        const acc = listAccounts().find((a) => a.username === String(body?.accountUsername || ''));
        if (!acc) return json(res, 401, { ok: false, error: '请先选择一个已登录的账号' });
        try {
          const r = await publishModule({
            kind, id,
            displayName: String(body?.displayName || ''),
            description: String(body?.description || ''),
            token: acc.token,
            // 发布端点有人机验证，前端弹完滑块把 param 透传
            captchaVerifyParam: String(body?.captchaVerifyParam || '')
          });
          return json(res, 200, {
            ok: true, item: r.item || null,
            renamedTo: r.renamedTo || null,
            note: r.note || ''
          });
        } catch (error) {
          return json(res, 502, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      // 口令批量校验：body { codes: [...] } → 每个口令的条目摘要
      method: 'POST', pattern: '/api/market/verify',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const codes = (Array.isArray(body?.codes) ? body.codes : [body?.code])
          .map((c) => String(c ?? '').trim().toUpperCase())
          .filter((c) => /^[A-Z0-9]{1,32}$/.test(c))
          .slice(0, 30);
        if (!codes.length) return json(res, 400, { ok: false, error: '没有有效的口令' });
        try {
          const results = await verifyInstallCodes(codes);
          return json(res, 200, { ok: true, results });
        } catch (error) {
          return json(res, 502, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      // 口令安装：body { code, entry }（entry = verify 阶段拿到的条目，含服务器判定的 type）。
      // 类型路由由服务器 entry.type 决定：技能页输插件口令也会归到插件。
      //
      // ⚠️ **这条路由不落盘**。流程：下载 → 导入扩展锻造台暂存区 → 拍快照 → 过五道闸门
      //    → 返回"待确认"。真正写 skills/ / plugins/ 的是 /api/forge/install，且必须带人工确认票据。
      //
      //    为什么必须这样：旧实现只做结构与清单预检就直落模块目录，五道闸门一道没跑、
      //    人工确认一步没有，用户点一下"安装"等于把整台机器交给一份没人看过的代码。
      //    闸门结论本身也不该自动换出安装许可（静态扫描是启发式的，见 gate.js 头注释）。
      //    现在"安装"这个词只保留给「人确认过的那一次落盘」。
      method: 'POST', pattern: '/api/market/install',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const code = String(body?.code || '').trim().toUpperCase();
        if (!/^[A-Z0-9]{4,12}$/.test(code)) return json(res, 400, { ok: false, error: '口令格式无效' });

        const ctx = skillRuntimeContext();
        const impProv = skillManager.getCapabilityProviders('forge.import-zip', ctx)[0];
        const canConfirm = skillManager.getCapabilityProviders('forge.confirm-ticket', ctx).length > 0;
        if (!impProv || !canConfirm) {
          // 锻造台是内置模块（kind='core'），正常不会缺席；缺席或版本过旧时宁可整单取消，
          // 也不退回"直装"，那正好是最该被删掉的那条旁路。
          return json(res, 503, {
            ok: false, available: false,
            error: impProv
              ? '扩展锻造台版本过旧（缺少「确认票据」能力，需重启应用）—— 安装已取消，没有任何文件落盘。'
              : '扩展锻造台未就绪（内置模块异常）—— 安装已取消，没有任何文件落盘。'
          });
        }

        let dl;
        try {
          dl = await downloadModuleZip({ code, verified: body?.entry || null });
        } catch (error) {
          return json(res, 502, { ok: false, error: String(error?.message ?? error) });
        }

        const name = String(dl.entry?.name || dl.ident || code);
        let out;
        try {
          out = impProv.fn({ zipBase64: dl.buffer.toString('base64'), zipName: `${dl.ident || code}.zip` });
        } catch (error) {
          return json(res, 500, { ok: false, error: `导入暂存区失败：${String(error?.message ?? error)}` });
        }
        if (!out?.ok) {
          return json(res, 200, { ok: false, rejected: !!out?.rejected, error: out?.error || '导入暂存区失败' });
        }

        // 适配前快照：之后模型改了什么、你确认的是哪一版，都靠它对比（失败不阻断）
        try {
          skillManager.getCapabilityProviders('forge.snapshot', ctx)[0]?.fn({ draftId: out.draftId, label: 'pre' });
        } catch { /* ignore */ }

        // 来源留痕：草稿列表里要能认出"这是市场口令 X 下载的"
        try {
          skillManager.getCapabilityProviders('forge.save-meta', ctx)[0]?.fn({
            draftId: out.draftId,
            source: 'market',
            originName: name,
            originCode: code,
            requirement: `市场口令 ${code} 下载：${name}（${dl.type === 'plugin' ? '插件' : '技能'}）`
          });
        } catch { /* 元数据写失败只影响展示，不阻断 */ }

        let gate = null;
        try { gate = skillManager.getCapabilityProviders('forge.gate', ctx)[0]?.fn({ draftId: out.draftId }) || null; }
        catch (error) { gate = { ok: false, error: String(error?.message ?? error) }; }

        log('info', `[market] 口令 ${code} 已导入锻造台暂存区（草稿 ${out.draftId}，`
          + `${gate?.ok ? '闸门通过' : `闸门阻断 ${gate?.blocking ?? '?'} 项`}），等待人工确认`);

        return json(res, 200, {
          ok: true,
          pending: true,                    // ← 前端据此区分"已安装"与"待确认"
          draftId: out.draftId,
          kind: out.kind || dl.type,
          id: dl.ident || out.draftId,
          name,
          files: out.files,
          skipped: out.skipped,
          gate,
          message: '已下载到「扩展锻造台」暂存区，还没写进 skills/ plugins —— '
            + '去 harness → 扩展锻造台 核对闸门结论、确认安装。'
        });
      }
    },

    // ── Skill 管理 ─────────────────────────────────────────────────────
    // 统一开关入口：前端只改这里，模块内部一律读 skillManager。
    {
      method: 'GET', pattern: '/api/skills',
      handler: async ({ res, json }) => {
        const context = skillRuntimeContext();
        const baseList = skillManager.list(context);
        // 给每条补「是不是随应用分发的内置模块」，前端「下载 → 技能 / 插件」
        // 据此做"来源"筛选（内置 / 第三方分开，方便管理自己后来装的那些）。
        // ⚠️ 刻意算在这里、而不是 manager.status 里：plugin-loader 已经 import 了
        //   skills/manager（加载模块要用），manager 再反向 import plugin-loader 就成了
        //   循环依赖；routes 本来两边都引，是安全的落点。
        // dir 形如 `skills/calculator` / `plugins/ban-state`，取最后一段即目录名。
        for (const it of baseList) {
          it.builtin = isBuiltinModuleDir(String(it.dir || '').split('/').pop());
        }
        // uninstalled：配置里还有 skills.<id> 段、但磁盘上已经没有这个条目
        // （删目录后的配置残留）。UI 显示成"已配置但未安装"，并提供一键清理。
        const installedIds = new Set(baseList.map((s) => s.id));
        const uninstalled = listConfiguredSkillIds()
          .filter((id) => !installedIds.has(id))
          .map((id) => {
            const c = getConfig()?.skills?.[id] || {};
            return {
              id,
              enabled: c.enabled !== false,
              hasSettings: Object.keys(c).some((k) => k !== 'enabled')
            };
          });
        // ── 工具调用性合并 ─────────────────────────────────────────────
        // "加载成功 + 开关打开 + 生效中" ≠ "模型调得到它的工具"：单工具开关、
        // 分类开关、requiresVision、send_to 独立开关……任何一档都能把工具
        // 静默拦在模型列表外。模块页的卡片此前毫不知情，用户看到"生效中"，
        // 实际一个工具都调不到。这里按 skillId 聚合可用性挂上 callability。
        let bySkill = null;
        try {
          bySkill = new Map();
          for (const a of availabilityOf(context)) {
            if (!a.skillId) continue;
            const agg = bySkill.get(a.skillId) || { callables: 0, blocked: [] };
            if (a.enabled) agg.callables += 1;
            else agg.blocked.push({ id: a.id, code: a.code, reason: a.reason });
            bySkill.set(a.skillId, agg);
          }
        } catch { bySkill = null; }   // 诊断失败不影响主列表
        const skills = baseList.map((s) => {
          if (!bySkill || !Array.isArray(s.toolIds) || !s.toolIds.length) return s;
          const agg = bySkill.get(s.id) || { callables: 0, blocked: [] };
          return {
            ...s,
            callability: {
              total: s.toolIds.length,
              callables: agg.callables,
              blocked: agg.blocked
            }
          };
        });
        return json(res, 200, {
          skills,
          summary: skillManager.summary(context),
          capabilities: skillManager.capabilities.list().sort(),
          uninstalled
        });
      }
    },
    {
      // 手动重扫磁盘：UI「刷新」按钮的后端动作。
      // 只读内存注册表的话，watcher 丢事件（目录删除重建 / 网络盘 / 杀软）时
      // 新插件永远进不来。这里走 app.reloadSkills()：重扫 + 激活 + 刷工具 + 重建 watcher。
      method: 'POST', pattern: '/api/skills/reload',
      handler: async ({ res, json }) => {
        if (typeof reloadSkills !== 'function') {
          return json(res, 500, { ok: false, error: '核心未提供 reloadSkills（请升级或检查启动方式）' });
        }
        try {
          const result = await reloadSkills({ reason: 'manual' });
          const context = skillRuntimeContext();
          return json(res, 200, {
            ok: true,
            loaded: result.loaded.map((r) => r.id),
            failed: result.failed.map((r) => ({ id: r.id, error: r.error })),
            pruned: result.pruned,
            skills: skillManager.list(context),
            summary: skillManager.summary(context),
            capabilities: skillManager.capabilities.list().sort()
          });
        } catch (error) {
          return json(res, 500, { ok: false, error: `重扫失败：${String(error?.message ?? error)}` });
        }
      }
    },
    {
      // 信任一个模块并立即重试加载。
      //
      // 准入闸拦下第三方模块后，用户若只能自己去改 data/config.json 的
      // trustedPlugins 数组，那等于"根本用不了自己写的插件"，于是闸门会被
      // 绕过或被整体关掉。这里给一次点击的入口。
      //
      // ⚠️ 严格限定「只能信任当前**确实因高危能力被拒**的模块」，否则这个接口
      //   就退化成万能放行口（配合任意 id 猜测，可以把某个第三方模块悄悄标成
      //   可信，而界面上看不出差别）。判据：它必须已注册在 skillManager.errors 里，
      //   且错误文本带本次闸门的标记。
      // 登记后立刻 reloadSkills()，用户点完就能看到结果。
      method: 'POST', pattern: '/api/skills/trust',
      handler: async ({ req, res, json }) => {
        const body = await readBody(req).catch(() => ({}));
        // ⚠️ 宽容取 id：这个接口的调用方有三类，UI 按钮（id=<目录名>）、
        //   用户脚本、以及**模型直接构造的请求**（缺陷报告由 AI 代测提交，模型会猜
        //   字段名 skillId/dir/dirName 或干脆不带 body）。只回「缺少 id」不教正确写法，
        //   调用方反复换字段重试，体感就是"信任要 id、id 要信任"的死循环。
        //   宽容别名不影响安全性：下面仍有三路 find、"触碰了高危能力"前置校验、
        //   只登记目录名三道闸守着。
        const raw = String(body?.id ?? body?.skillId ?? body?.dir ?? body?.dirName ?? body?.moduleName ?? '').trim();
        if (!raw) {
          return json(res, 400, {
            ok: false,
            error: '缺少 id —— POST body 应为 JSON：{"id": "<扩展目录名>"}'
              + '（目录名取 GET /api/skills 对应条目 dir 字段的最后一段，如 "comfyui-image"）。'
          });
        }
        const norm = raw.replace(/\\/g, '/');
        const base = path.basename(norm);

        // ⚠️ 判据**不能靠猜 `skillManager.errors` 的键**：`errors` 的键是 **manifest.id**
        //   （清单里自己声明的 id），而界面传来的是**目录名**。二者平时相等，可一旦安装时
        //   目录名冲突，安装器会给目录递增后缀（`meme-tracker` → `meme-tracker_1`，
        //   见"永不覆盖"策略），而清单里的 id 不变，两者就分叉：`errors['meme-tracker']`
        //   明明在，按目录名查 `meme-tracker_1` 却永远查不到，用户怎么点都信任不了。
        //   所以回**注册表**找这张卡片自己那一条（界面就是用它渲染的，`dir` 一定对得上），
        //   读它的 `loadError`，与界面决定"要不要显示信任按钮"用的是**同一个字段**。
        let row = null;
        try {
          const rows = skillManager.list(skillRuntimeContext()) || [];
          row = rows.find((r) => String(r.dir || '').replace(/\\/g, '/') === norm)
            || rows.find((r) => path.basename(String(r.dir || '').replace(/\\/g, '/')) === base)
            || rows.find((r) => String(r.id || '') === base)
            || null;
        } catch { row = null; }
        if (!row) {
          return json(res, 400, { ok: false, error: `找不到模块「${raw}」（可能已被移除，刷新列表后再试）。` });
        }

        // 前置校验：它此刻必须正处于「因高危能力被拦」的状态
        const errText = String(row.loadError || '')
          || String(skillManager.errors?.get?.(String(row.id || '')) ?? '')
          || String(skillManager.errors?.get?.(base) ?? '');
        const TRUST_MARK = '触碰了高危能力';
        if (!errText.includes(TRUST_MARK)) {
          return json(res, 400, {
            ok: false,
            error: `模块「${row.name || row.id}」当前不是因高危能力被拦截（无法作为信任对象）。`
              + '若它因其它原因加载失败，请先解决那个原因。'
          });
        }
        // 只登记**目录名**：id 写在第三方可编辑的清单文件里，当作信任判据的话，
        // 攻击者把清单 id 改成别人已信任的名字即可免检。目录名是磁盘上的一级目录名，
        // 第三方装进来时无法自选（冲突会递增后缀）。
        // ⚠️ `checkPluginTrust` 也按这个目录名匹配（plugin-loader 的 dirName），
        //   所以这里必须是**目录名**，不能是 row.id。
        const id = path.basename(String(row.dir || base).replace(/\\/g, '/')) || base;
        const ids = Array.isArray(getConfig().trustedPlugins) ? getConfig().trustedPlugins.map(String) : [];
        if (!ids.includes(id)) {
          updateConfig({ trustedPlugins: [...ids, id] });
          logger.info('routes', `用户主动信任模块：${id}（准入闸要求显式确认；清单 id=${row.id}）`);
        }

        // 立刻重试，让结果当场可见
        let result = null;
        if (typeof reloadSkills === 'function') {
          try { result = await reloadSkills({ reason: 'trust' }); } catch (error) {
            return json(res, 500, { ok: false, error: `已登记信任，但重载失败：${String(error?.message ?? error)}` });
          }
        }
        // 失败清单里的 id 是 **manifest.id**，可能不等于目录名，两种都比一次。
        const failRow = (result?.failed || [])
          .find((f) => String(f.id) === id || String(f.id) === String(row.id || ''));
        const context = skillRuntimeContext();
        return json(res, 200, {
          ok: true,
          trusted: id,
          stillFailing: failRow ? (failRow.error || '仍然失败') : null,
          skills: skillManager.list(context),
          summary: skillManager.summary(context)
        });
      }
    },
    {
      // 本地导入：用户把 zip 包 / 整个文件夹拖进技能页或插件页（或走「导入本地文件」按钮）。
      // body: { kind: 'skill'|'plugin', paths?: [本机绝对路径], zipBase64?: string, zipName?: string }
      //   · paths     ：Electron 里直接从拖放的 File 反查出来的真实路径（前端不过手文件内容）
      //   · zipBase64 ：浏览器/远程打开时的退路（没有本机路径可用，只能传字节）
      // 装完立刻 reloadSkills()，新条目当场出现在页面上。
      method: 'POST', pattern: '/api/skills/import',
      handler: async ({ req, res, json }) => {
        // zip 的 base64 比原文件大约 1/3，给到 12MB（硬上限 16MB 见 app.js）
        const raw = await readBody(req, { maxBytes: 12 * 1024 * 1024 }).catch((e) => {
          if (e?.expose) throw e;
          return {};
        });
        const body = raw && typeof raw === 'object' ? raw : {};
        const kind = body?.kind === 'plugin' ? 'plugin' : 'skill';
        const paths = Array.isArray(body?.paths) ? body.paths.map(String).filter(Boolean) : [];
        const zipBase64 = typeof body?.zipBase64 === 'string' ? body.zipBase64 : '';
        if (!paths.length && !zipBase64) {
          return json(res, 400, { ok: false, error: '没有可导入的内容' });
        }
        let result;
        try {
          result = await importModules({ paths, zipBase64, zipName: String(body?.zipName || ''), kind });
        } catch (e) {
          return json(res, 400, { ok: false, error: String(e?.message ?? e) });
        }
        if (!result.installed.length) {
          return json(res, 400, { ok: false, error: result.errors[0]?.error || '导入失败', errors: result.errors });
        }
        log('info', `[skill] 本地导入：${result.installed.map((r) => `${r.kind}s/${r.id}`).join('、')}`);
        // 重扫 + 激活 + 刷工具，并重建目录监听（新目录必须重新 watch 才能热重载）
        let reload = null;
        try {
          if (typeof reloadSkills === 'function') reload = await reloadSkills({ reason: 'import' });
        } catch (e) {
          log('warn', `[skill] 导入后重扫失败：${String(e?.message ?? e)}`);
        }
        const context = skillRuntimeContext();
        return json(res, 200, {
          ok: true,
          installed: result.installed.map((r) => ({ kind: r.kind, id: r.id, dir: r.dir, files: r.files })),
          errors: result.errors,
          skills: skillManager.list(context),
          summary: skillManager.summary(context),
          reloaded: Boolean(reload)
        });
      }
    },
    {
      // 清理"已配置但未安装"的残留配置段：删掉 config.skills.<id>。
      // body: { ids: [id...] }，只删传入的 id，且要求该 id 当前确实不在注册表里
      //（防止把正在运行的 Skill 配置误删）。
      method: 'POST', pattern: '/api/skills/cleanup',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const ids = Array.isArray(body?.ids) ? body.ids.map(String).filter(Boolean) : [];
        if (!ids.length) return json(res, 400, { ok: false, error: '缺少 ids' });
        const installed = new Set(skillManager.list().map((s) => s.id));
        const removable = ids.filter((id) => !installed.has(id));
        if (!removable.length) {
          return json(res, 400, { ok: false, error: '没有可清理的条目（都处于已安装状态）' });
        }
        const skillsCfg = getConfig()?.skills || {};
        const next = { ...skillsCfg };
        for (const id of removable) delete next[id];
        // deepMerge 传 {} 删不掉已有键，必须用 __replace__ 整体替换
        updateConfig({ skills: { __replace__: next } });
        emit('status', { configUpdated: true });
        return json(res, 200, {
          ok: true,
          removed: removable,
          skipped: ids.filter((id) => installed.has(id)),
          config: sanitizedConfig(getConfig())
        });
      }
    },
    {
      // 删除一个 Skill / 插件：把它的整个目录从磁盘移除，然后热重扫。
      // 不可逆操作（前端有二次确认），后端仍做**路径安全校验**：
      //   ① 目标目录必须位于 skills/ 或 plugins/ 根目录**之内**（防路径穿越 / 误删项目其它文件）；
      //   ② 目标必须是真实存在的目录。
      // 顺序刻意是"先删目录 → 再注销 → 清配置残留 → 重扫"：
      // 即使后面某步失败，磁盘上也不会残留一个"半死"模块。
      method: 'DELETE', pattern: /^\/api\/skills\/([^/]+)$/,
      handler: async ({ res, json, match }) => {
        const id = decodeURIComponent(match[1]);
        const skill = skillManager.registry.get(id);
        if (!skill) return json(res, 404, { ok: false, error: `模块不存在：${id}` });

        // 用加载器记录的绝对目录（skill.dir）判定归属，不信任前端传来的任何路径。
        const absDir = path.resolve(String(skill.dir || ''));
        const isInside = (root) => {
          const rel = path.relative(root, absDir);
          return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
        };
        if (![SKILLS_DIR, PLUGINS_DIR].some(isInside)) {
          return json(res, 400, {
            ok: false,
            error: `拒绝删除：目标不在 skills/ 或 plugins/ 目录内（${skill.relDir || absDir}）`
          });
        }
        if (!fs.existsSync(absDir) || !fs.statSync(absDir).isDirectory()) {
          return json(res, 404, { ok: false, error: `目录不存在：${skill.relDir || absDir}` });
        }

        try {
          fs.rmSync(absDir, { recursive: true, force: true });
        } catch (error) {
          // 目录被占用（插件起了子进程 / 原生模块句柄未释放）时最常见，如实回报
          return json(res, 500, { ok: false, error: `删除目录失败：${String(error?.message ?? error)}` });
        }

        // 注销：deactivate + dispose + 回收该模块注册的工具与能力
        skillManager.unregister(id, { reason: 'deleted' });

        // 顺带清掉 config.skills.<id> 残留段（否则它会变成"已配置但未安装"的幽灵条目）
        try {
          const skillsCfg = getConfig()?.skills || {};
          if (Object.prototype.hasOwnProperty.call(skillsCfg, id)) {
            const next = { ...skillsCfg };
            delete next[id];
            // deepMerge 传对象删不掉已有键，必须用 __replace__ 整体替换（同 cleanup 路由）
            updateConfig({ skills: { __replace__: next } });
          }
        } catch { /* 配置清理失败不影响"目录已删除"这一事实 */ }

        // 热重扫：重建 watcher，并让列表立刻反映删除（目录净减时 watcher 会丢事件）
        try {
          if (typeof reloadSkills === 'function') await reloadSkills({ reason: 'delete' });
        } catch { /* 忽略：注册表上面已手动注销 */ }

        emit('status', { configUpdated: true });
        const context = skillRuntimeContext();
        return json(res, 200, {
          ok: true,
          id,
          dir: skill.relDir || '',
          skills: skillManager.list(context),
          summary: skillManager.summary(context),
          capabilities: skillManager.capabilities.list().sort(),
          config: sanitizedConfig(getConfig())
        });
      }
    },
    {
      // 单个 Skill：切开关 / 改设置。两个动作分开处理，避免"改了设置顺手把我开着的关了"。
      method: 'POST', pattern: /^\/api\/skills\/([^/]+)$/,
      handler: async ({ req, res, json, match }) => {
        const id = decodeURIComponent(match[1]);
        const body = await bodyOf(req);
        const context = skillRuntimeContext();
        const skill = skillManager.registry.get(id);
        if (!skill) return json(res, 404, { ok: false, error: `Skill 不存在：${id}` });

        // 1) 开关（先写配置，再跑生命周期；顺序不能反，
        //    activate 里读配置必须已经生效，否则 Skill 会以为自己是关闭的）
        if (body.enabled !== undefined) {
          setSkillEnabled(id, !!body.enabled);
          if (body.enabled) skillManager.activate(id, context);
          else skillManager.deactivate(id, context);
        }

        // 2) 设置（只允许改 manifest 声明过的键，防止前端塞垃圾字段进配置）
        if (body.settings && typeof body.settings === 'object') {
          const allowed = new Set([
            ...Object.keys(skill.manifest.settings || {}),
            ...Object.keys(skill.manifest.configSchema || {})
          ]);
          const schema = skill.manifest.configSchema || {};
          const current = getSkillConfig(id, skill.manifest.settings || {});
          const patch = {};
          for (const [k, v] of Object.entries(body.settings)) {
            if (!allowed.has(k)) continue;
            // 密文字段：收到脱敏占位符或空串 = "不修改"。
            // 不这么做的话，用户只是打开表单点了保存，Cookie/Key 就被覆盖成 '******'。
            if (schema[k]?.secret && (v === '******' || String(v ?? '').trim() === '')) continue;
            patch[k] = v;
          }
          if (Object.keys(patch).length) setSkillConfig(id, patch);
        }

        emit('status', { configUpdated: true });
        return json(res, 200, {
          ok: true,
          skill: skillManager.status(id, context),
          // ⚠️ 响应里的 settings 必须用脱敏视图（settingsView）：
          //    直接回 getSkillConfig（明文）会在保存一次设置后把
          //    apiKey / Cookie 原文发回浏览器，与 GET 列表的脱敏口径相反。
          settings: skillManager.settingsView(id),
          config: sanitizedConfig(getConfig())
        });
      }
    },
    {
      // 开关配置总览：给设置页渲染"技能"区块
      method: 'GET', pattern: '/api/skills/capabilities',
      handler: async ({ res, json }) => {
        const context = skillRuntimeContext();
        const caps = skillManager.capabilities.list().sort();
        return json(res, 200, {
          capabilities: caps.map((c) => ({
            name: c,
            ...skillManager.explainCapability(c, context)
          }))
        });
      }
    },
    {
      // 工具可用性总览：明确告诉 UI "这个工具为什么没生效"
      method: 'GET', pattern: '/api/tools/availability',
      handler: async ({ res, json }) => {
        const context = skillRuntimeContext();
        const availability = availabilityOf(context);
        const defs = new Map(listTools().map((t) => [t.id, t]));
        return json(res, 200, {
          categories: CATEGORY_META,
          tools: availability.map((a) => ({
            id: a.id,
            category: defs.get(a.id)?.category || 'system',
            skillId: a.skillId,
            enabled: a.enabled,
            code: a.code,
            reason: a.reason
          }))
        });
      }
    },


    {
      method: 'POST', pattern: '/api/config',
      handler: async ({ req, res, json }) => {
        const patch = await readBody(req);
        if (patch.backup) patch.backup = prepareBackupConfig(patch.backup);
        const next = updateConfig(patch);
        store.setMaxPerChat(next.store?.maxMessagesPerChat ?? 0);
        sessions?.setKeepFiles?.(next.store?.keepSessionFiles ?? 0);
        if (next.proactive?.enabled) orchestrator.startProactiveLoop(); else orchestrator.stopProactiveLoop();
        initPriceFeed(FIXED_PRICE_FEED_URL);
        // ffmpeg 的解析结果带缓存。用户可能刚改了「手填路径 / 优先使用哪一组」，
        // 不主动作废的话要等下一次缓存过期（甚至永远，命中即长期缓存）才生效，
        // 表现为"设置改了但界面和实际调用都还是旧的"。这里无条件作废，代价一次探测。
        try {
          const { invalidateFfmpegCache } = await import('./ffmpeg-resolve.js');
          invalidateFfmpegCache();
        } catch { /* ffmpeg 模块不可用时不影响保存 */ }
        emit('status', { configUpdated: true });
        // ⚠️ 必须脱敏：updateConfig 返回的是内存里的活配置对象，含明文 apiKey /
        //    accessToken / dshProviderKeys。GET /api/config 一直是脱敏的，
        //    这里漏掉会让"任何一次保存设置"把全部明文密钥回传给浏览器。
        return json(res, 200, { ok: true, config: sanitizedConfig(next) });
      }
    },
    {
      method: 'GET', pattern: '/api/tools',
      handler: async ({ res, json }) => {
        const { listTools } = await import('./tool-registry.js');
        const tools = listTools().map((t) => ({
          id: t.id, name: t.name, description: t.description, category: t.category,
          icon: t.icon, defaultEnabled: t.defaultEnabled, requiresVision: t.requiresVision, requiresSearch: t.requiresSearch
        }));
        return json(res, 200, { tools });
      }
    },
    {
      // ── 插件面板内的「用户操作」通道 ────────────────────────────────────
      // 插件面板是**只读静态页**（安全模型见 src/skills/panel.js），群友反馈
      // "表情库里的表情没法自己编辑"，备注/标签只能让机器人在聊天里改。
      // 这条通道让面板把"用户明确点的保存"转发成一次工具调用。
      //
      // 安全三道（缺一不可）：
      //   ① 来源校验 keyEndpointAllowed：只放行控制台自己（挡外部网页冒用 127.0.0.1）；
      //   ② 工具白名单：只放"不发送消息、不读群上下文、只动插件自己数据"的工具；
      //      发送类（send_message/sticker__send_sticker）、读群类一律不在此列；
      //   ③ 工具必须真实注册且可执行。
      method: 'POST', pattern: '/api/plugin-tool',
      handler: async ({ req, res, json }) => {
        if (!keyEndpointAllowed(req)) return json(res, 403, { ok: false, error: '请求来源不被信任' });
        // 白名单：目前只有表情库面板需要（写备注 / 删除 / 恢复收藏表情）。
        // 新增工具前先问自己：它会不会发消息？会不会读群聊天？会不会改全局配置？
        // 任一为"会"，就不要加进来。
        const ALLOWED = new Set([
          'sticker__note',
          'sticker__delete_sticker',
          'sticker__restore_sticker',
          'sticker__list_deleted_stickers'
        ]);
        const body = await bodyOf(req);
        const name = String(body?.name || '');
        const args = body?.args && typeof body.args === 'object' ? body.args : {};
        if (!ALLOWED.has(name)) return json(res, 403, { ok: false, error: '该工具不允许从面板调用' });
        try {
          const { getTool } = await import('./tool-registry.js');
          const def = getTool(name);
          if (!def || typeof def.execute !== 'function') {
            return json(res, 404, { ok: false, error: '工具不存在或当前不可用' });
          }
          const r = await def.execute({}, args);
          if (r && r.isError) return json(res, 200, { ok: false, error: String(r.content || '执行失败') });
          return json(res, 200, { ok: true, result: String(r?.content ?? '') });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },

    // ── 版本 / 更新 ──────────────────────────────────────────────────
    {
      method: 'GET', pattern: '/api/version',
      handler: async ({ res, json }) => json(res, 200, { version: localVersion() })
    },
    {
      method: 'GET', pattern: '/api/update-check',
      handler: async ({ res, json }) => {
        const current = localVersion();
        // 功能关闭或没配源：明确返回 disabled，不发任何网络请求。
        // 不能只是"查不到"，UI 需要把"这项没开"和"网络不通"分开显示，
        // 否则用户会以为检查失败，反复点。
        const feed = getConfig()?.update || {};
        const feedUrl = String(feed.feedUrl || '').trim();
        if (feed.enabled !== true || !feedUrl) {
          return json(res, 200, {
            ok: true, current, disabled: true, hasUpdate: false,
            reason: feed.enabled !== true ? '在线更新检查未启用' : '尚未配置更新源地址'
          });
        }
        try {
          const r = await fetch(feedUrl, { signal: AbortSignal.timeout(8000), cache: 'no-store' });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const info = await r.json();
          const latest = String(info.version || '');
          if (!latest) throw new Error('version.json 缺少 version 字段');
          // 远端比本地还低 = 更新源没跟着发版推进。此时 hasUpdate 必然 false，
          // 光看它和"已是最新"分不开（实测远端 0.4.0 / 本地 0.4.8.9）。
          // 单独给 stale 字段，UI 可以据此提示"更新源未更新"而不是"已是最新"。
          const stale = compareSemver(latest, current) < 0;
          if (stale && !updateFeedState.staleWarned) {
            updateFeedState.staleWarned = true;
            logger.warn('update', `更新源版本（${latest}）落后于当前安装（${current}）：version.json 需要随发版更新，否则新版本永远不会被提示`);
          }
          return json(res, 200, {
            ok: true, current, latest,
            hasUpdate: compareSemver(latest, current) > 0,
            stale,
            staleHint: stale
              ? `更新源版本（${latest}）低于当前安装（${current}）：服务器上的 version.json 尚未推进，因此不会提示更新`
              : '',
            // 下载页地址由 version.json 给；没给就不给链接（不内置任何第三方地址）
            url: String(info.url || ''),
            notes: String(info.notes || '')
          });
        } catch (error) {
          return json(res, 200, { ok: false, current, error: String(error?.message ?? error) });
        }
      }
    },

    // ── 模型 / 会话 / 存档 ───────────────────────────────────────────
    {
      method: 'GET', pattern: '/api/models',
      handler: async ({ res, json }) => {
        // 没配 Base URL 时直接说清楚，别让它走到 fetch 变成
        // 「网络错误 ERR_INVALID_URL：/models Invalid URL」，用户会去查网络。
        const baseUrl = String(getConfig().api?.baseUrl ?? '').trim();
        if (!baseUrl) {
          return json(res, 400, {
            ok: false,
            error: '未配置模型服务商：请先在设置 → 模型里填写 Base URL 与 API Key',
            code: 'no-base-url'
          });
        }
        try {
          const models = await listModels();
          return json(res, 200, { models });
        } catch (error) {
          return json(res, 502, { error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'GET', pattern: '/api/sessions',
      handler: async ({ res, json, url }) => {
        const limit = Math.min(1048576, Math.max(1, Number(url.searchParams.get('limit')) || 1048576));
        return json(res, 200, { sessions: sessions.listSummaries(limit) });
      }
    },
    {
      method: 'GET', pattern: /^\/api\/sessions\/([\w-]+)$/,
      handler: async ({ res, json, match }) => {
        const s = sessions.get(match[1]);
        if (!s) return json(res, 404, { error: '会话不存在' });
        return json(res, 200, s);
      }
    },
    {
      // 主动删除一条会话记录（正在运行的不能删）
      method: 'DELETE', pattern: /^\/api\/sessions\/([\w-]+)$/,
      handler: async ({ res, json, match }) => {
        const removed = sessions.remove(match[1]);
        if (!removed) return json(res, 409, { ok: false, error: '会话不存在或正在运行（运行中的会话不能删除）' });
        emit('session-end', { sessionId: match[1], status: 'deleted' });
        return json(res, 200, { ok: true });
      }
    },
    {
      // 清空全部已结束的会话记录（保留运行中/等待中的）
      method: 'POST', pattern: '/api/sessions/clear-finished',
      handler: async ({ res, json }) => {
        const removed = sessions.clearFinished();
        emit('session-end', { status: 'cleared', removed });
        return json(res, 200, { ok: true, removed });
      }
    },
    {
      // 手动重试一条失败的会话：把触发批翻回未读并立即唤醒（会话页「重试」按钮）。
      // 只有 error 状态且未发出过消息的会话允许重试（已发言的重试 = 群里看到两遍）。
      method: 'POST', pattern: /^\/api\/sessions\/([\w-]+)\/retry$/,
      handler: async ({ res, json, match }) => {
        const r = orchestrator.retrySession(match[1]);
        if (!r.ok) return json(res, 409, { ok: false, error: r.reason });
        return json(res, 200, { ok: true, restored: r.restored });
      }
    },
    {
      // 中止一个运行中/等待中的会话（会话页「中止」按钮）。
      // 运行中的会话在下一轮 LLM 请求前安全收尾（不截断途中的请求/发送）；
      // 等待中的会话直接干净消失。不在两种状态之一（如已结束）则拒绝。
      method: 'POST', pattern: /^\/api\/sessions\/([\w-]+)\/abort$/,
      handler: async ({ res, json, match }) => {
        const r = orchestrator.abortSession(match[1]);
        if (!r.ok) return json(res, 409, { ok: false, error: r.reason });
        return json(res, 200, { ok: true });
      }
    },
    {
      method: 'GET', pattern: '/api/chats',
      handler: async ({ res, json }) => {
        const chats = store.listChats().map((key) => ({ key, ...store.getChatMeta(key) }))
          .sort((a, b) => b.lastTs - a.lastTs);
        await Promise.allSettled(chats.map(async (c) => {
          const m = /^group:(\d+)$/.exec(String(c.key || ''));
          if (!m) { c.chatName = ''; return; }
          // ⚠️ 超时定时器必须在**正常路径**上也清掉。缓存命中时 getChatName 立刻
          //   resolve，但 3 秒定时器仍挂在事件循环上，而本端点被 UI 每 15 秒轮询一次、
          //   每次对**每个群**各起一个：几百个群时事件循环里长期漂着上千个无用定时器。
          //   放在 finally 里清，两条路径都覆盖。
          let timer = null;
          try {
            c.chatName = await Promise.race([
              orchestrator.getChatName(m[1]),
              new Promise((r) => { timer = setTimeout(() => r(''), 3000); })
            ]) || '';
          } catch { c.chatName = ''; } finally { if (timer) clearTimeout(timer); }
        }));
        return json(res, 200, { chats });
      }
    },

    // ── 记忆 ─────────────────────────────────────────────────────────
    {
      method: 'GET', pattern: '/api/memory-files',
      handler: async ({ res, json }) => {
        const files = memory.listChats().map((chatKey) => {
          const members = memory.members(chatKey);
          const impressionCount = members.reduce((n, m) => n + m.impressions.length, 0);
          return {
            chatKey, impressionCount, memberCount: members.length,
            updatedAt: Math.max(0, ...members.map((m) => Number(m.updatedAt) || 0))
          };
        });
        const seen = new Set(files.map((f) => f.chatKey));
        for (const gid of (getConfig().allow?.groups || [])) {
          const key = `group:${String(gid)}`;
          if (!seen.has(key)) { files.push({ chatKey: key, impressionCount: 0, memberCount: 0, updatedAt: 0, consolidating: false }); seen.add(key); }
        }
        for (const uid of (getConfig().allow?.private || [])) {
          const key = `private:${String(uid)}`;
          if (!seen.has(key)) { files.push({ chatKey: key, impressionCount: 0, memberCount: 0, updatedAt: 0, consolidating: false }); seen.add(key); }
        }
        // 聊过但既没有记忆文件、也不在白名单里的会话（典型：allowAllWhenEmpty
        // 模式下机器人回过话的群）也要出现在记忆页，否则这种群永远进不了列表，
        // 就没机会点「整理本群记忆」，永远不会有记忆文件，卡死循环。
        // 只补轻量占位条目：updatedAt 用消息存档的最后一条时间，点开详情走
        // GET /api/memory-files/:key，对没有文件的会话返回空结构，不会报错，
        // 详情页里的「整理本群记忆」按钮照常可用。
        for (const key of store.listChats()) {
          if (seen.has(key)) continue;
          let lastTs = 0;
          try { lastTs = Number(store.getChatMeta(key)?.lastTs) || 0; } catch { /* 元信息拿不到就按 0 排序 */ }
          files.push({ chatKey: key, impressionCount: 0, memberCount: 0, updatedAt: lastTs, consolidating: false });
          seen.add(key);
        }
        const busy = orchestrator.consolidating;
        for (const f of files) f.consolidating = busy.has(f.chatKey);
        files.sort((a, b) => b.updatedAt - a.updatedAt);
        return json(res, 200, { files, consolidating: [...busy] });
      }
    },
    {
      method: 'GET', pattern: /^\/api\/memory-files\/(group|private)_(\d+)$/,
      handler: async ({ res, json, match }) => {
        const chatKey = `${match[1]}:${match[2]}`;
        return json(res, 200, { ...memory.query(chatKey), members: memory.members(chatKey) });
      }
    },
    {
      method: 'PUT', pattern: /^\/api\/memory-files\/(group|private)_(\d+)\/members\/(\d+)$/,
      handler: async ({ req, res, json, match }) => {
        const chatKey = `${match[1]}:${match[2]}`;
        const body = await bodyOf(req);
        try {
          const member = memory.editMemberImpression(chatKey, {
            userId: match[3],
            name: String(body.name ?? ''),
            note: body.note ?? '',
            impressions: body.impressions ?? []
          });
          emit('memory-update', { chatKey });
          return json(res, 200, { ok: true, member });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'DELETE', pattern: /^\/api\/memory-files\/(group|private)_(\d+)\/members\/(\d+)$/,
      handler: async ({ res, json, match }) => {
        const chatKey = `${match[1]}:${match[2]}`;
        memory.removeMember(chatKey, match[3]);
        emit('memory-update', { chatKey });
        return json(res, 200, { ok: true });
      }
    },
    {
      // 删除整个会话的记忆（记忆页「删除本会话记忆」按钮）
      method: 'DELETE', pattern: /^\/api\/memory-files\/(group|private)_(\d+)$/,
      handler: async ({ res, json, match }) => {
        const chatKey = `${match[1]}:${match[2]}`;
        memory.removeChat(chatKey);
        emit('memory-update', { chatKey });
        return json(res, 200, { ok: true });
      }
    },
    {
      method: 'POST', pattern: '/api/memory-files/consolidate',
      handler: async ({ req, res, json }) => {
        try {
          const body = await bodyOf(req);
          const chatKey = String(body.chatKey || '');
          if (!/^(group|private):\d+$/.test(chatKey)) return json(res, 400, { ok: false, error: 'chatKey 格式错误' });
          let userIds = null;
          if (body.userIds != null) {
            const arr = Array.isArray(body.userIds) ? body.userIds : [body.userIds];
            userIds = arr.map((u) => String(u ?? '').trim()).filter((u) => /^\d{1,15}$/.test(u));
            if (!userIds.length) return json(res, 400, { ok: false, error: 'userIds 需为 QQ 号数组' });
          }
          const force = body.force !== false;
          if (orchestrator.consolidating.has(chatKey)) return json(res, 409, { ok: false, error: '该群已在整理中' });
          orchestrator.consolidating.add(chatKey);
          emit('memory-update', { chatKey, phase: 'consolidate-start', userIds });
          orchestrator.consolidateMemoryForChat(chatKey, { userIds, force })
            .then((result) => emit('memory-update', { chatKey, phase: 'consolidate-done', ...(result || {}) }))
            .catch((error) => emit('memory-update', { chatKey, phase: 'consolidate-error', error: String(error?.message ?? error) }))
            .finally(() => orchestrator.consolidating.delete(chatKey));
          return json(res, 202, { ok: true, started: true });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },

    // ── 存档消息 ─────────────────────────────────────────────────────
    {
      method: 'GET', pattern: /^\/api\/chats\/(group|private)_(\d+)\/messages$/,
      handler: async ({ res, json, url, match }) => {
        const chatKey = `${match[1]}:${match[2]}`;
        const limit = Math.min(1048576, Math.max(1, Number(url.searchParams.get('limit')) || 1048576));
        const messages = store.recent(chatKey, { limit }).map((m) => ({
          id: m.id, mid: m.mid, ts: m.ts, senderId: m.senderId, senderName: m.senderName,
          text: m.text, self: m.self, read: m.read, reply: m.reply, media: m.media || []
        }));
        return json(res, 200, { chatKey, messages });
      }
    },
    {
      method: 'POST', pattern: '/api/media-data',
      handler: async ({ req, res, json }) => {
        try {
          const body = await readBody(req);
          const items = Array.isArray(body?.items) ? body.items.slice(0, 20) : [];
          const mimeOf = (p) => /\.png$/i.test(p) ? 'image/png' : /\.gif$/i.test(p) ? 'image/gif' : /\.webp$/i.test(p) ? 'image/webp' : 'image/jpeg';
          // 同步 IO 改异步：旧逻辑 statSync + readFileSync，单请求最多 20 条 ×
          // 单文件 15MB = 最坏 300MB 同步读，直接堵主进程事件循环（存档页打开
          // 多张大图的群时窗口卡住）。
          const fileToDataUrl = async (fp) => {
            const st = await fs.promises.stat(fp);
            if (st.size > 15 * 1024 * 1024) return null;
            const buf = await fs.promises.readFile(fp);
            return `data:${mimeOf(fp)};base64,${buf.toString('base64')}`;
          };
          // 下载一律走 safe-fetch：这里的 url 来自请求体（前端/任何本机进程都能构造），
          // 直接 fetch 等于给了一个"让本机去抓内网"的 SSRF 入口。
          const safeToDataUrl = async (rawUrl) => {
            const { buffer, contentType } = await safeFetchBinary(String(rawUrl), 15 * 1024 * 1024, { browseLocked: browseLockState().enabled });
            if (!buffer?.length || buffer.length > 15 * 1024 * 1024) return null;
            const type = String(contentType || 'image/jpeg').split(';')[0].trim();
            if (!/^image\//i.test(type)) return null;
            return `data:${type};base64,${buffer.toString('base64')}`;
          };
          const results = [];
          for (const it of items) {
            let dataUrl = null;
            try {
              const ret = await onebot.call('get_image', { file: String(it?.file || '') });
              if (ret?.file && fs.existsSync(String(ret.file))) dataUrl = await fileToDataUrl(String(ret.file));
              if (!dataUrl && ret?.url) dataUrl = await safeToDataUrl(ret.url);
            } catch { /* 缓存没有 / 地址不可信就走下一条 */ }
            if (!dataUrl && it?.url) {
              try { dataUrl = await safeToDataUrl(it.url); } catch { /* 过期或不可信就放弃 */ }
            }
            results.push(dataUrl ? { dataUrl } : null);
          }
          return json(res, 200, { ok: true, results });
        } catch (error) {
          return json(res, 200, { ok: false, error: String(error?.message ?? error), results: [] });
        }
      }
    },

    // ── 群成员 / 会话控制 ────────────────────────────────────────────
    {
      method: 'GET', pattern: /^\/api\/groups\/(\d+)\/members$/,
      handler: async ({ res, json, match }) => {
        try {
          const list = await onebot.call('get_group_member_list', { group_id: Number(match[1]) });
          const members = (Array.isArray(list) ? list : (list?.data ?? []))
            .map((m) => ({ userId: String(m.user_id), nickname: String(m.nickname || ''), card: String(m.card || '') }))
            .sort((a, b) => String(a.card || a.nickname).localeCompare(String(b.card || b.nickname), 'zh-CN'));
          return json(res, 200, { members });
        } catch (error) {
          return json(res, 502, { error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'POST', pattern: /^\/api\/chats\/(group|private)_(\d+)\/wake$/,
      handler: async ({ res, json, match }) => json(res, 200, { ok: orchestrator.forceWake(`${match[1]}:${match[2]}`) })
    },
    {
      method: 'POST', pattern: /^\/api\/chats\/(group|private)_(\d+)\/test-send$/,
      handler: async ({ req, res, json, match }) => {
        const body = await readBody(req);
        const text = String(body.text ?? '').trim();
        if (!text) return json(res, 400, { error: '消息内容为空' });
        try {
          const chatKey = `${match[1]}:${match[2]}`;
          const data = await onebot.sendText(match[1], match[2], text);
          store.appendSelf(chatKey, { text, ts: Date.now() });
          emit('chat-update', chatKey);
          return json(res, 200, { ok: true, messageId: data?.message_id ?? null });
        } catch (error) {
          return json(res, 502, { error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'POST', pattern: /^\/api\/chats\/(group|private)_(\d+)\/mark-read$/,
      handler: async ({ res, json, match }) => json(res, 200, { ok: true, marked: store.drainUnread(`${match[1]}:${match[2]}`).length })
    },
    {
      // 清空某会话的全部消息（整体清除存档）
      method: 'POST', pattern: /^\/api\/chats\/(group|private)_(\d+)\/clear$/,
      handler: async ({ res, json, match }) => {
        const chatKey = `${match[1]}:${match[2]}`;
        const removed = store.clearChat(chatKey);
        emit('chat-update', chatKey);
        return json(res, 200, { ok: true, removed });
      }
    },
    {
      // 仅屏蔽（不删除）：把某会话全部未读标记为已读，不再触发回复
      method: 'POST', pattern: /^\/api\/chats\/(group|private)_(\d+)\/mute$/,
      handler: async ({ res, json, match }) => {
        const chatKey = `${match[1]}:${match[2]}`;
        const marked = store.muteUnread(chatKey);
        emit('chat-update', chatKey);
        return json(res, 200, { ok: true, marked });
      }
    },
    {
      // 部分清除：删除指定本地 id 的消息
      method: 'POST', pattern: /^\/api\/chats\/(group|private)_(\d+)\/delete-messages$/,
      handler: async ({ req, res, json, match }) => {
        const chatKey = `${match[1]}:${match[2]}`;
        const body = await bodyOf(req);
        const ids = Array.isArray(body?.ids) ? body.ids.map(Number).filter((n) => Number.isFinite(n)) : [];
        if (!ids.length) return json(res, 400, { ok: false, error: '缺少要删除的消息 id 列表（ids）' });
        const removed = store.removeByLocalIds(chatKey, ids);
        emit('chat-update', chatKey);
        return json(res, 200, { ok: true, removed });
      }
    },
    {
      // 收紧本地 id：把空洞重排成 1..n，恢复【过去状态】窗口锚定（前缀缓存）。
      // 一次操作，幂等；已稠密时调用无副作用（重排结果不变）。
      method: 'POST', pattern: /^\/api\/chats\/(group|private)_(\d+)\/densify$/,
      handler: async ({ res, json, match }) => {
        const chatKey = `${match[1]}:${match[2]}`;
        const r = store.densify(chatKey);
        emit('chat-update', chatKey);
        return json(res, 200, { ok: true, chatKey, ...r });
      }
    },
    {
      method: 'POST', pattern: '/api/pause',
      handler: async ({ req, res, json }) => {
        const body = await readBody(req);
        const wasPaused = orchestrator.paused;
        orchestrator.setPaused(!!body.paused);
        if (wasPaused && !orchestrator.paused && !body.skipBacklog) orchestrator.drainBacklogAfterResume();
        return json(res, 200, { ok: true, paused: orchestrator.paused });
      }
    },
    {
      method: 'DELETE', pattern: '/api/pause',
      handler: async ({ res, json }) => {
        orchestrator.setPaused(false);
        const marked = {};
        for (const chatKey of store.listChats()) {
          const n = store.drainUnread(chatKey).length;
          if (n > 0) marked[chatKey] = n;
        }
        emit('chat-update', '*');
        return json(res, 200, { ok: true, paused: false, marked });
      }
    },

    // ── 日志系统 ─────────────────────────────────────────────────────
    {
      // 最近的日志（UI 日志页签首次加载）
      method: 'GET', pattern: '/api/logs',
      handler: async ({ res, json, url }) => {
        const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 200));
        return json(res, 200, { logs: logger.recent(limit), level: logger.getLevel() });
      }
    },
    {
      // 调整最低落盘级别（debug/info/warn/error）
      method: 'POST', pattern: '/api/logs/level',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const level = String(body.level || 'info');
        logger.setLevel(level);
        return json(res, 200, { ok: true, level: logger.getLevel() });
      }
    },

    // ══ 自动修复（self-fix 插件提供 fix.* 能力）══════════════════════════════
    //
    // 分工与 /api/doctor/* 完全同构：**插件负责"给能力"（沙箱、协议闸、验证器、快照），
    // 本层负责"调模型 + 编排流程"**。核心不 import 那个插件，只按能力名取。
    //
    // 两道人工闸在这里被强化成"后端绕不过去的门"：
    //   · 闸①：/api/fix/propose 只产出提案（不写盘）并返回一次性 approvalToken；
    //          /api/fix/apply 必须回传该令牌，令牌不对/用过一律拒绝。
    //          这样"人工批准"才是代码层的门，而不是界面上的装饰。
    //   · 闸②：/api/fix/verify 把**原始产物**留档；/api/fix/rerun 限次（防"刷到通过"）；
    //          通过要人显式调 /api/fix/commit 才会落地。
    {
      method: 'GET', pattern: '/api/fix/status',
      handler: async ({ res, json }) => {
        const ctx = skillRuntimeContext();
        const provs = skillManager.getCapabilityProviders('fix.status', ctx);
        if (!provs.length) {
          return json(res, 200, {
            ok: true, available: false,
            error: '「自动修复」模块未注册（自检 → 自动修复 页可查看状态）'
          });
        }
        try { return json(res, 200, { ok: true, available: true, ...(provs[0].fn({}) || {}) }); }
        catch (error) { return json(res, 500, { ok: false, available: true, error: String(error?.message ?? error) }); }
      }
    },
    {
      method: 'GET', pattern: '/api/fix/list',
      handler: async ({ res, json, url }) => {
        const ctx = skillRuntimeContext();
        const provs = skillManager.getCapabilityProviders('fix.list', ctx);
        if (!provs.length) return json(res, 200, { ok: false, available: false, error: '「自动修复」插件未启用' });
        const status = String(url.searchParams.get('status') || '');
        const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 200));
        try { return json(res, 200, { ok: true, available: true, ...(provs[0].fn({ status, limit }) || {}) }); }
        catch (error) { return json(res, 500, { ok: false, error: String(error?.message ?? error) }); }
      }
    },
    {
      method: 'GET', pattern: '/api/fix/detail',
      handler: async ({ res, json, url }) => {
        const ctx = skillRuntimeContext();
        const provs = skillManager.getCapabilityProviders('fix.detail', ctx);
        if (!provs.length) return json(res, 200, { ok: false, available: false, error: '「自动修复」插件未启用' });
        const fixId = String(url.searchParams.get('fixId') || '');
        if (!fixId) return json(res, 400, { ok: false, error: '缺少 fixId' });
        try { return json(res, 200, { available: true, ...(provs[0].fn({ fixId }) || {}) }); }
        catch (error) { return json(res, 500, { ok: false, error: String(error?.message ?? error) }); }
      }
    },
    {
      // 闸①之前：只出一条**提案**。不写任何真实文件，本接口也绝不落盘改动。
      method: 'POST', pattern: '/api/fix/propose',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const ctx = skillRuntimeContext();
        const promptProvs = skillManager.getCapabilityProviders('fix.prompt', ctx);
        const createProvs = skillManager.getCapabilityProviders('fix.create', ctx);
        if (!promptProvs.length || !createProvs.length) {
          return json(res, 200, { ok: false, available: false, error: '「自动修复」插件未启用（或未开启自动修复）' });
        }
        // ① 拼 prompt（插件侧读文件片段，核心不懂路径规则）
        let p;
        try {
          p = promptProvs[0].fn({
            question: String(body.question || ''),
            answer: String(body.answer || ''),
            target: body.target || null,
            extraNote: String(body.extraNote || '')
          });
        } catch (error) { return json(res, 500, { ok: false, error: `准备提案失败：${String(error?.message ?? error)}` }); }
        if (!p?.ok) return json(res, 200, { ok: false, available: true, error: p?.error || '无法准备提案' });

        // ② 选凭据（与 /api/doctor/ask 完全同源：doctorApi 开关对这里也生效）
        const cfg = getConfig();
        const d = cfg.doctorApi || {};
        const useOwn = d.enabled === true && String(d.model || '').trim();
        const overrides = useOwn ? {
          baseUrl: String(d.baseUrl || cfg.api?.baseUrl || ''),
          apiKey: String(d.apiKey || '').trim() || resolveApiKey(cfg),
          model: String(d.model).trim()
        } : null;
        const modelName = useOwn ? overrides.model : cfg.api?.model;
        if (!modelName) {
          return json(res, 200, {
            ok: false, available: true,
            error: useOwn ? '自检专用模型未填 model（harness → 模型设置）' : '尚未配置聊天模型（设置 → 模型与搜索 → 模型 API）'
          });
        }

        try {
          const ac = new AbortController();
          const timer = setTimeout(() => ac.abort(new Error('提案请求超时（120s）')), 120000);
          let text = '';
          try {
            const r = await chatCompletion({
              messages: [{ role: 'system', content: p.sys }, { role: 'user', content: p.user }],
              temperature: 0.2,
              maxTokens: 2400,
              signal: ac.signal,
              overrides,
              // ⚠️ 与 triage / ask 同理：deepseek 系推理模型的 reasoning token 从 max_tokens 里扣，
              //    不关思考会出现"提案解析出 0 条"的静默失败。
              skillContext: { thinkingMode: 'off' },
              tag: 'fix-propose'
            });
            text = r?.message?.content || r?.content || '';
          } finally { clearTimeout(timer); }

          if (!String(text).trim()) {
            return json(res, 200, { ok: false, available: true, error: '模型返回空正文（可能思考 token 吃光了 max_tokens）' });
          }
          const parseProvs = skillManager.getCapabilityProviders('fix.parse', ctx);
          if (!parseProvs.length) return json(res, 200, { ok: false, error: '插件缺少 fix.parse 能力' });
          const parsed = parseProvs[0].fn({ text });
          if (!parsed?.ok) return json(res, 200, { ok: false, available: true, error: `提案解析失败：${parsed?.error}`, raw: String(text).slice(0, 2000) });

          const made = createProvs[0].fn({
            question: body.question, answer: body.answer, target: body.target,
            proposal: parsed.proposal, model: modelName
          });
          if (!made?.ok) return json(res, 200, { ok: false, available: true, error: made?.error || '创建工单失败' });
          return json(res, 200, {
            ok: true, available: true, model: modelName, ownConfig: useOwn,
            noChange: !!made.noChange,
            fixId: made.fixId, approvalToken: made.approvalToken,
            record: made.record, summary: made.summary,
            files: p.files || []
          });
        } catch (error) {
          return json(res, 500, { ok: false, available: true, error: `模型调用失败：${String(error?.message ?? error)}` });
        }
      }
    },
    {
      // 闸①：必须带一次性批准令牌。令牌错/过期/用过 → 拒绝且什么都不做。
      method: 'POST', pattern: '/api/fix/apply',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const ctx = skillRuntimeContext();
        const provs = skillManager.getCapabilityProviders('fix.apply', ctx);
        if (!provs.length) return json(res, 200, { ok: false, available: false, error: '「自动修复」插件未启用' });
        try {
          const out = provs[0].fn({ fixId: body.fixId, approvalToken: body.approvalToken, extraNote: body.extraNote });
          return json(res, out?.ok ? 200 : (out?.code === 403 ? 403 : 200), out || { ok: false });
        } catch (error) { return json(res, 500, { ok: false, error: String(error?.message ?? error) }); }
      }
    },
    {
      method: 'POST', pattern: '/api/fix/gate',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const ctx = skillRuntimeContext();
        const provs = skillManager.getCapabilityProviders('fix.gate', ctx);
        if (!provs.length) return json(res, 200, { ok: false, available: false, error: '「自动修复」插件未启用' });
        try { return json(res, 200, provs[0].fn({ fixId: body.fixId }) || { ok: false }); }
        catch (error) { return json(res, 500, { ok: false, error: String(error?.message ?? error) }); }
      }
    },
    {
      // 自验（沙箱真跑）。原始产物由插件落盘，这里只把汇总回给前端。
      method: 'POST', pattern: '/api/fix/verify',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const ctx = skillRuntimeContext();
        const provs = skillManager.getCapabilityProviders('fix.verify', ctx);
        if (!provs.length) return json(res, 200, { ok: false, available: false, error: '「自动修复」插件未启用' });
        try {
          const out = provs[0].fn({ fixId: body.fixId });
          try { emit?.('fix-verify', { fixId: body.fixId, ...(out?.verify || {}) }); } catch { /* 推送失败不影响结果 */ }
          return json(res, 200, out || { ok: false });
        } catch (error) { return json(res, 500, { ok: false, error: String(error?.message ?? error) }); }
      }
    },
    {
      // 闸②的「重跑」：同一版本再跑一遍，不改码，限次。
      method: 'POST', pattern: '/api/fix/rerun',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const ctx = skillRuntimeContext();
        const provs = skillManager.getCapabilityProviders('fix.rerun', ctx);
        if (!provs.length) return json(res, 200, { ok: false, available: false, error: '「自动修复」插件未启用' });
        try { return json(res, 200, provs[0].fn({ fixId: body.fixId }) || { ok: false }); }
        catch (error) { return json(res, 500, { ok: false, error: String(error?.message ?? error) }); }
      }
    },
    {
      // 闸②的「通过」：快照 → 写真实文件（唯一允许写真实路径的地方）。
      method: 'POST', pattern: '/api/fix/commit',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const ctx = skillRuntimeContext();
        const provs = skillManager.getCapabilityProviders('fix.commit', ctx);
        if (!provs.length) return json(res, 200, { ok: false, available: false, error: '「自动修复」插件未启用' });
        try {
          const out = provs[0].fn({ fixId: body.fixId });
          // 落了 plugins/ 下的改动会被 fs.watch 热重载；核心改动需要重启才生效
          if (out?.ok) {
            try { reloadSkills?.(); } catch { /* ignore */ }
            try { emit?.('fix-committed', { fixId: body.fixId, needsRestart: !!out.needsRestart }); } catch { /* ignore */ }
          }
          return json(res, 200, out || { ok: false });
        } catch (error) { return json(res, 500, { ok: false, error: String(error?.message ?? error) }); }
      }
    },
    {
      method: 'POST', pattern: '/api/fix/rollback',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const ctx = skillRuntimeContext();
        const provs = skillManager.getCapabilityProviders('fix.rollback', ctx);
        if (!provs.length) return json(res, 200, { ok: false, available: false, error: '「自动修复」插件未启用' });
        try {
          const out = provs[0].fn({ fixId: body.fixId });
          if (out?.ok) { try { reloadSkills?.(); } catch { /* ignore */ } }
          return json(res, 200, out || { ok: false });
        } catch (error) { return json(res, 500, { ok: false, error: String(error?.message ?? error) }); }
      }
    },
    {
      method: 'POST', pattern: '/api/fix/discard',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const ctx = skillRuntimeContext();
        const provs = skillManager.getCapabilityProviders('fix.discard', ctx);
        if (!provs.length) return json(res, 200, { ok: false, available: false, error: '「自动修复」插件未启用' });
        try { return json(res, 200, provs[0].fn({ fixId: body.fixId, reason: body.reason }) || { ok: false }); }
        catch (error) { return json(res, 500, { ok: false, error: String(error?.message ?? error) }); }
      }
    },
    {
      // 删一笔审计。deleteSnapshot 必须显式给，快照是回滚的唯一依据，不能顺手删掉。
      method: 'DELETE', pattern: '/api/fix',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const ctx = skillRuntimeContext();
        const provs = skillManager.getCapabilityProviders('fix.delete', ctx);
        if (!provs.length) return json(res, 200, { ok: false, available: false, error: '「自动修复」插件未启用' });
        if (!body.fixId) return json(res, 400, { ok: false, error: '缺少 fixId' });
        try { return json(res, 200, provs[0].fn({ fixId: body.fixId, deleteSnapshot: body.deleteSnapshot === true }) || { ok: false }); }
        catch (error) { return json(res, 500, { ok: false, error: String(error?.message ?? error) }); }
      }
    },
    {
      method: 'POST', pattern: '/api/fix/prune',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const ctx = skillRuntimeContext();
        const provs = skillManager.getCapabilityProviders('fix.prune', ctx);
        if (!provs.length) return json(res, 200, { ok: false, available: false, error: '「自动修复」插件未启用' });
        try { return json(res, 200, provs[0].fn(body) || { ok: false }); }
        catch (error) { return json(res, 500, { ok: false, error: String(error?.message ?? error) }); }
      }
    },
    {
      // 导出报告。format=docx 返回二进制流（前端 fetch 成 blob 下载）；format=md 返回 JSON。
      method: 'POST', pattern: '/api/fix/export',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const ctx = skillRuntimeContext();
        const provs = skillManager.getCapabilityProviders('fix.export', ctx);
        if (!provs.length) return json(res, 200, { ok: false, available: false, error: '「自动修复」插件未启用' });
        if (!body.fixId) return json(res, 400, { ok: false, error: '缺少 fixId' });
        // 导出前先让模型写一份"叙事"（可选）：body.narrate !== false 时尝试
        if (body.narrate !== false) {
          try {
            const rp = skillManager.getCapabilityProviders('fix.report-prompt', ctx)[0]?.fn({ fixId: body.fixId });
            const sp = skillManager.getCapabilityProviders('fix.report-save', ctx)[0];
            if (rp?.ok && sp) {
              const cfg2 = getConfig();
              const d2 = cfg2.doctorApi || {};
              const own2 = d2.enabled === true && String(d2.model || '').trim();
              const ov2 = own2 ? {
                baseUrl: String(d2.baseUrl || cfg2.api?.baseUrl || ''),
                apiKey: String(d2.apiKey || '').trim() || resolveApiKey(cfg2),
                model: String(d2.model).trim()
              } : null;
              const ac2 = new AbortController();
              const t2 = setTimeout(() => ac2.abort(new Error('报告叙事超时（120s）')), 120000);
              try {
                const r = await chatCompletion({
                  messages: [{ role: 'system', content: rp.sys }, { role: 'user', content: rp.user }],
                  temperature: 0.3, maxTokens: 2000, signal: ac2.signal, overrides: ov2,
                  skillContext: { thinkingMode: 'off' }, tag: 'fix-report'
                });
                const txt = r?.message?.content || r?.content || '';
                if (txt) sp.fn({ fixId: body.fixId, text: txt });
              } finally { clearTimeout(t2); }
            }
          } catch (error) {
            logger.warn('fix', `报告叙事失败，导出退化为基础报告：${String(error?.message ?? error)}`);
          }
        }
        try {
          const out = provs[0].fn({ fixId: body.fixId, format: body.format === 'docx' ? 'docx' : 'md' });
          if (!out?.ok) return json(res, 200, out || { ok: false });
          if (out.format === 'docx' && out.buffer) {
            const buf = Buffer.isBuffer(out.buffer) ? out.buffer : Buffer.from(out.buffer);
            res.writeHead(200, {
              'content-type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
              'content-disposition': `attachment; filename="${encodeURIComponent(out.filename)}"`,
              'content-length': String(buf.length)
            });
            res.end(buf);
            return undefined;
          }
          return json(res, 200, { ok: true, format: 'md', filename: out.filename, markdown: out.markdown });
        } catch (error) { return json(res, 500, { ok: false, error: String(error?.message ?? error) }); }
      }
    },
    // ── 媒体工具（ffmpeg）────────────────────────────────────────────────
    // ffmpeg 不随包分发，按需下载到 data/runtime/ffmpeg/bin/。
    // 这里直接 import 模块（与 wallpaper 那条「不 import、只问能力」不同）：
    // ffmpeg 是核心 src/ 下的基础设施，不是可插拔扩展，没有第二种实现可换。
    {
      // 当前 ffmpeg 状态：路径 / 版本 / 来源（手填、下载的、随包的、系统 PATH）。
      method: 'GET', pattern: '/api/ffmpeg/status',
      handler: async ({ res, json }) => {
        try {
          const {
            resolveFfmpeg, listFfmpegSources, managedBinDir, FFMPEG_VERSION, FFMPEG_ASSETS,
            canAutoInstall, installGuideFor, platformAssets
          } = await import('./ffmpeg-resolve.js');
          const { resolveDownloadRoute } = await import('./ffmpeg-setup.js');
          const r = await resolveFfmpeg();
          const cfg = getConfig();
          // 预演一次下载通道（镜像 / 代理直连），让 UI 能提前说清"这次会怎么下"。
          // 探测失败当直连处理，不让它拖慢状态接口。
          // 预演的是 Windows 的 7z 资产：镜像 / 代理通道只对 GyanD 的 GitHub
          // Release 成立；Linux 的 riedl 资产自带完整 URL，不经过这条通道。
          // 所以非 win32 上这个字段只作参考，UI 不该拿它渲染下载源说明。
          let route = { url: '', proxy: '', reason: '' };
          if (process.platform === 'win32') {
            try {
              route = await resolveDownloadRoute(FFMPEG_ASSETS.win32['7z'].name, {
                mirror: cfg?.media?.downloadMirror || 'yylx',
                customMirror: cfg?.media?.customMirror || ''
              });
            } catch { /* ignore */ }
          }
          // 本机实际可用的全部 ffmpeg（按组归类），供「优先使用」下拉展示。
          // 探测失败只影响这一块，不影响上面的主状态。
          let candidates = [];
          try { candidates = await listFfmpegSources(); } catch { /* ignore */ }
          let managed = false;
          try { managed = fs.existsSync(path.join(managedBinDir(), process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')); } catch { /* ignore */ }
          // 能力体检：装了 ffmpeg 但可能缺 libx264 / 缺滤镜，表现出来是
          // "功能报错，可状态栏说已安装"。只在**有 ffmpeg 时**才查，结果走缓存，
          // 不让状态轮询每次都付两条子进程的代价。
          let health = { ok: true, problems: [] };
          if (r.ok) {
            try { health = await cachedFfmpegHealth(r.ffmpeg); } catch { /* ignore */ }
          }
          return json(res, 200, {
            ok: r.ok,
            path: r.ffmpeg,
            ffprobe: r.ffprobe,
            source: r.source,
            version: r.version,
            major: r.major,
            detail: r.detail,
            managed,
            managedDir: managedBinDir(),
            candidates,
            health,
            // 平台信息：UI 据此决定「下载并安装」按钮是否出现、以及不支持时
            // 改展示什么命令。判断放在后端，是因为资产表的形态在 win32 / linux
            // 之间并不一致，界面不该理解这两种结构。
            platform: process.platform,
            arch: process.arch,
            canAutoInstall: canAutoInstall(),
            installGuide: installGuideFor(),
            hasPlatformAssets: platformAssets() !== null,
            downloadVersion: FFMPEG_VERSION,
            downloadProxy: route.proxy,
            downloadChannel: route.reason,
            settings: {
              ffmpegPath: cfg?.media?.ffmpegPath || '',
              ffmpegSource: cfg?.media?.ffmpegSource || '',
              downloadMirror: cfg?.media?.downloadMirror || 'yylx',
              customMirror: cfg?.media?.customMirror || '',
              hasGithubAccessToken: Boolean(String(cfg?.media?.githubAccessToken || '').trim())
            }
          });
        } catch (error) {
          return json(res, 500, { ok: false, error: `读取 ffmpeg 状态失败：${String(error?.message ?? error)}` });
        }
      }
    },
    {
      // 媒体工具（ffmpeg）的 GitHub Token 明文读取：与 /api/api-key 同一套来源校验。
      // 只放行控制台来源，挡的是外部网页冒用 127.0.0.1 读走令牌。
      method: 'GET', pattern: '/api/ffmpeg/gh-token',
      handler: async ({ req, res, json }) => {
        if (!keyEndpointAllowed(req)) return json(res, 403, { error: '请求来源不被信任，已拒绝读取明文密钥。' });
        const t = String(getConfig()?.media?.githubAccessToken || '');
        return json(res, 200, { token: t, hasToken: Boolean(t.trim()) });
      }
    },
    {
      // 启动下载安装任务。GET ?job=1 读进度（形态与 /api/wallpaper/import 一致）。
      // 会写磁盘，所以要 keyEndpointAllowed，挡的是外部网页冒用 127.0.0.1。
      method: '*', pattern: '/api/ffmpeg/download',
      handler: async ({ req, res, url, json }) => {
        if (req.method !== 'GET' && req.method !== 'POST') {
          return json(res, 405, { ok: false, error: 'method not allowed' });
        }
        const setup = await import('./ffmpeg-setup.js');
        if (req.method === 'GET') {
          return json(res, 200, { ok: true, ...setup.setupStatus() });
        }
        if (!keyEndpointAllowed(req)) {
          return json(res, 403, { ok: false, error: '只能从控制台窗口发起下载（当前请求没有控制台凭据）。' });
        }
        try {
          const body = await bodyOf(req);
          const r = await setup.downloadAndInstallFfmpeg({
            mirror: body?.mirror,
            customMirror: body?.customMirror
          });
          return json(res, r.ok ? 200 : 409, r);
        } catch (error) {
          return json(res, 500, { ok: false, error: `启动下载失败：${String(error?.message ?? error)}` });
        }
      }
    },
    {
      // 验证手动指定的 ffmpeg 路径（只验证，不写配置，写配置走 POST /api/config）。
      method: 'POST', pattern: '/api/ffmpeg/test',
      handler: async ({ req, res, json }) => {
        if (!keyEndpointAllowed(req)) return json(res, 403, { ok: false, error: '请求来源不被信任' });
        try {
          const body = await bodyOf(req);
          const p = String(body?.path || '').trim();
          if (!p) return json(res, 400, { ok: false, error: '请填写 ffmpeg 的完整路径' });
          const { probeFfmpeg, ffprobeFor } = await import('./ffmpeg-resolve.js');
          const v = await probeFfmpeg(p, 15000);
          if (!v.ok) return json(res, 200, { ok: false, error: '这个路径下没有能运行的 ffmpeg（或文件损坏）' });
          return json(res, 200, {
            ok: true,
            version: v.raw,
            major: v.major,
            ffprobe: ffprobeFor(p),
            detail: `ffmpeg ${v.raw}`
          });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      // 删除下载的那份（只动 data/runtime/ffmpeg/，不碰系统安装的）。
      method: 'POST', pattern: '/api/ffmpeg/remove',
      handler: async ({ req, res, json }) => {
        if (!keyEndpointAllowed(req)) return json(res, 403, { ok: false, error: '请求来源不被信任' });
        try {
          const setup = await import('./ffmpeg-setup.js');
          const r = setup.removeManagedFfmpeg();
          return json(res, r.ok ? 200 : 500, r);
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    // ── 控制台壁纸（内置模块 src/wallpaper）──────────────────────────────
    // 这些路由**不 import 模块代码**，一律经 skillManager.getCapabilityProviders()
    // 拿能力函数的引用（与 doctor / forge 同款）。模块没注册上时统一 404。
    {
      // 控制台「壁纸」页：壁纸列表。
      method: 'GET', pattern: '/api/wallpaper/list',
      handler: async ({ res, json }) => {
        const fn = skillManager.getCapabilityProviders('wallpaper.library', {})[0]?.fn || null;
        if (!fn) return json(res, 404, { ok: false, error: '壁纸模块未加载（内置模块 src/wallpaper）。改过它的代码的话重启一次 QQ Agent。' });
        try {
          return json(res, 200, await fn());
        } catch (error) {
          return json(res, 500, { ok: false, error: `壁纸列表失败：${String(error?.message ?? error)}` });
        }
      }
    },
    {
      // 壁纸文件伺服：只按 id 取模块扫描时登记过的文件（不接受请求方提供的任何路径）。
      // 视频必须支持 Range（206）：Chromium <video> 的分段缓冲/拖进度条都依赖它，
      // 否则大视频起播慢、拖动直接卡死。GET/HEAD 之外的动词一律 405。
      method: '*', pattern: '/api/wallpaper/file',
      handler: async ({ req, res, url, json }) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          return json(res, 405, { ok: false, error: 'method not allowed' });
        }
        const fn = skillManager.getCapabilityProviders('wallpaper.file', {})[0]?.fn || null;
        if (!fn) return json(res, 404, { ok: false, error: '壁纸模块未加载（内置模块 src/wallpaper）' });
        let r;
        try {
          r = await fn({
            id: url.searchParams.get('id') || '',
            kind: url.searchParams.get('kind') === 'preview' ? 'preview' : 'media'
          });
        } catch (error) {
          return json(res, 500, { ok: false, error: `壁纸文件定位失败：${String(error?.message ?? error)}` });
        }
        if (!r?.ok || !r.path) return json(res, 404, { ok: false, error: r?.error || '文件不存在' });
        let st;
        try { st = fs.statSync(r.path); } catch { return json(res, 404, { ok: false, error: '文件不存在' }); }
        // 缓存策略分两类：
        //   预览图：内容随 id 不变，缓存一天（启动秒出、缩略图不重下）。
        //   媒体（视频/循环）：同一 URL 会在「转动态」后换成另一个文件
        //     （4K 原片 → 1080p 循环），max-age 会让播放器一直拿缓存的旧片
        //     最长一天！改 no-cache + ETag：内容没变 304（缓存照用，只多一次
        //     回环确认），变了立刻拿新文件。
        const isMedia = url.searchParams.get('kind') !== 'preview';
        const etag = `"${st.size}-${Math.round(st.mtimeMs)}"`;
        const base = {
          'content-type': r.contentType || 'application/octet-stream',
          'accept-ranges': 'bytes',
          ...(isMedia
            ? { 'cache-control': 'no-cache', etag }
            : { 'cache-control': 'private, max-age=86400' })
        };
        if (isMedia && req.headers['if-none-match'] === etag) {
          res.writeHead(304, { etag });
          res.end();
          return;
        }
        // 流式响应。两个错误口都要堵住：流读失败、客户端中途关连接（拖动视频时常见），
        // 不处理的话 unhandled 'error' 会走进程级 uncaughtException 直接退出整个应用。
        const sendStream = (opts) => {
          const stream = fs.createReadStream(r.path, opts);
          stream.on('error', () => { try { res.destroy(); } catch { /* 已断开 */ } });
          res.on('close', () => { try { stream.destroy(); } catch { /* 已结束 */ } });
          stream.pipe(res);
        };
        const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
        if (m && (m[1] !== '' || m[2] !== '')) {
          let start;
          let end;
          if (m[1] === '') {
            // 后缀区间 "-N"：取最后 N 字节
            const n = parseInt(m[2], 10);
            if (!Number.isFinite(n) || n <= 0) {
              res.writeHead(416, { 'content-range': `bytes */${st.size}` }); res.end(); return;
            }
            start = Math.max(0, st.size - n);
            end = st.size - 1;
          } else {
            start = parseInt(m[1], 10);
            end = m[2] === '' ? st.size - 1 : parseInt(m[2], 10);
          }
          if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= st.size || end >= st.size) {
            res.writeHead(416, { 'content-range': `bytes */${st.size}` }); res.end(); return;
          }
          res.writeHead(206, {
            ...base,
            'content-range': `bytes ${start}-${end}/${st.size}`,
            'content-length': end - start + 1
          });
          if (req.method === 'HEAD') { res.end(); return; }
          sendStream({ start, end });
          return;
        }
        res.writeHead(200, { ...base, 'content-length': st.size });
        if (req.method === 'HEAD') { res.end(); return; }
        sendStream({});
        return;
      }
    },
    {
      // 壁纸当前状态：控制台每次保存会 POST 一份镜像过来；GET 供控制台
      // 启动时对齐（机器人改过壁纸时以远端为准）。这里只做能力中介，
      // 不广播事件：控制台改状态自己已生效，广播是 wallpaper-chat 部分的事。
      method: '*', pattern: '/api/wallpaper/state',
      handler: async ({ req, res, json }) => {
        if (req.method !== 'GET' && req.method !== 'POST') {
          return json(res, 405, { ok: false, error: 'method not allowed' });
        }
        const cap = (name) => skillManager.getCapabilityProviders(name, {})[0]?.fn || null;
        const get = cap('wallpaper.state.get');
        if (!get) return json(res, 404, { ok: false, error: '壁纸模块未加载（内置模块 src/wallpaper）' });
        try {
          if (req.method === 'GET') return json(res, 200, await get());
          const body = await bodyOf(req);
          const set = cap('wallpaper.state.set');
          if (!set) return json(res, 404, { ok: false, error: '壁纸模块未加载（内置模块 src/wallpaper）' });
          return json(res, 200, await set({ cfg: body }));
        } catch (error) {
          return json(res, 500, { ok: false, error: `壁纸状态读写失败：${String(error?.message ?? error)}` });
        }
      }
    },
    {
      // 动态壁纸导入：POST {id} 启动任务（一次一个，WE 渲染窗独占），
      // GET ?job= 轮询进度。场景导入会短暂弹出渲染窗口属正常现象。
      method: '*', pattern: '/api/wallpaper/import',
      handler: async ({ req, res, url, json }) => {
        if (req.method !== 'GET' && req.method !== 'POST') {
          return json(res, 405, { ok: false, error: 'method not allowed' });
        }
        const cap = (name) => skillManager.getCapabilityProviders(name, {})[0]?.fn || null;
        try {
          if (req.method === 'GET') {
            const fn = cap('wallpaper.import.status');
            if (!fn) return json(res, 404, { ok: false, error: '壁纸模块未加载（内置模块 src/wallpaper）' });
            return json(res, 200, await fn({ job: url.searchParams.get('job') || '' }));
          }
          const fn = cap('wallpaper.import.start');
          if (!fn) return json(res, 404, { ok: false, error: '壁纸模块未加载（内置模块 src/wallpaper）' });
          const body = await bodyOf(req);
          // redo=true：先清掉该壁纸的缓存循环再导入（成品坏了重录的入口）
          if (body?.redo) {
            const redoFn = cap('wallpaper.import.redo');
            if (!redoFn) return json(res, 404, { ok: false, error: '壁纸模块未加载（内置模块 src/wallpaper）' });
            const r = await redoFn({ id: body?.id });
            if (!r?.ok) return json(res, 409, r);
          }
          return json(res, 200, await fn({ id: body?.id }));
        } catch (error) {
          return json(res, 500, { ok: false, error: `动态壁纸导入失败：${String(error?.message ?? error)}` });
        }
      }
    },
  ];
}
