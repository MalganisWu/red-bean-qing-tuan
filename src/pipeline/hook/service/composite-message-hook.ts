import type { RuntimeContext } from "../../context/runtime-context.js";
import type { RawMessage } from "../../../protocol/message.js";
import { isHookFatalError } from "../hook-error.js";
import type { MessageHook } from "../port/message-hook.js";
import { abortError } from "../../../protocol/abort-signal.js";

/** 宿主提供的增量消息追加 Port；存储所有权和持久化失败语义由宿主实现。 */
export interface MessageAppender {
  /**
   * 把一条消息增量追加进宿主的缓冲区。
   *
   * 失败语义由宿主实现决定：本 Hook 只把它当作「尽力而为」的旁路写入，
   * 权威状态仍以主 checkpoint 为准。
   *
   * @param key - 缓冲区键，通常取自 RuntimeContext 的 checkpoint 键。
   * @param message - 要追加的消息。
   * @param signal - 取消信号，宿主实现应据此尽早放弃写入。
   */
  append(key: string, message: RawMessage, signal: AbortSignal): Promise<void>;
}

/** 缓冲追加的默认超时毫秒数；宿主未显式配置时用它兜底，避免一次卡住的写入拖住整次运行。 */
const DEFAULT_BUFFER_TIMEOUT_MS = 5_000;
/**
 * 带超时地追加一条消息。
 *
 * 用 `Promise.race` 而不是把信号交给 appender：宿主的实现未必理会 `signal`，
 * 赛跑至少保证**本次运行**不会被一次卡住的写入拖住。
 * 代价是写入可能在我们放弃之后才完成——这正是这个缓冲定位于「尽力而为」的原因，
 * 权威状态由主 Checkpoint 承担。
 *
 * @param appender - 宿主提供的追加实现。
 * @param key - 缓冲区键，透传给 appender。
 * @param message - 要追加的消息，透传给 appender。
 * @param timeoutMs - 本次写入的超时毫秒数，超时即以取消原因拒绝。
 */
async function appendWithTimeout(
  appender: MessageAppender,
  key: string,
  message: RawMessage,
  timeoutMs: number,
): Promise<void> {
  const signal = AbortSignal.timeout(timeoutMs);
  const { promise: aborted, reject } = Promise.withResolvers<never>();
  signal.addEventListener("abort", (): void => reject(abortError(signal)), {
    once: true,
  });
  await Promise.race([appender.append(key, message, signal), aborted]);
}

/** 将已提交的 Assistant/Tool 消息限时追加到宿主缓冲区，避免阻塞主运行。 */
export class MessageBufferCheckpointer implements MessageHook {
  /** 宿主提供的增量追加实现；本类只负责限时与角色筛选。 */
  readonly #appender: MessageAppender;
  /** 每次追加的超时毫秒数，构造时已校验为正安全整数。 */
  readonly #timeoutMs: number;

  public constructor(
    appender: MessageAppender,
    timeoutMs: number = DEFAULT_BUFFER_TIMEOUT_MS,
  ) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new RangeError("timeoutMs 必须是正安全整数");
    }
    this.#appender = appender;
    this.#timeoutMs = timeoutMs;
  }

  /**
   * user 消息**不入缓冲**：它来自本次调用方传入的输入，调用方自己已经持有它。
   * 缓冲存在的意义是「崩溃后能补回宿主还不知道的增量」，而 user 消息宿主本来就不知道不了。
   *
   * @param _context - 契约占位，未使用；本方法不读运行上下文。
   * @param _message - 契约占位，未使用；user 消息不入缓冲。
   * @param _signal - 契约占位，未使用；本方法立即完成，无需取消。
   */
  public onUserMessage(
    _context: RuntimeContext,
    _message: RawMessage,
    _signal: AbortSignal,
  ): Promise<void> {
    return Promise.resolve();
  }

  /**
   * 把已提交的 assistant 消息限时追加进宿主缓冲区；写入失败被吞掉，不打断主运行。
   *
   * @param context - 本次运行上下文，用于取 checkpoint 键；键为空串时跳过追加。
   * @param message - 要缓冲的 assistant 消息。
   * @param _signal - 契约占位，未使用；超时由内部自建的信号控制。
   */
  public onAssistantMessage(
    context: RuntimeContext,
    message: RawMessage,
    _signal: AbortSignal,
  ): Promise<void> {
    return this.#append(context, message);
  }

  /**
   * 把已提交的 tool 消息限时追加进宿主缓冲区；语义与失败处理和 assistant 消息一致。
   *
   * @param context - 本次运行上下文，用于取 checkpoint 键；键为空串时跳过追加。
   * @param message - 要缓冲的 tool 消息。
   * @param _signal - 契约占位，未使用；超时由内部自建的信号控制。
   */
  public onToolMessage(
    context: RuntimeContext,
    message: RawMessage,
    _signal: AbortSignal,
  ): Promise<void> {
    return this.#append(context, message);
  }

  /**
   * 按当前运行的 checkpoint 键把消息追进缓冲区；键为空串时跳过。
   *
   * 键为空表示本次运行不参与缓冲区持久化，此时静默跳过而不是报错。
   *
   * @param context - 本次运行上下文，用于取 checkpoint 键。
   * @param message - 要缓冲的消息。
   * @returns 追加完成或跳过后的 Promise；写入失败被吞掉，不向调用方传播。
   */
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

