# 决策：`maxConcurrentTools` 的非法取值不再退化为不限并发

状态：已接受
日期：2026-10-15

背景：`RuntimeConfig.maxConcurrentTools` 的说明写着「缺省或非法取值时不限并发，直接按调用数量
并发」，`tool-step.ts` 也照此实现——只有 `Number.isSafeInteger(configured) && configured > 0`
才作为上限，其余一律折回 `calls.length`。于是宿主把 `0`、负数、非整数或 `NaN` 误填进来时，
**原本用来限制资源消耗的配置反而变成完全不限制**：一批有几个工具调用，就可能同时派发几个。

影响面（实测）：产品仓虽在 `AgentRuntimeConfig` 里声明了同名字段，但 `parseRuntimeConfig` 从不
解析它（agent metadata 里没有 `max_concurrent_tools` 这个键，两仓 0 命中），因此该字段恒为
`undefined`，当前的回退行为在产品路径上不可达。

选项：

- (a) 维持现状，只把回退写得更明确：代价是「填错等于放开关」这个反转继续存在。
- (b) 区分「未提供」与「已提供但无效」：未提供保持不限并发；显式无效值在运行边界报配置错误，
  不进入工具派发（选定）。
- (c) 非法值折回一个**保守**默认（如 `1`）：不会静默放开，但把一个明显的配置错误变成「跑得很慢」，
  更难定位。

决策：采用 (b)。

理由：「未提供」是一个有意的缺省，「填了非法值」是一个错误。把两者折进同一个分支，等于让错误
静默地变成与意图相反的资源配置。

后果：

- **范围**：只处理 `maxConcurrentTools`。`maxToolIterations` 有同款回退（`react-loop.ts`），但它
  折回的是**保守**默认而非放开，不在本次范围；是否一并收紧另作决策。**缺省并发策略保持不变**。
- **落点**：`tool-step.ts` 导出纯函数 `resolveToolConcurrency(config)`；`react-loop.ts` 在入口调用
  它（尽早失败、不进入派发），`dispatchToolBatch` 内部也调用（自包含，便于单测）。
- **错误形态**：pipeline 层不能依赖 runtime 层，因此抛普通 `Error`，不新增 `RUNTIME_ERROR_CODES`。
  **公开 API surface 与 TypeScript 声明基线均不变。**
- **验收**：合法正整数上限照旧生效；缺省仍不限并发；`0`、负数、非整数、`NaN` 四类显式无效值一律
  抛出可定位的配置错误，且不派发任何工具。边界测试覆盖这四类与两个合法分支。
- **代价**：宿主的 agent metadata 若曾依赖「填 `0` 即不限并发」，升级后会变成运行期配置错误。
  产品仓当前不产生该字段，实际无影响；若日后给它接上 metadata 解析，必须同时校验取值。
- 本决策不涉及 `AgentRuntimeConfig` 里另外两个声明了却无人赋值的字段（`maxConcurrentTools`、
  `toolTimeoutSeconds`）的存废，也不涉及后者说明与实现不符的问题——那是独立的一件事。
