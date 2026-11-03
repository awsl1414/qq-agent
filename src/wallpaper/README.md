# 内置壁纸模块（src/wallpaper/）

由「QQ-Agent壁纸套件-交接包」内置化。按用户要求不进插件：原 4 个独立
插件/技能合并为一个 core 模块，走 `src/harness/index.js` 的内置注册机制
（`kind:'core'`）：不走插件目录扫描、不进 `builtin-modules.json` 基线、不出现在
插件/Skill 列表、不可禁用。改本目录任何文件都要重启应用才生效（core 模块不热重载）。

## 默认只是"软件自带功能"，不进对话

`core` + `theme` 永远生效（控制台壁纸页、背景跟随）；`chat`/`engine` 的 8 个工具与
2 段提示词默认不注册（`config.skills.wallpaper.llmControl === false`）。

原因：它们每轮固定消耗约 1358 tok（提示词 1021 字符 ≈ 406 tok + 8 个工具定义
≈ 952 tok），而内容与工具 description 高度重复，实测 7 天 56 次调用中聊天侧工具
调用 0 次。要恢复群聊控制，在控制台「壁纸」页底部勾选「聊天里可控制壁纸」并重启。

## 四部分

| 文件 | 职责 | 暴露 |
| --- | --- | --- |
| `core.js` | 壁纸库扫描（创意工坊/我的项目）、文件伺服、状态镜像、动态壁纸导入（场景录屏/视频无缝循环） | 7 个能力 `wallpaper.library/file/state.*/import.*` |
| `theme.js` | 主题跟随：每 `intervalSec` 秒读小红车当前壁纸 → 复制预览进 `data/ui/` → 写 `config.ui.bgImage`（<720px 写 `bgSoften` 让前端柔化） | 能力 `wallpaper.theme-sync` + activate/deactivate/dispose 定时器 |
| `chat.js` | 「壁纸管家」：QQ 聊天里换/调/关/查控制台壁纸，白名单门禁（空=上锁） | 工具 `wallpaper__set/adjust/off/list`（仅 `llmControl`） |
| `engine.js` | 「小红车」：QQ 聊天里换/控桌面壁纸（WE `-control` 命令行通道） | 工具 `wallpaper__wallpaper_list/set/control/theme`（仅 `llmControl`）+ 能力 `wallpaper.apply`（恒在） |
| `lib/` | 动态壁纸管线：`exec/deps`（ffmpeg 探测）、`loop`（交叉淡化无缝循环）、`we`（场景渲染窗+录屏）、`sceneimport`（导入编排+LRU 缓存） | core.js 专用 |
| `we-control.js` | 桌面侧控制层：安装探测、壁纸库扫描、当前壁纸解析、`-control` 动作表 | engine.js 专用 |

`index.js` 是合并入口：拼齐 `providers`、逐个 try 地 `setup`（关闭对话侧时给
chat/engine 传一个 `registerTool` 空实现的 api，工具不登记、能力照旧）、转接 theme
的生命周期、导出 `promptSections`（默认返回 `[]`）。

## 设置（config.skills.wallpaper，控制台「壁纸」页底部可改）

`wallpaperEngineDir`/`executable`（WE 目录，留空自动探测）、`whitelist`（管家白名单）、
`llmControl`（是否把 8 个工具 + 2 段提示词给模型，默认 false，改了要重启）、
`follow`/`allowMature`/`intervalSec`/`softenSmall`（主题跟随）、
`sendPreview`/`previewRating`/`maxList`/`cacheSeconds`（桌面侧）。
默认值见 `plugin.json` 的 `settings`；`settingsOf('wallpaper')` 与用户配置深合并。

## 界面侧（ui/app/）

`14-wallpaper.js`（壁纸页+全局背景引擎+莫奈取色）、`20-glass.js`（全界面玻璃层，
一条 `panelAlpha` 滑条驱动主题令牌）、`vendor-md3.js`（MD3 取色算子，须在 14 之前加载）。
`ui/index.html` 顶栏第 5 项「壁纸」；路由 `/api/wallpaper/{list,file,state,import}`
在 `src/routes.js` 末尾，能力中介模式。

## 验证

- `tests/wallpaper-module.test.mjs`（8 例：能力面/工具注册/提示词段工具名一致性/白名单门禁/降级路径/生命周期）
- GPU：默认开（视频壁纸需要），崩溃回退写 `data/render-gpu-off.flag`；删掉这个文件即恢复

## 已知限制

- 升级宿主（`routes.js` / `style.css` / `index.html`）时冲突概率最高
- 市场页（人设广场/插件市场/Skill 市场）是独立窗口，没有壁纸层
- 多实例（`QQ_AGENT_PROFILE`）下 GPU flag 落在默认 `data/`（自洽但不在 profile 目录）
