# TypeScript Runtime 公共 API 契约

> 文档性质：活文档。描述 `red-bean-qing-tuan` TypeScript 包的当前公共入口。

## 包与运行环境

- 包名：`red-bean-qing-tuan`
- 模块格式：ESM
- Node.js：`>=24.9.0 <26`
- 生产依赖：无
- 构建产物：`dist/**/*.js`、`dist/**/*.d.ts` 与 source map

`package.json#exports` 是唯一公开边界。允许的入口只有：

| 入口 | 职责 |
| --- | --- |
| `red-bean-qing-tuan` | `AgentRuntime`、checkpoint、插件与稳定 Runtime 错误 |
| `red-bean-qing-tuan/llm` | LLM 契约、错误分类和 OpenAI-compatible Adapter |
| `red-bean-qing-tuan/pipeline` | 中性消息、事件、interrupt、Context、Node 与可组合 Pipeline |
| `red-bean-qing-tuan/tools` | Tool/Dispatcher 契约与可选内置工具 |
| `red-bean-qing-tuan/observability` | Tracer/Span 契约与 Runtime 观测插件 |
| `red-bean-qing-tuan/testing` | 下游 CheckpointStore 实现的可复用行为契约套件 |

消费方不得导入 `dist/**`、`src/**` 或以上入口之外的内部文件。`make ts-api-check` 会校验白名单、
声明文件可消费性和运行时导出快照。

## 高层 Runtime

```ts
const runtime = new AgentRuntime(options)
const result = await runtime.run(request, signal)
const resumed = await runtime.resume(resumeRequest, signal)
await runtime.close(shutdownSignal)
```

`AgentRuntimeOptions.model` 是唯一必填依赖。工具可通过 `tools` 直接注入，也可成对提供
`toolSchemas + toolDispatcher`；两种模式互斥。CheckpointStore、EventSink、ToolPolicy、静态插件、
系统提示和运行配置均可替换。

`run` / `resume` 必须显式接收 `AbortSignal`，不创建不可见的全局取消状态。同一实例内相同
`threadId` 串行，不同 thread 可并行。`close` 拒绝新运行、等待在途运行结束，再逆序且幂等地关闭插件资源。

`RuntimeResult.status` 使用 `completed`、`suspended`、`exhausted`、`cancelled`、`failed`。执行错误通过
`RuntimeExecutionError` 拒绝 Promise，同时在 `error.result` 保留可诊断的部分结果；调用方不能只保留
错误字符串而丢弃结果。

## Checkpoint 与恢复

TypeScript Store 提供结构化四操作：

- `load(request, signal)`
- `save(request, signal)`
- `consumeInterrupt(request, signal)`
- `delete(request, signal)`

revision 与 fencing token 使用 `bigint`，不得经过不安全的 `number` 转换。Store 必须保持 CAS、fence
高水位、owner 隔离、Resume claim/receipt、幂等 replay 和 delete tombstone 语义。
`MemoryCheckpointStore` 是开发与契约参考实现，不是跨实例存储。

JSON 边界使用 `parseCheckpoint`、`serializeCheckpoint`、`serializeCheckpointRecord`、`serializeRuntimeResult`、
`serializeRuntimeEvent` 等显式序列化函数；进程内 `ContentRef.fetch` 不进入 JSON。

自定义 Store 应在自己的测试中调用：

```ts
import {
  runCheckpointStoreContract,
  runCheckpointStoreFencingUnsupportedContract,
} from "red-bean-qing-tuan/testing";

await runCheckpointStoreContract(createStore, {
  supportsFencing: true,
  dispose: disposeStore,
});
```

基础套件验证 CAS、owner 隔离、Resume claim/receipt、并发消费、delete tombstone、防 ABA 与深拷贝；
`supportsFencing: true` 还验证 fence 高水位和各原子操作的复核。不支持 fencing 时省略该选项，并额外
运行 `runCheckpointStoreFencingUnsupportedContract`。工厂可以异步返回全新的空 Store，`dispose` 在每个
隔离用例结束后逆序清理该用例创建的实例。

## 插件与观测

