import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { consumerNpm } from "./installed-consumer.mjs";

const root = resolve(import.meta.dirname, "..");
export function digest(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
export function readRuntimeArtifact(directory) {
  const metadata = JSON.parse(readFileSync(join(directory, "runtime.json"), "utf8"));
  if (metadata.archive !== "caller.tgz" || metadata.name !== "@dvmkit/dvm-cli" ||
      metadata.engines?.node !== ">=22" || Object.keys(metadata.engines).length !== 1 ||
      typeof metadata.version !== "string" || !/^[a-f0-9]{64}$/u.test(metadata.sha256)) {
    throw new Error("invalid runtime artifact metadata");
  }
  if (readdirSync(directory).sort().join(",") !== "caller.tgz,runtime.json" ||
      digest(readFileSync(join(directory, metadata.archive))) !== metadata.sha256) {
    throw new Error("runtime archive integrity mismatch");
  }
  return metadata;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  try {
    const directory = join(root, ".artifacts", "runtime");
    rmSync(directory, { recursive: true, force: true });
    mkdirSync(directory, { recursive: true });
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const result = JSON.parse(await consumerNpm(["pack", "--ignore-scripts", "--json", "--pack-destination", directory], root))[0];
    const bytes = readFileSync(join(directory, result.filename));
    rmSync(join(directory, result.filename));
    writeFileSync(join(directory, "caller.tgz"), bytes);
    const skills = Object.fromEntries(["SKILL.md", "calling.md", "wallets.md", "credit.md", "recovery.md"].map(
      (file) => [file, digest(readFileSync(join(root, "skills", "dvm", file)))]));
    writeFileSync(join(directory, "runtime.json"), JSON.stringify({
      archive: "caller.tgz", name: manifest.name, version: manifest.version,
      engines: manifest.engines, sha256: digest(bytes), skills,
    }, null, 2) + "\n");
    readRuntimeArtifact(directory);
    console.log("runtime artifact: one verified-build archive and SHA-256 metadata ready");
  } catch {
    console.error("runtime artifact: creation failed (diagnostics withheld)");
    process.exitCode = 1;
  }
}
