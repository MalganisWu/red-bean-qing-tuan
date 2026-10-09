import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

/**
 * 架构门禁的语法与符号隔离层。
 *
 * 本模块是 runtime 仓内**唯一**允许接触 TypeScript 编译器 API 的位置，把源码解析成
 * 与编译器版本无关的中性结构，并只对外提供语法事实与两个语义查询。架构规则
 * `check-architecture.mjs` 因此不依赖 `ts.*` 类型与常量，升级 TypeScript 主版本时
 * 只需替换本文件实现：
 *
 * - 语法侧 `parseSourceFile()`：TS 7 可改用 `typescript/unstable/ast` 或等价解析器。
 * - 语义侧 `createSymbolResolver()`：TS 7.0 无公开编译器 API，7.1 的新 API 落地后在本文件接上。
 *
 * 中性结构刻意保持"事实"而非"策略"：这里不做目录判断、白名单过滤或规则命名，
 * 这些仍属于 `check-architecture.mjs` 的职责。
 *
 * 与产品仓 `backend/scripts/architecture-syntax.mjs` 的差异只有一处：
 * `createSymbolResolver()` 额外接受内存 source provider。门禁夹具自测以 JSON 内嵌虚拟源码，
 * 不落盘，因此解析器必须能由调用方参数化源文件来源：不传 `sources` 时读磁盘，
 * 传入 `Map<绝对路径, 源码>` 时用内存 compiler host 构造 program，两种模式共用同一套
 * 语义查询。文件系统关注点（`.js` → `.ts`、`index.ts`、存在性检查）仍留在规则文件。
 */

/** 声明种类；规则按此判定 DTO 纯度与文档要求，不感知编译器节点类型。 */
export const DECLARATION_KINDS = Object.freeze({
  INTERFACE: "interface",
  TYPE_ALIAS: "typeAlias",
  CLASS: "class",
  FUNCTION: "function",
  VARIABLE: "variable",
  ENUM: "enum",
  MODULE: "module",
});

/** 语句种类；`other` 表示非声明、非 import/export 的运行时代码。 */
export const STATEMENT_KINDS = Object.freeze({
  IMPORT: "import",
  EXPORT: "export",
  DECLARATION: "declaration",
  EXPORT_ASSIGNMENT: "exportAssignment",
  EMPTY: "empty",
  OTHER: "other",
});

/**
 * 解析一个 TypeScript 源文件为中性结构。
 *
 * 每个语句暴露规则实际使用的事实：`kind`、声明种类与名字、是否带 export 修饰符、
 * 1 起始行号、前导注释原文、import/export 是否 type-only，以及 class 的 implements 类型名。
 * `leadingTrivia` 保持原文而不是在隔离层判定中文，中文注释策略仍属于规则文件。
 */
export function parseSourceFile(
  fileName,
  source = readFileSync(fileName, "utf8"),
) {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  return { statements: parseStatements(sourceFile, source) };
}

/**
 * 跨文件符号解析。
 *
 * `rootFiles` 是进入扫描范围的绝对文件路径；`options.sources` 是可选的内存源文件
 * provider（`Map<绝对路径, 源码>`），仅供夹具自测使用。返回 `{ file, name }` 纯数据，
 * 调用方拿不到编译器符号、节点或类型对象。
 *
 * `fileNames` 按 program 顺序给出全部源文件（含 lib 文件），规则据此复现"遍历 program"
 * 的原有扫描范围；磁盘模式与内存模式行为一致。
 */
