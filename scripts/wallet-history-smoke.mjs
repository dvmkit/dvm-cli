import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

export async function verifyWalletHistory(packageRoot, expectedSdkVersion) {
  const started = Date.now();
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(import.meta.url),
      "--fixture",
      packageRoot,
      expectedSdkVersion,
    ],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  // Store failures privately: SDK diagnostics and assertions can contain signed
  // fixture artifacts, which must not reach publication logs.
  if (result.error || result.status !== 0) {
    const diagnostics = mkdtempSync(join(tmpdir(), "dvm-history-diagnostics-"));
    writeFileSync(
      join(diagnostics, "fixture.log"),
      `${result.stdout ?? ""}${result.stderr ?? ""}`,
      { mode: 0o600 },
    );
    throw new Error(
      "Installed wallet history fixture failed; diagnostics retained privately.",
    );
  }
  console.log(
    `installed wallet history ok: SDK ${expectedSdkVersion}; 12 refunds, 12 losses, old spending, ties/pages/filters, native unknowns, offline export, active/legacy recovery, crash deduplication/provider isolation, strict nested schema/atomic export, active aliases (${((Date.now() - started) / 1000).toFixed(1)}s)`,
  );
}

async function fixture(packageRoot, expectedSdkVersion) {
  const manifest = JSON.parse(
    readFileSync(join(packageRoot, "package.json"), "utf8"),
  );
  assert.equal(manifest.dependencies["@dvmkit/sdk"], expectedSdkVersion);
  const root = mkdtempSync(join(tmpdir(), "dvm-wallet-history-"));
  process.env.DVM_CONFIG_DIR = root;
  const loader = join(packageRoot, ".wallet-history-fixture.mjs");
  writeFileSync(loader, 'export * from "@dvmkit/sdk/internal";\n');
  const binary = join(packageRoot, "dist", "dvm.js");
  const run = (args, allowFailure = false) =>
    cli(binary, root, args, allowFailure);
  try {
    const initialized = JSON.parse((await run(["init"])).stdout);
    const sdk = await import(pathToFileURL(loader).href);
    rmSync(loader);
    const caller = initialized.identity.pubkey;
    const builderSecret = "11".repeat(32);
    const builderPubkey = sdk.receiptPubkeyFromSecret(builderSecret);
    const dvmId = "history-fixture";
    const key = sdk.deriveReceiptKeypair(builderSecret, dvmId);
    const attestation = sdk.buildAttestation({
      dvmId,
      slug: "example",
      capabilities: ["work"],
      builderPubkey,
      receiptPubkey: key.pubkey,
      deployedAt: 1_700_000_000,
    });
    const anchor = {
      pubkey: builderPubkey,
      attestation,
      signature: sdk.signAttestation(attestation, builderSecret),
    };
    const endpoint = "https://history.example";
    const timestamp = 1_700_000_000_000;
    sdk.appendBudgetSpend(sdk.BUDGET_FILE, {
      jobId: "old-spend",
      providerEndpoint: endpoint,
      msats: 10_000,
      btcRate: 100_000,
      now: new Date(timestamp - 100 * 86_400_000),
    });
    sdk.appendBudgetSpend(sdk.BUDGET_FILE, {
      jobId: "fund",
      kind: "credit_fund",
      providerEndpoint: endpoint,
      msats: 20_000,
      btcRate: 100_000,
      now: new Date(timestamp),
    });
    sdk.ensureProvisionalCredit({
      endpoint,
      callerPubkey: caller,
      creditId: "credit",
      currency: "eur",
      targetMicro: 3_000_000,
      now: timestamp,
    });
    for (let index = 0; index < 12; index++) {
      const drainId = `refund-${String(index).padStart(2, "0")}`;
      const receipt = sdk.signDrainReceipt(
        {
          v: 1,
          kind: "credit_drain",
          credit_id: "credit",
          drain_id: drainId,
          event: "sent",
          method: "x402",
          amount_micro: 321,
          balance_after_micro: 0,
          ledger_seq: index + 1,
          issued_at: timestamp / 1000,
          caller_pubkey: caller,
          dvm_id: dvmId,
          dvm: "example",
          receipt_pubkey: key.pubkey,
        },
        key.secret,
      );
      sdk.recordDrainReceipts({
        endpoint,
        callerPubkey: caller,
        drainId,
        creditId: "credit",
        receipts: [receipt],
        read: { reachable: true, anchor },
        now: timestamp,
      });
      sdk.settleDrainEvidence({
        endpoint,
        callerPubkey: caller,
        drainId,
        settlement:
          index === 0
            ? { rail: null, currency: null, amountMicro: null, feeMicro: null }
            : { rail: "x402", currency: "eur", amountMicro: 321, feeMicro: 7 },
        now: timestamp,
      });
      const creditId = `imp:cashu:loss-${index}`;
      sdk.applyImplicitReceiptCredit({
        endpoint,
        callerPubkey: caller,
        jobId: `failed-${index}`,
        outcome: "failed",
        credit: {
          credit_id: creditId,
          draw_id: `draw-${index}`,
          amount: 123,
          balance_after: 123,
          ledger_seq: 1,
        },
        currency: "usd",
        issuedAtMs: timestamp,
        now: timestamp,
      });
      sdk.markImplicitCreditLost({
        endpoint,
        callerPubkey: caller,
        creditId,
        reason: "not_found",
        now: timestamp,
      });
    }
    const pending = {
      drainId: "owed",
      creditId: "credit",
      method: "tempo",
      payout: {},
      requestedAt: timestamp,
      mppCredential: "fixture-recovery-secret",
    };
    sdk.recordPendingDrain(endpoint, caller, pending);
    sdk.recordDrainReceipts({
      endpoint,
      callerPubkey: caller,
      drainId: "owed",
      creditId: "credit",
      receipts: [
        sdk.signDrainReceipt(
          {
            v: 1,
            kind: "credit_drain",
            credit_id: "credit",
            drain_id: "owed",
            event: "requested",
            method: "tempo",
            amount_micro: 321,
            balance_after_micro: 0,
            ledger_seq: 99,
            issued_at: timestamp / 1000,
            caller_pubkey: caller,
            dvm_id: dvmId,
            dvm: "example",
            receipt_pubkey: key.pubkey,
          },
          key.secret,
        ),
      ],
      read: { reachable: true, anchor },
      now: timestamp,
    });
    const baseline = readFileSync(join(root, "config.json"));
    const history = JSON.parse((await run(["wallet", "history"])).stdout);
    assert.equal(history.count, 27);
    assert.equal(
      history.entries.filter((row) => row.kind === "completed_refund").length,
      12,
    );
    assert.equal(
      history.entries.filter((row) => row.kind === "expired_credit_loss")
        .length,
      12,
    );
    assert.equal(
      history.entries.filter((row) => row.kind === "active_recovery").length,
      1,
    );
    assert.equal(
      history.entries.find((row) => row.job_id === "old-spend").currency,
      null,
    );
    assert.equal(history.total_usd, 0.03);
    assert.equal(history.window.retention_days, null);
    assert.ok(!JSON.stringify(history).includes(pending.mppCredential));
    const humanResult = await run(["wallet", "history", "--human"]);
    const human = humanResult.stdout + humanResult.stderr;
    assert.match(human, /refund completed/);
    assert.match(human, /credit expired\/lost/);
    assert.match(human, /recovery pending/);
    assert.match(human, /BTC-equivalent budget valuation/);
    const pages = [];
    let cursor;
    do {
      const page = JSON.parse(
        (
          await run([
            "wallet",
            "history",
            "--limit",
            "5",
            ...(cursor ? ["--cursor", cursor] : []),
          ])
        ).stdout,
      );
      pages.push(...page.entries);
      cursor = page.next_cursor;
    } while (cursor !== null);
    // Equal-time order has an independent lexical descending tie contract.
    const tied = history.entries.filter(
      (row) => Date.parse(row.timestamp) === timestamp,
    );
    assert.deepEqual(
      tied.map((row) => row.id),
      tied
        .map((row) => row.id)
        .sort()
        .reverse(),
    );
    assert.deepEqual(
      pages.map((row) => row.id),
      history.entries.map((row) => row.id),
    );
    const filtered = JSON.parse(
      (
        await run([
          "wallet",
          "history",
          "--endpoint",
          endpoint + "/path",
          "--kind",
          "completed_refund",
          "--since",
          new Date(timestamp).toISOString(),
        ])
      ).stdout,
    );
    assert.equal(filtered.count, 12);
    assert.equal(filtered.total_usd, 0);
    const other = JSON.parse(
      (await run(["wallet", "history", "--endpoint", "https://other.example"]))
        .stdout,
    );
    assert.equal(other.count, 0);
    const receipts = JSON.parse(
      (await run(["credit", "receipts", endpoint])).stdout,
    );
    assert.equal(receipts.drains_total, 13);
    assert.equal(
      receipts.drains.filter((row) => row.outcome === "refunded").length,
      12,
    );
    assert.equal(
      receipts.drains.filter((row) => row.outcome === "pending").length,
      1,
    );
    const exported = (
      await run(["credit", "receipts", endpoint, "--export", "--refetch"])
    ).stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(exported.length, 13);
    for (const bundle of exported.filter(
      (bundle) => bundle.outcome === "refunded",
    )) {
      assert.equal(bundle.credit_id, "credit");
      assert.equal(bundle.settled_at, timestamp);
      assert.equal(bundle.collected_at, timestamp);
      assert.equal(
        bundle.verification.verdict,
        "verified",
        JSON.stringify(bundle.verification.checked),
      );
      assert.equal(bundle.provenance.settlement, "local_observation");
      assert.equal(
        sdk.verifyDrainReceiptChain({
          receipt: bundle.receipts[0],
          builder: bundle.builder,
          expectedCreditId: bundle.credit_id,
          expectedDrainId: bundle.drain_id,
        }).status,
        "verified",
      );
      if (bundle.drain_id === "refund-00")
        assert.deepEqual(
          [bundle.rail, bundle.currency, bundle.amount_micro, bundle.fee_micro],
          ["x402", null, 321, null],
        );
      else
        assert.deepEqual(
          [bundle.rail, bundle.currency, bundle.amount_micro, bundle.fee_micro],
          ["x402", "eur", 321, 7],
        );
      const tampered = { ...bundle.receipts[0], amount_micro: 999 };
      assert.equal(
        sdk.verifyDrainReceiptChain({
          receipt: tampered,
          builder: bundle.builder,
          expectedCreditId: bundle.credit_id,
          expectedDrainId: bundle.drain_id,
        }).status,
        "invalid",
      );
    }
    assert.ok(!JSON.stringify(exported).includes(pending.mppCredential));
    assert.ok(!JSON.stringify(exported).includes("mppCredential"));
    const selected = (
      await run([
        "credit",
        "receipts",
        endpoint,
        "--drain-id",
        "refund-00",
        "--export",
      ])
    ).stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(selected.length, 1);
    assert.equal(selected[0].drain_id, "refund-00");
    const firstPage = JSON.parse(
      (await run(["wallet", "history", "--limit", "5"])).stdout,
    );
    sdk.appendBudgetSpend(sdk.BUDGET_FILE, {
      jobId: "new-spend",
      providerEndpoint: endpoint,
      msats: 1000,
      btcRate: 100_000,
      now: new Date(timestamp + 1000),
    });
    const stale = await run(
      ["wallet", "history", "--cursor", firstPage.next_cursor],
      true,
    );
    assert.notEqual(stale.code, 0);
    assert.equal(JSON.parse(stale.stdout).error.code, "invalid_history_cursor");
    const changedFilter = await run(
      ["wallet", "history", "--cursor", firstPage.next_cursor, "--kind", "job"],
      true,
    );
    assert.equal(
      JSON.parse(changedFilter.stdout).error.code,
      "invalid_history_cursor",
    );
    const journal = readFileSync(join(root, "credits-history.jsonl"));
    sdk.recordDrainReceipts({
      endpoint,
      callerPubkey: caller,
      drainId: "owed",
      creditId: "credit",
      receipts: [{ mppCredential: pending.mppCredential }],
      read: { reachable: false },
      now: timestamp,
    });
    const unsafe = await run(
      ["credit", "receipts", endpoint, "--export"],
      true,
    );
    assert.notEqual(unsafe.code, 0);
    assert.equal(JSON.parse(unsafe.stdout).error.code, "unsafe_receipt_export");
    assert.ok(!unsafe.stdout.includes(pending.mppCredential));
    const pendingReceipt = sdk.signDrainReceipt(
      {
        v: 1,
        kind: "credit_drain",
        credit_id: "credit",
        drain_id: "owed",
        event: "requested",
        method: "tempo",
        amount_micro: 321,
        balance_after_micro: 0,
        ledger_seq: 99,
        issued_at: timestamp / 1000,
        caller_pubkey: caller,
        dvm_id: dvmId,
        dvm: "example",
        receipt_pubkey: key.pubkey,
      },
      key.secret,
    );
    sdk.recordDrainReceipts({
      endpoint,
      callerPubkey: caller,
      drainId: "owed",
      creditId: "credit",
      receipts: [pendingReceipt],
      read: {
        reachable: true,
        anchor: {
          ...anchor,
          attestation: {
            ...anchor.attestation,
            recovery_secret: pending.mppCredential,
          },
        },
      },
      now: timestamp,
    });
    const unsafeAnchor = await run(
      ["credit", "receipts", endpoint, "--export", "--drain-id", "owed"],
      true,
    );
    assert.notEqual(unsafeAnchor.code, 0);
    assert.equal(
      JSON.parse(unsafeAnchor.stdout).error.code,
      "unsafe_receipt_export",
    );
    assert.ok(!unsafeAnchor.stdout.includes(pending.mppCredential));
    assert.equal(
      sdk.loadCredit(endpoint, caller).pendingDrains[0].mppCredential,
      pending.mppCredential,
    );
    assert.equal(
      readFileSync(join(root, "credits-history.jsonl")).equals(journal),
      true,
    );
    assert.equal(
      readFileSync(join(root, "config.json")).equals(baseline),
      true,
    );
    // A legacy record with absent collection time and no current credit must
    // still seed a durable refund and export without inventing time/currency.
    const legacyRoot = mkdtempSync(join(tmpdir(), "dvm-history-legacy-"));
    try {
      writeFileSync(join(legacyRoot, "config.json"), baseline);
      // Signing identity is stored by init; copy its separate store if present.
      for (const file of ["identities.json", "identity.json"]) {
        try {
          writeFileSync(join(legacyRoot, file), readFileSync(join(root, file)));
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      }
      const stored = sdk.loadCredit(endpoint, caller);
      const legacy = {
        ...stored,
        pendingDrains: undefined,
        pendingDrain: undefined,
        drainEvidence: [
          {
            drainId: "legacy",
            creditId: "prior-credit",
            collectedAt: 0,
            settledAt: timestamp,
            receipts: [],
          },
        ],
      };
      writeFileSync(
        join(legacyRoot, "credits.json"),
        JSON.stringify({ credits: [legacy] }),
      );
      const result = await cli(binary, legacyRoot, [
        "credit",
        "receipts",
        endpoint,
        "--export",
      ]);
      const bundle = JSON.parse(result.stdout);
      assert.equal(bundle.credit_id, "prior-credit");
      assert.equal(bundle.collected_at, null);
      assert.equal(bundle.currency, null);
      assert.equal(bundle.fee_micro, null);
    } finally {
      rmSync(legacyRoot, { recursive: true, force: true });
    }
    await repairFixture(sdk, run, root, caller, timestamp);
    rmSync(join(root, "credits.json"));
    const archiveOnly = JSON.parse(
      (await run(["credit", "receipts", endpoint])).stdout,
    );
    assert.equal(archiveOnly.credit_id, null);
    assert.equal(archiveOnly.drains_total, 12);
    assert.equal(archiveOnly.receipts_verified, "verified");
    console.log(
      JSON.stringify({
        result: "PASS",
        records: history.count,
        verifiedRefunds: 12,
        configDigest: createHash("sha256").update(baseline).digest("hex"),
        offlineOnly: true,
      }),
    );
  } finally {
    rmSync(loader, { force: true });
    rmSync(root, { recursive: true, force: true });
  }
}

async function repairFixture(sdk, run, root, caller, timestamp) {
  const endpoint = "https://repair.example";
  const alias = "https://repair-alias.example";
  const otherEndpoint = "https://unrelated.example";
  const dvmId = "repair-service";
  const secret = "22".repeat(32);
  const builderPubkey = sdk.receiptPubkeyFromSecret(secret);
  const key = sdk.deriveReceiptKeypair(secret, dvmId);
  const attestation = sdk.buildAttestation({
    dvmId,
    slug: "repair",
    capabilities: ["work"],
    builderPubkey,
    receiptPubkey: key.pubkey,
    deployedAt: timestamp / 1000,
  });
  const anchor = {
    pubkey: builderPubkey,
    attestation,
    signature: sdk.signAttestation(attestation, secret),
  };
  const identity = { dvmId, builderPubkey };
  sdk.ensureProvisionalCredit({
    endpoint,
    identity,
    callerPubkey: caller,
    creditId: "shared-credit",
    currency: "eur",
    targetMicro: 1000,
    now: timestamp,
  });
  const makeReceipt = (amount, overrides = {}) =>
    sdk.signDrainReceipt(
      {
        v: 1,
        kind: "credit_drain",
        credit_id: "shared-credit",
        drain_id: "shared-drain",
        event: "sent",
        method: "tempo",
        amount_micro: amount,
        balance_after_micro: 0,
        ledger_seq: 1,
        issued_at: timestamp / 1000,
        caller_pubkey: caller,
        dvm_id: dvmId,
        dvm: "repair",
        receipt_pubkey: key.pubkey,
        ...overrides,
      },
      key.secret,
    );
  sdk.recordPendingDrain(endpoint, caller, {
    drainId: "shared-drain",
    creditId: "shared-credit",
    method: "tempo",
    payout: {},
    requestedAt: timestamp,
  });
  sdk.recordDrainReceipts({
    endpoint,
    callerPubkey: caller,
    creditId: "shared-credit",
    drainId: "shared-drain",
    receipts: [makeReceipt(111)],
    read: { reachable: true, anchor },
    now: timestamp,
  });
  const prior = readFileSync(join(root, "credits.json"));
  const terminal = makeReceipt(222);
  sdk.recordDrainReceipts({
    endpoint,
    callerPubkey: caller,
    creditId: "shared-credit",
    drainId: "shared-drain",
    receipts: [terminal],
    read: { reachable: true, anchor },
    now: timestamp + 1,
  });
  sdk.settleDrainEvidence({
    endpoint,
    callerPubkey: caller,
    drainId: "shared-drain",
    settlement: {
      rail: "tempo",
      currency: "eur",
      amountMicro: 222,
      feeMicro: 9,
    },
    now: timestamp + 2,
  });
  writeFileSync(join(root, "credits.json"), prior);
  for (const selection of [[], ["--drain-id", "shared-drain"]]) {
    const listed = JSON.parse(
      (await run(["credit", "receipts", endpoint, ...selection])).stdout,
    );
    assert.equal(
      listed.drains_total,
      1,
      "stale hot evidence must not duplicate the archived refund",
    );
    assert.equal(listed.drains[0].outcome, "refunded");
    const exported = JSON.parse(
      (await run(["credit", "receipts", endpoint, ...selection, "--export"]))
        .stdout,
    );
    assert.equal(exported.outcome, "refunded");
    assert.equal(exported.settled_at, timestamp + 2);
    assert.equal(exported.collected_at, timestamp + 1);
    assert.deepEqual(exported.receipts, [terminal]);
    assert.deepEqual(
      [
        exported.rail,
        exported.currency,
        exported.amount_micro,
        exported.fee_micro,
      ],
      ["tempo", "eur", 222, 9],
    );
  }
  sdk.loadCredit(alias, caller, identity);
  sdk.recordPendingDrain(endpoint, caller, {
    drainId: "alias-owed",
    creditId: "shared-credit",
    method: "tempo",
    payout: {},
    requestedAt: timestamp + 3,
  });
  const filtered = JSON.parse(
    (
      await run([
        "wallet",
        "history",
        "--kind",
        "active_recovery",
        "--endpoint",
        alias,
      ])
    ).stdout,
  );
  assert.deepEqual(
    filtered.entries.map((row) => row.drain_id),
    ["alias-owed"],
  );
  const excluded = JSON.parse(
    (
      await run([
        "wallet",
        "history",
        "--kind",
        "active_recovery",
        "--endpoint",
        "https://absent.example",
      ])
    ).stdout,
  );
  assert.equal(excluded.count, 0);
  const aliasBundle = JSON.parse(
    (
      await run([
        "credit",
        "receipts",
        alias,
        "--drain-id",
        "shared-drain",
        "--export",
      ])
    ).stdout,
  );
  assert.deepEqual(aliasBundle.receipts, [terminal]);
  const sensitive = {
    job_token: "fixture-bearer-secret",
    raw_content: "fixture-private-job-content",
  };
  const unsafeDrainId = "unsafe-nested";
  for (const field of ["ledger_seq", "balance_after_micro"]) {
    for (const value of [sensitive, [sensitive]]) {
      const receipt = makeReceipt(222, {
        drain_id: unsafeDrainId,
        event: "requested",
        [field]: value,
      });
      sdk.recordDrainReceipts({
        endpoint,
        callerPubkey: caller,
        creditId: "shared-credit",
        drainId: unsafeDrainId,
        receipts: [receipt],
        read: { reachable: true, anchor },
        now: timestamp,
      });
      for (const selection of [[], ["--drain-id", unsafeDrainId]]) {
        const result = await run(
          ["credit", "receipts", endpoint, "--export", ...selection],
          true,
        );
        assert.notEqual(result.code, 0, `${field} must reject nested values`);
        // Parsing one error object also proves that no earlier bundle was emitted.
        assert.equal(
          JSON.parse(result.stdout).error.code,
          "unsafe_receipt_export",
        );
        assert.ok(!result.stdout.includes(sensitive.job_token));
        assert.ok(!result.stdout.includes(sensitive.raw_content));
      }
    }
  }
  const receipt = makeReceipt(222, {
    drain_id: unsafeDrainId,
    event: "requested",
  });
  for (const attestationValue of [
    {},
    [],
    { ...attestation, receipt_pubkey: sensitive },
    { ...attestation, deployed_at: [sensitive] },
    { ...attestation, capabilities_hash: [sensitive] },
  ]) {
    sdk.recordDrainReceipts({
      endpoint,
      callerPubkey: caller,
      creditId: "shared-credit",
      drainId: unsafeDrainId,
      receipts: [receipt],
      read: {
        reachable: true,
        anchor: { ...anchor, attestation: attestationValue },
      },
      now: timestamp,
    });
    const result = await run(
      ["credit", "receipts", endpoint, "--export"],
      true,
    );
    assert.notEqual(
      result.code,
      0,
      "identity artifacts must satisfy their complete schema",
    );
    assert.equal(JSON.parse(result.stdout).error.code, "unsafe_receipt_export");
    assert.ok(!result.stdout.includes(sensitive.job_token));
    assert.ok(!result.stdout.includes(sensitive.raw_content));
  }
  // The released SDK merges equal caller/credit IDs in two hot records. Keep
  // provider A only in its archive to exercise the consumer's service boundary.
  sdk.forgetCredit(endpoint, caller, identity);
  const otherIdentity = {
    dvmId,
    builderPubkey: sdk.receiptPubkeyFromSecret("33".repeat(32)),
  };
  sdk.ensureProvisionalCredit({
    endpoint: otherEndpoint,
    identity: otherIdentity,
    callerPubkey: caller,
    creditId: "shared-credit",
    currency: "usd",
    targetMicro: 1000,
    now: timestamp,
  });
  sdk.recordPendingDrain(otherEndpoint, caller, {
    drainId: "shared-drain",
    creditId: "shared-credit",
    method: "tempo",
    payout: {},
    requestedAt: timestamp + 3,
  });
  const otherKey = sdk.deriveReceiptKeypair("33".repeat(32), dvmId);
  const unsignedOther = makeReceipt(222, {
    event: "requested",
    receipt_pubkey: otherKey.pubkey,
  });
  delete unsignedOther.signature;
  sdk.recordDrainReceipts({
    endpoint: otherEndpoint,
    callerPubkey: caller,
    creditId: "shared-credit",
    drainId: "shared-drain",
    receipts: [sdk.signDrainReceipt(unsignedOther, otherKey.secret)],
    read: { reachable: false },
    now: timestamp,
  });
  const active = JSON.parse(
    (await run(["wallet", "history", "--kind", "active_recovery"])).stdout,
  );
  assert.ok(
    active.entries.some(
      (row) =>
        row.endpoint === otherEndpoint && row.drain_id === "shared-drain",
    ),
    "textual drain IDs cannot suppress another attested provider",
  );
  const unrelated = JSON.parse(
    (
      await run([
        "credit",
        "receipts",
        otherEndpoint,
        "--drain-id",
        "shared-drain",
        "--export",
      ])
    ).stdout,
  );
  assert.equal(unrelated.outcome, "pending");
}

function cli(binary, root, args, allowFailure = false) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [binary, ...args], {
      env: { ...process.env, DVM_CONFIG_DIR: root, LANG: "C", LC_ALL: "C" },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15_000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0 && !allowFailure)
        reject(
          new Error(
            `history command ${args.slice(0, 2).join(" ")} exited ${code}`,
          ),
        );
      else resolveRun({ code, stdout, stderr });
    });
  });
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  if (process.argv[2] === "--fixture")
    await fixture(resolve(process.argv[3]), process.argv[4]);
  else {
    const packageRoot = resolve(process.argv[2] ?? ".");
    const manifest = JSON.parse(
      readFileSync(join(packageRoot, "package.json"), "utf8"),
    );
    await verifyWalletHistory(
      packageRoot,
      manifest.dependencies["@dvmkit/sdk"],
    );
  }
}
