# Runtime 架构

> 文档性质：活文档。描述当前 TypeScript Runtime 的模块边界、推荐入口与依赖方向；公开接口以
> [`../contracts/typescript-runtime-api.md`](../contracts/typescript-runtime-api.md) 为准。

## 定位

`red-bean-qing-tuan` 是可嵌入宿主进程的轻量 TypeScript Agent Runtime SDK，不是服务端应用。
产品后端通过六个白名单入口消费它。

Runtime 负责 model→tool 循环、Pipeline、事件、interrupt、checkpoint 契约、压缩、委派和中性观测
扩展。宿主负责 HTTP、数据库、Redis、用户、产品 Session、任务、展示投影和部署。Runtime 保持无状态
库的定位：可选 Store 是宿主注入的端口，SDK 自带内存实现只用于单进程开发和契约验证。

普通使用者从 `AgentRuntime` 的 `run`、`resume` 和 `close` 开始；需要自定义节点顺序、Hook、持久化或
展示适配的高级使用者可以从 `/pipeline` 组合 `RuntimeContext`、`PipelineBuilder` 和 `AgentNode`。
`AgentRuntime` 经 `RuntimeRunService`，`AgentNode` 直接委托给 `ReactAgentExecution`；两条路径最终都由
该组件唯一调用 `runReactLoop`，因此
两级入口不仅共享数据契约，也共享消息 Hook、错误分类和 interrupt 组装实现。

## 模块与公开边界

```text
red-bean-qing-tuan/
├── src/
│   ├── runtime/           AgentRuntime、运行用例、checkpoint、插件、观测组装与 control plane
│   ├── pipeline/          按 react-loop、execution、context、node、hook 等能力组织
│   ├── protocol/          消息、事件、运行身份、工具、interrupt 与 JSON 中性叶子协议
│   ├── llm/
│   │   ├── adapter/port/  LlmAdapter 扩展点
│   │   ├── model,error/   模型请求、流式 chunk 与错误分类
│   │   └── openai/        request、stream、error 与 Adapter
│   ├── tool/              MapToolDispatcher 与显式启用的安全内置工具
│   ├── observability/     中性 Tracer Port 与无操作 Adapter
│   └── testing/           下游 CheckpointStore 契约套件
├── test/                  TypeScript 单元、契约、序列化与 conformance 测试
├── testdata/              API surface 与稳定序列化 fixture
├── tooling/               TypeScript 政策、文档检查与消费方 smoke
└── package.json           npm exports、工具链和构建入口
```

`package.json#exports` 是唯一公共边界，只开放主入口以及 `/llm`、`/pipeline`、`/tools`、
`/observability`、`/testing`。消费方不得导入 `src/**`、`dist/**` 或未列出的深层路径。
内部 `port/service/adapter` 与能力目录用于维护依赖方向，不等于额外公开入口。
每个 npm 入口的 `index.ts` 仅转发相邻能力的 `public-api.ts`，由后者集中维护公开符号。

## 两级使用入口

### 高层 Runtime 门面

```ts
import { AgentRuntime, MemoryCheckpointStore } from "red-bean-qing-tuan";

const runtime = new AgentRuntime({
  model,
  tools,
  checkpointStore: new MemoryCheckpointStore(),
  eventSink,
});

const result = await runtime.run(
  {
    threadId: "thread-1",
    userId: "user-1",
    input: "帮我整理今天的任务",
  },
  signal,
);
```

`model` 是唯一必需依赖。工具、Store、事件、策略、插件和运行配置均显式注入。直接传 `tools` 时
Runtime 构造 schema 和 `MapToolDispatcher`；需要远程路由或自定义中间件时成对传入 `toolSchemas` 与
`toolDispatcher`。

### 低层 Pipeline API

宿主可以组合 `PipelineBuilder`、自定义 `RuntimeNode` 与 Hook，并复用 `AgentNode` 或
`runReactLoop`。这适合已经拥有产品 Session、事务或展示投影的服务端应用。

低层 API 不反向影响高层门面：产品 Session、数据库模型、SSE frame、DisplayMessage 和 UI section
只能存在于宿主。

## 静态插件边界

Runtime 插件是构造期依赖组合，不是动态扩展系统：

```text
new AgentRuntime({ plugins })
        ↓ runtime-composition.ts
DefaultRuntimeRunService + control-plane-composition.ts
        ↓ 注册并封闭 PluginRegistry
run / resume middleware
        ↓
LLM middleware + ToolPolicy + Tool middleware
        ↓
固定的 ReAct / interrupt / checkpoint 状态机
```