export function createSymbolResolver(rootFiles, options = {}) {
  const program =
    options.sources === undefined
      ? ts.createProgram({ rootNames: rootFiles, options: PROGRAM_OPTIONS })
      : createInMemoryProgram(rootFiles, options.sources);
  const checker = program.getTypeChecker();
  const parsedFiles = new Map();

  /**
   * 按 program 自身 AST 解析中性事实。
   *
   * 夹具虚拟源码不存在于磁盘，不能走 `parseSourceFile` 的 readFile 路径；从 program
   * 取 sourceFile 也保证规则看到的语法与符号解析基于同一份源码。
   */
  const parseFile = (fileName) => {
    const cached = parsedFiles.get(fileName);
    if (cached !== undefined) return cached;
    const sourceFile = program.getSourceFile(fileName);
    const parsed =
      sourceFile === undefined
        ? { statements: [] }
        : { statements: parseStatements(sourceFile, sourceFile.text) };
    parsedFiles.set(fileName, parsed);
    return parsed;
  };

  /** 在 `file` 中把 `implements` 写下的类型名解析到具名 interface 声明。 */
  const resolveImplementedInterface = (file, className, interfaceName) => {
    const sourceFile = program.getSourceFile(file);
    if (sourceFile === undefined) return undefined;
    const classNode = sourceFile.statements.find(
      (statement) =>
        ts.isClassDeclaration(statement) && statement.name?.text === className,
    );
    if (classNode === undefined || !ts.isClassDeclaration(classNode)) {
      return undefined;
    }
    const clauses =
      classNode.heritageClauses?.filter(
        (clause) => clause.token === ts.SyntaxKind.ImplementsKeyword,
      ) ?? [];
    for (const typeNode of clauses.flatMap((clause) => clause.types)) {
      if (typeNode.getText(sourceFile) !== interfaceName) continue;
      const symbol = resolveAliasedSymbol(
        checker,
        checker.getSymbolAtLocation(typeNode.expression),
      );
      const declaration = symbol?.declarations?.find(ts.isInterfaceDeclaration);
      if (declaration === undefined || declaration.name === undefined) {
        return undefined;
      }
      return {
        file: path.resolve(declaration.getSourceFile().fileName),
        name: declaration.name.text,
      };
    }
    return undefined;
  };

  /**
   * 在模块文件里按出现顺序解析每个 `new X()` 的构造目标。
   *
   * 每个元素对应一个 new 表达式：解析到类声明时为 `{ file, name }`（匿名类 `name`
   * 为 `undefined`），否则为 `undefined`。是否落在扫描范围内由规则判断，隔离层不做
   * 路径策略。保留逐表达式的结果是必要的，规则要对每个构造点计数或报错。
   */
  const resolveConstructedClasses = (file) => {
    const sourceFile = program.getSourceFile(file);
    if (sourceFile === undefined) return [];
    const resolvedClasses = [];
    const visit = (node) => {
      if (ts.isNewExpression(node)) {
        const symbol = resolveAliasedSymbol(
          checker,
          checker.getSymbolAtLocation(node.expression),
        );
        const declaration = symbol?.declarations?.find(ts.isClassDeclaration);
        const targetFile = declaration?.getSourceFile().fileName;
        resolvedClasses.push(
          targetFile === undefined
            ? undefined
            : { file: path.resolve(targetFile), name: declaration?.name?.text },
        );
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sourceFile, visit);
    return resolvedClasses;
  };

  return {
    fileNames: program
      .getSourceFiles()
      .map((sourceFile) => sourceFile.fileName),
    parseFile,
    resolveConstructedClasses,
    resolveImplementedInterface,
  };
}

/**
 * 构造 program 的编译器选项。
 *
 * 这些选项只影响符号解析的可达性，不承载规则策略；与改造前一致地固定为
 * NodeNext + ES2023，磁盘源码与内存夹具共用，避免两条路径出现解析差异。
 */
const PROGRAM_OPTIONS = Object.freeze({
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  target: ts.ScriptTarget.ES2023,
  noEmit: true,
});

function parseStatements(sourceFile, source) {
  return sourceFile.statements.map((statement) =>
    classifyStatement(statement, sourceFile, source),
  );
}

function classifyStatement(statement, sourceFile, source) {
  const base = {
    line:
      sourceFile.getLineAndCharacterOfPosition(statement.getStart(sourceFile))
        .line + 1,
    // 前导注释原文：中文 JSDoc 的判据留在规则文件，隔离层只负责切片。
    leadingTrivia: source.slice(
      statement.getFullStart(),
      statement.getStart(sourceFile),
    ),
  };
  if (ts.isImportDeclaration(statement)) {
    return {
      ...base,
      kind: STATEMENT_KINDS.IMPORT,
      typeOnly: isTypeOnlyImport(statement),
    };
  }
  if (ts.isExportDeclaration(statement)) {
    return {
      ...base,
      kind: STATEMENT_KINDS.EXPORT,
      typeOnly: isTypeOnlyExport(statement),
    };
  }
  const declarationKind = declarationKindOf(statement);
  if (declarationKind !== undefined) {
    return {
      ...base,
      kind: STATEMENT_KINDS.DECLARATION,
      declarationKind,
      name: declarationNameOf(statement),
      exported: hasExportModifier(statement),
      implementsNames: implementsTypeNames(statement, sourceFile),
    };
  }
  if (ts.isExportAssignment(statement)) {
    return { ...base, kind: STATEMENT_KINDS.EXPORT_ASSIGNMENT };
  }
  if (ts.isEmptyStatement(statement)) {
    return { ...base, kind: STATEMENT_KINDS.EMPTY };
  }
  return { ...base, kind: STATEMENT_KINDS.OTHER };
}

function declarationKindOf(statement) {
  if (ts.isInterfaceDeclaration(statement)) return DECLARATION_KINDS.INTERFACE;
  if (ts.isTypeAliasDeclaration(statement)) return DECLARATION_KINDS.TYPE_ALIAS;
  if (ts.isClassDeclaration(statement)) return DECLARATION_KINDS.CLASS;
  if (ts.isFunctionDeclaration(statement)) return DECLARATION_KINDS.FUNCTION;
  if (ts.isVariableStatement(statement)) return DECLARATION_KINDS.VARIABLE;
  if (ts.isEnumDeclaration(statement)) return DECLARATION_KINDS.ENUM;
  if (ts.isModuleDeclaration(statement)) return DECLARATION_KINDS.MODULE;
  return undefined;
}

function declarationNameOf(statement) {
  return statement.name?.text;
}

function hasExportModifier(statement) {
  return (
    statement.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    ) ?? false
  );
}

