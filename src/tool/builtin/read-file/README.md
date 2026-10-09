# Read File 能力

`read-file-tool.ts` 保存公开 Tool 与参数契约；`safe-file-reader.ts` 负责参数、行范围与输出上限；
`path-policy.ts` 负责固定根目录、符号链接和文件身份校验。

默认使用 `createRootedReadTool(root)`。`UnrestrictedReadTool` 不限制路径，只能由已经提供进程级文件系统
沙箱的宿主显式启用。路径校验失败、根目录被替换或文件身份在打开期间变化时必须 fail-closed。

同一区间被重复读取时返回「未变更」占位，提示消费方复用本次对话早前收到的内容。该去重状态按
conversation（`ToolCallContext.threadId`）隔离：它描述的是「这个对话的上下文里有没有这段内容」，
只按路径记录会让另一个从未读过该文件的会话收到一句它无法兑现的提示。