插件只能包装 run/resume、模型和工具分发，并登记关闭函数。它不能替换 ReAct、interrupt 屏障、
tool call/result 配对、checkpoint CAS/fencing、取消或资源回收语义。先注册的 middleware 位于外层；
`ToolPolicy` 在 Tool 插件链外先执行。Registry 构造后封闭，不支持运行期卸载、动态插件、Generation、
Supervisor 或 Service Locator。

`AgentRuntime.close` 停止接收新运行、等待在途运行完成，再逆序且仅一次执行清理。没有插件资源的使用者
仍可调用，行为保持幂等。

`Tracer` 是后端无关扩展点。`RuntimeTracePlugin` 创建
`agent.run/resume → llm.stream/tool.execute` span，但不选择 exporter；宿主可接 OpenTelemetry、结构化
日志或测试 recorder。`wrapChildRunner` 为委派建立同一 Trace 下的 `agent.delegate` span，只记录低基数
身份、operation 与 status，不采集任务内容和输出。`Span.within(operation)` 显式承载父 span 激活范围，
Runtime 业务代码不依赖厂商 SDK 或全局 tracer。

## 一轮运行的数据流

### 无 Store

```text
AgentRequest.input / messages + 可选 history
        ↓
RuntimeRunService 创建运行上下文
        ↓
ReactAgentExecution
        ↓
runReactLoop
  模型流 → assistant/tool call → policy → dispatcher → tool result → 下一轮模型
        ↓
RuntimeResult + 可序列化 Checkpoint
```

无 Store 时调用方自行保存 `result.checkpoint`；恢复时通过 `ResumeRequest.state` 传回。

### 配置 Store

```text
run:    load revision R → 执行 → save(expected R) → revision R+1
resume: load revision R → consumeInterrupt(expected R) → R+1
                         → 执行 → save(claim owner, expected R+1) → R+2
```

`DefaultRuntimeRunService` 只保留 run/resume 高层顺序；请求组合校验位于 `run/request`，Checkpoint
装载与恢复认领位于 `runtime-checkpoint-session.ts`，RuntimeContext 执行、结果映射和最终保存位于
`runtime-agent-execution.ts`，无 Store receipt 和 Store replay 判定位于 `runtime-resume-replay.ts`。
Runtime 对同一实例内相同 `threadId` 串行执行。跨进程并发由 `CheckpointStore` 的 CAS、interrupt claim
和可选 fencing 约束；宿主产生、续期和回收 lease，并把 fencing token 传入 Runtime。

## ReAct 与 interrupt

`runReactLoop` 负责：

1. 合并 history、本轮消息和系统提示。
2. 按需执行上下文压缩。
3. 调用 `LlmAdapter.streamCompletion` 并发射中性事件。
4. 解析 tool call，通过 `ToolPolicy` 和 `ToolDispatcher` 执行工具。
5. 将 tool result 追加回上下文，直到模型完成、挂起、取消或达到迭代上限。

interrupt 通过 `ToolResult.signal` 表达，不扫描文本、不绑定某个工具名。同一批工具出现 interrupt 时，
其余工具不执行；Runtime 返回 `suspended` 和结构化 `Interrupt`。恢复时必须用匹配的 `interruptId`
补齐悬空 tool call。

## Checkpoint 与分布式边界

SDK 提供状态并发协议，不提供分布式调度系统：

| SDK 负责                                       | 宿主负责                                      |
| ---------------------------------------------- | --------------------------------------------- |
| Checkpoint schema、revision、CAS 错误语义      | 持久化实现、事务与容量治理                    |
| Resume claim、幂等 disposition 与 receipt 契约 | claim 超时判定、接管与运维策略                |
| fencing token 传递与 stale fence 错误          | lease、Owner ID、TTL、heartbeat 与 token 生成 |
| `MemoryCheckpointStore` 参考实现               | PostgreSQL/Redis 等生产实现                   |
| `/testing` 契约套件                            | 多进程故障注入与数据恢复演练                  |

`/testing` 契约套件内部按基础 CAS/身份、恢复并发、删除与深复制生命周期、fencing 场景拆分；兼容入口
`checkpoint-store-contract.ts` 只做转发，所以下游导入路径不变。
`MemoryCheckpointStore` 仍是四个原子操作的唯一协调者，但记录/revision/fencing 规则与 resume receipt
账本分别由相邻专责文件维护；这些内部拆分不新增可消费的 package export。

