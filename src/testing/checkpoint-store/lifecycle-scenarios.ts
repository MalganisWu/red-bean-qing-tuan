import assert from "node:assert/strict";

import { cloneCheckpoint } from "../../runtime/checkpoint/codec/checkpoint-clone.js";
import { CHECKPOINT_STATUSES } from "../../runtime/checkpoint/checkpoint-status.js";
import type { Checkpoint } from "../../runtime/checkpoint/model/checkpoint.js";
import {
  CONSUME_DISPOSITIONS,
  type ConsumeInterruptRequest,
} from "../../runtime/checkpoint/store/port/checkpoint-store.js";
import { RUNTIME_ERROR_CODES } from "../../runtime/run/error/runtime-error.js";
import {
  assertOriginalCopy,
  checkpointFor,
  expectStoreError,
  firstMessageContent,
  suspendedCheckpoint,
  withMessage,
  type ContractCase,
  type ContractContext,
} from "./contract-support.js";

/**
 * 有未完成的 resume 认领时禁止删除，否则终态写入会落在一个已被抹掉的 thread 上。
 *
 * @param props - 套件提供的隔离上下文，含取消信号与 freshStore 工厂。
 */
async function rejectsDeleteWhileClaimIsActive(
  props: ContractContext,
): Promise<void> {
  const { freshStore, signal } = props;
  const store = await freshStore();
  const created = await store.save(
    {
      checkpoint: suspendedCheckpoint("delete-claim", "", "call-delete"),
      expectedRevision: 0n,
      fencingToken: 0n,
    },
    signal,
  );
  const claimed = await store.consumeInterrupt(
    {
      threadId: "delete-claim",
      userId: "",
      interruptId: "call-delete",
      requestId: "delete-owner",
      response: "yes",
      expectedRevision: created.revision,
      fencingToken: 0n,
    },
    signal,
  );
  await expectStoreError(
    store.delete(
      {
        threadId: "delete-claim",
        userId: "",
        expectedRevision: claimed.record.revision,
        fencingToken: 0n,
      },
      signal,
    ),
    RUNTIME_ERROR_CODES.THREAD_BUSY,
  );
}

/**
 * 墓碑必须同时做到两件相反的事：
 * - **挡住 ABA**：删除后拿删除前的旧 revision 写回必须失败。若删除把记录真正移除，
 *   新记录会从 revision 0 重新开始，一个陈旧的持有者就能「恰好对上」而写回旧状态。
 * - **允许重建**：拿着删除后的新 revision 必须能正常写入。
 * 删除本身的 revision 递增（`created.revision + 1n`）正是这两件事的交汇点。
 *
 * @param props - 套件提供的隔离上下文，含取消信号与 freshStore 工厂。
 */
async function preventsAbaAndSupportsRebuild(
  props: ContractContext,
): Promise<void> {
  const { freshStore, signal } = props;
  const store = await freshStore();
  const checkpoint = checkpointFor("deleted", "owner", "before delete");
  const created = await store.save(
    { checkpoint, expectedRevision: 0n, fencingToken: 0n },
    signal,
  );
  await expectStoreError(
    store.delete(
      {
        threadId: "deleted",
        userId: "owner",
        expectedRevision: 0n,
        fencingToken: 0n,
      },
      signal,
    ),
    RUNTIME_ERROR_CODES.REVISION_CONFLICT,
  );
  const deletedRevision = await store.delete(
    {
      threadId: "deleted",
      userId: "owner",
      expectedRevision: created.revision,
      fencingToken: 0n,
    },
    signal,
  );
  assert.equal(deletedRevision, created.revision + 1n);
  const tombstone = await expectStoreError(
    store.load(
      { threadId: "deleted", userId: "owner", fencingToken: 0n },
      signal,
    ),
    RUNTIME_ERROR_CODES.CHECKPOINT_NOT_FOUND,
  );
  assert.equal(tombstone.record?.revision, deletedRevision);
  assert.equal(tombstone.record?.checkpoint.threadId, "deleted");
  assert.equal(tombstone.record?.checkpoint.userId, "owner");
  const repeated = await expectStoreError(
    store.delete(
      {
        threadId: "deleted",
        userId: "owner",
        expectedRevision: deletedRevision,
        fencingToken: 0n,
      },
      signal,
    ),
    RUNTIME_ERROR_CODES.CHECKPOINT_NOT_FOUND,
  );
  assert.equal(repeated.record?.revision, deletedRevision);
  await expectStoreError(
    store.save(
      {
        checkpoint: withMessage(checkpoint, "unsafe ABA"),
        expectedRevision: created.revision,
        fencingToken: 0n,
      },
      signal,
    ),
    RUNTIME_ERROR_CODES.REVISION_CONFLICT,
  );
  const rebuilt = await store.save(
    {
      checkpoint: withMessage(checkpoint, "safe rebuild"),
      expectedRevision: deletedRevision,
      fencingToken: 0n,
    },
    signal,
  );
  assert.equal(rebuilt.revision, deletedRevision + 1n);
  const loaded = await store.load(
    { threadId: "deleted", userId: "owner", fencingToken: 0n },
    signal,
  );
  assert.equal(loaded.revision, rebuilt.revision);
  assert.equal(firstMessageContent(loaded), "safe rebuild");
}

