import { RUNTIME_ERROR_CODES } from "../../../../runtime/run/error/runtime-error.js";
import {
  cloneCheckpoint,
  cloneCheckpointRecord,
} from "../../codec/checkpoint-clone.js";
import { CheckpointStoreError } from "../checkpoint-store-error.js";
import {
  CONSUME_DISPOSITIONS,
  type CheckpointRecord,
  type CheckpointStore,
  type ConsumeInterruptRequest,
  type ConsumeInterruptResult,
  type DeleteCheckpointRequest,
  type LoadCheckpointRequest,
  type SaveCheckpointRequest,
} from "../port/checkpoint-store.js";
import {
  advanceFence,
  checkpointOwnedBy,
  emptyCheckpoint,
  emptyMemoryRecord,
  incrementRevision,
  type MemoryCheckpointRecord,
} from "./memory-checkpoint-record.js";
import { MemoryCheckpointReceiptLedger } from "./memory-checkpoint-receipts.js";

/**
 * 支持 CAS、fencing、回执和墓碑语义的进程内参考 Adapter。
 *
 * 只用于单进程与契约测试；生产实现由宿主提供。四条语义在这里被实现成可读的样板，
 * 宿主实现必须逐条对齐：
 * - **CAS**：`save`/`consumeInterrupt`/`delete` 都要求 `expectedRevision` 与当前 revision
 *   相等，否则 `REVISION_CONFLICT`；改动的写入总是 `revision + 1`。
 * - **fencing 单调**：fence 高水位只前进。关键是它在**任何校验之前**推进、且推进结果
 *   无论本次成败都会写回，因此失败的操作照样抬高水位，重放旧 token 一律 `STALE_FENCE`。
 * - **认领互斥**：`consumeInterrupt` 把 resume 从「挂起」推进到「已认领」，
 *   此后只有携带同一 `requestId` 的 `save` 能落终态，普通 run 无法越过认领覆盖结果。
 * - **所有权隐藏**：`userId` 不匹配一律返回 `CHECKPOINT_NOT_FOUND` 而非「无权限」，
 *   避免调用方靠错误码探测他人 thread 是否存在。
 */
export class MemoryCheckpointStore implements CheckpointStore {
  readonly #records = new Map<string, MemoryCheckpointRecord>();
  readonly #receipts = new MemoryCheckpointReceiptLedger();
  readonly #now: () => number;

