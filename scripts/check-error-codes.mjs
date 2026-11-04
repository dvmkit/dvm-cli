#!/usr/bin/env node
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const repository = resolve(import.meta.dirname, "..");
// Recursive decorators can grow property paths forever; require classification
// when the projection exceeds the bounded analysis instead of guessing a code.
const MAX_PROJECTION_DEPTH = 16;

export function discoverErrorCodes(sourceRoot, relays = []) {
  sourceRoot = resolve(sourceRoot);
  for (const entry of relays) {
    if (!entry || ![entry.file, entry.owner, entry.expression, entry.reason].every((value) => typeof value === "string" && value.trim()) ||
      !Array.isArray(entry.path) || entry.path.some((value) => typeof value !== "string") ||
      (entry.alsoPaths && (!Array.isArray(entry.alsoPaths) || entry.alsoPaths.some((path) => !Array.isArray(path) || path.some((value) => typeof value !== "string")))) ||
      (entry.argument !== undefined && (!Number.isSafeInteger(entry.argument) || entry.argument < 0))) {
      throw new Error("Source classifications require file, owner, expression, path, and a reason; argument indexes must be non-negative integers.");
    }
    if (entry.argument !== undefined && (!entry.guard || !/^[a-f0-9]{64}$/u.test(entry.guard.sha256))) {
      throw new Error("An argument-flow classification requires a reviewed local function guard.");
    }
    if (entry.callee && entry.argument === undefined) throw new Error("A callee classification must declare its guarded argument flow.");
  }
  const files = productionFiles(sourceRoot);
  const fileNames = new Set(files.map((file) => resolve(file)));
  const program = ts.createProgram(files, {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    skipLibCheck: true,
    noResolve: true,
    lib: ["lib.es2024.d.ts"],
    types: [],
  });
  const checker = program.getTypeChecker();
  const sources = program.getSourceFiles().filter((file) => fileNames.has(resolve(file.fileName)));
  for (const source of sources) {
    if (source.parseDiagnostics.length) throw new Error(`Cannot parse production source: ${relative(sourceRoot, source.fileName)}`);
  }
  const calls = new Map();
  const assignments = new Map();
  const propertyWrites = new Map();
  const codes = new Set();
  const families = new Set();
  const unresolved = new Set();
  const usedRelays = new Set();
  const active = new Map();
  const visited = new Map();

  function symbol(node) {
    let value = checker.getSymbolAtLocation(node);
    if (value?.flags & ts.SymbolFlags.Alias) value = checker.getAliasedSymbol(value);
    return value;
  }

  function owner(node) {
    for (let current = node.parent; current; current = current.parent) {
      if (ts.isFunctionLike(current)) {
        if (current.name) return current.name.getText();
        if (ts.isVariableDeclaration(current.parent)) return current.parent.name.getText();
      }
    }
    return "<module>";
  }

  function site(node) {
    return {
      file: relative(sourceRoot, node.getSourceFile().fileName).replaceAll("\\", "/"),
      owner: owner(node),
      expression: node.getText().replaceAll("\r\n", "\n"),
    };
  }

  function relay(node, path) {
    const location = site(node);
    const index = relays.findIndex((entry) => [entry.path, ...(entry.alsoPaths ?? [])].some((projection) => JSON.stringify(projection) === JSON.stringify(path)) &&
      (entry.callee
        ? ts.isCallExpression(node) && functionFor(node.expression) === localFunction(entry.guard)
        : entry.file === location.file && entry.owner === location.owner && entry.expression === location.expression));
    if (index < 0) return false;
    const entry = relays[index];
    if (entry.argument === undefined && !entry.local) {
      if (ts.isStringLiteralLike(node)) return false;
      if (ts.isIdentifier(node) && symbol(node)?.declarations?.some((declaration) =>
        ts.isVariableDeclaration(declaration) && (declaration.initializer || assignments.get(symbol(node))?.length))) return false;
      if (ts.isCallExpression(node)) {
        const declaration = functionFor(node.expression);
        if (declaration?.body && fileNames.has(resolve(declaration.getSourceFile().fileName))) return false;
      }
    }
    usedRelays.add(index);
    if (entry.argument !== undefined) {
      const definition = localFunction(entry.guard);
      const sha256 = createHash("sha256").update(definition.getText().replaceAll("\r\n", "\n")).digest("hex");
      if (sha256 !== entry.guard.sha256) throw new Error(`Classified local flow changed: ${entry.guard.file}#${entry.guard.name}. Review the flow before updating its guard.`);
      if (!ts.isCallExpression(node) || !node.arguments[entry.argument]) throw new Error("Invalid argument-flow classification.");
      evaluate(node.arguments[entry.argument], path);
    }
    if (entry.local) {
      const declaration = localFunction(entry.local);
      walkReturns(declaration.body, (value) => evaluate(value, path));
    }
    return true;
  }

  function localFunction(target) {
    const source = sources.find((entry) => relative(sourceRoot, entry.fileName).replaceAll("\\", "/") === target.file);
    const declaration = source?.statements.find((entry) => ts.isFunctionDeclaration(entry) && entry.name?.text === target.name);
    if (!declaration?.body) throw new Error("Missing classified local result function.");
    return declaration;
  }

  function unknown(node, path) {
    const location = site(node);
    unresolved.add(JSON.stringify({ ...location, ...(path.length ? { path } : {}) }));
  }

  function functionFor(node) {
    return symbol(node)?.declarations?.find((declaration) => ts.isFunctionLike(declaration) && declaration.body) ??
      symbol(node)?.declarations?.find(ts.isVariableDeclaration)?.initializer;
  }

  function propertyName(name) {
    if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text;
    if (ts.isComputedPropertyName(name)) {
      const type = checker.getTypeAtLocation(name.expression);
      if (type.flags & ts.TypeFlags.StringLiteral) return type.value;
    }
    return undefined;
  }

  function literalKeys(node, seen = new Set()) {
    if (!node || seen.has(node)) return undefined;
    seen.add(node);
    if (ts.isStringLiteralLike(node)) return [node.text];
    if (ts.isAsExpression(node) || ts.isParenthesizedExpression(node)) return literalKeys(node.expression, seen);
    if (ts.isArrayLiteralExpression(node)) {
      const keys = node.elements.map((element) => literalKeys(element, new Set(seen)));
      return keys.every((key) => key !== undefined) ? keys.flat() : undefined;
    }
    if (ts.isIdentifier(node)) {
      const declaration = symbol(node)?.declarations?.[0];
      if (declaration && ts.isVariableDeclaration(declaration)) {
        const loop = declaration.parent.parent;
        const values = [declaration.initializer ?? (ts.isForOfStatement(loop) ? loop.expression : undefined), ...(assignments.get(symbol(node)) ?? [])].filter(Boolean);
        if (!values.length) return undefined;
        const keys = values.map((value) => literalKeys(value, new Set(seen)));
        return keys.every((key) => key !== undefined) ? keys.flat() : undefined;
      }
      if (declaration && ts.isParameter(declaration)) {
        const index = declaration.parent.parameters.indexOf(declaration);
        const callers = calls.get(declaration.parent) ?? [];
        if (!callers.length) return undefined;
        const keys = callers.map((call) => literalKeys(call.arguments?.[index] ?? declaration.initializer, new Set(seen)));
        return keys.every((key) => key !== undefined) ? keys.flat() : undefined;
      }
    }
    return undefined;
  }

  function objectOrigins(node, seen = new Set()) {
    if (!node || seen.has(node)) return [];
    seen.add(node);
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node)) {
      return objectOrigins(node.expression, seen);
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const keys = ts.isPropertyAccessExpression(node) ? [node.name.text] : literalKeys(node.argumentExpression) ?? ["*"];
      return objectOrigins(node.expression, seen).flatMap((origin) => keys.map((key) => ({ root: origin.root, path: [...origin.path, key] })));
    }
    if (ts.isIdentifier(node)) {
      const target = symbol(node);
      const origins = target ? [{ root: target, path: [] }] : [];
      for (const declaration of target?.declarations ?? []) {
        if (ts.isVariableDeclaration(declaration)) {
          for (const value of [declaration.initializer, ...(assignments.get(target) ?? [])]) {
            origins.push(...objectOrigins(value, new Set(seen)));
          }
        } else if (ts.isParameter(declaration)) {
          const index = declaration.parent.parameters.indexOf(declaration);
          for (const call of calls.get(declaration.parent) ?? []) {
            origins.push(...objectOrigins(call.arguments?.[index] ?? declaration.initializer, new Set(seen)));
          }
        } else if (ts.isBindingElement(declaration) && !declaration.dotDotDotToken && ts.isObjectBindingPattern(declaration.parent)) {
          const parent = declaration.parent.parent;
          const key = propertyName(declaration.propertyName ?? declaration.name) ?? "*";
          if (ts.isVariableDeclaration(parent)) {
            origins.push(...objectOrigins(parent.initializer, new Set(seen)).map((origin) => ({ root: origin.root, path: [...origin.path, key] })));
          }
        }
      }
      return origins;
    }
    if (ts.isCallExpression(node)) {
      const declaration = functionFor(node.expression);
      if (declaration?.body && fileNames.has(resolve(declaration.getSourceFile().fileName))) {
        const origins = [];
        if (ts.isBlock(declaration.body)) walkReturns(declaration.body, (value) => origins.push(...objectOrigins(value, new Set(seen))));
        else origins.push(...objectOrigins(declaration.body, seen));
        return origins;
      }
    }
    return [{ root: node, path: [] }];
  }

  function recordPropertyWrite(target, value, node, supported, keys = []) {
    for (const origin of objectOrigins(target)) {
      const entries = propertyWrites.get(origin.root) ?? [];
      entries.push({ path: [...origin.path, ...keys], value, node, supported });
      propertyWrites.set(origin.root, entries);
    }
  }

  for (const source of sources) walk(source, (node) => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left)) {
      const target = symbol(node.left);
      const values = assignments.get(target) ?? [];
      values.push(node.right);
      assignments.set(target, values);
    }
    if (!ts.isCallExpression(node) && !ts.isNewExpression(node)) return;
    const declaration = ts.isNewExpression(node)
      ? symbol(node.expression)?.declarations?.find(ts.isClassDeclaration)?.members.find(ts.isConstructorDeclaration)
      : functionFor(node.expression);
    if (declaration && ts.isFunctionLike(declaration)) {
      const entries = calls.get(declaration) ?? [];
      entries.push(node);
      calls.set(declaration, entries);
    }
  });

  // Index after calls and identifier assignments so aliases and helper
  // parameters refer to the same possible objects as the serialized value.
  for (const source of sources) walk(source, (node) => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      (ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left))) {
      recordPropertyWrite(node.left, node.right, node, node.operatorToken.kind === ts.SyntaxKind.EqualsToken);
    }
    if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator) &&
      (ts.isPropertyAccessExpression(node.operand) || ts.isElementAccessExpression(node.operand))) {
      recordPropertyWrite(node.operand, undefined, node, false);
    }
    if (ts.isCallExpression(node) && node.expression.getText() === "Object.assign") {
      for (const value of node.arguments.slice(1)) recordPropertyWrite(node.arguments[0], value, node, true);
    }
    if (ts.isCallExpression(node) && ["Object.defineProperty", "Reflect.defineProperty", "Reflect.set"].includes(node.expression.getText())) {
      for (const key of literalKeys(node.arguments[1]) ?? ["*"]) {
        recordPropertyWrite(node.arguments[0], undefined, node, false, [key]);
      }
    }
    if (ts.isCallExpression(node) && node.expression.getText() === "Object.defineProperties") {
      recordPropertyWrite(node.arguments[0], undefined, node, false);
    }
  });

  function evaluatePropertyWrites(node, path) {
    if (!path.length) return;
    for (const origin of objectOrigins(node)) {
      const projection = [...origin.path, ...path];
      for (const write of propertyWrites.get(origin.root) ?? []) {
        const common = Math.min(projection.length, write.path.length);
        if (!write.path.slice(0, common).every((part, index) => part === projection[index] || part === "*" || projection[index] === "*")) continue;
        if (!write.supported || write.path.includes("*") || write.path.length > projection.length) unknown(write.node, path);
        else evaluate(write.value, projection.slice(write.path.length));
      }
    }
  }

  function evaluate(node, path = []) {
    if (!node) return;
    const key = JSON.stringify(path);
    if (visited.get(node)?.has(key)) return;
    if (path.length > MAX_PROJECTION_DEPTH) return unknown(node, path);
    const paths = active.get(node) ?? new Set();
    if (paths.has(key)) return;
    paths.add(key);
    active.set(node, paths);
    try {
      evaluatePropertyWrites(node, path);
      if (path.length && checker.getTypeAtLocation(node).flags & (ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike)) return;
      if (relay(node, path)) return;
      if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) ||
        ts.isSatisfiesExpression(node) || ts.isTypeAssertionExpression(node) || ts.isAwaitExpression(node)) {
        return evaluate(node.expression, path);
      }
      if (ts.isStringLiteralLike(node) && path.length === 0) {
        codes.add(node.text);
        return;
      }
      if (node.kind === ts.SyntaxKind.NullKeyword || node.kind === ts.SyntaxKind.UndefinedKeyword ||
        (ts.isIdentifier(node) && node.text === "undefined")) return;
      if (ts.isConditionalExpression(node)) {
        evaluate(node.whenTrue, path);
        evaluate(node.whenFalse, path);
        return;
      }
      if (ts.isBinaryExpression(node) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(node.operatorToken.kind)) {
        evaluate(node.left, path);
        evaluate(node.right, path);
        return;
      }
      if (ts.isPropertyAccessExpression(node)) return evaluate(node.expression, [node.name.text, ...path]);
      if (ts.isElementAccessExpression(node)) {
        const argument = node.argumentExpression;
        const name = argument && ts.isStringLiteralLike(argument) ? argument.text : "*";
        return evaluate(node.expression, [name, ...path]);
      }
      if (ts.isObjectLiteralExpression(node) && path.length) {
        const [head, ...rest] = path;
        for (const property of node.properties) {
          if (ts.isSpreadAssignment(property)) evaluate(property.expression, path);
          else if (property.name) {
            const names = ts.isComputedPropertyName(property.name) ? literalKeys(property.name.expression) : [propertyName(property.name)];
            if (head !== "*" && !names) {
              unknown(property.name, path);
              continue;
            }
            if (head !== "*" && !names.includes(head)) continue;
            if (ts.isPropertyAssignment(property)) evaluate(property.initializer, rest);
            else if (ts.isShorthandPropertyAssignment(property)) {
              const target = checker.getShorthandAssignmentValueSymbol(property);
              for (const declaration of target?.declarations ?? []) evaluate(declaration.name, rest);
            } else unknown(property, rest);
          }
        }
        return;
      }
      if (ts.isArrayLiteralExpression(node) && path[0] === "*") {
        for (const element of node.elements) evaluate(element, path.slice(1));
        return;
      }
      if (ts.isIdentifier(node)) {
        const declarations = symbol(node)?.declarations ?? [];
        if (!declarations.length) return unknown(node, path);
        for (const declaration of declarations) evaluateDeclaration(declaration, path);
        return;
      }
      if (ts.isCallExpression(node)) {
        if (ts.isPropertyAccessExpression(node.expression)) {
          const method = node.expression.name.text;
          if (node.expression.expression.getText() === "Promise" && method === "all") return evaluate(node.arguments[0], path);
          if (node.expression.expression.getText() === "Promise" && method === "allSettled" && path[0] === "*" && path[1] === "value") {
            return evaluate(node.arguments[0], ["*", ...path.slice(2)]);
          }
          if (method === "map" && path[0] === "*") {
            const callback = node.arguments[0];
            if (callback && ts.isArrowFunction(callback)) {
              if (ts.isBlock(callback.body)) walkReturns(callback.body, (value) => evaluate(value, path.slice(1)));
              else evaluate(callback.body, path.slice(1));
              return;
            }
          }
          if (method === "catch") {
            evaluate(node.expression.expression, path);
            const handler = node.arguments[0];
            if (handler && ts.isArrowFunction(handler)) {
              if (ts.isBlock(handler.body)) walkReturns(handler.body, (value) => evaluate(value, path));
              else evaluate(handler.body, path);
            } else unknown(node, path);
            return;
          }
          if (method === "find") return evaluate(node.expression.expression, ["*", ...path]);
        }
        const imports = checker.getSymbolAtLocation(node.expression)?.declarations ?? [];
        if (imports.some((declaration) => ts.isImportSpecifier(declaration) &&
          ["withWalletLock", "withTempoChannelLock", "withX402ChannelLock", "withNwcPool"].includes((declaration.propertyName ?? declaration.name).text) &&
          declaration.parent.parent.parent.moduleSpecifier.text === "@dvmkit/sdk/internal")) {
          const callbackIndex = imports.some((declaration) => (declaration.propertyName ?? declaration.name)?.text === "withNwcPool") ? 1 : 0;
          const callback = node.arguments[callbackIndex];
          if (callback && ts.isArrowFunction(callback)) {
            if (ts.isBlock(callback.body)) walkReturns(callback.body, (value) => evaluate(value, path));
            else evaluate(callback.body, path);
            return;
          }
        }
        const declaration = functionFor(node.expression);
        if (declaration && ts.isFunctionLike(declaration) && declaration.body && fileNames.has(resolve(declaration.getSourceFile().fileName))) {
          if (!ts.isBlock(declaration.body)) evaluate(declaration.body, path);
          else walkReturns(declaration.body, (value) => evaluate(value, path));
          return;
        }
      }
      if (ts.isNewExpression(node) && path[0] === "code" && isDvmError(node.expression)) {
        return evaluate(node.arguments?.[0], path.slice(1));
      }
      if (ts.isNewExpression(node) && path[0] === "data" && isDvmError(node.expression)) {
        return evaluate(node.arguments?.[3], path.slice(1));
      }
      if (ts.isNewExpression(node) && (path[0] === "code" || path[0] === "data")) {
        const declaration = symbol(node.expression)?.declarations?.find(ts.isClassDeclaration);
        if (declaration?.heritageClauses?.some((clause) => clause.types.some((type) => isDvmError(type.expression)))) {
          evaluateSuperCodes(declaration, path.slice(1), path[0] === "code" ? 0 : 3);
          return;
        }
      }
      if (ts.isTemplateExpression(node) && path.length === 0 && node.head.text === "http_" &&
        node.templateSpans.length === 1 && node.templateSpans[0].literal.text === "" &&
        node.templateSpans[0].expression.getText() === "status.toString()" &&
        checker.getTypeAtLocation(node.templateSpans[0].expression.expression.expression).flags & ts.TypeFlags.Number) {
        families.add("http_${number}");
        return;
      }
      unknown(node, path);
    } finally {
      paths.delete(key);
      const completed = visited.get(node) ?? new Set();
      completed.add(key);
      visited.set(node, completed);
    }
  }

  function evaluateDeclaration(declaration, path) {
    if (!fileNames.has(resolve(declaration.getSourceFile().fileName))) return unknown(declaration.name ?? declaration, path);
    if (ts.isVariableDeclaration(declaration)) {
      const writes = assignments.get(symbol(declaration.name)) ?? [];
      if (declaration.initializer || writes.length) {
        evaluate(declaration.initializer, path);
        for (const value of writes) evaluate(value, path);
        return;
      }
    }
    if (ts.isParameter(declaration)) {
      const fn = declaration.parent;
      const index = fn.parameters.indexOf(declaration);
      const callers = calls.get(fn) ?? [];
      if (!callers.length) {
        const type = checker.getTypeAtLocation(declaration);
        if (path.length && path[0] !== "*" && type.flags & ts.TypeFlags.Object &&
          !type.getProperty(path[0]) && !type.getStringIndexType()) return;
        return unknown(declaration.name, path);
      }
      for (const call of callers) evaluate(call.arguments?.[index] ?? declaration.initializer, path);
      return;
    }
    if (ts.isBindingElement(declaration) && ts.isObjectBindingPattern(declaration.parent)) {
      const parent = declaration.parent.parent;
      const property = (declaration.propertyName ?? declaration.name).getText();
      if (ts.isVariableDeclaration(parent)) return evaluate(parent.initializer, [property, ...path]);
    }
    unknown(declaration.name ?? declaration, path);
  }

  function isDvmError(expression, seen = new Set()) {
    // Resolve aliases through the actual import, without scanning dependency source.
    if (seen.has(expression)) return false;
    seen.add(expression);
    if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression)) return isDvmError(expression.expression, seen);
    if (ts.isPropertyAccessExpression(expression) && expression.name.text === "DvmError") {
      return checker.getSymbolAtLocation(expression.expression)?.declarations?.some((declaration) =>
        ts.isNamespaceImport(declaration) && declaration.parent.parent.moduleSpecifier.text === "@dvmkit/sdk/internal") ?? false;
    }
    const declarations = checker.getSymbolAtLocation(expression)?.declarations ?? [];
    return declarations.some((declaration) =>
      (ts.isImportSpecifier(declaration) && (declaration.propertyName ?? declaration.name).text === "DvmError" &&
        declaration.parent.parent.parent.moduleSpecifier.text === "@dvmkit/sdk/internal") ||
      (ts.isVariableDeclaration(declaration) && declaration.initializer && isDvmError(declaration.initializer, seen)));
  }

  function evaluateSuperCodes(declaration, path = [], argument = 0) {
    for (const member of declaration.members) {
      if (ts.isConstructorDeclaration(member) && member.body) walk(member.body, (child) => {
        if (ts.isCallExpression(child) && child.expression.kind === ts.SyntaxKind.SuperKeyword) {
          evaluate(child.arguments[argument], path);
        }
      });
    }
  }

  for (const source of sources) walk(source, (node) => {
    if (ts.isNewExpression(node) && isDvmError(node.expression)) {
      evaluate(node.arguments?.[0]);
      // The JSON boundary spreads data last, so a local data.code is authored
      // output even when it overrides the positional constructor code.
      evaluate(node.arguments?.[3], ["code"]);
    }
    if (ts.isClassDeclaration(node) && node.heritageClauses?.some((clause) =>
      clause.types.some((type) => isDvmError(type.expression)))) {
      evaluateSuperCodes(node);
      evaluateSuperCodes(node, ["code"], 3);
    }
    if (ts.isPropertyAssignment(node) && propertyName(node.name) === "error") {
      evaluate(node.initializer, ["code"]);
    }
    if (ts.isShorthandPropertyAssignment(node) && node.name.text === "error") {
      const target = checker.getShorthandAssignmentValueSymbol(node);
      for (const declaration of target?.declarations ?? []) evaluate(declaration.name, ["code"]);
    }
  });

  for (let index = 0; index < relays.length; index++) {
    if (!usedRelays.has(index)) unresolved.add(`Unused relay classification: ${JSON.stringify(relays[index])}`);
  }
  if (unresolved.size) throw new Error(`Unclassified error-code sources (classify relays explicitly; trace local values):\n${[...unresolved].sort().join("\n")}`);
  return { codes: [...codes].sort(), families: [...families].sort() };
}

