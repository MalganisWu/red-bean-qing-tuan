import type { ContentRef } from "../../../protocol/content-reference.js";
import type { RawMessage } from "../../../protocol/message.js";

/** 内容引用读取 Port；SDK 没有默认实现，宿主在构造 DefaultRestorer 时显式注入。 */
export interface ContentResolver {
  /**
   * 读取一条内容引用的原始字节，供压缩后的内容恢复使用。
   *
   * @param reference - 待读取的内容引用，携带 key 与可选的写入期抓取方式。
   * @param signal - 取消信号，透传给底层读取；已中止时应尽快以取消原因拒绝。
   * @returns 该引用对应内容的原始字节，格式不做假设、由恢复方自行解码。
   */
  resolve(reference: ContentRef, signal: AbortSignal): Promise<Uint8Array>;
}

/** 压缩后按预算恢复内容引用的能力；SDK 默认实现为由宿主直接构造的 DefaultRestorer。 */
export interface PostCompactRestorer {
  /**
   * 把一批内容引用恢复成可注入对话的 user 消息。
   *
   * 失败策略由实现决定，但语义定位为「尽力而为」：单份内容取不到不应阻断其余恢复，
   * 也不应让已经有效的摘要作废。
   *
   * @param references - 待恢复的内容引用，实现自行按时间戳与预算筛选。
   * @param signal - 取消信号，透传给引用自带的抓取方式或宿主的 resolver。
   * @returns 伪装成工具结果注入的 user 消息列表；取不到内容的引用被跳过。
   */
  buildAttachments(
    references: readonly ContentRef[],
    signal: AbortSignal,
  ): Promise<readonly RawMessage[]>;
}
