import { readFile } from "node:fs/promises";

import type { JsonObject, JsonValue } from "../../../protocol/json.js";
import type { Tool, ToolResult, ToolSchema } from "../../definition/tool.js";
import { throwIfReadAborted } from "../read-file/safe-file-reader.js";
import { writeFileAtomically } from "../file-access/atomic-write.js";
import {
  countOccurrences,
  replaceFirst,
} from "../file-access/literal-replace.js";
import { ledgerFileKey } from "../file-access/ledger-key.js";
import { assertFreshRead } from "../file-access/mutation-guard.js";
import type { FileReadLedger } from "../file-access/port/file-read-ledger.js";

export const APPLY_PATCH_TOOL_NAME = "sys_apply_patch";

/** 单处改动：把 oldString 字面替换为 newString。 */
export interface PatchEdit {
  readonly oldString: string;
  readonly newString: string;
}

/** 调用方给出的文件与改动序列，已通过运行时校验。 */
export interface ApplyPatchParams {
  readonly filePath: string;
  readonly edits: readonly PatchEdit[];
}

/** 工具依赖：账本是必填项，缺失会让「先读后写」闸门失效。 */
export interface ApplyPatchOptions {
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
      edits: {
        type: "array",
        minItems: 1,
        description:
          "按顺序施加的改动列表；每处 old_string 都必须在该步骤的当前内容中恰好匹配一次，任一处不满足则整体不写入",
        items: {
          type: "object",
          properties: {
            old_string: {
              type: "string",
              description: "要被替换掉的原文片段，需带上足够上下文以保证唯一",
            },
            new_string: {
              type: "string",
              description: "替换后的新内容，与 old_string 不能相同",
            },
          },
          required: ["old_string", "new_string"],
        },
      },
    },
    required: ["file_path", "edits"],
  };
}

function parseEdit(value: JsonValue, index: number): PatchEdit {
  const position = index + 1;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`edits[${index}] 必须是对象`);
  }
  const rawOld = value["old_string"];
  if (typeof rawOld !== "string") {
    throw new Error(`edits[${index}].old_string 必须是字符串`);
  }
  if (rawOld === "") throw new Error(`edits[${index}].old_string 不能为空`);
  const rawNew = value["new_string"];
  if (typeof rawNew !== "string") {
    throw new Error(`edits[${index}].new_string 必须是字符串`);
  }
  if (rawNew === rawOld) {
    throw new Error(
      `第 ${position} 处修改的 new_string 与 old_string 相同，无需修改`,
    );
  }
  return { oldString: rawOld, newString: rawNew };
}

/** 从 unknown 形状的入参校验并归一化改动序列。 */
function parseApplyPatchParams(value: JsonValue): ApplyPatchParams {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("apply_patch parameters must be an object");
  }
  const rawPath = value["file_path"];
  if (typeof rawPath !== "string") throw new Error("file_path 必须是字符串");
  const filePath = rawPath.trim();
  if (filePath === "") throw new Error("file_path 不能为空");

  const rawEdits = value["edits"];
  if (!Array.isArray(rawEdits)) throw new Error("edits 必须是数组");
  if (rawEdits.length === 0) throw new Error("edits 不能为空");
  return { filePath, edits: rawEdits.map(parseEdit) };
}

/**
 * 一次调用对单个文件施加多处改动的无限制工具。
 *
 * 与 `UnrestrictedReadTool` 一样不做路径限制，只在宿主已提供文件系统沙箱时使用。
 * 改动按顺序施加，每处都必须恰好匹配一次；全部校验通过后才做**一次**原子写入，
 * 因此不存在「前半套改动已落盘」的中间状态。
 *
 * 采用结构化改动列表而不是解析 unified diff：diff 文本对模型是脆弱的输出格式（行号偏移、空白或
 * 上下文行数量稍有差错即整段失败），而模型本来就有结构化入参可用。本工具的实质价值是原子多处改动。
 */
export class ApplyPatchTool implements Tool {
  public readonly name = APPLY_PATCH_TOOL_NAME;
  public readonly schema: ToolSchema = {
    type: "function",
    function: {
      name: this.name,
      description:
        "一次调用对同一个文件施加多处精确替换，全部成功才写入（原子），适合批量重命名、同时改多处配置。每处 old_string 必须恰好匹配一次，按列表顺序施加。只改一处用 sys_edit_file，整体重写用 sys_write_file。文件在读取后被改动过会拒绝执行。该工具不限制路径，仅应在外部已有文件系统沙箱时使用",
      parameters: parameters(),
    },
  };
  readonly #ledger: FileReadLedger;

  public constructor(options: ApplyPatchOptions) {
    this.#ledger = options.ledger;
  }

  public async execute(
    value: JsonValue,
    context: { readonly threadId: string },
    signal: AbortSignal,
  ): Promise<ToolResult> {
    throwIfReadAborted(signal);
    const params = parseApplyPatchParams(value);
    const key = ledgerFileKey(params.filePath);
    await assertFreshRead({
      filePath: params.filePath,
      threadId: context.threadId,
      ledger: this.#ledger,
      allowMissing: false,
    });

    const source = await readFile(params.filePath, "utf8");
    const updated = applyEdits(source, params.edits, params.filePath);
    await writeFileAtomically(params.filePath, updated);
    // 版本已推进，旧读取记录不再代表磁盘内容，必须作废。
    this.#ledger.forget(context.threadId, key);

    return {
      content: `已修改 ${params.filePath}（${params.edits.length} 处改动，一次性写入）`,
    };
  }

  public close(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * 顺序施加改动，任一处不满足唯一匹配就整体失败。
 *
 * 在内存中累积而不是边改边写，是为了让「全部成功或全部不写」成为结构上的事实，而不是依赖调用方
 * 记得回滚。
 */
function applyEdits(
  source: string,
  edits: readonly PatchEdit[],
  filePath: string,
): string {
  let working = source;
  for (const [index, edit] of edits.entries()) {
    const position = index + 1;
    const occurrences = countOccurrences(working, edit.oldString);
    if (occurrences === 0) {
      throw new Error(
        `第 ${position} 处修改未找到 old_string（${filePath}），请先读取文件确认原文`,
      );
    }
    if (occurrences > 1) {
      throw new Error(
        `第 ${position} 处修改的 old_string 在 ${filePath} 中出现 ${occurrences} 处，请补充上下文使其唯一`,
      );
    }
    working = replaceFirst(working, edit.oldString, edit.newString);
  }
  return working;
}
