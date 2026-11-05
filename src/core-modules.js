// 内置模块（kind='core'）的 id → 源码目录，唯一真源。
//
// 为什么需要这份名单：内置模块不落 skills/ 或 plugins/，也不在 builtin-modules.json
// 基线里（基线只收随包分发的扩展目录），所以「已装扩展」的磁盘索引看不到它们。
// 「这个名字已经属于内置模块」的判断有三处要用：
//   · 安装侧（extension-forge 的 forge.install、本地导入）——否则第三方包能落一个
//     同 id 的目录，加载后 manager.register() 的 capabilities.removeOwner() 把
//     core 实例的能力整体清空（实测 forge.install 提供者 1 → 0）；
//   · 装载侧（plugin-loader 的 loadSkillDir）——拦手工拷进 skills/ 的同 id 目录；
//   · 注册侧（SkillManager.register）——任何注册路径都不能顶掉 core。
// 这三处都不能 import src/harness/index.js：它反过来 import plugin-loader，会成环。
//
// 目录值同时是 harness/index.js 注册时用的 relDir，那边启动时会校验两边一致。
export const CORE_MODULES = Object.freeze({
  'self-doctor': 'src/harness/doctor',
  'self-fix': 'src/harness/fix',
  'extension-forge': 'src/harness/forge',
  'dev-orders': 'src/harness/dev',
  'wallpaper': 'src/wallpaper'
});

export const CORE_MODULE_IDS = Object.freeze(Object.keys(CORE_MODULES));

/** 是否为内置模块 id（空白与类型差异都按字符串归一后比较）。 */
export function isCoreModuleId(id) {
  return Object.hasOwn(CORE_MODULES, String(id ?? '').trim());
}

/** 内置模块的源码目录（仓库相对路径，'/' 分隔）。非内置 id 返回 ''。 */
export function coreModuleRelDir(id) {
  return CORE_MODULES[String(id ?? '').trim()] || '';
}