  public constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  public load(
    request: LoadCheckpointRequest,
    signal: AbortSignal,
  ): Promise<CheckpointRecord> {
    return rejected((): CheckpointRecord => this.#load(request, signal));
  }

  public save(
    request: SaveCheckpointRequest,
    signal: AbortSignal,
  ): Promise<CheckpointRecord> {
    return rejected((): CheckpointRecord => this.#save(request, signal));
  }

  public consumeInterrupt(
    request: ConsumeInterruptRequest,
    signal: AbortSignal,
  ): Promise<ConsumeInterruptResult> {
    return rejected((): ConsumeInterruptResult =>
      this.#consumeInterrupt(request, signal),
    );
  }

  public delete(
    request: DeleteCheckpointRequest,
    signal: AbortSignal,
  ): Promise<bigint> {
    return rejected((): bigint => this.#delete(request, signal));
  }

  #load(request: LoadCheckpointRequest, signal: AbortSignal): CheckpointRecord {
    requireActive(signal);
    requireThreadId(request.threadId);
    const existing = this.#records.get(request.threadId);
    // 越权与不存在返回同一个错误码，见类注释「所有权隐藏」。
    if (
      existing &&
      !checkpointOwnedBy(existing.record.checkpoint, request.userId)
    ) {
      throw new CheckpointStoreError(RUNTIME_ERROR_CODES.CHECKPOINT_NOT_FOUND);
    }
    const record =
      existing ?? emptyMemoryRecord(request.threadId, request.userId);
    // fence 先于一切业务校验推进，且只要带非零 token 就落回 Map——包括本次即将失败的读取。
    // 这样「失败的调用也消耗水位」，重放同一 token 不会因为上一次失败而被放行。
    advanceFence(record, request.fencingToken);
    if (existing || request.fencingToken !== 0n)
      this.#records.set(request.threadId, record);
    // 未落盘、或已被 delete 写成墓碑时，抛错仍附带当前记录：调用方拿得到 revision，
    // 可以据此参与后续 CAS，而不是只剩一个无从下手的错误。
    if (!existing || !record.present || record.deleted) {
      throw new CheckpointStoreError(
        RUNTIME_ERROR_CODES.CHECKPOINT_NOT_FOUND,
        record.record,
      );
    }
    return cloneCheckpointRecord(record.record);
  }

  /**
   * CAS 保存。resume 的两次写入（认领、落终态）共用本方法，靠 `claimRequestId` 区分形态：
   * 首次认领不传，落终态必须传且等于已认领的 requestId。
   *
   * 越权、revision 冲突与认领冲突分别映射到 NOT_FOUND / REVISION_CONFLICT / THREAD_BUSY，
   * 调用方据此区分「不该我来写」「我来晚了」和「有人正在处理」。
   */
  #save(request: SaveCheckpointRequest, signal: AbortSignal): CheckpointRecord {
    requireActive(signal);
    requireThreadId(request.checkpoint.threadId);
    const threadId = request.checkpoint.threadId;
    const existing = this.#records.get(threadId);
    if (
      existing &&
      !checkpointOwnedBy(existing.record.checkpoint, request.checkpoint.userId)
    ) {
      throw new CheckpointStoreError(RUNTIME_ERROR_CODES.CHECKPOINT_NOT_FOUND);
    }
    // 即使记录尚不存在，也先建立带 owner 的墓碑状态，使 fence 高水位不会因失败写入而回退。
    const current =
      existing ?? emptyMemoryRecord(threadId, request.checkpoint.userId);
    advanceFence(current, request.fencingToken);
    if (existing || request.fencingToken !== 0n)
      this.#records.set(threadId, current);
    if (current.record.revision !== request.expectedRevision) {
      throw new CheckpointStoreError(RUNTIME_ERROR_CODES.REVISION_CONFLICT);
    }

    const checkpoint = cloneCheckpoint(request.checkpoint);
    // 调用方省略 userId 时沿用已存 owner，避免一次「没带身份」的写入把 thread 变成无主记录。
    if (checkpoint.userId === "" && existing)
      checkpoint.userId = current.record.checkpoint.userId;
    // 认领互斥的两个方向都必须在同一处判完：
    // ① 已认领时，落终态必须自证身份——requestId 对得上、自己不再声明新 claim、
    //    且 lastResumeInterrupt 指向被认领的那个 interrupt。三项缺一即 THREAD_BUSY，
    //    这就是「普通 run 不得越过 claim 覆盖结果」的落点。
    // ② 未认领时，反过来禁止任何一方携带 claim 痕迹，否则视为绕过 consumeInterrupt。
    const claim = current.record.checkpoint.resumeClaim;
    if (claim) {
      if (
        request.claimRequestId === undefined ||
        request.claimRequestId === "" ||
        request.claimRequestId !== claim.requestId ||
        checkpoint.resumeClaim !== undefined ||
        checkpoint.lastResumeInterrupt !== claim.interruptId
      ) {
        throw new CheckpointStoreError(RUNTIME_ERROR_CODES.THREAD_BUSY);
      }
    } else if (
      (request.claimRequestId !== undefined && request.claimRequestId !== "") ||
      checkpoint.resumeClaim !== undefined
    ) {
      throw new CheckpointStoreError(RUNTIME_ERROR_CODES.THREAD_BUSY);
    }

    const saved: CheckpointRecord = {
      checkpoint,
      revision: incrementRevision(current.record.revision),
    };
    current.record = cloneCheckpointRecord(saved);
    current.present = true;
    current.deleted = false;
    this.#records.set(threadId, current);

    // 落终态即完成一次 resume，把回执从「进行中」翻成「已完成」，后续同 requestId 走 REPLAYED。
    if (claim) {
      this.#receipts.saveCompletion(
        threadId,
        claim.requestId,
        claim.interruptId,
        claim.response,
        saved,
      );
    }
    return cloneCheckpointRecord(saved);
  }

