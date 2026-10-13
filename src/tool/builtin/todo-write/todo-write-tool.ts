import type { JsonObject, JsonValue } from "../../../protocol/json.js";
import type { Tool, ToolResult, ToolSchema } from "../../definition/tool.js";
import { throwIfReadAborted } from "../read-file/safe-file-reader.js";

/** 本工具在 Tool Registry 中的注册名；Agent 的 sys_tool_ids 用它引用，改名等于改变对外契约。 */
export const TODO_WRITE_TOOL_NAME = "sys_todo_write";

/** 待办事项状态常量表；比较与渲染都引用成员，避免散落的字符串字面量。 */
export const TODO_STATUSES = Object.freeze({
  PENDING: "pending",
  IN_PROGRESS: "in_progress",
  COMPLETED: "completed",
} as const);

/** 待办事项的状态。 */
export type TodoStatus = (typeof TODO_STATUSES)[keyof typeof TODO_STATUSES];

/** 单条待办事项。 */
export interface TodoItem {
  readonly content: string;
  readonly status: TodoStatus;
}

/** 调用方给出的完整清单，已通过运行时校验。 */
export interface TodoWriteParams {
  readonly todos: readonly TodoItem[];
}

/** 状态到渲染标记的映射。 */
const STATUS_MARKERS = Object.freeze({
  [TODO_STATUSES.PENDING]: "[ ]",
  [TODO_STATUSES.IN_PROGRESS]: "[~]",
  [TODO_STATUSES.COMPLETED]: "[x]",
} satisfies Readonly<Record<TodoStatus, string>>);

function parameters(): JsonObject {
  return {
    type: "object",
    properties: {
      todos: {
        type: "array",
        description:
          "完整待办清单，整体替换上一次的内容；传空数组表示清空。一次调用只应有一个进行中项",
        items: {
          type: "object",
          properties: {
            content: {
              type: "string",
              description: "待办事项描述，用祈使句写明要做什么",
            },
            status: {
              type: "string",
              enum: [
                TODO_STATUSES.PENDING,
                TODO_STATUSES.IN_PROGRESS,
                TODO_STATUSES.COMPLETED,
              ],
              description:
                "pending 未开始 / in_progress 进行中 / completed 已完成",
            },
          },
          required: ["content", "status"],
        },
      },
    },
    required: ["todos"],
  };
}

function parseStatus(value: JsonValue | undefined, index: number): TodoStatus {
  if (value === TODO_STATUSES.PENDING) return TODO_STATUSES.PENDING;
  if (value === TODO_STATUSES.IN_PROGRESS) return TODO_STATUSES.IN_PROGRESS;
  if (value === TODO_STATUSES.COMPLETED) return TODO_STATUSES.COMPLETED;
  const allowed = Object.values(TODO_STATUSES).join(" / ");
  throw new Error(`todos[${index}].status 必须是 ${allowed}`);
}

function parseItem(value: JsonValue, index: number): TodoItem {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`todos[${index}] 必须是对象`);
  }
  const rawContent = value["content"];
  if (typeof rawContent !== "string") {
    throw new Error(`todos[${index}].content 必须是字符串`);
  }
  const content = rawContent.trim();
  if (content === "") throw new Error(`todos[${index}].content 不能为空`);
  return { content, status: parseStatus(value["status"], index) };
}

/** 从 unknown 形状的入参校验并归一化完整清单。 */
function parseTodoWriteParams(value: JsonValue): TodoWriteParams {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("todo_write parameters must be an object");
  }
  const rawTodos = value["todos"];
  if (!Array.isArray(rawTodos)) throw new Error("todos 必须是数组");
  return { todos: rawTodos.map(parseItem) };
}

