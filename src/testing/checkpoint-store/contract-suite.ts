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

/**
 * 顺序执行用例，并保证每个用例都被隔离与收尾。
 *
 * 三条规则：
 * - **逐用例新建 Store**：`freshStore` 每次调用工厂，用例之间不共享实例，
 *   这样「用例 A 写脏了数据导致用例 B 通过」不可能发生。
 * - **失败也要收尾**：用例中途抛错时，之前创建的 Store 仍会被释放；
 *   派生 Store 以相反的创建顺序释放（后创建的依赖先创建的）。
 * - **失败不被掩盖**：用例自身的失败与释放时的失败会聚合成 `AggregateError`，
 *   只报其中一个会让真正的根因时有时无。
 *
 * `afterCase` 只在用例通过后执行——它是「重置外部状态」的钩子，用例已失败时没有意义。
 */
async function runCases(
  factory: CheckpointStoreContractFactory,
  options: CheckpointStoreContractOptions,
  cases: readonly ContractCase[],
): Promise<void> {
  for (const contractCase of cases) {
    const stores: CheckpointStore[] = [];
    /**
     * 造一个本用例专属的 Store 并登记待释放。
     * 校验在构造处完成，用例拿到的一定是合法 Store，不必各自再判一次。
     */
    async function freshStore(): Promise<CheckpointStore> {
      const candidate: unknown = await factory();
      if (!isCheckpointStore(candidate)) {
        throw new TypeError(
          "CheckpointStore factory returned an invalid store",
        );
      }
      stores.push(candidate);
      return candidate;
    }
    const context: ContractContext = {
      signal: options.signal ?? new AbortController().signal,
      freshStore,
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

/**
 * 运行可复用的 CAS、恢复、回执、墓碑、复制及可选 fencing 契约。
 *
 * `supportsFencing` 决定是否纳入 fencing 用例组：声明 false 时套件不会替你验证
 * 「非零 token 一律拒绝」，那部分必须另行运行 `runCheckpointStoreFencingUnsupportedContract`。
 *
 * @param factory - 生成隔离 Store 的工厂；每个用例都会调用一次，实现需保证实例之间不共享状态。
 * @param options - 套件的能力声明与测试生命周期配置；supportsFencing 决定是否纳入 fencing 用例组。
 */
export async function runCheckpointStoreContract(
  factory: CheckpointStoreContractFactory,
  options: CheckpointStoreContractOptions = {},
): Promise<void> {
  const cases = options.supportsFencing
    ? [...baseCheckpointStoreCases(), ...fencingCheckpointStoreCases()]
    : baseCheckpointStoreCases();
  await runCases(factory, options, cases);
}

/**
 * 验证不支持 fencing 的 Store 会以 fail-closed 方式拒绝所有非零 token。
 *
 * 关键在「所有」：四个方法必须逐一拒绝。只挡住写入而放行读取的实现，
 * 会让一个已经被接管（或本不该再持有 lease）的实例仍然读到最新状态，
 * 因此本用例对 load / save / consumeInterrupt / delete 逐个断言 `FENCING_UNSUPPORTED`。
 *
 * @param factory - 生成隔离 Store 的工厂；每个用例都会调用一次，实现需保证实例之间不共享状态。
 * @param options - 套件生命周期配置；supportsFencing 由本入口固定，不接受覆盖。
 */
export async function runCheckpointStoreFencingUnsupportedContract(
  factory: CheckpointStoreContractFactory,
  options: Omit<CheckpointStoreContractOptions, "supportsFencing"> = {},
): Promise<void> {
  /** 四个方法逐一断言：只挡住写入而放行读取的实现会在这里露出来。 */
  async function isFailClosedForEveryMethod({
    freshStore,
    signal,
  }: ContractContext): Promise<void> {
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
  }

  const unsupportedCase: ContractCase = {
    name: "fencing unsupported is fail-closed",
    run: isFailClosedForEveryMethod,
  };
  await runCases(factory, options, [unsupportedCase]);
}
