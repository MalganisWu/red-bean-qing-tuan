import type { Tool } from "../../tool/definition/tool.js";
import {
  FETCH_URL_TOOL_NAME,
  FetchUrlTool,
} from "./fetch-url/fetch-url-tool.js";
import { GetTimeTool } from "./get-time/get-time-tool.js";
import {
  HTTP_REQUEST_TOOL_NAME,
  HttpRequestTool,
} from "./http-request/http-request-tool.js";

const GET_TIME_TOOL_NAME = "sys_get_time";

/**
 * 返回新的可选内置工具实例，不注册任何全局状态。
 *
 * @param id - Tool Registry 中的注册名，如 `sys_get_time`
 * @returns 匹配的实例；未注册的 id 返回 `undefined`
 */
export function lookupBuiltinTool(id: string): Tool | undefined {
  switch (id) {
    case GET_TIME_TOOL_NAME:
      return new GetTimeTool();
    case HTTP_REQUEST_TOOL_NAME:
      return new HttpRequestTool();
    case FETCH_URL_TOOL_NAME:
      return new FetchUrlTool();
    default:
      return undefined;
  }
}
