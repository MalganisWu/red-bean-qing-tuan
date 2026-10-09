import type { ContentRef } from "../../../protocol/content-reference.js";
import type { RawMessage } from "../../../protocol/message.js";

/** 内容引用读取 Port；SDK 没有默认实现，宿主在构造 DefaultRestorer 时显式注入。 */
export interface ContentResolver {
  resolve(reference: ContentRef, signal: AbortSignal): Promise<Uint8Array>;
}

/** 压缩后按预算恢复内容引用的能力；SDK 默认实现为由宿主直接构造的 DefaultRestorer。 */
export interface PostCompactRestorer {
  buildAttachments(
    references: readonly ContentRef[],
    signal: AbortSignal,
  ): Promise<readonly RawMessage[]>;
}
