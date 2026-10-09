import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(
  await readFile(path.join(root, "package.json"), "utf8"),
);
const snapshot = JSON.parse(
  await readFile(path.join(root, "testdata/api/public-exports.json"), "utf8"),
);
const failures = [];
const exportEntries = Object.entries(packageJson.exports ?? {});

for (const [subpath, declaration] of exportEntries) {
  if (subpath.includes("*"))
    failures.push(`禁止通配 public export：${subpath}`);
  if (
    typeof declaration !== "object" ||
    declaration === null ||
    typeof declaration.import !== "string" ||
    typeof declaration.types !== "string"
  ) {
    failures.push(`export ${subpath} 必须同时声明 import 与 types`);
    continue;
  }
  for (const [kind, target] of [
    ["import", declaration.import],
    ["types", declaration.types],
  ]) {
    if (!target.startsWith("./dist/")) {
      failures.push(`export ${subpath} 的 ${kind} 未指向 dist：${target}`);
      continue;
    }
    try {
      await access(path.join(root, target));
    } catch {
      failures.push(`export ${subpath} 的 ${kind} 目标不存在：${target}`);
    }
  }
}

const packageNames = new Set(
  exportEntries.map(([subpath]) =>
    subpath === "."
      ? packageJson.name
      : `${packageJson.name}/${subpath.slice(2)}`,
  ),
);
for (const packageName of Object.keys(snapshot)) {
  if (!packageNames.has(packageName)) {
    failures.push(`快照包含未声明的 public subpath：${packageName}`);
    continue;
  }
  const actual = Object.keys(await import(packageName)).sort();
  const expected = [...snapshot[packageName]].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures.push(
      `${packageName} 导出漂移\n  expected=${JSON.stringify(expected)}\n  actual=${JSON.stringify(actual)}`,
    );
  }
}
for (const packageName of packageNames) {
  if (!(packageName in snapshot))
    failures.push(`public subpath 缺少快照：${packageName}`);
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`✗ ${failure}`);
  process.exit(1);
}
console.log(`✓ ${packageNames.size} 个 public subpath 与 API surface 快照一致`);
