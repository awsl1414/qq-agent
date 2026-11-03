# 运行方式与部署

> 面向使用者：怎么启动、数据放在哪、多开怎么配、出问题查什么。
> 装依赖、装协议端、首次配置见 [README](../README.md) 的「安装与使用」。

---

## 1. 三种运行方式

| 方式 | 命令 / 入口 | 需要什么 | 适合谁 |
|---|---|---|---|
| 桌面端 | `pnpm start`（`electron/main.js`） | Electron 二进制 | 日常使用：托盘常驻、桌宠、桌面悬浮小窗 |
| 网页模式 | `pnpm run server`（`src/server.js`） | 只要 Node | 服务器常驻、想用另一台设备的浏览器看控制台 |
| 打包版 | 双击 `qq-agent.exe`（安装包或解压目录） | 无 | 不想装 Node / pnpm 的机器 |

三者共用同一套核心（`src/app.js` 的 `createApp()`）与同一份数据格式，随时可以换着跑，数据目录不变就能接上。

### 1.1 网页模式（浏览器运行）

`pnpm run server` 跑的是 `src/server.js`，**完全不加载 Electron**，所以不需要 Electron 二进制，也不需要桌面环境。

- **浏览器打开 `http://127.0.0.1:3210`**（端口见第 5 节）。控制台界面与桌面端是同一份：`src/app.js` 的静态分支把整个 `ui/` 目录服务出去，`/` 就是 `ui/index.html`，脚本在 `/app/*.js`，插件自带页面在 `/plugin-panel/<id>/…`。桌面端独有的能力（`window.qqaDesktop` 桥）不存在时，页面自己降级：窗口按钮只剩返回键、「浏览…」按钮隐藏、背景图选择给出明确提示。
- **只监听回环**：`src/app.js` 的 `listenOn` 里是 `server.listen(port, '127.0.0.1')`。局域网、远程都访问不到。想从别的设备看，得自己在前面架 nginx 之类的反向代理，那等于把控制台暴露到网络上，风险（控制台里有明文 API Key、协议端凭据）由你自己承担。
- **端口让位**：从 `config.server.port`（默认 3210）起逐个 +1 试听，最多试到 +9；实际端口写进 `<数据目录>/console-port`（一行数字，每次启动覆盖，退出不删）。
- **鉴权**：
  - `server.token` 为空（默认）→ `/api/*` 直接放行，浏览器打开即用。
  - 配了 `server.token` → 首次打开要带 `?token=<token>`。`ui/app/00-core.js` 的 `CONSOLE_AUTH_TOKEN` 会把它存进 sessionStorage 并从地址栏抹掉，之后这个标签页自动带上。不带 token 时页面能打开，但所有接口报「没有权限（控制台令牌失效或被拒绝）」。
  - 外部脚本调**写**接口需要同源：带 `Origin: http://127.0.0.1:<实际端口>`（`src/app.js` 的 `originAllowed`）。纯 GET 不需要来源。配了 token 的话再带 `x-console-token: <token>` 头或 `?token=` 参数，两条都要满足。
  - 「显示 API Key」「协议端控制台密码」这类明文密钥端点，在浏览器里默认读不到（`keyEndpointAllowed` 只认 Electron 主进程注入的渲染凭据或你自配的 `server.token`）。需要时配 token，而不是去打开 `server.allowBrowserKeyRead`。
- **网页模式没有的功能**：托盘常驻、开机自启、桌宠（`desktopPetHost` 为 `null`，桌宠页会提示「需要 QQ Agent 桌面程序」）、桌面悬浮小窗、选背景图 / 选文件夹这类原生对话框。壁纸控制（Wallpaper Engine）走系统命令，网页模式下照常可用。
- **怎么停**：`Ctrl+C`。`src/server.js` 注册了 SIGINT，会先 `app.stop()`（落盘、释放单实例锁、断开 OneBot）再退出。直接关终端窗口属于强杀，锁文件靠下次启动时的残留检测自动接管。
- **启动日志**：同时写两处，终端（stdout，`[模块] 消息`）和 `<数据目录>/logs/qq-agent-<日期>.log`（带时间戳与级别）。启动完成时会打一行 `控制台已就绪：http://127.0.0.1:<端口>`，这就是实际端口；`<数据目录>/console-port` 里也有同一份数字。启动失败走 stderr 打 `[启动失败] …` 并退出。

