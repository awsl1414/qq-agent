# 扩展 API 完整参考

> **必读**。这一份是查表用的：字段名、签名、返回值、失败原因全在这里。
> 「该做插件还是技能、怎么开始写」见 [plugin-development.md](plugin-development.md) / [skill-development.md](skill-development.md)；
> 「整体结构」见 [skill-system.md](skill-system.md)。

本文用**符号名**引用代码位置（函数名、常量名），不用行号：行号会随每次改动漂移，
而符号名可以用编辑器直接跳转。源码路径均相对项目根。

---

## 1. 清单字段全表

清单文件名：`skill.json`（优先）或 `plugin.json`（等价，``src/plugin-loader.js` 的 `readManifest``）。
规范化入口：`normalizeManifest()`（``src/skills/manifest.js` 的 `normalizeManifest``）。

| 键 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `id` | string | 目录名 | **必填**。正则 `/^[a-z0-9][a-z0-9._-]*$/i` |
| `name` | string | `id` | 显示名 |
| `version` | string | `'0.0.0'` | 版本号 |
| `apiVersion` | number | `1` | 高于当前支持值只记 problem，不阻断 |
| `enabledByDefault` | boolean | `true` | **只有显式 `false` 才是 false** |
| `category` | enum | `'utility'` | `model` / `message` / `knowledge` / `media` / `utility` / `fun` / `query`。非法值回退 `utility` |
| `description` | string | `''` | 一句话介绍 |
| `author` | string | `''` | 作者 |
| `requires` | string[] | `[]` | **硬依赖**的能力名。缺了 → 本扩展不可用。自依赖会被剔除 |
| `capabilities` | string[] | `[]` | 本扩展**声明提供**的能力名 |
| `permissions` | string[] | `[]` | 见 1.2 节 |
| `configSchema` | object | `{}` | 设置表单的渲染依据（第 2 节） |
| `settings` | object | `{}` | 设置的**默认值**（第 3 节） |
| `prompt` | string \| object | `null` | 提示词片段（第 4 节） |
| `deprecated` | boolean | `false` | 严格 `=== true` 才生效 |

规范化产物还会多一个 **`panels`**（从 `configSchema` 摘出的界面入口，已校验、URL 已算好）。
见 [panel-ui-contract.md](panel-ui-contract.md)。

### 1.1 数组字段的容错

`requires` / `capabilities` / `permissions` 走 `asArray`（``src/skills/manifest.js` 的 `asArray``）：

- `null` / `undefined` → `[]`
- **字符串** → 单元素数组（`"permissions": "web_fetch"` 也能用，不会静默变成零权限）
- 数组 → 逐项 `String()` 后过滤空值，去重

### 1.2 `permissions` 只有两个值有意义

| 值 | 效果 |
|---|---|
| `web_fetch` | 让 `api.fetch` 变成真的 `globalThis.fetch` |
| `qq_sticker` | 让 `api.qqCall` 可用 |

没声明时这两个 API **存在但永远 reject**（``src/plugin-loader.js` 的 `createSkillApi``）。
写别的值没有任何效果，也不报错。

> 历史坑：早期 `permissions` 只认数组，写成字符串会静默变成"零权限"。
> 现在有 `asArray` 兜住，但**能力名拼错**仍然只会表现为"fetch/qqCall 一直失败"。

---

## 2. `configSchema` 的 type

**加载器不校验 type**（除了 `action`，见 panel 契约）。type 的语义由渲染层定义
（`ui/app/06-settings-render.js:1404-1440`）。

| type | 渲染成 | 可用字段 |
|---|---|---|
| `boolean` | 复选框（整行可点） | `label` `description` `default` |
| `number` | 数字输入 | 同上 |
| `string` | 文本框 | 同上 + `secret` `multiline` |
| `enum` | 下拉 | 同上 + `values` **或** `options` |
| `internal` | **不渲染输入框**，只在弹窗底部列出并说明去哪改 | `label` `description` |
| `action` | **不是配置项**，是界面入口（渲染成按钮） | `label` `button` `panel` `description` `icon` |

