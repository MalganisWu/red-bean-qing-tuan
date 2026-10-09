const HOOK_FATAL_PREFIX = "hook fatal error, abort pipeline";

export class HookFatalError extends Error {
  public constructor(cause: Error) {
    super(`${HOOK_FATAL_PREFIX}: ${cause.message}`, { cause });
    this.name = "HookFatalError";
  }
}

export function isHookFatalError(value: unknown): value is HookFatalError {
  return value instanceof HookFatalError;
}
