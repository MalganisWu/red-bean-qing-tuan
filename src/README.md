# Runtime 人工代码审查导航

Runtime 是 SDK，不是 HTTP 服务。人工审查固定使用：

`package export → facade / builder → Port → implements → composition → implementation`

## 代码结构

```text
src/
├── runtime/
│   ├── facade/              AgentRuntime 薄门面
│   ├── run/                 高层运行用例与配置
│   ├── checkpoint/          model、codec、store port 与内存 adapter
│   ├── thread-execution/    同 thread 串行协调
│   ├── resume-receipt/      resume 幂等结果所有权
│   ├── lifecycle/           close 与资源释放所有权
│   └── observability/       Runtime Trace 高层插件
├── pipeline/
│   ├── react-loop/          唯一 ReAct 主循环及 model/tool step
│   ├── execution/           高低层共用执行适配
│   ├── context/             RuntimeContext
│   ├── node/                RuntimeNode Port 与 AgentNode
│   ├── pipeline/            RuntimePipeline Port 与 SequentialPipeline
│   ├── compression/         压缩与内容恢复
│   ├── hook/                消息 Hook
│   └── interrupt/           interrupt 组装
├── protocol/                消息、事件、运行身份、工具、JSON 等中性叶子协议
├── llm/                     LLM Port 与 OpenAI-compatible adapter
├── tool/                    Tool Port、Dispatcher 与 builtin
├── observability/           Tracer Port 与无操作 Adapter
└── testing/                 下游 CheckpointStore 契约套件
```

## 从接口找到实现

`LlmAdapter`、`ToolDispatcher`、`CheckpointStore`、`Tracer`、`RuntimeNode` 等名称已经表达 Port 角色，
不额外追加 `Port`。SDK 默认实现必须显式 `implements`；没有默认实现的接口由注释说明宿主责任。

```text
构造参数或字段类型
→ 打开 Port
→ 搜索 implements <InterfaceName>
→ runtime-composition.ts / control-plane-composition.ts / PipelineBuilder 中找 new
→ 打开实现方法
```

## 六个公开入口

| npm 入口             | Facade / 索引                                                          | 核心契约                                                                                | 主要实现                                                                    | 重点测试                    |
| -------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | --------------------------- |
| `red-bean-qing-tuan` | `index.ts`、`runtime/public-api.ts`、`runtime/facade/agent-runtime.ts` | `runtime/run/model`、`runtime/run/result`、`runtime/checkpoint/model`、`runtime/plugin` | `DefaultRuntimeRunService`、control plane 默认实现、`MemoryCheckpointStore` | `test/runtime/*`            |
| `/pipeline`          | `pipeline/index.ts`                                                    | `protocol/*`、各能力 `port/`                                                            | `react-loop/*`、`ReactAgentExecution`、`AgentNode`、`SequentialPipeline`    | `test/pipeline/*`           |
| `/llm`               | `llm/index.ts`                                                         | `llm/adapter/port`、`llm/model`、`llm/error`                                            | `llm/openai/{adapter,request,stream,error}`                                 | `test/llm/openai/*`         |
| `/tools`             | `tool/index.ts`                                                        | `tool/definition`、各能力 `port/`                                                       | `tool/dispatcher/service`、`tool/builtin/*`                                 | `test/tool/*`               |
| `/observability`     | `observability/index.ts`                                               | `observability/tracer/port`                                                             | `observability/tracer/adapter`、兼容导出的 `runtime/observability`          | `test/observability/*`      |
| `/testing`           | `testing/index.ts`                                                     | `testing/checkpoint-store/*`                                                            | 下游 adapter 契约套件                                                       | `test/runtime/checkpoint/*` |

## 高层运行完整链路

```text
src/index.ts
→ runtime/facade/agent-runtime.ts
→ runtime/run/port/runtime-run-service.ts
→ runtime/runtime-composition.ts
→ runtime/run/service/default-runtime-run-service.ts
→ runtime/run/request + runtime-checkpoint-session.ts + runtime-resume-replay.ts
→ runtime-agent-execution.ts
→ pipeline/execution/service/react-agent-execution.ts
→ pipeline/react-loop/react-loop.ts
→ model-turn.ts / model-step.ts / tool-step.ts
```

Checkpoint、同 thread 排队、resume receipt 和 close 各有独立状态所有者，由
`runtime/control-plane-composition.ts` 显式组装。`AgentRuntime` 只保留稳定公开 API，不再承载整套业务实现。

## 低层 Pipeline 链路

```text
pipeline/index.ts
→ protocol/* + pipeline/context/runtime-context.ts
→ pipeline/pipeline/service/sequential-pipeline.ts
→ pipeline/node/service/agent-node.ts
→ pipeline/execution/service/react-agent-execution.ts
→ pipeline/react-loop/react-loop.ts
```

高层 Runtime 与低层 Pipeline 最终进入同一个 `ReactAgentExecution` 和 `runReactLoop`，不会复制模型—工具
循环、interrupt 或消息 Hook 逻辑。

## DTO 与协议规则

- 高层请求与配置 DTO 位于 `runtime/run/model`，结果 DTO 位于 `runtime/run/result/runtime-result.ts`；
  mapper、serializer 和运行时常量放到相邻专责文件。
- `protocol/` 是无宿主依赖的中性叶子层，保存跨能力共享的消息、事件、工具和 JSON 协议。
- Checkpoint 的 model、codec、clone、store port 和 adapter 分目录放置，不能把转换逻辑塞回数据对象。
- Memory Store 内部将 record/fencing 规则与 receipt 账本放在独立文件，Adapter 只协调四个原子操作。
- 外部 JSON 必须经 codec/parser 校验；实现层不得另造相似 shape。
- 公开类型变化必须同步检查 `package.json#exports`、声明基线、API surface、契约文档和产品消费方。

## 常用定位命令

```bash
sed -n '/"exports"/,/},/p' package.json
rg -n "^export" src/index.ts src/*/index.ts
rg -n "export interface|export type" src/protocol src/runtime src/pipeline
rg -n "implements (LlmAdapter|ToolDispatcher|CheckpointStore|Tracer|RuntimeNode|RuntimeRunService)" src
rg -n "new [A-Z]" src/runtime src/pipeline test
rg -n "describe\(" test
```
