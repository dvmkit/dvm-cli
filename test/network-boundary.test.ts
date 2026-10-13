// The agent wallet resolves its state directory once, at import time, so the
// sweep fixture below has to publish `DVM_CONFIG_DIR` before the SDK package is
// evaluated. `vi.hoisted` is the only hook that runs that early.
const configRoot = vi.hoisted(() => {
  const tmp = (process.env.TMPDIR ?? "/tmp").replace(/\/$/, "");
  const dir = `${tmp}/dvm-cli-network-boundary-${process.pid}-${Date.now()}`;
  process.env.DVM_CONFIG_DIR = dir;
  return dir;
});

import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { sweepPendingSubmissions } from "../src/lib/wallet-agent/recovery-submissions";
import * as ts from "typescript";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { dvmFetch } from "../src/lib/http";

const sourceRoot = resolve(import.meta.dirname, "../src");

const RECOVERY_ENTRY_POINTS = ["sweepPendingSubmissions", "recoverPendingSubmission"];

function sourceFiles(dir = sourceRoot): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) return ["__tests__", "test-support"].includes(entry.name) ? [] : sourceFiles(path);
    return entry.isFile() && path.endsWith(".ts") ? [path] : [];
  });
}

function parse(path: string): ts.SourceFile {
  return ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
}

function networkBypasses(sources = sourceFiles().map((path) => ({ path, parsed: parse(path) }))): {
  rawFetch: string[];
  sharedGlobalFetch: string[];
  rawNodeHttp: string[];
} {
  const rawFetch: string[] = [];
  const sharedGlobalFetch: string[] = [];
  const rawNodeHttp: string[] = [];
  for (const { path, parsed } of sources) {
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "fetch"
      ) {
        rawFetch.push(relative(sourceRoot, path));
      }
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === "globalThis" &&
        node.expression.name.text === "fetch"
      ) {
        sharedGlobalFetch.push(relative(sourceRoot, path));
      }
      if (
        ts.isImportDeclaration(node) &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        (node.moduleSpecifier.text === "node:http" || node.moduleSpecifier.text === "node:https")
      ) {
        rawNodeHttp.push(relative(sourceRoot, path));
      }
      ts.forEachChild(node, visit);
    };
    visit(parsed);
  }
  return {
    rawFetch: rawFetch.sort(),
    sharedGlobalFetch: sharedGlobalFetch.sort(),
    rawNodeHttp: rawNodeHttp.sort(),
  };
}

