import assert from "node:assert/strict";

import {
  CONSUME_DISPOSITIONS,
  type ConsumeInterruptRequest,
} from "../../runtime/checkpoint/store/port/checkpoint-store.js";
import { RUNTIME_ERROR_CODES } from "../../runtime/run/error/runtime-error.js";
import {
  checkpointFor,
  expectStoreError,
  suspendedCheckpoint,
  withMessage,
  type ContractCase,
  type ContractContext,
} from "./contract-support.js";

/**
 * 认领与删除必须在写入的那一刻重新比对水位，而不是沿用调用方拿到 token 时的判断。
 * 用例先做一次带更高 token（71n / 81n）的读把水位抬高，随后用旧 token（70n / 80n）改动：
 * 必须 STALE_FENCE。换成新 token 才放行。
 *
 * 这条对应真实的接管窗口：调用方读到了 token、正要去写，期间 lease 已被别人接管。
 * 若实现只在 load 时校验 fence、写入时不再看，这个窗口就会漏过去。
 *
 * @param props - 套件提供的隔离上下文，含取消信号与 freshStore 工厂。
 */
async function rechecksFenceOnConsumeAndDelete(
  props: ContractContext,
): Promise<void> {
  const { freshStore, signal } = props;
  const consumeStore = await freshStore();
  const created = await consumeStore.save(
    {
      checkpoint: suspendedCheckpoint("consume-fence", "owner", "call-fence"),
      expectedRevision: 0n,
      fencingToken: 70n,
    },
    signal,
  );
  await consumeStore.load(
    { threadId: "consume-fence", userId: "owner", fencingToken: 71n },
    signal,
  );
  const consumeRequest: ConsumeInterruptRequest = {
    threadId: "consume-fence",
    userId: "owner",
    interruptId: "call-fence",
    requestId: "consume-fence-request",
    response: "yes",
    expectedRevision: created.revision,
    fencingToken: 70n,
  };
  await expectStoreError(
    consumeStore.consumeInterrupt(consumeRequest, signal),
    RUNTIME_ERROR_CODES.STALE_FENCE,
  );
  const claimed = await consumeStore.consumeInterrupt(
    { ...consumeRequest, fencingToken: 71n },
    signal,
  );
  assert.equal(claimed.disposition, CONSUME_DISPOSITIONS.CLAIMED);
  assert.equal(claimed.record.revision, created.revision + 1n);

  const deleteStore = await freshStore();
  const deleteCreated = await deleteStore.save(
    {
      checkpoint: checkpointFor("delete-fence", "owner", "state"),
      expectedRevision: 0n,
      fencingToken: 80n,
    },
    signal,
  );
  await deleteStore.load(
    { threadId: "delete-fence", userId: "owner", fencingToken: 81n },
    signal,
  );
  await expectStoreError(
    deleteStore.delete(
      {
        threadId: "delete-fence",
        userId: "owner",
        expectedRevision: deleteCreated.revision,
        fencingToken: 80n,
      },
      signal,
    ),
    RUNTIME_ERROR_CODES.STALE_FENCE,
  );
  const deletedRevision = await deleteStore.delete(
    {
      threadId: "delete-fence",
      userId: "owner",
      expectedRevision: deleteCreated.revision,
      fencingToken: 81n,
    },
    signal,
  );
  assert.equal(deletedRevision, deleteCreated.revision + 1n);
}

/**
 * 把「越权不推进水位」在三个改动型方法上再确认一遍（读路径已在高水位那组覆盖）。
 * 每个子场景的结构相同：bob 拿 99n 做改动被判 NOT_FOUND，随后 alice 仍能用原 token 90n
 * 正常完成同一操作——这后半句才是断言的关键，它证明水位没被 bob 的失败调用带上去。
 *
 * @param props - 套件提供的隔离上下文，含取消信号与 freshStore 工厂。
 */
async function keepsFenceOnWrongOwnerMutations(
  props: ContractContext,
): Promise<void> {
  const { freshStore, signal } = props;
  const saveStore = await freshStore();
  const saveCheckpoint = checkpointFor("wrong-save-fence", "alice", "state");
  const saveCreated = await saveStore.save(
    { checkpoint: saveCheckpoint, expectedRevision: 0n, fencingToken: 90n },
    signal,
  );
  await expectStoreError(
    saveStore.save(
      {
        checkpoint: checkpointFor("wrong-save-fence", "bob", "wrong"),
        expectedRevision: saveCreated.revision,
        fencingToken: 99n,
      },
      signal,
    ),
    RUNTIME_ERROR_CODES.CHECKPOINT_NOT_FOUND,
  );
  await saveStore.save(
    {
      checkpoint: withMessage(saveCheckpoint, "still alice"),
      expectedRevision: saveCreated.revision,
      fencingToken: 90n,
    },
    signal,
  );

  const consumeStore = await freshStore();
  const consumeCreated = await consumeStore.save(
    {
      checkpoint: suspendedCheckpoint("wrong-consume-fence", "alice", "call"),
      expectedRevision: 0n,
      fencingToken: 90n,
    },
    signal,
  );
  const consumeBase: ConsumeInterruptRequest = {
    threadId: "wrong-consume-fence",
    userId: "bob",
    interruptId: "call",
    requestId: "wrong",
    response: "yes",
    expectedRevision: consumeCreated.revision,
    fencingToken: 99n,
  };
  await expectStoreError(
    consumeStore.consumeInterrupt(consumeBase, signal),
    RUNTIME_ERROR_CODES.CHECKPOINT_NOT_FOUND,
  );
  await consumeStore.consumeInterrupt(
    { ...consumeBase, userId: "alice", requestId: "owner", fencingToken: 90n },
    signal,
  );

  const deleteStore = await freshStore();
  const deleteCreated = await deleteStore.save(
    {
      checkpoint: checkpointFor("wrong-delete-fence", "alice", "state"),
      expectedRevision: 0n,
      fencingToken: 90n,
    },
    signal,
  );
  await expectStoreError(
    deleteStore.delete(
      {
        threadId: "wrong-delete-fence",
        userId: "bob",
        expectedRevision: deleteCreated.revision,
        fencingToken: 99n,
      },
      signal,
    ),
    RUNTIME_ERROR_CODES.CHECKPOINT_NOT_FOUND,
  );
  await deleteStore.delete(
    {
      threadId: "wrong-delete-fence",
      userId: "alice",
      expectedRevision: deleteCreated.revision,
      fencingToken: 90n,
    },
    signal,
  );
}

/**
 * 三个「改动型」方法（consume / delete / save）在水位已被抬高之后的行为。
 *
 * 与 fencing-high-water 那组的分工：那组验证水位怎么推进，这组验证推进之后
 * 调用方**手里那个 token 什么时候作废**。
 *
 * @returns 本组的契约用例列表，仅在宿主声明 `supportsFencing` 时才应纳入执行。
 */
export function fencingMutationCases(): readonly ContractCase[] {
  return [
    {
      name: "fencing/consume and delete recheck fence atomically",
      run: rechecksFenceOnConsumeAndDelete,
    },
    {
      name: "fencing/wrong owner mutations cannot advance fence",
      run: keepsFenceOnWrongOwnerMutations,
    },
  ];
}
