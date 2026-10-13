import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";
import {
  installPublishedRelease,
  runBoundedProcess,
} from "../scripts/install-published-release.mjs";

const version = "1.2.3-rc.1";
const target = `@dvmkit/dvm-cli@${version}`;

describe("published release consumer installation", () => {
  it.each([
    ["ETARGET", npmFailure("ETARGET", `npm error notarget No matching version found for ${target}.`)],
    ["E404 package spec", npmFailure("E404", [
      "npm error 404 Not Found - GET https://registry.npmjs.org/@dvmkit%2fdvm-cli/1.2.3-rc.1",
      `npm error 404 '${target}' is not in this registry.`,
    ])],
    ["E404 encoded metadata URL", npmFailure("E404", "npm error 404 Not Found - GET https://registry.npmjs.org/@dvmkit%2fdvm-cli/1.2.3-rc.1")],
    ["E404 archive URL", npmFailure("E404", "npm error 404 Not Found - GET https://registry.npmjs.org/@dvmkit%2fdvm-cli/-/dvm-cli-1.2.3-rc.1.tgz")],
  ])("retries an exact-version %s propagation response", async (_label, failure) => {
    const runFn = vi.fn().mockReturnValueOnce(failure).mockReturnValueOnce(success());
    const waitFn = vi.fn(async () => {});
    await expect(install({ version, prefix: "/consumer", runFn, waitFn, retryDelayMs: 17 })).resolves.toBeUndefined();
    expect(runFn).toHaveBeenCalledTimes(2);
    expect(runFn).toHaveBeenNthCalledWith(1, { prefix: "/consumer", target, timeoutMs: 120_000 });
    expect(waitFn).toHaveBeenCalledExactlyOnceWith(17);
  });

  it("stops at the total availability deadline including retry waits", async () => {
    const runFn = vi.fn(() => npmFailure("ETARGET", `npm error notarget No matching version found for ${target}.`));
    let now = 0;
    const waitFn = vi.fn(async (milliseconds: number) => {
      now += milliseconds;
    });

    await expect(
      install({
        version,
        prefix: "/consumer",
        runFn,
        waitFn,
        nowFn: () => now,
        availabilityTimeoutMs: 25_000,
        retryDelayMs: 10_000,
      })
    ).rejects.toThrow("exact-version availability deadline");

    expect(runFn).toHaveBeenCalledTimes(3);
    expect(waitFn).toHaveBeenCalledTimes(3);
    expect(waitFn).toHaveBeenNthCalledWith(1, 10_000);
    expect(waitFn).toHaveBeenLastCalledWith(5_000);
  });

  it("accounts for install subprocess elapsed time in the total deadline", async () => {
    let now = 0;
    const runFn = vi.fn(() => {
      now = 101;
      return success();
    });

    await expect(
      install({
        version,
        prefix: "/consumer",
        runFn,
        nowFn: () => now,
        availabilityTimeoutMs: 100,
      })
    ).rejects.toThrow("exact-version availability deadline");
    expect(runFn).toHaveBeenCalledWith({ prefix: "/consumer", target, timeoutMs: 100 });
  });

  it.each([
    ["a network failure", npmFailure("EAI_AGAIN", "npm error request to registry failed")],
    ["a package-level 404 without the exact version", npmFailure("E404", "npm error 404 Not Found - GET https://registry.npmjs.org/@dvmkit%2fdvm-cli")],
    ["a wrong-version registry URL", npmFailure("E404", "npm error 404 Not Found - GET https://registry.npmjs.org/@dvmkit%2fdvm-cli/1.2.3-rc.2")],
    ["an exact quoted package spec without a matching registry URL", npmFailure("E404", `npm error 404 '${target}' is not in this registry.`)],
    [
      "an exact package URL accompanied by an untrusted URL",
      npmFailure("E404", [
        "npm error 404 Not Found - GET https://registry.npmjs.org/@dvmkit%2fdvm-cli/1.2.3-rc.1",
        "npm error 404 Not Found - GET https://registry.invalid/@dvmkit%2fdvm-cli/1.2.3-rc.1",
      ]),
    ],
    [
      "an exact ETARGET response accompanied by a fatal npm code",
      npmFailure("ETARGET", [
        `npm error notarget No matching version found for ${target}.`,
        "npm error code E401",
        "npm error Unable to authenticate",
      ]),
    ],
    [
      "an exact ETARGET response accompanied by a separate E404 record",
      npmFailure("ETARGET", [
        `npm error notarget No matching version found for ${target}.`,
        "npm error code E404",
        "npm error 404 Not Found - GET https://registry.npmjs.org/other-package/9.9.9",
      ]),
    ],
    [
      "an exact ETARGET response accompanied by a same-code unrelated record",
      npmFailure("ETARGET", [
        `npm error notarget No matching version found for ${target}.`,
        "npm error code ETARGET",
        "npm error notarget No matching version found for other-package@9.9.9.",
      ]),
    ],
    [
      "an ETARGET response for a version with the requested version as a prefix",
      npmFailure("ETARGET", `npm error notarget No matching version found for ${target}.1.`),
    ],
    [
      "a different package's target error despite wrapper command text naming the release",
      { ...npmFailure("ETARGET", "npm error notarget No matching version found for other-package@1.2.3."), stdout: `command ${target}\n` },
    ],
  ])("fails without retrying on %s", async (_label, result) => {
    const runFn = vi.fn(() => result);
    const waitFn = vi.fn(async () => {});

    await expect(install({ version, prefix: "/consumer", runFn, waitFn })).rejects.toThrow(
      `npm could not install ${target}`
    );

    expect(runFn).toHaveBeenCalledOnce();
    expect(waitFn).not.toHaveBeenCalled();
  });

  it("kills the owned npm wrapper process group when installation times out", async () => {
    const root = mkdtempSync(join(tmpdir(), "dvm-cli-install-timeout-"));
    const pidFile = join(root, "child.pid");
    const wrapper = [
      'const { spawn } = require("node:child_process")',
      'const { writeFileSync } = require("node:fs")',
      'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })',
      `writeFileSync(${JSON.stringify(pidFile)}, String(child.pid))`,
      "setInterval(() => {}, 1000)",
    ].join(";");

    try {
      const result = await runBoundedProcess(process.execPath, ["-e", wrapper], 250);
      expect(result.error).toMatchObject({ code: "ETIMEDOUT" });
      const childPid = Number(readFileSync(pidFile, "utf8"));
      await expect.poll(() => processExists(childPid), { timeout: 1_000 }).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function npmFailure(code: string, detail: string | string[]) {
  return { status: 1, stdout: "", stderr: `npm error code ${code}\n${[detail].flat().join("\n")}\n` };
}

function success() {
  return { status: 0, stdout: "added 1 package\n", stderr: "" };
}

function install(options: Parameters<typeof installPublishedRelease>[0]) {
  return installPublishedRelease({ ...options, outputFn: () => {} });
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}
