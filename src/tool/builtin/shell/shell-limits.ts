// 命令执行工具的默认与上限配置。

/** 未显式指定超时时使用的默认值。 */
export const DEFAULT_SHELL_TIMEOUT_MS = 120_000;

/** 单次命令允许的最长执行时间；调用方给出的更大值会被压到该上限。 */
export const MAX_SHELL_TIMEOUT_MS = 600_000;

/** stdout 与 stderr 各自保留的最大字节数；超出即截断并告知。 */
export const MAX_SHELL_OUTPUT_BYTES = 65_536;

/** 发出 SIGTERM 后等待多久升级为 SIGKILL；忽略 SIGTERM 的命令靠它兜底。 */
export const SHELL_KILL_GRACE_MS = 2_000;