### 1.2 桌面端

`pnpm start` 启动 Electron 主进程，行为：

- **托盘常驻**：点窗口 ✕ 默认缩到托盘、进程继续跑（`config.server.closeToTray`，默认开）。真正退出走托盘菜单的「退出」。
- **开机自启**：设置页「界面与应用 → 桌面端」或托盘菜单里的「开机自启」勾选，落地为 `app.setLoginItemSettings({ openAtLogin })`。只对桌面端有效。
- **重复启动**：再双击一次会唤出已有窗口，不会开第二个进程。
- **控制台鉴权**：桌面端由主进程每次启动生成随机凭据并通过 `webRequest` 注入，不需要你配 `server.token`。

### 1.3 打包版

仓库已有打包基础设施：`electron-builder.yml` 加 `scripts/` 下的三个脚本。

```bash
pnpm run build          # 产出 NSIS 安装包与免安装 zip，落在 dist/
pnpm run build:dir      # 只出解包目录，用于快速验证
pnpm run prepack:check  # 只跑构建前静态校验
pnpm run verify:version # 校验 VERSION / package.json / CHANGELOG 顶部版本一致
```

- 数据目录固定在 **exe 同级的 `data/`**（多实例为 `data-<N>/`），不往 `%APPDATA%` 塞。安装目录必须可写，所以安装器默认装到 `%LOCALAPPDATA%\Programs\…`，不要手工装进 `Program Files`。
- 卸载时保留 `data/`（群聊记录、记忆、API Key 都在里面）。
- 打包产物里 `asar` 关闭：运行时要往代码根写 `plugins/`、`skills/` 与 `builtin-modules.json`，这是硬约束，不是风格选择。

---

## 2. 环境变量

所有环境变量都在进程启动时读取一次，改完要重启。Windows 下 `$env:NAME="值"`，bash 下 `export NAME=值`。

### 2.1 运行与路径

| 变量 | 作用 | 取值 / 默认 | 源码位置 |
|---|---|---|---|
| `QQ_AGENT_DATA_DIR` | 数据目录，覆盖一切推导 | 任意绝对路径；不设时按 profile 推导 | `src/config.js` 的 `DATA_DIR`；桌面端见 `electron/main.js` 的 `resolveDataDir` |
| `QQ_AGENT_PROFILE` | 多实例编号 | 纯数字；非数字视为未设 | `src/profile.js` 的 `PROFILE_ID` / `portOffset` |
| `QQ_AGENT_PORT` | 控制台端口 | 数字；只在 `config.json` 里还没有 `server.port` 时生效 | `src/config.js` 的 `DEFAULT_CONFIG.server.port` |
| `QQ_AGENT_DEV` | 强制打开扩展热重载 | `1` = 强制开（不能强制关） | `src/app.js` 的 `hotReloadOn` |
| `QQ_AGENT_DEV_SANDBOX` | 开发工单沙箱根目录 | 绝对路径；默认在应用根外两级的 `dev-sandbox/` | `src/harness/dev/index.js` 的 `SANDBOX_ENV` |
| `QQ_AGENT_DEV_CTX_BUDGET` | 开发工单的单轮上下文字符预算 | 数字；默认 400K 字符 | `src/harness/dev/executor.js` 的 `DEV_CTX_CHAR_BUDGET_DEFAULT` |
| `QQ_AGENT_FFMPEG` | 指定 ffmpeg 路径（优先于自动探测） | 可执行文件绝对路径 | `src/ffmpeg-resolve.js` 的 `buildCandidatesByGroup` |
| `QQ_AGENT_COMMUNITY_KEY` | 云端屏蔽名单写密钥（仅管理员） | 字符串；显式设为空 = 不用 | `src/community.js` 的 `communityWriteKey` |

