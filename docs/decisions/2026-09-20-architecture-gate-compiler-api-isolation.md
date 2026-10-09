# 决策：架构门禁与 TypeScript 编译器 API 解耦

状态：已接受
日期：2026-09-20

背景：`scripts/check-architecture.mjs` 直接消费 TypeScript 编译器 API：AST 解析、跨文件符号解析、
读取 `tsconfig.json` 构造 program，以及用内存 compiler host 驱动夹具自测。TypeScript 7.0 已把编译器
改写为 Go 原生程序且不提供公开编译器 API（7.1 才带来与 6.x 不同的新 API），该依赖使门禁无法随主版本
升级。宿主产品仓已完成同类改造（`backend/scripts/architecture-syntax.mjs`），本仓沿用同一结构。

选项：

- (a) 新增 `scripts/architecture-syntax.mjs` 隔离层，把编译器 API 收敛到一处，并用 source provider
  参数化 program 构造：不传 `sources` 时读磁盘真实源码，传入 `Map<绝对路径, 源码>` 时用内存 host
  喂夹具虚拟源码（选定）。
- (b) 夹具改为写入临时目录再走磁盘路径：需要文件系统副作用、清理与路径冲突处理，违背门禁"快速、
  只读"的定位，且夹具分析根目录会随临时路径漂移。
- (c) 让 import 依赖图改用 program 语义解析：没有必要——门禁的依赖图一直由正则预解析 specifier 加
  磁盘 `.js → .ts` 解析构建，program 只服务于 `implements`/`new` 语义审计。

决策：采用 (a)。隔离层对外只暴露中性语句事实（语句/声明种类、名字、export 修饰符、1 起始行号、
前导注释原文、implements 类型名）与两个语义查询（implements 类型名 → 具名 interface；每个
`new X()` → 类声明）。文件系统关注点（`.js → .ts`、`index.ts`、存在性检查）留在规则文件。

理由：行为改动最小——内存 host 的逻辑原样迁移，磁盘与内存两条路径共用同一套语义查询；门禁仍然只读
且无文件系统副作用；升级 TypeScript 主版本时只需替换隔离层实现。重构前后脚本 stdout/stderr 逐字
一致，独立对照脚本也证明正则加磁盘的 import 图与 program 模块图在 145 个生产文件上边集与环判定
完全一致。

后果：

- `scripts/check-architecture.mjs` 不再导入 `typescript`，编译器 API 调用清零；夹具 host 与符号解析
  逻辑迁入隔离层。
- 隔离层是唯一的编译器版本耦合点；TS 7.1 新 API 落地或 `typescript/unstable/ast` 可用时在此替换。
- `sources` 参数只服务夹具自测，生产路径不传即以磁盘为准。