/**
 * 删除必须一并作废幂等回执。
 * 用例在删除后重建 thread、并复用**同一个 requestId** 再认领一次：
 * 期望结果是 `CLAIMED`（真的重新认领）而不是 `REPLAYED`。
 * 若回执被留存下来，一个已被删除的 thread 会拿旧回执冒充「已经处理过」，
 * 新写入的挂起点就永远等不到应答。
 *
 * @param props - 套件提供的隔离上下文，含取消信号与 freshStore 工厂。
 */
async function clearsReceiptsBeforeRebuild(
  props: ContractContext,
): Promise<void> {
  const { freshStore, signal } = props;
  const store = await freshStore();
  const created = await store.save(
    {
      checkpoint: suspendedCheckpoint("receipt-delete", "owner", "call-reused"),
      expectedRevision: 0n,
      fencingToken: 0n,
    },
    signal,
  );
  const request: ConsumeInterruptRequest = {
    threadId: "receipt-delete",
    userId: "owner",
    interruptId: "call-reused",
    requestId: "request-reused",
    response: "yes",
    expectedRevision: created.revision,
    fencingToken: 0n,
  };
  const claimed = await store.consumeInterrupt(request, signal);
  const finalCheckpoint = cloneCheckpoint(claimed.record.checkpoint);
  finalCheckpoint.resumeClaim = undefined;
  finalCheckpoint.lastResumeInterrupt = request.interruptId;
  finalCheckpoint.status = CHECKPOINT_STATUSES.COMPLETED;
  const completed = await store.save(
    {
      checkpoint: finalCheckpoint,
      expectedRevision: claimed.record.revision,
      fencingToken: 0n,
      claimRequestId: request.requestId,
    },
    signal,
  );
  const deletedRevision = await store.delete(
    {
      threadId: request.threadId,
      userId: request.userId,
      expectedRevision: completed.revision,
      fencingToken: 0n,
    },
    signal,
  );
  const rebuilt = await store.save(
    {
      checkpoint: suspendedCheckpoint(
        request.threadId,
        request.userId,
        request.interruptId,
      ),
      expectedRevision: deletedRevision,
      fencingToken: 0n,
    },
    signal,
  );
  const reused = await store.consumeInterrupt(
    { ...request, expectedRevision: rebuilt.revision },
    signal,
  );
  assert.equal(reused.disposition, CONSUME_DISPOSITIONS.CLAIMED);
  assert.equal(reused.record.revision, rebuilt.revision + 1n);
}

/**
 * 防御性复制契约：Store 与调用方之间不得共享任何可变对象。
 *
 * 用例在**四个位置**各改写一次，每次都要能被后续读取证伪：
 * ① 改写 save 的入参对象（含嵌套的 toolCalls.function、contentRefs.meta、interrupt）；
 * ② 改写 save 的返回值；
 * ③ 改写 load 的返回值；
 * ④ 改写 consumeInterrupt 返回的记录，并用同 requestId 重放核对。
 * 第 ④ 条最关键：回执是长期持有的对象，任何一处浅拷贝都会让它被逐步污染，
 * 而症状要到很久以后的某次重放才显现。
 *
 * @param props - 套件提供的隔离上下文，含取消信号与 freshStore 工厂。
 */