### 2.1 字段细节

| 字段 | 适用 | 说明 |
|---|---|---|
| `label` | 全部 | 字段标题，缺省用键名 |
| `description` | 全部 | 字段说明 |
| `default` | 全部 | UI 兜底默认值（`settings` 里没给时的最后一道） |
| `secret` | string | 渲染成密码框 + `🔒`；**写入侧约定空串 / `'******'` = 不修改** |
| `multiline` | string | 强制整行渲染（长文本字段窄列里会碎成一条） |
| `values` | enum | `['off','auto','on']`：值即显示文本 |
| `options` | enum | `[{value, label}]`：值与显示分离（如把 `0~3` 档显示成中文档位） |

`enum` 只在 `values` 或 `options` 是数组时才渲染成下拉。

### 2.2 `internal` 的用法

列表 / 对象类设置（如账号池的账号列表）不该渲染成表单输入，但**必须在弹窗里列出来**，
否则用户会以为"这个设置根本不存在"。用 `internal` 就会出现在底部的
「以下设置不在这里改」区块里。

---

## 3. `settings` 与 `configSchema` 的关系

- **`settings` = 默认值来源**。运行时 `api.config()` 返回的是
  `manifest.settings` 被 `config.skills[id]` 覆盖后的结果
  （``src/skills/manager.js` 的 `settingsOf``）。
- **`configSchema` = 渲染依据**，决定弹窗里出现哪些字段、什么控件。
- 保存白名单 = `Object.keys(settings) ∪ Object.keys(configSchema)`。

⚠️ 两者可以不一致且**不报错**：

| 情况 | 后果 |
|---|---|
| schema 有、settings 无 | 默认空串，能改能存 |
| settings 有、schema 无 | **存得住但界面看不到、也改不了** |
| 只写了 configSchema，没写 settings | 正常（`default` 兜底） |

推荐：**两者都写**，`settings` 给默认值，`configSchema` 给 label/description/控件类型。

---

## 4. `prompt` 字段

`normalizePrompt()`（``src/skills/manifest.js` 的 `normalizePrompt``）：

```jsonc
// 形态 1：字符串，等价于 { instruction: "..." }
"prompt": "你是表情包专家…"

// 形态 2：对象
"prompt": {
  "sections": [
    { "id": "sticker-rules", "title": "表情包", "content": "…", "priority": 40 }
  ]
}
```

- 每个 section 规范成 `{id, title, content, priority}`；`id` 缺省 `section-<序号>`；
  `content` 裁剪后**为空则被过滤掉**；`priority` 被钳到 `min(99, 值 || 50)`。
- 给了 `sections` 之外还给了 `instruction`，且 sections 为空 → 合成一个 `{id:'main', priority:50}`。
- **全都为空 → 返回 `null`，提示词静默消失**（不报错）。

### 旧式形态仍兼容

```jsonc
"prompt": { "when": "…", "examples": ["…"], "instruction": "…" }
```

由 `adaptLegacyPrompt()`（``src/plugin-loader.js` 的 `adaptLegacyPrompt``）适配成
`{sections:[{id:'legacy', priority:50}]}`。**不写 `sections` 也不写 `instruction` 的旧形态会静默失效。**

### 动态片段

导出 `promptSections(context)` 函数即可（见第 9.3 节）。

---

## 5. 目录布局与入口

```
<plugins|skills>/<id>/
  plugin.json | skill.json     清单（二者等价，优先 skill.json）
  index.js                     入口（清单的 entry 字段可改，默认 index.js）
  lib/…  panel/…  …            自己的其它文件
```

- `entry` 必须是目录内的相对路径；符号链接指到目录外会被拒。
- 入口必须导出 `setup(api)` 或 `register(api)`，**或者**导出 `hooks` / `providers` / `activate`
  ，否则报 `入口需导出 setup(api)/register(api) 或 hooks/providers`。