CAS/fencing 只保护 checkpoint 提交。网络调用、文件写入和其他工具副作用仍由宿主或工具实现幂等、
outbox 或补偿，不得宣称 exactly-once。

## 事件、展示与工具边界

- `RuntimeEvent` 是运行时事件，不是 Web 传输协议；`EventSink` 到 SSE、WebSocket、CLI 或日志的映射
  属于宿主。
- SDK 不定义 DisplayMessage、Process、卡片、会话标题或本地化状态文案；稳定状态码由宿主投影。
- `Tool`、`ToolDispatcher` 和 `ToolPolicy` 是中性契约；`MapToolDispatcher` 是轻量默认实现。
- 内置工具不通过模块加载产生注册副作用。文件、网络和委派工具必须由宿主显式选择并授权。
- Runtime 在分发前注入只读 `ToolCallContext`；工具不能修改父 Pipeline 状态。
- `DelegationTool` 只依赖 `ChildRunner`；子执行持久化、权限与 UI 包装留在宿主。

## 依赖方向

逐入口的源码审查地图见 [`../../src/README.md`](../../src/README.md)。

```text
protocol
   ↑
llm   tool   observability
   \   |   /
    pipeline
       ↑
    runtime
       ↑
public entrypoints / testing
```

`RuntimeTracePlugin` 同时组合 Runtime、LLM、Tool 与 Tracer，因此实现归属高层
`runtime/observability`；`/observability` 入口只为保持既有公共 API 做静态转发。

硬边界：

- `protocol` 和各能力 `port/` 只保存中性类型、接口和小型纯 helper，不依赖宿主或具体基础设施。
- 一个模块的实现不直接耦合另一个模块的内部实现；跨模块通过公开入口和最小接口组合。
- SDK 主包依赖闭包不出现产品仓、Fastify、数据库、Redis、产品 Session 或展示类型；package 保持零生产
  依赖，第三方协议通过宿主或边缘 Adapter 接入。
- `make ts-api-check` 检查 TypeScript 声明可消费性、六个入口和公开 API surface；完整边界仍需结合
  diff 人工审查。

**「代码怎么写才满足这些边界」——DTO 纯度、`implements` 义务、默认实现的注入与 `new` 接线、接口
后缀、架构门禁检什么——见编码规范 Skill 的「架构与依赖」与「架构门禁」两节。**

架构门禁的 TypeScript 编译器 API 接触点全部收敛在 `scripts/architecture-syntax.mjs` 隔离层：它把
源码解析为与编译器版本无关的中性语句事实，只对外暴露"`implements` 类型名解析到具名 interface"与
"`new X()` 解析到类声明"两个语义查询，规则文件 `scripts/check-architecture.mjs` 不再导入
`typescript`。TypeScript 7.0 编译器是无公开 API 的 Go 原生程序（7.1 才引入与 6.x 不同的新 API），
隔离层是升级主版本时的唯一替换点；夹具自测的内存源码由隔离层的 source provider 承载，门禁的检查
范围、只读性质与输出保持不变。import 依赖图仍由规则文件的正则预解析 specifier 加磁盘 `.js → .ts`
解析构建，不经过编译器。

## 扩展方式

| 需求           | 扩展点                                             |
| -------------- | -------------------------------------------------- |
| 新模型厂商     | 实现 `LlmAdapter` 或 `LlmAdapterFactory`           |
| 新工具         | 实现 `Tool`，通过 `tools` 或 `ToolDispatcher` 注册 |
| 远程工具/权限  | 实现 `ToolDispatcher` / `ToolPolicy`               |
| 自定义持久化   | 实现 `CheckpointStore` 并运行 `/testing` 契约套件  |
| 自定义事件出口 | 实现 `EventSink`                                   |
| 不同压缩策略   | 实现 `ContextCompressor` / `PostCompactRestorer`   |
| 自定义编排     | 从 `/pipeline` 组合 Node、Pipeline 和 Hook         |
| 横切观测/审计  | 实现 `RuntimePlugin` 或 `Tracer` Adapter           |

## 非目标

- HTTP 路由、认证、SSE frame 和业务错误码。
- 数据库 schema、Redis key、生产 lease 服务和 scheduler。
- 用户、会话列表、标题、任务与产品展示模型。
- 默认开启文件、网络或其他高权限工具。
- 动态代码安装、运行期热更新、进程内蓝绿切换或核心二进制自更新。
- 为外部工具副作用提供 exactly-once 保证。