另有 `QQ_AGENT_FIX_SANDBOX` 只在自动修复拉起子进程时由代码自己注入（`src/harness/fix/checks.js`），不是给用户配的。

### 2.2 预算（省 token / 防超限）

| 变量 | 作用 | 取值 / 默认 | 源码位置 |
|---|---|---|---|
| `QQ_AGENT_PROMPT_BUDGET` | 用户提示词总字符上限，超了裁最早的历史 | 数字；默认 400 × 1024 字符 | `src/prompt.js` 的 `PROMPT_CHAR_BUDGET` |
| `QQ_AGENT_MEDIA_BUDGET` | 单次请求里媒体部分的字符上限，超了从最早的媒体开始丢 | 数字；默认 512 × 1024 | `src/llm.js` 的 `MEDIA_CHAR_BUDGET` |

### 2.3 渲染与排障（仅桌面端）

| 变量 | 作用 | 取值 | 源码位置 |
|---|---|---|---|
| `QQ_AGENT_DISABLE_GPU` | 强制软件渲染 | 非空且不等于 `0` 即生效，优先级最高 | `electron/main.js` 的 `gpuDisable` |
| `QQ_AGENT_ENABLE_GPU` | 强制开启 GPU | `1` = 开；`0` = 关 | 同上 `gpuForce` |
| `QQ_AGENT_NO_SANDBOX` | 关闭渲染进程沙箱（逃生门） | `1` = 关；只在「沙箱导致起不来」时临时用 | 同上 `NO_SANDBOX_ESCAPE` |
| `QQ_AGENT_DEBUG_MEMORY` | 记忆解析失败时打印模型原始返回 | 任意非空 | `src/orchestrator.js` 的记忆整理分支 |

GPU 的判定顺序是：`QQ_AGENT_DISABLE_GPU` → `QQ_AGENT_ENABLE_GPU` → `data/render-gpu-off.flag` 是否存在 → 默认开。

### 2.4 搜索服务密钥

设置页里留空时回退到环境变量（`src/web-search.js` 各家 provider 的 `apiKey` 取值处）。

| 变量 | 服务 |
|---|---|
| `DEEPSEEK_API_KEY` | DeepSeek 搜索 |
| `ZHIPU_API_KEY` | 智谱搜索 |
| `BOCHA_API_KEY` | 博查搜索 |
| `BAIDU_SEARCH_API_KEY` | 百度千帆搜索 |
| `METASO_API_KEY` | 秘塔搜索（无 Key 也会尝试官方免费额度） |

Bing 网页解析不需要 Key，是默认搜索源。

---

## 3. 数据目录

默认位置：

| 场景 | 位置 |
|---|---|
| 开发 / `pnpm run server` | 仓库内的 `data/` |
| 打包版 | `<exe 同级>/data/` |
| 多实例（`QQ_AGENT_PROFILE=N`） | 上述位置换成 `data-<N>/` |
| 显式覆盖 | `QQ_AGENT_DATA_DIR` 指向的目录（优先级最高） |

主要子目录与文件：

