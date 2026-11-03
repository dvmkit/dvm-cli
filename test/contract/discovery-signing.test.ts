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
  requests: Array<{ method: string; path: string; authenticated: boolean }>;
}
let snapshot: () => Promise<Evidence>;
let control: (message: "defer" | "release") => Promise<void>;
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
  ({ authenticated, anonymous, snapshot, control } = await provider());
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
  it.each([false, true])("resumes the exact timeout hint in a second process (signed: %s)", async (signed) => {
    const root = signed ? caller : configRoot();
    const endpoint = signed ? authenticated : anonymous;
    const before = await snapshot();
    await control("defer");
    try {
      const first = await runCli([...command.args, "--endpoint", endpoint, "--timeout", "0.1"], root);
      expect(first.code).toBe(1);
      const error = JSON.parse(first.stdout).error;
      expect(error.code).toBe("timeout");
      const records = JSON.parse(readFileSync(join(root, "jobs.json"), "utf8"));
      const job = records.at(-1);
      expect(job).toMatchObject({ endpoint, capability: command.capability, status: "submitted", messageCursor: expect.any(Number) });
      expect(job.messageCursor).toBeGreaterThan(0);
      expect(job.jobToken).toMatch(/^[0-9a-f]{64}$/i);
      const hint = /`(dvm messages [\w-]+ --wait)`/.exec(error.hint);
      expect(hint).not.toBeNull();
      const args = hint![1].split(" ").slice(1);
      expect(args).toEqual(["messages", job.id, "--wait"]);
      await control("release");
      const resumed = await runCli(args, root);
      expect(resumed.code, resumed.stdout + resumed.stderr).toBe(0);
      const output = JSON.parse(resumed.stdout);
      expect(output.jobId).toBe(job.id);
      expect(output.messages).toEqual(expect.arrayContaining([expect.objectContaining({ type: "complete" })]));
      expect(output.next_action).toBeNull();
      if (job.jobToken) expect(first.stdout + first.stderr + resumed.stdout + resumed.stderr).not.toContain(job.jobToken);
      const after = await snapshot();
      expect(after.jobs.at(-1)?.pubkey).toBe(signed ? pubkey : undefined);
      expect(after.submissions.length - before.submissions.length).toBe(1);
      const requests = after.requests.slice(before.requests.length);
      expect(requests.filter((request) => request.method === "POST").map((request) => request.path)).toEqual(["/v1/job"]);
      expect(requests.every((request) => request.authenticated === signed)).toBe(true);
      expect(JSON.parse(readFileSync(join(root, "jobs.json"), "utf8")).at(-1)).toMatchObject({ status: "completed" });
    } finally {
      await control("release");
    }
  }, 20_000);

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

async function provider(): Promise<{ authenticated: string; anonymous: string; snapshot: () => Promise<Evidence>; control: typeof control }> {
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
    async control(message) {
      const response = receive(message === "defer" ? "deferred" : "released");
      child.send(message);
      await response;
    },
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
    delete env.DVM_JOB_ENDPOINT;
    delete env.DVM_JOB_TOKEN;
    const child = spawn(process.execPath, [binary, ...args], { env, stdio: ["ignore", "pipe", "pipe"], timeout: 15_000 });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => done({ code, stdout, stderr }));
  });
}
