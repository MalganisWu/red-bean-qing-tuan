import type { ChildRunResult } from "../runner/port/child-runner.js";

/** 子运行失败，同时保留宿主已经返回的部分结果。 */
export class ChildRunError extends Error {
  /**
   * 宿主失败那一刻已经产出的部分结果。
   *
   * 包装方应以它为准，而不是丢弃后另造一个最小结果——半成品往往足以让父 Agent 继续。
   */
  public readonly result: ChildRunResult;

  public constructor(message: string, result: ChildRunResult, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ChildRunError";
    this.result = result;
  }
}
