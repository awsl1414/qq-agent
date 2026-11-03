# 插件界面契约（把「自己的页面」放进控制台）

> 适用：`plugins/<id>/` 与 `skills/<id>/` 两型扩展**通用**。
> 唯一实现：`src/skills/panel.js`。改规则只改这一处。

---

## 0. 一句话

在清单的 `configSchema` 里写一条 `type: "action"`，设置弹窗就多出一颗按钮；
点开是 iframe，内容是插件目录里的那个 `.html`。

```jsonc
// plugins/my-plugin/plugin.json
{
  "configSchema": {
    "viewer": {
      "type": "action",
      "label": "我的面板",
      "button": "打开面板",
      "panel": "panel/viewer.html",
      "description": "打开一个只读的查看器"
    }
  }
}
```

```
plugins/my-plugin/
  plugin.json          清单（上面的 configSchema）
  index.js             逻辑
  panel/
    viewer.html        ← 入口页，必须是 .html
    viewer.css
    viewer.js
```

**不需要改宿主 UI 代码。** 不用注册组件、不用 import 什么、不用动 `ui/`。

---

## 1. 为什么入口声明在 `configSchema` 里

因为它**长在设置弹窗里**，和开关、下拉框是同一张表单的一部分。放在一起，插件作者
的心智负担最小：写一条，界面上就出现一颗按钮。

代价是 `configSchema` 因此混了两种东西：**配置项**（要存值）和**界面入口**（不用存值）。
所以加载期会做一次拆分（`src/skills/manifest.js` 的 `normalizeManifest`）：

| 产物 | 内容 | 谁消费 |
|---|---|---|
| `manifest.configSchema` | **只含配置项**（action 已被摘掉） | 保存循环、「共 N 项设置」计数 |
| `manifest.panels` | 界面入口，已校验 + URL 已算好 | 设置弹层的「界面」区块 |

拆分的意义：action 不会变成一个不存在的配置键被写进 `config.skills[id]`，
也不会被算进「共 N 项设置」，保存循环不用再手动减一。

---

## 2. 声明规则

### 2.1 字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `type` | ✅ | 固定 `"action"`。这是**判据**：有它就当界面入口。 |
| `panel` | ✅ | 入口页路径，相对插件目录，**必须是 `.html`** |
| `label` | | 显示名。缺省取 configSchema 的键名 |
| `button` | | 按钮文字。缺省 `"打开"` |
| `description` | | 按钮下方的一行说明 |
| `icon` | | 显示在 label 前的小图标（文本，如 emoji） |

写**其它字段**会被记进 `manifest.problems` 并忽略，不会静默吃掉。
（静默忽略最难查，所以宁可吵一点。）

### 2.2 上限

- 一个扩展最多 **8** 个入口（`PANEL_MAX_ENTRIES`）。多的忽略并记 problem。
- `panel` 路径最长 **180** 字符（`PANEL_PATH_MAX`）。

### 2.3 `panel` 路径的硬规则

全部由 `normalizePanelPath()` 执行，**非法即拒绝**，拒绝原因直接显示在按钮位置上
（就地换成一红字「打不开：<原因>」，**不会给一颗点了没反应的死按钮**）。

| 写法 | 结果 | 原因 |
|---|---|---|
| `panel/viewer.html` | ✅ | — |
| `viewer.html` | ✅ | 根目录下也可以 |
| `  panel/a.html  ` | ✅ | 两端空白自动裁掉 |
| `/panel/a.html` | ❌ | 不能以 `/` 开头 |
| `C:\x\a.html` | ❌ | 不能带盘符 |
| `panel\a.html` | ❌ | 必须用 `/`，不接受反斜杠 |
| `../outside.html` | ❌ | 不能含 `..` |
| `panel//a.html` | ❌ | 不能含空段 |
| `panel/./a.html` | ❌ | 不能含 `.` |
| `https://x/a.html` | ❌ | 不能是绝对 URL |
| `@data/storage.json` | ❌ | `@data/` 是运行时数据，不是页面 |
| `panel/a.txt` | ❌ | 入口必须是 `.html` |
| `panel/a.js`（含控制字符/超长） | ❌ | 控制字符 / 超长 |

