# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 变更

- **`maxConcurrentTools` 的非法取值不再退化为不限并发。** 未提供仍表示不限并发（行为不变）；显式
  传入 `0`、负数、非整数或 `NaN` 时，会在运行边界抛出可定位的配置错误，不进入工具派发。此前这些
  取值被静默当成「不限并发」——本想限制资源消耗的配置反而完全不限制。宿主的 agent 配置若依赖
  「填 `0` 即不限并发」，需要改掉。
- **报错说明改为简体中文**；稳定错误码（`RUNTIME_ERROR_CODES` 的值）一个没动。面向用户或日志的
  分支、告警分类与聚合应当只看 `code` —— 依赖 `message` 的全文或子串会随文案改进而失效，这条依赖
  本身就是缺陷。技术标识（字段名、协议名、具体 ID）保留原文。
- 错误文案不再承诺「固定不变」，改为只求可读：它会随版本改进。

### 新增

- `docs/glossary.md`：术语表。`checkpoint revision`、`fencing token`、`claim`、`interrupt 屏障`、
  `Token`（本仓是粗略估算）等各有一句话定义与「**不是**……」的边界。它是读者索引，不是第二个
  事实来源。

### 修复

- 取消排队等待时不再误摘队列指针，保住同 thread 的串行化。

### 文档与仓库

- 编码规范与开发流程的**规则本体移入 Skill**，各级 `AGENTS.md` 只做治理入口与路由；
  `docs/standards/` 收敛为短指针。
- **`.agents/skills/` 随仓走**（[Agent Skills](https://agentskills.io) 开放标准路径），
  仓库不绑定任何一家工具的私有目录。
- 新增 `make ts-export-jsdoc-check`：导出符号与公开成员的 JSDoc 门禁，零容忍、无棘轮基线。
- 注释形态规则：`/** */` 只写在「删掉它有工具的行为会变」的地方（符号文档、`@deprecated` 一类
  tag），其余一律 `//` —— 因为它会原样进 `.d.ts`，把内部说明变成对外文档。

## [0.1.0] - 2026-10-09

首个公开版本。

### 核心能力

- **Agent 循环**：模型流式输出、并发工具执行、重试、取消与超时，以及中断与恢复。
- **两级 API**：高层 `AgentRuntime`，以及可自由组合的低层 `RuntimeContext` / `PipelineBuilder` / `AgentNode`。
- **Checkpoint**：revision/CAS、可选 fencing、Resume claim/receipt、幂等 replay 与 delete tombstone。
- **静态插件**：构造期注册 Run / LLM / Tool middleware，顺序确定，资源反序清理。
- **中性观测**：`Tracer` 不绑定厂商，可接结构化日志、OpenTelemetry 或测试 recorder。
- **内置工具**：时间、HTTP/fetch、受限文件读取与委派，以及一组只注册、不自动授权的 `sys_*` 工具。

### 包结构

零生产依赖的 ESM 包，构建产物为 JavaScript、声明文件与 source map。开放六个白名单入口：

`red-bean-qing-tuan`、`/llm`、`/pipeline`、`/tools`、`/observability`、`/testing`。

### 安全模型

框架提供机制，部署边界由宿主决定。

- 宿主默认 Agent **不**自动获得任意文件读取与 HTTP 出站权限，能力必须由宿主显式注入与授权。
- 公网 HTTP 工具拒绝私网、回环、链路本地与 CGNAT 地址，并在建连与每次重定向前复核。
- 写入类工具在覆盖或修改既有文件前，要求同一 conversation 已读取过该文件且版本未变，拒绝发生在
  任何磁盘改动之前；写入经同目录临时文件加原子重命名完成，失败不留半写文件。
- `sys_shell` 是任意命令执行，会绕过文件工具的「先读后写」闸门，且子进程继承宿主环境变量 ——
  部署隔离是唯一安全边界。
- fencing 只保护 checkpoint 提交。工具副作用的 exactly-once、lease/TTL/heartbeat、claim 过期恢复
  与 outbox 仍由宿主负责。

[0.1.0]: https://github.com/MalganisWu/red-bean-qing-tuan/releases/tag/v0.1.0
