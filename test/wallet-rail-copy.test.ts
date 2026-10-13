const exit = vi.hoisted(() => ({ advance: vi.fn() }));
vi.mock("@dvmkit/sdk/internal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@dvmkit/sdk/internal")>()),
  advanceTempoChannelExit: exit.advance,
}));

import { CONFIG_FILE, createTempoChannelStore, deriveIdentityFromPrivkey } from "@dvmkit/sdk/internal";
import { rmSync } from "node:fs";
import { ensureConfig } from "../src/lib/identity";
import { walletMppExit } from "../src/commands/wallet-mpp";

import { DvmError } from "@dvmkit/sdk/internal";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RailProbe } from "../src/lib/wallet-probe";
type ProbeRail = RailProbe["rail"];
import {
  TEMPO_EXIT_KEY_MISSING_HINT,
  tempoKeyImportRoutes,
  unreachableRailDisplay,
  unreachableRailHint,
} from "../src/lib/wallet-rail-copy";

function unreachable(rail: ProbeRail): RailProbe {
  return { rail, configured: true, reachable: false };
}

describe("unreachableRailHint", () => {
  it("gives Tempo a remedy that works for a rail already configured", () => {
    const hint = unreachableRailHint(unreachable("tempo"));

    expect(hint).toContain("DVM_TEMPO_RPC_URL");
    // This fallback is reached only with a usable key stored, where a
    // re-connect is refused (`tempo_wallet_exists`) and fixes nothing. The
    // state where reconnecting *is* the fix carries its own hint from
    // `probeMpp` — see the `defers to a probe's own diagnosis` case below.
    expect(hint).not.toContain("tempo-connect");
  });

  it("defers to a probe's own diagnosis when it carries one", () => {
    const rail: RailProbe = {
      ...unreachable("tempo"),
      error: { code: "tempo_unreachable", message: "no answer", hint: "Do this instead." },
    };
    expect(unreachableRailHint(rail)).toBe("Do this instead.");
  });
});

describe("tempoKeyImportRoutes", () => {
  it.each([
    [true, "'dvm wallet tempo-connect --key-file <path> --force', or DVM_TEMPO_KEY=<key> dvm wallet tempo-connect --force"],
    [false, "'dvm wallet tempo-connect --key-file <path>', or DVM_TEMPO_KEY=<key> dvm wallet tempo-connect"],
  ] as const)("gives the exact key-import routes (replacingConnectedKey=%s)", (replacing, expected) => {
    expect(tempoKeyImportRoutes({ replacingConnectedKey: replacing })).toBe(expected);
  });

  it("builds the shared exit-key-missing hint off the keyless routes", () => {
    expect(TEMPO_EXIT_KEY_MISSING_HINT).toContain(
      "'dvm wallet tempo-connect --key-file <path>', or DVM_TEMPO_KEY=<key> dvm wallet tempo-connect"
    );
    expect(TEMPO_EXIT_KEY_MISSING_HINT).not.toContain("--api-key");
    expect(TEMPO_EXIT_KEY_MISSING_HINT).not.toContain("--force");
  });
});

// NIP-47 has two rejections, and "not reachable" is wrong for both —
// the wallet answered. It is wrong in opposite directions, too: one connection
// has to be recreated, the other exists and needs a permission or a bigger cap.
describe("a wallet that answered and refused", () => {
  function rejected(code: string): RailProbe {
    return { ...unreachable("lightning"), error: { code, message: "refused" } };
  }

  it("does not call a revoked connection an unreachable rail", () => {
    const display = unreachableRailDisplay(rejected("float_unauthorized"));
    expect(display).not.toContain("not reachable");
    expect(display).toContain("no longer recognises");
  });

  it("says a restricted connection is recognised, so nobody recreates it", () => {
    const display = unreachableRailDisplay(rejected("float_connection_restricted"));
    expect(display).not.toContain("not reachable");
    expect(display).toContain("recognises this connection");
    expect(display).not.toBe(unreachableRailDisplay(rejected("float_unauthorized")));
  });

  it("still calls a genuinely silent wallet unreachable", () => {
    expect(unreachableRailDisplay(rejected("float_wallet_offline"))).toContain("not reachable");
  });
});


describe("Tempo exit recovery commands", () => {
  const endpoint = "https://tempo-exit.example";
  const callerKey = "11".repeat(32);
  afterEach(() => { vi.unstubAllEnvs(); exit.advance.mockReset(); });

  async function refusal(error: DvmError, connected: boolean): Promise<DvmError> {
    vi.stubEnv("DVM_IDENTITY_KEY", callerKey);
    rmSync(CONFIG_FILE, { force: true });
    await ensureConfig(connected ? { tempo: { method: "tempo", apiKey: `0x${"88".repeat(32)}`, network: "moderato" } } : {});
    const caller = deriveIdentityFromPrivkey(callerKey);
    await createTempoChannelStore({ endpoint, callerPubkey: caller.pubkey, creditId: "credit-exit-copy" }).set({
      channelId: `0x${"11".repeat(32)}`,
      cumulativeAmount: 25_000n,
      deposit: 100_000n,
      descriptor: { payee: `0x${"22".repeat(20)}`, token: `0x${"33".repeat(20)}`, salt: `0x${"44".repeat(32)}` },
      escrow: `0x${"55".repeat(20)}`,
      chainId: 42431,
      opened: true,
    } as never);
    exit.advance.mockRejectedValue(error);
    try {
      await walletMppExit(endpoint, { creditId: "credit-exit-copy", abandon: !connected });
      expect.unreachable("exit should refuse");
    } catch (caught) {
      expect(caught).toBeInstanceOf(DvmError);
      return caught as DvmError;
    }
  }

  it("names safe replacement routes and abandonment for a foreign payer", async () => {
    const original = new DvmError("tempo_wallet_mismatch", "Connected payer A differs from recorded payer B", "Shared neutral remedy", { anchor: "tempo_channel_payer_mismatch", recorded_payer: "B", connected_payer: "A" }, "Payer mismatch");
    const caught = await refusal(original, true);
    expect(caught.code).toBe("tempo_wallet_mismatch");
    expect(caught.message).toBe(original.message);
    expect(caught.data).toEqual(original.data);
    expect(caught.display).toBe(original.display);
    expect(caught.hint).toContain("--abandon");
    expect(caught.hint).not.toContain("--api-key");
    expect(caught.hint).toContain("dvm wallet tempo-connect --key-file <path> --force");
    expect(caught.hint).toContain("DVM_TEMPO_KEY=<key> dvm wallet tempo-connect --force");
  });

  it("names the opening key without replacement when keyless abandonment meets collateral", async () => {
    const caught = await refusal(new DvmError("tempo_channel_on_chain", "Collateral remains", "Shared neutral remedy"), false);
    expect(caught.hint).toContain("Reconnect the key that opened this channel");
    expect(caught.hint).not.toContain("--api-key");
    expect(caught.hint).toContain("dvm wallet tempo-connect --key-file <path>");
    expect(caught.hint).toContain("DVM_TEMPO_KEY=<key> dvm wallet tempo-connect");
    expect(caught.hint).not.toContain("--force");
  });

  it("uses the caller key-missing remedy when the SDK exit requires signing", async () => {
    const caught = await refusal(new DvmError("tempo_wallet_missing", "Signing key missing", "Shared neutral remedy"), true);
    expect(caught.code).toBe("tempo_wallet_missing");
    expect(caught.hint).toBe(TEMPO_EXIT_KEY_MISSING_HINT);
    expect(caught.hint).not.toContain("--api-key");
  });
});
