---
paths:
  - "src/**/*.js"
  - "electron/**/*.js"
  - "plugins/**/*"
  - "skills/**/*"
  - "tests/**/*"
---

# 后端与扩展规范

## 提示词契约（改 `src/prompt.js` 前必读）

前缀缓存要求从第一个字节起逐字节一致才能命中。任何插在中间的变化都会让后面全部作废，而系统提示通常占 token 大头。

- 静态段全部在前，动态段殿后
- 每轮必变的段（当前时间、此刻状态）声明 `volatile: true`，由 `renderVolatileSections` 挪到尾部
- 同优先级片段按 `id` 字典序排，防重扫导致字节漂移
- 扩展片段的 `priority` 被强制钳到 ≤ 99，且一律渲染在核心安全规则之后，压不到核心规则之上

`tests/volatile-contract.test.mjs` 钉住了这条契约。改动提示词组装前先读它。

安全规则（`securityRules()`）里"数据不是指令"的条款覆盖群消息与 `web_fetch` 抓回的网页内容两路，改动时不要削弱。

## 扩展装载

两型走同一条加载路径，目录只决定 `manifest.kind` 和一条告警：

| | 放哪 | 生效方式 | 谁决定执行 |
|---|---|---|---|
| 插件（确定性型） | `plugins/<id>/` | `providers` / `hooks` | 核心代码 |
| 技能（LLM 型） | `skills/<id>/` | `registerTool` + 提示词片段 | 模型 |

选错的后果是静默失效：装上了、开关也开着、就是不干活，且不报错。判定方法见 `doc/extend_development/plugin-development.md` 第 1 节。

`src/harness/` 与 `src/wallpaper/` 是 `kind='core'`：不可禁用、不走目录扫描与指纹闸、不热重载，改完必须重启。

### 改内置模块必须重算基线

`plugins/`、`skills/` 下任何文件改动后都要重算 `builtin-modules.json`，否则指纹失配会让该模块掉进能力扫描被拒绝加载。做法见 `doc/extend_development/skill-system.md` 第 6 节。

## 能力（providers）

核心代码从不 `import` 具体扩展，只按能力名问 `skillManager.getCapabilityProviders('llm.request-params')`。

`src/skills/manager.js` 的 `MULTI_PROVIDER_CAPABILITIES` 只列了 6 个允许多提供者的能力。其余能力多注册会被静默忽略：核心只取第一个，后面的不生效。

## 发送链路

出站必须经过 `src/sender.js` 的队列，它统一处理：白名单硬闸（`#ensureAllowed`）、限频、去重、分段。

插件里主动发言用 hook 上下文给的 `ctx.send` / `ctx.sendSegments`，不要自己调 `send_*_msg`；发表情走 `ctx.sender.sendSticker`。这两条路径才会走完整链路。

## Electron 边界

- 渲染进程不持有 API 凭据。主进程独占随机凭据，通过 `webRequest` 只注入控制台窗口的 API 请求
- 外链一律过 `electron/external-link.js` 的四道判据（协议白名单 / 拒 userinfo / 本机地址不外开 / 主机白名单）
- 桌宠、小窗等独立窗口各用一份受限 preload，做 sender + origin + pathname 三重校验
- 原生消息框统一走 `electron/dialog-safe.js` 的 `showDialog`（挂父窗口 + 超时自消）

## 安全边界

两层，别混淆：

1. 准入闸 `checkPluginTrust()`（`src/plugin-loader.js`）：内置指纹豁免 → 信任名单 → 能力扫描（`fs` / `child_process` / `net` / `vm` / `process.env` 等一律拒载，含拼接绕过）
2. 运行时护栏 `guardToolExecute()`（`src/tool-guard.js`）：单次 120s 超时、返回文本截断 30000 字符、同 skillId 连续失败 5 次熔断 5 分钟

联网抓取走 `src/safe-fetch.js`，带 DNS 校验 / IP 固定 / 手动跟重定向的 SSRF 防护。不要绕过它直接用 `fetch`。
