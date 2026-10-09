import type { ReactResult } from "../react-loop/react-loop.js";

/** 保留失败时已经生成的中性结果，供高层 Runtime 构造可持久化 checkpoint。 */
export class ReactAgentExecutionError extends Error {
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
