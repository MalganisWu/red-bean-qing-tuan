import { fencingHighWaterCases } from "./fencing-high-water-scenarios.js";
import { fencingMutationCases } from "./fencing-mutation-scenarios.js";
import type { ContractCase } from "./contract-support.js";

/** fencing 契约按高水位规则与原子写操作两个场景组聚合。 */
export function fencingCheckpointStoreCases(): readonly ContractCase[] {
  return [...fencingHighWaterCases(), ...fencingMutationCases()];
}
