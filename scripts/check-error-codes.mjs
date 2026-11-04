#!/usr/bin/env node
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const repository = resolve(import.meta.dirname, "..");

export function discoverErrorCodes(sourceRoot, relays = []) {
  sourceRoot = resolve(sourceRoot);
  for (const entry of relays) {
    if (!entry || ![entry.file, entry.owner, entry.expression, entry.reason].every((value) => typeof value === "string" && value.trim()) ||
      !Array.isArray(entry.path) || entry.path.some((value) => typeof value !== "string") ||
      (entry.argument !== undefined && (!Number.isSafeInteger(entry.argument) || entry.argument < 0))) {
      throw new Error("Source classifications require file, owner, expression, path, and a reason; argument indexes must be non-negative integers.");
    }
    if (entry.argument !== undefined && (!entry.guard || !/^[a-f0-9]{64}$/u.test(entry.guard.sha256))) {
      throw new Error("An argument-flow classification requires a reviewed local function guard.");
    }
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
  const codes = new Set();
  const families = new Set();
  const unresolved = new Set();
  const usedRelays = new Set();
  const active = new Map();

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
    const index = relays.findIndex((entry) => entry.file === location.file && entry.owner === location.owner &&
      entry.expression === location.expression && JSON.stringify(entry.path ?? []) === JSON.stringify(path));
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

  for (const source of sources) walk(source, (node) => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left)) {
      const target = symbol(node.left);
      const values = assignments.get(target) ?? [];
      values.push(node.right);
      assignments.set(target, values);
    }
    if (!ts.isCallExpression(node)) return;
    const declaration = functionFor(node.expression);
    if (declaration && ts.isFunctionLike(declaration)) {
      const entries = calls.get(declaration) ?? [];
      entries.push(node);
      calls.set(declaration, entries);
    }
  });

  function evaluate(node, path = []) {
    if (!node) return;
    const key = JSON.stringify(path);
    const paths = active.get(node) ?? new Set();
    if (paths.has(key)) return;
    paths.add(key);
    active.set(node, paths);
    try {
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
          else if (property.name && (head === "*" || propertyName(property.name) === head ||
            (ts.isComputedPropertyName(property.name) && propertyName(property.name) === undefined))) {
            if (ts.isPropertyAssignment(property)) evaluate(property.initializer, rest);
            else if (ts.isShorthandPropertyAssignment(property)) {
              const target = checker.getShorthandAssignmentValueSymbol(property);
              for (const declaration of target?.declarations ?? []) evaluateDeclaration(declaration, rest);
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
      if (ts.isNewExpression(node) && path[0] === "code") {
        const declaration = symbol(node.expression)?.declarations?.find(ts.isClassDeclaration);
        if (declaration?.heritageClauses?.some((clause) => clause.types.some((type) => isDvmError(type.expression)))) {
          evaluateSuperCodes(declaration, path.slice(1));
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
      for (const call of callers) evaluate(call.arguments[index] ?? declaration.initializer, path);
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

  function evaluateSuperCodes(declaration, path = []) {
    for (const member of declaration.members) {
      if (ts.isConstructorDeclaration(member) && member.body) walk(member.body, (child) => {
        if (ts.isCallExpression(child) && child.expression.kind === ts.SyntaxKind.SuperKeyword) evaluate(child.arguments[0], path);
      });
    }
  }

  for (const source of sources) walk(source, (node) => {
    if (ts.isNewExpression(node) && isDvmError(node.expression)) evaluate(node.arguments?.[0]);
    if (ts.isClassDeclaration(node) && node.heritageClauses?.some((clause) =>
      clause.types.some((type) => isDvmError(type.expression)))) evaluateSuperCodes(node);
    if (ts.isPropertyAssignment(node) && propertyName(node.name) === "error") {
      evaluate(node.initializer, ["code"]);
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
