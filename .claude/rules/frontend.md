---
paths:
  - "ui/**/*"
  - "**/*.css"
  - "**/*.html"
---

# 前端规范

## 1. 实际运行环境

`ui/` 为原生 HTML / CSS / JS，不使用前端框架。控制台既用于 Electron，也由 `pnpm run server` 提供给浏览器；桌宠等独立窗口另有 Electron 专属能力。

- 桌面运行时版本以 `package.json` 和锁文件为准，不在规则中固定 Chromium / Node 的对应版本。
- 通用控制台改动同时考虑桌面与 headless 访问；Electron 专属能力遵守现有桥接与可用性判断。
- 新增 Web 特性核对 MDN Browser Compatibility Data 与 Baseline；通用控制台默认采用 Baseline Widely available 的能力，并验证 Electron 与当前主流浏览器。仅在 Electron 独立窗口使用的能力按其运行时核实，不据此提高通用控制台的要求。
- 复用下述原生实现与公共封装；遇到旧写法时按对应职责统一改进，不并存两套实现。新增框架、预处理器或构建步骤属于技术栈调整，按通用规则第 4.2 节处理。

## 2. 脚本加载契约

- Node 模块写法见通用规则第 4.2 节；浏览器脚本以 HTML 中的实际声明为准，不能因 `package.json` 的 `type: module` 就把普通脚本当作 ESM。
- `ui/index.html` 通过 `defer` 按序加载 `ui/app/*.js` 普通脚本，跨脚本共享顶层绑定；这些文件不能直接添加 `import` / `export`。
- `ui/app.js` 是 ESM 桥，将所需 `/vendor/*.js` 导出挂到 `window`；其他页面和入口按各自 `<script>` 声明处理。
- 新增或删除渲染脚本时，检查 `ui/index.html` 的引用、执行依赖，以及 `ui/app.js` 和文件头说明；涉及桥接时同步修改桥，不因脚本数量变化而添加空改动。

### 2.1 DOM 与请求接口

- 控制台业务请求复用 `ui/app/00-core.js` 的 `api()`，沿用认证、错误文案与超时参数；启动探活、流式响应等不同契约使用其已有专用路径，不为普通业务请求另建 `fetch` 包装。
- 纯文本写入用 `textContent`；HTML 模板中的外部文本用现有 `esc()` 转义。URL 单独校验协议和目标，HTML 转义不能代替 URL 校验。事件用 `addEventListener`，不新增内联事件属性。

## 3. 样式与交互

样式集中在 `ui/style.css`，设计令牌定义在 `:root` 与亮暗主题选择器中。

- 复用 `.sl-*`、`.btn`、`.field`、`.skill-*` 等现有外壳与控件。
- 颜色使用设计令牌，不硬编码色值；间距优先使用现有令牌，新增视觉效果验证亮暗主题。
- HTML 优先使用语义元素和原生表单控件；开关沿用 `input.sw`，布局保持开关在左、文字在右。
- CSS 能直接表达的状态优先用选择器（如 `:has()`），需要业务状态时才使用 JS。
- 常规布局优先使用 Flexbox / Grid；界面主题的透明与混色沿用 `color-mix(in srgb, var(--令牌) 比例, transparent)`，由 CSS 自定义属性控制，不另写 JS 逐元素设色。壁纸取色等业务算法沿用其专用实现，不受此主题样式规则限制。
- 常规动效按正常样式定义，并在 `prefers-reduced-motion: reduce` 下关闭或减弱；交互元素须有可见的 `:focus-visible`。
- 表单控件提供关联的 `label`，图标按钮提供可访问名称；保留原生键盘操作，不用可点击的 `div` 代替按钮。
- 状态条用于异常或需要用户行动的状态，正常时不重复已有信息。

相关原生能力的语义与兼容性见 MDN 的 [color-mix()](https://developer.mozilla.org/en-US/docs/Web/CSS/color_value/color-mix) 与 [:focus-visible](https://developer.mozilla.org/en-US/docs/Web/CSS/:focus-visible)；项目采用方式以上述规则为准。

## 4. 插件面板

插件面板在同源 iframe 中运行，CSP 由 `src/skills/panel.js` 的 `panelCsp()` 统一管理：

- 脚本来自允许的同源资源，不使用内联 `<script>` 或 `onclick=`；不放宽 CSP 来迁就实现。
- 样式可用 `<style>` 与内联 `style=`。
- 保留 `frame-ancestors 'self'`，使控制台可嵌入面板。
- 存储数据通道用相对路径 `../@data/storage.json`，不硬编码扩展 id。

修改面板前查阅 `doc/extend_development/panel-ui-contract.md`。修改内置插件面板文件也须按后端规则更新指纹。
