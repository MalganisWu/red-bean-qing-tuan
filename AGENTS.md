# AGENTS.md · red-bean-qing-tuan

Agent Runtime SDK 的 AI 开发助手手册。写代码前先读本文件，再按需查阅关联文档。

## 项目定位

`red-bean-qing-tuan` 是轻量、可嵌入的 TypeScript Agent Runtime SDK，不是服务。公开入口为主包及
`/llm`、`/pipeline`、`/tools`、`/observability`、`/testing`。

Runtime 提供 model→tool 循环、Pipeline、工具系统、LLM adapter、checkpoint 契约、interrupt、压缩、
委派和中性观测扩展。宿主注入模型、状态存储、工具与部署能力。SDK 不提供 HTTP 服务、数据库 schema、
Redis 客户端、产品 Session、UI 展示或生产 lease 服务。

TypeScript 源码构建为 ESM JavaScript 和声明文件，保持零生产依赖。

## 目录与公开边界

```text
red-bean-qing-tuan/
├── src/
│   ├── runtime/           AgentRuntime、运行用例、checkpoint、插件与 control plane
│   ├── pipeline/          ReAct、Pipeline、Hook、压缩与恢复
│   ├── protocol/          消息、事件、运行身份、工具与 JSON 中性叶子协议
│   ├── llm/               LLM 契约与 OpenAI-compatible adapter
│   ├── tool/              Dispatcher、安全内置工具与委派
│   ├── observability/     中性 Tracer Port 与无操作 Adapter
│   └── testing/           下游 CheckpointStore 契约套件
├── test/                  镜像源码能力的 TypeScript 单元、契约与 conformance 测试
├── testdata/              API surface 与 JSON fixture
├── tooling/               TypeScript 政策、文档检查与消费方 smoke
├── docs/                  契约、设计、指南、标准与冻结记录
└── package.json           npm exports 与构建入口
```

`package.json#exports` 是 TypeScript 唯一公开边界。消费方不得导入 `src/**`、`dist/**` 或未列出的深层路径。
`make ts-api-check` 校验声明可消费性、6 个入口和 API surface 快照。
从公开入口逐层人工审查时，先读 [`src/README.md`](src/README.md) 的入口矩阵。

## 跨客户端 Skill 入口

`AGENTS.md` 是开发治理的唯一入口。共享工作流位于 `skills/red-bean-runtime-development/`；
`.claude/skills/` 与 `.agents/skills/` 只通过符号链接暴露，不复制规范正文。

## 文档分类与路由

完整导航见 [`docs/README.md`](docs/README.md)。

| 分类 | 目录 | 生命周期 |
| --- | --- | --- |
| 契约 | `docs/contracts/` | 活文档；描述当前 TypeScript API |
| 设计 | `docs/design/` | 活文档；描述**当前**架构、数据流与 SDK/宿主边界；不写进度与排期 |
| 指南 | `docs/guides/` | 活文档；描述接入、迁移与操作方式 |
| 标准 | `docs/standards/` | 活文档；描述编码、测试与交付流程 |
| 计划 | `docs/plans/` | 任务文档；执行期可改，交付后冻结 |
| 决策记录 | `docs/decisions/` | 冻结；只追加不修改 |

一次开发的产出只有这三样（plan / decision / design）；触发判据、红线、骨架与验收条件去向见
[`docs/standards/development-workflow.md`](docs/standards/development-workflow.md)「一次开发的产出」。

进行中的 plan 可以修订；交付后只更新 contract、design、guide、standard、README、CHANGELOG 或源码，
不得回写历史 plan 替代当前事实。

## 架构规则

详见 [`docs/design/architecture.md`](docs/design/architecture.md)。核心规则：

