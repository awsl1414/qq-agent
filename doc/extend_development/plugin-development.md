# 插件开发规范（确定性型）

> 「什么时候该动」能用代码写死、不经过模型判断的扩展，就写成插件。
> 完整字段与 API 表见 [skill-reference.md](skill-reference.md)；
> 整体结构见 [skill-system.md](skill-system.md)。

---

## 1. 先判断：该做插件还是技能

**大多数人分不清这两型，所以先花两分钟回答三个问题。** 选错的后果不是报错，
是功能静默失效：装上了、开关也是开的、就是不干活（原因见 1.1 节）。

### 第一问：触发时机能不能写成一条规则？

| 你的功能 | 答案 |
|---|---|
| "每条消息都看一眼，命中关键词就回一句" | ✅ 能 → 插件 |
| "每次发请求前，往 body 里加两个字段" | ✅ 能 → 插件 |
| "有人撤回消息时，跟着发一句" | ✅ 能 → 插件 |
| "用户问天气的时候帮他查一下" | ❌ 不能，得**看懂**这句话是不是在问天气 → 技能 |

### 第二问：需要模型"理解内容"才能决定吗？

- **需要**（判断这句话是不是在接梗、要不要查资料、该用哪个工具）→ **技能**
- **不需要**（机械地记个数、加个字段、按时间轮换）→ **插件**

### 第三问：你希望它是"必然发生"还是"模型自己看着办"？

- **必然发生**：安全规则、缓存守卫、协议方言适配、撤回反应 → **插件**
  （核心代码会在条件满足时必然调用它，模型无权决定）
- **看着办**：一个可以查资料 / 算数 / 发表情的工具 → **技能**
  （模型看工具说明自己决定调不调）

### 1.1 选错了会怎样

`src/plugin-loader.js` 对两型走同一条加载路径，所以两型都"能装上"。
区别只在 `lintKindPlacement` 的一条告警（不阻断加载）：

| 放错的情况 | 实际后果 |
|---|---|
| 该做插件，却放进 `skills/` 并且没注册工具 | 模型看不到它 → 永远不触发。日志里只有一条告警 |
| 该做技能，却放进 `plugins/` 并且没有 providers/hooks | 没有任何核心代码会调它 → 永远不触发 |
| 该做技能，放进 `skills/` 但忘了写清 `description` | 模型不知道什么时候该用 → 基本不触发 |

判据一句话：规则能写死就做插件；要理解人话就做技能。

> 补充一个反直觉的事实：两型技术上可以混用。一个扩展完全可以既 `registerTool`
> 又提供 `providers`/`hooks`（`plugins/sticker` 就是这么做的：8 个工具 + 1 个 hook + 1 段提示词）。
> 目录只决定它在控制台归到哪一页、以及上面那条告警。
> 所以"三问"是在问你的主要用法是什么，按主要用法归类。

---

## 2. 插件的本质：核心代码会来调你

技能是"模型来找你"，插件是"核心来找你"。核心只在两个地方找你：

| 机制 | 谁调 | 何时 |
|---|---|---|
| `hooks` | 核心在固定事件点 | 每条消息 / 每次发请求前 / 工具执行前后… |
| `providers` | 核心按能力名 | 它需要一个能力时（比如"谁来适配思考参数"） |

你不会在插件里写"监听消息"的循环，那是核心的事。你只提供回调。

---

## 3. 最小可运行插件

`plugins/my-plugin/plugin.json`：

```json
{
  "id": "my-plugin",
  "name": "我的插件",
  "version": "1.0.0",
  "apiVersion": 1,
  "category": "message",
  "description": "被艾特到就说一句「收到」。",
  "enabledByDefault": true,
  "capabilities": [],
  "requires": [],
  "permissions": [],
  "settings": { "reply": "收到" },
  "configSchema": {
    "reply": {
      "type": "string",
      "label": "回复内容",
      "description": "被艾特到时机器人回什么。",
      "default": "收到"
    }
  }
}
```

`plugins/my-plugin/index.js`：

```js
let cfg = () => ({ reply: '收到' });
let log = () => {};

export function setup(api) {
  cfg = () => ({ reply: '收到', ...(api.config() || {}) });
  log = api.log;
  log('已启用');
}

export const hooks = {
  onMessage(ctx) {
    if (!ctx.text || !ctx.text.includes('@我')) return;
    // 通过 ctx.send 主动发言；这里不需要返回值
    ctx.send(String(cfg().reply));
  }
};
```

放进去即生效（热重载默认开），控制台「插件」页签会出现它。

---

## 4. 真实例子：`plugins/cache-guard`

它同时用了 hooks（确定性）、软依赖 provider、自查工具，还写清了自己的红线，值得照着读。

```js
export function setup(api) {
  cfg = () => ({ ...DEFAULTS, ...(api.config() || {}) });
  log = api.log;
  // ① 自查工具：模型被问"缓存命中率怎么样"时能直接查
  api.registerTool({
    id: 'cache_report',
    name: '缓存命中率报表',
    description: '查看前缀缓存命中率统计…当用户问缓存/成本相关问题时调用。',
    parameters: { type: 'object', properties: {} },
    execute: async () => ({ content: buildReport() })
  });
}

export function deactivate() { flushNow(); }   // 禁用/卸载时把内存里的统计落盘
export function dispose() { deactivate(); }

export const hooks = {
  'before-llm-messages'(ctx) {   // ② 每次发请求前：对系统提示做分段指纹，检测缓存前缀漂移
    const sys = (ctx.messages || []).find((m) => m.role === 'system');
    // …
  },
  'after-response'(ctx) {        // ③ 拿到响应后：累计 prompt / cached token
    const c = ctx.session?.lastCallCache;
    // …
  }
};

export const providers = {
  // ④ 软依赖能力：别人可以问"缓存快照是多少"。不装我就没有，但不该导致别人不可用
  'cache.snapshot': () => ({ days: state.days, drift: state.drift, lastSystem: state.lastSystem })
};
```