async function deepCopiesRecords(props: ContractContext): Promise<void> {
  const { freshStore, signal } = props;
  const store = await freshStore();
  const sourceFunction = {
    name: "ask",
    arguments: '{"value":"original"}',
  };
  const sourceMeta: Record<string, string> = { state: "original" };
  const sourceArguments: Record<string, string> = {
    argument: "original",
  };
  const sourcePayload: Record<string, string> = { payload: "original" };
  const checkpoint: Checkpoint = {
    ...suspendedCheckpoint("copies", "", "call-copy"),
    messages: [
      {
        role: "assistant",
        content: "original",
        toolCalls: [
          {
            id: "call-copy",
            type: "function",
            function: sourceFunction,
          },
        ],
      },
    ],
    contentRefs: [{ kind: "object", key: "key", meta: sourceMeta }],
    interrupt: {
      toolCallId: "call-copy",
      toolName: "ask",
      arguments: sourceArguments,
      payload: sourcePayload,
    },
  };
  const created = await store.save(
    { checkpoint, expectedRevision: 0n, fencingToken: 0n },
    signal,
  );
  // ① 改写入参：就地替换数组元素，并逐个改写被嵌套对象持有的可变引用。
  checkpoint.messages[0] = {
    role: "assistant",
    content: "mutated input",
  };
  sourceFunction.name = "mutated input";
  sourceMeta["state"] = "mutated input";
  sourceArguments["argument"] = "mutated input";
  sourcePayload["payload"] = "mutated input";
  // ② 改写返回值：若 Store 把内部对象直接交出去，这次修改会直接落进存储。
  created.checkpoint.messages[0] = {
    role: "assistant",
    content: "mutated result",
  };
  created.checkpoint.contentRefs[0] = {
    kind: "object",
    key: "key",
    meta: { state: "mutated result" },
  };
  created.checkpoint.interrupt = {
    toolCallId: "call-copy",
    toolName: "mutated result",
    arguments: {},
    payload: {},
  };

  const loaded = await store.load(
    { threadId: "copies", userId: "", fencingToken: 0n },
    signal,
  );
  assertOriginalCopy(loaded);
  // ③ 改写读取结果，再读一次核对。
  loaded.checkpoint.messages[0] = {
    role: "assistant",
    content: "mutated load",
  };
  loaded.checkpoint.contentRefs[0] = {
    kind: "object",
    key: "key",
    meta: { state: "mutated load" },
  };
  loaded.checkpoint.interrupt = {
    toolCallId: "call-copy",
    toolName: "mutated load",
    arguments: {},
    payload: {},
  };
  const reloaded = await store.load(
    { threadId: "copies", userId: "", fencingToken: 0n },
    signal,
  );
  assertOriginalCopy(reloaded);

  const request: ConsumeInterruptRequest = {
    threadId: "copies",
    userId: "",
    interruptId: "call-copy",
    requestId: "copy-request",
    response: "original response",
    expectedRevision: reloaded.revision,
    fencingToken: 0n,
  };
  const claimed = await store.consumeInterrupt(request, signal);
  // ④ 改写认领结果，再用同 requestId 重放核对回执没有被带着一起改掉。
  if (claimed.record.checkpoint.resumeClaim) {
    claimed.record.checkpoint.resumeClaim.response = "mutated claim result";
  }
  claimed.record.checkpoint.contentRefs[0] = {
    kind: "object",
    key: "key",
    meta: { state: "mutated claim result" },
  };
  const inProgress = await store.consumeInterrupt(request, signal);
  assert.equal(
    inProgress.record.checkpoint.resumeClaim?.response,
    "original response",
  );
  assert.equal(
    inProgress.record.checkpoint.contentRefs[0]?.meta?.["state"],
    "original",
  );
  const completedCheckpoint = withMessage(
    inProgress.record.checkpoint,
    "completed original",
  );
  completedCheckpoint.resumeClaim = undefined;
  completedCheckpoint.lastResumeInterrupt = "call-copy";
  completedCheckpoint.status = CHECKPOINT_STATUSES.COMPLETED;
  const completed = await store.save(
    {
      checkpoint: completedCheckpoint,
      expectedRevision: inProgress.record.revision,
      fencingToken: 0n,
      claimRequestId: "copy-request",
    },
    signal,
  );
  completed.checkpoint.messages[0] = {
    role: "assistant",
    content: "mutated completion",
  };
  completed.checkpoint.contentRefs[0] = {
    kind: "object",
    key: "key",
    meta: { state: "mutated completion" },
  };
  const replayed = await store.consumeInterrupt(request, signal);
  assert.equal(replayed.disposition, CONSUME_DISPOSITIONS.REPLAYED);
  assert.equal(firstMessageContent(replayed.record), "completed original");
  assert.equal(
    replayed.record.checkpoint.contentRefs[0]?.meta?.["state"],
    "original",
  );
}

/**
 * 删除与复制的生命周期契约。
 *
 * 核心命题是「删除是墓碑而非移除」：revision 与 fence 高水位在删除后继续有效，
 * 因此既拦得住旧持有者的 ABA 写回，也允许在同一 revision 序列上安全重建。
 *
 * @returns 本组的契约用例列表，覆盖 delete 与 copy 两条生命周期。
 */
export function checkpointLifecycleCases(): readonly ContractCase[] {
  return [
    {
      name: "delete tombstone/active claim is busy",
      run: rejectsDeleteWhileClaimIsActive,
    },
    {
      name: "delete tombstone/prevents ABA and supports CAS rebuild",
      run: preventsAbaAndSupportsRebuild,
    },
    {
      name: "delete tombstone/clears resume receipts before rebuild",
      run: clearsReceiptsBeforeRebuild,
    },
    { name: "records are deep copied", run: deepCopiesRecords },
  ];
}