- 入口文件用 ESM（`import` / `export`）。整个 app 是 `"type": "module"`。

---

## 6. `api` 对象全表

构造于 `createSkillApi()`（``src/plugin-loader.js` 的 `createSkillApi``），在 `setup` 之前注入。

| 成员 | 签名 | 说明 |
|---|---|---|
| `registerTool` | `(def) => string` | 注册工具，返回加过前缀的 id（第 8 节） |
| `config` | `() => object` | 本扩展设置（`manifest.settings` 已被 `config.skills[id]` 覆盖） |
| `storage` | `{get, set, remove}` | 持久化 KV（第 7 节） |
| `panel` | `{id, prefix, url, dataUrl}` | 界面只读 URL（见 panel 契约） |
| `isSkillActive` | `(id, ctx?) => boolean` | 别的扩展是否生效 |
| `capability` | `(name, args?) => any` | **软依赖**调用：取第一个生效提供者；无/异常 → `undefined` |
| `hasCapability` | `(name) => boolean` | 是否有真实实现的能力 |
| `log` / `warn` / `error` | `(...args)` | 自动带 `[skill:<id>]` 前缀 |
| `fetch` | `fetch` 或 reject 函数 | 需要 `permissions: ['web_fetch']` |
| `qqCall` | `(method, params?) => Promise` | 需要 `permissions: ['qq_sticker']`，见 [onebot-capabilities.md](onebot-capabilities.md) |
| `utils.sleep` | `(ms) => Promise` | 定时 |
| `utils.safeJsonParse` | `(text, fallback?) => any` | 解析失败返回 fallback |

⚠️ `api.capability()` **只取第一个生效的提供者**，并且内部 try/catch 后返回 `undefined`，
调用方拿不到失败原因。要诊断用 `hasCapability()`。

---

## 7. `api.storage`

落盘位置：**`<DATA_DIR>/plugin-data/<id>/storage.json`**
（`DATA_DIR` 默认 `<项目>/data`，可用环境变量 `QQ_AGENT_DATA_DIR` 覆盖）。

| 项 | 值 |
|---|---|
| 容量上限 | **1MB**（`SKILL_STORAGE_MAX_BYTES`，``src/plugin-loader.js` 的 `SKILL_STORAGE_MAX_BYTES``），超了 `set` **抛错** |
| 键名 | 非空字符串；显式拒绝 `__proto__` / `constructor` / `prototype` |
| 读写时机 | **同步、每次整文件读写**（`get` 全量 parse，`set` 读→改→整体落盘） |
| `get(key, fallback?)` | 有该键返回值，否则 fallback |
| `set(key, value)` | `value === undefined` 按 JSON 语义存 `null` |
| 生命周期 | 数据在 `data/` 目录下，**卸载重装不丢** |

**它同时是插件界面的数据通道**：插件自带的页面读不到 `data/stickers.json` 这类私有文件，
但可以 `fetch('../@data/storage.json')`。所以"要给页面看的东西"写进 storage 就够了。

⚠️ 别把大对象塞进去：1MB 是硬上限，100 张表情的内联 base64 就爆了。
写快照时只带页面真正要用的字段。

---

## 8. `api.registerTool`

```js
api.registerTool({
  id: 'send_sticker',              // 必填。最终 id 会变成 <skillId>__send_sticker
  name: '发表情',                   // 显示名
  description: '把表情发到当前会话…', // 给模型看的说明，写清楚"什么时候用"
  category: 'message',             // 缺省 'system'
  icon: '😀',                      // 缺省 '🔧'
  defaultEnabled: true,
  requiresVision: false,           // 需要模型支持图片输入
  requiresSearch: false,           // 需要联网搜索开启
  requires: [],                    // 缺省 []；缺了 → 工具被禁用并写明原因
  parameters: {                    // OpenAI function 参数 schema
    type: 'object',
    properties: { id: { type: 'string', description: '表情 id' } },
    required: ['id']
  },
  async execute(ctx, args) {
    return { content: '发出去了' };   // content 可为字符串，或 parts 数组
  }
});
```

