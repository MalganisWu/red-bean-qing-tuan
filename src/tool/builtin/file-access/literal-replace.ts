/**
 * 字面文本替换助手。
 *
 * 刻意不用 `String.prototype.replace`：它的替换串会把 `$&`、`$1`、`` $` `` 当引用展开，而替换内容来自
 * 模型给出的代码片段，含 `$` 的文本会被静默改写——这类错误不会报错，只会把代码改坏。这里只做字面拼接。
 */

/**
 * 计数用 `split` 而不是正则：needle 是字面文本，不能当模式解释。
 *
 * @param source - 被搜索的原始文本
 * @param needle - 作为字面量匹配的子串，不含正则语义
 * @returns `needle` 在 `source` 中出现的次数
 */
export function countOccurrences(source: string, needle: string): number {
  return source.split(needle).length - 1;
}

/**
 * 替换第一处匹配；调用方需自行保证匹配存在。
 *
 * @param source - 被替换的原始文本
 * @param oldString - 待替换的字面文本，找不到时原样返回
 * @param newString - 新文本，按字面拼接，`$&` 等序列不会被展开
 * @returns 替换后的文本
 */
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

/**
 * 替换全部匹配；调用方需自行保证至少有一处匹配。
 *
 * @param source - 被替换的原始文本
 * @param oldString - 待替换的字面文本，按字面匹配
 * @param newString - 新文本，按字面拼接，`$` 序列不会被展开
 * @returns 替换后的文本
 */
export function replaceEvery(
  source: string,
  oldString: string,
  newString: string,
): string {
  return source.split(oldString).join(newString);
}
