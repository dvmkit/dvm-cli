vi.mock("../src/lib/payment-rails/tempo-wallet", async () => ({ ...(await vi.importActual<typeof import("../src/lib/payment-rails/tempo-wallet")>("../src/lib/payment-rails/tempo-wallet")), connectedTempoAccount: seams.connectedTempoAccount }));
import { DvmError } from "@dvmkit/sdk/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const seams = vi.hoisted(() => ({
  connectedTempoAccount: vi.fn(),
  fundTempoFromFaucet: vi.fn(),
  json: vi.fn(),
}));

vi.mock("@dvmkit/sdk/internal", async (importOriginal) => ({ ...(await importOriginal<typeof import("@dvmkit/sdk/internal")>()),
connectedTempoAccount: seams.connectedTempoAccount }));
vi.mock("../src/lib/output", async () => ({ ...(await vi.importActual<typeof import("../src/lib/output")>("../src/lib/output")), json: seams.json }));

vi.mock("../src/lib/tempo-faucet", () => ({
  fundTempoFromFaucet: seams.fundTempoFromFaucet,
}));

import { walletFund } from "../src/commands/wallet-agent-fund";
import { catchErrors } from "../src/lib/error-handler";

class ExitSignal extends Error {
  constructor(readonly code: number | undefined) {
    super("process.exit");
  }
}

describe("dvm wallet fund on Tempo Moderato", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seams.connectedTempoAccount.mockResolvedValue({
      method: "tempo",
      apiKey: `0x${"22".repeat(32)}`,
      address: "0x1111111111111111111111111111111111111111",
      network: "moderato",
    });
    seams.fundTempoFromFaucet.mockResolvedValue({
      before: { usdc: 2, rawBaseUnits: 2_000_000n },
      after: { usdc: 1_000_002, rawBaseUnits: 1_000_002_000_000n },
      grantedBaseUnits: 1_000_000_000_000n,
      granted: 1_000_000,
      attempts: 2,
    });
  });

  afterEach(() => {
    process.exitCode = undefined;
  });

  it("reports the observed grant separately from the requested workflow amount", async () => {
    await walletFund("$1", { rail: "tempo" });

    expect(seams.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "faucet_funded",
        rail: "tempo",
        network: "moderato",
        network_label: "Tempo Testnet (Moderato)",
        chain_id: 42431,
        requested_usd: 1,
        requested_amount_role: "workflow_selection_only",
        faucet_granted_atomic: "1000000000000",
        faucet_granted_amount: 1_000_000,
        balance_after: 1_000_002,
        poll_attempts: 2,
        hint: expect.stringContaining("did not size the faucet grant"),
      })
    );
  });

  it("emits an actionable CLI error instead of claiming an invalid reply funded the wallet", async () => {
    seams.fundTempoFromFaucet.mockRejectedValueOnce(
      new DvmError(
        "tempo_faucet_outcome_unknown",
        "The Tempo faucet returned an invalid JSON-RPC response, so the funding outcome is unknown.",
        "Do not request again blindly. Run 'dvm wallet balance' to check pathUSD (0x20c0000000000000000000000000000000000000) on Tempo Testnet (Moderato); the request may already have reached the faucet.",
        {
          status: "unknown",
          reason: "mismatched_id",
          network: "moderato",
          chain_id: 42431,
          token: "0x20c0000000000000000000000000000000000000",
        }
      )
    );
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new ExitSignal(code);
    }) as never);

    await expect(
      catchErrors(() => walletFund("$1", { rail: "tempo" }))
    ).rejects.toMatchObject({ code: 1 });

    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(seams.json).toHaveBeenCalledExactlyOnceWith({
      error: {
        code: "tempo_faucet_outcome_unknown",
        message:
          "The Tempo faucet returned an invalid JSON-RPC response, so the funding outcome is unknown.",
        hint: expect.stringMatching(/Do not request again blindly.*dvm wallet balance/),
        status: "unknown",
        reason: "mismatched_id",
        network: "moderato",
        chain_id: 42431,
        token: "0x20c0000000000000000000000000000000000000",
      },
    });

  });
});