### 8.1 `execute` 的返回值

`(ctx, args) => { content, isError? }`

- `content`：字符串，或 parts 数组（元素含 `text` / `image_url` / `video_url`）。
- `isError: true` 让模型知道这次调用失败了。
- 抛异常也会被兜成错误结果，但**连续失败 5 次会熔断本扩展 5 分钟**。

### 8.2 工具 id 为什么要加前缀

最终 id = `<sanitized skillId>__<sanitized toolId>`（``src/plugin-loader.js` 的 `createSkillApi``）：

- 工具 id 会成为发给模型的 **OpenAI function name**，只允许 `[a-zA-Z0-9_-]`。
  用 `:` 或 `.` 拼接会被严格端点（DeepSeek / OpenAI）以 `400 invalid function name`
  **拒掉整个请求**。不是这一个工具失败，是整轮对话失败。
- 总长 ≤ 64（OpenAI 上限）：skillId 截 24、工具名截 38。
- 前缀把工具绑到 skillId，便于开关联动与批量清理。
- sanitize + 截断后**可能撞名**，此时后加载者覆盖先加载者，只留一条 `console.warn`。

### 8.3 运行时护栏（自动套，不用自己写）

`guardToolExecute()`（`src/tool-guard.js`）：

- 单次执行超时 **120s**
- 返回文本截断 **30000 字符**；parts 总量 **60000**
- **同 skillId 连续失败 5 次 → 熔断 5 分钟**

内置工具（`src/tools.js` 的静态 defs）不经过 `registerTool`，不受此限。

### 8.4 清单里的 `tools[]` 只是元数据

在清单里写 `tools: [{id, name, description, parameters}]` **不会注册工具**。
工具只能靠 `api.registerTool()` 注册。声明了却没注册只会得到一条告警
（``src/plugin-loader.js` 的 `loadSkillDir``）。

---

## 9. 扩展级导出与生命周期

| 导出 | 调用时机 | 次数 | await？ | 抛错后果 |
|---|---|---|---|---|
| `setup(api)` | 加载时（优先） | 1 | **是** | 回滚已注册工具；有旧实例则补 `activate` 救活旧版本 |
| `register(api)` | 加载时（`setup` 不存在时） | 1 | **是** | 同上 |
| `activate(ctx)` | 启用时 / 热重载救活旧实例 | 多次 | 否 | 被吞掉，记进 `errors` |
| `deactivate(ctx)` | 禁用 / 卸载 / 覆盖注册前 / 退出 | 多次 | 否 | 同上。`ctx.reason` 说明原因 |
| `dispose()` | 卸载 / 覆盖注册 / 退出 | 1 | 否 | 同上。默认实现会注销本扩展全部工具 |
| `hooks` | 对应事件发生时（第 10 节） | 每事件 1 次 | **是** | 只记日志，不影响其它扩展 |
| `providers` | 核心按能力名取用时（第 11 节） | 由调用方定 | 由调用方定 | 调用方各自 try/catch |
| `promptSections(ctx)` | 每次组装提示词 | 每次 1 次 | **否（同步！）** | 被 try/catch 吞掉 |
| `available(ctx)` | 每次可用性判定 | 多次 | **否（同步！）** | 记 `自检异常：…` |

### 9.1 `activate` / `deactivate` / `dispose` 的语义

```js
export function activate(ctx) { startTimer(); }       // 启用
export function deactivate(ctx) { stopTimer(); }      // 禁用（ctx.reason: 'disabled' / 'deleted' / …）
export function dispose() { release(); }              // 彻底卸载
```

- 覆盖注册（热重载）时顺序是 **先 `deactivate` + `dispose`，再注册新的**。
- 退出时 `disposeAll({reason:'shutdown'})`。

### 9.2 ⚠️ `available` 与 `promptSections` 必须是同步函数

