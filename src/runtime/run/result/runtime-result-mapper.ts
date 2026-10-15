import type { ContentRef } from "../../../protocol/content-reference.js";
import { serializeInterrupt } from "../../../protocol/interrupt.js";
import type { JsonObject, JsonValue } from "../../../protocol/json.js";
import {
  serializeRawMessage,
  type RawMessage,
} from "../../../protocol/message.js";
import { cloneCheckpoint } from "../../checkpoint/codec/checkpoint-clone.js";
import { serializeCheckpoint } from "../../checkpoint/codec/checkpoint-codec.js";
import type {
  Checkpoint,
  CheckpointStatus,
} from "../../checkpoint/model/checkpoint.js";
import type { CheckpointRecord } from "../../checkpoint/store/port/checkpoint-store.js";
import type { RuntimeResult } from "./runtime-result.js";

/**
 * Runtime 结果与 checkpoint 之间的纯映射；不执行模型、工具或持久化。
 *
 * 本文件所有 `clone*` 函数都做深拷贝到消息与嵌套对象的层级，原因与 checkpoint 侧一致：
 * 调用方拿到的结果不能与 Runtime 内部状态共享可变引用，否则调用方的一次手滑改写
 * 会隔着几层影响后续持久化。`ContentRef.fetch` 是唯一按引用带过去的字段——它是函数。
 * @param result - 待拷贝的结果；消息与嵌套对象会被深拷贝，`ContentRef.fetch` 仍按引用带过去。
 * @returns 与输入结构相同的副本；调用方改写它不会影响 Runtime 内部状态。
 */
export function cloneRuntimeResult(result: RuntimeResult): RuntimeResult {
  return {
    status: result.status,
    output: result.output,
    messages: cloneRuntimeMessages(result.messages),
    ...(result.interrupt ? { interrupt: { ...result.interrupt } } : {}),
    tokensUsed: result.tokensUsed,
    finishReason: result.finishReason,
    checkpoint: cloneCheckpoint(result.checkpoint),
    revision: result.revision,
  };
}

/**
 * 造一个空 Checkpoint。`version` 固定为 1（0 只属于未落盘的内存态），
 * `messages` 会被深拷贝——传入的数组通常是调用方自己的，不能共享。
 * @param threadId - 新 Checkpoint 的 thread 标识。
 * @param userId - 新 Checkpoint 的所有者；空串表示未声明身份。
 * @param status - 起始状态；调用方据此表达这是失败、取消还是别的终止。
 * @param messages - 起始消息序列，会被深拷贝，不与调用方共享数组。
 * @returns version 固定为 1、内容引用与计费字段为空的 Checkpoint。
 */
export function emptyRuntimeCheckpoint(
  threadId: string,
  userId: string,
  status: CheckpointStatus,
  messages: readonly RawMessage[],
): Checkpoint {
  return {
    version: 1,
    threadId,
    userId,
    status,
    messages: cloneRuntimeMessages(messages),
    contentRefs: [],
    lastResumeInterrupt: "",
    tokensUsed: 0,
    finishReason: "",
  };
}

/**
 * 由 Checkpoint 构造结果。**revision 恒为 0n**：传入的只是内容，不含 Store 版本。
 * 需要真实 revision 时必须走 `runtimeResultFromRecord`——0n 在这里表示「未知」，
 * 不是一个可以直接拿去 CAS 的期望值。
 * @param checkpointInput - 作为结果内容的 Checkpoint；会被克隆，不会被就地修改。
 * @returns revision 恒为 0n 的结果；需要真实 revision 时应改用 `runtimeResultFromRecord`。
 */
export function runtimeResultFromCheckpoint(
  checkpointInput: Checkpoint,
): RuntimeResult {
  const checkpoint = cloneCheckpoint(checkpointInput);
  return {
    status: checkpoint.status,
    output: lastAssistantOutput(checkpoint.messages),
    messages: cloneRuntimeMessages(checkpoint.messages),
    ...(checkpoint.interrupt ? { interrupt: { ...checkpoint.interrupt } } : {}),
    tokensUsed: checkpoint.tokensUsed,
    finishReason: checkpoint.finishReason,
    checkpoint,
    revision: 0n,
  };
}

/**
 * 由 Store 记录构造结果——与 `runtimeResultFromCheckpoint` 的唯一差别是把真实 revision 带出来。
 * @param record - Store 返回的记录；其 revision 反映该记录在 Store 中的版本。
 * @returns 携带真实 revision 的结果，可据此参与后续 CAS。
 */
