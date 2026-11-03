# 操作 QQ 本身（OneBot v11 能力层）

> 需要**读取群成员、取消息、转存图片、发戳一戳**这类"动 QQ 自己"的能力时读这一份。
> API 完整参考见 [skill-reference.md](skill-reference.md)。

---

## 1. 协议端是什么（由用户自装）

QQ Agent 自己是纯 OneBot v11 客户端，不登录 QQ、也不附带协议端。真正登录 QQ 并对外
暴露 OneBot v11 协议的是协议端，二选一，由用户自行安装运行：

| 协议端 | 说明 |
|---|---|
| SnowLuma | 第三方项目，自带 EULA（其许可禁止并入第三方安装包，所以本软件不分发） |
| NapCat | 开源协议端，从官方仓库获取 |

两者默认端口一致，核心代码不用区分：

- WebSocket 只收事件（消息、撤回…）
- HTTP API 负责动作（`POST httpUrl/<action>`）

核心通过 `src/onebot.js` 连它，配置项在 `config.protocol`：

```js
config.protocol = {
  wsUrl: 'ws://127.0.0.1:3001',       // 收事件
  httpUrl: 'http://127.0.0.1:3000',   // 发动作
  accessToken: '',                    // WS 令牌
  httpAccessToken: ''                 // HTTP 令牌（留空沿用 accessToken）
}
```

