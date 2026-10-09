export type RuntimeProbe =
  | { kind: "ready"; runtimeId: string }
  | { kind: "failed"; runtimeId: string; reason: string };

/** 让空载迁移期的编译器与类型感知 ESLint 确实检查至少一个 TypeScript 模块。 */
export function describeRuntimeProbe(probe: RuntimeProbe): string {
  switch (probe.kind) {
    case "ready":
      return `runtime ${probe.runtimeId} ready`;
    case "failed":
      return `runtime ${probe.runtimeId} failed: ${probe.reason}`;
  }
}
