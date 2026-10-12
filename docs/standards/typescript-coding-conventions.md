# TypeScript Runtime 本仓规范

> 文档性质：活文档。适用于本仓全部 `.ts` 源码。
> **通用规则已抽到 [`typescript-common-conventions.md`](typescript-common-conventions.md)**，该文件与
> 产品仓 `red-bean-nian-gao` 逐字相同并由门禁校验。本文件只写 Runtime 特有的约束；两者冲突时以
> 通用件为准，本文件只做补充。

## Runtime 特有要求

- `AbortSignal` 作为取消边界显式传递，不保存在全局状态。
- Promise、stream、iterator 和资源所有权必须明确；创建方负责关闭或取消。
- 事件联合必须可穷尽；新增事件不能依赖字符串拼接或宽泛索引签名绕过调用方检查。
- checkpoint revision、Tool 参数和 LLM 响应必须在不可信边界进行运行时 Schema 校验。
- **SDK 主包零生产依赖**：不依赖 HTTP 服务、数据库、Redis 或产品展示类型。宿主能力一律通过
  显式接口注入，由产品仓在组装期提供实现。
- `*-dto.ts` 或 `*/core/dto.ts` 只允许类型和 interface；校验、序列化、映射和业务函数必须放在
  相邻的 parser、serializer、presenter 或 service 模块。

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

## 组装与架构门禁

- 无 Port 实现类必须登记在 `scripts/check-architecture.mjs` 的白名单并附理由，判据是「宿主或测试
  需要替换它的地方」。
- 默认实现必须在 `AgentRuntime`、builder 或宿主 composition root 中通过明确的
  `new ConcreteClass(...)` 组装；生产代码不得以匿名对象、模块副作用或运行期扫描隐藏实现选择。
- 能力之间保持单向依赖；`make ts-architecture-check` 会校验能力 DAG 无环、实现与接口精确对应、
  中文 JSDoc 覆盖重要契约，以及 DTO 纯度。

## 门禁

配置位于仓库根 `tsconfig.json`、`eslint.config.js` 与 `tooling/typescript/`。提交前至少执行：

```bash
make typecheck
make ts-lint
make ts-format-check
make ts-policy-check
make ts-api-check
make verify
```

`make verify` 已包含上述全部步骤。这些命令是只读检查；失败后修复真实类型或控制流，不使用断言、
disable 注释或降低规则掩盖问题。
