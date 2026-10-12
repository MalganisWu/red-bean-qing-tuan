import assert from "node:assert/strict";

import { RUNTIME_ERROR_CODES } from "../../runtime/run/error/runtime-error.js";
import {
  checkpointFor,
  expectStoreError,
  withMessage,
  type ContractCase,
  type ContractContext,
} from "./contract-support.js";

/**
 * fencing 高水位规则：token 只增不减，且**操作失败也要消耗水位**。
 *
 * 这一组是 CheckpointStore 里最容易被实现错的部分——多数实现会把 fence 校验放在
 * 业务校验之后，结果「失败的写入不推进水位」，于是一个已被接管的旧持有者
 * 只要重试一次就能重新写入。
 */
export function fencingHighWaterCases(): readonly ContractCase[] {
  return [
    {
      /**
       * 四种 token 关系逐一验证：0 表示未启用 fencing（可反复使用同一 thread）、
       * 相等放行、更高的放行、**更低的拒绝**。
       * 最后两个断言是同一条规则的两面：thread 一旦被非零 token 写过，
       * 就再也不能退回 0——「降级」和「用更低的 token」是同一类越权。
       */
      name: "fencing/zero equal higher lower and downgrade",
      run: async ({ freshStore, signal }: ContractContext): Promise<void> => {
        const store = await freshStore();
        const zero = checkpointFor("unfenced", "", "zero");
        const createdZero = await store.save(
          { checkpoint: zero, expectedRevision: 0n, fencingToken: 0n },
          signal,
        );
        await store.save(
          {
            checkpoint: withMessage(zero, "zero-update"),
            expectedRevision: createdZero.revision,
            fencingToken: 0n,
          },
          signal,
        );
        const checkpoint = checkpointFor("fenced", "", "ten");
        const created = await store.save(
          { checkpoint, expectedRevision: 0n, fencingToken: 10n },
          signal,
        );
        const equal = await store.save(
          {
            checkpoint: withMessage(checkpoint, "equal"),
            expectedRevision: created.revision,
            fencingToken: 10n,
          },
          signal,
        );
        const loaded = await store.load(
          { threadId: "fenced", userId: "", fencingToken: 11n },
          signal,
        );
        assert.equal(loaded.revision, equal.revision);
        await expectStoreError(
          store.save(
            {
              checkpoint: withMessage(checkpoint, "lower"),
              expectedRevision: equal.revision,
              fencingToken: 10n,
            },
            signal,
          ),
          RUNTIME_ERROR_CODES.STALE_FENCE,
        );
        await expectStoreError(
          store.load(
            { threadId: "fenced", userId: "", fencingToken: 10n },
            signal,
          ),
          RUNTIME_ERROR_CODES.STALE_FENCE,
        );
        await expectStoreError(
          store.load(
            { threadId: "fenced", userId: "", fencingToken: 0n },
            signal,
          ),
          RUNTIME_ERROR_CODES.STALE_FENCE,
        );
        const higher = await store.save(
          {
            checkpoint: withMessage(checkpoint, "higher"),
            expectedRevision: equal.revision,
            fencingToken: 12n,
          },
          signal,
        );
        assert.equal(higher.revision, equal.revision + 1n);
      },
    },
    {
      /**
       * 带高 token 读一个不存在的 thread 会**预定**它：读虽然没有内容，但水位已被记下。
       * 于是后来者只能用不低于它的 token 写入，用的 token 更低就是 STALE_FENCE。
       * 这是 lease 系统的必要能力——新持有者要先占位、再写入，中间不能被旧持有者插队。
       */
      name: "fencing/high token load reserves missing thread",
      run: async ({ freshStore, signal }: ContractContext): Promise<void> => {
        const store = await freshStore();
        const reserved = await expectStoreError(
          store.load(
            { threadId: "reserved", userId: "owner", fencingToken: 20n },
            signal,
          ),
          RUNTIME_ERROR_CODES.CHECKPOINT_NOT_FOUND,
        );
        assert.equal(reserved.record?.revision, 0n);
        assert.equal(reserved.record?.checkpoint.threadId, "reserved");
        assert.equal(reserved.record?.checkpoint.userId, "owner");
        await expectStoreError(
          store.load(
            { threadId: "reserved", userId: "other", fencingToken: 20n },
            signal,
          ),
          RUNTIME_ERROR_CODES.CHECKPOINT_NOT_FOUND,
        );
        await expectStoreError(
          store.save(
            {
              checkpoint: checkpointFor("reserved", "other", "wrong owner"),
              expectedRevision: 0n,
              fencingToken: 20n,
            },
            signal,
          ),
          RUNTIME_ERROR_CODES.CHECKPOINT_NOT_FOUND,
        );
        const checkpoint = checkpointFor("reserved", "owner", "reserved");
        await expectStoreError(
          store.save(
            { checkpoint, expectedRevision: 0n, fencingToken: 19n },
            signal,
          ),
          RUNTIME_ERROR_CODES.STALE_FENCE,
        );
        await expectStoreError(
          store.save(
            { checkpoint, expectedRevision: 0n, fencingToken: 0n },
            signal,
          ),
          RUNTIME_ERROR_CODES.STALE_FENCE,
        );
        const created = await store.save(
          { checkpoint, expectedRevision: 0n, fencingToken: 20n },
          signal,
        );
        assert.equal(created.revision, 1n);
      },
    },
    {
      /**
       * 关键用例：新持有者用更高 token 写入时 CAS 失败（revision 陈旧），
       * 但水位照样被推进到 31n。此后旧持有者用 30n 重试必须 STALE_FENCE，
       * 新持有者补上正确 revision 即可写入。
       *
       * 若把 fence 校验放在 CAS 之后，这里第一次写入会直接以 REVISION_CONFLICT 结束且不动水位，
       * 旧持有者就能继续以 30n 写入——接管失效。
       */
      name: "fencing/higher token survives failed CAS",
      run: async ({ freshStore, signal }: ContractContext): Promise<void> => {
        const store = await freshStore();
        const checkpoint = checkpointFor("takeover", "", "old");
        const created = await store.save(
          { checkpoint, expectedRevision: 0n, fencingToken: 30n },
          signal,
        );
        await expectStoreError(
          store.save(
            { checkpoint, expectedRevision: 0n, fencingToken: 31n },
            signal,
          ),
          RUNTIME_ERROR_CODES.REVISION_CONFLICT,
        );
        await expectStoreError(
          store.save(
            {
              checkpoint,
              expectedRevision: created.revision,
              fencingToken: 30n,
            },
            signal,
          ),
          RUNTIME_ERROR_CODES.STALE_FENCE,
        );
        await store.save(
          {
            checkpoint: withMessage(checkpoint, "new owner"),
            expectedRevision: created.revision,
            fencingToken: 31n,
          },
          signal,
        );
      },
    },
    {
      /**
       * 越权判定必须先于水位推进。
       * bob 用 99n 去读 alice 的 thread：请求被拒，且**水位没有被推到 99n**——
       * 证据是 alice 随后仍能用原来的 50n 正常写入。
       * 若顺序反了，任何知道 threadId 的人都能靠一次越权读取把合法持有者永久踢出局。
       */
      name: "fencing/wrong owner cannot advance fence",
      run: async ({ freshStore, signal }: ContractContext): Promise<void> => {
        const store = await freshStore();
        const checkpoint = checkpointFor("owner-fence", "alice", "private");
        const created = await store.save(
          { checkpoint, expectedRevision: 0n, fencingToken: 50n },
          signal,
        );
        await expectStoreError(
          store.load(
            { threadId: "owner-fence", userId: "bob", fencingToken: 99n },
            signal,
          ),
          RUNTIME_ERROR_CODES.CHECKPOINT_NOT_FOUND,
        );
        await store.save(
          {
            checkpoint: withMessage(checkpoint, "still owner"),
            expectedRevision: created.revision,
            fencingToken: 50n,
          },
          signal,
        );
      },
    },
    {
      /**
       * 墓碑保留 fence 高水位：删除后 60n 与 0n 都被拒，只有更高的 61n 能写入。
       * 与「挡住 ABA」是同一条设计的两面——删除若清掉水位，旧持有者即可借删除复位。
       */
      name: "fencing/tombstone retains fence high water",
      run: async ({ freshStore, signal }: ContractContext): Promise<void> => {
        const store = await freshStore();
        const checkpoint = checkpointFor("fenced-delete", "owner", "before");
        const created = await store.save(
          { checkpoint, expectedRevision: 0n, fencingToken: 60n },
          signal,
        );
        const deletedRevision = await store.delete(
          {
            threadId: "fenced-delete",
            userId: "owner",
            expectedRevision: created.revision,
            fencingToken: 60n,
          },
          signal,
        );
        const tombstone = await expectStoreError(
          store.load(
            {
              threadId: "fenced-delete",
              userId: "owner",
              fencingToken: 61n,
            },
            signal,
          ),
          RUNTIME_ERROR_CODES.CHECKPOINT_NOT_FOUND,
        );
        assert.equal(tombstone.record?.revision, deletedRevision);
        await expectStoreError(
          store.save(
            {
              checkpoint,
              expectedRevision: deletedRevision,
              fencingToken: 60n,
            },
            signal,
          ),
          RUNTIME_ERROR_CODES.STALE_FENCE,
        );
        await expectStoreError(
          store.save(
            {
              checkpoint,
              expectedRevision: deletedRevision,
              fencingToken: 0n,
            },
            signal,
          ),
          RUNTIME_ERROR_CODES.STALE_FENCE,
        );
        await store.save(
          {
            checkpoint,
            expectedRevision: deletedRevision,
            fencingToken: 61n,
          },
          signal,
        );
      },
    },
  ];
}
