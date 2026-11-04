import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverErrorCodes, type ErrorCodeInventory, type ErrorCodeSource } from "../scripts/check-error-codes.mjs";

const script = resolve(import.meta.dirname, "../scripts/check-error-codes.mjs");
const roots: string[] = [];
const importError = 'import { DvmError } from "@dvmkit/sdk/internal";\n';
const promised: ErrorCodeInventory = { codes: ["internal", "invalid_input"], families: [] };
const original = `${importError}throw new DvmError("invalid_input", "Invalid");\njson({error: {code: "internal", message: "Unexpected"}});`;

function fixture(source = original, inventory = promised, relays: ErrorCodeSource[] = []) {
  const root = mkdtempSync(join(tmpdir(), "cli-error-contract-"));
  roots.push(root);
  const sourceRoot = join(root, "src");
  mkdirSync(sourceRoot);
  const sourcePath = join(sourceRoot, "command.ts");
  const inventoryPath = join(root, "inventory.json");
  const relayPath = join(root, "relays.json");
  writeFileSync(sourcePath, source);
  writeFileSync(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`);
  writeFileSync(relayPath, JSON.stringify(relays));
  return {
    sourceRoot, sourcePath, inventoryPath,
    run(...args: string[]) {
      const result = spawnSync(process.execPath, [script, "--source", sourceRoot, "--inventory", inventoryPath, "--relays", relayPath, ...args], {
        encoding: "utf8", timeout: 10_000,
      });
      if (result.error) throw result.error;
      return { status: result.status, output: result.stdout + result.stderr };
    },
    inventory() { return readFileSync(inventoryPath, "utf8"); },
    write(path: string, content: string) {
      const file = join(sourceRoot, path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content);
    },
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("CLI error compatibility check", () => {
  it("checks an independent baseline without rewriting it", () => {
    const tree = fixture();
    const before = tree.inventory();
    expect(tree.run()).toMatchObject({ status: 0 });
    expect(tree.inventory()).toBe(before);
  });

  it.each([
    ["removed", original.replace('throw new DvmError("invalid_input", "Invalid");', "")],
    ["renamed", original.replace('"invalid_input"', '"input_rejected"')],
    ["fallback removed", original.replace('json({error: {code: "internal", message: "Unexpected"}});', "")],
  ])("rejects a %s code in check and update modes without erasing the promise", (_name, source) => {
    const tree = fixture(source);
    const before = tree.inventory();
    for (const mode of [[], ["--update"]]) {
      const result = tree.run(...mode);
      expect(result.status).toBe(1);
      expect(result.output).toContain("Removed or renamed CLI error codes:");
      expect(tree.inventory()).toBe(before);
    }
  });

  it("rejects an unlisted addition, then accepts an additive, deterministic update", () => {
    const tree = fixture(`${original}\nthrow new DvmError("new_failure", "New");`);
    const before = tree.inventory();
    const rejected = tree.run();
    expect(rejected.status).toBe(1);
    expect(rejected.output).toContain("Unlisted CLI error codes: new_failure");
    expect(rejected.output).toContain("run update:error-codes");
    expect(tree.inventory()).toBe(before);
    expect(tree.run("--update").status).toBe(0);
    expect(JSON.parse(tree.inventory())).toEqual({ codes: ["internal", "invalid_input", "new_failure"], families: [] });
    expect(tree.run().status).toBe(0);
    const extended = tree.inventory();
    expect(tree.run("--update").status).toBe(0);
    expect(tree.inventory()).toBe(extended);
  });

  it("refuses update if an addition accompanies a removal", () => {
    const tree = fixture(original.replace('"invalid_input"', '"new_failure"'));
    const before = tree.inventory();
    expect(tree.run("--update").status).toBe(1);
    expect(tree.inventory()).toBe(before);
  });

  it.each([
    ["shorthand envelope", 'const error = {code: "new_failure", message: "Failure"}; json({error});'],
    ["property override", 'const data: Record<string, unknown> = {}; data.code = "new_failure"; new DvmError("invalid_input", "Failure", undefined, data);'],
    ["computed property override", 'const data: Record<string, unknown> = {}; const key = "code"; data[key] = "new_failure"; new DvmError("invalid_input", "Failure", undefined, data);'],
    ["aliased property override", 'const data: Record<string, unknown> = {}; const alias = data; alias.code = "new_failure"; new DvmError("invalid_input", "Failure", undefined, data);'],
    ["nested property override", 'const holder = {data: {}}; holder.data["code"] = "new_failure"; new DvmError("invalid_input", "Failure", undefined, holder.data);'],
    ["helper property override", 'const data = {}; function setCode(target: Record<string, unknown>) { target.code = "new_failure"; } setCode(data); new DvmError("invalid_input", "Failure", undefined, data);'],
    ["assigned property override", 'const data = {}; Object.assign(data, {code: "new_failure"}); new DvmError("invalid_input", "Failure", undefined, data);'],
    ["loop-selected property override", 'const data: Record<string, unknown> = {}; for (const key of ["code", "hint"] as const) data[key] = "new_failure"; new DvmError("invalid_input", "Failure", undefined, data);'],
    ["reassigned key override", 'const data: Record<string, unknown> = {}; let key = "hint"; key = "code"; data[key] = "new_failure"; new DvmError("invalid_input", "Failure", undefined, data);'],
    ["destructured alias override", 'const holder = {data: {}}; const {data: alias} = holder; alias.code = "new_failure"; new DvmError("invalid_input", "Failure", undefined, holder.data);'],
    ["stored shorthand alias override", 'const data: Record<string, unknown> = {}; const holder = {data}; holder.data.code = "new_failure"; new DvmError("invalid_input", "Failure", undefined, data);'],
    ["stored named alias override", 'const data: Record<string, unknown> = {}; const holder = {saved: data}; holder.saved.code = "new_failure"; new DvmError("invalid_input", "Failure", undefined, data);'],
    ["stored nested alias override", 'const data: Record<string, unknown> = {}; const holder = {nested: {data}}; holder.nested.data.code = "new_failure"; new DvmError("invalid_input", "Failure", undefined, data);'],
    ["stored array alias override", 'const data: Record<string, unknown> = {}; const holder = [data]; holder[0].code = "new_failure"; new DvmError("invalid_input", "Failure", undefined, data);'],
    ["assigned stored alias override", 'const data: Record<string, unknown> = {}; const holder: Record<string, Record<string, unknown>> = {}; holder.data = data; holder.data.code = "new_failure"; new DvmError("invalid_input", "Failure", undefined, data);'],
    ["copied stored alias override", 'const data: Record<string, unknown> = {}; const holder: Record<string, Record<string, unknown>> = {}; Object.assign(holder, {data}); holder.data.code = "new_failure"; new DvmError("invalid_input", "Failure", undefined, data);'],
    ["computed stored alias override", 'const data: Record<string, unknown> = {}; const slot = "data"; const holder = {[slot]: data}; holder[slot].code = "new_failure"; new DvmError("invalid_input", "Failure", undefined, data);'],
    ["spread stored alias override", 'const data: Record<string, unknown> = {}; const holder = {...{data}}; holder.data.code = "new_failure"; new DvmError("invalid_input", "Failure", undefined, data);'],
    ["returned copy alias override", 'const data: Record<string, unknown> = {}; const holder = Object.assign({}, {data}); holder.data.code = "new_failure"; new DvmError("invalid_input", "Failure", undefined, data);'],
    ["helper-stored alias override", 'const data: Record<string, unknown> = {}; function store(input: Record<string, unknown>) { return {saved: input}; } const holder = store(data); holder.saved.code = "new_failure"; new DvmError("invalid_input", "Failure", undefined, data);'],
    ["later-assigned stored alias override", 'const data: Record<string, unknown> = {}; const holder: Record<string, Record<string, unknown>> = {}; function setCode() { holder.data.code = "new_failure"; } holder.data = data; setCode(); new DvmError("invalid_input", "Failure", undefined, data);'],
  ])("rejects an unlisted %s and accepts its additive inventory entry", (_name, source) => {
    const tree = fixture(`${original}\n${source}`);
    const before = tree.inventory();
    const rejected = tree.run();
    expect(rejected.status).toBe(1);
    expect(rejected.output).toContain("Unlisted CLI error codes: new_failure");
    expect(tree.inventory()).toBe(before);
    expect(tree.run("--update").status).toBe(0);
    expect(JSON.parse(tree.inventory())).toEqual({ codes: ["internal", "invalid_input", "new_failure"], families: [] });
    expect(tree.run().status).toBe(0);
  });

  it.each([
    'const data: Record<string, unknown> = {}; data[externalKey] = "new_failure";',
    'const data = {code: "invalid_input"}; data.code += "_suffix";',
    'const data = {}; Object.defineProperty(data, "code", {value: "new_failure"});',
    'const data = {}; Reflect.set(data, "code", "new_failure");',
    'const data = {}; const holder = opaqueStore(data); holder.data.code = "new_failure";',
    'const data = {}; const holder = opaqueStore(data); Object.assign(holder.data, {code: "new_failure"});',
  ])("rejects unresolved code mutations without updating the baseline", (mutation) => {
    const tree = fixture(`${original}\n${mutation}\nnew DvmError("invalid_input", "Failure", undefined, data);`);
    const before = tree.inventory();
    for (const mode of [[], ["--update"]]) {
      const result = tree.run(...mode);
      expect(result.status).toBe(1);
      expect(result.output).toContain("Unclassified error-code sources");
      expect(tree.inventory()).toBe(before);
    }
  });

  it("does not inventory writes limited to prose fields", () => {
    const tree = fixture(`${original}
const data: Record<string, unknown> = {};
for (const field of ["message", "display", "hint"] as const) data[field] = "Display prose";
new DvmError("invalid_input", "Failure", undefined, data);`);
    expect(discoverErrorCodes(tree.sourceRoot)).toEqual(promised);
  });

  it.each(['{...data}', 'Object.assign({}, data)'])("does not treat a copied object as a reference to the original: %s", (copy) => {
    const tree = fixture(`${original}
const data = {code: "invalid_input"};
const copy = ${copy};
copy.code = "not_emitted";
new DvmError("invalid_input", "Failure", undefined, data);`);
    expect(discoverErrorCodes(tree.sourceRoot)).toEqual(promised);
  });

  it("inventories local data.code overrides and rejects dropping their serialized source", () => {
    const source = `${original}
const OVERRIDES = {primary: "override_error"};
function details() { return {code: OVERRIDES.primary}; }
new DvmError("invalid_input", "Message", undefined, details());`;
    const tree = fixture(source);
    expect(tree.run().output).toContain("Unlisted CLI error codes: override_error");
    expect(tree.run("--update").status).toBe(0);
    expect(JSON.parse(tree.inventory())).toEqual({ codes: ["internal", "invalid_input", "override_error"], families: [] });
    expect(tree.run().status).toBe(0);
    writeFileSync(tree.sourcePath, source.replace(', undefined, details()', ''));
    const before = tree.inventory();
    expect(tree.run("--update").output).toContain("Removed or renamed CLI error codes: override_error");
    expect(tree.inventory()).toBe(before);
  });

  it.each([
    { codes: ["invalid_input", "internal"], families: [] },
    { codes: ["internal", "internal", "invalid_input"], families: [] },
  ])("rejects a noncanonical baseline", (inventory) => {
    const result = fixture(original, inventory).run();
    expect(result.status).toBe(1);
    expect(result.output).toContain("sorted array of unique");
  });
});

describe("production source discovery", () => {
  it("traces local constants, widened maps, helper options, assignments and subclasses across files", () => {
    const expected = {
      codes: ["assigned_error", "constant_error", "helper_error", "mapped_error", "option_error", "other_mapped_error"], families: [],
    };
    const tree = fixture(`${importError}
import { fail, failOption, ByKind } from "./helpers";
const INPUT = "constant_error";
throw new DvmError((INPUT as string), "Constant");
fail("helper_error");
const option = {code: "option_error"};
failOption(option);
let later: string;
later = "assigned_error";
fail(later);
json({error: new ByKind("first")});`, expected);
    tree.write("helpers.ts", `${importError}
export function fail(code: string) { return new DvmError(code, "Message"); }
export function failOption(option: {code: string}) { return new DvmError(option.code, "Option"); }
const CODES: Readonly<Record<string, string>> = {first: "mapped_error", second: "other_mapped_error"};
export class ByKind extends DvmError { constructor(kind: string) { super(CODES[kind], "Mapped"); } }`);
    expect(discoverErrorCodes(tree.sourceRoot)).toEqual(expected);
    expect(tree.run().status).toBe(0);
    tree.write("helpers.ts", readFileSync(join(tree.sourceRoot, "helpers.ts"), "utf8").replace('"mapped_error"', '"renamed_map_error"'));
    const result = tree.run();
    expect(result.status).toBe(1);
    expect(result.output).toContain("Removed or renamed CLI error codes: mapped_error");
  });

  it("finds constructor aliases, namespace imports, conditionals and template-free codes", () => {
    const tree = fixture('import { DvmError as Failure } from "@dvmkit/sdk/internal";\n' +
      'import * as sdk from "@dvmkit/sdk/internal";\n' +
      'const Alias = Failure; new Alias(flag ? "branch_a" : "branch_b", "Message");\n' +
      'new sdk.DvmError(`namespace_error`, "Message");');
    expect(discoverErrorCodes(tree.sourceRoot)).toEqual({ codes: ["branch_a", "branch_b", "namespace_error"], families: [] });
  });

  it("finds error object codes returned through helpers and SDK lock callbacks", () => {
    const tree = fixture(`${importError}
import { withWalletLock } from "@dvmkit/sdk/internal";
function reason() { return {code: "returned_error", message: "Failure"}; }
json({error: reason()});
const locked = withWalletLock(() => ({error: {code: "locked_error", message: "Locked"}}));
throw new DvmError((await locked).error.code, "Message");`);
    expect(discoverErrorCodes(tree.sourceRoot)).toEqual({ codes: ["locked_error", "returned_error"], families: [] });
  });

  it("traces computed literal map and envelope keys", () => {
    const tree = fixture(`${importError}
const KEY = "code";
const CODES = {["first"]: "computed_map_error"};
throw new DvmError(CODES["first"], "Message");
json({["error"]: {[KEY]: "computed_envelope_error"}});`);
    expect(discoverErrorCodes(tree.sourceRoot)).toEqual({ codes: ["computed_envelope_error", "computed_map_error"], families: [] });
  });

  it("excludes provider codes while keeping local fallbacks and normalization codes", () => {
    const source = `${importError}
function fromProvider(body: {code?: string}) { return new DvmError(body.code ?? "provider_error", "Remote"); }
fromProvider({code: "provider_private_failure"});
function normalize(body: {code: string}) { return new DvmError(body.code === "remote_input" ? "invalid_input" : body.code, "Remote"); }
normalize({code: "different_provider_failure"});`;
    const relays = ["fromProvider", "normalize"].map((owner) => ({
      file: "command.ts", owner, expression: "body.code", path: [], reason: "Provider-owned code, unchanged.",
    }));
    const tree = fixture(source, { codes: ["invalid_input", "provider_error"], families: [] }, relays);
    expect(discoverErrorCodes(tree.sourceRoot, relays)).toEqual({ codes: ["invalid_input", "provider_error"], families: [] });
    expect(tree.run().status).toBe(0);
    const changed = source.replace('"different_provider_failure"', '"another_remote_code"');
    writeFileSync(tree.sourcePath, changed);
    expect(tree.run().status).toBe(0);
    writeFileSync(tree.sourcePath, changed + '\nthrow new DvmError("unlisted_local", "Local");');
    expect(tree.run().output).toContain("Unlisted CLI error codes: unlisted_local");
  });

  it("keeps relayed provider code and data.code fields outside the local promise", () => {
    const tree = fixture(`${importError}
function fromProvider(body: {code?: string; data?: Record<string, unknown>}) {
  return new DvmError(body.code ?? "provider_error", "Remote", undefined, body.data);
}
fromProvider({code: "remote_name", data: {code: "remote_override"}});`);
    expect(discoverErrorCodes(tree.sourceRoot, [{
      file: "command.ts", owner: "fromProvider", expression: "body", path: ["code"], alsoPaths: [["data", "code"]],
      reason: "Both fields are supplied by a provider, unchanged.",
    }])).toEqual({ codes: ["provider_error"], families: [] });
  });

  it("rejects unclassified dynamic sources and stale classifications", () => {
    const source = `${importError}function fail(code: string) { throw new DvmError(code.toLowerCase(), "Message"); } fail("new_code");`;
    const tree = fixture(source);
    expect(() => discoverErrorCodes(tree.sourceRoot)).toThrow("Unclassified error-code sources");
    expect(() => discoverErrorCodes(tree.sourceRoot, [{
      file: "command.ts", owner: "otherFunction", expression: "code.toLowerCase()", path: [], reason: "An unrelated relay.",
    }])).toThrow("Unused relay classification");
  });

  it("does not let a catch relay classification suppress a local variable with the same name", () => {
    const tree = fixture(`${importError}
function run() {
  try { work(); } catch (err) { throw new DvmError((err as {code: string}).code, "Remote"); }
  const err = {code: "local_shadow_error"};
  throw new DvmError(err.code, "Local");
}`);
    expect(discoverErrorCodes(tree.sourceRoot, [{
      file: "command.ts", owner: "run", expression: "err", path: ["code"], reason: "Caught code is relayed.",
    }])).toEqual({ codes: ["local_shadow_error"], families: [] });
  });

  it("matches reviewed source expressions with LF or CRLF line endings", () => {
    const relays: ErrorCodeSource[] = [{
      file: "command.ts", owner: "fromProvider", expression: "JSON.parse(\n  body\n)", path: ["code"], reason: "Provider JSON code.",
    }];
    const source = `${importError}
function fromProvider(body: string) {
 const remote = JSON.parse(
  body
);
 return new DvmError(remote.code ?? "provider_error", "Remote");
}`;
    const tree = fixture(source.replaceAll("\n", "\r\n"));
    expect(discoverErrorCodes(tree.sourceRoot, relays)).toEqual({ codes: ["provider_error"], families: [] });
  });

  it("traces classified local callbacks rather than excluding their results", () => {
    const relays: ErrorCodeSource[] = [{
      file: "command.ts", owner: "<module>", expression: "deps.settled()", path: ["code"],
      local: { file: "command.ts", name: "settled" }, reason: "The production callback supplies this result.",
    }];
    const tree = fixture(`${importError}
function settled() { return {code: "settlement_error"}; }
throw new DvmError(deps.settled().code, "Message");`, { codes: ["settlement_error"], families: [] }, relays);
    expect(tree.run().status).toBe(0);
    writeFileSync(tree.sourcePath, readFileSync(tree.sourcePath, "utf8").replace("settlement_error", "changed_settlement"));
    expect(tree.run().output).toContain("Removed or renamed CLI error codes: settlement_error");
  });

  it("traces classified promise input flows instead of dropping local codes", () => {
    const wrapper = "function withTimeout(input: unknown) { return new Promise(resolve => resolve(input)); }";
    const relays: ErrorCodeSource[] = [{
      file: "command.ts", owner: "<module>", expression: "withTimeout(probe())", path: ["code"],
      argument: 0, reason: "Timeout preserves the input's resolved value.",
      guard: { file: "command.ts", name: "withTimeout", sha256: createHash("sha256").update(wrapper).digest("hex") },
    }];
    const tree = fixture(`${importError}
${wrapper}
function probe() { return {code: "probe_error"}; }
throw new DvmError((await withTimeout(probe())).code, "Message");`, { codes: ["probe_error"], families: [] }, relays);
    expect(tree.run().status).toBe(0);
    const source = readFileSync(tree.sourcePath, "utf8");
    writeFileSync(tree.sourcePath, source.replace("resolve(input)", 'resolve({code: "new_wrapper_code"})'));
    expect(tree.run().output).toContain("Classified local flow changed: command.ts#withTimeout");
    writeFileSync(tree.sourcePath, source.replace("probe_error", "changed_probe"));
    expect(tree.run().output).toContain("Removed or renamed CLI error codes: probe_error");
  });

  it("guards argument flows by helper declaration across call sites", () => {
    const helper = "function decorate(input: Record<string, unknown>) { return {...input, marked: true}; }";
    const relays: ErrorCodeSource[] = [{
      file: "command.ts", owner: "decorate", expression: "decorate", path: ["code"], argument: 0, callee: true,
      guard: { file: "command.ts", name: "decorate", sha256: createHash("sha256").update(helper).digest("hex") },
      reason: "The reviewed metadata decorator preserves the code field.",
    }];
    const source = `${importError}\n${helper}
new DvmError("base_error", "Message", undefined, decorate({code: "first_override"}));
function run() { return new DvmError("base_error", "Message", undefined, decorate({code: "second_override"})); }`;
    const tree = fixture(source, { codes: ["base_error", "first_override", "second_override"], families: [] }, relays);
    expect(tree.run().status).toBe(0);
    writeFileSync(tree.sourcePath, source.replace("marked: true", 'code: "new_hidden_override"'));
    expect(tree.run().output).toContain("Classified local flow changed: command.ts#decorate");
  });

  it("traces a redacted code separately from prose and relayed provider codes", () => {
    const wrapper = `function wrapError(err: {code: string; message: string}, token: string) {
  const redact = (value: string): string => value.replaceAll(token, "[REDACTED]");
  return new DvmError(redact(err.code), redact(err.message));
}`;
    const source = `${original}\n${wrapper}
wrapError({code: "new_failure", message: "not_a_code"}, token);
function fromProvider(body: {code: string; message: string}) { return wrapError(body, token); }
fromProvider({code: "provider_owned", message: "also_not_a_code"});`;
    const relays: ErrorCodeSource[] = [
      {file: "command.ts", owner: "wrapError", expression: "redact(err.code)", path: [], argument: 0,
        guard: {file: "command.ts", name: "wrapError", sha256: createHash("sha256").update(wrapper).digest("hex")},
        reason: "Redaction acts on an existing code; trace its input while guarding the wrapper."},
      {file: "command.ts", owner: "fromProvider", expression: "body", path: ["code"], reason: "Provider-owned code is relayed."},
    ];
    const tree = fixture(source, promised, relays);
    const result = tree.run();
    expect(result.status).toBe(1);
    expect(result.output).toContain("Unlisted CLI error codes: new_failure");
    expect(tree.run("--update").status).toBe(0);
    expect(JSON.parse(tree.inventory())).toEqual({codes: ["internal", "invalid_input", "new_failure"], families: []});
    expect(tree.run().status).toBe(0);
    writeFileSync(tree.sourcePath, source.replace("redact(err.code),", 'redact(err.code) || "hidden_code",'));
    expect(tree.run().output).toContain("Classified local flow changed: command.ts#wrapError");
  });

  it("tracks the dynamic HTTP family and rejects removing it or changing its construction", () => {
    const source = `${importError}function fromHttp(status: number) { return new DvmError(\`http_\${status.toString()}\`, "HTTP error"); }`;
    const tree = fixture(source, { codes: [], families: ["http_${number}"] });
    expect(tree.run().status).toBe(0);
    writeFileSync(tree.sourcePath, importError);
    expect(tree.run().output).toContain("Removed or renamed CLI error families: http_${number}");
    writeFileSync(tree.sourcePath, source.replace("http_", "status_"));
    expect(tree.run().output).toContain("Unclassified error-code sources");
  });

  it("excludes test, fixture, support, declaration and dependency source", () => {
    const tree = fixture();
    for (const path of ["__tests__/probe.ts", "test/probe.ts", "tests/probe.ts", "test-support/probe.ts", "fixtures/probe.ts", "__fixtures__/probe.ts", "node_modules/pkg/index.ts", "probe.test.ts", "probe.spec.ts", "probe.d.ts"]) {
      tree.write(path, `${importError}throw new DvmError("not_a_production_code", "Fixture");`);
    }
    expect(discoverErrorCodes(tree.sourceRoot)).toEqual(promised);
  });

  it("rejects syntax it cannot parse", () => {
    const tree = fixture(`${importError}new DvmError(`);
    expect(() => discoverErrorCodes(tree.sourceRoot)).toThrow("Cannot parse production source: command.ts");
  });
});
