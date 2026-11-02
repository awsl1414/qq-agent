# 桌宠渲染组件

运行组件固定版本并在本地提供，不从 CDN 加载脚本，不包含 API 密钥。

| 文件 | 来源 | 许可 |
| --- | --- | --- |
| pixi.min.js | pixi.js 6.5.10 | MIT，见 LICENSE-PixiJS.txt |
| unsafe-eval.min.js | @pixi/unsafe-eval 6.5.10 | MIT，见 LICENSE-unsafe-eval.txt |
| cubism4.min.js | pixi-live2d-display 0.4.0 | MIT，见 LICENSE-pixi-live2d-display.txt；其使用的 Cubism Framework 亦受 Live2D 条款约束 |
| live2dcubismcore.min.js | @hazart-pkg/live2d-core 1.0.1 中的 Cubism Core | Live2D Proprietary Software License，见 LICENSE-Cubism-Core.md 和 Cubism-RedistributableFiles.txt |

unsafe-eval 组件以不动态生成 JavaScript 函数的实现替换 PIXI 的相关功能，允许控制台继续禁止 JavaScript unsafe-eval。只有宠物渲染页面单独允许 WebAssembly 编译，以加载 Cubism Core。

Live2D 许可及发行要求：https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_cn.html

官方示例角色的出处、版权和素材许可另见 assets/desktop-pet/Hiyori/NOTICE.md。商用、再分发与其他角色模型应分别遵守对应条款。

## DaiMeow 动作和气泡逻辑

本机接入的 `daimeow-effects.js`、动作池与坐站规则，以及气泡样式，参考或改编自 [yubdey/DaiMeow](https://github.com/yubdey/DaiMeow)，固定提交 `3544f16d861d18a919901f66d161ecc5f4088b4f`。源代码使用 MIT 许可，Copyright (c) 2026 DaiMeow contributors；完整许可保存在 `../daimeow-assets/UPSTREAM-LICENSE.md`。

道具图片、GIF 和艾露猫模型适用独立权利声明，原作者与第三方说明随 `../daimeow-assets/THIRD_PARTY_NOTICES.md` 和角色目录中的说明保留。代码的 MIT 许可不自动覆盖图片或角色素材。