| 路径 | 内容 |
|---|---|
| `config.json` | 全部配置：API Key、协议端令牌、白名单、人设、`server.token` |
| `messages/` | 群聊与私聊消息存档（每条带时间与已读状态） |
| `memory/` | 群友印象（控制台「记忆」页） |
| `memory-v2/` | 内置分层记忆的派生索引（历史数据，保留不删） |
| `memory-v3/` | `mem-layered` 插件的分层记忆数据根 |
| `sessions/` | 每次处理的会话卡片留档（提示词、思考、工具调用、实际发出的消息） |
| `logs/` | 按天日志 `qq-agent-<日期>.log`，保留 7 天 |
| `plugin-data/<id>/` | 各插件/技能自己的数据（自检报告、修复工单、锻造台暂存、开发工单等） |
| `usage-ledger/` | 用量账本，按天一个 `YYYY-MM-DD.ndjson` |
| `usage-daily.json` / `usage-today.json` / `usage-archived-days.json` | 用量聚合快照 |
| `telemetry.json` / `telemetry-totals.json` | 匿名用量遥测的本机 id 与累计值（遥测默认关闭，文件仍会累计本地计数） |
| `image-cache/` / `video-cache/` | 收到的图片与视频缓存 |
| `ui/` | 控制台背景图、壁纸预览图 |
| `wallpaper-static/` / `wallpaper-state.json` / `wallpaper-imports.json` | 壁纸库静态副本与状态 |
| `desktop-pet/` | 桌宠模型（`models/`）、预览图、`state.json` |
| `exports/` / `import-bundles/` / `import-backups/` | 数据导出包、导入包解压临时区、导入前备份 |
| `runtime/ffmpeg/` | 设置页「媒体工具」下载的 ffmpeg |
| `runtime/legacy-backup/` | 跨版本迁移搬出来的旧文件（如旧版随包的 ffmpeg）。不自动删除，确认不要了在「设置 → 外观与数据」里清 |
| `account.json` | 社区市场账号凭据（不进 `config.json`） |
| `qq-agent.lock` | 进程单实例锁 |
| `console-port` | 控制台实际端口（一行数字） |
| `window-state.json` | 桌面端窗口位置与尺寸 |
| `reminders.json` / `cache-warm-prefix.json` / `price-feed-cache.json` / `cloud-global-blocklist.json` / `session-index-cache.json` / `upgrade-state.json` | 提醒、缓存保活前缀、远程价表缓存、云端屏蔽名单、会话索引缓存、版本迁移进度 |
| `render-gpu-off.flag` / `render-config.json` / `boot-diag.log` / `boot-fallback.log` | 桌面端渲染降级标记与启动诊断 |

> **`data/` 里是明文 API Key、协议端令牌和真实群聊记录，绝不入库。** 仓库的 `.gitignore` 已挡掉 `data/` 与 `data-*/`，备份、分享、提 issue 时也请先脱敏。

目录里不是每项都会立刻出现：`messages/`、`sessions/`、`image-cache/` 等都是首次用到才建。

---

## 4. 多实例

同一台机器跑两个 QQ 号，靠 `QQ_AGENT_PROFILE` 把数据目录岔开。`src/profile.js` 的 `profileSuffix` / `portOffset` 同时给出默认端口偏移：

| `QQ_AGENT_PROFILE` | 数据目录 | 控制台默认端口 | OneBot 默认 WS / HTTP |
|---|---|---|---|
| 不设 | `data/` | 3210 | 3001 / 3000 |
| `1` | `data-1/` | 3310 | 3101 / 3100 |
| `2` | `data-2/` | 3410 | 3201 / 3200 |
| `N` | `data-N/` | 3210 + N×100 | 3001 + N×100 / 3000 + N×100 |

偏移是恒定的 N×100，不是固定 +100，否则 #2 和 #3 会互撞。

> ⚠️ 偏移只写进「默认值」，不覆盖已存的配置。`src/config.js` 的 `loadConfig` 把磁盘上的 `config.json` 深合并到 `DEFAULT_CONFIG` 之上，所以只要 `data-N/config.json` 里已有 `server.port` / `protocol.wsUrl` / `protocol.httpUrl`，就以文件里的值为准，profile 只决定数据目录名。`data-N/` 一旦落过配置，端口就固定下来了（首次按偏移值落盘，自洽）。
>
> 由此得出两条实操规则：不要从 `data/` 复制 `config.json` 到 `data-2/`（端口与协议端地址会一起复制过去，两个实例撞同一套端口）；复制过的话，进控制台把「工具 → 连接」的地址和 `server.port` 改到偏移值。

正确姿势：

