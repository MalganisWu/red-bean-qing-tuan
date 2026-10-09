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

export const EDIT_FILE_TOOL_NAME = "sys_edit_file";

/** 调用方给出的替换条件，已通过运行时校验。 */
export interface EditFileParams {
  readonly filePath: string;
  readonly oldString: string;
  readonly newString: string;
  readonly replaceAll: boolean;
}

/** 工具依赖：账本是必填项，缺失会让「先读后写」闸门失效。 */
export interface EditFileOptions {
  readonly ledger: FileReadLedger;
}

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

/** 从 unknown 形状的入参校验并归一化替换条件。 */
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
  public readonly name = EDIT_FILE_TOOL_NAME;
  public readonly schema: ToolSchema = {
    type: "function",
    function: {
      name: this.name,
      description:
        "对已读取过的文件做精确串替换。old_string 必须带上足够上下文以在文件中唯一；若确实要改多处，把 replace_all 设为 true。整体重写文件用 sys_write_file，一次改多处用 sys_apply_patch。文件在读取后被改动过会拒绝执行。该工具不限制路径，仅应在外部已有文件系统沙箱时使用",
      parameters: parameters(),
    },
  };
  readonly #ledger: FileReadLedger;

  public constructor(options: EditFileOptions) {
    this.#ledger = options.ledger;
  }

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

  public close(): Promise<void> {
    return Promise.resolve();
  }
}

function applyReplacement(source: string, params: EditFileParams): string {
  return params.replaceAll
    ? replaceEvery(source, params.oldString, params.newString)
    : replaceFirst(source, params.oldString, params.newString);
}
