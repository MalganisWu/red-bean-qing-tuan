import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

/**
 * 声明基线的哈希算法 —— **检查与重生成共享这一份实现**。
 *
 * 之所以抽出来：`tsconfig.build.json` 没有设 `removeComments`，JSDoc 会原样进 `.d.ts`，
 * 因此**任何注释改动**都会让基线失效，改注释后必须重生成。原先重生成只有一份临时脚本，
 * 算法一旦漂移，"检查"与"重生成"会互相判定对方是错的。
 */

/** 基线文件位置；调用方用 `root` 拼出仓库根相对路径。 */
export function declarationBaselinePath(root) {
  return path.join(root, "testdata/api/public-declarations.sha256");
}

/**
 * 计算 `dist/` 下全部 `.d.ts` 的整仓哈希。
 *
 * 逐文件 `${相对路径}\0${内容}\0` 顺序喂入，文件按路径排序 —— 顺序敏感，所以
 * **同一份 dist 必须得到同一个值**，任何一次增删改都会改变结果。
 * 返回哈希与参与计数的文件数，供调用方报数。
 */
export async function declarationBaselineHash(root) {
  const dist = path.join(root, "dist");
  const hash = createHash("sha256");
  const files = (await declarationFiles(dist)).sort();
  for (const file of files) {
    hash.update(path.relative(dist, file));
    hash.update("\0");
    hash.update(await readFile(file));
    hash.update("\0");
  }
  return { hash: hash.digest("hex"), fileCount: files.length };
}

async function declarationFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await declarationFiles(target)));
    else if (entry.isFile() && entry.name.endsWith(".d.ts")) files.push(target);
  }
  return files;
}
