import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DECLARATION_KINDS,
  STATEMENT_KINDS,
  createSymbolResolver,
  parseSourceFile,
} from "./architecture-syntax.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = path.join(root, "src");
const testRoot = path.join(root, "test");
const failures = [];
const warnings = [];
const dtoPurityCasesPath = path.join(
  root,
  "testdata/architecture/dto-purity-cases.json",
);
const testFileSizeCasesPath = path.join(
  root,
  "testdata/architecture/test-file-size-cases.json",
);
const implementationContractCasesPath = path.join(
  root,
  "testdata/architecture/implementation-contract-cases.json",
);
const testFileWarningLines = 400;

// 跨能力只依赖 Port；具体实现统一在 composition root 中选择。
const allowedCrossCapabilityImplementationImports = new Set();
const observedAllowedImports = new Set();

const allowedCapabilityDependencies = Object.freeze({
  protocol: new Set(),
  llm: new Set(["protocol"]),
  tool: new Set(["protocol"]),
  observability: new Set(["protocol"]),
  pipeline: new Set(["protocol", "llm", "tool"]),
  runtime: new Set(["protocol", "llm", "tool", "observability", "pipeline"]),
  testing: new Set(["protocol", "runtime"]),
});

const expectedPublicApiAggregators = Object.freeze([
  ["src/index.ts", "./runtime/public-api.js"],
  ["src/llm/index.ts", "./public-api.js"],
  ["src/observability/index.ts", "./public-api.js"],
  ["src/pipeline/index.ts", "./public-api.js"],
  ["src/testing/index.ts", "./public-api.js"],
  ["src/tool/index.ts", "./public-api.js"],
]);

// 这些文件只为稳定 package export 保留，生产实现不得借它们绕回宽聚合依赖。
const publicCompatibilityAggregators = new Set([
  path.join(sourceRoot, "runtime/checkpoint/checkpoint.ts"),
  path.join(sourceRoot, "runtime/config/runtime-config.ts"),
  path.join(sourceRoot, "testing/checkpoint-store-contract.ts"),
]);

async function listTypeScriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listTypeScriptFiles(target)));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(target);
  }
  return files;
}