---

## 3. 数据通道：页面怎么拿到数据

页面跑在**同源 iframe** 里，所以它可以直接 `fetch` 相对路径。

### 3.1 写：插件侧用 `api.storage`

`setup(api)` 里把 api 存住，`activate` 里用它：

```js
let api_ = null;
export function setup(api) { api_ = api; }
export function activate() { api_.storage.set('snapshot', { items: [...] }); }   // 立刻落盘
```

落盘位置：`<DATA_DIR>/plugin-data/<id>/storage.json`
（`DATA_DIR` = `config.js` 的 `DATA_DIR`，默认 `<ROOT>/data`，可用 `QQ_AGENT_DATA_DIR` 覆盖。）

- 单个文件 1MB 硬上限，超了 `set` 抛错。
- 键名 `__proto__` / `constructor` / `prototype` 会被拒。
- 只读通道没有写接口，页面改不了任何东西。

### 3.2 读：页面侧 fetch 相对路径

```html
<!-- plugins/my-plugin/panel/viewer.html -->
<script src="./viewer.js" defer></script>
```

```js
// plugins/my-plugin/panel/viewer.js
const res = await fetch('../@data/storage.json');   // ← 推荐
const snap = await res.json();
```

推荐相对路径 `../@data/storage.json`，而不是绝对路径
`/plugin-panel/my-plugin/@data/storage.json`。相对写法不必知道自己的 id，
整个 `panel/` 目录可以原样复制到另一个插件里而不改一行。

（`@data` 是路由保留段，映射到 `<DATA_DIR>/plugin-data/<id>/`。）

### 3.3 数据刷新

这条通道是纯静态 GET，宿主不会通知页面"数据变了"。
所以快照由插件在每次数据变动后主动写（表情库查看器就是这么做的：
收藏同步 / 加备注 / 收藏新表情 / 发送表情后各写一次）。

页面每次打开都会重新 fetch（`cache-control: no-cache`），所以打开即最新，
不需要页面内轮询。

---

## 4. 插件侧助手：`api.panel`

不用手抄 `/plugin-panel/<自己的 id>/`。宿主注入了：

```js
api.panel.id        // 自己的 id，如 'sticker'
api.panel.prefix    // '/plugin-panel'

api.panel.url('panel/viewer.html')
// → '/plugin-panel/sticker/panel/viewer.html'
// 相对插件目录的任意白名单资源（.js/.css/.png/.svg/.woff2…）
// 非法路径（越界 / 扩展名不在白名单）→ 返回 ''，调用方据此判断

api.panel.dataUrl()                  // → '/plugin-panel/sticker/@data/storage.json'
api.panel.dataUrl('other.json')      // → '/plugin-panel/sticker/@data/other.json'
```

典型用法是在日志里把地址打出来，方便用户直接点：

```js
const viewUrl = api.panel?.url?.('panel/viewer.html') || '';
api.log(`表情系统已启用${viewUrl ? `\n  界面：${viewUrl}` : ''}`);
```

> `api.panel` 是可选的（老宿主没有），所以写 `api.panel?.url?.(...)` 更稳。

---

## 5. URL 与路由

```
/plugin-panel/<id>/<段>/<段>/…           → <APP_ROOT>/plugins|skills/<id>/<段>/…
/plugin-panel/<id>/@data/<段>/…          → <DATA_DIR>/plugin-data/<id>/<段>/…
```

- `<id>` 形态：`/^[A-Za-z0-9][A-Za-z0-9._-]*$/`（与清单 id 校验同口径）。
- 每一段都经 `encodeURIComponent`（`panelUrl()` 负责），所以带空格/中文的文件名可用。
- 例外：`@data` 段是**字面量，不编码**（`panelDataUrl()` 单独处理）。
  这就是 `panelDataUrl()` 与 `panelUrl(id, '@data/…')` 不等价的原因：
  后者会把 `@data` 编成 `%40data`。

### 允许的文件类型

