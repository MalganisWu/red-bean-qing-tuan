import { LLM_ERROR_KINDS, LlmError } from "../../error/llm-error.js";
import type { LlmChunk, TokenUsage } from "../../model/model.js";
import type { ToolCall } from "../../../protocol/tool-call.js";
import {
  abortError,
  openAiProtocolError,
} from "../error/openai-error-mapper.js";

interface ParsedEvent {
  readonly done: boolean;
  readonly chunks: readonly LlmChunk[];
}

interface StreamReadResult {
  readonly done: boolean;
  readonly value?: Uint8Array | undefined;
}

/**
 * 把 OpenAI-compatible SSE 流解析成中性的 LLM chunk。
 *
 * 分帧要点：网络分片与 SSE 事件边界无关，一个 `data:` 行可能被切成两半，
 * 所以必须累积到换行符才交出去；末尾那段没有换行符的残行要在 reader 结束后补一轮，
 * 并先用 `decoder.decode()`（不带 `stream`）冲掉 TextDecoder 里残留的多字节字符——
 * 少了这一步，以非 ASCII 结尾的响应会丢最后一个字符。
 *
 * 本函数不抛协议错误：见 `parseEvent` 的带内错误约定。
 * `finally` 里无条件 cancel + releaseLock，保证消费者提前 break 时底层连接不会悬着；
 * 清理失败被吞掉是对的——此时主流程已经结束，再抛只会掩盖真正的结果。
 */
export async function* parseOpenAiEventStream(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<LlmChunk, void, undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  try {
    while (true) {
      const read = await readWithAbort(reader, signal);
      if (read.done) break;
      if (read.value === undefined) continue;
      buffered += decoder.decode(read.value, { stream: true });
      let newline = buffered.indexOf("\n");
      while (newline >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        const data = lineData(line);
        if (data !== undefined) {
          const event = parseEvent(data);
          for (const chunk of event.chunks) yield chunk;
          if (event.done) return;
        }
        newline = buffered.indexOf("\n");
      }
    }
    buffered += decoder.decode();
    if (buffered !== "") {
      const data = lineData(buffered);
      if (data !== undefined) {
        const event = parseEvent(data);
        for (const chunk of event.chunks) yield chunk;
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch (_error: unknown) {
      // transport 可能已经关闭或取消，此处清理失败不能覆盖主要结果。
    }
    reader.releaseLock();
  }
}

/**
 * 解析一条 SSE `data:` 载荷。
 *
 * **协议错误走带内通道**：JSON 坏掉、字段类型不对、provider 回了 `error` 对象，
 * 一律返回 `done: true` 且 chunks 里带一个设置了 `error` 的 chunk，而不是抛出。
 * 这样上层拿到的是「流正常结束，但内容是失败的」——错误和正常的终止走同一条路径，
 * 不必在消费侧再套一层 try；`done: true` 同时告诉生产者不必再读了。
 */
function parseEvent(data: string): ParsedEvent {
  if (data === "[DONE]") return { done: true, chunks: [] };
  let decoded: unknown;
  try {
    decoded = JSON.parse(data);
  } catch (cause: unknown) {
    return errorEvent(
      openAiProtocolError("provider stream contains invalid JSON", cause),
    );
  }
  if (!isRecord(decoded))
    return errorEvent(openAiProtocolError("provider event is invalid"));
  const providerError = decoded["error"];
  if (providerError !== undefined && providerError !== null) {
    const message = isRecord(providerError)
      ? optionalString(providerError, "message")
      : undefined;
    return errorEvent(
      new LlmError(
        LLM_ERROR_KINDS.TEMPORARY,
        new Error(`provider stream error: ${message ?? "unknown error"}`),
      ),
    );
  }
  const chunks: LlmChunk[] = [];
  const usage = parseUsage(decoded["usage"]);
  if (usage instanceof Error) return errorEvent(usage);
  if (usage) chunks.push({ content: null, usage });
  const choices = decoded["choices"];
  if (choices === undefined || choices === null) return { done: false, chunks };
  if (!Array.isArray(choices)) {
    return {
      done: true,
      chunks: [
        ...chunks,
        {
          content: null,
          error: openAiProtocolError("provider choices are invalid"),
        },
      ],
    };
  }
  const validatedChoices: readonly unknown[] = choices;
  const firstChoice = validatedChoices[0];
  if (firstChoice === undefined) return { done: false, chunks };
  const choice = parseChoice(firstChoice);
  if (choice instanceof Error)
    return {
      done: true,
      chunks: [...chunks, { content: null, error: choice }],
    };
  chunks.push(choice);
  return { done: false, chunks };
}

/** 用 `hasOptionalString` 而非 `optionalString` 校验：字段「存在但类型不对」必须报错，不能当作缺失忽略。 */
function parseChoice(value: unknown): LlmChunk | Error {
  if (!isRecord(value))
    return openAiProtocolError("provider choice is invalid");
  const delta = value["delta"];
  if (!isRecord(delta)) return openAiProtocolError("provider delta is invalid");
  if (
    !hasOptionalString(delta, "content") ||
    !hasOptionalString(delta, "reasoning_content") ||
    !hasOptionalString(value, "finish_reason")
  ) {
    return openAiProtocolError("provider choice fields are invalid");
  }
  const rawToolCalls = delta["tool_calls"];
  const toolCalls: ToolCall[] = [];
  if (rawToolCalls !== undefined) {
    if (!Array.isArray(rawToolCalls))
      return openAiProtocolError("provider tool calls are not an array");
    for (const raw of rawToolCalls) {
      const parsed = parseToolCall(raw);
      if (parsed instanceof Error) return parsed;
      toolCalls.push(parsed);
    }
  }
  const content = optionalString(delta, "content");
  const reasoningContent = optionalString(delta, "reasoning_content");
  const finishReason = optionalString(value, "finish_reason");
  return {
    content: content ?? null,
    ...(reasoningContent !== undefined ? { reasoningContent } : {}),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    ...(finishReason !== undefined ? { finishReason } : {}),
  };
}

function parseToolCall(value: unknown): ToolCall | Error {
  if (!isRecord(value))
    return openAiProtocolError("provider tool call is invalid");
  const fn = value["function"];
  if (!isRecord(fn))
    return openAiProtocolError("provider tool call function is invalid");
  const index = value["index"];
  if (
    !hasOptionalString(value, "id") ||
    !hasOptionalString(value, "type") ||
    !hasOptionalString(fn, "name") ||
    !hasOptionalString(fn, "arguments") ||
    (index !== undefined &&
      (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0))
  ) {
    return openAiProtocolError("provider tool call fields are invalid");
  }
  return {
    ...(typeof index === "number" ? { index } : {}),
    id: optionalString(value, "id") ?? "",
    type: optionalString(value, "type") ?? "",
    function: {
      name: optionalString(fn, "name") ?? "",
      arguments: optionalString(fn, "arguments") ?? "",
    },
  };
}

/** 三个 token 计数要么齐全且为无符号安全整数，要么整块判错——半份用量比没有用量更危险。 */
function parseUsage(value: unknown): TokenUsage | Error | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value))
    return openAiProtocolError("provider usage is not an object");
  const promptTokens = requiredNumber(value, "prompt_tokens");
  const completionTokens = requiredNumber(value, "completion_tokens");
  const totalTokens = requiredNumber(value, "total_tokens");
  if (
    promptTokens === undefined ||
    completionTokens === undefined ||
    totalTokens === undefined
  ) {
    return openAiProtocolError("provider usage contains invalid token counts");
  }
  return { promptTokens, completionTokens, totalTokens };
}

