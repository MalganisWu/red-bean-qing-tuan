import assert from "node:assert/strict";

import { cloneCheckpoint } from "../../runtime/checkpoint/codec/checkpoint-clone.js";
import { CHECKPOINT_STATUSES } from "../../runtime/checkpoint/checkpoint-status.js";
import {
  CONSUME_DISPOSITIONS,
  type ConsumeInterruptRequest,
} from "../../runtime/checkpoint/store/port/checkpoint-store.js";
import {
  RUNTIME_ERROR_CODES,
  isRuntimeError,
} from "../../runtime/run/error/runtime-error.js";
import {
  expectStoreError,
  firstMessageContent,
  suspendedCheckpoint,
  withMessage,
  type ContractCase,
  type ContractContext,
} from "./contract-support.js";

/**
 * 恢复（resume）的契约：认领、幂等回放、并发互斥与终态写入门槛。
 *
 * 这三个用例是 CheckpointStore 最难实现对的部分，宿主自研 Store 时最该逐条对照。
 */
export function resumeCheckpointStoreCases(): readonly ContractCase[] {
  return [
    {
      /**
       * 走完一次 resume 的完整状态链，并在每一步插入反例：
       * 认领 → 同 requestId 重放（IN_PROGRESS）→ 同 requestId 改内容（幂等冲突）
       * → 换 requestId 抢认领（进行中）→ 写终态 → 再重放（REPLAYED）→ 已消费的 interrupt 不可再认领。
       */
      name: "consume lifecycle",
      run: async ({ freshStore, signal }: ContractContext): Promise<void> => {
        const store = await freshStore();
        const created = await store.save(
          {
            checkpoint: suspendedCheckpoint("resume", "owner", "call-1"),
            expectedRevision: 0n,
            fencingToken: 0n,
          },
          signal,
        );
        const request: ConsumeInterruptRequest = {
          threadId: "resume",
          userId: "owner",
          interruptId: "call-1",
          requestId: "request-1",
          response: "approved",
          expectedRevision: created.revision,
          fencingToken: 0n,
        };
        const claimed = await store.consumeInterrupt(request, signal);
        assert.equal(claimed.disposition, CONSUME_DISPOSITIONS.CLAIMED);
        assert.equal(claimed.record.revision, created.revision + 1n);
        assert.deepEqual(claimed.record.checkpoint.resumeClaim, {
          interruptId: request.interruptId,
          requestId: request.requestId,
          response: request.response,
          claimedAt: claimed.record.checkpoint.resumeClaim?.claimedAt,
        });
        assert.equal(claimed.record.checkpoint.interrupt, undefined);

        // 重放必须原样返回，且不推进 revision——幂等的意思是「读到同样的结果」而不是「再执行一次」。
        const inProgress = await store.consumeInterrupt(request, signal);
        assert.equal(inProgress.disposition, CONSUME_DISPOSITIONS.IN_PROGRESS);
        assert.equal(inProgress.record.revision, claimed.record.revision);
        // 同一个 requestId 承载两个不同的应答/中断，属于调用方的身份错用，必须显式拒绝而不是接受后者。
        await expectStoreError(
          store.consumeInterrupt({ ...request, response: "rejected" }, signal),
          RUNTIME_ERROR_CODES.IDEMPOTENCY_CONFLICT,
        );
        await expectStoreError(
          store.consumeInterrupt(
            { ...request, interruptId: "call-other" },
            signal,
          ),
          RUNTIME_ERROR_CODES.IDEMPOTENCY_CONFLICT,
        );
        // 换一个 requestId 来抢同一个挂起点：不是幂等冲突，而是「有人正在处理」。
        const competitor = {
          ...request,
          requestId: "request-2",
          expectedRevision: claimed.record.revision,
        };
        await expectStoreError(
          store.consumeInterrupt(competitor, signal),
          RUNTIME_ERROR_CODES.RESUME_IN_PROGRESS,
        );

        const finalCheckpoint = withMessage(claimed.record.checkpoint, "done");
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
        assert.equal(completed.revision, claimed.record.revision + 1n);
        const replayed = await store.consumeInterrupt(request, signal);
        assert.equal(replayed.disposition, CONSUME_DISPOSITIONS.REPLAYED);
        assert.equal(replayed.record.revision, completed.revision);
        assert.equal(firstMessageContent(replayed.record), "done");
        await expectStoreError(
          store.consumeInterrupt(
            { ...competitor, expectedRevision: completed.revision },
            signal,
          ),
          RUNTIME_ERROR_CODES.INTERRUPT_ALREADY_CONSUMED,
        );
      },
    },
    {
      /**
       * 16 个不同 requestId 同时认领同一挂起点，断言恰好 1 次 CLAIMED、15 次 RESUME_IN_PROGRESS，
       * 且不允许出现第三种结果。
       *
       * ⚠️ 这条用例验证的是**可见结果互斥**，不是「原子性」本身。在单进程 Store 上这些调用
       * 由同一个事件循环串行推进，不会真正交错；真正保证互斥的是实现内部的临界区
       * （数据库行锁、advisory lock 等）。本用例能挡住的是一类具体错误：
       * 把「已认领」判定与写回做成两步、中间让出执行权的实现，会在这里出现多个 CLAIMED。
       * 因此它是有价值的回归网，但它证明不了并发正确性——不要在别处把它当作原子性证明引用。
       */
      name: "consume is atomic under contention",
      run: async ({ freshStore, signal }: ContractContext): Promise<void> => {
        const store = await freshStore();
        const created = await store.save(
          {
            checkpoint: suspendedCheckpoint("contended", "", "call-race"),
            expectedRevision: 0n,
            fencingToken: 0n,
          },
          signal,
        );
        const outcomes = await Promise.all(
          Array.from({ length: 16 }, async (_unused, index) => {
            try {
              return {
                result: await store.consumeInterrupt(
                  {
                    threadId: "contended",
                    userId: "",
                    interruptId: "call-race",
                    requestId: `request-${index}`,
                    response: "approved",
                    expectedRevision: created.revision,
                    fencingToken: 0n,
                  },
                  signal,
                ),
              };
            } catch (error: unknown) {
              return { error };
            }
          }),
        );
        let claimed = 0;
        let inProgress = 0;
        for (const outcome of outcomes) {
          if (
            "result" in outcome &&
            outcome.result?.disposition === CONSUME_DISPOSITIONS.CLAIMED
          ) {
            claimed += 1;
          } else if (
            "error" in outcome &&
            isRuntimeError(
              outcome.error,
              RUNTIME_ERROR_CODES.RESUME_IN_PROGRESS,
            )
          ) {
            inProgress += 1;
          } else {
            assert.fail("unexpected contention outcome");
          }
        }
        assert.equal(claimed, 1);
        assert.equal(inProgress, 15);
      },
    },
    {
      /**
       * 认领之后写终态的门槛矩阵。五个反例各自对应一类「试图绕过认领」的写法，
       * 全部必须失败；只有第六次（requestId 对得上、checkpoint 自洽、revision 正确）才允许通过。
       * 这张矩阵就是「普通 run 不得越过 claim 覆盖结果」的可执行定义。
       */
      name: "final save claim ownership and CAS",
      run: async ({ freshStore, signal }: ContractContext): Promise<void> => {
        const store = await freshStore();
        const created = await store.save(
          {
            checkpoint: suspendedCheckpoint("claim-save", "", "call-final"),
            expectedRevision: 0n,
            fencingToken: 0n,
          },
          signal,
        );
        const claimed = await store.consumeInterrupt(
          {
            threadId: "claim-save",
            userId: "",
            interruptId: "call-final",
            requestId: "claim-owner",
            response: "yes",
            expectedRevision: created.revision,
            fencingToken: 0n,
          },
          signal,
        );
        const finalCheckpoint = cloneCheckpoint(claimed.record.checkpoint);
        finalCheckpoint.resumeClaim = undefined;
        finalCheckpoint.lastResumeInterrupt = "call-final";
        finalCheckpoint.status = CHECKPOINT_STATUSES.COMPLETED;
        const baseRequest = {
          checkpoint: finalCheckpoint,
          expectedRevision: claimed.record.revision,
          fencingToken: 0n,
        };
        // ① 完全不声明认领身份：等价于一次普通 run 想直接覆盖已被认领的 thread。
        await expectStoreError(
          store.save(baseRequest, signal),
          RUNTIME_ERROR_CODES.THREAD_BUSY,
        );
        // ② 声明了身份但对不上被认领的 requestId。
        await expectStoreError(
          store.save({ ...baseRequest, claimRequestId: "not-owner" }, signal),
          RUNTIME_ERROR_CODES.THREAD_BUSY,
        );
        // ③ requestId 对了，但 lastResumeInterrupt 指向另一个 interrupt —— 认领的是 A，写的却是 B。
        await expectStoreError(
          store.save(
            {
              ...baseRequest,
              checkpoint: {
                ...finalCheckpoint,
                lastResumeInterrupt: "call-other",
              },
              claimRequestId: "claim-owner",
            },
            signal,
          ),
          RUNTIME_ERROR_CODES.THREAD_BUSY,
        );
        // ④ 落终态时仍带着 resumeClaim —— 终态意味着认领已经完成，claim 必须被清掉。
        await expectStoreError(
          store.save(
            {
              ...baseRequest,
              checkpoint: {
                ...finalCheckpoint,
                resumeClaim: claimed.record.checkpoint.resumeClaim,
              },
              claimRequestId: "claim-owner",
            },
            signal,
          ),
          RUNTIME_ERROR_CODES.THREAD_BUSY,
        );
        // ⑤ 身份全部正确但 revision 陈旧：认领门槛与 CAS 是两道独立关卡，过了前者仍要过后者。
        await expectStoreError(
          store.save(
            {
              ...baseRequest,
              expectedRevision: created.revision,
              claimRequestId: "claim-owner",
            },
            signal,
          ),
          RUNTIME_ERROR_CODES.REVISION_CONFLICT,
        );
        const completed = await store.save(
          { ...baseRequest, claimRequestId: "claim-owner" },
          signal,
        );
        assert.equal(completed.revision, claimed.record.revision + 1n);
      },
    },
  ];
}
