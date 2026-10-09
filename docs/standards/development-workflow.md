# Runtime 开发流程

> 文档性质：活文档。Runtime 是 TypeScript SDK；流程中不包含 HTTP 端点、数据库 migration 或服务部署。

## 变更分级

| 级别 | 示例 | 前置产物 |
| --- | --- | --- |
| 轻量 | 文案、注释、内部重构、小型 bug | 明确验收条件；无需强制新建 spec/plan |
| 标准 | 新增兼容 Option、工具、适配器、默认实现 | 需求边界和简短实施计划，可写入任务记录 |
| 架构/兼容性 | 新模块、公开接口变化、并发或持久化语义变化 | `docs/specs/` + `docs/plans/`；破坏兼容性先获得授权 |

是否需要 spec/plan 由风险和公共影响决定，不以代码行数决定。交付后的 spec/plan 冻结；当前行为写入
contract、design、guide、README 或 CHANGELOG。

## 工作步骤

### 1. 确认边界

- 明确使用者、可观察行为、兼容性和不做什么。
- 先读 `docs/README.md`，再读取相关 contract/design/guide、TypeScript 声明和实现。
- 判断能力属于高层 `agent` 门面、低层 Pipeline，还是宿主应用；服务端职责不得进入 SDK。
- 新生产依赖、破坏公共 API、安全边界变化或外部副作用按 `AGENTS.md` 先询问。

### 2. 设计测试

- 行为变化先写会因目标能力缺失而失败的测试，并确认失败原因正确。
- Bug 修复优先写最小回归测试。
- 公开 Store、并发、interrupt、事件或工具契约同时覆盖 happy path、主要错误和取消。
- 纯文档、配置或机械接线可豁免先写测试，但要记录理由与替代验证。

### 3. 最小实现与重构

- 只实现让测试通过的最小变化，再在绿色测试下重构。
- 保持 `protocol / port → service / adapter → composition` 单向依赖和产品边界。
- 公开 API 同步契约和迁移说明；默认行为变化同步 README/CHANGELOG。
- 不在实现过程中顺带扩大未批准的公共接口或安全权限。

### 4. 定向验证

先运行最接近改动的检查，例如：

```bash
pnpm test -- --test-name-pattern='AgentRuntime'
pnpm test -- --test-name-pattern='ReAct'
pnpm test -- --test-name-pattern='CheckpointStore'
```

测试名称和包以当前代码为准；不要把示例命令当作永不变化的固定清单。

### 5. 文档影响审查

查看完整 diff，从 [`../README.md`](../README.md) 的活文档索引开始，沿相关链接逐份判断：

| 改动 | 必查文档 |
| --- | --- |
| 高层入口、配置或快速开始 | 根 README、TypeScript API contract |
| 导出 API、错误、事件或扩展点 | `contracts/typescript-runtime-api.md`、API snapshot、契约测试 |
| 模块边界或数据流 | `design/architecture.md` |
| 压缩与内容恢复 | `design/compression.md` |
| 迁移或删除项 | CHANGELOG、当前 plan |
| 开发规范、命令或目录 | AGENTS、standards、Makefile |

可以得出“无需更新”，但必须说明具体理由。新增、移动、重命名或删除活文档时同步索引与引用方。

### 6. 统一门禁与交付

```bash
make doctor
make docs-check
make secrets-check
make typecheck
make ts-lint
make ts-format-check
make ts-policy-check
make verify
```

所有 TypeScript 源码都必须通过上述专项门禁。

交付前还要确认 `git diff --check`、最终文件清单和文档影响结论。提交、推送、合并和发布只有在用户
明确授权时执行；不要因为进入“交付阶段”自动取得外部写入权限。

最终说明应包含：结果、测试先行证据或豁免理由、验证命令、文档影响，以及提交/同步状态。
