# QQ Agent（桌面端）

![平台](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux%20%7C%20Electron-lightgrey)
![技术栈](https://img.shields.io/badge/stack-Node.js%20%7C%20原生前端-orange)
![测试](https://img.shields.io/badge/tests-122%20cases-brightgreen)

一个跑在自己电脑上的 QQ 群聊机器人：装完双击启动，扫码登录，填个模型 Key 就能用。
事件驱动 + 无状态会话，每次处理的 token 成本恒定；所有操作都在图形控制台里完成。

从 [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge) 改造而来。

## 能实现什么

- **像真人一样混群**：被 @ 或被叫到时回话，平时看心情插嘴。会发文字、表情包、戳一戳，会引用、会 @ 人，知道什么时候该闭嘴
- **记住每个群友**：双向长期记忆，记得谁是什么风格、爱什么梗、雷点是什么；记忆页随时可查看、手动编辑
- **看得懂图、上得了网**：视觉模型直接看消息里的图片；内置 6 家搜索服务（含免 Key 的 Bing 网页解析），还能加任意兼容搜索服务
- **花多少看多少**：每次调用的 token 和成本精确记录，按天 / 按会话 / 按模型统计，缓存命中率、峰谷分时计价、图片计费口径都标清楚
- **零编程门槛**：白名单从 QQ 里直接勾选群，模型从目录里点选切换，不用查群号、不用写配置

## 技术架构

**事件驱动 + 无状态会话**

1. 群聊消息持续写入本地 JSON 存档，每条带时间与已读状态
2. 每次有新消息（或主动机会）就新开一个独立会话：提示词 = 静态系统提示（人设/规则/策略）+ 存档摘要 + 本次新消息
3. 会话结束即弃置，LLM 层面零历史，一次处理的成本是恒定小份，不随聊天量膨胀
4. 处理期间新来的消息只写存档；本次结束后发现未读，自动再开新会话，直到清空
5. 长期信息走记忆工具持久化，跨运行生效

**整体组成**

- **协议端**：通过 OneBot v11（正向 WebSocket 收事件 + HTTP 发动作）接 QQ。协议端由用户自行安装，**SnowLuma 或 NapCat 任选其一**，两者默认端口一致（WS 3001 / HTTP 3000）。本项目只做客户端，不分发、不启动协议端
- **大脑**：任意 OpenAI 兼容 API，官方 / 中转站 / 本地网关均可，模型在设置里自选
- **桌面壳**：Electron，托盘常驻、开机自启、关窗不退出、端口被占自动让位
- **控制台**：零框架原生 HTML/CSS/JS，明暗双主题 + 跟随系统，带完整设计 token 体系
- **安全边界**：工具天然绑定会话（模型无法把消息发到别的群）、发送白名单 + 限频、联网抓取带 SSRF 防护（DNS 校验 / IP 固定 / 手动跟重定向）、图片地址禁内网

## 设置项都能做什么

**模型 API**

- 多提供商模型目录：填 Base URL + Key，点「获取列表」自动拉模型，选中即切换；中转站返回几百个模型时内置搜索 + 厂商/模型双栏
- 一键测试：发个 ping 立刻验证地址/Key/模型通不通，显示延迟
- 成本核算：内置 140 个模型的官方价格表自动匹配；走中转站可关掉官方价自填单价，支持「渠道：模型」两级定价、峰谷分时、图片计费规则提示
- 视觉开关：模型不支持图片时关掉，看图工具自动从提示词移除

**聊天设置**

- **响应档位滑条**（省 token 核心）：0~100 无级调节。1 档仅 @ 响应、2 档 +关键词、3 档按概率随机响应（滑条位置线性决定概率）、4 档全响应；没命中的消息直接标已读，零 token 消耗。触发原因决定上下文条数：被 @ 时永远带最多上下文
- **表情包积极程度** 0~3 档：不鼓励 / 偶尔 / 较积极 / 表情包爱好者（提示词层面引导，不强制）
- 人设系统：内置「小鲸鱼」角色卡开箱即用，多套模板一键填充可改；参与度风格（安静/普通/活跃）可调
- 关键词、每群独立开关、私聊开关、屏蔽名单（被屏蔽者不存档、不触发、不进提示词）

**记忆**

- 自动记录对群友的长期印象；可手动触发整理（合并重复、删过时），或对单个群友「更新记忆」

**搜索服务**

- 6 家内置（Bing 免 Key / DeepSeek / 智谱 / 博查 / 百度千帆 / 秘塔）+ 自定义添加任意兼容服务，可加多个

**白名单**

- 从 QQ 账号拉群列表/好友列表直接勾选；机器人只对名单内的会话工作

**桌面端**

- 托盘常驻 / 开机自启 / 关窗不退出；明暗主题；版本更新检查（默认关闭，配 `config.update.feedUrl` 后可用）

**桌宠（内置）**

- Live2D 桌面伙伴（插件 `desktop-pet`，PixiJS + Cubism Core）。随包带 DS鼠控版 默认模型（8 个动作组 / 44 个表情），控制台「桌宠」页可导入 Cubism 4 模型（自动读动作组与表情），支持置顶/穿透/缩放/透明度、待机动作与表情
- 交互：单击弹「今日用量」卡片（今日 N 次运行 · X tok · 缓存 Y% · ¥Z，下面一行「搜索：N 次」，16 秒自动收起，期间每 5 秒刷新）；双击打开开发工单对话窗（由内置模块 `dev-orders` 提供，不可禁用）
- 模型放在 `data/desktop-pet/models/<模型 id>/`，导入走插件真实链路 `service.importModel`。运行时导入会被 5 秒一次的状态落盘覆盖，导入前先完整退出应用
- 依赖 GPU 渲染。显卡驱动异常导致白屏/崩溃时，按 [doc/running.md](doc/running.md) 第 7 节的显卡条目处理

**OneBot**

- 协议端地址可改，适配任何 OneBot v11 实现

**外链**

- 页面里的链接（金句墙 / 意见墙 / 更新提示 / 模型输出里的网址）交给系统浏览器前要过四道判据：协议只放 http(s)、拒绝带 userinfo 的 URL（`https://trusted@evil.com` 这类钓鱼形态）、本机地址不外开、主机需在白名单内（官网 / GitHub / 各供应商后台）
- 被拦时只在日志里留一行，界面上就是"点了没反应"，这是刻意的默认拒绝。自建文档站之类的额外域名加 `config.security.externalHosts`（写裸域名，子域自动放行）

## 界面一览

- **会话**：每次处理一个会话卡片，完整留档：提示词、思考、工具调用与结果、实际发出的每条消息、用量；运行中实时刷新
- **存档**：每个群/好友的消息库，未读标记一目了然；可手动唤醒一次处理或全部标已读
- **记忆**：每个群友一份档案，可编辑、删除、单独更新
- **用量**：三维度统计 + 下钻明细 + 调用次数明细（每个扩展的工具按类别分组的趣味统计）
- **设置**：以上所有

## 扩展（两型：插件 / 技能）

扩展分两型，按"什么时候该运行"来选，放进对应目录即生效：

| 类型 | 放哪 | 靠什么生效 | 谁决定何时执行 |
|---|---|---|---|
| **确定性型（插件）** | `plugins/<id>/` | 能力 `providers` / 钩子 `hooks` | **核心代码**：满足条件必然执行，不经过 LLM |
| **LLM 型（技能）** | `skills/<id>/` | 工具 `registerTool` + 提示词片段 | **模型**：看工具说明自己判断 |

```
plugins/my-plugin/            skills/my-skill/
  plugin.json  清单              skill.json   清单
  index.js     providers/hooks   index.js     registerTool
```

判据一句话：规则能写死就做插件（`plugins/`），要理解人话就做技能（`skills/`）。

选错类型的后果是功能静默失效：不报错、不崩、就是没反应。所以两份开发文档请先读：

- **确定性型** → [doc/extend_development/plugin-development.md](doc/extend_development/plugin-development.md)
- **LLM 型** → [doc/extend_development/skill-development.md](doc/extend_development/skill-development.md)
- 共同机制完整参考 → [doc/extend_development/skill-reference.md](doc/extend_development/skill-reference.md)
- 插件往控制台放自己的界面 → [doc/extend_development/panel-ui-contract.md](doc/extend_development/panel-ui-contract.md)

其它约定：

- 开关只有一处：`config.skills[id].enabled`。关掉一个扩展，它注册的工具、提供的能力、提示词片段、请求改写会同时失效，不会出现"界面关了但还在偷偷工作"
- 按能力依赖，不按名字：核心代码问"谁提供 `llm.request-params`"，不 import 具体扩展，所以换实现不用改核心代码
- 扩展的提示词片段优先级被强制压在核心规则之下，覆盖不了安全规则
- 状态可解释：控制台的「技能」与「插件」两个页签各自直接告诉你为什么某项没生效（未启用 / 依赖缺失 / 加载失败 / 模型不支持），不是笼统的"工具关闭"
- 两种清单文件功能等价：`plugin.json` 与 `skill.json` 走同一条规范化流程，目录只决定语义分类，不限制能用哪些特性
- 插件可以自带界面：在 `configSchema` 里写一条 `type: "action"`（`panel` 指向插件目录里的 `.html`），设置弹窗就多出一颗按钮，点开是只读 iframe，不用改宿主 UI 代码
- 内置示例：`speaker-identity`（身份标注）、`thinking-adapters`（思考参数方言适配）为确定性型；`calculator`、`memory-recall` 为 LLM 型
- 热重载默认开启：目录放进去就生效，无需重启（`config.extensions.hotReload` 可关；等价于"任意落地的 JS 会被执行"，共享机器建议关掉）
- 架构总览见 [doc/extend_development/skill-system.md](doc/extend_development/skill-system.md)

## 安装与使用

### 下载安装包

| 平台 | 产物 | 安装方式 |
|---|---|---|
| Windows | `.exe`（安装版）/ `.zip`（免安装） | 双击安装；zip 解压即用 |
| macOS | `.dmg` / `.zip`（arm64 与 x64 各一份） | 打开 dmg 把应用拖进「应用程序」；zip 解压后拖入 |
| Linux | `.AppImage` / `.deb` | AppImage：`chmod +x` 后直接运行；deb：`sudo apt install ./qq-agent_*.deb` |

macOS 与 Linux 的产物**未经 Apple 公证**，首次打开会被系统拦一下：

- **macOS**：提示「无法验证开发者」时，在 Finder 里右键应用 →「打开」，或执行
  `xattr -dr com.apple.quarantine "/Applications/qq-agent.app"`
- **Linux AppImage**：先 `chmod +x qq-agent-*.AppImage` 再双击/运行。若报
  `dlopen(): error loading libfuse.so.2`，装一下运行时：Debian/Ubuntu 用
  `sudo apt install libfuse2`（Ubuntu 24.04+ 是 `libfuse2t64`），Fedora 用
  `sudo dnf install fuse-libs`

数据目录：Windows 在安装目录旁的 `data/`；macOS 在 `~/Library/Application Support/qq-agent/data/`；
Linux 在 `~/.config/qq-agent/data/`。多实例后缀 `data-<N>` 三个平台一致。

### 从源码运行

```bash
git clone https://github.com/awsl1414/qq-agent.git
cd qq-agent
pnpm install
pnpm start
```

1. **装协议端**（必做，二选一）：
   - **SnowLuma**：独立第三方项目，自带 EULA，其许可**禁止**把它的原生组件并入第三方安装包、也禁止用脚本自动部署。所以本项目**不附带、不下载、不启动**它。请从 <https://github.com/SnowLuma/SnowLuma> 获取并安装，启动后打开控制台 <http://localhost:5099>（初始账号 `admin`，密码见启动日志），按引导把 QQ 接进来，再登录机器人号。
   - **NapCat**：开源协议端，从 <https://github.com/NapNeko/NapCatQQ> 获取。启动后打开控制台 <http://127.0.0.1:6099/webui>（首次启动的日志里会打印带 token 的完整地址），登录机器人号后进「网络配置」建服务。

   两者默认都会开 OneBot v11：**WS 3001 / HTTP 3000**，与程序默认值一致，装好即连。在协议端里登录**机器人专用小号**，别用日常号。

2. **启动**：`pnpm start`。连上协议端后，「工具 → 连接」页会显示「机器人工作中」。
3. **配置**：设置页顶部体检卡会告诉你缺什么：填接口地址和 Key、选模型、勾白名单。

> 换了协议端端口或加了令牌？在「工具 → 连接」页的「端点设置」里改，点「保存并重连」立刻生效，不用重启。设置页「连接 QQ」里也有同样的四个字段。

### 常用命令

本项目只用 pnpm 管理依赖（`packageManager` 字段锁定版本，`node_modules` 为 pnpm 的 isolated 布局）。`npm` / `yarn` 不在支持范围内。

```bash
pnpm install         # 装依赖（含 electron）
pnpm start           # 桌面端启动
pnpm run server      # headless 模式：浏览器打开 http://127.0.0.1:3210（实际端口见 data/console-port）
pnpm test            # 全量测试（等价于 pnpm run check）

pnpm run build:mac       # 打 macOS 包（dmg + zip，arm64 与 x64）
pnpm run build:linux     # 打 Linux 包（AppImage + deb，x64）
pnpm run build           # 打 Windows 包（NSIS 安装包 + zip）
```

打包目标必须在对应平台上构建：mac 包只能在 macOS 上出，Linux 包只能在 Linux 上出。
只想验证配置能不能产出可运行的应用时用 `build:mac:dir` / `build:linux:dir` / `build:dir`，
它们只解包、不生成安装包，快很多。

环境变量、网页模式的鉴权与端口规则、数据目录、多实例、常见故障，见 **[doc/running.md](doc/running.md)**。

备份内容、本地目录 / WebDAV / S3 目标、加密限制与恢复流程，见 **[备份与恢复](doc/backup.md)**。

> 首次 `pnpm install` 会下载 Electron 二进制（约 238 MB）。国内网络慢的话先设镜像：
> `$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"`（PowerShell）
> 或 `export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`（bash）。

### 风险与免责声明

- 本项目通过非官方方式接入 QQ 协议，**账号存在被风控/封禁的风险**，建议使用小号
- SnowLuma 是独立第三方项目，受其自身 EULA 约束。本项目不分发其代码、不自动部署，只按 OneBot v11 协议连接用户自行运行的协议端
- 用户自行承担使用本项目的所有风险

## 致谢与出处

本项目基于前人的工作，一并致谢：

- **[Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge)**：最初的改造来源，"仿真群友"的思路是这一切的起点
- **[Kondius/qq-agent](https://github.com/Kondius/qq-agent)**：本仓库 fork 自该项目（上游当时称「洛版」），大部分代码由上游作者 Kondius 编写
- **SnowLuma** / **NapCat**：QQ 协议端（OneBot v11）提供者，各自独立、各自受自身许可约束

本仓库由 fork 者独立维护，与上游项目无隶属关系。

## 社区与反馈

上游项目建立的社区渠道仍然有效，内容与用户都在那里：

| 渠道 | 地址 | 用途 |
|---|---|---|
| 官网 | <https://kondius.cn/qq-agent> | 项目主页、下载 |
| 意见箱 | <https://kondius.cn/qq-agent/comments> | 提交意见与建议（应用内「意见收集」直传此处） |
| 金句墙 | <https://kondius.cn/qq-agent/holyshits> | 收录机器人的精彩发言（应用内「金句上传」直传此处） |
| Skill 市场 | <https://www.kondius.cn/qq-agent/skill-market/> | 技能分享与安装 |
| 插件市场 | <https://www.kondius.cn/qq-agent/plugin-market/> | 插件分享与安装 |
| 人设广场 | <https://www.kondius.cn/qq-agent/persona-plaza/> | 人设与系统提示词分享 |
| 作者博客 | <https://kondius.cn> | 上游作者 Kondius 的站点 |

> 应用内「意见收集 / 金句上传 / 三个市场按钮」均指向上述地址。这些服务由上游维护，本仓库不控制其可用性。

## 许可

本项目以 MIT 许可发布（见 [LICENSE](LICENSE)）。协议端（SnowLuma / NapCat）是独立项目，不随本项目分发，受其自身许可约束，不受本项目许可覆盖。

---

有点忘了为什么要开发这个了。本来就是看见一个 QQ 机器人项目，自己去搭一个拿来玩，没想到效果确实不错，于是想到一些能省成本的做法就做了，效果至少还不错。

改完发现省得特别多，就拿到评论区装了个大 b（笑）。当时想着把用过的痕迹删干净就能发出去给大伙用。但插眼的人有点多，做得太糊弄也不太好，就多做了点东西。关注的人一直在涨，也真有人提意见，做着做着就越来越膨胀了。实际上核心功能还是那么一个机器人，说实话，原来那个项目的提示词写得是真好，没这个效果我大概率用两天就扔了。

现在加了个意见收集和金句上传，其实是有点想做成社区。独乐乐不如众乐乐，这种东西大家一起玩才好玩，让大家都看看肥鱼都会说些什么骚话（或者情话，谁知道）。

最近确实一直通宵坐在这边搞，一天去掉睡觉时间基本都在做这个。做自己要用的东西确实不累，再加上一想到有很多人会用，也许他们也会觉得大肥鱼很有趣（至少我的朋友都觉得……吧），那至少我也做了一份贡献，也会有很多源源不断的灵感。再加上现在长期无业，求职也相当失败，确实需要这么一个东西来让我感觉我暂时还"处于一种有用的活着的状态"。

于是 QQ-agent 诞生了。以后也会有更多版本，只要我的灵感和大家的灵感还在。

我爱你们。
