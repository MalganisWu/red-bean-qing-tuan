import path from "node:path";

/**
 * 读取账本使用的文件键：绝对化后统一。
 *
 * 读取工具与写入工具分别接收模型给出的路径，同一个文件可能被写成 `x.txt`、`./x.txt` 或
 * `/abs/x.txt`。若把原始字符串直接当键，「先读后写」会因为写法不同而判定为未读过并拒绝写入——
 * 这是 fail-closed 方向的安全失败，但会变成纯噪音。因此两侧统一使用绝对化后的路径作键。
 *
 * 不使用 `realpath`：账本在读取成功路径上写记录，此时再做一次符号链接解析既多一次 I/O，也会把
 * 「同一文件的不同链接」合并成一个键，反而掩盖了链接本身的变化。自动化的失败方向是拒绝写入。
 */
export function ledgerFileKey(filePath: string): string {
  return path.resolve(filePath);
}
