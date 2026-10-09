import type { RuntimeContext } from "../../context/runtime-context.js";
import type { RawMessage } from "../../../protocol/message.js";
import { isHookFatalError } from "../hook-error.js";
import type { MessageHook } from "../port/message-hook.js";

/** 宿主提供的增量消息追加 Port；存储所有权和持久化失败语义由宿主实现。 */
export interface MessageAppender {
  append(key: string, message: RawMessage, signal: AbortSignal): Promise<void>;
}

const DEFAULT_BUFFER_TIMEOUT_MS = 5_000;

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("operation aborted", "AbortError");
}

async function appendWithTimeout(
  appender: MessageAppender,
  key: string,
  message: RawMessage,
  timeoutMs: number,
): Promise<void> {
  const signal = AbortSignal.timeout(timeoutMs);
  const aborted = new Promise<never>((_resolve, reject): void => {
    signal.addEventListener("abort", (): void => reject(abortError(signal)), {
      once: true,
    });
  });
  await Promise.race([appender.append(key, message, signal), aborted]);
}

/** 将已提交的 Assistant/Tool 消息限时追加到宿主缓冲区，避免阻塞主运行。 */
export class MessageBufferCheckpointer implements MessageHook {
  readonly #appender: MessageAppender;
  readonly #timeoutMs: number;

  public constructor(
    appender: MessageAppender,
    timeoutMs: number = DEFAULT_BUFFER_TIMEOUT_MS,
  ) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new RangeError("timeoutMs must be a positive safe integer");
    }
    this.#appender = appender;
    this.#timeoutMs = timeoutMs;
  }

  public onUserMessage(
    _context: RuntimeContext,
    _message: RawMessage,
    _signal: AbortSignal,
  ): Promise<void> {
    return Promise.resolve();
  }

  public onAssistantMessage(
    context: RuntimeContext,
    message: RawMessage,
    _signal: AbortSignal,
  ): Promise<void> {
    return this.#append(context, message);
  }

  public onToolMessage(
    context: RuntimeContext,
    message: RawMessage,
    _signal: AbortSignal,
  ): Promise<void> {
    return this.#append(context, message);
  }

  #append(context: RuntimeContext, message: RawMessage): Promise<void> {
    const checkpointKey = context.checkpointKey();
    return checkpointKey === ""
      ? Promise.resolve()
      : appendWithTimeout(
          this.#appender,
          checkpointKey,
          message,
          this.#timeoutMs,
        );
  }
}

type HookOperation = (hook: MessageHook) => Promise<void>;

/** 按注册顺序运行全部消息 Hook，并保证 fatal 错误优先于普通错误返回。 */
export class CompositeMessageHook implements MessageHook {
  readonly #hooks: readonly MessageHook[];

  public constructor(hooks: readonly MessageHook[]) {
    this.#hooks = [...hooks];
  }

  public onUserMessage(
    context: RuntimeContext,
    message: RawMessage,
    signal: AbortSignal,
  ): Promise<void> {
    return this.#runAll((hook: MessageHook): Promise<void> =>
      hook.onUserMessage(context, message, signal),
    );
  }

  public onAssistantMessage(
    context: RuntimeContext,
    message: RawMessage,
    signal: AbortSignal,
  ): Promise<void> {
    return this.#runAll((hook: MessageHook): Promise<void> =>
      hook.onAssistantMessage(context, message, signal),
    );
  }

  public onToolMessage(
    context: RuntimeContext,
    message: RawMessage,
    signal: AbortSignal,
  ): Promise<void> {
    return this.#runAll((hook: MessageHook): Promise<void> =>
      hook.onToolMessage(context, message, signal),
    );
  }

  async #runAll(operation: HookOperation): Promise<void> {
    let firstError: Error | undefined;
    let fatalError: Error | undefined;
    for (const hook of this.#hooks) {
      try {
        await operation(hook);
      } catch (value: unknown) {
        const error = value instanceof Error ? value : new Error(String(value));
        if (isHookFatalError(error)) fatalError ??= error;
        else firstError ??= error;
      }
    }
    if (fatalError) throw fatalError;
    if (firstError) throw firstError;
  }
}
