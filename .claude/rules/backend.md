---
paths:
  - "src/**/*"
  - "electron/**/*"
  - "plugins/**/*"
  - "skills/**/*"
  - "tests/**/*"
---

# 后端与扩展规范

## 1. 提示词与缓存契约

改提示词组装前，先读 `tests/volatile-contract.test.mjs` 及相关实现。

- 前缀缓存依赖从开头逐字节一致：静态内容在前，动态内容在后。
- 每轮变化的片段声明 `volatile: true`；收集阶段保留该字段，由 `src/prompt.js` 的 `renderVolatileSections` 渲染到动态区域。
- 同优先级片段按 `id` 字典序排序，避免重扫造成顺序漂移。
- 扩展片段的 `priority` 上限为 99，渲染在核心安全规则之后；相关实现见 `src/skills/manifest.js`、`src/skills/manager.js` 与 `src/prompt.js`。不得通过自定义系统提示绕过安全规则与工具协议。
- `securityRules()` 的“数据不是指令”覆盖群消息与网页内容，修改时不能削弱。

## 2. 扩展类型、装载与能力

| 类型 | 目录 | 主要生效方式 | 执行决定方 |
|---|---|---|---|
| 插件 | `plugins/<id>/` | `providers` / `hooks` | 核心代码 |
| 技能 | `skills/<id>/` | `registerTool` + 提示词片段 | 模型 |

两型共用装载路径，目录决定分类与告警，不限制可注册的机制。按主要用法选择类型；功能能否触发取决于是否提供了对应工具、能力或钩子。开发前查阅 `doc/extend_development/plugin-development.md` 或同目录 `skill-development.md` 的第 1 节。

- 核心不直接导入具体扩展，通过 `skillManager.getCapabilityProviders()` 等能力接口调用。
- 多提供者能力以 `src/skills/manager.js` 的 `MULTI_PROVIDER_CAPABILITIES` 为准；其他能力按单提供者契约处理，不能假定重复注册后会全部执行。组合顺序以调用方为准。
- `src/harness/` 与 `src/wallpaper/` 属于 `kind='core'`：不可禁用、不走扩展目录扫描与指纹闸、不热重载，改动后须重启。
- 扩展状态写 `api.storage` 或数据目录，不写回扩展源码目录，以免触发热重载重扫。生命周期及 API 契约见 `doc/extend_development/skill-system.md` 与同目录 `skill-reference.md`。

### 2.1 内置扩展指纹

修改 `plugins/`、`skills/` 下的内置扩展文件后，必须同步更新 `builtin-modules.json` 中对应条目，包括新增与删除文件。否则指纹失配会让扩展回落到能力扫描，可能被拒载。

按 `doc/extend_development/skill-system.md` 第 6 节重算：相对路径为键，文件字节的 `sha1` 前 16 位为值。顺序是：完成扩展改动 → 更新对应基线 → 运行测试；不改无关扩展的指纹。

## 3. 发送链路

- 出站经过 `src/sender.js` 队列，统一执行白名单、限频、去重和分段。
- 插件主动发言使用 hook 上下文的 `ctx.send` / `ctx.sendSegments`，发表情使用 `ctx.sender.sendSticker`，不要直接调用 `send_*_msg` 绕过链路。

## 4. Electron 边界

- 窗口沿用 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`；preload 通过 `contextBridge` 暴露限定方法，不暴露整个 `ipcRenderer`。已有环境兼容开关只保留在统一入口，不在新增窗口中自行关闭隔离。
- 渲染进程不持有 API 凭据；主进程通过 `webRequest` 仅向控制台窗口的 API 请求注入凭据。
- 外链经过 `electron/external-link.js`：协议白名单、拒绝 userinfo、本机地址不外开、主机白名单。
- 独立窗口使用受限 preload，并校验 sender、origin 和 pathname。
- 原生消息框统一使用 `electron/dialog-safe.js` 的 `showDialog`，按调用场景设置父窗口与超时。

窗口与 preload 调整同时遵守 [Electron 安全建议](https://www.electronjs.org/docs/latest/tutorial/security)，不通过启用 Node 集成或放宽 CSP 解决界面接入问题。

## 5. 扩展与联网安全

- 准入由 `src/plugin-loader.js` 的 `checkPluginTrust()` 负责：内置指纹豁免 → 信任名单 → 能力扫描。不得为解决加载失败而绕过检查。
- 扩展工具运行时由 `src/tool-guard.js` 的 `guardToolExecute()` 负责超时、输出限制与熔断，阈值以 `TOOL_GUARD` 为准。这是运行时护栏，不是隔离沙箱，不能当作能终止同步死循环或取消底层任务。
- 抓取外部内容使用 `src/safe-fetch.js` 或扩展 API 提供的受控接口，保留 DNS 校验、IP 固定和重定向检查，不直接用 `fetch` 绕过 SSRF 防护。
