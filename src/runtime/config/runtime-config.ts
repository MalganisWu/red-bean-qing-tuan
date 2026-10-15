// 兼容 Runtime 主入口；配置的单一来源位于低层 Pipeline。
// 这里只转发类型，不复制定义——否则同一份配置会出现两个可能漂移的版本。
export type {
  CompressionConfig,
  RuntimeConfig,
} from "../../pipeline/config/runtime-config.js";
