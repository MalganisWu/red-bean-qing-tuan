import type { ChildRunResult } from "../runner/port/child-runner.js";

/** 子运行失败，同时保留宿主已经返回的部分结果。 */
export class ChildRunError extends Error {
  public readonly result: ChildRunResult;

  public constructor(message: string, result: ChildRunResult, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ChildRunError";
    this.result = result;
  }
}