function productionFiles(root) {
  return readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) => {
    if (["node_modules", "__tests__", "test", "tests", "test-support", "fixtures", "__fixtures__"].includes(entry.name)) return [];
    const path = join(root, entry.name);
    if (entry.isDirectory()) return productionFiles(path);
    return entry.isFile() && /\.[cm]?tsx?$/u.test(entry.name) && !/\.(?:test|spec|d)\.[cm]?tsx?$/u.test(entry.name) ? [path] : [];
  });
}

function walk(node, visit) {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

function walkReturns(node, visit) {
  if (ts.isReturnStatement(node)) visit(node.expression);
  else if (!ts.isFunctionLike(node)) ts.forEachChild(node, (child) => walkReturns(child, visit));
}

function checkInventory(discovered, inventory, update = false) {
  for (const field of ["codes", "families"]) {
    const entries = inventory[field];
    if (!Array.isArray(entries) || entries.some((entry) => typeof entry !== "string" || !entry) ||
      JSON.stringify(entries) !== JSON.stringify([...new Set(entries)].sort())) {
      throw new Error(`Inventory ${field} must be a sorted array of unique non-empty strings.`);
    }
    const removed = entries.filter((entry) => !discovered[field].includes(entry));
    if (removed.length) throw new Error(`Removed or renamed CLI error ${field}: ${removed.join(", ")}. Restore the source; the additive update cannot remove compatibility promises.`);
    const added = discovered[field].filter((entry) => !entries.includes(entry));
    if (added.length && !update) throw new Error(`Unlisted CLI error ${field}: ${added.join(", ")}. Run node scripts/pinned-npm.mjs run update:error-codes and commit the inventory.`);
  }
  return discovered;
}

function main() {
  const args = process.argv.slice(2);
  let sourceRoot = join(repository, "src");
  let inventoryPath = join(repository, "cli-error-codes.json");
  let relayPath = join(repository, "scripts/error-code-relays.json");
  let update = false;
  while (args.length) {
    const argument = args.shift();
    if (argument === "--update") update = true;
    else if (["--source", "--inventory", "--relays"].includes(argument) && args[0] && !args[0].startsWith("--")) {
      const value = resolve(args.shift());
      if (argument === "--source") sourceRoot = value;
      if (argument === "--inventory") inventoryPath = value;
      if (argument === "--relays") relayPath = value;
    } else throw new Error(`Unknown or incomplete argument: ${argument}`);
  }
  const discovered = discoverErrorCodes(sourceRoot, JSON.parse(readFileSync(relayPath, "utf8")));
  const inventory = JSON.parse(readFileSync(inventoryPath, "utf8"));
  checkInventory(discovered, inventory, update);
  if (update) writeFileSync(inventoryPath, `${JSON.stringify(discovered, null, 2)}\n`);
  console.log(`CLI error codes: ${discovered.codes.length} codes and ${discovered.families.length} dynamic families checked${update ? " and inventory updated" : ""}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`CLI error codes: ${error.message}`);
    process.exitCode = 1;
  }
}