export function runtimeResultFromRecord(
  record: CheckpointRecord,
): RuntimeResult {
  const result = runtimeResultFromCheckpoint(record.checkpoint);
  result.revision = record.revision;
  return result;
}

/**
 * 序列化结果，遵循与 Checkpoint codec 相同的「空值即缺席」约定：
 * 空串、0、空数组都不写进 payload，因此同一结果的输出逐字节稳定。
 * revision 为 0n 时同样省略——它表示「未知」，写个 `"revision": 0` 反而像是真的第 0 版。
 * @param result - 待序列化的结果；空值字段（空串、0、空数组）与 revision 为 0n 时会被省略。
 * @returns 稳定的 JSON 对象；同一结果的输出逐字节可复现。
 */
export function serializeRuntimeResult(result: RuntimeResult): JsonObject {
  const payload: Record<string, JsonValue> = {
    status: result.status,
    checkpoint: serializeCheckpoint(result.checkpoint),
  };
  if (result.output !== "") payload["output"] = result.output;
  if (result.messages.length > 0)
    payload["messages"] = result.messages.map(serializeRawMessage);
  if (result.interrupt)
    payload["interrupt"] = serializeInterrupt(result.interrupt);
  if (result.tokensUsed !== 0) payload["tokens_used"] = result.tokensUsed;
  if (result.finishReason !== "")
    payload["finish_reason"] = result.finishReason;
  if (result.revision !== 0n)
    payload["revision"] = revisionToJson(result.revision);
  return payload;
}

/**
 * 逐条深拷贝消息；`toolCalls.function` 也是新建对象，不共享引用。
 * @param messages - 待拷贝的消息序列；只读取，不修改传入的数组。
 * @returns 元素全部为新对象的消息数组。
 */
export function cloneRuntimeMessages(
  messages: readonly RawMessage[],
): RawMessage[] {
  return messages.map(cloneMessage);
}

/**
 * 拷贝内容引用。浅展开 + 复制 `meta` 即可——`fetch` 是函数，必须按引用带过去
 * （`structuredClone` 会直接失败），其余字段都是值类型。
 * @param reference - 待拷贝的内容引用；`fetch` 是函数，必须按引用带过去。
 * @returns 浅展开并复制了 `meta` 的引用；其余字段都是值类型，可直接搬运。
 */
export function cloneRuntimeContentRef(reference: ContentRef): ContentRef {
  return {
    ...reference,
    ...(reference.meta ? { meta: { ...reference.meta } } : {}),
  };
}

/**
 * 逐字段重建一条消息，`toolCalls` 及其内层 `function` 再各复制一层。
 *
 * 与 checkpoint 侧的同名函数一致，但结果侧不需要保留 `ContentRef.fetch` 的引用语义，
 * 因此只需覆盖消息本身的可变嵌套结构。
 *
 * @param message - 待复制的消息；调用方保留原对象所有权
 * @returns 与入参等值但无共享可变嵌套结构的独立消息
 */
function cloneMessage(message: RawMessage): RawMessage {
  return {
    role: message.role,
    content: message.content,
    ...(message.toolCalls
      ? {
          toolCalls: message.toolCalls.map((call) => ({
            ...call,
            function: { ...call.function },
          })),
        }
      : {}),
    ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
    ...(message.name ? { name: message.name } : {}),
  };
}

/**
 * 把 revision 降级为可写入 JSON 的 number；超出安全整数范围即拒绝。
 *
 * 结果序列化只在 revision 非 0n 时调用它，0n 表示「未知」会被整体省略。
 * 静默截断会让宿主读回一个看似合理却错误的版本号，因此宁可抛错。
 *
 * @param revision - 待降级的 bigint 版本号；为负或超出安全整数范围即抛 RangeError
 * @returns 可安全写入 JSON 的 number 形式版本号
 */
function revisionToJson(revision: bigint): number {
  const value = Number(revision);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("runtime 结果的 revision 超出 JSON 安全整数范围");
  }
  return value;
}

/**
 * 取最后一条有正文的 assistant 消息作为 `output`。
 *
 * 倒序扫描而非取末条：末条可能是工具调用轮次的 assistant 消息（`content` 为 null），
 * 也可能是工具结果。跳过 null 正文才能拿到模型真正说过的话。
 * 全都没有时返回空串，由调用方结合 status 判断这是不是一种失败。
 *
 * @param messages - 本次运行的消息序列；只读不改
 * @returns 最后一条有正文的 assistant 消息内容，没有则为空串
 */
function lastAssistantOutput(messages: readonly RawMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant" && message.content !== null)
      return message.content;
  }
  return "";
}
