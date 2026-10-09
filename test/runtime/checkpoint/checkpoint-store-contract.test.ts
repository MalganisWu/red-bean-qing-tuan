import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MemoryCheckpointStore,
  type CheckpointRecord,
  type CheckpointStore,
  type ConsumeInterruptRequest,
  type ConsumeInterruptResult,
  type DeleteCheckpointRequest,
  type LoadCheckpointRequest,
  type SaveCheckpointRequest,
} from "../../../src/runtime/checkpoint/checkpoint.js";
import {
  RUNTIME_ERROR_CODES,
  RuntimeError,
} from "../../../src/runtime/run/error/runtime-error.js";
import {
  runCheckpointStoreContract,
  runCheckpointStoreFencingUnsupportedContract,
} from "../../../src/testing/index.js";

function unsupported<TOutput>(fencingToken: bigint): Promise<TOutput> {
  if (fencingToken !== 0n) {
    return Promise.reject(
      new RuntimeError(RUNTIME_ERROR_CODES.FENCING_UNSUPPORTED),
    );
  }
  return Promise.reject(new Error("operation should use a fencing token"));
}

class NonFencingStore implements CheckpointStore {
  readonly #next = new MemoryCheckpointStore();

  public load(
    request: LoadCheckpointRequest,
    signal: AbortSignal,
  ): Promise<CheckpointRecord> {
    return request.fencingToken === 0n
      ? this.#next.load(request, signal)
      : unsupported(request.fencingToken);
  }

  public save(
    request: SaveCheckpointRequest,
    signal: AbortSignal,
  ): Promise<CheckpointRecord> {
    return request.fencingToken === 0n
      ? this.#next.save(request, signal)
      : unsupported(request.fencingToken);
  }

  public consumeInterrupt(
    request: ConsumeInterruptRequest,
    signal: AbortSignal,
  ): Promise<ConsumeInterruptResult> {
    return request.fencingToken === 0n
      ? this.#next.consumeInterrupt(request, signal)
      : unsupported(request.fencingToken);
  }

  public delete(
    request: DeleteCheckpointRequest,
    signal: AbortSignal,
  ): Promise<bigint> {
    return request.fencingToken === 0n
      ? this.#next.delete(request, signal)
      : unsupported(request.fencingToken);
  }
}

void describe("CheckpointStore public contract kit", () => {
  void it("accepts the reference store including fencing", async () => {
    const completed: string[] = [];
    await runCheckpointStoreContract(
      (): CheckpointStore => new MemoryCheckpointStore(),
      {
        supportsFencing: true,
        afterCase: (name: string): void => {
          completed.push(name);
        },
      },
    );
    assert.equal(completed.length >= 10, true);
    assert.equal(completed.includes("CAS"), true);
    assert.equal(completed.includes("records are deep copied"), true);
    assert.equal(
      completed.includes("fencing/wrong owner mutations cannot advance fence"),
      true,
    );
  });

  void it("accepts a fail-closed non-fencing store", async () => {
    await runCheckpointStoreFencingUnsupportedContract(
      (): CheckpointStore => new NonFencingStore(),
    );
  });

  void it("identifies the failing contract case", async () => {
    class BrokenStore extends MemoryCheckpointStore {
      public override save(
        request: SaveCheckpointRequest,
        signal: AbortSignal,
      ): Promise<CheckpointRecord> {
        return super.save({ ...request, expectedRevision: 0n }, signal);
      }
    }

    await assert.rejects(
      runCheckpointStoreContract((): CheckpointStore => new BrokenStore()),
      (error: unknown): boolean =>
        error instanceof Error && error.message.includes("[CAS]"),
    );
  });
});
