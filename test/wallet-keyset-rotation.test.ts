import {
  createNewMintKeys,
  Mint,
  serializeMintKeys,
  Wallet,
  type GetInfoResponse,
  type MintKeys,
  type MintKeyset,
} from "@cashu/cashu-ts";
import { describe, expect, it, vi } from "vitest";

const mintInfo: GetInfoResponse = {
  name: "rotation test mint",
  pubkey: "",
  version: "test",
  contact: [],
  nuts: {
    "4": {
      methods: [{ method: "bolt11", unit: "sat", min_amount: null, max_amount: null }],
      disabled: false,
    },
    "5": {
      methods: [{ method: "bolt11", unit: "sat", min_amount: null, max_amount: null }],
      disabled: false,
    },
  },
};

describe("cashu wallet keyset rotation", () => {
  it("rebinds new outputs to the active keyset after a mint refresh", async () => {
    const original = createNewMintKeys(8, new Uint8Array(32).fill(1));
    const replacement = createNewMintKeys(8, new Uint8Array(32).fill(2));
    let rotated = false;

    const mint = new Mint("https://rotation.example");
    vi.spyOn(mint, "getInfo").mockResolvedValue(mintInfo);
    vi.spyOn(mint, "getKeySets").mockImplementation(async () => ({
      keysets: rotated
        ? [keyset(original.keysetId, false), keyset(replacement.keysetId, true)]
        : [keyset(original.keysetId, true)],
    }));
    vi.spyOn(mint, "getKeys").mockImplementation(async () => ({
      keysets: rotated
        ? [keys(replacement.keysetId, serializeMintKeys(replacement.pubKeys))]
        : [keys(original.keysetId, serializeMintKeys(original.pubKeys))],
    }));

    const wallet = new Wallet(mint);
    await wallet.loadMint();
    expect(wallet.keysetId).toBe(original.keysetId);

    rotated = true;
    await wallet.loadMint(true);

    expect(wallet.keysetId).toBe(replacement.keysetId);
    const preview = await wallet.prepareMint("bolt11", 1, { quote: "rotation-quote" });
    expect(preview.keysetId).toBe(replacement.keysetId);
  });
});

function keyset(id: string, active: boolean): MintKeyset {
  return { id, unit: "sat", active, input_fee_ppk: 0 };
}

function keys(id: string, publicKeys: MintKeys["keys"]): MintKeys {
  return { id, unit: "sat", active: true, input_fee_ppk: 0, keys: publicKeys };
}
