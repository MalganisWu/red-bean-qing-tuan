import type { CheckpointStatus } from "./model/checkpoint.js";

/**
 * Checkpoint 终态与挂起态的稳定运行时常量。
 * 与 `RuntimeResult.status` 一一对应，是宿主判断「这次运行要不要 resume」的依据；
 * 作为字面量常量而非枚举导出，避免消费者依赖 TypeScript 的运行时枚举产物。
 */
export const CHECKPOINT_STATUSES = Object.freeze({
  COMPLETED: "completed",
  SUSPENDED: "suspended",
  EXHAUSTED: "exhausted",
  CANCELLED: "cancelled",
  FAILED: "failed",
} satisfies Readonly<Record<string, CheckpointStatus>>);
