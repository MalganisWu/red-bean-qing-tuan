/**
 * 名称的字节序比较，用于发现类工具的确定性排序。
 *
 * 不用 `localeCompare`：它依赖运行环境的 locale，同一份目录在不同机器上可能给出不同顺序，
 * 而工具输出会进入模型上下文并被测试断言，顺序必须可复现。
 */
export function compareByName(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
