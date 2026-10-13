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

/**
 * 内置时间工具在 Tool Registry 中的注册名，`lookupBuiltinTool` 用它把 id 分发到 `GetTimeTool`。
 *
 * 该字符串是宿主 `sys_tool_ids` 引用的对外契约，因此抽成常量而不是散落在 case 分支里，
 * 改名时只需改一处、也让「注册名」这件事在代码里有一个可说清的位置。
 */
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
