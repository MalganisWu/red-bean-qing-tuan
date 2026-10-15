import type { ToolCallContext } from "../../../protocol/run-identity.js";
import type { JsonObject, JsonValue } from "../../../protocol/json.js";
import type { Tool, ToolResult, ToolSchema } from "../../definition/tool.js";

/** 未指定 timezone 时使用的默认时区。 */
export const DEFAULT_TIMEZONE = "Asia/Shanghai";

/** 某一时区下拆分出的各时间字段，以及与 UTC 的偏移量。 */
interface ZonedParts {
  /** 四位年份字符串。 */
  readonly year: string;
  /** 两位月份字符串（01-12）。 */
  readonly month: string;
  /** 两位日期字符串（01-31）。 */
  readonly day: string;
  /** 两位小时字符串，24 小时制（00-23）。 */
  readonly hour: string;
  /** 两位分钟字符串（00-59）。 */
  readonly minute: string;
  /** 两位秒字符串（00-59）。 */
  readonly second: string;
  /** UTC 偏移量，紧凑格式，如 `+0800`。 */
  readonly offset: string;
  /** UTC 偏移量，带冒号格式，如 `+08:00`。 */
  readonly colonOffset: string;
}

/**
 * 判断 JSON 值是否为非数组的普通对象，用于把 unknown 形状的入参收窄。
 *
 * @param value - 待判定的 JSON 值，为 null 或数组时返回 false
 * @returns 是普通对象则为 true，供类型守卫收窄到 `JsonObject`
 */
function isObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 读取一个可选的字符串字段，缺失或为 null 时回退为空串。
 *
 * @param value - 工具入参对象
 * @param key - 要读取的字段名，也会出现在类型错误消息里便于定位
 * @returns 字段的字符串值；缺失或为 null 时为空串
 */
function optionalString(value: JsonObject, key: string): string {
  const field = value[key];
  if (field === undefined || field === null) return "";
  if (typeof field !== "string") throw new Error(`${key} 必须是字符串`);
  return field;
}

/**
 * 从 `Intl.DateTimeFormat#formatToParts` 的结果里取出指定类型的分量。
 *
 * @param parts - `formatToParts` 返回的分量数组
 * @param type - 想要的分量类型，如 `year` / `hour`
 * @returns 对应分量的文本；该时区下不存在该分量时为空串
 */
function part(
  parts: readonly Intl.DateTimeFormatPart[],
  type: Intl.DateTimeFormatPartTypes,
): string {
  return parts.find((candidate) => candidate.type === type)?.value ?? "";
}

/**
 * 把分钟数的 UTC 偏移量格式化成 `±HH:MM` 或 `±HHMM`。
 *
 * @param offsetMinutes - 相对 UTC 的偏移分钟数，正负号直接决定前缀
 * @param separator - 时与分之间的分隔符，传空串得到紧凑格式
 * @returns 形如 `+08:00`（分隔符为 `:`）或 `-0500`（分隔符为空）的偏移量文本
 */
function formatOffset(offsetMinutes: number, separator: string): string {
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absolute = Math.abs(offsetMinutes);
  const hours = Math.floor(absolute / 60)
    .toString()
    .padStart(2, "0");
  const minutes = (absolute % 60).toString().padStart(2, "0");
  return `${sign}${hours}${separator}${minutes}`;
}

/**
 * 用 `Intl` 在指定时区下拆分一个时间点，并算出相对 UTC 的偏移量。
 *
 * 偏移量由「本地字段重拼成的 UTC 时间戳」与真实时间戳之差得到，因此无需查时区表；
 * 时区名非法时抛出带 `cause` 的异常。
 *
 * @param value - 要拆分的时间点
 * @param timeZone - IANA 时区名，非法时抛出异常
 * @returns 该时区下的各时间字段与偏移量
 */
function zonedParts(value: Date, timeZone: string): ZonedParts {
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-US-u-nu-latn", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
  } catch (cause: unknown) {
    throw new Error(`时区非法：${JSON.stringify(timeZone)}`, { cause });
  }
  const parts = formatter.formatToParts(value);
  const year = part(parts, "year");
  const month = part(parts, "month");
  const day = part(parts, "day");
  const hour = part(parts, "hour");
  const minute = part(parts, "minute");
  const second = part(parts, "second");
  const representedUtc = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );
  const instantAtSecond = Math.floor(value.getTime() / 1_000) * 1_000;
  const offsetMinutes = Math.round((representedUtc - instantAtSecond) / 60_000);
  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    offset: formatOffset(offsetMinutes, ""),
    colonOffset: formatOffset(offsetMinutes, ":"),
  };
}

