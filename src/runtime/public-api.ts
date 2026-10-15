// Runtime 主包的稳定公开聚合；package 根入口只转发本文件。
//
// **本文件的导出清单就是 `red-bean-qing-tuan` 主入口的公共 API**：
// 改这里的 `export` 等于改 API，`check-api-surface` 与声明基线会拦住非预期变化。
// 内部模块之间请直接引用源文件，不要经由本文件转发。
export * from "./checkpoint/checkpoint.js";
export * from "./config/runtime-config.js";
export * from "./run/model/runtime-request.js";
export type { RuntimeResult } from "./run/result/runtime-result.js";
export * from "./run/error/runtime-error.js";
export * from "./plugin/runtime-plugin.js";
export * from "./facade/agent-runtime.js";
export { serializeRuntimeResult } from "./run/result/runtime-result-mapper.js";