/** 渲染清单与进度，供模型在后续轮次继续引用。 */
function renderTodos(todos: readonly TodoItem[]): string {
  if (todos.length === 0) return "清单已清空（当前没有待办事项）";
  const lines = todos.map(
    (item: TodoItem): string =>
      `${STATUS_MARKERS[item.status]} ${item.content}`,
  );
  const completed = todos.filter(
    (item: TodoItem): boolean => item.status === TODO_STATUSES.COMPLETED,
  ).length;
  const inProgress = todos.filter(
    (item: TodoItem): boolean => item.status === TODO_STATUSES.IN_PROGRESS,
  ).length;
  lines.push("");
  lines.push(`进度：${completed}/${todos.length} 完成，${inProgress} 项进行中`);
  return lines.join("\n");
}

/**
 * 外化任务清单的工具，用于长任务的自我规划。
 *
 * 清单按 conversation（`ToolCallContext.threadId`）隔离，保存在进程内：Runtime 是库，不提供持久化，
 * 跨重启恢复与界面展示属于宿主，宿主可用 `current` 读取当前清单。
 *
 * 入参是完整清单而不是增量补丁：模型已经持有全量视图，整体替换能避免「第 N 项该删还是该改」这类
 * 无法从局部指令推断的歧义。
 */
export class TodoWriteTool implements Tool {
  /** 本工具在 Tool Registry 中的注册名，与 `TODO_WRITE_TOOL_NAME` 保持一致。 */
  public readonly name = TODO_WRITE_TOOL_NAME;
  /** 工具契约：函数名、给模型的说明与 JSON Schema 入参。 */
  public readonly schema: ToolSchema = {
    type: "function",
    function: {
      name: this.name,
      description:
        "记录或更新当前任务的待办清单，整体替换上一次内容（传空数组即清空）。用于多步任务开始前列出计划、每完成一步后更新状态；单步任务不需要调用。返回渲染后的清单与完成进度",
      parameters: parameters(),
    },
  };
  readonly #byThread = new Map<string, TodoItem[]>();

  /**
   * 整体替换指定 conversation 的清单并返回渲染结果。校验失败与取消失败都以 rejected Promise 返回，
   * 不同步抛出，以满足 `Tool` 契约。
   *
   * @param value - 工具入参原始值，含 `todos` 数组，尚未校验
   * @param context - 调用上下文，其 threadId 决定清单归属的 conversation
   * @param signal - 取消信号，进入处理逻辑前检查
   * @returns 渲染后的清单与完成进度文本
   */
  public execute(
    value: JsonValue,
    context: { readonly threadId: string },
    signal: AbortSignal,
  ): Promise<ToolResult> {
    // 清单只保存在进程内，本次调用没有异步等待，因此不声明 async；但 Tool 契约要求返回 Promise，
    // 校验失败必须表现为 rejected promise——同步抛出会让调用方的 .catch() 接不住，也会让
    // MapToolDispatcher 同步抛出而破坏它自己的 Promise 契约。这里的 try/catch 只做形态转换，不吞错。
    try {
      throwIfReadAborted(signal);
      const params = parseTodoWriteParams(value);
      this.#byThread.set(context.threadId, [...params.todos]);
      return Promise.resolve({ content: renderTodos(params.todos) });
    } catch (cause: unknown) {
      // Promise 的拒绝原因必须是 Error；非 Error 抛出（例如字符串）在此包裹并保留原值。
      return Promise.reject(
        cause instanceof Error ? cause : new Error(String(cause), { cause }),
      );
    }
  }

  /**
   * 读取某个 conversation 的当前清单，供宿主展示或持久化。
   *
   * @param threadId - conversation 标识，未记录过时返回空清单而非抛错
   * @returns 该 conversation 当前的待办清单，无记录时为空数组
   */
  public current(threadId: string): readonly TodoItem[] {
    return this.#byThread.get(threadId) ?? [];
  }

  /** 无常驻资源需要释放；保留以满足 `Tool` 契约。 */
  public close(): Promise<void> {
    return Promise.resolve();
  }
}
