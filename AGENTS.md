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
| 设计 | `docs/design/` | 活文档；描述架构、数据流与 SDK/宿主边界 |
| 指南 | `docs/guides/` | 活文档；描述接入、迁移与操作方式 |
| 标准 | `docs/standards/` | 活文档；描述编码、测试与交付流程 |
| 需求 | `docs/specs/` | 任务文档；交付后冻结 |
| 计划 | `docs/plans/` | 任务文档；交付后冻结 |

进行中的 spec/plan 可以修订；交付后只更新 contract、design、guide、standard、README、CHANGELOG 或源码，
不得回写历史计划替代当前事实。

## 架构规则

详见 [`docs/design/architecture.md`](docs/design/architecture.md)。核心规则：

- `src/protocol` 与各能力的 `port/` 只包含中性类型、小型纯 helper 和接口，不依赖宿主或具体基础设施。
- 纯数据 DTO 按所属能力放在 `model/` 或 `request/`，只允许类型和 interface，不允许函数、Schema 或运行时常量；
  parser、serializer 和业务规则必须放在相邻专责文件。Port 与领域状态不是 DTO，不为形式统一混入 DTO。
  Runtime 不建立全局 DTO 大文件，也不接收产品 HTTP DTO。
- 实现通过构造函数或显式 factory 注入依赖；禁止 Decorator DI、Service Locator 和全局可变注册表。
- `LlmAdapter`、`ToolDispatcher`、`CheckpointStore`、`Tracer`、`RuntimeNode` 等既有职责名已表达 Port 语义，
  不为形式统一追加 `Port` 并破坏公共 API；新接口同样必须使用可辨识的职责后缀。
- Runtime 自带的生产/默认实现类必须显式 `implements` 对应接口，不能只依赖 TypeScript 结构化类型；
  默认组装必须能从公开 facade、builder 或宿主 composition root 找到明确的 `new ConcreteClass(...)`。
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
- 接口只服务于真实的多实现、宿主替换或公开契约边界：公开 API 的接口是消费方契约必须保留；SDK 内部
  1:1 且无多实现/宿主替换需求的能力接口应删除，调用方直接依赖实现类（无 Port 实现类登记在
  `scripts/check-architecture.mjs` 白名单并附理由）。判据同产品侧：接口保留在"宿主或测试需要替换它的地方"。

新增 TypeScript 能力必须同时审查公开 exports 和宿主影响。

## TypeScript 规则

所有 `.ts` 遵循跨仓共享的通用规范
[`docs/standards/typescript-common-conventions.md`](docs/standards/typescript-common-conventions.md)，
Runtime 特有约束见 [`docs/standards/typescript-coding-conventions.md`](docs/standards/typescript-coding-conventions.md)。硬性红线：

- 禁止显式 `any`、非空断言、无校验类型断言、浮空 Promise、隐式强制转换。
- 导出 API 以及 LLM、Tool、Event、Checkpoint、Interrupt、Hook 和 Tracer 边界必须显式标注。
- 外部输入从 `unknown` 开始，经过显式运行时校验后才能进入可信领域。
- 禁止 `enum`、Decorator、Reflect Metadata、自动依赖注入、Monkey Patch、`eval` 和复杂递归类型体操。
- `AbortSignal` 显式传递；Promise、stream、iterator 和资源的所有权与关闭路径必须明确。
- revision/fencing 使用 `bigint`，不得经不安全的 `number` 转换。
- 错误包装必须保留 cause 链：catch 后重新抛出必须携带原始错误（`new Error(message, { cause })` 或同等
  机制），不得只取 `message` 重抛使宿主日志断链。错误"类型不重要、可定位性优先"——SDK 的 adapter/plugin
  包装宿主错误时尤其遵守。
- 不得通过 disable 注释、断言或放宽 tsconfig 绕过检查。

## 中文注释规范

- 生产代码的注释和 JSDoc 统一使用简体中文；协议名、类名、字段名等专有标识保留原文。
- 公开入口、Core Contract/DTO、Port、默认实现、复杂状态机、并发与一致性、安全限制及反直觉分支必须
  说明设计意图或原因，不能只复述代码表面行为。
- 与 Port 一起演进的请求/结果类型应说明所有权和失败语义；宿主实现要求应写在接口附近。
- Port JSDoc 应说明 Runtime 默认实现和默认组装入口；若实现只能由宿主提供，则明确标注宿主责任。
- Runtime 默认实现类的公开用例方法必须有职责注释：做什么、边界在哪、何时抛错，不能只有方法名。
- 导出符号与公开成员（方法、访问器、公开属性）的 JSDoc 完整性与 `@param` / `@returns` 由
  `make ts-export-jsdoc-check` 机械校验。**它只覆盖可机械判定的那一半**：门禁过了不代表注释合格，
  「是否解释了复杂业务」「是否在复述显而易见的代码」仍然只能由评审判断。
- 方法体内注释以"意图与取舍、不变量与前提、分支划分依据"为最高价值；翻译式注释允许但低价值，
  不设排除清单——本仓优先保证注释充足。
- 流程超过三个阶段的业务方法推荐使用 `// ── 阶段名 ──` 分段标题，让执行顺序成为视觉事实。
- **唯一注释红线：注释必须与代码一致**（同 diff 更新）；失真注释比没有注释更有害，评审时必查。
- 跨任务决策（为什么选这条路、代价是什么）记入 `docs/decisions/`（ADR 式，只追加不修改）；
  代码注释只承载局部"为什么"。为显而易见的赋值、getter、简单条件逐行加注释仍应避免，但不作为硬禁。
- 错误码、状态码、事件类型、命令 kind 等字面量联合的比较与 case 标签必须引用 const 成员
  （`CODE.X`），禁止字符串字面量；无 const 源时先建立 const 映射。
- 测试名称和第三方协议原文可以保留英文，但测试中的非显然 setup、故障注入和断言原因优先使用中文注释。

## 开发与测试流程

所有变更按“需求 → 计划 → 编码 → 验证 → 文档影响审查 → 交付”执行，详见
[`docs/standards/development-workflow.md`](docs/standards/development-workflow.md)。

- 可观察行为严格 Red → Green → Refactor；bug 可复现时先添加失败回归测试。
- 公开契约、并发、取消、checkpoint、interrupt、工具、流式 LLM 和观测必须覆盖 happy path、主要失败与取消。
- TypeScript 测试位于 `test/`；稳定序列化 fixture 位于 `testdata/conformance`。
- 单个 `*.test.ts` 超过 400 行会触发架构检查 warning；这不是失败红线，但评审前应优先按能力或场景拆分，
  公共测试夹具放在相邻的非测试文件中，不能靠压缩排版规避提示。
- 自定义 CheckpointStore 行为通过 `red-bean-qing-tuan/testing` 的契约套件验证。
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

```bash
make setup            # 安装锁定的 TypeScript 工具链
make ts-build         # 构建 TypeScript ESM、声明与 source map
make ts-test          # 运行 TypeScript Runtime 测试
make ts-api-check     # 校验 6 个公开入口与 API surface
make typecheck        # TypeScript 严格类型检查
make ts-lint          # TypeScript 类型感知 ESLint
make ts-format-check  # TypeScript/tooling 格式检查
make verify           # TypeScript Runtime 完整本地门禁
```

`make verify*` 不得修改 Git 跟踪文件。可选 Git hooks 不自动安装；使用 `--no-verify` 后仍须在交付前补跑。
交付前还要执行 `git diff --check`、复查最终文件清单并报告文档影响和提交/同步状态。
