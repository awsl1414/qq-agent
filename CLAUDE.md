# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 命令

```bash
pnpm install                       # 依赖（含 electron，首次会懒下载约 238MB 二进制）
pnpm start                         # Electron 桌面端
pnpm run server                    # headless，控制台 http://127.0.0.1:3210
pnpm test                          # = pnpm run check，跑 tests/*.test.mjs
node --test tests/sticker-grace.test.mjs   # 跑单个测试文件
```

测试用 Node 内置 `node:test` + `node:assert/strict`，无测试框架依赖。仓库没有 lint / format 配置，改动后至少跑一次 `node --check <file>`。

改完 `plugins/`、`skills/` 下的任何文件后**必须重算 `builtin-modules.json`**，否则该模块会掉进能力扫描被拒绝加载（表现为"这个内置功能突然整个不工作了"）。做法见 `doc/extend_development/skill-system.md` 第 6 节。

## 架构

```
协议端（用户自装 SnowLuma / NapCat）
  └─ OneBot v11：WS 3001 收事件 / HTTP 3000 发动作
       └─ src/onebot.js  ── 客户端
            └─ src/app.js  createApp()  ← 核心，闭包装配所有子系统
                 ├─ src/store.js        消息存档（每条带时间 + 已读）
                 ├─ src/orchestrator.js 唤醒判定 → 建会话 → 跑 agent
                 │    └─ prompt.js 组装提示词 → llm.js 调用 → tools.js 执行
                 ├─ src/sessions.js     会话卡片留档
                 ├─ src/sender.js       出站队列（白名单闸 / 限频 / 去重）
                 ├─ src/plugin-loader.js + src/skills/manager.js  扩展装载
                 ├─ src/harness/index.js  内置工具链（kind='core'）
                 └─ src/routes.js       145 个 /api 接口 + SSE
```

**事件驱动 + 无状态会话**是整个设计的成本基础：每次唤醒新开一个会话，提示词 = 静态系统提示 + 存档摘要 + 本次新消息，会话结束即弃置。LLM 侧零历史，单次成本恒定。长期信息只能走记忆工具。

**两个入口共用一套核心**：`electron/main.js`（桌面）与 `src/server.js`（headless）都调 `createApp()`。

**依赖注入而非全局单例**：`createRoutes(deps)` 从 `app.js` 收齐依赖；核心代码从不 `import` 具体扩展，只按能力名问 `skillManager.getCapabilityProviders('llm.request-params')`。新增能力时先看 `src/skills/manager.js` 的 `MULTI_PROVIDER_CAPABILITIES`：只有那 6 个能力允许多提供者，其余能力多注册会被静默忽略。

### 扩展两型

| | 放哪 | 生效方式 | 谁决定执行 |
|---|---|---|---|
| 插件（确定性型） | `plugins/<id>/` | `providers` / `hooks` | 核心代码 |
| 技能（LLM 型） | `skills/<id>/` | `registerTool` + 提示词片段 | 模型 |

两型走**同一条加载路径**，目录只决定 `manifest.kind` 和一条告警。选错的后果是静默失效：装上了、开关也开着、就是不干活。判定方法见 `doc/extend_development/plugin-development.md` 第 1 节。

`src/harness/` 下的模块（自检 / 修复 / 锻造台 / 工单）与 `src/wallpaper/` 是 `kind='core'`：不可禁用、不走目录扫描与指纹闸、**不热重载**，改完必须重启。

### 前缀缓存是硬约束

`src/prompt.js` 的段落顺序不能随意调整。前缀缓存要求从第一个字节起逐字节一致，任何插在中间的变化都会让后面全部作废。规则：

- 静态段全部在前，动态段殿后
- 每轮必变的段（当前时间、此刻状态）声明 `volatile: true`，由 `renderVolatileSections` 挪到尾部
- 同优先级片段按 `id` 字典序排（防重扫导致字节漂移）

`tests/volatile-contract.test.mjs` 钉住了这条契约，改动提示词组装前先读它。

## 项目规范

规范按作用范围拆在 `.claude/rules/` 下，改对应文件时会自动加载：

| 规则 | 何时加载 | 内容 |
|---|---|---|
| `conventions.md` | 始终 | 术语一致性、根因修复、通用编码规范、更新日志、解耦判断、兼容代码边界 |
| `frontend.md` | 编辑 `ui/` 下的文件、任意 `.css` / `.html` 时 | 前端规范与页面设计、浏览器基线 |
| `backend.md` | 编辑 `src/`、`electron/`、`plugins/`、`skills/`、`tests/` 时 | 提示词契约、扩展装载、发送链路、Electron 边界 |

修 bug 时先读 `conventions.md` 的「修问题」一节：找本质原因、从底层修，不做表面修复。
升版本时读「更新日志」一节：把 `## 未发布` 转成版本条目并压缩。

## 已知的清理项

以下已确认无调用方或已过时，遇到时顺手处理，不要在此基础上继续加东西：

- `src/tool-registry.js` 的 `isToolEnabledLegacy`，全仓仅 1 处引用（自身定义）
- `src/harness/dev/index.js` 的 `CTX_KEEP_TAIL`，自 2026-10-15 起不再使用，只剩一处导出、没有调用方或测试引用

## 相关文档

| 文档 | 内容 |
|---|---|
| `doc/extend_development/skill-system.md` | 加载流水线、能力机制、安全边界、基线重算 |
| `doc/extend_development/plugin-development.md` | 插件规范，第 1 节是两型判定法 |
| `doc/extend_development/skill-development.md` | 技能规范，工具描述怎么写 |
| `doc/extend_development/skill-reference.md` | 完整 API 查表 |
| `doc/extend_development/panel-ui-contract.md` | 插件往控制台放界面 |
| `doc/extend_development/onebot-capabilities.md` | `api.qqCall` 能调什么 |

README 面向使用者，CHANGELOG 只记面向用户的变更。
