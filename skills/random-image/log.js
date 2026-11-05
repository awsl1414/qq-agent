// 扩展日志入口。核心通过 setup(api) 注入；未注入时静默（不影响取图主流程）。
//
// 为什么单独成模块而不是形参传递：downloadImage / fetchPixivSearch 等底层函数
// 在技能内被多处调用，加形参会扩散到所有调用点且容易漏传；日志是横切关注点，
// 模块内共享一个只写一次的入口更简单。
//
// 只在 setup 时赋值一次，之后只读——不提供运行时切换，避免隐藏的全局状态。
// 本模块是单例扩展，不存在「两个实例互相覆盖」的问题。
let impl = null;

/** @param {{info?:Function, warn?:Function, error?:Function}} fn */
export function setLogger(fn) { impl = fn || null; }

export function log(...a) { impl?.info?.(...a); }
export function warn(...a) { impl?.warn?.(...a); }
export function error(...a) { impl?.error?.(...a); }
