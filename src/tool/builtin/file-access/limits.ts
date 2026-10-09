/**
 * 发现类工具共享的输出上限。
 *
 * 这些上限的作用不是省资源，而是保证调用方在结果被截断时**知道**自己被截断了：发现类工具返回的是
 * 候选集合，静默截断会让模型把「前 N 项」误当成全集。因此每个上限都必须配套一条包含总量与
 * 缩小范围方式的提示。
 *
 * 读取类上限（`MAX_READ_SIZE_BYTES` 等）保留在 `read-file/safe-file-reader.ts`：它们随该工具的公开出口
 * 一起发布，移到这里只会制造一次无收益的破坏性搬迁。
 */

/** 单次目录列举返回的最大条目数。 */
export const MAX_DIRECTORY_ENTRIES = 500;

/** 单次模式匹配返回的最大路径数。 */
export const MAX_GLOB_RESULTS = 200;

/** 单次内容检索返回的最大匹配行数。 */
export const MAX_GREP_MATCHES = 200;

/** 内容检索跳过超过该大小的文件，避免把大文件整体读入内存。 */
export const MAX_GREP_FILE_BYTES = 1_048_576;

/** 内容检索输出中单行保留的最大字符数，超长行截断以避免单行撑爆上下文。 */
export const MAX_GREP_LINE_CHARS = 500;