/**
 * 按 strftime 子集把时间字段替换进格式串。
 *
 * @param format - 格式串，支持 `%Y %m %d %H %M %S %z %:z %%`，其余字符原样保留
 * @param parts - 已拆分好的时区时间字段
 * @returns 替换占位符后的格式化时间文本
 */
function formatStrftime(format: string, parts: ZonedParts): string {
  const replacements: Readonly<Record<string, string>> = {
    "%%": "%",
    "%Y": parts.year,
    "%m": parts.month,
    "%d": parts.day,
    "%H": parts.hour,
    "%M": parts.minute,
    "%S": parts.second,
    "%z": parts.offset,
    "%:z": parts.colonOffset,
  };
  return format.replace(
    /%(?::z|[%YmdHMSz])/gu,
    (token: string): string => replacements[token] ?? token,
  );
}

/** 暴露给模型的 JSON Schema 入参：可选的 `format` 与 `timezone`，无必填字段。 */
const TIME_PARAMETERS: JsonObject = {
  type: "object",
  properties: {
    format: {
      type: "string",
      description:
        "时间格式，strftime 语法；支持 %Y %m %d %H %M %S %z %:z %%，默认 %Y-%m-%dT%H:%M:%S%:z",
    },
    timezone: {
      type: "string",
      description: "IANA 时区名；默认 Asia/Shanghai",
    },
  },
  required: [],
};

/** 使用显式或默认时区返回格式化时间的无副作用内置工具。 */
export class GetTimeTool implements Tool {
  /** 本工具在 Tool Registry 中的注册名，Agent 的 sys_tool_ids 用它引用。 */
  public readonly name = "sys_get_time";
  /** 工具契约：函数名、给模型的说明与 JSON Schema 入参。 */
  public readonly schema: ToolSchema = {
    type: "function",
    function: {
      name: this.name,
      description: "获取当前系统时间和秒级 Unix 时间戳",
      parameters: TIME_PARAMETERS,
    },
  };
  /**
   * 取当前时间的函数；默认读系统时钟，注入后便于测试固定时间点。
   *
   * @returns 当前时刻的 `Date`。
   */
  readonly #now: () => Date;

  public constructor(now: () => Date = (): Date => new Date()) {
    this.#now = now;
  }

  /**
   * 按显式或默认时区格式化当前时间。失败（时区非法、时钟返回无效日期）以 rejected Promise 返回，
   * 不抛出同步异常。
   *
   * @param params - 工具入参原始值，可选 `timezone` 与 `format` 字段，未校验
   * @param _context - 未使用；保留以满足 `Tool` 契约
   * @param signal - 取消信号，已中止时立即以 rejected Promise 返回
   * @returns JSON 文本，含 Unix 时间戳、格式化时间与所用时区
   */
  public execute(
    params: JsonValue,
    _context: ToolCallContext,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    if (signal.aborted) {
      return Promise.reject(
        signal.reason instanceof Error
          ? signal.reason
          : new DOMException("operation aborted", "AbortError"),
      );
    }
    if (!isObject(params)) {
      return Promise.reject(new Error("time 的参数必须是对象"));
    }
    try {
      const timezone = optionalString(params, "timezone") || DEFAULT_TIMEZONE;
      const format = optionalString(params, "format") || "%Y-%m-%dT%H:%M:%S%:z";
      const now = this.#now();
      if (!Number.isFinite(now.getTime()))
        throw new Error("clock 返回了非法日期");
      const result = {
        unix: Math.floor(now.getTime() / 1_000),
        iso: formatStrftime(format, zonedParts(now, timezone)),
        timezone,
      };
      return Promise.resolve({ content: JSON.stringify(result) });
    } catch (cause: unknown) {
      return Promise.reject(
        cause instanceof Error ? cause : new Error(String(cause)),
      );
    }
  }
}
