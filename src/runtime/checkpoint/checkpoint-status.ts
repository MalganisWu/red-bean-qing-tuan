import type { CheckpointStatus } from "./model/checkpoint.js";

/** Checkpoint 终态与挂起态的稳定运行时常量。 */
export const CHECKPOINT_STATUSES = Object.freeze({
  COMPLETED: "completed",
  SUSPENDED: "suspended",
  EXHAUSTED: "exhausted",
  CANCELLED: "cancelled",
  FAILED: "failed",
} satisfies Readonly<Record<string, CheckpointStatus>>);
