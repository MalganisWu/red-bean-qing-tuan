---
name: red-bean-qing-tuan-development-workflow
description: 在 red-bean-qing-tuan 中开发、修复、重构、评审、测试或交付代码时使用；给出一次开发的产出与必读顺序，并指向跨仓共享的开发流程规则。
---

# red-bean-qing-tuan 开发流程

> 本 Skill 是本仓**开发流程的唯一事实来源**。
> 通用流程（一次开发的产出、触发判据、三条红线、各自骨架、验收条件去向、变更分级、六阶段、
> 执行纪律、文档影响审查、交付核验）在 [`references/common.md`](references/common.md)——
> 与产品仓 `red-bean-nian-gao` 中的同名文件**逐字相同**，由 `scripts/check-shared-files.mjs` 校验。
> 本文件只写本仓特有的流程落点。

**开始任务前完整读取两份**：本文件 + [`references/common.md`](references/common.md)。

## 本仓特有的流程落点

- **第 1 步先判断能力归属**：高层 `agent` 门面、低层 Pipeline，还是宿主应用；**服务端职责不得进入 SDK**。
- 只实现让测试通过的最小变化，再在绿色测试下重构；保持 `protocol / port → service / adapter →
  composition` 单向依赖。
- 公开契约、并发、取消、checkpoint、interrupt、工具、流式 LLM 和观测必须覆盖 happy path、主要
  失败与取消。
- TypeScript 测试位于 `test/`；稳定序列化 fixture 位于 `testdata/conformance`。
- 单个 `*.test.ts` 超过 400 行会触发架构检查 warning；这不是失败红线，但评审前应优先按能力或场景
  拆分，公共测试夹具放在相邻的非测试文件中，不能靠压缩排版规避提示。
- 自定义 CheckpointStore 行为通过 `red-bean-qing-tuan/testing` 的契约套件验证。
- 公开 API 同步契约与迁移说明；默认行为变化同步 README/CHANGELOG。
- 不在实现过程中顺带扩大未批准的公共接口或安全权限。
- **定向验证**先跑最接近改动的检查（如 `pnpm test -- --test-name-pattern='CheckpointStore'`）；
  测试名称与包以当前代码为准，不要把示例命令当作固定清单。
- 纯文档、配置、生成文件或机械接线可豁免先写测试，但必须说明原因并执行最近风险的静态或契约检查。
