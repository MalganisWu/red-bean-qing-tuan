# 上下文压缩（Context Compression）

> 文档性质：活文档。描述当前 TypeScript Runtime 的压缩契约、默认实现与内容恢复边界。

上下文压缩用于在模型上下文接近窗口上限时，把较早的消息归纳为摘要，同时保留最近消息、工具调用配对
以及宿主允许恢复的内容引用。压缩属于 Runtime 中性能力，不依赖产品 Session、数据库、Redis 或展示模型。

## 代码位置

```text
src/runtime/config/runtime-config.ts
  → CompressionConfig

src/pipeline/compression/
├── port/
│   ├── context-compression.ts       ContextCompressor
│   └── content-restoration.ts       PostCompactRestorer / ContentResolver
├── service/
│   ├── default-context-compressor.ts
│   └── default-post-compact-restorer.ts
└── token-counter.ts

src/protocol/content-reference.ts    ContentRef
src/pipeline/react-loop/react-loop.ts
```

公开兼容名称仍为 `DefaultCompressor` 与 `DefaultRestorer`。接口和默认实现放在同一能力目录内，实际默认
压缩器由 ReAct 主循环显式创建；宿主也可以通过 `CompressionConfig.compressor` 注入自己的实现。

## 契约与配置

`ContextCompressor` 负责判断是否需要压缩并返回新的消息序列：

```ts
export interface ContextCompressor {
  shouldCompact(
    context: RuntimeContext,
    messages: readonly RawMessage[],
    signal: AbortSignal,
  ): Promise<boolean>

  compress(
    context: RuntimeContext,
    messages: readonly RawMessage[],
    signal: AbortSignal,
  ): Promise<readonly RawMessage[]>
}
```

`CompressionConfig` 支持：

| 字段 | 含义 |
| --- | --- |
| `enabled` | 是否启用默认压缩器；默认关闭 |
| `compressor` | 宿主提供的替代实现；提供后由 Runtime 直接使用 |
| `restorer` | 摘要完成后恢复内容引用的实现 |
| `triggerThreshold` | 显式 Token 触发阈值 |
| `summaryPrompt` | 附加到默认摘要指令后的自定义要求 |
| `keepRecent` | 除当前输入外额外保留的最近消息数量 |
| `idleTimeoutSeconds` | 摘要流连续无 chunk 的超时时间 |

默认关闭压缩。开启默认实现的示例：

```ts
const runtime = new AgentRuntime({
  model,
  modelParams: { contextWindow: 200_000 },
  runtimeConfig: {
    compression: {
      enabled: true,
      triggerThreshold: 100_000,
      keepRecent: 3,
      restorer: new DefaultRestorer({ resolver: contentResolver }),
    },
  },
})
```

## 默认压缩流程

每轮模型调用前，`runReactLoop` 执行以下步骤：

1. 调用 `shouldCompact`。显式阈值优先；否则根据模型 `contextWindow`、最大摘要输出和安全缓冲计算阈值。
2. 保留开头连续的 system 消息和尾部当前输入/最近消息，向前调整切分点以避免拆开 assistant tool call
   与对应 tool result。
3. 使用同一个 `LlmAdapter` 发起无工具摘要请求。摘要流默认连续 30 秒无 chunk 即超时。
4. 删除 `<analysis>` 草稿，只保存 `<summary>` 内容，并生成 compact boundary 与 continuation 消息。
5. 若配置了 `PostCompactRestorer`，按预算恢复 `ContentRef`，以附件消息追加到压缩结果。
6. 发射结构化 `CompactionEvent`，记录压缩前后 Token 数和被归纳的消息数量。

默认实现连续三次摘要失败后会在当前压缩器实例内停止继续尝试。摘要或恢复失败不会伪造成功结果：摘要
错误返回给主循环按既有失败语义处理；单个内容引用恢复失败则跳过该引用，已经生成的有效摘要仍可使用。

## 内容引用与恢复

工具可以通过 `ToolResult.preserve` 返回 `ContentRef`。Runtime 把稳定描述写入 checkpoint；进程内可选
`fetch` 函数不会进入 JSON：

```ts
export interface ContentRef {
  readonly kind: string
  readonly key: string
  readonly version?: string
  readonly meta?: Readonly<Record<string, string>>
  readonly timestamp?: number
  readonly fetch?: (signal: AbortSignal) => Promise<Uint8Array>
}
```

`DefaultRestorer` 优先调用引用自身的 `fetch`；序列化恢复后则调用宿主提供的 `ContentResolver`。默认策略：

- 按 `timestamp` 从新到旧选择最多 5 个引用。
- 每个引用最多约 5,000 Token。
- 所有附件总预算约 50,000 Token。
- 单个读取失败跳过；达到总预算后停止。
- 截断内容附带明确标记，提示消费方通过 Read 工具获取完整内容。

文件、对象存储和数据库的访问授权属于宿主。Runtime 不根据 `kind/key` 自行连接外部系统，也不扩大
`RootedReadTool` 的文件系统权限。

## SDK 与宿主边界

| SDK 负责 | 宿主负责 |
| --- | --- |
| 压缩接口、默认摘要算法、Token 估算和压缩事件 | 选择是否启用、阈值和模型窗口 |
| `ContentRef` 稳定描述与 checkpoint 序列化 | 提供持久化和允许访问的内容范围 |
| `DefaultRestorer` 的排序、截断和预算 | 实现 `ContentResolver` 或进程内 `fetch` |
| 传播 `AbortSignal` 和摘要流超时 | 运行级超时、日志、Trace 与产品错误呈现 |

压缩不能保证外部内容永久可恢复，也不能代替宿主的数据保留策略。删除、换权或版本变化后的引用可以
恢复失败；默认恢复器会跳过失败项，不泄露其内部错误到模型上下文。

## 验证入口

- `test/pipeline/compression/compressor.test.ts`：阈值、摘要、熔断、取消、消息配对和事件。
- `test/pipeline/compression/restorer.test.ts`：Resolver、排序、数量限制、截断和失败跳过。
- `test/conformance/core-json.test.ts`：ContentRef 与 checkpoint 的稳定 JSON。
- `test/tool/builtin/read-file/read-file.test.ts`：受限文件读取及可恢复引用安全边界。

修改公开接口时还必须同步检查
[`../contracts/typescript-runtime-api.md`](../contracts/typescript-runtime-api.md)、六个 package exports、声明
基线和产品仓消费测试。
