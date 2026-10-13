import { readFile } from "node:fs/promises";

import type { JsonObject, JsonValue } from "../../../protocol/json.js";
import type { Tool, ToolResult, ToolSchema } from "../../definition/tool.js";
import { throwIfReadAborted } from "../read-file/safe-file-reader.js";
import { writeFileAtomically } from "../file-access/atomic-write.js";
import {
  countOccurrences,
  replaceEvery,
  replaceFirst,
} from "../file-access/literal-replace.js";
import { ledgerFileKey } from "../file-access/ledger-key.js";
import { assertFreshRead } from "../file-access/mutation-guard.js";
import type { FileReadLedger } from "../file-access/port/file-read-ledger.js";

/** 本工具在 Tool Registry 中的注册名；Agent 的 sys_tool_ids 用它引用，改名等于改变对外契约。 */
export const EDIT_FILE_TOOL_NAME = "sys_edit_file";

/** 调用方给出的替换条件，已通过运行时校验。 */
export interface EditFileParams {
  /** 目标文件路径，必须已用 sys_read_file 读过且之后未被改动。 */
  readonly filePath: string;
  /** 要被替换掉的原文片段，需带上足够上下文以保证在文件中唯一。 */
  readonly oldString: string;
  /** 替换后的新内容，与 oldString 相同会被解析阶段拒绝。 */
  readonly newString: string;
  /** 为 true 时替换全部匹配；为 false 时匹配数不为 1 直接失败。 */
  readonly replaceAll: boolean;
}

/** 工具依赖：账本是必填项，缺失会让「先读后写」闸门失效。 */
export interface EditFileOptions {
  /** 读取账本，用于确认目标文件在本 conversation 读过且自读取后未被改动。 */
  readonly ledger: FileReadLedger;
}

/**
 * 构造暴露给模型的 JSON Schema 入参描述。
 *
 * 结构必须与 `parseEditFileParams` 的运行期校验保持一致：Schema 只是给模型的第一层提示，
 * 真正决定拒绝与否的是解析函数，两者不同步会让模型按 Schema 构造仍被拒。
 *
 * @returns 描述 file_path、old_string、new_string 与 replace_all 的 JSON Schema 对象
 */
function parameters(): JsonObject {
  return {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "要修改的文件路径，必须已用 sys_read_file 读过",
      },
      old_string: {
        type: "string",
        description: "要被替换掉的原文片段，需带上足够上下文以保证在文件中唯一",
      },
      new_string: {
        type: "string",
        description: "替换后的新内容，与 old_string 不能相同",
      },
      replace_all: {
        type: "boolean",
        description:
          "为 true 时替换所有匹配；默认 false，此时出现多处匹配会拒绝执行",
      },
    },
    required: ["file_path", "old_string", "new_string"],
  };
}

/**
 * 从 unknown 形状的入参校验并归一化替换条件。
 *
 * replace_all 缺省视为 false：模型不显式声明要改多处时，宁可按「只想改一处」处理并让其补上下文，
 * 也不要默认扩大改动范围。
 *
 * @param value - 工具入参原始值，须是含 file_path、old_string、new_string 的对象
 * @returns 归一化后的替换条件，replace_all 已补全为布尔值
 */
function parseEditFileParams(value: JsonValue): EditFileParams {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("edit_file parameters must be an object");
  }
  const rawPath = value["file_path"];
  if (typeof rawPath !== "string") throw new Error("file_path 必须是字符串");
  const filePath = rawPath.trim();
  if (filePath === "") throw new Error("file_path 不能为空");

  const rawOld = value["old_string"];
  if (typeof rawOld !== "string") throw new Error("old_string 必须是字符串");
  if (rawOld === "") throw new Error("old_string 不能为空");

  const rawNew = value["new_string"];
  if (typeof rawNew !== "string") throw new Error("new_string 必须是字符串");
  if (rawNew === rawOld)
    throw new Error("new_string 与 old_string 相同，无需修改");

  const rawReplaceAll = value["replace_all"];
  if (rawReplaceAll !== undefined && typeof rawReplaceAll !== "boolean") {
    throw new Error("replace_all 必须是布尔值");
  }
  return {
    filePath,
    oldString: rawOld,
    newString: rawNew,
    replaceAll: rawReplaceAll === true,
  };
}

