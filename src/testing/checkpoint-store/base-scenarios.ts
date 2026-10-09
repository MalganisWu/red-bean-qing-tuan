import { basicCheckpointStoreCases } from "./basic-scenarios.js";
import { checkpointLifecycleCases } from "./lifecycle-scenarios.js";
import { resumeCheckpointStoreCases } from "./resume-scenarios.js";
import type { ContractCase } from "./contract-support.js";

/** 基础契约按身份/CAS、恢复并发和生命周期三个独立场景组聚合。 */
export function baseCheckpointStoreCases(): readonly ContractCase[] {
  return [
    ...basicCheckpointStoreCases(),
    ...resumeCheckpointStoreCases(),
    ...checkpointLifecycleCases(),
  ];
}
