# 应用图标

三个平台各用一份，源图只有 `icon.png`（256×256 RGBA）。

| 文件 | 用在哪 | 来源 |
|---|---|---|
| `icon.png` | 开发态 / 非 Windows 的窗口与托盘图标（`electron/main.js` 的 `ICON_PATH`） | 原始素材 |
| `icon.ico` | Windows 打包图标（含 16~256 全套，Windows 原生格式） | 原始素材 |
| `icon.icns` | mac 打包图标（`mac.icon`） | 由 `icon.png` 放大生成 |
| `icons/<N>x<N>.png` | Linux 打包图标目录（`linux.icon` 指向这个目录） | 由 `icon.png` 放大生成 |

## 为什么是放大出来的

`icon.png` 只有 256×256，而 mac 的 icns 要撑到 512@2x（1024px）、Linux 桌面要给
512 / 1024 两档。仓库里（含 `git log --all -- assets/` 的历史）没有更大的源图，
所以 `icon.icns` 与 `icons/` 下 512 以上的档位都是 `sips` 从 256 插值放大的：
代码根以外没有更高分辨率的原件可用。

**后果**：高分屏（Retina / 4K）上图标会偏软，边缘能看出轻微模糊。这不是取巧，
是素材本身的硬限制。拿到 1024×1024 以上的源图后，应当按下面的命令重新生成，
而不是继续放大这份 256 的图。

## 重新生成

```bash
# 1. 放大到 1024 作为各档的中间图。源图若本身 ≥1024，这一步换成直接复制源图。
sips -z 1024 1024 assets/icon.png --out /tmp/icon-1024.png

# 2. mac：iconset → icns
mkdir -p /tmp/icon.iconset
for spec in 16:icon_16x16.png 32:icon_16x16@2x.png 32:icon_32x32.png 64:icon_32x32@2x.png \
            128:icon_128x128.png 256:icon_128x128@2x.png 256:icon_256x256.png \
            512:icon_256x256@2x.png 512:icon_512x512.png 1024:icon_512x512@2x.png; do
  sips -z "${spec%%:*}" "${spec%%:*}" /tmp/icon-1024.png --out "/tmp/icon.iconset/${spec##*:}"
done
iconutil -c icns /tmp/icon.iconset -o assets/icon.icns

# 3. linux：多尺寸 PNG 目录
mkdir -p assets/icons
for s in 16 32 48 64 128 256 512 1024; do
  sips -z "$s" "$s" /tmp/icon-1024.png --out "assets/icons/${s}x${s}.png"
done
```

`icon.icns` 生成后直接重跑构建即可生效：`electron-builder` 把它转出的中间文件放在
`dist/.icon-icns/`，每次全新构建都会重新读取源文件。