function isTypeOnlyImport(statement) {
  const clause = statement.importClause;
  if (clause === undefined) return false;
  if (clause.isTypeOnly) return true;
  // `import { type A, type B } from '...'` 语法上不是整体 type-only，但语义上是；
  // 目录约定把这种写法等同于 type-only import。
  return (
    clause.name === undefined &&
    clause.namedBindings !== undefined &&
    ts.isNamedImports(clause.namedBindings) &&
    clause.namedBindings.elements.length > 0 &&
    clause.namedBindings.elements.every((element) => element.isTypeOnly)
  );
}

function isTypeOnlyExport(statement) {
  if (statement.isTypeOnly) return true;
  return (
    statement.exportClause !== undefined &&
    ts.isNamedExports(statement.exportClause) &&
    statement.exportClause.elements.length > 0 &&
    statement.exportClause.elements.every((element) => element.isTypeOnly)
  );
}

function implementsTypeNames(statement, sourceFile) {
  if (!ts.isClassDeclaration(statement)) return [];
  const clauses =
    statement.heritageClauses?.filter(
      (clause) => clause.token === ts.SyntaxKind.ImplementsKeyword,
    ) ?? [];
  return clauses.flatMap((clause) =>
    clause.types.map((typeNode) => typeNode.getText(sourceFile)),
  );
}

function resolveAliasedSymbol(checker, initialSymbol) {
  let symbol = initialSymbol;
  const visited = new Set();
  while (
    symbol !== undefined &&
    (symbol.flags & ts.SymbolFlags.Alias) !== 0 &&
    !visited.has(symbol)
  ) {
    visited.add(symbol);
    symbol = checker.getAliasedSymbol(symbol);
  }
  return symbol;
}

/**
 * 用内存源码构造 program，服务于门禁的夹具自测。
 *
 * 复刻改造前 `check-architecture.mjs` 自建 host 的行为：内存命中优先，未命中回落到
 * 磁盘（lib 文件、`@types`），相对模块说明符按 `.js → .ts`、`.ts`、`index.ts`
 * 的候选顺序在内存里解析，其余交给编译器默认解析。
 */
function createInMemoryProgram(rootNames, sources) {
  const options = { ...PROGRAM_OPTIONS };
  const defaultHost = ts.createCompilerHost(options, true);
  const host = {
    ...defaultHost,
    fileExists: (fileName) =>
      sources.has(path.resolve(fileName)) || defaultHost.fileExists(fileName),
    readFile: (fileName) =>
      sources.get(path.resolve(fileName)) ?? defaultHost.readFile(fileName),
    getSourceFile: (fileName, languageVersion) => {
      const source = sources.get(path.resolve(fileName));
      return source === undefined
        ? defaultHost.getSourceFile(fileName, languageVersion)
        : ts.createSourceFile(
            fileName,
            source,
            languageVersion,
            true,
            ts.ScriptKind.TS,
          );
    },
    resolveModuleNames: (moduleNames, containingFile) =>
      moduleNames.map((moduleName) => {
        if (moduleName.startsWith(".")) {
          const unresolved = path.resolve(
            path.dirname(containingFile),
            moduleName,
          );
          const candidates = [
            unresolved.replace(/\.js$/u, ".ts"),
            `${unresolved}.ts`,
            path.join(unresolved, "index.ts"),
          ];
          const resolvedFileName = candidates.find((candidate) =>
            sources.has(candidate),
          );
          if (resolvedFileName !== undefined) {
            return { resolvedFileName, extension: ts.Extension.Ts };
          }
        }
        return ts.resolveModuleName(moduleName, containingFile, options, host)
          .resolvedModule;
      }),
  };
  return ts.createProgram({ rootNames, options, host });
}