管理器**同步调用**它们（``src/skills/manager.js` 的 `isAvailable``、`439`）。
写成 `async` 会返回一个 Promise：

- `available` → `{ok:true}` 判定恒真（`r && r.ok === false` 永不成立），自检**静默失真**；
- `promptSections` → `for (const s of promise)` 抛错被吞，片段**静默消失**。

### 9.3 `promptSections` 的形态

```js
export function promptSections(context) {   // 注意：不是 async
  if (!enabled) return [];
  return [{ id: 'my-rules', title: '我的规则', content: '…', priority: 40 }];
}
```

- 同 `id` 时**动态覆盖静态**（清单里的 `prompt.sections`）。
- `priority` 显式 `0` 是合法值（排最末），不会被 falsy 吞掉。
- 排序：`priority` 降序 → 同优先级按 `id` 字典序（防字节漂移击穿缓存）。
- 上限 **99**，且一律渲染在核心安全规则**之后**。

---

## 10. hooks 全表

```js
export const hooks = {
  'before-llm-messages'(ctx) { /* 可以原地改 ctx.messages */ }
};
```

回调签名 `(context, { skillId })`。**只跑 `isActive` 为真的扩展**，禁用/未就绪的扩展
其钩子会被**静默跳过**。

| 事件 | 何时 | 拿得到什么 | 能做什么 |
|---|---|---|---|
| `onMessage` | 每条入站消息（不管是否被唤醒） | `event, chatKey, senderId, senderName, text, onebot, sender, store, log, sendSegments, send` | 通过 `ctx.send` / `ctx.sendSegments` 主动发言 |
| `onRecall` | 消息被撤回 | `event, chatKey, mid, onebot, sender, store, log, sendSegments` | 通过 `ctx.sendSegments` 反应 |
| `before-context` | 组装提示词前 | skillContext + `triggerEntries, store, memory` | 返回值被忽略；用来追加/加工上下文 |
| `before-llm-messages` | messages 定稿、发模型前 | skillContext + `messages` | **原地修改 `messages`**（同一数组引用）；返回值被忽略 |
| `after-response` | 拿到模型响应后 | skillContext + `response, session` | 返回值被忽略（统计、日志） |
| `before-tool` | 工具执行前 | skillContext + `toolName, argsRaw, session` | **返回 `{block:true, reason}` 可否决本次调用** |
| `after-tool` | 工具执行后 | skillContext + `toolName, argsRaw, result, session` | 返回值被忽略 |

`skillContext` = `{chatKey, kind, chatId, chatName, model, provider, visionEnabled, searchEnabled, proactive, sessionId}`。

**统一语义**（``src/skills/manager.js` 的 `runHook``）：

- 返回值 `!== undefined` 才被收集成 `{skillId, value}`。**"不改写请求"就是返回 `undefined`。**
- 默认超时 **5000ms**，超时抛 `skill-timeout`，该钩子被跳过、其它扩展不受影响。
- 单个钩子抛错只记日志，不影响其它扩展。
- 顺序 = 注册顺序（`skills/` 先于 `plugins/`）。

否决工具调用的读法：`hookResults.map(r => r.value).find(v => v && v.block)`。

---

## 11. providers 全表（常用）

```js
export const providers = {
  'llm.request-params': ({ body, api, model }) => ({ body: { ...body, ...extra } })
};
```

核心**从不 import 具体扩展**，只按能力名取。常用能力：

