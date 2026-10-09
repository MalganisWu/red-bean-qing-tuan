/** Runtime 可稳定序列化的 JSON 原子值。 */
export type JsonPrimitive = boolean | null | number | string;

/** 所有跨进程协议载荷允许使用的递归 JSON 值。 */
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;

/** 不携带原型或方法的 JSON 对象。 */
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

function normalizeObject(value: object, ancestors: Set<object>): JsonObject {
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("value is not a plain JSON object");
  }
  if (ancestors.has(value))
    throw new TypeError("value contains a circular JSON reference");

  ancestors.add(value);
  try {
    const result: Record<string, JsonValue> = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string")
        throw new TypeError("JSON object contains a symbol key");
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) {
        throw new TypeError("JSON object contains an accessor property");
      }
      const nestedValue: unknown = descriptor.value;
      result[key] = normalizeJsonValue(nestedValue, ancestors);
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

function normalizeJsonValue(value: unknown, ancestors: Set<object>): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new TypeError("JSON number must be finite");
    return value;
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value))
      throw new TypeError("value contains a circular JSON reference");
    ancestors.add(value);
    try {
      return value.map((item) => normalizeJsonValue(item, ancestors));
    } finally {
      ancestors.delete(value);
    }
  }
  if (typeof value === "object") return normalizeObject(value, ancestors);
  throw new TypeError(`value of type ${typeof value} is not valid JSON`);
}

/** 校验并复制不可信输入，使其进入 Runtime 的 JSON 值域。 */
export function toJsonValue(value: unknown): JsonValue {
  return normalizeJsonValue(value, new Set<object>());
}