function importSpecifiers(source) {
  const specifiers = [];
  const pattern =
    /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)(["'])([^"']+)\1/gu;
  for (const match of source.matchAll(pattern)) {
    const specifier = match[2];
    if (specifier !== undefined) specifiers.push(specifier);
  }
  return specifiers;
}

function capabilityOwner(file) {
  const relative = path.relative(sourceRoot, file);
  return relative.split(path.sep)[0] ?? "";
}

function resolveRelativeImport(file, specifier) {
  if (!specifier.startsWith(".")) return undefined;
  return path.resolve(path.dirname(file), specifier.replace(/\.js$/u, ".ts"));
}

function importsImplementationDirectory(target) {
  const segments = path.relative(sourceRoot, target).split(path.sep);
  return segments.some((segment, index) => {
    if (segment === "adapter" && segments[index + 1] === "port") return false;
    return ["adapter", "impl", "service"].includes(segment);
  });
}

function importEdge(file, target) {
  return `${path.relative(root, file)}→${path.relative(root, target)}`;
}

function isCompositionRoot(file) {
  return path.basename(file).endsWith("-composition.ts");
}

function isPublicAggregator(file) {
  const basename = path.basename(file);
  return basename === "index.ts" || basename === "public-api.ts";
}

function isPort(file) {
  return path.relative(sourceRoot, file).split(path.sep).includes("port");
}

function isModel(file) {
  return path.relative(sourceRoot, file).split(path.sep).includes("model");
}

function isDataOnlyDto(file) {
  if (isModel(file)) return true;
  const relativePath = path.relative(sourceRoot, file);
  const pathSegments = relativePath.split(path.sep);
  if (!pathSegments.some((part) => ["request", "result"].includes(part))) {
    return false;
  }
  // request/result 下允许紧邻 DTO 放置具名转换与校验器，但数据文件本身必须保持无行为。
  return !/(?:validator|mapper|parser|serializer|normalizer|factory|presenter)\.ts$/u.test(
    path.basename(file),
  );
}

function dtoRuntimeDeclarations(source, fileName) {
  const { statements: topLevel } = parseSourceFile(fileName, source);
  const declarations = [];
  for (const statement of topLevel) {
    const kind = dtoRuntimeDeclarationKind(statement);
    if (kind === undefined) continue;
    declarations.push(`${kind}@${statement.line}`);
  }
  return declarations;
}

/** 把中性语句事实映射为 DTO 纯度违规名；返回 `undefined` 表示该语句不产生运行时值。 */
function dtoRuntimeDeclarationKind(statement) {
  if (statement.kind === STATEMENT_KINDS.EXPORT) {
    return statement.typeOnly === true ? undefined : "runtime re-export";
  }
  if (statement.kind === STATEMENT_KINDS.EXPORT_ASSIGNMENT) {
    return "export default";
  }
  if (statement.kind !== STATEMENT_KINDS.DECLARATION) return undefined;
  if (statement.declarationKind === DECLARATION_KINDS.CLASS) return "class";
  if (statement.declarationKind === DECLARATION_KINDS.FUNCTION) {
    return "function";
  }
  if (statement.declarationKind === DECLARATION_KINDS.VARIABLE) {
    return "const/let/var";
  }
  if (statement.declarationKind === DECLARATION_KINDS.ENUM) return "enum";
  if (statement.declarationKind === DECLARATION_KINDS.MODULE) {
    return "module/namespace";
  }
  return undefined;
}

function sourceLineCount(source) {
  const lineCount = source.split(/\r?\n/u).length;
  return source.endsWith("\n") ? lineCount - 1 : lineCount;
}

function exceedsTestFileWarning(source) {
  return sourceLineCount(source) > testFileWarningLines;
}

function normalizeRelativePath(file) {
  return file.split(path.sep).join("/");
}

function implementationCapability(relativePath) {
  const segments = normalizeRelativePath(relativePath).split("/");
  const boundary = segments.findIndex((segment) =>
    ["service", "adapter"].includes(segment),
  );
  return boundary < 0
    ? segments.slice(0, -1).join("/")
    : segments.slice(0, boundary).join("/");
}

function portCapability(relativePath) {
  const segments = normalizeRelativePath(relativePath).split("/");
  const portIndex = segments.indexOf("port");
  return portIndex < 0 ? undefined : segments.slice(0, portIndex).join("/");
}

// 通用规则只接受同能力 port；跨能力装饰器与稳定公共契约必须精确登记四元组。
const allowedImplementationContracts = new Map(
  [
    [
      "llm/openai/adapter/openai-compatible-adapter.ts#OpenAiAdapter",
      "llm/adapter/port/llm-adapter.ts#LlmAdapter",
    ],
    [
      "runtime/runtime-composition.ts#PolicyDispatcher",
      "tool/dispatcher/port/tool-dispatcher.ts#ToolDispatcher",
    ],
    [
      "runtime/observability/runtime-trace-plugin.ts#TracedLlmAdapter",
      "llm/adapter/port/llm-adapter.ts#LlmAdapter",
    ],
    [
      "runtime/observability/runtime-trace-plugin.ts#TracedToolDispatcher",
      "tool/dispatcher/port/tool-dispatcher.ts#ToolDispatcher",
    ],
    [
      "runtime/observability/runtime-trace-plugin.ts#TracedChildRunner",
      "tool/delegation/runner/port/child-runner.ts#ChildRunner",
    ],
    [
      "runtime/observability/runtime-trace-plugin.ts#RuntimeTracePlugin",
      "runtime/plugin/runtime-plugin.ts#RuntimePlugin",
    ],
    [
      "tool/builtin/http-request/egress-policy.ts#PublicInternetOnlyPolicy",
      "tool/builtin/http-request/http-contracts.ts#EgressPolicy",
    ],
    [
      "tool/builtin/http-request/egress-policy.ts#AllowAllEgressPolicy",
      "tool/builtin/http-request/http-contracts.ts#EgressPolicy",
    ],
    [
      "tool/builtin/http-request/http-client.ts#PolicyHttpClient",
      "tool/builtin/http-request/http-contracts.ts#HttpClient",
    ],
    ...[
      "tool/builtin/fetch-url/fetch-url-tool.ts#FetchUrlTool",
      "tool/builtin/get-time/get-time-tool.ts#GetTimeTool",
      "tool/builtin/apply-patch/apply-patch-tool.ts#ApplyPatchTool",
      "tool/builtin/edit-file/edit-file-tool.ts#EditFileTool",
      "tool/builtin/glob/glob-tool.ts#GlobTool",
      "tool/builtin/grep/grep-tool.ts#GrepTool",
      "tool/builtin/http-request/http-request-tool.ts#HttpRequestTool",
      "tool/builtin/list-directory/list-directory-tool.ts#ListDirectoryTool",
      "tool/builtin/read-file/read-file-tool.ts#UnrestrictedReadTool",
      "tool/builtin/shell/shell-tool.ts#ShellTool",
      "tool/builtin/read-file/read-file-tool.ts#RootedReadTool",
      "tool/builtin/todo-write/todo-write-tool.ts#TodoWriteTool",
      "tool/builtin/write-file/write-file-tool.ts#WriteFileTool",
      "tool/delegation/service/delegation-tool.ts#DelegationTool",
    ].map((implementation) => [implementation, "tool/definition/tool.ts#Tool"]),
  ].map(([implementation, contract]) => [implementation, new Set([contract])]),
);

// 实现目录中的非 Port helper/value/error 必须精确登记，禁止用类名后缀猜测后放行。
const nonPortImplementationClasses = new Set([
  "pipeline/pipeline/service/sequential-pipeline.ts#PipelineBuilder",
  "runtime/checkpoint/store/adapter/memory-checkpoint-receipts.ts#MemoryCheckpointReceiptLedger",
  "tool/builtin/http-request/egress-policy.ts#IpDenyList",
  "tool/builtin/file-access/path-policy.ts#RootedFileAccess",
  "tool/builtin/shell/shell-process.ts#OutputCollector",
  "tool/dispatcher/service/map-tool-dispatcher.ts#ToolDispatchError",
]);

function isManagedImplementationFile(relativePath) {
  const pathSegments = normalizeRelativePath(relativePath).split("/");
  return (
    pathSegments.some((part) =>
      ["adapter", "service", "builtin"].includes(part),
    ) ||
    path.posix.basename(normalizeRelativePath(relativePath)) ===
      "runtime-trace-plugin.ts"
  );
}

/** 实现/契约标识：相对 analysisRoot 的路径 + 名字；匿名类统一记为 `anonymous`。 */
function declarationIdentity(analysisRoot, file, name) {
  const relativeFile = normalizeRelativePath(path.relative(analysisRoot, file));
  return `${relativeFile}#${name ?? "anonymous"}`;
}

function contractIdentity(analysisRoot, contract) {
  return declarationIdentity(analysisRoot, contract.file, contract.name);
}

function implementationContractMatch(
  analysisRoot,
  implementationFile,
  implementationName,
  contract,
) {
  const implementation = declarationIdentity(
    analysisRoot,
    implementationFile,
    implementationName,
  );
  const contractKey = contractIdentity(analysisRoot, contract);
  const contractFile = contractKey.slice(0, contractKey.lastIndexOf("#"));
  const sameCapabilityPort =
    portCapability(contractFile) !== undefined &&
    portCapability(contractFile) ===
      implementationCapability(
        normalizeRelativePath(path.relative(analysisRoot, implementationFile)),
      );
  return {
    allowed:
      sameCapabilityPort ||
      (allowedImplementationContracts.get(implementation)?.has(contractKey) ??
        false),
    whitelistEntry: sameCapabilityPort
      ? undefined
      : `${implementation}→${contractKey}`,
  };
}

/**
 * 校验一个类声明的 implements 契约。
 *
 * 逐个接口名交给隔离层的符号解析器；解析不到具名 interface、或契约不属于同能力 Port
 * 且未精确登记时按原有语义报违规，其余记为已使用的白名单绑定。
 */
function classImplementationContracts(
  resolver,
  analysisRoot,
  file,
  className,
  interfaceNames,
) {
  const bindings = [];
  const violations = [];
  for (const interfaceName of interfaceNames) {
    const contract = resolver.resolveImplementedInterface(
      file,
      className,
      interfaceName,
    );
    if (contract === undefined) {
      violations.push(
        `${className} 的 implements 未解析到真实 interface symbol`,
      );
      continue;
    }
    const match = implementationContractMatch(
      analysisRoot,
      file,
      className,
      contract,
    );
    if (!match.allowed) {
      violations.push(
        `${declarationIdentity(analysisRoot, file, className)} 不得实现 ${contractIdentity(analysisRoot, contract)}`,
      );
      continue;
    }
    bindings.push({
      identity: contractIdentity(analysisRoot, contract),
      whitelistEntry: match.whitelistEntry,
    });
  }
  return { bindings, violations };
}

function inspectImplementationContracts(resolver, analysisRoot) {
  const validatedClasses = new Set();
  const observedNonPortExceptions = new Set();
  const observedWhitelistEntries = new Set();
  const violations = [];
  const analysisPrefix = `${path.resolve(analysisRoot)}${path.sep}`;
  let count = 0;
  let bindingCount = 0;
  for (const fileName of resolver.fileNames) {
    if (!path.resolve(fileName).startsWith(analysisPrefix)) continue;
    const { statements: topLevel } = resolver.parseFile(fileName);
    for (const statement of topLevel) {
      if (statement.declarationKind !== DECLARATION_KINDS.CLASS) continue;
      if (statement.name === undefined) continue;
      const identity = declarationIdentity(
        analysisRoot,
        fileName,
        statement.name,
      );
      const managed = isManagedImplementationFile(
        normalizeRelativePath(path.relative(analysisRoot, fileName)),
      );
      const interfaceNames = statement.implementsNames ?? [];
      if (interfaceNames.length === 0) {
        if (managed && nonPortImplementationClasses.has(identity)) {
          observedNonPortExceptions.add(identity);
        } else if (managed) {
          violations.push(
            `${identity} 是受管生产实现类，必须显式 implements 对应 Port`,
          );
        }
        continue;
      }
      const result = classImplementationContracts(
        resolver,
        analysisRoot,
        fileName,
        statement.name,
        interfaceNames,
      );
      violations.push(...result.violations);
      if (result.violations.length === 0 && result.bindings.length > 0) {
        validatedClasses.add(identity);
        for (const binding of result.bindings) {
          if (binding.whitelistEntry !== undefined) {
            observedWhitelistEntries.add(binding.whitelistEntry);
          }
        }
      }
      count += 1;
    }
  }

  for (const fileName of resolver.fileNames) {
    const basename = path.basename(fileName);
    if (
      !basename.endsWith("-composition.ts") &&
      !basename.endsWith(".module.ts")
    ) {
      continue;
    }
    for (const declaration of resolver.resolveConstructedClasses(fileName)) {
      if (declaration === undefined) continue;
      if (!path.resolve(declaration.file).startsWith(analysisPrefix)) continue;
      const identity = declarationIdentity(
        analysisRoot,
        declaration.file,
        declaration.name,
      );
      if (!validatedClasses.has(identity)) {
        violations.push(
          `${normalizeRelativePath(path.relative(analysisRoot, fileName))} 中的 new ${declaration.name ?? "anonymous"} 无法追溯到精确接口`,
        );
      } else {
        bindingCount += 1;
      }
    }
  }
  return {
    bindingCount,
    count,
    observedNonPortExceptions,
    observedWhitelistEntries,
    violations,
  };
}

/**
 * 构造一个夹具的符号解析器。
 *
 * 夹具源码只存在于 JSON 内嵌字符串里，不落盘；这里把虚拟源码按绝对路径装进
 * Map 交给隔离层的内存 provider，语义查询与真实源码共用同一套实现。
 */
function createFixture(testCase) {
  const fixtureRoot = path.resolve(
    root,
    ".architecture-fixture",
    testCase.name,
  );
  const sources = new Map(
    Object.entries({
      [testCase.file]: testCase.source,
      ...(testCase.dependencies ?? {}),
    }).map(([file, source]) => [path.resolve(fixtureRoot, file), source]),
  );
  return {
    root: fixtureRoot,
    resolver: createSymbolResolver([...sources.keys()], { sources }),
  };
}

const dtoPurityCases = JSON.parse(await readFile(dtoPurityCasesPath, "utf8"));
for (const testCase of dtoPurityCases) {
  const violations = dtoRuntimeDeclarations(testCase.source, testCase.name);
  const valid = violations.length === 0;
  if (valid !== testCase.valid) {
    failures.push(
      `DTO 纯度门禁负例 ${JSON.stringify(testCase.name)} 预期 valid=${String(testCase.valid)}，实际检测到 ${violations.join(", ") || "无运行时声明"}`,
    );
  }
}

const testFileSizeCases = JSON.parse(
  await readFile(testFileSizeCasesPath, "utf8"),
);
for (const testCase of testFileSizeCases) {
  const source = Array.from(
    { length: testCase.lines },
    (_value, index) => `line ${String(index + 1)}`,
  ).join("\n");
  const warned = exceedsTestFileWarning(source);
  if (warned !== testCase.warned) {
    failures.push(
      `测试文件规模门禁用例 ${JSON.stringify(testCase.name)} 预期 warned=${String(testCase.warned)}，实际为 ${String(warned)}`,
    );
  }
}

const implementationContractCases = JSON.parse(
  await readFile(implementationContractCasesPath, "utf8"),
);
for (const testCase of implementationContractCases) {
  const fixture = createFixture(testCase);
  const { violations } = inspectImplementationContracts(
    fixture.resolver,
    fixture.root,
  );
  const valid = violations.length === 0;
  if (valid !== testCase.valid) {
    failures.push(
      `implements 对应能力门禁用例 ${JSON.stringify(testCase.name)} 预期 valid=${String(testCase.valid)}，实际检测到 ${violations.join(", ") || "无缺失"}`,
    );
  }
}

function findImportCycles(graph) {
  const cycles = [];
  const visited = new Set();
  const active = new Set();
  const stack = [];
  function visit(file) {
    if (active.has(file)) {
      const start = stack.indexOf(file);
      cycles.push([...stack.slice(start), file]);
      return;
    }
    if (visited.has(file)) return;
    visited.add(file);
    active.add(file);
    stack.push(file);
    for (const target of graph.get(file) ?? []) visit(target);
    stack.pop();
    active.delete(file);
  }
  for (const file of graph.keys()) visit(file);
  return cycles;
}

const sourceFiles = await listTypeScriptFiles(sourceRoot);
const sourceResolver = createSymbolResolver(sourceFiles);
const contractAudit = inspectImplementationContracts(
  sourceResolver,
  sourceRoot,
);
failures.push(...contractAudit.violations);
for (const [implementation, contracts] of allowedImplementationContracts) {
  for (const contract of contracts) {
    const entry = `${implementation}→${contract}`;
    if (!contractAudit.observedWhitelistEntries.has(entry)) {
      failures.push(`精确 implements 白名单未被使用，请删除或修正：${entry}`);
    }
  }
}
for (const identity of nonPortImplementationClasses) {
  if (!contractAudit.observedNonPortExceptions.has(identity)) {
    failures.push(`非 Port 实现类例外未被使用，请删除或修正：${identity}`);
  }
}
const testFiles = (await listTypeScriptFiles(testRoot)).filter((file) =>
  file.endsWith(".test.ts"),
);
for (const file of testFiles) {
  const source = await readFile(file, "utf8");
  const lineCount = sourceLineCount(source);
  if (exceedsTestFileWarning(source)) {
    warnings.push(
      `${path.relative(root, file)} 共 ${String(lineCount)} 行，超过 ${String(testFileWarningLines)} 行 review warning，请按能力边界拆分`,
    );
  }
}
const importGraph = new Map();
for (const file of sourceFiles) {
  const relativePath = path.relative(sourceRoot, file);
  const pathSegments = relativePath.split(path.sep);
  if (pathSegments.some((segment) => ["core", "impl"].includes(segment))) {
    failures.push(`${path.relative(root, file)} 位于已退役的 core/impl 目录`);
  }
  const source = await readFile(file, "utf8");
  const { statements: topLevel } = parseSourceFile(file, source);
  if (
    isPort(file) &&
    topLevel.some(
      (statement) => statement.declarationKind === DECLARATION_KINDS.CLASS,
    )
  ) {
    failures.push(`${path.relative(root, file)} 的 port 文件不得包含实现类`);
  }
  if (isDataOnlyDto(file)) {
    const declarations = dtoRuntimeDeclarations(source, relativePath);
    if (declarations.length > 0) {
      failures.push(
        `${path.relative(root, file)} 的 DTO 文件只能包含纯数据类型，发现 ${declarations.join(", ")}`,
      );
    }
  }
  const dependencies = [];
  for (const specifier of importSpecifiers(source)) {
    if (!specifier.startsWith(".") && !specifier.startsWith("node:")) {
      failures.push(
        `${path.relative(root, file)} 直接导入生产外部包 ${JSON.stringify(specifier)}`,
      );
      continue;
    }
    const target = resolveRelativeImport(file, specifier);
    if (target === undefined || !target.startsWith(`${sourceRoot}${path.sep}`))
      continue;
    dependencies.push(target);
    const sourceOwner = capabilityOwner(file);
    const targetOwner = capabilityOwner(target);
    if (!isPublicAggregator(file) && isPublicAggregator(target)) {
      failures.push(
        `${path.relative(root, file)} 不得通过公开聚合入口依赖内部能力 ${path.relative(root, target)}`,
      );
    }
    if (
      !isPublicAggregator(file) &&
      publicCompatibilityAggregators.has(target)
    ) {
      failures.push(
        `${path.relative(root, file)} 不得通过兼容聚合入口依赖内部能力 ${path.relative(root, target)}`,
      );
    }
    if (
      sourceOwner !== targetOwner &&
      !isPublicAggregator(file) &&
      !allowedCapabilityDependencies[sourceOwner]?.has(targetOwner)
    ) {
      failures.push(
        `${path.relative(root, file)} 违反能力依赖方向，不能依赖 ${path.relative(root, target)}`,
      );
    }
    if (isPort(file) && importsImplementationDirectory(target)) {
      failures.push(
        `${path.relative(root, file)} 的 Port 不能依赖实现 ${path.relative(root, target)}`,
      );
    }
    const edge = importEdge(file, target);
    const crossesIntoImplementation =
      capabilityOwner(file) !== capabilityOwner(target) &&
      importsImplementationDirectory(target);
    if (
      crossesIntoImplementation &&
      allowedCrossCapabilityImplementationImports.has(edge)
    ) {
      observedAllowedImports.add(edge);
    } else if (crossesIntoImplementation && !isCompositionRoot(file)) {
      failures.push(
        `${path.relative(root, file)} 跨能力导入内部实现 ${path.relative(root, target)}`,
      );
    }
  }
  importGraph.set(file, dependencies);
}

for (const cycle of findImportCycles(importGraph)) {
  failures.push(
    `检测到源码循环依赖：${cycle.map((file) => path.relative(root, file)).join(" → ")}`,
  );
}

for (const edge of allowedCrossCapabilityImplementationImports) {
  if (!observedAllowedImports.has(edge)) {
    failures.push(`已登记的跨能力实现桥接不存在，请删除过期例外：${edge}`);
  }
}

for (const [entrypoint, publicApi] of expectedPublicApiAggregators) {
  const source = await readFile(path.join(root, entrypoint), "utf8");
  const statement = `export * from ${JSON.stringify(publicApi)};`;
  if (!source.includes(statement)) {
    failures.push(`${entrypoint} 必须通过 ${publicApi} 维护公开 API`);
  }
}

const manifest = JSON.parse(
  await readFile(path.join(root, "package.json"), "utf8"),
);
for (const field of ["dependencies", "optionalDependencies"]) {
  const dependencies = manifest[field];
  if (dependencies !== undefined && Object.keys(dependencies).length > 0) {
    failures.push(`package.json#${field} 必须为空，Runtime 保持零生产依赖`);
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`✗ ${failure}`);
  process.exit(1);
}

for (const warning of warnings) console.warn(`⚠ ${warning}`);

console.log(
  `✓ ${sourceFiles.length} 个生产源码文件满足能力 DAG 与无环约束，${contractAudit.count} 个实现通过 Compiler API 精确解析并对应能力接口，${contractAudit.bindingCount} 个 composition/module 生产绑定可追溯，${implementationContractCases.length} 个 implements 正反例通过，${dtoPurityCases.length} 个 DTO 纯度正反例与 ${testFileSizeCases.length} 个测试规模正反例通过；扫描 ${testFiles.length} 个测试文件，${warnings.length} 个超过 ${testFileWarningLines} 行；${expectedPublicApiAggregators.length} 个公开入口经 public-api 聚合，且生产依赖为空`,
);