`QQ_AGENT_PROFILE=N` 时默认端口偏移为 N×100（WS 3001 + N×100 / HTTP 3000 + N×100），已有配置优先；仍需在协议端配置相应端口，见 [运行方式与部署第 4 节](../running.md#4-多实例)。

---

## 2. 怎么获得调用权：`permissions: ["qq_sticker"]`

```jsonc
// skill.json / plugin.json
{
  "id": "my-plugin",
  "permissions": ["qq_sticker"],
  ...
}
```

然后：

```js
const info = await api.qqCall('get_login_info');
```

不声明会怎样：`api.qqCall` 存在，但永远 reject，错误消息是
`Skill <id> 未声明 qq_sticker 权限`。

⚠️ 名字有历史包袱：这个权限叫 `qq_sticker`（因为最早只给表情系统用），
但它实际放行的是整个 `api.qqCall` 通道，不限于表情。
`permissions` 里目前只有两个值有意义：`web_fetch` 和 `qq_sticker`（`src/plugin-loader.js` 的 `createSkillApi`）。
写别的名字没有任何效果，也不报错，只会表现为"fetch / qqCall 一直失败"。

---

## 3. `api.qqCall` 的调用约定

```js
api.qqCall(action, params = {})   // => Promise<any>
```

- 内部就是 `onebotClient.call(action, params)` → `POST {httpUrl}/{action}`。
- 协议端返回 `retcode !== 0` 会抛错（`src/onebot.js` 的 `call`），所以业务判断要用 try/catch，
  不要自己去看 retcode。
- OneBot 客户端还没初始化时 reject：`OneBot 客户端尚未初始化`。

### 超时：按 action 分档

| action 形态 | 超时 |
|---|---|
| 查询类（`get_*` 等） | 15 秒 |
| 发送类：匹配 `/^(send_(group\|private)\|upload_\|_send)/i` | 90 秒 |

> 原来一律 15 秒。查询类够用，但发送类不够：图片/视频以 base64 或大 body 发出去时，
> 协议端要走完"接收 body → 解码 → 上传腾讯服务器 → 返回"，实测 1.9MB 的图稳定超时
> （表现是"图画出来了但发不出去"）。而超时抛的是 `fetch failed`，用户完全看不懂。
> （`src/onebot.js` 的 `call` 原注释）

网络层失败时，`src/onebot.js` 会把 `error.cause` 链挖出来再抛，所以错误消息里通常能看
到真实原因，别只看开头那句 `fetch failed`。

---

## 4. 能力清单（按实际使用分类）

### 4.1 本项目代码**实际在调**的（已验证可用）

| action | 用途 | 谁在用 |
|---|---|---|
| `get_login_info` | 取机器人自己的 uin / 昵称 | `onebot.js` 的 `connect` / `#selfInfoTimer`，`app.js` 的 WS 就绪兜底 |
| `get_msg` | 按消息 id 取一条消息 | `onebot.js` 的 `getMsg` |
| `get_forward_msg` | 展开合并转发 | `onebot.js` 的 `fetchForwardNodes`、`tools.js` 的 `read_forward` |
| `get_group_info` | 群信息 | `onebot.js` 的 `getGroupInfo` |
| `get_group_member_info` | 单个群成员信息 | `onebot.js` 的 `getGroupMemberInfo`、`orchestrator.js` 的群名片与禁言判定 |
| `get_group_member_list` | 群成员列表 | `routes.js` 的 `/api/groups/:id/members` |
| `get_group_list` | 群列表 | `routes.js` 的 `/api/onebot/groups` |
| `get_friend_list` | 好友列表 | `routes.js` 的 `/api/onebot/friends` |
| `get_image` | 把图片 file 转成本地文件 / 地址 | `routes.js` 的 `/api/media-data`、`sender.js` 的表情缓存回退、表情系统 |
| `send_group_msg` | 发群消息 | `onebot.js` 的 `sendSegments` |
| `send_private_msg` | 发私聊消息 | `onebot.js` 的 `sendSegments` |
| `group_poke` / `friend_poke` / `send_poke` | 戳一戳 | `onebot.js` 的 `sendPoke` |
| `fetch_custom_face_detail` | 同步 QQ 收藏表情明细 | 表情系统（`plugins/sticker/lib/manager.js`） |

### 4.2 协议上应该有，但本仓库没有代码路径（未验证）

`api.qqCall` 是协议透传：协议端支持什么它就能调什么，不受我们这边的白名单限制。
但下列 action 在本项目里 grep 不到调用点，也就是说没人验证过它们在你这个版本上可用：

| action | 常见用途 |
|---|---|
| `set_group_ban` | 禁言单个成员 |
| `set_group_whole_ban` | 全员禁言 |
| `delete_msg` | 撤回消息 |
| `upload_group_file` / `upload_private_file` | 发文件到群/私聊 |
| `set_group_card` | 改群名片 |
| `set_group_name` | 改群名 |
| `send_group_forward_msg` | 发合并转发 |
| `get_group_honor_info` | 群荣誉 |
| `get_stranger_info` | 陌生人资料 |

要用这些，自己试一下并加 try/catch，别假设它们和 4.1 一样可靠。

> ⚠️ 控制台里的「自己造个扩展」引导（`ui/app/09-community.js`）提到过"查群成员、禁言、发文件"。
> 其中只有"查群成员"有代码路径，"禁言 / 发文件"在本仓库里没有对应实现。

### 4.3 发消息：别自己调 `send_*_msg`

需要主动发言时，优先用 hook 上下文里给的 `ctx.send` / `ctx.sendSegments`
（见 [skill-reference.md 第 10 节](skill-reference.md#10-hooks-全表)）。
它们会走完整的发送链路（分段、重试、@ 处理、图片转存）。

同理，发表情走 `ctx.sender.sendSticker`，不需要 `qqCall`
（`src/plugin-loader.js` 的 `createSkillApi`）。发送操作应走上述队列；`qqCall` 适合查询或队列未封装的协议动作，其权限并不只读（见第 5 节）。

---

## 5. 权限与安全的边界

- 唯一闸门是 `permissions: ["qq_sticker"]`。通过了之后，`api.qqCall` 可以调
  任意 OneBot action，包括 4.2 里那些能改群状态、改名片、撤回消息的。
  我们这边没有第二层白名单。
- 所以给第三方插件加这个权限要慎重：拿到它等于拿到了这台机器上那个 QQ 的操作权。
- 第三方插件本身仍受准入闸约束（不能 `import node:fs` 等），见
  [skill-system.md 第 6 节](skill-system.md#6-安全边界两层别混淆)。

---

## 6. 排障

| 现象 | 原因 |
|---|---|
| `Skill <id> 未声明 qq_sticker 权限` | 没写 `permissions`，或拼写不对 |
| `OneBot 客户端尚未初始化` | 核心还没连上协议端（应用刚启动时正常） |
| `fetch failed: …`（带 cause） | 看 cause 链里的真实原因，别只信开头 |
| 发大图超时 | 走的是发送类 90s；还是超时说明图太大或协议端慢 |
| `retcode !== 0` 抛错 | 协议端业务失败，错误消息里通常有中文原因 |
| 群成员列表是空的 | 该群不在机器人所在的群里 |
| 所有动作都连不上 | 协议端没运行 / 端口不对 / 令牌不一致，看「工具 → 连接」页 |

调试：控制台的「工具 → 连接」页能看到端点、端口是否监听、机器人是否连上、以及
应用日志；协议端自己的日志在它的控制台里（SnowLuma 控制台 / NapCat WebUI）。

---

## 相关文档

- [skill-reference.md](skill-reference.md)：完整 API 参考（`api.qqCall` 之外的全部接口）
- [skill-development.md](skill-development.md)：LLM 型（技能）开发规范
- [plugin-development.md](plugin-development.md)：确定性型（插件）开发规范
- [skill-system.md](skill-system.md)：架构总览、加载流水线、安全边界
