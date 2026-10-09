/**
 * Checkpoint 兼容聚合入口。
 *
 * 数据模型、Codec、Store Port 和内存 Adapter 分别位于相邻能力目录；保留本文件以维持
 * 已发布入口的导出名称，消费方无需跟随内部目录变化。
 */
export {
  type Checkpoint,
  type CheckpointStatus,
  type ResumeClaim,
} from "./model/checkpoint.js";
export { CHECKPOINT_STATUSES } from "./checkpoint-status.js";
export {
  CONSUME_DISPOSITIONS,
  type CheckpointRecord,
  type CheckpointStore,
  type ConsumeInterruptDisposition,
  type ConsumeInterruptRequest,
  type ConsumeInterruptResult,
  type DeleteCheckpointRequest,
  type LoadCheckpointRequest,
  type SaveCheckpointRequest,
} from "./store/port/checkpoint-store.js";
export { CheckpointStoreError } from "./store/checkpoint-store-error.js";
export { MemoryCheckpointStore } from "./store/adapter/memory-checkpoint-store.js";
export {
  cloneCheckpoint,
  cloneCheckpointRecord,
} from "./codec/checkpoint-clone.js";
export {
  parseCheckpoint,
  serializeCheckpoint,
  serializeCheckpointRecord,
} from "./codec/checkpoint-codec.js";
