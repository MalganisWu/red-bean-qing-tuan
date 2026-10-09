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

/** 去除进程内 fetch 函数，仅保留可稳定序列化的内容引用描述。 */
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
