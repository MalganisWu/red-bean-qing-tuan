# AGENTS.md · red-bean-qing-tuan

Agent Runtime SDK 的 AI 开发助手手册。本文件是**治理入口**：项目边界、路由、协作权限与命令。
**编码规范与开发流程的规则本体在 Skill 里**，本文件只做路由，见「[编码规范](#编码规范)」与
「[开发与测试流程](#开发与测试流程)」两节。

## 开始任务

1. 完整读取本文件（根 `AGENTS.md`）。
2. 按将要读写的路径，完整读取沿途适用的模块级 `AGENTS.md`；规则冲突时以离目标文件最近者为准。
3. 完整读取上面「编码规范」与「开发与测试流程」指向的 Skill——**规则本体在那里**。
4. 检查工作区状态，保留用户已有改动；范围或权限不明确时先确认。

## 编码规范

写 TypeScript 代码前，完整读取
[`skills/red-bean-qing-tuan-coding-conventions/SKILL.md`](skills/red-bean-qing-tuan-coding-conventions/SKILL.md)
及其 [`references/common.md`](skills/red-bean-qing-tuan-coding-conventions/references/common.md)。

前者是本仓编码规则的**唯一事实来源**（语言与风格、架构与依赖、注释、兼容性与判断边界、
公开契约与发布物、门禁）；后者是**跨仓共享**的通用 TypeScript 规则（类型标注边界、硬性禁止、
外部输入、泛型、控制流与错误、函数与流程可读性、表达式与调用可读性、判空与可空映射、
命名与签名约定、注释、门禁）。

## 开发与测试流程

任何开发任务前，完整读取
[`skills/red-bean-qing-tuan-development-workflow/SKILL.md`](skills/red-bean-qing-tuan-development-workflow/SKILL.md)
及其 [`references/common.md`](skills/red-bean-qing-tuan-development-workflow/references/common.md)。

前者写本仓特有的流程落点；后者是**跨仓共享**的通用流程（一次开发的产出 plan / decision / design
及触发判据、三条红线、各自骨架、验收条件去向、变更分级、六阶段、执行纪律、文档影响审查、交付核验）。

## 目录与边界

### 代码

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
├── skills/                编码规范与开发流程的规则本体
├── docs/                  契约、设计、指南、标准与冻结记录
└── package.json           npm exports 与构建入口
```

完整模块划分见 [`docs/design/architecture.md`](docs/design/architecture.md)。

### 公开边界

- `package.json#exports` 是 TypeScript **唯一公开边界**。消费方不得导入 `src/**`、`dist/**` 或未列出的深层路径。
- `make ts-api-check` 校验声明可消费性、6 个入口和 API surface 快照。
- 从公开入口逐层人工审查时，先读 [`src/README.md`](src/README.md) 的入口矩阵。

### 文档

| 分类 | 目录 | 生命周期 |
| --- | --- | --- |
| 契约 | `docs/contracts/` | 活文档；描述当前 TypeScript API |
| 设计 | `docs/design/` | 活文档；描述**当前**架构、数据流与 SDK/宿主边界——面向功能；不写进度与排期，也不写代码书写规范（后者在 `standards/` 与 `skills/`） |
| 指南 | `docs/guides/` | 活文档；描述接入、迁移与操作方式 |
| 标准 | `docs/standards/` | **短指针**——规则实体在 `skills/`；本目录只保住既有路径与链接 |
| 计划 | `docs/plans/` | 任务文档；执行期可改，交付后冻结 |
| 决策记录 | `docs/decisions/` | 冻结；只追加不修改 |

完整导航见 [`docs/README.md`](docs/README.md)。进行中的 plan 可以修订；交付后只更新活文档或源码，
不得回写历史 plan 替代当前事实。

## 门禁

**本仓门禁命令的唯一清单就在这里**；其他文档只引用，不重列。`make verify` 依次执行：

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

配置位于仓库根 `tsconfig.json`、`eslint.config.js` 与 `tooling/typescript/`。
这些命令是只读检查；失败后修复真实类型或控制流，不使用断言、disable 注释或降低规则掩盖问题。

## Skill

规则本体住在 Skill 里，上面「[编码规范](#编码规范)」与「[开发与测试流程](#开发与测试流程)」两节
分别指向适用的那一份。`skills/` 是**唯一源**，任何地方都不复制规则正文。

**`.agents/skills/` 随仓走**——它是 [Agent Skills](https://agentskills.io) 的开放标准路径，多个
工具（Codex、OpenCode 等）从这里发现 Skill，仓库因此不偏向任何一家。其余是各家工具的私有目录
（`.claude/`、`.cursor/`、`.codex/` …），**一律不进库**；用哪个，自己在本地建符号链接指向
`skills/<name>` 即可。两个 Skill 都**自包含**：规则正文在自己的目录里，不依赖本文件才能读懂。

Skill 按任务自动触发，本文件的路由是另一条到达路径。`make docs-check` 校验 Skill 的 frontmatter
格式、「`name` 必须等于目录名」，以及 `.agents/skills/` 下每个 Skill 都是指向 `skills/<name>`
的符号链接。

## 决策权限

- 必须询问：破坏公开 API/序列化兼容性、不可逆数据或外部副作用、新的生产依赖、现有范围外能力、
  未批准的安全边界变化。
- 已批准迁移计划内的兼容实现、测试、文档和本地验证可自主完成，不重复询问。
- **提交与分支**：commit message 用中文、格式 `<type>: <简短描述>`（`feat:` / `fix:` / `refactor:`
  / `docs:` / `polish:`）；分支命名 `feat/<描述>`、`fix/<描述>`，kebab-case。
- commit、push、merge、发布和消费方仓库修改只在用户明确授权时执行。

## 文档影响审查

每次代码、配置、依赖或目录变化后，从 [`docs/README.md`](docs/README.md) 打开相关活文档并逐份判断：

| 改动 | 必查文档 |
| --- | --- |
| 高层入口、安装或快速开始 | README、TypeScript API contract |
| 导出 API、错误、事件或扩展点 | `contracts/typescript-runtime-api.md`、API snapshot、契约测试、产品消费方 |
| 模块边界或数据流 | `design/architecture.md` |
| 压缩与内容恢复 | `design/compression.md` |
| 迁移状态或删除项 | CHANGELOG、当前 plan |
| 开发规范、命令或目录 | AGENTS、standards、skills、Makefile |

`make docs-check` 只验证索引、链接和 Skill 单一来源，不能替代语义审查。

## 常用命令

日常几条；**完整门禁清单见本文件「[门禁](#门禁)」**，本节不重列。

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

## 项目定位

`red-bean-qing-tuan` 是轻量、可嵌入的 TypeScript Agent Runtime SDK，不是服务。公开入口为主包及
`/llm`、`/pipeline`、`/tools`、`/observability`、`/testing`。

Runtime 提供 model→tool 循环、Pipeline、工具系统、LLM adapter、checkpoint 契约、interrupt、压缩、
委派和中性观测扩展。宿主注入模型、状态存储、工具与部署能力。SDK 不提供 HTTP 服务、数据库 schema、
Redis 客户端、产品 Session、UI 展示或生产 lease 服务。

TypeScript 源码构建为 ESM JavaScript 和声明文件，保持零生产依赖。