只有白名单里的扩展名能被吐出来：

```
.html .js .mjs .css .json .svg .png .jpg .jpeg .webp .gif .ico .woff2 .txt
```

**刻意不是"任意文件"。** 这条通道一旦放开成通用文件下载器，插件目录里的
`.md` / `.log` / 无扩展名文件（可能含调试残留的密钥）都会跟着被挂出去。

---

## 6. 安全模型

### 6.1 五道闸（`src/app.js` 的静态分支）

1. **来源校验** `originAllowed(req)`：恶意网页借浏览器读 `127.0.0.1` 读不到。
   只认 loopback 的 `Host`，且 `Origin`/`Referer` 若存在必须与 `Host` 同源。
   无来源信息的 `GET`/`HEAD`（地址栏直达 / curl）放行。
2. **id 形态** 必须匹配 `ID_RE`。
3. **逐段路径检查**：`..`、空段、控制字符、盘符、反斜杠一律拒（与 `/ui` 共用规则）。
4. **扩展名白名单** `PANEL_FILE_TYPES`。
5. **realpath 二次确认**：对根目录与目标文件各做一次 `fs.realpathSync`，
   再要求 `realFile === realRoot || realFile.startsWith(realRoot + path.sep)`。
   符号链接 / Windows 目录联接指向外面 → 404。

> 第 5 道是必须的：第 3 道只看字符串，拦不住"插件目录里放一个指向
> `C:\Users\...` 的链接"。在 Windows 上写这类测试要用 junction
> （`fs.symlinkSync(..., 'junction')`）：本机 `symlinkSync` 默认类型会静默退化成普通文件，
> 那样测出来是假绿。

### 6.2 CSP

