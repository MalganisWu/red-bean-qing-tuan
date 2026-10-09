import { RUNTIME_ERROR_CODES } from "../../runtime/run/error/runtime-error.js";
import type { CheckpointStore } from "../../runtime/checkpoint/store/port/checkpoint-store.js";
import { baseCheckpointStoreCases } from "./base-scenarios.js";
import { fencingCheckpointStoreCases } from "./fencing-scenarios.js";
import {
  checkpointFor,
  expectRuntimeError,
  isCheckpointStore,
  type CheckpointStoreContractFactory,
  type CheckpointStoreContractOptions,
  type ContractCase,
  type ContractContext,
} from "./contract-support.js";

export type {
  CheckpointStoreContractFactory,
  CheckpointStoreContractOptions,
} from "./contract-support.js";

async function runCases(
  factory: CheckpointStoreContractFactory,
  options: CheckpointStoreContractOptions,
  cases: readonly ContractCase[],
): Promise<void> {
  for (const contractCase of cases) {
    const stores: CheckpointStore[] = [];
    const context: ContractContext = {
      signal: options.signal ?? new AbortController().signal,
      freshStore: async (): Promise<CheckpointStore> => {
        const candidate: unknown = await factory();
        if (!isCheckpointStore(candidate)) {
          throw new TypeError(
            "CheckpointStore factory returned an invalid store",
          );
        }
        stores.push(candidate);
        return candidate;
      },
    };
    let failed = false;
    let failure: unknown;
    try {
      await contractCase.run(context);
    } catch (error: unknown) {
      failed = true;
      failure = error;
    }
    if (options.dispose) {
      for (const store of stores.reverse()) {
        try {
          await options.dispose(store);
        } catch (error: unknown) {
          failure = failed
            ? new AggregateError(
                [failure, error],
                "contract case and cleanup failed",
              )
            : error;
          failed = true;
        }
      }
    }
    if (failed) {
      throw new Error(
        `CheckpointStore contract failed [${contractCase.name}]`,
        { cause: failure },
      );
    }
    try {
      await options.afterCase?.(contractCase.name);
    } catch (error: unknown) {
      throw new Error(
        `CheckpointStore contract afterCase failed [${contractCase.name}]`,
        { cause: error },
      );
    }
  }
}

/** 运行可复用的 CAS、恢复、回执、墓碑、复制及可选 fencing 契约。 */
export async function runCheckpointStoreContract(
  factory: CheckpointStoreContractFactory,
  options: CheckpointStoreContractOptions = {},
): Promise<void> {
  const cases = options.supportsFencing
    ? [...baseCheckpointStoreCases(), ...fencingCheckpointStoreCases()]
    : baseCheckpointStoreCases();
  await runCases(factory, options, cases);
}

/** 验证不支持 fencing 的 Store 会以 fail-closed 方式拒绝所有非零 token。 */
export async function runCheckpointStoreFencingUnsupportedContract(
  factory: CheckpointStoreContractFactory,
  options: Omit<CheckpointStoreContractOptions, "supportsFencing"> = {},
): Promise<void> {
  const unsupportedCase: ContractCase = {
    name: "fencing unsupported is fail-closed",
    run: async ({ freshStore, signal }: ContractContext): Promise<void> => {
      const store = await freshStore();
      await expectRuntimeError(
        store.load(
          { threadId: "unsupported-fence", userId: "", fencingToken: 1n },
          signal,
        ),
        RUNTIME_ERROR_CODES.FENCING_UNSUPPORTED,
      );
      await expectRuntimeError(
        store.save(
          {
            checkpoint: checkpointFor("unsupported-fence", "", "state"),
            expectedRevision: 0n,
            fencingToken: 1n,
          },
          signal,
        ),
        RUNTIME_ERROR_CODES.FENCING_UNSUPPORTED,
      );
      await expectRuntimeError(
        store.consumeInterrupt(
          {
            threadId: "unsupported-fence",
            userId: "",
            interruptId: "call",
            requestId: "request",
            response: "yes",
            expectedRevision: 0n,
            fencingToken: 1n,
          },
          signal,
        ),
        RUNTIME_ERROR_CODES.FENCING_UNSUPPORTED,
      );
      await expectRuntimeError(
        store.delete(
          {
            threadId: "unsupported-fence",
            userId: "",
            expectedRevision: 0n,
            fencingToken: 1n,
          },
          signal,
        ),
        RUNTIME_ERROR_CODES.FENCING_UNSUPPORTED,
      );
    },
  };
  await runCases(factory, options, [unsupportedCase]);
}
