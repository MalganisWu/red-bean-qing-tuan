import type {
  AgentRequest,
  AgentRuntime,
  AgentRuntimeOptions,
  CheckpointStore,
  ResumeRequest,
  RuntimePlugin,
  RuntimeResult,
} from "red-bean-qing-tuan";
import type {
  LlmAdapter,
  LlmChunk,
  LlmRequest,
  OpenAiAdapter,
} from "red-bean-qing-tuan/llm";
import type {
  RuntimeTracePlugin,
  Span,
  Tracer,
} from "red-bean-qing-tuan/observability";
import type {
  ReactResult,
  RuntimeContext,
  RuntimeEvent,
} from "red-bean-qing-tuan/pipeline";
import type {
  ChildRunner,
  EgressPolicy,
  FetchUrlTool,
  RootedReadTool,
  Tool,
} from "red-bean-qing-tuan/tools";
import type {
  CheckpointStoreContractFactory,
  CheckpointStoreContractOptions,
} from "red-bean-qing-tuan/testing";

export interface PublicApiSmoke {
  readonly request: AgentRequest;
  readonly resume: ResumeRequest;
  readonly result: RuntimeResult;
  readonly runtime: AgentRuntime;
  readonly runtimeOptions: AgentRuntimeOptions;
  readonly checkpointStore: CheckpointStore;
  readonly plugin: RuntimePlugin;
  readonly adapter: LlmAdapter;
  readonly llmRequest: LlmRequest;
  readonly llmChunk: LlmChunk;
  readonly openAi: OpenAiAdapter;
  readonly tracer: Tracer;
  readonly span: Span;
  readonly tracePlugin: RuntimeTracePlugin;
  readonly context: RuntimeContext;
  readonly event: RuntimeEvent;
  readonly reactResult: ReactResult;
  readonly tool: Tool;
  readonly childRunner: ChildRunner;
  readonly egressPolicy: EgressPolicy;
  readonly fetchTool: FetchUrlTool;
  readonly rootedReadTool: RootedReadTool;
  readonly checkpointStoreFactory: CheckpointStoreContractFactory;
  readonly checkpointStoreContractOptions: CheckpointStoreContractOptions;
}
