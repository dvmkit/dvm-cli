import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const binary = resolve(import.meta.dirname, "../../dist/dvm.js");
const execute = promisify(execFile);
const endpoint = "https://provider.example";
const secret = "0123456789abcdef".repeat(4);
const upstreamText = JSON.stringify(`Upstream diagnostic: ${secret}`);

it.each([
  ["quote", `return new Response(${upstreamText}, { status: 503 });`],
  ["request", `throw new Error(${upstreamText});`],
])("keeps upstream descriptor errors out of %s output", async (command, fail) => {
  const preload = `data:text/javascript,${encodeURIComponent(`globalThis.fetch = async () => { ${fail} };`)}`;
  const run = (...outputFlags: string[]) => execute(process.execPath, [
    "--import", preload, binary, command, "--endpoint", endpoint, "--input", "test", ...outputFlags,
  ], { timeout: 10_000 }).then(
    (result) => ({ ...result, code: 0 }),
    (error) => error as { stdout: string; stderr: string; code: number },
  );

  const [json, human] = await Promise.all([run(), run("--human")]);
  for (const result of [json, human]) {
    expect(result.code).toBe(1);
    expect(result.stdout + result.stderr).not.toContain(secret);
    expect(result.stdout + result.stderr).not.toContain("Upstream diagnostic");
  }
  expect(JSON.parse(json.stdout)).toMatchObject({ error: {
    code: "endpoint_unreachable",
    message: expect.stringContaining(endpoint),
    hint: expect.stringContaining("Check the endpoint URL and your network connection"),
  } });
  expect(human.stderr).toContain(endpoint);
  expect(human.stderr).toContain("Check the endpoint URL and your network connection");
}, 15_000);
