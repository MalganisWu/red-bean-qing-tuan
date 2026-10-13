import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  declarationBaselineHash,
  declarationBaselinePath,
} from "./declaration-baseline.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { hash: actual, fileCount } = await declarationBaselineHash(root);
const expected = (await readFile(declarationBaselinePath(root), "utf8")).trim();

if (actual !== expected) {
  console.error("✗ TypeScript 声明基线发生变化");
  console.error(`  expected=${expected}`);
  console.error(`  actual=${actual}`);
  console.error(
    "  改过 JSDoc 或公开面就要重生成：make ts-decl-baseline-update（顺序必须是先构建再更新）",
  );
  process.exit(1);
}

console.log(`✓ ${fileCount} 个声明文件与完整 API 基线一致`);
