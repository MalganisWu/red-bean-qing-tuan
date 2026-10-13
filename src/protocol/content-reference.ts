/** `RuntimeContext.metadata` 中存放内容引用列表的键；压缩后的内容恢复按它取引用。 */
export const CONTENT_REFS_METADATA_KEY = "content_refs";

/** 可跨 checkpoint 保存的内容定位信息；fetch 仅供当前进程读取，序列化时必须移除。 */
export interface ContentRef {
  /** 内容类别标签，决定 `key` 与 `version` 的解释方式（如 `file`、`artifact`）。 */
  readonly kind: string;
  /** 内容在 `kind` 命名空间内的定位键；跨 checkpoint 稳定，是恢复内容的主索引。 */
  readonly key: string;
  /** 内容版本；同一 `key` 的不同版本借此区分，未设置表示不参与版本比对。 */
  readonly version?: string | undefined;
  /** 宿主附加的字符串元数据；空对象与未设置等价，序列化时不写出。 */
  readonly meta?: Readonly<Record<string, string>> | undefined;
  /** 内容产生时间戳（毫秒）；`0` 与未设置等价，序列化时不写出。 */
  readonly timestamp?: number | undefined;
  /** 进程内读取闭包，按需拉取字节；跨进程无意义，序列化时恒被剥离。 */
  readonly fetch?: ((signal: AbortSignal) => Promise<Uint8Array>) | undefined;
}

/**
 * 去除进程内 fetch 函数，仅保留可稳定序列化的内容引用描述。
 *
 * @param reference - 待序列化的内容引用；`fetch` 是进程内闭包，恒被剥离而不进入输出。
 * @returns 键序固定为 `kind`、`key` 再按需追加可选字段的 JSON 对象；`version` 为空、
 *   `meta` 为空对象、`timestamp` 为 `undefined`/`0` 时不写出该字段，故可参与快照比对。
 */
export function serializeContentRef(reference: ContentRef): JsonObject {
  const payload: Record<string, JsonValue> = {
    kind: reference.kind,
    key: reference.key,
  };
  if (reference.version) payload["version"] = reference.version;
  if (reference.meta && Object.keys(reference.meta).length > 0) {
    payload["meta"] = { ...reference.meta };
  }
  if (reference.timestamp !== undefined && reference.timestamp !== 0) {
    payload["timestamp"] = reference.timestamp;
  }
  return payload;
}
import type { JsonObject, JsonValue } from "./json.js";
