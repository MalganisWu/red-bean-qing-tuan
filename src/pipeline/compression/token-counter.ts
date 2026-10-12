import type { RawMessage } from "../../protocol/message.js";

/**
 * 粗略估算，**不是**真实分词：ASCII 约 4 字符 1 Token，非 ASCII 按 1 字符 1 Token。
 *
 * 之所以不用真分词器：它会引入一个生产依赖与一份词表，而这里要的只是一个触发压缩的量级判断，
 * 差 10% 完全不影响决策。非 ASCII 单独计数是刻意的——中日韩文本在多数分词器里接近 1:1，
 * 若沿用 4 字符 1 Token 的换算，中文会被严重低估，压缩该触发时不触发。
 */
function estimateTextTokens(value: string): number {
  let asciiCharacters = 0;
  let nonAsciiCharacters = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && codePoint < 128) {
      asciiCharacters += 1;
    } else {
      nonAsciiCharacters += 1;
    }
  }
  return Math.floor((asciiCharacters + 3) / 4) + nonAsciiCharacters;
}

/** 统计消息正文与工具调用的名称、参数；不含角色名与消息骨架的固定开销。 */
export function estimateTokens(messages: readonly RawMessage[]): number {
  let total = 0;
  for (const message of messages) {
    if (message.content !== null) total += estimateTextTokens(message.content);
    for (const call of message.toolCalls ?? []) {
      total += estimateTextTokens(call.function.name);
      total += estimateTextTokens(call.function.arguments);
    }
  }
  return total;
}
