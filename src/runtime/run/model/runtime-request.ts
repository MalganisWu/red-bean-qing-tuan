import type { Checkpoint } from "../../checkpoint/model/checkpoint.js";
import type { RawMessage } from "../../../protocol/message.js";

/** 启动一次 Agent 运行的中性输入 DTO；宿主 HTTP 字段不得泄漏到此处。 */
export interface AgentRequest {
  readonly threadId?: string | undefined;
  readonly userId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly traceId?: string | undefined;
  readonly input?: string | undefined;
  readonly messages?: readonly RawMessage[] | undefined;
  readonly history?: readonly RawMessage[] | undefined;
  /** 由宿主持久化并在新一轮运行时交回的 Runtime 状态。 */
  readonly state?: Checkpoint | undefined;
  readonly expectedRevision?: bigint | undefined;
  readonly fencingToken?: bigint | undefined;
}

/** 恢复一次已中断运行的输入 DTO。 */
export interface ResumeRequest {
  readonly threadId?: string | undefined;
  readonly interruptId: string;
  readonly response: string;
  readonly state?: Checkpoint | undefined;
  readonly userId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly traceId?: string | undefined;
  readonly expectedRevision?: bigint | undefined;
  readonly fencingToken?: bigint | undefined;
}
