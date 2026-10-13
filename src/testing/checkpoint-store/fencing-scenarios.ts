import { fencingHighWaterCases } from "./fencing-high-water-scenarios.js";
import { fencingMutationCases } from "./fencing-mutation-scenarios.js";
import type { ContractCase } from "./contract-support.js";

/**
 * fencing 契约按高水位规则与原子写操作两个场景组聚合。
 *
 * @returns 两个场景组合并后的用例列表，仅在宿主声明 `supportsFencing` 时才应纳入执行。
 */
export function fencingCheckpointStoreCases(): readonly ContractCase[] {
  return [...fencingHighWaterCases(), ...fencingMutationCases()];
}