| 能力名 | 契约 | 多提供者？ |
|---|---|---|
| `llm.request-params` | `({body, api, model, messages, tools, temperature, context}) => {body, omitTemperature?}` | ✅ 串行，后者见前者输出 |
| `llm.response` | `({result, ...ctx}) => {result}` | ✅ |
| `llm.usage` | `({result, usage, ...ctx}) => {k: v}`（累加进 extraUsage） | ✅ |
| `llm.retry-advisor` | `({body, errorText, status, ...ctx}) => {body, reason} \| null`（`null` = 不归我管） | ✅ 第一个给建议的胜出 |
| `tool.guard` | `({toolId, tool, context}) => false \| {ok:false, reason}` | ✅ |
| `media.download` | `({url, onebot, sender, kind, chatId, ...}) => {skip?} \| {ok, platform?, title?, friendly?} \| {error}` | ✅ 挨个问、认领即停 |
| `llm.endpoint-pick` | `({model}) => {baseUrl, apiKey?, model?, id?}` | ❌ |
| `llm.endpoint-feedback` | `(payload) => void` | ❌ |
| `message.owner-check` | `({triggerEntries, kind, selfId, persona}) => {persona?, rules?}` | ❌ |
| `message.speaker-format` | `({message, notes, selfLabel}) => string` | ❌ |
| `message.inline-at-normalize` | `({text, members, atUserId}) => string \| null` | ❌ |
| `chat.ban-state` | `({chatKey, action, durationSec}) => {muted, known, remainSec, skipRun, markRead}` | ❌ |
| `media.transcribe` | `({record, onebot}) => {ok, text}` | ❌ |
| `video.frames` | `({filePath, count, durationSec}) => {frames[], times[], error?}` | ❌ |
| `video.frames.available` | `({}) => {ok}` | ❌ |
| `image.mime-support` | `({mime}) => {supported}` | ❌ |
| `model.thinking-detect` | `({baseUrl, model}) => dialect` | ❌ |

**只有这 6 个允许多提供者**（`MULTI_PROVIDER_CAPABILITIES`，``src/skills/manager.js` 的 `MULTI_PROVIDER_CAPABILITIES``）：
`llm.request-params`、`llm.response`、`llm.usage`、`llm.retry-advisor`、`tool.guard`、`media.download`。

其余能力**约定只能有一个提供者**：多了以后核心只取第一个，后面的静默不生效
（`src/harness/doctor` 会报 `cap-conflict-*` 告警）。

**取用规则**：`getCapabilityProviders()` 只返回 `isActive` 且**有真实实现**的提供者，
顺序 = 注册顺序。`capabilities` 里声明了但没提供实现 → 登记成 `null` 占位，
`hasCapability()` 为 `false`（便于诊断"声明了但没写"）。

---

## 12. 安全闸门

### 12.1 准入闸 `checkPluginTrust()`

