# 项目指南

本文件提供项目入口与导航，具体开发约束见 `.claude/rules/`。规则读取与适用机制见根目录 `AGENTS.md`。

项目核心要点：采用最佳方案、从根本分析修复问题、代码与文档高度统一、遵循项目明确的技术基线、主动清查并清理兼容代码。执行标准统一见 `.claude/rules/conventions.md` 第 1 节，具体技术约定见第 4.2 节及前后端规则；兼容业务逻辑的保留边界见第 3 节。

## 1. 常用命令

使用 pnpm；版本和运行时要求以 `package.json` 的 `packageManager`、`engines` 为准。

```bash
pnpm install                         # 安装依赖
pnpm start                           # Electron 桌面端
pnpm run server                      # headless，默认 http://127.0.0.1:3210，实际端口见 data/console-port
pnpm test                            # 全部 tests/*.test.mjs，等同 pnpm run check
node --test tests/sticker-grace.test.mjs  # 指定测试
node --check src/example.js           # 语法检查，路径替换为实际修改文件
pnpm run verify:version               # 版本一致性校验
```

测试使用 Node 内置 `node:test` 与 `node:assert/strict`。修改代码后检查受影响 JS 文件语法并运行相关测试；涉及跨子系统行为时运行全量测试。纯文档改动检查差异、路径与引用即可。修改内置扩展时，先按后端规则更新指纹，再测试。

## 2. 架构入口

```text
OneBot v11 协议端（SnowLuma / NapCat）
  └─ src/onebot.js                 协议客户端
      └─ src/app.js createApp()    装配核心子系统
          ├─ store.js             消息存档
          ├─ orchestrator.js      唤醒、会话与 agent 调度
          │   └─ prompt.js → llm.js → tools.js
          ├─ sessions.js          会话留档
          ├─ sender.js            出站队列
          ├─ plugin-loader.js + skills/manager.js  扩展装载
          ├─ harness/index.js     内置工具链
          ├─ wallpaper/           壁纸功能
          └─ routes.js            HTTP API 与 SSE
```

- 桌面入口 `electron/main.js` 与 headless 入口 `src/server.js` 共用 `createApp()`。
- 事件驱动、会话之间不沿用 LLM 对话历史：每次唤醒组装静态系统提示、存档摘要和本次新消息。长期信息通过记忆工具保存。
- 依赖由 `app.js` 装配并注入；核心通过能力接口使用扩展，具体约束见后端规则。

## 3. 规则索引

以下是适用范围；所有规则仍须按 `AGENTS.md` 完整读取。不要依赖当前工具一定会自动加载。

| 文件 | 适用范围 | 内容 |
|---|---|---|
| `.claude/rules/conventions.md` | 全项目 | 五项核心原则、根因修复、实际边界、兼容代码清查、复用与解耦、编码、文档与版本 |
| `.claude/rules/frontend.md` | `ui/`、任意 CSS / HTML | 运行环境、脚本加载、视觉与交互、插件面板 |
| `.claude/rules/backend.md` | `src/`、`electron/`、`plugins/`、`skills/`、`tests/` | 提示词缓存、扩展与指纹、发送链路、安全边界 |

## 4. 按任务查阅文档

| 任务 | 文档 |
|---|---|
| 扩展装载、生命周期、指纹重算 | `doc/extend_development/skill-system.md`，指纹见第 6 节 |
| 确定性插件开发与类型判定 | `doc/extend_development/plugin-development.md` |
| LLM 技能开发与工具描述 | `doc/extend_development/skill-development.md` |
| 清单、API、hooks、providers 契约 | `doc/extend_development/skill-reference.md` |
| 插件控制台面板 | `doc/extend_development/panel-ui-contract.md` |
| QQ 协议动作 | `doc/extend_development/onebot-capabilities.md` |

README 面向使用者；CHANGELOG 只记录用户可感知的变更。临时排查记录与待清理清单不作为长期项目规则，处理相关代码时重新核实。
