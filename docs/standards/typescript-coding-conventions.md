# TypeScript Runtime 本仓规范

> 文档性质：活文档。适用于本仓全部 `.ts` 源码。
> **通用规则已抽到 [`typescript-common-conventions.md`](typescript-common-conventions.md)**，该文件与
> 产品仓 `red-bean-nian-gao` 逐字相同并由门禁校验。本文件只写 Runtime 特有的约束；两者冲突时以
> 通用件为准，本文件只做补充。

## Runtime 特有要求

- Promise、stream、iterator 的所有权与关闭责任必须明确：创建方负责关闭或取消。
- 事件联合必须可穷尽；新增事件不能依赖字符串拼接或宽泛索引签名绕过调用方检查。
- checkpoint revision 从持久化层读回后必须运行时校验，不能只靠静态类型。
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

- 无对应接口的默认实现类登记在 `scripts/check-architecture.mjs` 的白名单并附理由。
- 本仓的默认组装入口是 `AgentRuntime`、builder 或宿主 composition root。
- 能力之间保持单向依赖；`make ts-architecture-check` 会校验能力 DAG 无环、实现与接口精确对应
  以及 DTO 纯度。注释的完整性与语言由 `make ts-export-jsdoc-check` 统一负责。

## 门禁

配置位于仓库根 `tsconfig.json`、`eslint.config.js` 与 `tooling/typescript/`。**本仓门禁命令的唯一清单**
就在这里；其他文档只引用，不重列。`make verify` 依次执行：

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
