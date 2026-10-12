import assert from "node:assert/strict";
import { describe, it } from "node:test";

// ThreadExecutionCoordinator 默认实现测试与 src/runtime/thread-execution 能力对应。
// 重点是「排队者被取消」这一条路径：它是唯一会改写队列指针的非正常出口，
// 一旦摘错了指针，同一 thread 的串行保证就会在窗口期内失效。

import { DefaultThreadExecutionCoordinator } from "../../../src/runtime/thread-execution/service/default-thread-execution-coordinator.js";

/**
 * 让已排入任务队列的回调先跑完，再观察「此刻是否已获得锁」。
 * 用宏任务而不是 `await Promise.resolve()`：取消分支要跑完自己的 catch 才改写队列指针，
 * 只等一个微任务不足以覆盖它。
 */
function flushTasks(): Promise<void> {
  return new Promise<void>((resolve): void => {
    setTimeout(resolve, 0);
  });
}

function neverAborted(): AbortSignal {
  return new AbortController().signal;
}

void describe("Runtime TypeScript DefaultThreadExecutionCoordinator", () => {
  void it("serializes acquires on the same thread", async () => {
    const coordinator = new DefaultThreadExecutionCoordinator();
    const releaseFirst = await coordinator.acquire(
      "thread-serial",
      neverAborted(),
    );

    let secondAcquired = false;
    const second = coordinator
      .acquire("thread-serial", neverAborted())
      .then((release): (() => void) => {
        secondAcquired = true;
        return release;
      });

    await flushTasks();
    assert.equal(
      secondAcquired,
      false,
      "同一 thread 的第二个 acquire 必须等第一个释放",
    );

    releaseFirst();
    const releaseSecond = await second;
    assert.equal(secondAcquired, true);
    releaseSecond();
  });

  void it("does not let one thread block another", async () => {
    const coordinator = new DefaultThreadExecutionCoordinator();
    const releaseA = await coordinator.acquire("thread-a", neverAborted());
    // 能直接 await 到就说明未被 thread-a 阻塞；若被串行化，这里会挂住直到超时。
    const releaseB = await coordinator.acquire("thread-b", neverAborted());
    releaseA();
    releaseB();
  });

  void it("treats an empty thread id as no serialization at all", async () => {
    const coordinator = new DefaultThreadExecutionCoordinator();
    const releaseFirst = await coordinator.acquire("", neverAborted());
    const releaseSecond = await coordinator.acquire("", neverAborted());
    releaseFirst();
    releaseSecond();
  });

  void it("rejects an already aborted acquire without occupying the slot", async () => {
    const coordinator = new DefaultThreadExecutionCoordinator();
    const controller = new AbortController();
    controller.abort(new Error("cancel before start"));

    await assert.rejects(
      coordinator.acquire("thread-aborted", controller.signal),
      /cancel before start/,
    );

    // 空 thread 上没有别的持有者，队列指针应当已清掉：下一次 acquire 立刻拿到。
    const release = await coordinator.acquire("thread-aborted", neverAborted());
    release();
  });

  void it("cancels a waiter and lets the next acquire through once the holder releases", async () => {
    const coordinator = new DefaultThreadExecutionCoordinator();
    const releaseHolder = await coordinator.acquire(
      "thread-cancel",
      neverAborted(),
    );

    const controller = new AbortController();
    const waiting = coordinator.acquire("thread-cancel", controller.signal);
    controller.abort(new Error("cancel waiter"));
    await assert.rejects(waiting, /cancel waiter/);
    await flushTasks();

    releaseHolder();
    // 持有者已释放，链上没有别人：后续 acquire 不应被永久卡住。
    const releaseNext = await coordinator.acquire(
      "thread-cancel",
      neverAborted(),
    );
    releaseNext();
  });

  void it("does not open the thread when a waiter is cancelled mid-run", async () => {
    const coordinator = new DefaultThreadExecutionCoordinator();
    const threadId = "thread-cancel-mid-run";
    const releaseHolder = await coordinator.acquire(threadId, neverAborted());

    const controller = new AbortController();
    const waiting = coordinator.acquire(threadId, controller.signal);
    controller.abort(new Error("cancel waiter"));
    await assert.rejects(waiting, /cancel waiter/);
    // 等取消分支跑完：它在这里改写队列指针，正是本用例要盯的窗口。
    await flushTasks();

    let lateAcquired = false;
    const late = coordinator
      .acquire(threadId, neverAborted())
      .then((release): (() => void) => {
        lateAcquired = true;
        return release;
      });

    await flushTasks();
    assert.equal(
      lateAcquired,
      false,
      "持有者仍在运行，后来的 acquire 不得越过它拿到锁",
    );

    releaseHolder();
    const releaseLate = await late;
    assert.equal(lateAcquired, true);
    releaseLate();
  });

  void it("keeps later waiters ordered behind the holder after a cancellation", async () => {
    const coordinator = new DefaultThreadExecutionCoordinator();
    const threadId = "thread-cancel-order";
    const releaseHolder = await coordinator.acquire(threadId, neverAborted());

    const cancelledController = new AbortController();
    const cancelled = coordinator.acquire(threadId, cancelledController.signal);
    cancelledController.abort(new Error("cancel middle waiter"));
    await assert.rejects(cancelled, /cancel middle waiter/);

    // 第二个排队者在取消者之后入队，仍应排在持有者之后。
    let queuedAcquired = false;
    const queued = coordinator
      .acquire(threadId, neverAborted())
      .then((release): (() => void) => {
        queuedAcquired = true;
        return release;
      });

    await flushTasks();
    assert.equal(
      queuedAcquired,
      false,
      "后面的排队者同样不得越过仍在运行的持有者",
    );

    releaseHolder();
    const releaseQueued = await queued;
    assert.equal(queuedAcquired, true);
    releaseQueued();
  });

  void it("ignores repeated release calls", async () => {
    const coordinator = new DefaultThreadExecutionCoordinator();
    const release = await coordinator.acquire("thread-release", neverAborted());
    release();
    release();

    // 重复释放不应误删别人的尾巴：后续请求仍能正常排队与获得。
    const releaseNext = await coordinator.acquire(
      "thread-release",
      neverAborted(),
    );
    releaseNext();
  });
});