- `src/protocol` 与各能力的 `port/` 只包含中性类型、小型纯 helper 和接口，不依赖宿主或具体基础设施。
- 纯数据 DTO 按所属能力放在 `model/` 或 `request/`，只允许类型和 interface，不允许函数、Schema 或运行时常量；
  parser、serializer 和业务规则必须放在相邻专责文件。Port 与领域状态不是 DTO，不为形式统一混入 DTO。
  Runtime 不建立全局 DTO 大文件，也不接收产品 HTTP DTO。
- `LlmAdapter`、`ToolDispatcher`、`CheckpointStore`、`Tracer`、`RuntimeNode` 等既有职责名已表达 Port 语义，
  不为形式统一追加 `Port` 并破坏公共 API；新接口同样必须使用可辨识的职责后缀。
- Runtime 自带的生产/默认实现类，其默认组装必须能从公开 facade、builder 或宿主 composition root
  找到明确的 `new ConcreteClass(...)`。
- 一个模块的实现不直接耦合另一个模块的内部实现；跨模块通过公开入口和最小接口组合。
- 顶层能力依赖固定为 `protocol ← llm/tool/observability ← pipeline ← runtime`；同时依赖 Runtime、LLM、
  Tool 的观测插件实现归 `runtime/`，既有子路径只能兼容导出，不得成为内部依赖捷径。
- 禁止重新建立宽泛的 `core/`、`impl/` 或 `dto.ts` 聚合目录；能力目录采用 `port/` 配合
  `service/adapter`，纯转换保留为具名函数。
- 高层 `AgentRuntime` 与低层 Pipeline 共用一套中性消息、事件、Tool、Interrupt 和 Checkpoint 语义。
- 默认实现必须可替换；`MemoryCheckpointStore` 仅是单进程参考实现。产品取消、锁与 ID registry
  属于宿主，SDK 不提供。
- SDK 只定义 revision/CAS/fencing/Resume claim 协议，不实现数据库、Redis、lease、heartbeat、超时接管或
  exactly-once 外部副作用；这些属于宿主。
- 静态插件仅在构造期注册并封闭。禁止恢复动态热更新、Generation、Supervisor 或运行期插件市场。
- 文件和网络工具默认 fail-closed，必须由宿主显式选择并授权。
- 公开 API 的接口是消费方契约，必须保留；SDK 内部 1:1 且无多实现/宿主替换需求的能力接口应删除。
  无对应接口的默认实现类登记在 `scripts/check-architecture.mjs` 白名单并附理由。

新增 TypeScript 能力必须同时审查公开 exports 和宿主影响。

## TypeScript 规则

所有 `.ts` 遵循跨仓共享的通用规范
[`docs/standards/typescript-common-conventions.md`](docs/standards/typescript-common-conventions.md)，
Runtime 特有约束见 [`docs/standards/typescript-coding-conventions.md`](docs/standards/typescript-coding-conventions.md)。
**本节不重复通用规则**（禁止 `any`、显式标注边界、`unknown` 起步、禁用 Decorator/enum、cause 链、
不得绕过门禁等都在通用件里），只列 Runtime 仓的额外强调：

- revision/fencing 使用 `bigint`，不得经不安全的 `number` 转换。
- Promise、stream、iterator 和资源的所有权与关闭路径必须明确。
- 错误"类型不重要、可定位性优先"——SDK 的 adapter/plugin 包装宿主错误时尤其遵守，不得只取
  `message` 重抛使宿主日志断链。

## 注释规范

注释的**唯一事实来源**是根 TS 规范
[`docs/standards/typescript-common-conventions.md`](docs/standards/typescript-common-conventions.md)
的「注释」章节 —— 适用范围（谁必须有注释）、机械门禁检查什么、提交前人工检查什么，全在那里。
**本节不重复规则，只列 Runtime 仓的额外强调**，避免同一判据出现两份表述：

- 与 Port 一起演进的请求/结果类型应说明所有权和失败语义；宿主实现要求写在接口附近。
- Port JSDoc 应说明 Runtime 默认实现和默认组装入口；若实现只能由宿主提供，则明确标注宿主责任。

