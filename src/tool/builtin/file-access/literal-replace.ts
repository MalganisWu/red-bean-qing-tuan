/**
 * 字面文本替换助手。
 *
 * 刻意不用 `String.prototype.replace`：它的替换串会把 `$&`、`$1`、`` $` `` 当引用展开，而替换内容来自
 * 模型给出的代码片段，含 `$` 的文本会被静默改写——这类错误不会报错，只会把代码改坏。这里只做字面拼接。
 */

/** 计数用 `split` 而不是正则：needle 是字面文本，不能当模式解释。 */
export function countOccurrences(source: string, needle: string): number {
  return source.split(needle).length - 1;
}

/** 替换第一处匹配；调用方需自行保证匹配存在。 */
export function replaceFirst(
  source: string,
  oldString: string,
  newString: string,
): string {
  const index = source.indexOf(oldString);
  if (index < 0) return source;
  return (
    source.slice(0, index) + newString + source.slice(index + oldString.length)
  );
}

/** 替换全部匹配；调用方需自行保证至少有一处匹配。 */
export function replaceEvery(
  source: string,
  oldString: string,
  newString: string,
): string {
  return source.split(oldString).join(newString);
}
