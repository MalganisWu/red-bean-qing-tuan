import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const baselinePath = path.join(root, "testdata/api/public-declarations.sha256");

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

const hash = createHash("sha256");
const files = (await declarationFiles(dist)).sort();
for (const file of files) {
  hash.update(path.relative(dist, file));
  hash.update("\0");
  hash.update(await readFile(file));
  hash.update("\0");
}
const actual = hash.digest("hex");
const expected = (await readFile(baselinePath, "utf8")).trim();

if (actual !== expected) {
  console.error("✗ TypeScript 声明基线发生变化");
  console.error(`  expected=${expected}`);
  console.error(`  actual=${actual}`);
  process.exit(1);
}

console.log(`✓ ${files.length} 个声明文件与完整 API 基线一致`);