function submissionRecoveryCalls(): { site: string; fetchImpl: string | null }[] {
  const calls: { site: string; fetchImpl: string | null }[] = [];
  for (const path of sourceFiles()) {
    const parsed = parse(path);
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        RECOVERY_ENTRY_POINTS.includes(node.expression.text)
      ) {
        const opts = node.arguments[0];
        const property =
          opts && ts.isObjectLiteralExpression(opts)
            ? opts.properties.find(
                (p) =>
                  ts.isPropertyAssignment(p) &&
                  ts.isIdentifier(p.name) &&
                  p.name.text === "fetchImpl"
              )
            : undefined;
        const value =
          property && ts.isPropertyAssignment(property) && ts.isIdentifier(property.initializer)
            ? property.initializer.text
            : null;
        calls.push({
          site: `${relative(sourceRoot, path)}:${node.expression.text}`,
          fetchImpl: value,
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(parsed);
  }
  return calls.sort((a, b) => a.site.localeCompare(b.site));
}

const REQUEST_ID = "6f2ad1c8-3f1f-4a17-9d3a-1a2b3c4d5e6f";
const MINT = "https://mint.invalid";
const ENDPOINT = "https://dvm.invalid";
const LOCK_PUBKEY = `03${"33".repeat(32)}`;

const UPGRADE_BODY = JSON.stringify({
  error: "client_upgrade_required",
  required_capabilities: ["future-streaming-mode"],
  minimum_client_version: "9.9.9",
  display: "This DVM needs a newer dvm client.",
  hint: "Upgrade dvm, then retry.",
});

function writeWalletWithPendingSubmission(): void {
  mkdirSync(configRoot, { recursive: true, mode: 0o700 });
  const wallet = {
    version: 8,
    lock_privkey: "11".repeat(32),
    lock_pubkey: `02${"22".repeat(32)}`,
    mnemonic_fingerprint: null,
    mints: [MINT],
    proofs: [],
    nut13_counters: {},
    pending_mints: [],
    pending_melts: [],
    pending_submissions: [
      {
        endpoint: ENDPOINT,
        request_id: REQUEST_ID,
        intended_lock_pubkey: LOCK_PUBKEY,
        mint: MINT,
        amount_sats: 1,
        output_proofs: [
          {
            mint: MINT,
            secret: "network-boundary-secret",
            C: `02${"44".repeat(32)}`,
            amount: 1,
            id: "0088553322110000",
            locked_to_pubkey: LOCK_PUBKEY,
            status: "valid",
          },
        ],
        created_at: new Date().toISOString(),
        cashu_token: "cashuBnetwork-boundary-token",
        context: { route: "job", submit_body: { capability: "echo", data: {} } },
      },
    ],
    recent_spends: [],
    created_at: new Date().toISOString(),
  };
  writeFileSync(join(configRoot, "wallet.json"), `${JSON.stringify(wallet, null, 2)}\n`, {
    mode: 0o600,
  });
}

describe("dvmkit network boundary", () => {
  it("classifies every raw fetch and Node HTTP call site", () => {
    expect(networkBypasses()).toEqual({
      rawFetch: [],
      sharedGlobalFetch: ["lib/http.ts"],
      rawNodeHttp: ["lib/upload-stream.ts", "lib/upload-stream.ts"],
    });
  });

  it("rejects raw production network calls in an invalid source example", () => {
    const path = join(sourceRoot, "invalid.ts");
    const parsed = ts.createSourceFile(path, 'import { request } from "node:https"; fetch("https://example.com"); globalThis.fetch("https://example.com");', ts.ScriptTarget.Latest, true);
    expect(networkBypasses([{ path, parsed }])).toEqual({
      rawFetch: ["invalid.ts"], sharedGlobalFetch: ["invalid.ts"], rawNodeHttp: ["invalid.ts"],
    });
  });

  // Caller recovery uses the network wrapper, which preserves
  // `client_upgrade_required` on an HTTP
  // 426 instead of a generic `provider_unreachable`.
  it("injects dvmFetch into every submission recovery consumer", () => {
    const calls = submissionRecoveryCalls();
    // Exact, like the inventories above: a site that disappears, or one that
    // reaches recovery through an alias this parser cannot see, fails here.
    expect(calls.map((call) => call.site)).toEqual([
      "commands/request.ts:sweepPendingSubmissions",
      "commands/wallet-agent-fund.ts:sweepPendingSubmissions",
      "commands/wallet-recover-submission.ts:recoverPendingSubmission",
      "lib/payment-responder.ts:sweepPendingSubmissions",
    ]);
    expect(calls.every((call) => call.fetchImpl === "dvmFetch")).toBe(true);
  });
});

describe("submission recovery through dvmFetch", () => {
  const originalFetch = globalThis.fetch;

  beforeAll(() => {
    writeWalletWithPendingSubmission();
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
    rmSync(configRoot, { recursive: true, force: true });
  });

  it("carries the 426 error dvmFetch raises through to the sweep outcome", async () => {
    globalThis.fetch = vi.fn(async () => new Response(UPGRADE_BODY, { status: 426 }));

    const { outcomes } = await sweepPendingSubmissions({ fetchImpl: dvmFetch });

    expect(outcomes).toHaveLength(1);
    const [outcome] = outcomes;
    expect(outcome.kind).toBe("still_pending");
    // The reason is the message `dvmFetch` raises for a 426, verbatim. A sweep
    // left on the package's own `fetch` never sees that error at all — it reads
    // the 426 as an ordinary response and reports the wire code
    // (`client_upgrade_required`) with none of the caller's upgrade guidance.
    expect(outcome).toMatchObject({
      reason: "network error: This request needs a newer dvm client.",
    });
  });
});
