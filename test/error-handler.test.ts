import { DvmError } from "@dvmkit/sdk/internal";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { build } from "esbuild";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({ writes: [] as { fd: number; text: string }[] }));
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, writeSync: vi.fn((fd: number, buffer: Uint8Array, offset = 0, length = buffer.length) => {
    if (fd !== 1 && fd !== 2) return actual.writeSync(fd, buffer, offset, length);
    captured.writes.push({ fd, text: Buffer.from(buffer).subarray(offset, offset + length).toString() });
    return length;
  }) };
});

import { catchErrors } from "../src/lib/error-handler";
import { withJobTokenRedaction } from "../src/lib/job-access";
import { addOutputWarnings, json, withOutputWarnings, type OutputWarning } from "../src/lib/output";
import { NODE_REQUIRE_BANNER } from "../tsup.config";

class ExitSignal extends Error {
  constructor(readonly code: number | undefined) {
    super("process.exit");
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe("command error boundary", () => {

  it("keeps the process alive through Commander parsing until an unreferenced action completes", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "dvm-cli-async-action-"));
    try {
      const entry = resolve(root, "entry.ts");
      const bundle = resolve(root, "entry.mjs");
      writeFileSync(
        entry,
        [
          `import { Command } from ${JSON.stringify(resolve(import.meta.dirname, "../node_modules/commander/index.js"))};`,
          `import { catchErrors } from ${JSON.stringify(resolve(import.meta.dirname, "../src/lib/error-handler.ts"))};`,
          "const program = new Command();",
          'program.command("probe").action(() =>',
          "  catchErrors(() =>",
          "    new Promise((resolvePromise) => {",
          "      const timer = setTimeout(() => {",
          '        process.stdout.write("completed\\n");',
          "        resolvePromise();",
          "      }, 10);",
          "      timer.unref();",
          "    })",
          "  )",
          ");",
          'await program.parseAsync(["node", "dvm", "probe"]);',
        ].join("\n")
      );
      await build({
        absWorkingDir: resolve(import.meta.dirname, ".."),
        // Same shim the shipped bundle carries: the CLI's graph reaches CommonJS
        // packages whose `require` has no definition in an ES module.
        banner: { js: NODE_REQUIRE_BANNER },
        bundle: true,
        entryPoints: [entry],
        external: [resolve(import.meta.dirname, "../node_modules/commander/index.js")],
        format: "esm",
        outfile: bundle,
        platform: "node",
        target: "node22",
      });

      const result = await runChild(bundle);
      expect(result).toEqual({ code: 0, stdout: "completed\n", stderr: "" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves a command-selected successful exit code", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

    await catchErrors(() => {
      process.exitCode = 7;
    });

    expect(exit).toHaveBeenCalledExactlyOnceWith(7);
  });

  it("keeps structured action errors terminal", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new ExitSignal(code);
    }) as never);

    await expect(
      catchErrors(() => {
        throw new DvmError("expected_failure", "Expected failure");
      })
    ).rejects.toMatchObject({ code: 1 });

    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("returns the guarded promise from every Commander action", () => {
    const source = readFileSync(resolve(import.meta.dirname, "../src/cli/dvm.ts"), "utf8");
    const actionCount = (source.match(/\.action\(/g) ?? []).length;
    const returnedBoundaryCount = (source.match(/^\s*return catchErrors\(/gm) ?? []).length;

    expect(actionCount).toBeGreaterThan(0);
    expect(returnedBoundaryCount).toBe(actionCount);
    expect(source).not.toMatch(/^\s+catchErrors\(/m);
  });
});

describe("warnings on command errors", () => {
  const local: OutputWarning = {
    code: "local_job_state_unsaved",
    display: "Local job state could not be saved. Automatic payments are paused.",
    hint: "Refresh the job before paying again.",
  };
  const draw: OutputWarning = {
    code: "draw_funding_unverified", job_id: "warning-job", reason: "funding_unknown",
    display: "Credit draw funding could not be verified.", hint: "Check the original funding.",
  };
  const bound: OutputWarning = {
    code: "auto_pay_bound_exceeded", bound: "1000 msats", maximum: "5000 msats",
    auto_pay_below: "5000", source: "quote", display: "The quote exceeds the auto-pay bound.",
  };
  const text = (fd: number) => captured.writes.filter((write) => write.fd === fd).map((write) => write.text).join("");
  const documents = () => text(1).trim().split("\n").map((line) => JSON.parse(line));

  beforeEach(() => {
    captured.writes.length = 0;
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => { throw new ExitSignal(code); }) as never);
  });

  it.each(["structured", "unexpected"])("carries all warning types through an async %s failure", async (kind) => {
    const token = "ab".repeat(32);
    await expect(catchErrors(() => withJobTokenRedaction(token, () => withOutputWarnings(async () => {
      addOutputWarnings([local, draw, bound, local]);
      await Promise.resolve();
      throw kind === "structured"
        ? new DvmError("provider_unreachable", `Connection lost for ${token}`)
        : new TypeError("Dependency failure");
    })))).rejects.toMatchObject({ code: 1 });

    expect(documents()).toEqual([expect.objectContaining({
      error: expect.objectContaining({ code: kind === "structured" ? "provider_unreachable" : "internal" }),
      warnings: [local, draw, bound],
    })]);
    if (kind === "structured") {
      expect(documents()[0].error.message).toBe("Connection lost for [REDACTED]");
    }
    expect(text(1)).not.toContain(token);
    expect(text(2)).toBe("");
    expect(process.exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("omits warnings on a fresh error after a successful command with warnings", async () => {
    await expect(catchErrors(() => withOutputWarnings(async () => {
      addOutputWarnings([local]);
      json({ status: "ok" });
    }))).rejects.toMatchObject({ code: 0 });
    await expect(catchErrors(() => withOutputWarnings(async () => {
      throw new DvmError("provider_unreachable", "Connection lost");
    }))).rejects.toMatchObject({ code: 1 });

    const [success, failure] = documents();
    expect(success).toMatchObject({ status: "ok", warnings: [local] });
    expect(failure.error.code).toBe("provider_unreachable");
    expect(failure).not.toHaveProperty("warnings");
  });

  it("keeps warnings isolated between overlapping commands and shares nested scopes", async () => {
    let finish!: () => void;
    const ready = new Promise<void>((resolve) => { finish = resolve; });
    const first = expect(catchErrors(() => withOutputWarnings(async () => {
      addOutputWarnings([local]);
      await ready;
      await withOutputWarnings(async () => { addOutputWarnings([draw]); });
      throw new DvmError("first_failed", "First command failed");
    }))).rejects.toMatchObject({ code: 1 });

    try {
      await expect(catchErrors(() => withOutputWarnings(async () => {
        throw new DvmError("second_failed", "Second command failed");
      }))).rejects.toMatchObject({ code: 1 });
    } finally {
      finish();
      await first;
    }

    const [second, firstCommand] = documents();
    expect(second.error.code).toBe("second_failed");
    expect(second).not.toHaveProperty("warnings");
    expect(firstCommand).toMatchObject({ error: { code: "first_failed" }, warnings: [local, draw] });
  });

  it("prints a human warning once when the command subsequently fails", async () => {
    await expect(catchErrors(() => withOutputWarnings(async () => {
      addOutputWarnings([local, local], true);
      throw new DvmError("provider_unreachable", "Connection lost");
    }, true), true)).rejects.toMatchObject({ code: 1 });

    expect(text(1)).toBe("");
    expect(text(2)).toBe(`Warning: ${local.display}\nError: Connection lost\n`);
  });
});

function runChild(file: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [file], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
  });
}
