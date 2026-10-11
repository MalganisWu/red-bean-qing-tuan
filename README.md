<div align="center">

# red-bean-qing-tuan · 青团

**可嵌入的 TypeScript Agent Runtime。** model→tool 循环、Pipeline、checkpoint、interrupt、
压缩、委派，以及一层厂商中性的观测接缝 —— 零生产依赖。

[![CI](https://github.com/MalganisWu/red-bean-qing-tuan/actions/workflows/ci.yml/badge.svg)](https://github.com/MalganisWu/red-bean-qing-tuan/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D24.9.0%20%3C26-brightgreen)](package.json)

[English](README.en.md) · **简体中文**

</div>

## 为什么会有它

Agent 框架往往替你决定太多：假定你有 HTTP 服务、有数据库、有会话模型、有 UI。这个不作任何假定。

`red-bean-qing-tuan` 只做执行层，别的一概不管。它运行 model→tool 循环，通过**你提供的**
store 持久化 checkpoint，并发出中性事件。HTTP、SSE、数据库、缓存、鉴权与产品会话全部留在宿主里 ——
在那里，它们可以按产品的需要来定，而不用迁就框架的假设。

它**零生产依赖**，产物是 ESM JavaScript 加类型声明与 source map。接入它不会给你的服务添一棵依赖树。

## 安装

还没发到 npm。目前先从 Git 装：

```bash
pnpm add git+https://github.com/MalganisWu/red-bean-qing-tuan.git#<commit>
```

或在本地构建：

```bash
git clone https://github.com/MalganisWu/red-bean-qing-tuan.git
cd red-bean-qing-tuan
pnpm install --frozen-lockfile
make ts-build
```

要求 Node.js `>=24.9.0 <26`。

## 快速开始

```ts
import { AgentRuntime, MemoryCheckpointStore } from 'red-bean-qing-tuan'
import { OpenAiAdapter } from 'red-bean-qing-tuan/llm'

const runtime = new AgentRuntime({
  model: new OpenAiAdapter({
    apiKey: process.env['OPENAI_API_KEY'] ?? '',
    modelName: 'gpt-4',
  }),
  checkpointStore: new MemoryCheckpointStore(),
  systemPrompt: '你是助手。',
})

const result = await runtime.run(
  { threadId: 'session-1', userId: 'user-1', input: '你好' },
  AbortSignal.timeout(60_000)
)

if (result.status === 'suspended' && result.interrupt !== undefined) {
  await runtime.resume(
    {
      threadId: 'session-1',
      userId: 'user-1',
      requestId: 'resume-1',
      interruptId: result.interrupt.toolCallId,
      response: '{"approved":true}',
    },
    AbortSignal.timeout(60_000)
  )
}

await runtime.close(AbortSignal.timeout(10_000))
```

`RuntimeResult.status` 区分 `completed`、`suspended`、`exhausted`、`cancelled`、`failed`。
执行失败抛出 `RuntimeExecutionError`，其 `result` 保留部分输出和可诊断的 checkpoint。

`MemoryCheckpointStore` 是开发与契约参考实现 —— **不是**跨实例的生产存储。

## Runtime 负责什么，不负责什么

这条边界是这个库存在的全部理由，所以值得写清楚。

**Runtime 负责：**

- ReAct 状态机、模型流、工具调度、取消与超时。
- interrupt 执行屏障，以及带幂等 resume 的持久化 checkpoint。
- 中性运行事件和结构化 `Result`。
- 默认安全的内置工具，以及必须显式点名才能用的高权限构造。

**宿主负责：**

- HTTP / SSE / WebSocket 协议、UI section 与卡片、本地化。
- 用户身份、会话列表与标题、鉴权与审批。
- 缓存与数据库 key、定时任务元数据、子执行记录。
- 允许哪些网络目标、可达哪些文件系统根、密钥如何注入。

具体一点：Runtime **不**提供 lease、TTL、heartbeat、claim 超时接管或 exactly-once 外部副作用。
fencing 只保护 checkpoint 提交。这些都是宿主策略 —— 假装 Runtime 能兜住它们，就是隐瞒。

## Checkpoint 与并发边界

- 普通 run 从 revision `R` 加载，成功以 CAS 保存为 `R+1`。
- `resume` 先原子消费 interrupt（`R→R+1`），再以 claim owner 保存终态（`R+1→R+2`）。
- 相同 `requestId` 会重放已完成的回执，不重复调用模型；请求冲突时直接 fail-closed。
- 非零 fencing token 由宿主的 lease 系统生成；Runtime 和 Store 拒绝 stale fence。

自定义 Store 应运行框架无关的契约套件：

```ts
import {
  runCheckpointStoreContract,
  runCheckpointStoreFencingUnsupportedContract,
} from 'red-bean-qing-tuan/testing'

await runCheckpointStoreContract(() => new CustomCheckpointStore(), {
  supportsFencing: true,
  dispose: async (store) => store.close(),
})
```

不支持 fencing 的实现还应运行 `runCheckpointStoreFencingUnsupportedContract`，
保证非零 token 明确 fail-closed。

## 公共 API 边界

`package.json#exports` 是唯一公开边界：

| 入口 | 内容 |
| --- | --- |
| `red-bean-qing-tuan` | `AgentRuntime`、checkpoint store、协议 |
| `red-bean-qing-tuan/llm` | 中性 LLM adapter 接口与 OpenAI-compatible 默认实现 |
| `red-bean-qing-tuan/pipeline` | `RuntimeContext`、`PipelineBuilder`、`AgentNode` |
| `red-bean-qing-tuan/tools` | 工具定义、分发器、内置工具与委派 |
| `red-bean-qing-tuan/observability` | 中性 `Tracer` 与 Runtime 观测插件 |
| `red-bean-qing-tuan/testing` | 供宿主实现复用的框架无关契约套件 |

不要导入 `src/**`、`dist/**` 或其他深层路径。完整 surface 见
[`docs/contracts/typescript-runtime-api.md`](docs/contracts/typescript-runtime-api.md)。

## Interrupt

任何 Tool 都能返回一个结构化的 `InterruptSignal`，以此请求挂起。interrupt 是**执行屏障**：同批其他工具不会在确认前
执行。高层调用方使用 `runtime.resume`；低层 Pipeline 宿主把匹配 `interrupt.toolCallId` 的 tool message
追加后继续运行。

产品卡片、CLI 提示和本地化文案均由宿主负责 —— Runtime 从不拼装面向用户的文案。

## 内置工具安全

- `lookupBuiltinTool(id)` 只为 `sys_get_time`、`sys_http_request`、`sys_fetch_url` 返回新实例，
  不注册任何全局状态。
- HTTP/fetch 默认拒绝私网、回环、链路本地、组播、CGNAT 和未指定地址，并在建连与每次重定向前复核。
- `createRootedReadTool(root)` 阻止路径和 symlink 逃逸。`UnrestrictedReadTool` 只适用于已有进程级
  文件系统沙箱的宿主。
- 文件、网络和委派能力必须由宿主显式注入与授权。

## 插件与观测

`plugins` 只在 `AgentRuntime` 构造期注册，随后封闭。插件可以包装 run/resume、模型和工具调用，
也可以登记关闭函数。先注册的 middleware 位于外层，且任何插件都不能短路 `ToolPolicy`。

`red-bean-qing-tuan/observability` 提供中性 `Tracer` 与 `RuntimeTracePlugin`，默认 span 层级为：

```text
agent.run / agent.resume
├── llm.stream
└── tool.execute
    └── agent.delegate
```

`Span.within(operation)` 显式传播父 span。Runtime 不引入 exporter 或厂商 SDK，也从不记录 prompt、
工具参数或模型输出。请自行选择结构化日志、OpenTelemetry 或其他适配器。

## 开发

```bash
make setup          # 安装工具链
make ts-build       # 构建 ESM 与声明文件
make ts-test        # 单元、契约与 conformance 测试
make ts-api-check   # 六个入口、声明消费与 API surface
make typecheck      # 严格类型检查
make ts-lint        # 类型感知 ESLint
make verify         # 完整本地门禁
```

`make verify*` 不修改 Git 跟踪文件。

## 文档与目录

想读源码的话，从 [`src/README.md`](src/README.md) 开始，按六个公开入口依次看 facade、protocol/port、
service/adapter、composition 与宿主实现。

```text
src/        Runtime 生产源码
test/       单元、契约与 conformance 测试
testdata/   API surface 与稳定序列化 fixture
tooling/    TypeScript 政策和消费方 smoke
```

开发规则见 [`AGENTS.md`](AGENTS.md)，文档索引见 [`docs/README.md`](docs/README.md)，
未发布变化见 [`CHANGELOG.md`](CHANGELOG.md)。

## 关联仓库

[`red-bean-nian-gao`](https://github.com/MalganisWu/red-bean-nian-gao) 是构建在本 Runtime 之上的
完整 Agent 对话平台 —— 一个宿主如何接管会话、持久化、HTTP/SSE、定时任务与 UI 的完整范例。
它通过 `runtime.lock` 按 commit 钉住本仓，这也是消费未发布 SDK 的一种方式。

## License

[MIT](LICENSE)
