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

/** 本工具在 Tool Registry 中的注册名；Agent 的 sys_tool_ids 用它引用，改名等于改变对外契约。 */
export const APPLY_PATCH_TOOL_NAME = "sys_apply_patch";

/** 单处改动：把 oldString 字面替换为 newString。 */
export interface PatchEdit {
  /** 作为匹配依据的原文片段，必须带上足够上下文以保证在文件中唯一。 */
  readonly oldString: string;
  /** 替换 oldString 的新内容；与 oldString 相同会被解析阶段拒绝。 */
  readonly newString: string;
}

/** 调用方给出的文件与改动序列，已通过运行时校验。 */
export interface ApplyPatchParams {
  /** 目标文件路径；edits 中的每一处改动都作用在这同一个文件上。 */
  readonly filePath: string;
  /** 按顺序施加的改动序列，至少一项，任一处失败则整体不写入。 */
  readonly edits: readonly PatchEdit[];
}

/** 工具依赖：账本是必填项，缺失会让「先读后写」闸门失效。 */
export interface ApplyPatchOptions {
  /** 读取账本，用于确认目标文件在本 conversation 读过且自读取后未被改动。 */
  readonly ledger: FileReadLedger;
}

/**
 * 构造暴露给模型的 JSON Schema 入参描述。
 *
 * 这里的结构与 `parseApplyPatchParams` 的运行期校验一一对应：Schema 是给模型的第一层提示，
 * 真正的拒绝仍由解析函数完成，两者不同步会导致模型看到一个能通过却会被拒的形状。
 *
 * @returns 描述 file_path 与 edits 数组的 JSON Schema 对象
 */
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

/**
 * 校验单处改动的形状，并把下划线字段名归一化为驼峰。
 *
 * 空 old_string 与 new_string 等于 old_string 都在此拒绝：前者会让替换无限匹配，后者是无意义的
 * 改动，放行只会让模型误以为修改已生效。
 *
 * @param value - 单个改动的原始值，须是含 old_string 与 new_string 的非空对象
 * @param index - 该改动在 edits 中的下标，仅用于拼出可定位的错误信息
 * @returns 归一化后的改动，字段为 oldString 与 newString
 */
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

/**
 * 从 unknown 形状的入参校验并归一化改动序列。
 *
 * @param value - 工具入参原始值，须是含 file_path 与 edits 的对象，尚未做任何校验
 * @returns 归一化后的文件路径与非空改动序列；任一项不合法都抛出 Error
 */
function parseApplyPatchParams(value: JsonValue): ApplyPatchParams {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("apply_patch 的参数必须是对象");
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
  /** 本工具在 Tool Registry 中的注册名，与 `APPLY_PATCH_TOOL_NAME` 保持一致。 */
  public readonly name = APPLY_PATCH_TOOL_NAME;
  /** 工具契约：函数名、给模型的说明与 JSON Schema 入参。 */
  public readonly schema: ToolSchema = {
    type: "function",
    function: {
      name: this.name,
      description:
        "一次调用对同一个文件施加多处精确替换，全部成功才写入（原子），适合批量重命名、同时改多处配置。每处 old_string 必须恰好匹配一次，按列表顺序施加。只改一处用 sys_edit_file，整体重写用 sys_write_file。文件在读取后被改动过会拒绝执行。该工具不限制路径，仅应在外部已有文件系统沙箱时使用",
      parameters: parameters(),
    },
  };
  /** 读取账本，是「先读后写」闸门的事实来源；缺失会让新鲜度校验失效。 */
  readonly #ledger: FileReadLedger;

  public constructor(options: ApplyPatchOptions) {
    this.#ledger = options.ledger;
  }

  /**
   * 施加多处改动。先校验入参、确认文件自上次读取后未被改动，再一次性原子写入；
   * 任一处 old_string 匹配数不为 1 都整体失败，不留下已改动一半的中间态，
   * 写入后作废该文件的读取记录。
   *
   * @param value - 工具入参原始值，尚未校验，需经 `parseApplyPatchParams` 归一化
   * @param context - 调用上下文，其 threadId 用于查读取账本
   * @param signal - 取消信号，进入与写入前检查
   * @returns 文本结果，说明改动的文件与处数
   */
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

  /** 无常驻资源需要释放；保留以满足 `Tool` 契约。 */
  public close(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * 顺序施加改动，任一处不满足唯一匹配就整体失败。
 *
 * 在内存中累积而不是边改边写，是为了让「全部成功或全部不写」成为结构上的事实，而不是依赖调用方
 * 记得回滚。
 *
 * @param source - 文件的当前内容，作为逐处替换的起点
 * @param edits - 按顺序施加的改动序列，每处都必须恰好匹配一次
 * @param filePath - 目标文件路径，仅用于拼出可定位到文件的错误信息
 * @returns 全部改动施加后的完整文件内容，调用方负责写盘
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
