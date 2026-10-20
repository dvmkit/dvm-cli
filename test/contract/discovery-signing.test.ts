import { fork, spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const binary = resolve(import.meta.dirname, "../../dist/dvm.js");
const roots: string[] = [];
const providers: Array<{ child: ChildProcess; completion: Promise<number | null> }> = [];
interface Evidence {
  jobs: Array<{ capability: string; input: unknown; pubkey?: string }>;
  submissions: Array<Record<string, unknown>>;
}
let snapshot: () => Promise<Evidence>;
let authenticated: string;
let anonymous: string;
let caller: string;
let pubkey: string;

function configRoot() {
  const root = mkdtempSync(join(tmpdir(), "discovery-caller-"));
  roots.push(root);
  return root;
}

beforeAll(async () => {
  ({ authenticated, anonymous, snapshot } = await provider());
  caller = configRoot();
  const initialized = await runCli(["init"], caller);
  pubkey = JSON.parse(initialized.stdout).identity.pubkey;
  await runCli(["identity", "create", "second"], caller);
  await runCli(["identity", "use", "default"], caller);
}, 30_000);

afterAll(async () => {
  await Promise.all(providers.map(async ({ child, completion }) => {
    const timeout = setTimeout(() => child.kill("SIGKILL"), 5_000);
    try {
      if (child.connected) child.send("shutdown");
      const code = await completion;
      if (code !== 0) throw new Error("Discovery fixture exited unexpectedly; diagnostics retained privately.");
    } finally {
      clearTimeout(timeout);
    }
  }));
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const commands = [
  {
    capability: "search",
    args: ["search", "weather", "--tag", "audio", "--credit", "--limit", "3"],
    input: { query: "weather", mode: "keyword", tags: ["audio"], credit: true, limit: 3, region: "global" },
    output: { results: [], query: "weather", mode: "keyword", total: 0 },
  },
  {
    capability: "browse",
    args: ["browse", "--tag", "audio", "--builder", "publisher", "--source", "platform", "--sort", "name", "--limit", "3", "--offset", "2"],
    input: { tags: ["audio"], builder: "publisher", source: "platform", sort: "name", limit: 3, offset: 2, region: "global" },
    output: { entries: [], total: 0, offset: 2, limit: 3 },
  },
];

describe.each(commands)("$capability signed discovery", (command) => {
  it("uses the configured identity and schema defaults through the SDK verifier", async () => {
    const identities = readFileSync(join(caller, "identities.json"), "utf8");
    const result = await runCli([...command.args, "--endpoint", authenticated], caller);

    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject(command.output);
    expect((await snapshot()).jobs.at(-1)).toMatchObject({ capability: command.capability, input: command.input, pubkey });
    expect((await snapshot()).submissions.at(-1)).toMatchObject({ capability: command.capability, data: command.input });
    expect(readFileSync(join(caller, "identities.json"), "utf8")).toBe(identities);
  });

  it("rejects unsigned HTTP submissions with 401", async () => {
    const response = await fetch(`${authenticated}/v1/job`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ capability: command.capability, input: JSON.stringify(command.input) }),
    });
    expect(response.status).toBe(401);
  });

  it("works anonymously without creating an identity", async () => {
    const root = configRoot();
    const result = await runCli([...command.args, "--endpoint", anonymous], root);

    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject(command.output);
    expect((await snapshot()).jobs.at(-1)).toEqual({ capability: command.capability, input: command.input, pubkey: undefined });
    expect(existsSync(join(root, "identities.json"))).toBe(false);
    expect(existsSync(join(root, "config.json"))).toBe(false);
  });

  it("returns actionable JSON when no signing identity exists", async () => {
    const root = configRoot();
    const count = (await snapshot()).jobs.length;
    const result = await runCli([...command.args, "--endpoint", authenticated], root);

    expect(result.code).toBe(1);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout).error).toMatchObject({
      code: "auth_required",
      hint: expect.stringContaining("dvm identity create"),
    });
    expect((await snapshot()).jobs).toHaveLength(count);
    expect(existsSync(join(root, "identities.json"))).toBe(false);
    expect(existsSync(join(root, "config.json"))).toBe(false);
  });
});

async function provider(): Promise<{ authenticated: string; anonymous: string; snapshot: () => Promise<Evidence> }> {
  // SDK request spans contain raw routes that CI deliberately refuses to print.
  // Keep fixture telemetry private without intercepting test-runner diagnostics.
  const diagnostics = createWriteStream(join(mkdtempSync(join(tmpdir(), "discovery-provider-")), "fixture.log"), { mode: 0o600 });
  const child = fork(resolve(import.meta.dirname, "../support/discovery-provider.mjs"), {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    serialization: "advanced",
  });
  child.stdout!.pipe(diagnostics, { end: false });
  child.stderr!.pipe(diagnostics, { end: false });
  const completion = new Promise<number | null>((done) => child.once("close", (code) => {
    diagnostics.end(() => done(code));
  }));
  providers.push({ child, completion });
  const failure = () => new Error("Discovery fixture unavailable; diagnostics retained privately.");
  function receive(type: string): Promise<Record<string, unknown>> {
    return new Promise((done, reject) => {
      const cleanup = () => {
        clearTimeout(timeout);
        child.off("message", onMessage);
        child.off("error", onFailure);
        child.off("close", onFailure);
      };
      const onFailure = () => { cleanup(); reject(failure()); };
      const onMessage = (message: Record<string, unknown>) => {
        if (message.type !== type) return;
        cleanup();
        done(message);
      };
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        onFailure();
      }, 10_000);
      child.on("message", onMessage);
      child.once("error", onFailure);
      child.once("close", onFailure);
      if (child.exitCode !== null || child.signalCode !== null) onFailure();
    });
  }
  const ready = await receive("ready");
  return {
    authenticated: ready.authenticated as string,
    anonymous: ready.anonymous as string,
    async snapshot() {
      const response = receive("snapshot");
      if (child.connected) child.send("snapshot");
      return await response as unknown as Evidence;
    },
  };
}

function runCli(args: string[], root: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, DVM_CONFIG_DIR: root };
    delete env.DVM_IDENTITY_KEY;
    const child = spawn(process.execPath, [binary, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => done({ code, stdout, stderr }));
  });
}
