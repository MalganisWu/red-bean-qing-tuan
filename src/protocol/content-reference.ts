/** `RuntimeContext.metadata` 中存放内容引用列表的键；压缩后的内容恢复按它取引用。 */
export const CONTENT_REFS_METADATA_KEY = "content_refs";

/** 可跨 checkpoint 保存的内容定位信息；fetch 仅供当前进程读取，序列化时必须移除。 */
export interface ContentRef {
  readonly kind: string;
  readonly key: string;
  readonly version?: string | undefined;
  readonly meta?: Readonly<Record<string, string>> | undefined;
  readonly timestamp?: number | undefined;
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