/** 对单个 Hook 的一次派发操作；由 `runAll` 逐个调用并收拢其错误。 */
type HookOperation = (hook: MessageHook) => Promise<void>;

/** 按注册顺序运行全部消息 Hook，并保证 fatal 错误优先于普通错误返回。 */
export class CompositeMessageHook implements MessageHook {
  /** 已注册的 Hook 列表；构造时复制一份，之后按注册顺序依次派发。 */
  readonly #hooks: readonly MessageHook[];

  public constructor(hooks: readonly MessageHook[]) {
    this.#hooks = [...hooks];
  }

  /**
   * 把 user 消息依次派发给全部已注册 Hook；跑完全部后再按 fatal 优先抛错。
   *
   * @param context - 本次运行上下文，原样传给每个 Hook。
   * @param message - 刚提交的 user 消息。
   * @param signal - 运行取消信号，原样传给每个 Hook。
   */
  public onUserMessage(
    context: RuntimeContext,
    message: RawMessage,
    signal: AbortSignal,
  ): Promise<void> {
    return this.#runAll((hook: MessageHook): Promise<void> =>
      hook.onUserMessage(context, message, signal),
    );
  }

  /**
   * 把 assistant 消息依次派发给全部已注册 Hook；跑完全部后再按 fatal 优先抛错。
   *
   * @param context - 本次运行上下文，原样传给每个 Hook。
   * @param message - 刚提交的 assistant 消息。
   * @param signal - 运行取消信号，原样传给每个 Hook。
   */
  public onAssistantMessage(
    context: RuntimeContext,
    message: RawMessage,
    signal: AbortSignal,
  ): Promise<void> {
    return this.#runAll((hook: MessageHook): Promise<void> =>
      hook.onAssistantMessage(context, message, signal),
    );
  }

  /**
   * 把 tool 消息依次派发给全部已注册 Hook；跑完全部后再按 fatal 优先抛错。
   *
   * @param context - 本次运行上下文，原样传给每个 Hook。
   * @param message - 刚提交的 tool 消息。
   * @param signal - 运行取消信号，原样传给每个 Hook。
   */
  public onToolMessage(
    context: RuntimeContext,
    message: RawMessage,
    signal: AbortSignal,
  ): Promise<void> {
    return this.#runAll((hook: MessageHook): Promise<void> =>
      hook.onToolMessage(context, message, signal),
    );
  }

  /**
   * **跑完全部 hook**，把错误收集起来再抛，而不是遇到第一个就中断。
   *
   * 理由：hook 之间彼此独立（一个写审计、一个推展示），前一个失败不该让后面的看不到这条消息。
   * 抛出时 fatal 优先于普通错误——fatal 意味着运行必须停下来，掩盖它而去报一个可忽略的错误，
   * 会让调用方以为还能继续。同类错误只记第一个（`??=`），后续是同一根因的重复。
   *
   * @param operation - 对单个 Hook 的派发操作，对每个已注册 Hook 调用一次。
   */
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
