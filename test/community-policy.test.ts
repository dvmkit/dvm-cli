import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");

describe("community policy", () => {
  it("keeps source and package metadata under Apache-2.0", () => {
    const manifest = json("package.json") as { license?: string };
    const lock = json("package-lock.json") as {
      packages?: Record<string, { license?: string }>;
    };

    expect(manifest.license).toBe("Apache-2.0");
    expect(lock.packages?.[""].license).toBe("Apache-2.0");
    expect(file("LICENSE")).toMatch(/^Apache License\n\nVersion 2\.0/u);
    expect(file("NOTICE")).toContain("Copyright 2026 DVM Technologies Ltd");
  });

  it("asks bug reporters for the facts needed to reproduce a CLI failure", () => {
    const template = parse(file(".github/ISSUE_TEMPLATE/bug_report.yml")) as {
      body: Array<{ id?: string }>;
    };
    const fields = template.body.map((entry) => entry.id).filter(Boolean);

    expect(fields).toEqual(
      expect.arrayContaining([
        "cli-version",
        "node-version",
        "platform",
        "command",
        "reproduction",
        "expected",
        "actual",
      ])
    );
  });

  it("closes outside pull requests without running their contents", () => {
    const source = file(".github/workflows/close-external-prs.yml");
    const workflow = parse(source) as {
      on: { pull_request_target: { types: string[] } };
      permissions: Record<string, string>;
      jobs: { close: { if: string } };
    };

    expect(workflow.on.pull_request_target.types).toEqual(["opened", "reopened"]);
    expect(workflow.permissions).toEqual({ "pull-requests": "write" });
    expect(workflow.jobs.close.if).toContain(
      "github.event.pull_request.head.repo.full_name != github.repository"
    );
    expect(source).not.toContain("actions/checkout");
    expect(source).toContain("gh pr comment");
    expect(source).toContain("gh pr close");
  });
});

function file(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

function json(path: string): unknown {
  return JSON.parse(file(path));
}