/**
 * 让 `reader.read()` 可被取消：Web Streams 的读取不感知 `AbortSignal`，
 * 只能把「读取完成」与「收到取消」赛跑。
 *
 * `finally` 里必须摘掉监听器——一次运行里会做很多次 read，
 * 若每次都往同一个长生命周期的 signal 上挂监听，监听器会线性累积。
 * 开头的 `signal.aborted` 短路则保证已取消的信号不会先挂上监听再立刻 reject。
 */
async function readWithAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<StreamReadResult> {
  if (signal.aborted) throw abortError(signal);
  let onAbort: (() => void) | undefined;
  const cancelled = new Promise<never>((_resolve, reject): void => {
    onAbort = (): void => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([reader.read(), cancelled]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

/**
 * 取出一条 SSE 行的载荷，非 `data:` 行（注释、`event:`、空行）返回 undefined。
 * 先剥掉行尾的 `\r` 以同时兼容 CRLF；`data:` 后的一个空格按 SSE 规范是分隔符而非内容，
 * 只剥一个。
 */
function lineData(line: string): string | undefined {
  const normalized = line.endsWith("\r") ? line.slice(0, -1) : line;
  if (!normalized.startsWith("data:")) return undefined;
  const value = normalized.slice("data:".length);
  return value.startsWith(" ") ? value.slice(1) : value;
}

function optionalString(
  record: Record<string, unknown>,
  key: string,
): string | null | undefined {
  const value = record[key];
  if (value === undefined || value === null) return value;
  return typeof value === "string" ? value : undefined;
}

function hasOptionalString(
  record: Record<string, unknown>,
  key: string,
): boolean {
  const value = record[key];
  return value === undefined || value === null || typeof value === "string";
}

function requiredNumber(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorEvent(error: Error): ParsedEvent {
  return { done: true, chunks: [{ content: null, error }] };
}
