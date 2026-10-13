import { describe, expect, it } from "vitest";

import {
  inFlightTimeoutSeconds,
  markProofsInFlight,
  proofKey,
  revertInFlight,
  settleSpendSuccess,
  sweepStaleInFlight,
} from "../inflight";
import {
  type AgentProof,
  type AgentRecentSpend,
  type AgentWallet,
  RECENT_SPENDS_CAP,
  WALLET_VERSION,
} from "@dvmkit/sdk/internal";

function proof(secret: string, amount: number): AgentProof {
  return {
    mint: "https://mint.example",
    secret,
    C: "02" + "ff".repeat(32),
    amount,
    id: "k1",
    locked_to_pubkey: "02" + "ab".repeat(32),
    status: "valid",
  };
}

function baseWallet(proofs: AgentProof[]): AgentWallet {
  return {
    version: WALLET_VERSION,
    lock_privkey: "ab".repeat(32),
    lock_pubkey: "02" + "ab".repeat(32),
    mnemonic_fingerprint: null,
    mints: ["https://mint.example"],
    proofs,
    nut13_counters: {},
    pending_mints: [],
    pending_melts: [],
    pending_submissions: [],
    recent_spends: [],
    created_at: "2026-05-09T00:00:00.000Z",
  };
}

describe("agent wallet in-flight lifecycle", () => {
  describe("markProofsInFlight", () => {
    it("flips matching proofs to in_flight with the given until timestamp", () => {
      const w = baseWallet([proof("a", 1), proof("b", 2)]);
      const keys = new Set([proofKey(w.proofs[0])]);
      const next = markProofsInFlight(w, keys, 9999);
      expect(next.proofs[0].status).toBe("in_flight");
      expect(next.proofs[0].in_flight_until_ms).toBe(9999);
      expect(next.proofs[1].status).toBe("valid");
    });
  });

  describe("settleSpendSuccess", () => {
    it("removes spent proofs and appends a recent spend", () => {
      const w = baseWallet([proof("a", 1), proof("b", 2)]);
      const keys = new Set([proofKey(w.proofs[0])]);
      const spend: AgentRecentSpend = {
        request_id: "11111111-1111-4111-8111-111111111111",
        dvm_endpoint: "https://api.example.com",
        mint: "https://mint.example",
        amount_sats: 1,
        signed_at_ms: 100,
      };
      const next = settleSpendSuccess(w, keys, spend);
      expect(next.proofs).toHaveLength(1);
      expect(next.proofs[0].secret).toBe("b");
      expect(next.recent_spends).toEqual([spend]);
    });

    it("caps recent_spends to the most-recent RECENT_SPENDS_CAP entries", () => {
      const existing: AgentRecentSpend[] = Array.from({ length: RECENT_SPENDS_CAP }, (_, i) => ({
        request_id: `${"a".repeat(8)}-aaaa-4aaa-8aaa-${String(i).padStart(12, "0")}`,
        dvm_endpoint: "https://api.example.com",
        mint: "https://mint.example",
        amount_sats: i,
        signed_at_ms: i,
      }));
      const w = { ...baseWallet([]), recent_spends: existing };
      const newer: AgentRecentSpend = {
        request_id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        dvm_endpoint: "https://api.example.com",
        mint: "https://mint.example",
        amount_sats: 999,
        signed_at_ms: 999,
      };
      const next = settleSpendSuccess(w, new Set(), newer);
      expect(next.recent_spends).toHaveLength(RECENT_SPENDS_CAP);
      expect(next.recent_spends.at(-1)).toEqual(newer);
      expect(next.recent_spends[0].amount_sats).toBe(1);
    });
  });

  describe("revertInFlight", () => {
    it("flips in_flight back to valid + clears in_flight_until_ms", () => {
      const w = baseWallet([{ ...proof("a", 1), status: "in_flight", in_flight_until_ms: 5000 }]);
      const keys = new Set([proofKey(w.proofs[0])]);
      const next = revertInFlight(w, keys);
      expect(next.proofs[0].status).toBe("valid");
      expect(next.proofs[0].in_flight_until_ms).toBeUndefined();
    });

    it("is a no-op for proofs that are already valid", () => {
      const w = baseWallet([proof("a", 1)]);
      const keys = new Set([proofKey(w.proofs[0])]);
      const next = revertInFlight(w, keys);
      expect(next.proofs[0].status).toBe("valid");
    });
  });

  describe("sweepStaleInFlight", () => {
    it("reverts only proofs whose in_flight_until_ms is past nowMs", () => {
      const w = baseWallet([
        { ...proof("stale", 1), status: "in_flight", in_flight_until_ms: 100 },
        { ...proof("fresh", 1), status: "in_flight", in_flight_until_ms: 9999 },
        proof("plain", 1),
      ]);
      const result = sweepStaleInFlight(w, 500);
      expect(result.reverted).toBe(1);
      expect(result.wallet.proofs.find((p) => p.secret === "stale")?.status).toBe("valid");
      expect(result.wallet.proofs.find((p) => p.secret === "fresh")?.status).toBe("in_flight");
      expect(result.wallet.proofs.find((p) => p.secret === "plain")?.status).toBe("valid");
    });

    it("reverts in_flight proofs that lack an until timestamp (defensive)", () => {
      const w = baseWallet([{ ...proof("a", 1), status: "in_flight" }]);
      const result = sweepStaleInFlight(w, 0);
      expect(result.reverted).toBe(1);
      expect(result.wallet.proofs[0].status).toBe("valid");
    });

    it("never reclaims proofs committed to an open melt, however stale", () => {
      // A timeout says nothing about whether the mint paid the invoice. Handing
      // these back on a timer would offer the wallet proofs the mint may
      // already have consumed; only `sweepPendingMelts` may resolve them.
      const committed = { ...proof("melting", 64), status: "in_flight" as const };
      const w = {
        ...baseWallet([committed, { ...proof("stale", 1), status: "in_flight" as const }]),
        pending_melts: [
          {
            mint: "https://mint.example",
            quote_id: "q1",
            bolt11: "lnbc60",
            destination: "recipient@example.com",
            amount_sats: 60,
            fee_reserve_sats: 2,
            input_fee_sats: 2,
            input_proofs: [committed],
            created_at: "2026-05-09T00:00:00.000Z",
          },
        ],
      };

      const result = sweepStaleInFlight(w, 9e15);

      expect(result.reverted).toBe(1);
      expect(result.wallet.proofs.find((p) => p.secret === "melting")?.status).toBe("in_flight");
      expect(result.wallet.proofs.find((p) => p.secret === "stale")?.status).toBe("valid");
    });

    it("never reclaims proofs committed to a prepared swap, however stale", () => {
      const swapping = { ...proof("swapping", 8), status: "in_flight" as const };
      const w: AgentWallet = {
        ...baseWallet([swapping]),
        pending_submissions: [
          {
            endpoint: "https://api.example.com",
            request_id: "11111111-1111-4111-8111-111111111111",
            intended_lock_pubkey: "02" + "cc".repeat(32),
            mint: swapping.mint,
            amount_sats: 5,
            output_proofs: [],
            created_at: "2026-05-09T00:00:00.000Z",
            swapping: {
              keyset_id: "k1",
              input_proofs: [swapping],
              unselected_proofs: [],
              send_outputs: [],
              keep_outputs: [],
            },
          },
        ],
      };

      const result = sweepStaleInFlight(w, 9e15);

      expect(result.reverted).toBe(0);
      expect(result.wallet.proofs[0].status).toBe("in_flight");
    });

    it("is idempotent — running twice yields the same result", () => {
      const w = baseWallet([{ ...proof("a", 1), status: "in_flight", in_flight_until_ms: 1 }]);
      const r1 = sweepStaleInFlight(w, 100);
      const r2 = sweepStaleInFlight(r1.wallet, 100);
      expect(r2.reverted).toBe(0);
      expect(r2.wallet).toEqual(r1.wallet);
    });
  });

  describe("inFlightTimeoutSeconds env knob", () => {
    it("defaults to 60 when DVM_INFLIGHT_PROOF_TIMEOUT_SEC is unset", () => {
      const prev = process.env.DVM_INFLIGHT_PROOF_TIMEOUT_SEC;
      delete process.env.DVM_INFLIGHT_PROOF_TIMEOUT_SEC;
      try {
        expect(inFlightTimeoutSeconds()).toBe(60);
      } finally {
        if (prev !== undefined) process.env.DVM_INFLIGHT_PROOF_TIMEOUT_SEC = prev;
      }
    });

    it("respects a positive integer override", () => {
      const prev = process.env.DVM_INFLIGHT_PROOF_TIMEOUT_SEC;
      process.env.DVM_INFLIGHT_PROOF_TIMEOUT_SEC = "120";
      try {
        expect(inFlightTimeoutSeconds()).toBe(120);
      } finally {
        if (prev === undefined) delete process.env.DVM_INFLIGHT_PROOF_TIMEOUT_SEC;
        else process.env.DVM_INFLIGHT_PROOF_TIMEOUT_SEC = prev;
      }
    });

    it("falls back to default on garbage / non-positive values", () => {
      const prev = process.env.DVM_INFLIGHT_PROOF_TIMEOUT_SEC;
      process.env.DVM_INFLIGHT_PROOF_TIMEOUT_SEC = "abc";
      try {
        expect(inFlightTimeoutSeconds()).toBe(60);
        process.env.DVM_INFLIGHT_PROOF_TIMEOUT_SEC = "0";
        expect(inFlightTimeoutSeconds()).toBe(60);
        process.env.DVM_INFLIGHT_PROOF_TIMEOUT_SEC = "-1";
        expect(inFlightTimeoutSeconds()).toBe(60);
      } finally {
        if (prev === undefined) delete process.env.DVM_INFLIGHT_PROOF_TIMEOUT_SEC;
        else process.env.DVM_INFLIGHT_PROOF_TIMEOUT_SEC = prev;
      }
    });
  });
});
