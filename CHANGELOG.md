# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

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