### 从这个例子里学到的三条

1. `hooks` 是普通对象，键是事件名、值是回调。必须是对象，导出成函数/数组会被忽略成 `{}`。
2. `providers` 用于"给别的扩展用"，不是给自己用。
   `cache.snapshot` 是软依赖：别人用 `api.capability('cache.snapshot')` 拿，
   拿不到就降级，不会因为没装 cache-guard 而变成不可用。
3. 数据只写 `plugin-data/`，绝不写进 `plugins/`（原注释原话）：
   > 数据只写 `QQ_AGENT_DATA_DIR/plugin-data/cache-guard/`，绝不写进 `plugins/` 目录
   > 因为 `fs.watch recursive` 会把每次写盘变成全量重扫。

---

## 5. 清单怎么写

| 字段 | 插件里的常见写法 |
|---|---|
| `id` | 小写英文 + 连字符，如 `my-plugin`。必须与目录名一致（便于排查） |
| `category` | `model` / `message` / `knowledge` / `media` / `utility` / `fun` / `query` |
| `enabledByDefault` | 有副作用的（改请求、发消息）建议 `false`；纯观测的可以 `true` |
| `capabilities` | 你提供的能力名，如 `['cache.snapshot']` |
| `requires` | 你依赖的能力名（硬依赖，缺了本插件不可用）。能用软依赖就别用这个 |
| `permissions` | 只有 `web_fetch` / `qq_sticker` 有效 |
| `settings` | 默认值 |
| `configSchema` | 每个键给 `label` + `description`，控制台设置弹窗直接照它渲染 |
| `prompt` | 需要往系统提示词里加规则时才写 |

**状态放哪：**

| 场景 | 用什么 |
|---|---|
| 第三方插件（走能力扫描） | `api.storage`（`plugin-data/<id>/storage.json`，1MB 上限） |
| 内置插件（有指纹豁免） | 可以 `import fs` 自己写 `plugin-data/<id>/`，但要节流 + 原子写 |
| 要给自带页面看的 | 写进 `api.storage`，页面 `fetch('../@data/storage.json')` |

> 内置插件为什么能 `import node:fs`：它靠 `builtin-modules.json` 的指纹豁免过准入闸。
> 代价是改了它的任何文件都必须重算基线（见 [skill-system.md 第 6 节](skill-system.md#6-安全边界两层别混淆)），
> 否则下次启动它会掉进能力扫描被拒加载。第三方插件没有这个豁免。

---

## 6. 常见的坑

| 坑 | 症状 | 正确做法 |
|---|---|---|
| `hooks` / `providers` 导出成函数或数组 | 被忽略成 `{}`，插件完全不工作 | 必须是普通对象 |
| `available` / `promptSections` 写成 `async` | 自检恒真 / 提示词片段消失，不报错 | 这两个是同步调用的 |
| `prompt` 写对象但既无 `sections` 也无 `instruction` | 提示词静默消失 | 用 `{sections:[{id,content,priority}]}` |
| 数据写进 `plugins/` 目录 | 每次写盘触发全量重扫（热重载抖动） | 写 `plugin-data/` 或 `api.storage` |
| 在 `before-llm-messages` 里返回新数组 | 无效，返回值被忽略 | 原地改 `ctx.messages` |
| 想"否决某次工具调用"却用了 `after-tool` | 已经执行完了 | 用 `before-tool` 返回 `{block:true, reason}` |
| 忘了声明 `permissions: ['web_fetch']` | `api.fetch` 一直 reject | 声明权限，且拼写要对 |
| 改了内置插件文件没重算基线 | 下次启动整个插件消失 | 见 [skill-system.md 第 6 节](skill-system.md#6-安全边界两层别混淆) |
| 依赖能力写进 `requires` 但其实可选 | 缺了以后插件整体不可用 | 改成 `api.capability()` 软依赖 |

---

## 7. 自查清单

- [ ] 三个问题都答过，确认主要用法是"核心必然调用"而不是"模型看着办"
- [ ] 目录在 `plugins/`，`plugin.json` 的 `id` 与目录名一致
- [ ] 入口导出了 `setup(api)`（或 `register(api)`），或至少导出了 `hooks` / `providers`
- [ ] `hooks` / `providers` 是对象字面量
- [ ] 每个 `configSchema` 键都有 `label` 和 `description`
- [ ] `available` / `promptSections` 不是 `async`
- [ ] 状态写进 `api.storage` 或 `plugin-data/`，没有写进插件目录
- [ ] 需要联网/QQ 能力时声明了对应 `permissions`
- [ ] 如果用了 `hooks`，确认它在扩展被禁用时也能安全跳过（会被静默跳过，别依赖它清理资源）
- [ ] 改了 `plugins/**` 任何文件后 → 重算 `builtin-modules.json` 指纹（见 [skill-system.md 第 6 节](skill-system.md#6-安全边界两层别混淆)）
- [ ] 控制台「插件」页签里显示"生效中"，而不是"依赖未就绪 / 加载失败"

---

## 相关文档

- [skill-development.md](skill-development.md)：LLM 型（技能）开发规范
- [skill-reference.md](skill-reference.md)：完整 API 参考
- [skill-system.md](skill-system.md)：架构总览、加载流水线、安全边界
- [onebot-capabilities.md](onebot-capabilities.md)：操作 QQ 本身
- [panel-ui-contract.md](panel-ui-contract.md)：让插件在控制台里拥有自己的界面
