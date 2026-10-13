import assert from "node:assert/strict";

import { RUNTIME_ERROR_CODES } from "../../runtime/run/error/runtime-error.js";
import {
  checkpointFor,
  expectStoreError,
  firstMessageContent,
  withMessage,
  type ContractCase,
  type ContractContext,
} from "./contract-support.js";

/** CAS 用例：revision 串行推进，用陈旧 revision 保存必须报冲突。 */
async function savesWithRevisionCas({
  freshStore,
  signal,
}: ContractContext): Promise<void> {
  const store = await freshStore();
  const first = checkpointFor("cas", "owner", "first");
  const created = await store.save(
    { checkpoint: first, expectedRevision: 0n, fencingToken: 0n },
    signal,
  );
  assert.equal(created.revision, 1n);
  const second = withMessage(first, "second");
  const updated = await store.save(
    {
      checkpoint: second,
      expectedRevision: created.revision,
      fencingToken: 0n,
    },
    signal,
  );
  assert.equal(updated.revision, 2n);
  await expectStoreError(
    store.save(
      {
        checkpoint: withMessage(first, "stale"),
        expectedRevision: created.revision,
        fencingToken: 0n,
      },
      signal,
    ),
    RUNTIME_ERROR_CODES.REVISION_CONFLICT,
  );
  const loaded = await store.load(
    { threadId: "cas", userId: "owner", fencingToken: 0n },
    signal,
  );
  assert.equal(loaded.revision, updated.revision);
  assert.equal(firstMessageContent(loaded), "second");
}

/**
 * 读一个不存在的 thread 不是「什么都没有」：错误必须携带一条合成的空记录，
 * 且 threadId/userId 回填为**调用方请求的身份**、revision 为 0。
 * 调用方据此可以直接发起 expectedRevision=0n 的首次保存，而不必再查一次。
 */
async function reportsRequestedIdentityOnMissingRecord({
  freshStore,
  signal,
}: ContractContext): Promise<void> {
  const store = await freshStore();
  const error = await expectStoreError(
    store.load(
      { threadId: "missing", userId: "owner", fencingToken: 0n },
      signal,
    ),
    RUNTIME_ERROR_CODES.CHECKPOINT_NOT_FOUND,
  );
  assert.equal(error.record?.revision, 0n);
  assert.equal(error.record?.checkpoint.threadId, "missing");
  assert.equal(error.record?.checkpoint.userId, "owner");
}

/**
 * 越权必须返回 `CHECKPOINT_NOT_FOUND`，且**错误里不得夹带任何快照**——
 * `denied.record` 为 undefined 正是这条断言。若把 alice 的记录附在 bob 的错误上，
 * 「隐藏所有权」就形同虚设：调用方靠错误对象就能读到别人的内容。
 * 四个方法逐一验证，避免只挡住读、漏掉写。
 */
async function rejectsOwnerMismatch({
  freshStore,
  signal,
}: ContractContext): Promise<void> {
  const store = await freshStore();
  const created = await store.save(
    {
      checkpoint: checkpointFor("owned", "alice", "private"),
      expectedRevision: 0n,
      fencingToken: 0n,
    },
    signal,
  );
  // 注意这次 load 还带了 fencingToken 99n：越权判定必须先于 fence 推进，
  // 否则 bob 的一次越权读取就能污染 thread 的 fence 高水位。
  const denied = await expectStoreError(
    store.load({ threadId: "owned", userId: "bob", fencingToken: 99n }, signal),
    RUNTIME_ERROR_CODES.CHECKPOINT_NOT_FOUND,
  );
  assert.equal(denied.record, undefined);
  await expectStoreError(
    store.save(
      {
        checkpoint: checkpointFor("owned", "bob", "overwrite"),
        expectedRevision: created.revision,
        fencingToken: 0n,
      },
      signal,
    ),
    RUNTIME_ERROR_CODES.CHECKPOINT_NOT_FOUND,
  );
  await expectStoreError(
    store.consumeInterrupt(
      {
        threadId: "owned",
        userId: "bob",
        interruptId: "missing",
        requestId: "bob-resume",
        response: "yes",
        expectedRevision: created.revision,
        fencingToken: 0n,
      },
      signal,
    ),
    RUNTIME_ERROR_CODES.CHECKPOINT_NOT_FOUND,
  );
  await expectStoreError(
    store.delete(
      {
        threadId: "owned",
        userId: "bob",
        expectedRevision: created.revision,
        fencingToken: 0n,
      },
      signal,
    ),
    RUNTIME_ERROR_CODES.CHECKPOINT_NOT_FOUND,
  );
  const loaded = await store.load(
    { threadId: "owned", userId: "alice", fencingToken: 0n },
    signal,
  );
  assert.equal(loaded.revision, created.revision);
  assert.equal(firstMessageContent(loaded), "private");
}

/**
 * 身份与 CAS 的基础契约，不涉及 resume 与 fencing。
 *
 * 三个用例合起来锁死一件事：revision 是唯一的写入门槛，身份不匹配时错误里不许夹带内容。
 *
 * @returns 本组的契约用例列表，每个用例都要求套件提供隔离的 `freshStore`。
 */
export function basicCheckpointStoreCases(): readonly ContractCase[] {
  return [
    { name: "CAS", run: savesWithRevisionCas },
    {
      name: "missing record returns requested identity",
      run: reportsRequestedIdentityOnMissingRecord,
    },
    { name: "owner mismatch", run: rejectsOwnerMismatch },
  ];
}
