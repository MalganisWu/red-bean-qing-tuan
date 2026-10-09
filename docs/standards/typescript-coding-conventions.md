# TypeScript Runtime 编码规范

> 文档性质：活文档。适用于当前 TypeScript Runtime 的全部 `.ts` 源码。

## 原则

TypeScript 迁移用于减少产品跨语言契约对账，不允许通过类型体操、框架反射或 JavaScript 隐式行为
换取表面上的代码简短。Runtime 公共契约必须明确、可替换，并在静态类型消失后仍能正确验证外部输入。

## 显式边界

- 导出函数、公开方法、构造函数依赖和跨模块回调必须显式声明参数及返回类型。
- LLM、Tool、Event、Checkpoint、Interrupt、Hook 和观测适配器边界必须显式声明。
- 简单局部常量和已经由声明位置完整约束的回调允许类型推导。
- 协议实现对象优先使用 `satisfies`，避免扩大字面量类型或用断言跳过检查。
- 为满足接口形状而保留但确实不使用的参数必须以 `_` 开头；其他未使用变量仍由编译器和 ESLint 拒绝。

## 禁止项

- 禁止显式 `any`、非空断言和双重断言；未知输入从 `unknown` 开始窄化。
- 禁止用 `as Target` 代替外部数据校验；允许 `as const`。
- 禁止 `@ts-ignore`；类型契约测试中的 `@ts-expect-error` 必须包含原因。
- 禁止 `enum`、运行时代码 namespace、参数属性、Decorator、Reflect Metadata 和自动依赖注入。
- 禁止 Service Locator、全局可变注册表、Monkey Patch、原型修改和 `eval`。
- 禁止含糊真假判断、隐式数字/字符串转换、`==` 与 `!=`。
- 禁止浮空 Promise、异步函数误传同步回调和静默吞错。
- 错误包装必须保留 cause 链：catch（或 catch 内部的重新抛出）携带原始错误，使用 `new Error(message, { cause })`
  或自定义错误类的 cause 参数，不得只取 `message` 重抛。错误分类（码/kind）服务于契约，错误链（cause）
  服务于可定位性；两者缺一不可。
- 禁止通过放宽配置或整文件 disable 逃避门禁。
- 错误码、状态码、事件类型、命令 kind 等字面量联合的比较与 case 标签必须引用 const 成员
  （`CODE.X`）；无 const 源时先建立 const 映射，禁止直接写字符串字面量。理由：成员引用让 IDE
  的 Go to Definition / Find Usages 在定义与全部使用点之间双向可跳，并防止拼写漂移
  （详见 `docs/decisions/2026-09-10-comment-governance.md`）。

## 泛型

- 泛型必须表达多个位置之间的类型关系；只出现一次的类型参数改用具体类型或 `unknown`。
- 通常最多两个泛型参数，名称使用 `TInput`、`TOutput`、`TEvent` 等语义形式。
- 公共 API 优先使用判别联合和小接口，不使用重载或递归条件类型隐藏运行状态。
- 复杂类型工具仅限 core 或 tooling，必须有类型级测试和用途说明。

## Runtime 特有要求

- `AbortSignal` 作为取消边界显式传递，不保存在全局状态。
- Promise、stream、iterator 和资源所有权必须明确；创建方负责关闭或取消。
- 事件联合必须可穷尽；新增事件不能依赖字符串拼接或宽泛索引签名绕过调用方检查。
- checkpoint revision、Tool 参数和 LLM 响应必须在不可信边界进行运行时 Schema 校验。
- SDK 主包不依赖 HTTP 服务、数据库、Redis 或产品展示类型。
- `*-dto.ts` 或 `*/core/dto.ts` 只允许类型和 interface；校验、序列化、映射和业务函数必须放在相邻的
  parser、serializer、presenter 或 service 模块。

## Port 与默认实现

- 注入型行为接口必须使用明确职责名。既有 `Adapter`、`Dispatcher`、`Store`、`Registry`、`Factory`、
  `Hook`、`Tracer`、`Node`、`Runner` 等后缀已表达 Port 语义，不机械追加 `Port`。
- Runtime 自带的生产或默认实现类必须显式 `implements` 对应接口，不得只依靠结构化类型兼容。工厂返回
  协议对象时必须声明返回类型或使用 `satisfies`。
- Port JSDoc 应指出 Runtime 默认实现及默认组装入口；没有默认实现时说明由宿主提供。
- 默认实现必须在 `AgentRuntime`、builder 或宿主 composition root 中通过明确的
  `new ConcreteClass(...)` 组装。生产代码不得以匿名对象、模块副作用或运行期扫描隐藏实现选择；测试
  fake 可以使用对象字面量，但必须接受显式 Port 类型约束。
- 接口只服务于真实的多实现、宿主替换或公开契约边界：公开 API 导出的接口是消费方契约，必须保留且受
  semver 约束；SDK 内部 1:1 且无多实现/宿主替换需求的能力接口应删除，调用方直接依赖实现类。无 Port
  实现类登记在 `scripts/check-architecture.mjs` 白名单并附理由（判据同宿主产品侧：接口保留在"宿主或
  测试需要替换它的地方"）。

人工审查按 `依赖字段 → Port → implements → facade/builder/宿主 composition root 中的 new → 实现方法`
追踪。调用处没有 `new` 是构造注入的预期结果，组装入口必须补足实现选择的证据链。

## 中文注释

- 生产代码注释与 JSDoc 使用简体中文，专有协议名和代码标识保留原文。
- 公开入口、Core Contract/DTO、Port、默认实现、复杂状态机、并发/一致性、安全限制和反直觉分支必须
  解释设计意图、所有权或失败语义。
- 注释说明“为什么”和边界，不逐行复述显而易见的代码；实现变化时同步更新或删除失真注释。
- 测试名称与第三方协议原文可保留英文；非显然的测试准备、故障注入和断言原因优先写中文注释。

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

这些命令是只读检查。检查失败后修复真实类型或控制流，不使用断言、disable 注释或降低规则掩盖问题。