## 开发与测试流程

所有变更按“需求 → 计划 → 编码 → 验证 → 文档影响审查 → 交付”执行；三样产出、触发判据与验收条件
去向见 [`docs/standards/development-workflow.md`](docs/standards/development-workflow.md)。

- **第 1 步先判断能力归属**：高层 `agent` 门面、低层 Pipeline，还是宿主应用；服务端职责不得进入 SDK。
- 可观察行为严格 Red → Green → Refactor；bug 可复现时先添加失败回归测试。
- 只实现让测试通过的最小变化，再在绿色测试下重构；保持 `protocol / port → service / adapter →
  composition` 单向依赖。
- 公开契约、并发、取消、checkpoint、interrupt、工具、流式 LLM 和观测必须覆盖 happy path、主要失败与取消。
- TypeScript 测试位于 `test/`；稳定序列化 fixture 位于 `testdata/conformance`。
- 单个 `*.test.ts` 超过 400 行会触发架构检查 warning；这不是失败红线，但评审前应优先按能力或场景拆分，
  公共测试夹具放在相邻的非测试文件中，不能靠压缩排版规避提示。
- 自定义 CheckpointStore 行为通过 `red-bean-qing-tuan/testing` 的契约套件验证。
- 公开 API 同步契约与迁移说明；默认行为变化同步 README/CHANGELOG。
- 不在实现过程中顺带扩大未批准的公共接口或安全权限。
- 定向验证先跑最接近改动的检查（如 `pnpm test -- --test-name-pattern='CheckpointStore'`）；
  测试名称与包以当前代码为准，不要把示例命令当作固定清单。
- 纯文档、配置、生成文件或机械接线可豁免先写测试，但必须说明原因并执行最近风险的静态或契约检查。

## 兼容性与决策权限

- 必须询问：破坏公开 API/序列化兼容性、不可逆数据或外部副作用、新的生产依赖、现有范围外能力、
  未批准的安全边界变化。
- 已批准迁移计划内的兼容实现、测试、文档和本地验证可自主完成，不重复询问。
- TypeScript API 尚未正式 semver 发布，但任何 surface 变化仍须更新快照、契约、迁移指南和产品消费方。
- commit、push、merge、发布和消费方仓库修改只在用户明确授权时执行。

## 文档影响门禁

每次代码、配置、依赖或目录变化后，从 [`docs/README.md`](docs/README.md) 打开相关活文档并逐份判断：

| 改动 | 必查文档 |
| --- | --- |
| 高层入口、安装或快速开始 | README、TypeScript API contract |
| 导出 API、错误、事件或扩展点 | `contracts/typescript-runtime-api.md`、API snapshot、契约测试 |
| 模块边界或数据流 | `design/architecture.md` |
| 压缩与内容恢复 | `design/compression.md` |
| 迁移状态或删除项 | CHANGELOG、当前 plan |
| 开发规范、命令或目录 | AGENTS、standards、Makefile |

`make docs-check` 只验证索引、链接和 Skill 单一来源，不能替代语义审查。

## 常用命令

日常几条；**完整门禁清单见
[`docs/standards/typescript-coding-conventions.md`](docs/standards/typescript-coding-conventions.md)「门禁」**，
本节不重列。

```bash
make setup            # 安装锁定的 TypeScript 工具链
make ts-build         # 构建 TypeScript ESM、声明与 source map
make ts-test          # 运行 TypeScript Runtime 测试
make ts-api-check     # 校验 6 个公开入口与 API surface
make typecheck        # TypeScript 严格类型检查
make ts-lint          # TypeScript 类型感知 ESLint
make verify           # TypeScript Runtime 完整本地门禁
```

`make verify*` 不得修改 Git 跟踪文件。可选 Git hooks 不自动安装；使用 `--no-verify` 后仍须在交付前补跑。
交付前还要执行 `git diff --check`、复查最终文件清单并报告文档影响和提交/同步状态。
