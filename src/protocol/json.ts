/** Runtime 可稳定序列化的 JSON 原子值。 */
export type JsonPrimitive = boolean | null | number | string;

/** 所有跨进程协议载荷允许使用的递归 JSON 值。 */
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;

/** 不携带原型或方法的 JSON 对象。 */
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

/**
 * 归一化普通对象，逐个自有字符串键递归校验并复制。
 *
 * 拒绝非普通原型、符号键与访问器属性：这些形态绕过 JSON 语义，放行会在序列化时静默丢字段。
 *
 * @param value - 待归一化的对象；本函数不再检查其类型，由调用方保证是 `object`。
 * @param ancestors - 当前递归路径上的祖先，用于识别环引用；进入时加入、退出时移除。
 * @returns 与输入等值的新普通对象，不共享引用。
 * @throws TypeError 输入含环、符号键或访问器属性时抛出。
 */
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

/**
 * 归一化任意未知值为 JSON 值，递归处理数组与对象。
 *
 * 原子值按值返回（数字要求有限），数组与对象走递归复制；其它类型（函数、bigint、symbol、
 * undefined）一律拒绝而非丢弃，避免不可信输入被静默裁剪成合法 JSON。
 *
 * @param value - 来自外部的未知输入，可能是任意类型。
 * @param ancestors - 当前递归路径上的祖先，用于识别环引用。
 * @returns 与输入等值的 JSON 值，不共享引用。
 * @throws TypeError 输入含非有限数、环引用或不可序列化类型时抛出。
 */
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

/**
 * 校验并复制不可信输入，使其进入 Runtime 的 JSON 值域。
 *
 * @param value - 来自外部的未知输入；必须是普通对象且不含环、非有限数、符号键与访问器属性。
 * @returns 与输入等值的新副本，不共享引用；含上述任一违例时抛 `TypeError` 而非静默裁剪。
 */
export function toJsonValue(value: unknown): JsonValue {
  return normalizeJsonValue(value, new Set<object>());
}
