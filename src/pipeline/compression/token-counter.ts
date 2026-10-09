import type { RawMessage } from "../../protocol/message.js";

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