  /**
   * 原子消费中断响应：把 `suspended` 的 Checkpoint 推进到「已认领」，并登记幂等回执。
   *
   * 判定顺序是这个方法的全部要点，不能重排：
   * 1. **回执优先于一切状态校验**。同 `requestId` 的重放必须能拿到当初的结果，
   *    而此时 Checkpoint 早已越过那次挂起（revision 变了、interrupt 也没了），
   *    任何「先比 revision」的写法都会把重放误判成 REVISION_CONFLICT。
   * 2. 回执存在但 `interruptId`/`response` 对不上 → `IDEMPOTENCY_CONFLICT`：
   *    同一个 requestId 不允许承载两次不同的请求。
   * 3. 之后才是「这个 interrupt 是不是已经被消费过」「是不是有人正在处理」，
   *    最后才轮到 CAS 与「当前确实处于挂起态」。
   */
  #consumeInterrupt(
    request: ConsumeInterruptRequest,
    signal: AbortSignal,
  ): ConsumeInterruptResult {
    requireActive(signal);
    requireThreadId(request.threadId);
    if (request.requestId === "")
      throw new Error("resume request ID must not be empty");

    const existing = this.#records.get(request.threadId);
    if (
      existing &&
      !checkpointOwnedBy(existing.record.checkpoint, request.userId)
    ) {
      throw new CheckpointStoreError(RUNTIME_ERROR_CODES.CHECKPOINT_NOT_FOUND);
    }
    const current =
      existing ?? emptyMemoryRecord(request.threadId, request.userId);
    advanceFence(current, request.fencingToken);
    if (existing || request.fencingToken !== 0n)
      this.#records.set(request.threadId, current);
    if (!existing || !current.present || current.deleted) {
      throw new CheckpointStoreError(
        RUNTIME_ERROR_CODES.CHECKPOINT_NOT_FOUND,
        current.record,
      );
    }

    // 见方法注释第 1、2 条：回执必须最先查，且查到了就不再往下走状态校验。
    const receipt = this.#receipts.find(request.threadId, request.requestId);
    if (receipt) {
      if (
        receipt.interruptId !== request.interruptId ||
        receipt.response !== request.response
      ) {
        throw new CheckpointStoreError(
          RUNTIME_ERROR_CODES.IDEMPOTENCY_CONFLICT,
        );
      }
      // completed 说明终态已落盘，重放直接返回；否则上一次认领还没走完，如实告知进行中。
      return {
        record: cloneCheckpointRecord(receipt.record),
        disposition: receipt.completed
          ? CONSUME_DISPOSITIONS.REPLAYED
          : CONSUME_DISPOSITIONS.IN_PROGRESS,
      };
    }

    const checkpoint = current.record.checkpoint;
    if (checkpoint.lastResumeInterrupt === request.interruptId) {
      throw new CheckpointStoreError(
        RUNTIME_ERROR_CODES.INTERRUPT_ALREADY_CONSUMED,
        current.record,
      );
    }
    // 已认领但未落终态：另一个请求正在进行，此时任何二次认领都必须被挡住。
    if (checkpoint.resumeClaim) {
      throw new CheckpointStoreError(
        RUNTIME_ERROR_CODES.RESUME_IN_PROGRESS,
        current.record,
      );
    }
    if (current.record.revision !== request.expectedRevision) {
      throw new CheckpointStoreError(RUNTIME_ERROR_CODES.REVISION_CONFLICT);
    }
    if (!checkpoint.interrupt) {
      throw new CheckpointStoreError(
        RUNTIME_ERROR_CODES.CHECKPOINT_NOT_SUSPENDED,
        current.record,
      );
    }
    // 挂起的是别的工具调用：请求与当前挂起点不匹配，不是「已消费」也不是「无权限」。
    if (checkpoint.interrupt.toolCallId !== request.interruptId) {
      throw new CheckpointStoreError(
        RUNTIME_ERROR_CODES.INTERRUPT_MISMATCH,
        current.record,
      );
    }

    // 认领是「消掉挂起 + 挂上 claim」的一次原子推进：interrupt 清空后，
    // 状态机只认 resumeClaim，直到携带同一 requestId 的 save 写出终态。
    const claimedCheckpoint = cloneCheckpoint(checkpoint);
    claimedCheckpoint.interrupt = undefined;
    claimedCheckpoint.resumeClaim = {
      interruptId: request.interruptId,
      requestId: request.requestId,
      response: request.response,
      claimedAt: this.#now(),
    };
    const claimed: CheckpointRecord = {
      checkpoint: claimedCheckpoint,
      revision: incrementRevision(current.record.revision),
    };
    current.record = cloneCheckpointRecord(claimed);
    this.#records.set(request.threadId, current);
    this.#receipts.saveClaim(
      request.threadId,
      request.requestId,
      request.interruptId,
      request.response,
      claimed,
    );
    return {
      record: cloneCheckpointRecord(claimed),
      disposition: CONSUME_DISPOSITIONS.CLAIMED,
    };
  }

  /**
   * 删除写出的是**墓碑**而非移除记录：checkpoint 内容被清空，但 `fencingToken` 与
   * 递增后的 `revision` 保留在原位。若真把记录删掉，fence 高水位会随之下落，
   * 一个早已被 fenced 的旧持有者就能重新拿 token 0 写回来。
   */
  #delete(request: DeleteCheckpointRequest, signal: AbortSignal): bigint {
    requireActive(signal);
    requireThreadId(request.threadId);
    const existing = this.#records.get(request.threadId);
    if (
      existing &&
      !checkpointOwnedBy(existing.record.checkpoint, request.userId)
    ) {
      throw new CheckpointStoreError(RUNTIME_ERROR_CODES.CHECKPOINT_NOT_FOUND);
    }
    const current =
      existing ?? emptyMemoryRecord(request.threadId, request.userId);
    advanceFence(current, request.fencingToken);
    if (existing || request.fencingToken !== 0n)
      this.#records.set(request.threadId, current);
    if (!existing || !current.present || current.deleted) {
      throw new CheckpointStoreError(
        RUNTIME_ERROR_CODES.CHECKPOINT_NOT_FOUND,
        current.record,
      );
    }
    if (current.record.revision !== request.expectedRevision) {
      throw new CheckpointStoreError(RUNTIME_ERROR_CODES.REVISION_CONFLICT);
    }
    // 有未完成的 resume 认领时禁止删除：否则终态写入会落在一个已经被抹掉的 thread 上。
    if (current.record.checkpoint.resumeClaim)
      throw new CheckpointStoreError(RUNTIME_ERROR_CODES.THREAD_BUSY);

    const revision = incrementRevision(current.record.revision);
    // version 被刻意保留：它标识 Checkpoint 结构的代次，与内容是否存在无关。
    current.record = {
      checkpoint: {
        ...emptyCheckpoint(request.threadId, current.record.checkpoint.userId),
        version: current.record.checkpoint.version,
      },
      revision,
    };
    current.present = false;
    current.deleted = true;
    this.#records.set(request.threadId, current);
    // 回执随 thread 一起作废，避免删除后旧 requestId 还能重放出已不存在的记录。
    this.#receipts.deleteThread(request.threadId);
    return revision;
  }
}

/** 已取消的调用不得产生任何副作用，因此在校验参数之前就先退出。 */
function requireActive(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException("operation aborted", "AbortError");
  }
}

function requireThreadId(threadId: string): void {
  if (threadId === "")
    throw new Error("checkpoint thread ID must not be empty");
}

/**
 * 把同步实现包装成 Promise 形态的 Port 方法。
 * 同步抛出会变成 reject 而不是「同步 throw + 返回 rejected promise」的混合形态，
 * 保证实现方无论同步失败还是异步失败，调用方的 catch 路径完全一致。
 */
function rejected<TOutput>(operation: () => TOutput): Promise<TOutput> {
  try {
    return Promise.resolve(operation());
  } catch (error: unknown) {
    return Promise.reject(
      error instanceof Error ? error : new Error(String(error)),
    );
  }
}
