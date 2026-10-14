---
name: red-bean-qing-tuan-coding-conventions
description: 在 red-bean-qing-tuan 中编写、修改、重构或评审 TypeScript 代码，或调整类型标注、接口、依赖注入、错误处理、注释时使用；给出本仓编码落点，并指向跨仓共享的通用 TypeScript 规则。纯 Markdown、纯配置或无 TypeScript 代码的改动不使用。
---

# red-bean-qing-tuan 编码规范

> 本 Skill 是本仓**编码规则的唯一事实来源**。
> 通用 TypeScript 规则在 [`references/common.md`](references/common.md)——与产品仓 `red-bean-nian-gao`
> 中的同名文件**逐字相同**，由 `scripts/check-shared-files.mjs` 校验。**两者冲突时以通用件为准**；
> 本文件只写本仓特有约束与落点。

**写代码前完整读取两份**：本文件 + [`references/common.md`](references/common.md)。

## 语言与风格

通用规则（类型标注边界、硬性禁止、外部输入、泛型、控制流与错误、函数与流程可读性、表达式与调用
可读性、判空与可空映射、命名与签名约定）全在 [`references/common.md`](references/common.md)。
本仓额外强调：

- revision/fencing 使用 `bigint`，不得经不安全的 `number` 转换。
- Promise、stream、iterator 的所有权与关闭责任必须明确：创建方负责关闭或取消。
- 事件联合必须可穷尽；新增事件不能依赖字符串拼接或宽泛索引签名绕过调用方检查。
- checkpoint revision 从持久化层读回后必须运行时校验，不能只靠静态类型。
- **SDK 主包零生产依赖**：不依赖 HTTP 服务、数据库、Redis 或产品展示类型。宿主能力一律通过
  显式接口注入，由产品仓在组装期提供实现。
- `*-dto.ts` 或 `*/core/dto.ts` 只允许类型和 interface；校验、序列化、映射和业务函数必须放在
  相邻的 parser、serializer、presenter 或 service 模块。
- 错误「类型不重要、可定位性优先」——SDK 的 adapter/plugin 包装宿主错误时尤其遵守，不得只取
  `message` 重抛使宿主日志断链。

## 架构与依赖

完整架构见 [`docs/design/architecture.md`](../../docs/design/architecture.md)。顶层能力依赖方向固定：

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

硬边界：

- `src/protocol` 与各能力的 `port/` 只包含中性类型、小型纯 helper 和接口，不依赖宿主或具体基础设施。
- 纯数据 DTO 按所属能力放在 `model/` 或 `request/`，只允许类型和 interface，不允许函数、Schema 或
  运行时常量；parser、serializer 和业务规则必须放在相邻专责文件。Port 与领域状态不是 DTO，不为形式
  统一混入 DTO。Runtime 不建立全局 DTO 大文件，也不接收产品 HTTP DTO。
- 一个模块的实现不直接耦合另一个模块的内部实现；跨模块通过公开入口和最小接口组合。
- 禁止重新建立宽泛的 `core/`、`impl/` 或 `dto.ts` 聚合目录；能力目录采用 `port/` 配合
  `service/adapter`，纯转换保留为具名函数。
- 高层 `AgentRuntime` 与低层 Pipeline 共用一套中性消息、事件、Tool、Interrupt 和 Checkpoint 语义。
- 默认实现必须可替换；`MemoryCheckpointStore` 仅是单进程参考实现。产品取消、锁与 ID registry
  属于宿主，SDK 不提供。
- SDK 只定义 revision/CAS/fencing/Resume claim 协议，不实现数据库、Redis、lease、heartbeat、
  超时接管或 exactly-once 外部副作用；这些属于宿主。
- 静态插件仅在构造期注册并封闭。禁止恢复动态热更新、Generation、Supervisor 或运行期插件市场。
- 文件和网络工具默认 fail-closed，必须由宿主显式选择并授权。
- 公开 API 的接口是消费方契约，必须保留；SDK 内部 1:1 且无多实现/宿主替换需求的能力接口应删除。
- 没有对应接口的默认实现类必须登记在 `scripts/check-architecture.mjs` 的白名单中并附理由；
  判据是「宿主或测试需要替换它的地方」。
- 本仓的默认组装入口是 `AgentRuntime`、builder 或宿主 composition root。
- 能力之间保持单向依赖；`make ts-architecture-check` 校验能力 DAG 无环、实现与接口精确对应
  以及 DTO 纯度。

新增 TypeScript 能力必须同时审查公开 exports 和宿主影响。

## 注释

注释的唯一事实来源是 [`references/common.md`](references/common.md) 的「注释」章节——适用范围
（谁必须有注释）、机械门禁检查什么、书写要求、提交前人工检查，全在那里。本仓额外强调：

- 与 Port 一起演进的请求/结果类型应说明所有权和失败语义；宿主实现要求写在接口附近。
- Port JSDoc 应说明 Runtime 默认实现和默认组装入口；若实现只能由宿主提供，则明确标注宿主责任。

## 兼容性与判断边界

- 必须询问：破坏公开 API/序列化兼容性、不可逆数据或外部副作用、新的生产依赖、现有范围外能力、
  未批准的安全边界变化。
- 已批准迁移计划内的兼容实现、测试、文档和本地验证可自主完成，不重复询问。
- TypeScript API 尚未正式 semver 发布，但任何 surface 变化仍须更新快照、契约、迁移指南和产品消费方。

## 公开契约与发布物

本仓是对外发布的包，公开面比内部代码受更严的约束：

- 六个公开入口经 `public-api` 聚合；入口之外的文件不是契约，可以自由重构。
- 公开 API 导出的接口是消费方契约，必须保留且受 semver 约束。SDK 内部 1:1 且无多实现或宿主
  替换需求的能力接口应删除，调用方直接依赖实现类。
- 公开 API surface 快照与 TypeScript 声明基线分别由 `testdata/api/public-exports.json` 与
  `testdata/api/public-declarations.sha256` 锁定。**JSDoc 会编译进 `.d.ts`**，因此任何注释改动
  都要重生成声明基线；顺序是构建 → 更新基线 → 验证，不能倒过来。
- 修改公开面时必须先跑 `make ts-api-check`：`check-api-surface.mjs` 通过只说明导出形状没变，
  与声明基线是两道独立检查，不能互相替代。

## 门禁

配置位于仓库根 `tsconfig.json`、`eslint.config.js` 与 `tooling/typescript/`。**本仓门禁命令的唯一
清单**就在这里；其他文档只引用，不重列。`make verify` 依次执行：

```bash
make doctor                 # 工具链版本与 package 声明
make fmt-check              # 格式检查（只读）
make diff-check             # git diff 空白检查
make secrets-check          # 环境文件与高置信度密钥扫描
make build                  # 构建 ESM、声明与 source map
make docs-check             # 文档索引与链接
make shared-files-check     # 跨仓共享件逐字一致
make ts-policy-check        # TypeScript 政策
make ts-architecture-check  # 架构门禁（能力 DAG、DTO 纯度）
make ts-export-jsdoc-check  # 注释门禁
make ts-api-check           # 公开入口与声明基线
make typecheck              # 严格类型检查
make ts-lint                # 类型感知 ESLint
make test                   # 测试
```

这些命令是只读检查；失败后修复真实类型或控制流，不使用断言、disable 注释或降低规则掩盖问题。
