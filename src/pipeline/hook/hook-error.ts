/*
 * 消息 Hook 的两种失败强度：普通错误只记录并放行，fatal 错误必须中止整条 pipeline。
 * 这个区分只能由 hook 作者决定——「展示推送失败」可以忽略，「审计写入失败」往往不行，
 * 框架无从推断。因此约定是用这个包装类**显式**标记 fatal。
 */
/**
 * fatal hook 错误消息的固定前缀。
 *
 * 它只服务日志与告警的粗筛，**不是**机器判据——机器判据是 `HookFatalError` 类型本身，
 * 所以这里的措辞可以被翻译或改写而不影响判定。
 */
const HOOK_FATAL_PREFIX = "hook fatal error, abort pipeline";

/**
 * 标记「必须中止 pipeline」的 hook 错误。
 * 消息里保留固定前缀，是为了让日志与告警能在不解析错误类型的情况下筛出这类致命失败。
 * 原始错误通过 `cause` 保留，不会被这层包装丢掉。
 */
export class HookFatalError extends Error {
  public constructor(cause: Error) {
    super(`${HOOK_FATAL_PREFIX}: ${cause.message}`, { cause });
    this.name = "HookFatalError";
  }
}

/**
 * 用 `instanceof` 判定而不是匹配消息前缀：前缀是给人读的，可能被翻译或改写；
 * 类型才是机器判据。跨包边界（例如被包进 AggregateError）时由调用方沿 cause 链查找。
 *
 * @param value - 待判定的值；非 HookFatalError 实例一律返回 false，且不会抛错。
 * @returns 该值是否为 HookFatalError。
 */
export function isHookFatalError(value: unknown): value is HookFatalError {
  return value instanceof HookFatalError;
}
