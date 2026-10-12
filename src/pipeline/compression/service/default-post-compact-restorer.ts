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

/**
 * 按 4 字节/Token 的粗略换算截断，保留**头部**。
 *
 * 保留头部而不是尾部：内容引用的多半是文件，文件开头（导入、声明、结构）比结尾更有用，
 * 而且截断标记会明确告诉模型「后面还有，自己去 Read」。
 * 按字节切可能切断一个多字节字符，但这里只是喂给模型的近似文本，代价可以接受。
 */
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

/**
 * 把恢复出来的内容伪装成一条 **Read 工具结果**再作为 user 消息注入。
 *
 * 这不是为了好看：压缩会丢掉「读过哪些文件」这一事实，而写入类工具依赖「先读后写」的闸门
 * （见内置工具的安全模型）。以工具结果的形式回放，模型和工具层都能把这次读取计入账，
 * 后续写入才不会被安全闸门拒掉。用 `system-reminder` 包裹则是为了明确这是系统注入的上下文，
 * 而非用户真的说了这些话。
 */
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

  /**
   * 按「最新优先、限额、预算」三重约束恢复。
   *
   * 三条边界各管一件事：`maxFiles` 限条数（避免把十几份文件都塞回去）、
   * `maxTokensPerReference` 限单份长度、`totalBudget` 限总量。
   * 排序取时间戳最新的一批——刚访问过的内容最可能与当前任务相关。
   *
   * 失败策略是「跳过」而非「中止」：单份内容取不到（文件已删、权限不足）不影响其余恢复。
   * 超预算时用 `break` 而不是 `continue`，因为预算是总量约束，后面的条目只会更少机会。
   */
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
        // 引用自带 fetch 时优先用它：它绑定了写入时的读取方式与权限上下文，
        // 比宿主的通用 resolver 更准确。
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
