import type { ResumeRequest } from "../../../runtime/run/model/runtime-request.js";
import type { RuntimeResult } from "../../../runtime/run/result/runtime-result.js";

/** 无持久化 Store 模式下，一次 resume 调用的进程内幂等收据。 */
export interface ResumeReceipt {
  /** 被恢复的中断标识；与 requestId 一起构成重放时的幂等比对身份。 */
  readonly interruptId: string;
  /** 恢复请求的幂等键；无 Store 模式用它区分重复请求，缺失时为空串并以 interruptId 兜底。 */
  readonly requestId: string;
  /** 恢复时提交的应答原文；重放时逐字节比对，防止同一 requestId 承载两次不同的回答。 */
  readonly response: string;
  /** 首次恢复的终态结果；深拷贝保存，重放时原样返回而不重新执行。 */
  readonly result: RuntimeResult;
  /** 首次恢复的失败原因；undefined 表示成功，非 undefined 时重放同样以失败返回。 */
  readonly error: Error | undefined;
}

/**
 * 保存无 Store 模式的 resume 结果，避免请求重试导致工具重复执行。
 * 持久化模式的幂等性仍由宿主 CheckpointStore 提供。
 * SDK 默认实现为 MemoryResumeReceiptStore，由 control-plane-composition.ts 显式组装。
 */
export interface ResumeReceiptStore {
  /**
   * 查找已有收据；命中即表示这次 resume 已经跑过，调用方应重放而不再执行工具。
   *
   * @param threadId - 收据所属的 thread
   * @param request - 用于推导查找键的恢复请求
   * @returns 命中的收据；没有时返回 undefined，调用方据此走首次执行路径
   */
  find(threadId: string, request: ResumeRequest): ResumeReceipt | undefined;
  /**
   * 记下首次恢复的结果或失败，供同 requestId/interruptId 的重试重放。
   *
   * @param threadId - 收据归属的 thread
   * @param request - 产生该结果的恢复请求；其身份字段成为重放时的比对项
   * @param result - 本次恢复的终态结果
   * @param error - 失败原因；undefined 表示成功，非 undefined 时重放照样以失败返回
   */
  save(
    threadId: string,
    request: ResumeRequest,
    result: RuntimeResult,
    error: Error | undefined,
  ): void;
}
