import { access, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  intentionallyDisabledRules,
  requiredCompilerOptions,
  requiredPackageScripts,
  typescriptSafetyRules,
} from "../tooling/typescript/policy.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];

async function readJson(relativePath) {
  const source = await readFile(path.join(root, relativePath), "utf8");
  return JSON.parse(source);
}

const baseConfig = await readJson("tooling/typescript/tsconfig.base.json");
for (const [name, expected] of Object.entries(requiredCompilerOptions)) {
  if (baseConfig.compilerOptions?.[name] !== expected) {
    failures.push(
      `tooling/typescript/tsconfig.base.json 缺少 ${name}: ${String(expected)}`,
    );
  }
}

const rootConfig = await readFile(path.join(root, "tsconfig.json"), "utf8");
if (!rootConfig.includes("./tooling/typescript/tsconfig.base.json")) {
  failures.push("tsconfig.json 未继承共享严格配置");
}

const manifest = await readJson("package.json");
for (const scriptName of requiredPackageScripts) {
  if (typeof manifest.scripts?.[scriptName] !== "string") {
    failures.push(`package.json 缺少 scripts.${scriptName}`);
  }
}

if (manifest.packageManager !== "pnpm@11.5.2") {
  failures.push("package.json packageManager 必须为 pnpm@11.5.2");
}
if (manifest.engines?.node !== ">=24.9.0 <26") {
  failures.push("package.json engines.node 必须为 >=24.9.0 <26");
}
if (manifest.engines?.pnpm !== ">=11 <12") {
  failures.push("package.json engines.pnpm 必须为 >=11 <12");
}

const eslintConfig = await readFile(
  path.join(root, "eslint.config.js"),
  "utf8",
);
if (!eslintConfig.includes("./tooling/typescript/policy.mjs")) {
  failures.push("eslint.config.js 未加载共享 TypeScript 政策");
}
if (!eslintConfig.includes("strictTypeChecked")) {
  failures.push("eslint.config.js 未启用 strictTypeChecked");
}

for (const [ruleName, severity] of Object.entries(typescriptSafetyRules)) {
  const configuredSeverity = Array.isArray(severity) ? severity[0] : severity;
  const expectedSeverity = intentionallyDisabledRules.includes(ruleName)
    ? "off"
    : "error";
  if (configuredSeverity !== expectedSeverity) {
    failures.push(`共享 ESLint 规则 ${ruleName} 必须为 error`);
  }
}

try {
  await access(path.join(root, "tooling/typescript/strict-smoke.ts"));
} catch {
  failures.push(
    "缺少 tooling/typescript/strict-smoke.ts，空载门禁无法证明编译器实际运行",
  );
}

const makefile = await readFile(path.join(root, "Makefile"), "utf8");
for (const target of [
  "typecheck:",
  "ts-lint:",
  "ts-format-check:",
  "ts-policy-check:",
  "ts-api-check:",
  "ts-test:",
  "ts-build:",
  "verify:",
]) {
  if (!makefile.includes(target)) failures.push(`Makefile 缺少 ${target}`);
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`✗ ${failure}`);
  process.exit(1);
}

console.log(
  "✓ Runtime TypeScript 严格配置、ESLint 政策、工具链声明与空载样例完整",
);
