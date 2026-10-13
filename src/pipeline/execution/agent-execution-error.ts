import type { ReactResult } from "../react-loop/react-loop.js";

/** 保留失败时已经生成的中性结果，供高层 Runtime 构造可持久化 checkpoint。 */
export class ReactAgentExecutionError extends Error {
  /**
   * 失败发生前 ReAct loop 已经生成的部分结果；仅当循环先产出结果、随后才失败时才有值，
   * 供调用方持久化已产生的进展。为 undefined 表示连部分结果都没来得及生成。
   */
  public readonly result: ReactResult | undefined;

  public constructor(
    message: string,
    result: ReactResult | undefined,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ReactAgentExecutionError";
    this.result = result;
  }
}
