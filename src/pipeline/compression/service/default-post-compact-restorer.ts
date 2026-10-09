import type { ContentRef } from "../../../protocol/content-reference.js";
import type { RawMessage } from "../../../protocol/message.js";
import type {
  ContentResolver,
  PostCompactRestorer,
} from "../port/content-restoration.js";
import { estimateTokens } from "../token-counter.js";

const DEFAULT_MAX_TOKENS_PER_REFERENCE = 5_000;
const DEFAULT_TOTAL_BUDGET = 50_000;
const DEFAULT_MAX_FILES = 5;
const TRUNCATION_MARKER =
  "\n\n... [content truncated; use Read on the path for the full content]";

/** 默认内容恢复器的预算和宿主解析器配置。 */
export interface RestorerOptions {
  readonly resolver?: ContentResolver | undefined;
  readonly maxTokensPerReference?: number | undefined;
  readonly totalBudget?: number | undefined;
  readonly maxFiles?: number | undefined;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0
    ? value
    : fallback;
}

export function truncateHeadToTokens(
  data: Uint8Array,
  maxTokens: number,
): Uint8Array {
  const maxBytes = maxTokens * 4;
  if (data.byteLength <= maxBytes) return data;
  const marker = new TextEncoder().encode(TRUNCATION_MARKER);
  const output = new Uint8Array(maxBytes + marker.byteLength);
  output.set(data.subarray(0, maxBytes), 0);
  output.set(marker, maxBytes);
  return output;
}

function buildRestoreAttachment(
  reference: ContentRef,
  data: Uint8Array,
): RawMessage {
  const content = new TextDecoder().decode(data);
  return {
    role: "user",
    content: `<system-reminder>
<tool_use>Read(${JSON.stringify(reference.key)})</tool_use>
<tool_result>
${content}
</tool_result>
</system-reminder>`,
  };
}

/** 按文件数和 Token 预算恢复内容引用；单个引用读取失败不会阻断其余恢复。 */
export class DefaultRestorer implements PostCompactRestorer {
  readonly #resolver: ContentResolver | undefined;
  readonly #maxTokensPerReference: number;
  readonly #totalBudget: number;
  readonly #maxFiles: number;

  public constructor(options: RestorerOptions = {}) {
    this.#resolver = options.resolver;
    this.#maxTokensPerReference = positiveInteger(
      options.maxTokensPerReference,
      DEFAULT_MAX_TOKENS_PER_REFERENCE,
    );
    this.#totalBudget = positiveInteger(
      options.totalBudget,
      DEFAULT_TOTAL_BUDGET,
    );
    this.#maxFiles = positiveInteger(options.maxFiles, DEFAULT_MAX_FILES);
  }

  public async buildAttachments(
    references: readonly ContentRef[],
    signal: AbortSignal,
  ): Promise<readonly RawMessage[]> {
    const selected = [...references]
      .sort(
        (left: ContentRef, right: ContentRef): number =>
          (right.timestamp ?? 0) - (left.timestamp ?? 0),
      )
      .slice(0, this.#maxFiles);
    const messages: RawMessage[] = [];
    let totalTokens = 0;

    for (const reference of selected) {
      let data: Uint8Array;
      try {
        if (reference.fetch) data = await reference.fetch(signal);
        else if (this.#resolver) {
          data = await this.#resolver.resolve(reference, signal);
        } else {
          continue;
        }
      } catch {
        continue;
      }

      const message = buildRestoreAttachment(
        reference,
        truncateHeadToTokens(data, this.#maxTokensPerReference),
      );
      totalTokens += estimateTokens([message]);
      if (totalTokens > this.#totalBudget) break;
      messages.push(message);
    }
    return messages;
  }
}