/**
 * 精确串替换工具，替换单处或全部匹配。
 *
 * 与 `UnrestrictedReadTool` 一样不做路径限制，只在宿主已提供文件系统沙箱时使用。
 * 必须先用 `sys_read_file` 读过同一文件且版本未变；匹配数不为 1 且未要求全部替换时拒绝执行，
 * 避免模型在无法确定改哪一处时擅自扩大改动范围。
 */
export class EditFileTool implements Tool {
  /** 本工具在 Tool Registry 中的注册名，与 `EDIT_FILE_TOOL_NAME` 保持一致。 */
  public readonly name = EDIT_FILE_TOOL_NAME;
  /** 工具契约：函数名、给模型的说明与 JSON Schema 入参。 */
  public readonly schema: ToolSchema = {
    type: "function",
    function: {
      name: this.name,
      description:
        "对已读取过的文件做精确串替换。old_string 必须带上足够上下文以在文件中唯一；若确实要改多处，把 replace_all 设为 true。整体重写文件用 sys_write_file，一次改多处用 sys_apply_patch。文件在读取后被改动过会拒绝执行。该工具不限制路径，仅应在外部已有文件系统沙箱时使用",
      parameters: parameters(),
    },
  };
  /** 读取账本，是「先读后写」闸门的事实来源；缺失会让新鲜度校验失效。 */
  readonly #ledger: FileReadLedger;

  public constructor(options: EditFileOptions) {
    this.#ledger = options.ledger;
  }

  /**
   * 执行精确串替换。先确认文件自上次读取后未被改动，再计数匹配：
   * 零处匹配直接失败，多处匹配且未要求全部替换也失败，避免扩大改动范围；
   * 写盘后作废该文件的读取记录。
   *
   * @param value - 工具入参原始值，尚未校验，需经 `parseEditFileParams` 归一化
   * @param context - 调用上下文，其 threadId 用于查读取账本
   * @param signal - 取消信号，进入与写入前检查
   * @returns 文本结果，说明改动的文件与替换处数
   */
  public async execute(
    value: JsonValue,
    context: { readonly threadId: string },
    signal: AbortSignal,
  ): Promise<ToolResult> {
    throwIfReadAborted(signal);
    const params = parseEditFileParams(value);
    const key = ledgerFileKey(params.filePath);
    await assertFreshRead({
      filePath: params.filePath,
      threadId: context.threadId,
      ledger: this.#ledger,
      allowMissing: false,
    });

    const source = await readFile(params.filePath, "utf8");
    const occurrences = countOccurrences(source, params.oldString);
    if (occurrences === 0) {
      throw new Error(
        `在 ${params.filePath} 中未找到 old_string，请先读取文件确认原文`,
      );
    }
    if (occurrences > 1 && !params.replaceAll) {
      throw new Error(
        `old_string 在 ${params.filePath} 中出现 ${occurrences} 处，请补充上下文使其唯一，或显式设置 replace_all`,
      );
    }

    const updated = applyReplacement(source, params);
    await writeFileAtomically(params.filePath, updated);
    // 版本已推进，旧读取记录不再代表磁盘内容，必须作废。
    this.#ledger.forget(context.threadId, key);

    const replaced = params.replaceAll ? occurrences : 1;
    return {
      content: `已修改 ${params.filePath}（替换 ${replaced} 处）`,
    };
  }

  /** 无常驻资源需要释放；保留以满足 `Tool` 契约。 */
  public close(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * 按 replaceAll 选择只替换第一处还是替换全部匹配。
 *
 * 纯函数，不改写入参；匹配唯一性已在调用方校验，这里只负责施加替换。
 *
 * @param source - 文件当前内容
 * @param params - 已归一化的替换条件，replaceAll 决定替换范围
 * @returns 替换后的完整文件内容，调用方负责写盘
 */
function applyReplacement(source: string, params: EditFileParams): string {
  return params.replaceAll
    ? replaceEvery(source, params.oldString, params.newString)
    : replaceFirst(source, params.oldString, params.newString);
}
