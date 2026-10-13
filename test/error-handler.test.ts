import { DvmError } from "@dvmkit/sdk/internal";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { build } from "esbuild";
import { afterEach, describe, expect, it, vi } from "vitest";

import { catchErrors } from "../src/lib/error-handler";
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
