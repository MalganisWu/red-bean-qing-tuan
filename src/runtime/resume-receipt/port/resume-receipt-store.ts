import type { ResumeRequest } from "../../../runtime/run/model/runtime-request.js";
import type { RuntimeResult } from "../../../runtime/run/result/runtime-result.js";

/** 无持久化 Store 模式下，一次 resume 调用的进程内幂等收据。 */
export interface ResumeReceipt {
  readonly interruptId: string;
  readonly requestId: string;
  readonly response: string;
  readonly result: RuntimeResult;
  readonly error: Error | undefined;
}

/**
 * 保存无 Store 模式的 resume 结果，避免请求重试导致工具重复执行。
 * 持久化模式的幂等性仍由宿主 CheckpointStore 提供。
 * SDK 默认实现为 MemoryResumeReceiptStore，由 control-plane-composition.ts 显式组装。
 */
export interface ResumeReceiptStore {
  find(threadId: string, request: ResumeRequest): ResumeReceipt | undefined;
  save(
    threadId: string,
    request: ResumeRequest,
    result: RuntimeResult,
    error: Error | undefined,
  ): void;
}
