---
paths:
  - "ui/**/*"
  - "**/*.css"
  - "**/*.html"
---

# 前端规范

`ui/` 是零框架原生实现。样式集中在 `ui/style.css`，设计令牌定义在 `:root` / `[data-theme='dark']` / `[data-theme='light']`。

## 运行时基线

`electron` 45 对应 **Chromium 156 / Node 24.22.1**（查自 `releases.electronjs.org` 的版本表）。不需要为旧浏览器加垫片。

`ui/` 由 Electron 直接加载，不存在跨浏览器兼容问题。独立窗口的 `ui/widget.html` 同样只在应用内打开。

## 特性采用标准

以 [Baseline](https://web-platform-dx.github.io/web-features/) 为准，不用"最新"这种判断。当前可用：

| 特性 | Baseline 状态 | 项目使用 |
|---|---|---|
| `color-mix()` | Widely available | 166 处 |
| `:has()` | Widely available | 5 处 |
| CSS 嵌套 | Widely available | 未使用 |
| `@layer` | Widely available | 未使用 |
| `@container` | Widely available | 未使用 |
| `oklch()` | Widely available | 未使用 |
| `light-dark()` | **Newly available** | 未使用，慎用 |
| `<dialog>` / Popover API | Widely available / **Newly available** | 未使用 |

新增特性前先 `grep` 现有用法，与既有实现对齐优先于引入新写法。同一种效果不要出现两套写法。

## 编写要求

- HTML：语义元素优先（`<button>` 不用 `<div onclick>`），表单控件用原生元素而不是重建
- CSS：自定义属性做令牌，不写硬编码色值；能用 `:has()` 就用，不要加 JS 类切换
- 无障碍：动效必须包在 `@media (prefers-reduced-motion: reduce)` 里（现有 4 处）；交互元素要有可见焦点态（`:focus-visible` 现有 20 处）
- JS：ESM，`"type": "module"`

## 脚本加载

`ui/index.html` 用 `defer` 按序加载 `ui/app/*.js`（26 个）。这些是 classic script，不是 ESM：跨段共享的顶层绑定靠加载顺序，不能 `import`。

只有 `ui/app.js` 是 module，负责把 `/vendor/*.js` 的导出挂到 `window`。

新增渲染脚本必须同步改三处：`ui/index.html`、`ui/app.js`、该文件头部的说明。三处对不上就是"函数未定义"。

## 视觉与交互风格

- 新页面复用已有外壳：`.sl-*`（连接 / 自检 / 桌宠页）、`.btn`、`.field`、`.skill-*`。不要为单个页面另造一套
- 颜色只走令牌，亮暗两套主题都要验
- 开关统一用 `input.sw`（40×22 轨道，开关在左文字在右），不要混用方块复选框
- 状态条只在出问题时说话，正常时不重复下方已有信息
- 排版留白优先用现有间距令牌，不新造数值

## 插件自带页面

插件面板跑在同源 iframe 里，CSP 由 `src/skills/panel.js` 的 `panelCsp()` 统一给：

- `script-src 'self'` 不含 `unsafe-inline`，内联 `<script>` 和 `onclick=` 会被静默拦掉
- `<style>` 与内联 `style=` 允许
- `frame-ancestors 'self'`（必须能被设置弹窗嵌入）

数据通道用相对路径 `../@data/storage.json`，不要硬编码自己的 id。完整契约见 `doc/extend_development/panel-ui-contract.md`。