插件只在构造期通过 `RuntimePlugin.register(registry)` 注册。Registry 随后封闭，不支持运行期热插拔。
Run、LLM、Tool middleware 的先注册者位于外层，`ToolPolicy` 仍位于插件 Tool middleware 外层。

`Tracer.start` 返回 `Span`；`Span.within(operation)` 显式激活父上下文，避免依赖全局 Service Locator。
`RuntimeTracePlugin` 产生 `agent.run/resume → llm.stream/tool.execute` 层级，`wrapChildRunner` 产生
`agent.delegate`。span 只记录低基数身份、operation 与 status，不记录用户 prompt、工具参数或输出。

## 内置工具安全边界

- `PolicyHttpClient` 在建连前解析目标、执行 `EgressPolicy` 并直接连接已授权 IP，避免 DNS rebinding。
- `PublicInternetOnlyPolicy` 默认拒绝回环、私网、链路本地、组播、CGNAT 与未指定地址。
- HTTP 与 Fetch 对每次重定向重新执行策略；Fetch 限制响应与输出大小并安全截断 UTF-8。
- `createRootedReadTool(root)` 限制文件系统边界。Linux 固定已打开目录句柄；缺少等价 `openat` 的平台
  在根或路径身份变化时 fail-closed。`UnrestrictedReadTool` 只适用于已有进程级文件沙箱的宿主。
- 文件类工具 `sys_read_file`、`sys_list_directory`、`sys_glob`、`sys_grep`、`sys_write_file`、
  `sys_edit_file`、`sys_apply_patch` 都不限制路径：除 `createRootedReadTool` 外，其余实现都只适用于
  已有进程级文件沙箱的宿主。它们只注册、不自动授权。
- 发现类工具 `sys_glob` / `sys_grep` 共用同一份默认排除表，排除 `node_modules` 与 `.git`（已写进两个工具
  的描述，调用方可据此调整模式），结果超过上限时截断并报告总量。`sys_list_directory` 只列直接子项、
  不套用该排除表——`node_modules/` 本身必须可见——但同样受条目上限约束，截断时报告总条目数。
  `sys_grep` 还会跳过二进制与超大文件，并把这些跳过**明确计数**而不是静默丢弃。
- 写入类工具以版本闸门为前提：覆盖或修改既有文件要求同一 conversation 先读取过该文件，且文件自
  读取以来未被改动；不满足即拒绝。写入经同目录临时文件加原子重命名完成，任何失败点都不留半写文件。
  闸门状态来自宿主注入的 `FileReadLedger`，读取工具与写入工具必须共用同一实例，否则闸门永远读不到
  读取记录。`MemoryFileReadLedger` 是进程内参考实现，持久化属于宿主。
- `sys_todo_write` 的清单按 conversation 保存在进程内，`current(threadId)` 供宿主读取；跨重启恢复与
  界面展示属于宿主。
- `sys_shell` 执行 `bash -c`，是**任意命令执行**：可以发起网络请求、安装依赖、启动进程，且
  **绕过全部文件闸门**——`sed -i`、`tee` 都不经过 `FileReadLedger`，因此「先读后写」在该工具存在时
  不再是一项可强制执行的约束。它在超时或取消时终止**整个进程组**（先 `SIGTERM`、宽限期后
  `SIGKILL`），stdout 与 stderr 各自上限截断，结尾给出 `[exit code: N]` 或终止原因标记。
  子进程**继承宿主进程的完整环境变量**，包括部署凭据；凭据隔离依赖部署方式，不依赖应用层名单。
  本批只支持前台执行：长时间运行的命令会被超时终止，没有后台作业与 `job_output` 配套。

网络、文件和委派工具都不是默认能力，必须由宿主显式加入并授权。

`lookupBuiltinTool(id)` 是无注册副作用的默认目录，只返回新的 time、HTTP 或 Fetch 工具实例；Read、
其余文件类工具与 Delegation 依赖宿主权限/执行器，不属于目录默认项。

## 兼容性状态

`testdata/api/public-exports.json` 冻结当前 package surface。正式 semver 发布前允许在评审并同步产品
消费方后调整 API，但不得绕过快照或静默深层导入；发布前再建立版本化 API 基线。
