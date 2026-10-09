import type { ToolCallContext } from "../../../protocol/run-identity.js";
import type { JsonObject, JsonValue } from "../../../protocol/json.js";
import type { Tool, ToolResult, ToolSchema } from "../../definition/tool.js";

export const DEFAULT_TIMEZONE = "Asia/Shanghai";

interface ZonedParts {
  readonly year: string;
  readonly month: string;
  readonly day: string;
  readonly hour: string;
  readonly minute: string;
  readonly second: string;
  readonly offset: string;
  readonly zoneOffset: string;
}

function isObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: JsonObject, key: string): string {
  const field = value[key];
  if (field === undefined || field === null) return "";
  if (typeof field !== "string") throw new Error(`${key} must be a string`);
  return field;
}

function part(
  parts: readonly Intl.DateTimeFormatPart[],
  type: Intl.DateTimeFormatPartTypes,
): string {
  return parts.find((candidate) => candidate.type === type)?.value ?? "";
}

function formatOffset(offsetMinutes: number, useZulu: boolean): string {
  if (useZulu && offsetMinutes === 0) return "Z";
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absolute = Math.abs(offsetMinutes);
  const hours = Math.floor(absolute / 60)
    .toString()
    .padStart(2, "0");
  const minutes = (absolute % 60).toString().padStart(2, "0");
  return `${sign}${hours}:${minutes}`;
}

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
    throw new Error(`invalid time zone ${JSON.stringify(timeZone)}`, { cause });
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
    offset: formatOffset(offsetMinutes, false),
    zoneOffset: formatOffset(offsetMinutes, true),
  };
}

function formatGoLayout(layout: string, parts: ZonedParts): string {
  const replacements: Readonly<Record<string, string>> = {
    "2006": parts.year,
    "01": parts.month,
    "02": parts.day,
    "15": parts.hour,
    "04": parts.minute,
    "05": parts.second,
    "Z07:00": parts.zoneOffset,
    "-07:00": parts.offset,
  };
  return layout.replace(
    /Z07:00|-07:00|2006|01|02|15|04|05/g,
    (token: string): string => replacements[token] ?? token,
  );
}

const TIME_PARAMETERS: JsonObject = {
  type: "object",
  properties: {
    format: {
      type: "string",
      description: "时间格式，使用 Go layout；默认 RFC3339",
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
  public readonly name = "sys_get_time";
  public readonly schema: ToolSchema = {
    type: "function",
    function: {
      name: this.name,
      description: "获取当前系统时间和秒级 Unix 时间戳",
      parameters: TIME_PARAMETERS,
    },
  };
  readonly #now: () => Date;

  public constructor(now: () => Date = (): Date => new Date()) {
    this.#now = now;
  }

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
      return Promise.reject(new Error("time parameters must be an object"));
    }
    try {
      const timezone = optionalString(params, "timezone") || DEFAULT_TIMEZONE;
      const layout =
        optionalString(params, "format") || "2006-01-02T15:04:05Z07:00";
      const now = this.#now();
      if (!Number.isFinite(now.getTime()))
        throw new Error("clock returned an invalid date");
      const result = {
        unix: Math.floor(now.getTime() / 1_000),
        iso: formatGoLayout(layout, zonedParts(now, timezone)),
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