见 [skill-system.md 第 6 节](skill-system.md#6-安全边界两层别混淆)。要点：

- **内置模块**靠 `builtin-modules.json` 的逐文件 sha1 指纹豁免。
- **第三方模块**若触碰高危能力，默认拒绝加载，需在 `config.trustedPlugins`
  里登记它的**目录名**（不是清单 id，因为清单 id 是第三方自己能写的，目录名不是）。
- 扫描被截断（>500 文件 / >12 层）→ fail-closed 拒绝。

⚠️ **改了任何内置模块的文件，必须重算基线**，否则该模块会掉进能力扫描被拒加载。
重算方式见 [skill-system.md 第 6 节](skill-system.md#6-安全边界两层别混淆)。

### 12.2 高危能力清单

`fs` `fs/promises` `child_process` `cluster` `dgram` `net` `tls` `worker_threads`
`inspector` `v8` `vm` `module`（含 `node:` 前缀），以及
`process.getBuiltinModule`、运行期拼接 / 模板串形式的动态加载，
以及触碰 `account.json` / `config.json` / `.env` / `process.env` / `accessToken` 等凭据。

用**能力级正则**而不是字符串黑名单，因为黑名单追不上 `require('f'+'s')` 这类等价写法。

### 12.3 运行时护栏

见 8.3 节。

---

## 13. 失败对照表

### 13.1 加载失败（卡片上会显示 `loadError`）

| 界面原文 | 代码原因 |
|---|---|
| `缺少 skill.json / plugin.json` | 目录里没有清单文件 |
| `清单解析失败：…` | JSON 语法错（BOM 已被自动剥离） |
| `清单不可用：缺少 id` | 清单没写 `id` |
| `清单不可用：id 只能包含字母/数字/._-` | `id` 含非法字符 |
| `entry 必须是 Skill 目录内的相对路径：…` | `entry` 越界 |
| `entry 指向了 Skill 目录外（符号链接）：…` | `entry` 是指向目录外的符号链接 |
| `入口文件不存在：…` | `entry` 指向的文件不在 |
| `入口需导出 setup(api)/register(api) 或 hooks/providers` | 入口没导出任何被认可的成员 |
| `加载失败：…` | `import()` 抛错（语法错、顶层异常） |
| `注册失败：…` | `setup`/`register` 抛错 |
| `模块「x」触碰了高危能力：…` | 第三方插件 import 了高危模块或触碰凭据 |
| `模块「x」的文件太多或嵌套太深…` | 扫描被截断（>500 文件 / >12 层） |

重载失败时统一追加 **`（已沿用旧版本继续运行）`**，不会把正在工作的扩展弄挂。

### 13.2 静默失效（不报错、不崩、就是没反应）

**这类最难查，逐条对照：**

| 现象 | 原因 |
|---|---|
| 装上了、开关开了，模型从不用它 | ① 放 `skills/` 但**没注册工具**（模型看不到）；② 工具 `description` 没写清何时用 |
| 条件满足了但插件不跑 | 放 `plugins/` 但**既无 `providers` 也无 `hooks`**（没有代码会调它） |
| 钩子/能力不生效 | 扩展**未启用 / 依赖未就绪**：`runHook` 与 `getCapabilityProviders` 会跳过非 active 的扩展 |
| 提示词片段不见了 | ① `prompt` 形态写错（对象但无 `sections`/`instruction` → 返回 `null`）；② `promptSections` 写成了 `async`；③ `content` 为空被过滤 |
| 自检总是不生效（或恒生效） | `available` 写成了 `async` |
| 清单里写了 `tools[]` 但工具没出现 | `tools[]` 只是元数据，必须 `api.registerTool()` |
| 开关点了没反应 | `activate`/`deactivate` 抛错被吞（只记进 `errors`） |
| `api.fetch` / `api.qqCall` 一直失败 | 没声明 `permissions`，或**能力名拼错**（只有 `web_fetch` / `qq_sticker` 有效） |
| 工具"用着用着就不工作了" | 连续失败 5 次被熔断 5 分钟（`tool-guard.js`） |
| 多个扩展的同类能力只生效一个 | 该能力不是多提供者能力，核心只取第一个 |
| 界面入口点了白屏 | `panel` 路径非法（按钮会就地显示「打不开：<原因>」） |
| 改了内置模块后整个功能消失 | **忘了重算 `builtin-modules.json` 指纹** |

### 13.3 依赖相关的界面文案

| 界面原文 | 含义 |
|---|---|
| `已关闭（点击开启）` | 已加载但未启用 |
| `已启用但依赖未就绪：…` | `requires` 缺能力，或 `available()` 返回 false |
| `加载失败` + 红字原因 | 见 13.1 节 |
| `信任并重试` | 因触碰高危能力被拦，可一键加进 `trustedPlugins` |
| `已配置但未安装（N）` | `config.skills` 里有残留配置，磁盘上已无目录 |

---

## 14. 调试手段

```bash
# 手动触发重扫（热重载关闭时）
curl -X POST http://127.0.0.1:<port>/api/skills/reload

# 控制台端口写在数据目录里
cat data/console-port
```

校验内置模块指纹（本快照没带重算脚本，做法见
[skill-system.md 第 6 节](skill-system.md#6-安全边界两层别混淆)）。

用独立数据目录试错（不污染正在用的实例）：

```bash
QQ_AGENT_DATA_DIR=/tmp/qqa-test node ...
```

控制台里：**技能** / **插件** 两个页签各自会写明每一项为什么没生效
（未启用 / 依赖缺失 / 加载失败 / 模型不支持），不是笼统的"工具关闭"。