插件页面由 `panelCsp()` 统一给：

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' data: blob: http: https:; media-src 'self' data: blob:;
connect-src 'self'; font-src 'self' data:;
object-src 'none'; base-uri 'none'; form-action 'none';
frame-ancestors 'self'
```

与 `/ui` 的 CSP 同款，只有两处不同：

- `script-src` 去掉了内联脚本的 hash，插件页面一律用外链 `.js`。
  内联 `<script>` 和 `onclick=` 都会被拦。`<style>` 和内联 `style=` 仍然允许
  （`style-src` 带 `unsafe-inline`）。
- `frame-ancestors` 从 `'none'` 放宽成 `'self'`：插件页面就是要被设置弹窗的
  iframe 嵌，写 `'none'` 会被浏览器直接拒掉，表现为白屏。

另附 `x-content-type-options: nosniff` 与 `referrer-policy: no-referrer`。

### 6.3 明确不防的东西

页面能读到自己插件的全部源码与全部 `plugin-data`。

这不是漏洞，那本来就是它自己的东西。但插件不该把别人的机密往 `plugin-data` 里塞，
因为它等于放在一个可被自己的页面读到的位置。

同理，页面读不到别的插件的目录（根被限定在自己的 id 下）。

### 6.4 为什么用 iframe，而不是把 HTML 注进主页面

1. 插件页有自己的 `<script>`，注进来会被主页面 CSP 的 `script-src 'self'` 拦掉；
2. 它的 `<style>` 会串味到整个控制台；
3. iframe 是现成的沙箱，插件页拿不到主页面的 DOM、变量和事件。

代价：插件页要自己再发一次请求，且只能读 `/plugin-panel/` 与 `/api` 的公开数据。

---

## 7. 加载失败时的表现

加载期（`normalizeManifest`）：

- 路径非法 → 入口仍然出现在列表里，但 `url` 为空、`problem` 是原因，
  按钮位置就地显示「打不开：<原因>」。
- 同时写进 `manifest.problems`，控制台的技能/插件页签会显示。

打开后（`openPluginPanel`）：

- iframe 加载完先探一次：如果页面正文恰好是 `Not Found` / `Forbidden`
  （宿主 404 页的字面内容），显示兜底提示。
- 4 秒超时还没 `load`，也显示兜底提示，避免用户盯着一个白框。

---

## 8. 三个必须记住的坑

### 8.1 改了 `plugins/**` 或 `skills/**` 就要重算指纹基线

`checkPluginTrust()` 对"目录名在基线里且内容指纹一致"的内置模块直接放行。
指纹一旦失配，扩展降级走能力扫描，扫到 `node:fs` 之类即判不可信并拒绝加载。
表情系统插件的 `lib/manager.js` 就 import 了 `node:fs`，失去豁免后必然被打回。

重算方式见 [skill-system.md 第 6 节](skill-system.md#6-安全边界两层别混淆)。
顺序必须是：改完所有插件文件 → 重算基线 → 跑测试。反了就是假失败。

### 8.2 插件页面不能用内联脚本

`script-src 'self'` 不含 `unsafe-inline`。写在 HTML 里的 `<script>…</script>`
不会执行，也不报错（只在 DevTools console 里有一条 CSP 违规）。
一律外链：`<script src="./viewer.js" defer></script>`。

### 8.3 前端弹层不拼 URL

`ui/app/06-settings-render.js` 是 classic script（`ui/index.html` 用 `defer` 逐个加载），
不能 `import` `src/skills/panel.js`。所以它只消费后端算好的 `panels[].url`，
自己一行路径都不拼，只保留一个形状检查（是否以 `/plugin-panel` 开头）。

加新的界面能力时不要在前端拼路径。两边拼法一有分歧就是"点了白屏"且不报错。

---

## 9. 相关文件

| 文件 | 角色 |
|---|---|
| `src/skills/panel.js` | **契约唯一实现**：常量 / 路径校验 / URL 拼装 / CSP |
| `src/skills/manifest.js` | `normalizeManifest` 里做 `configSchema` ↔ `panels` 拆分 |
| `src/skills/manager.js` | `status()` 把 `configSchema` 与 `panels` 透给前端；`hasSettings` 计入 panels |
| `src/app.js` | `/plugin-panel/` 静态分支（五道闸 + CSP 响应头） |
| `src/plugin-loader.js` | 注入 `api.panel`；`api.storage` 是数据通道的另一半 |
| `ui/app/06-settings-render.js` | 渲染「界面」区块 + `openPluginPanel()` iframe 弹层 |
| `ui/style.css` | `.skill-panels` / `.skill-panel-row` / `.plugin-panel__*` |
| `plugins/sticker/panel/` | 参考实现（表情库查看器） |

契约测试不在本仓库里（原 `panel-contract-test.mjs` 等套件随开发目录分发）。
现有测试见 `tests/`，用 `pnpm test` 跑。

---

## 10. 最小检查清单

新增一个界面入口时，逐条对：

- [ ] `configSchema` 里加了 `type: "action"`，`panel` 指向 `.html`
- [ ] 页面用**外链** `<script>`，没有内联脚本 / `onclick=`
- [ ] 页面用相对路径 `../@data/storage.json` 读数据（不硬编码自己的 id）
- [ ] 插件在数据变动后写了快照（`api.storage.set`）
- [ ] 路径是相对路径、用 `/`、不含 `..`（跑一遍 `pnpm test`）
- [ ] 改了插件文件 → **重算 `builtin-modules.json` 指纹**
- [ ] 在浅色 / 深色两个主题下各点一次（iframe 里的页面不继承控制台主题，
      要么自己读 `prefers-color-scheme`，要么像 `viewer.css` 那样做一份 token 镜像）

---

## 11. 相关文档

| 文档 | 内容 |
|---|---|
| [skill-system.md](skill-system.md) | 架构总览：两型扩展、加载流水线、能力机制、**安全边界** |
| [skill-reference.md](skill-reference.md) | 完整 API 参考：`api.storage`（数据的另一半）、`api.panel`、清单字段 |
| [plugin-development.md](plugin-development.md) | 插件开发规范（界面入口多数由插件提供） |
| [skill-development.md](skill-development.md) | 技能开发规范（技能同样可以带界面） |
| [onebot-capabilities.md](onebot-capabilities.md) | 操作 QQ 本身（界面里要展示 QQ 数据时用） |
