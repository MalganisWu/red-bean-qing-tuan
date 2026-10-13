import {
  RuntimeError,
  type RuntimeErrorCode,
} from "../../../runtime/run/error/runtime-error.js";
import { cloneCheckpointRecord } from "../codec/checkpoint-clone.js";
import type { CheckpointRecord } from "./port/checkpoint-store.js";

/** Checkpoint Store 的稳定错误，必要时附带冲突时读取到的安全快照。 */
export class CheckpointStoreError extends RuntimeError {
  /** 抛出时读取到的记录快照（已深拷贝）；仅当调用方能安全看到该记录时才附带，越权场景刻意不带。 */
  public readonly record: CheckpointRecord | undefined;

  public constructor(
    code: RuntimeErrorCode,
    record?: CheckpointRecord,
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = "CheckpointStoreError";
    this.record = record ? cloneCheckpointRecord(record) : undefined;
  }
}
