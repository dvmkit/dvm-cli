import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const placeholder = (name) => "$" + "{" + name + "}";
const mappings = [
  { name: "docsPath3", expected: 1 },
  { name: "docsPath6", expected: 1 },
  { name: "i", expected: 2 },
];
for (const mapping of mappings) {
  const sourceText = "`Docs: " + "https:" + "//abitype.dev" + placeholder(mapping.name) + "`";
  const replacementText =
    '"Docs: " + "https://abitype.dev/{path}".replace("/{path}", () => ' + mapping.name + ")";
  let replacements = 0;
  for (const name of readdirSync("dist")) {
    if (!name.endsWith(".js")) continue;
    const path = join("dist", name);
    const source = readFileSync(path, "utf8");
    const occurrences = source.split(sourceText).length - 1;
    if (occurrences === 0) continue;
    replacements += occurrences;
    writeFileSync(path, source.split(sourceText).join(replacementText));
  }
  if (replacements !== mapping.expected) {
    throw new Error(
      `expected ${mapping.expected} abitype ${mapping.name} URL templates, found ${replacements}`
    );
  }
}
const residualPrefix = "https:" + "//abitype.dev" + "$" + "{";
for (const name of readdirSync("dist")) {
  if (!name.endsWith(".js")) continue;
  if (readFileSync(join("dist", name), "utf8").includes(residualPrefix)) {
    throw new Error("unaccounted abitype URL template remains after normalization");
  }
}

const rpcSourceText = "`https:" + "//rpc-zone-" + placeholder("paddedId") + "." + placeholder("options.rpcHost") + "`";
const rpcReplacementText =
  '"https://{domain}".replace("{domain}", () => `rpc-zone-' +
  placeholder("paddedId") +
  "." +
  placeholder("options.rpcHost") +
  "`)";
let rpcReplacements = 0;
for (const name of readdirSync("dist")) {
  if (!name.endsWith(".js")) continue;
  const path = join("dist", name);
  const source = readFileSync(path, "utf8");
  const occurrences = source.split(rpcSourceText).length - 1;
  if (occurrences === 0) continue;
  rpcReplacements += occurrences;
  writeFileSync(path, source.split(rpcSourceText).join(rpcReplacementText));
}
if (rpcReplacements !== 1) {
  throw new Error(
    `expected 1 generated RPC host URL template, found ${rpcReplacements}`
  );
}
const residualRpcPrefix = "https:" + "//rpc-zone-" + "$" + "{";
for (const name of readdirSync("dist")) {
  if (!name.endsWith(".js")) continue;
  if (readFileSync(join("dist", name), "utf8").includes(residualRpcPrefix)) {
    throw new Error("unaccounted generated RPC host URL template remains after normalization");
  }
}