1. 每个实例设一个不同的 `QQ_AGENT_PROFILE`，各自用 `pnpm run server` 起。
2. 每个实例在协议端里登录不同的 QQ 号，并且协议端的 OneBot 端口要各自对齐（协议端默认只开 3001/3000，第二套需要在协议端里另建一组端口，再在控制台「工具 → 连接」页改成偏移后的地址）。
3. 白名单、模型 Key、人设按实例各自配一遍（数据目录独立，配置不共享）。

> 不设 profile 会双份回复。两个实例连同一个协议端、处理同一个 QQ 号的消息，群里就会收到两遍同样的回复。同一数据目录本身会被核心的单实例锁（`qq-agent.lock`）拦住，所以更常见的形态是"数据目录分开了，但端口没分开、连的还是同一个协议端"。
>
> 桌面端不能靠 profile 多开。Electron 的单实例锁按用户数据目录生效（实测：同一 `userData` 下第二个实例拿到锁失败，换 `userData` 或传 `--user-data-dir` 则两边都能拿到），而 `electron/main.js` 没有按 profile 切换 `userData`，所以第二个桌面实例会直接弹「已经在运行了」并退出。要多开请用网页模式；桌面端（`data/`）与若干 headless 实例（`data-2/`、`data-3/`…）可以并存，互不干扰。给桌面端传 `--user-data-dir` 理论上能绕过这条锁，但本项目没有适配、也没有验证过这种组合，不列为支持路径。

---

## 5. 端口

| 用途 | 默认 | 配置位置 |
|---|---|---|
| 控制台 HTTP | 3210（+ profile 偏移） | `config.json` 的 `server.port`；`QQ_AGENT_PORT` 只在配置里还没有该字段时生效 |
| OneBot WS（收消息） | 3001（+ profile 偏移） | `config.json` 的 `protocol.wsUrl`，控制台「工具 → 连接」页可改 |
| OneBot HTTP（发消息） | 3000（+ profile 偏移） | `config.json` 的 `protocol.httpUrl`，同上 |

**端口让位**：`src/app.js` 的 `start()` 从基准端口起逐个 +1 试听，共试 10 个（基准 … 基准 +9）。实际端口写进 `<数据目录>/console-port`，每次启动覆盖、退出时故意不删（脚本在应用没起时还能读到上次的端口）。10 个全被占则启动失败，退出码 1，stderr 打印 `[启动失败] Error: listen EADDRINUSE …`。

叠加顺序是先 profile 偏移、再让位：`PROFILE=2` 从 3410 开始试，3410 被占就用 3411。

### 5.1 网页模式的完整使用流程

1. 装依赖：`pnpm install`（只用 pnpm，`npm` / `yarn` 不在支持范围）。
2. 启动：`pnpm run server`。
3. 拿地址：读 `<数据目录>/console-port`（默认就是 `data/console-port`），或看 `data/logs/` 当日日志里的 `控制台已就绪：http://127.0.0.1:<端口>`。
4. 浏览器打开 `http://127.0.0.1:<端口>`。
5. 如果 `config.json` 里配了 `server.token`，首次用 `http://127.0.0.1:<端口>/?token=<token>` 打开；之后同一标签页不用再带。
6. `Ctrl+C` 停止。

---

## 6. 前置条件

- Node.js ≥ 22.12.0、pnpm ≥ 12.0.0（`package.json` 的 `engines`，`packageManager` 锁到 `pnpm@12.14.0`）。
- 协议端二选一：SnowLuma 或 NapCat，两者默认都开 OneBot v11 的 WS 3001 / HTTP 3000，装好即连。本项目不分发、不启动协议端。安装与登录步骤见 [README](../README.md) 的「安装与使用」第 1 步。
- 首次 `pnpm install` 会下载 Electron 二进制（约 238 MB）；国内网络慢可先设 `ELECTRON_MIRROR`，写法见 README。

---

## 7. 常见故障

