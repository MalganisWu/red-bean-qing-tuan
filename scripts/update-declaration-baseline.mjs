import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  declarationBaselineHash,
  declarationBaselinePath,
} from "./declaration-baseline.mjs";

/**
 * 重生成 TypeScript 声明基线。
 *
 * 它是**写文件**的目标，因此排除在 `make verify*` 之外 —— 门禁必须只读。
 * 触发条件比"改了公开 API"宽得多：`tsconfig.build.json` 未设 `removeComments`，
 * JSDoc 会进 `.d.ts`，所以**任何注释改动**都要重生成。顺序固定为
 * 构建 → 重生成 → 验证，不能倒过来，否则写入的是上一次构建的哈希。
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { hash, fileCount } = await declarationBaselineHash(root);
await writeFile(declarationBaselinePath(root), `${hash}\n`);
console.log(`✓ 已重生成声明基线：${fileCount} 个声明文件，sha256=${hash}`);
