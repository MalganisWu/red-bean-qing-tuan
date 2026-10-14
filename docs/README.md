# Runtime 文档索引

本页只负责导航。文档分类、更新义务与交付规则以根目录 [`AGENTS.md`](../AGENTS.md) 为准。

代码、配置或目录发生变化时，先用本页确定受影响类别，再打开该类别下与改动相关的每份文档。
更新本索引只能证明导航完整，不能代替对链接目标的语义审查。

## 活文档

> 一次开发的产出只有 `plans/` / `decisions/` / `design/` 三样，触发判据与红线见
> [`standards/development-workflow.md`](standards/development-workflow.md)「一次开发的产出」。
> 本节索引**活文档**（描述当前事实）；`design/` 不写进度与排期。

- [`../src/README.md`](../src/README.md)：从六个公开入口到 core contract、实现与宿主 adapter 的人工审查导航。
- [`contracts/typescript-runtime-api.md`](contracts/typescript-runtime-api.md)：当前 TypeScript 包的公共入口与契约。
- [`design/architecture.md`](design/architecture.md)：当前 Runtime 架构、模块与依赖边界。
- [`design/compression.md`](design/compression.md)：上下文压缩与内容恢复机制。
- [`standards/typescript-common-conventions.md`](standards/typescript-common-conventions.md)：跨仓共享的 TypeScript 通用规范，与产品仓 `red-bean-nian-gao` 逐字相同，由 `scripts/check-shared-files.mjs` 校验。
- [`standards/typescript-coding-conventions.md`](standards/typescript-coding-conventions.md)：Runtime 特有的约束（零生产依赖、公开契约与发布物、组装与架构门禁）。
- [`standards/development-workflow.md`](standards/development-workflow.md)：开发与交付流程。

快速开始位于根 [`README.md`](../README.md)，开发规则位于根 [`AGENTS.md`](../AGENTS.md)，
未发布变化位于 [`CHANGELOG.md`](../CHANGELOG.md)。

## 决策记录

- [`decisions/`](decisions/)：决策记录（格式为 ADR 式的「背景 / 选项 / 决策 / 理由 / 后果」），
  只追加不修改。**不是全部都是架构决策**，因此不用「ADR」泛指它们。

决策记录用于解释“当时为什么这样决定”，不作为当前接口或行为的唯一依据。当前行为以活文档、
TypeScript 声明、契约测试和源码为准。

新增、删除、移动或重命名活文档时，必须同步本索引；`make docs-check` 会检查是否漏收录。