| 现象 | 根因 | 解法 |
|---|---|---|
| 双击没反应；进程起来又没了，无窗口、无端口、`data/logs` 里什么都没有 | 数据目录不可写。`electron/main.js` 的 `probeDataDirWritable` 列了四类成因：装进了 `Program Files` 等受保护目录；安装目录在 OneDrive / 坚果云的「仅在线」位置；杀软或企业管控把目录设成只读；`data` 被一个同名文件占住 | 看弹出的原生错误框和 `%APPDATA%\qq-agent\data-dir-error.log`，按提示换目录或解除只读。这是环境问题，不是程序坏了 |
| 双击后弹「QQ Agent 已经在运行了」 | 单实例锁：已有实例占着同一个数据目录，或 Electron 单实例锁已被占 | 从托盘图标唤出/退出已有实例；要多开见第 4 节 |
| 白屏、闪退、显卡相关崩溃 | GPU 渲染链路异常。应用在 60 秒内崩 3 次会自动写 `data/render-gpu-off.flag` 并重启进软件模式 | 删掉 `data/render-gpu-off.flag` 恢复 GPU；排障时可临时设 `QQ_AGENT_ENABLE_GPU=1` / `QQ_AGENT_DISABLE_GPU=1` |
| 装好的内置插件/技能突然整个不工作，开关还开着 | 改过 `plugins/` 或 `skills/` 下的文件但没重算 `builtin-modules.json`，指纹失配后掉进能力扫描被拒载 | 按 [skill-system.md 第 6 节](extend_development/skill-system.md) 重算基线，再跑测试。控制台「插件」「技能」页会写明加载失败的原因 |
| 控制台打不开，日志里是 `EADDRINUSE` | 基准端口起连续 10 个端口都被占 | 改 `config.json` 的 `server.port`，或换 profile（第 4 节）。实际端口始终看 `console-port` |
| 「机器人工作中」一直不亮 | 协议端没起、端口对不上、或访问令牌不一致。`/api/status` 的 `onebot.diagnosis` 会直接说缺什么 | 先确认协议端在跑且开了 WS 3001；再核对「工具 → 连接」页的地址与令牌，改完「保存并重连」即可生效，不用重启 |
| headless 跑完发现仓库根多出 `plugin-data/`，自检报告在界面上看不到 | 旧版本的数据目录在 env 为空时回落到进程 cwd。现已统一走 `src/config.js` 的 `DATA_DIR`（按模块位置锚定，不看 cwd，profile 也一并正确） | 升级到含该修复的版本；确认 `data/plugin-data/` 才是界面读的那份 |
| 网页模式终端里什么都没有 | 0.5.0.0 及更早版本的 `createApp` 把日志监听器闭包与形参 `log` 共享绑定，改指 `appLog` 后形成自指、被 logger 重入防护静默丢弃，终端与 Electron console 都收不到，只有日志文件有 | 升级到含该修复的版本；期间临时看 `<数据目录>/logs/qq-agent-<日期>.log` 或控制台「工具 → 连接 → 应用日志」 |
| 浏览器里「显示 API Key」「协议端控制台密码」读不出来 | 明文密钥端点只认 Electron 注入的渲染凭据或自配的 `server.token`；`server.allowBrowserKeyRead` 默认关 | 配 `server.token` 并用 `?token=` 打开（第 1.1 节），不要为了省事去打开 `allowBrowserKeyRead` |

---

## 8. 测试

```bash
pnpm test                                  # 等价于 pnpm run check
node --test tests/volatile-contract.test.mjs   # 只跑一个文件
```

测试用 Node 内置的 `node:test` + `node:assert/strict`，没有测试框架依赖。改动提示词组装前先读 `tests/volatile-contract.test.mjs`，它钉住了前缀缓存的段落顺序契约。

---

## 相关文档

| 文档 | 内容 |
|---|---|
| [README](../README.md) | 功能一览、安装、协议端接入、首次配置 |
| [CHANGELOG](../CHANGELOG.md) | 各版本面向用户的变更与修复根因 |
| [doc/extend_development/skill-system.md](extend_development/skill-system.md) | 扩展加载流水线、能力机制、指纹基线 |
| [doc/extend_development/onebot-capabilities.md](extend_development/onebot-capabilities.md) | 连接排查与 `api.qqCall` 能调什么 |
