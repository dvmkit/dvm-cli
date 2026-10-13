import { type PaymentRailKey } from "./rail-labels";
/**
 * Rail-specific onramp guidance for `dvm wallet setup`.
 *
 * Agents pay DVMs on one of three per-call rails — x402, Tempo, and Cashu.
 * This module is the single source of truth for the plain-language, "how do I
 * get from zero to a funded wallet" instructions surfaced by the setup flow,
 * so the rails overview and the per-rail walkthrough render from the same data
 * in both human and JSON output.
 *
 * Written for non-Bitcoiners: the Tempo and x402 paths assume no crypto
 * fluency, and every actionable step carries a concrete command or URL.
 */

import {
  resolveX402Asset,
  X402_DEFAULT_NETWORK
} from "@dvmkit/sdk/internal";

export const FUNDING_DOCS_URL = "https://dvmkit.com/docs/funding";

/**
 * The x402 walkthrough runs before any wallet is connected, so it describes the
 * default chain. Resolved rather than written out so the contract in the copy
 * can never drift from the one the balance read queries.
 */
const X402_DEFAULT_ASSET = resolveX402Asset();
const X402_ASSET_LABEL = X402_DEFAULT_ASSET?.label ?? "native USDC";
const X402_NETWORK_LABEL = X402_DEFAULT_ASSET?.networkLabel ?? "Base";
const X402_CONTRACT_NOTE = X402_DEFAULT_ASSET ? ` (contract ${X402_DEFAULT_ASSET.address})` : "";

export interface OnrampStep {
  /** Short label an agent can relay to a human (e.g. "Fund your wallet"). */
  display: string;
  command?: string;
  url?: string;
  /** Prose explanation tailored to users who may not know Bitcoin. */
  description: string;
}

/**
 * The per-call rails a caller can be walked onto, and so the `--rail` values
 * `dvm wallet setup` accepts.
 *
 * Derived from `PAYMENT_RAIL_KEYS` rather than written out, so a rail added
 * there widens this type and {@link ONRAMPS_BY_RAIL} stops type-checking until
 * it has an onramp. `cashu_p2pk` drops out because it is how a completed spend
 * names itself, not a rail anyone chooses.
 */
export type OnrampRail = Exclude<PaymentRailKey, "cashu_p2pk">;

export interface RailOnramp {
  /** Canonical rail identifier used as the `--rail` flag value. */
  rail: OnrampRail;
  /**
   * Display title, in the rail-choice register: `<protocol name> — <what the
   * money is>`, e.g. "Cashu — Bitcoin / Lightning". The protocol name leads
   * deliberately and does not gloss — see the note on {@link ONRAMPS_BY_RAIL}.
   */
  title: string;
  summary: string;
  bestFor: string;
  /** Timeless custody, availability, or wrong-asset warning for this route. */
  warning: string;
  noBitcoinNeeded: boolean;
  setupCommand: string;
  verifyCommand: string;
  /** Stable guide for provider- and jurisdiction-dependent funding instructions. */
  docsUrl: string;
  steps: OnrampStep[];
}

/**
 * Onramp guidance keyed by rail, in display order.
 *
 * Keyed rather than a bare array so the table is exhaustive by construction: a
 * rail added to `PAYMENT_RAIL_KEYS` is a missing-property error right here,
 * rather than a menu that silently can't walk anyone onto it. Each value's
 * `rail` field is pinned to its own key by the mapped type, so the two can't
 * disagree either.
 *
 * The titles lead with the protocol name — `Cashu`, not `ecash` — and that is
 * the one caller-facing place where they should. This is a rail *choice*, the
 * carve-out  wrote into the payment-language rule: a caller meets
 * protocol terms when choosing a rail, troubleshooting, or managing custody.
 * The name is what identifies the row to someone who already holds that money,
 * and it is the `--rail` value they type next; the plain language rides in the
 * second half of the title, after the dash. Everything downstream of the
 * choice glosses through `rail-labels.ts` instead, which is why a
 * `grep railLabel` sweep finds nothing here.
 */
export const ONRAMPS_BY_RAIL: { [K in OnrampRail]: RailOnramp & { rail: K } } = {
  tempo: {
    rail: "tempo",
    title: "Tempo — US dollars",
    summary: "Pay in the configured dollar token on Tempo. No Bitcoin needed.",
    bestFor:
      "Best when your current provider can withdraw the configured Tempo asset directly, or you already hold dollars you can bridge.",
    warning:
      "Tempo carries several dollar tokens. Fund only the contract named in the local facts; another dollar token is real money but reads as $0.00 here.",
    noBitcoinNeeded: true,
    setupCommand: "dvm wallet tempo-connect",
    verifyCommand: "dvm wallet balance",
    docsUrl: FUNDING_DOCS_URL,
    steps: [
      {
        display: "Create your Tempo wallet and funding handoff",
        command: "dvm wallet tempo-connect",
        description:
          "Creates or reuses a Tempo wallet, then returns the exact address for standalone copy and a separate QR. The local facts name the configured settlement contract rather than assuming a token.",
      },
      {
        display: "Choose a funding route from your starting point",
        url: FUNDING_DOCS_URL,
        description:
          "Use the maintained funding guide for provider and regional availability. Before moving money, verify that the source can withdraw the exact configured token directly to Tempo, or use a route that converts into it.",
      },
      {
        display: "Fund the configured address",
        description:
          "Send the exact token contract named in the local facts to the printed address on Tempo. A similarly named dollar at another contract will not be spendable by this wallet.",
      },
      {
        display: "Confirm your balance",
        command: "dvm wallet balance",
        description:
          "Run after the transfer confirms. A zero balance can mean the wallet holds a different Tempo token; the balance output names the contract this wallet reads.",
      },
    ],
  },
  x402: {
    rail: "x402",
    title: `x402 — US dollars (${X402_ASSET_LABEL} on ${X402_NETWORK_LABEL})`,
    summary: `Pay in ${X402_ASSET_LABEL} on ${X402_NETWORK_LABEL}. No Bitcoin needed.`,
    bestFor: `Best when your current provider can withdraw ${X402_ASSET_LABEL} directly to ${X402_NETWORK_LABEL}.`,
    warning: `Fund only the token and network named in the local facts. A bridged dollar or USDC on another chain reads as $0.00 here, and a generated wallet must be backed up before it holds more than pocket money.`,
    noBitcoinNeeded: true,
    setupCommand: "dvm wallet x402-connect",
    verifyCommand: "dvm wallet balance",
    docsUrl: FUNDING_DOCS_URL,
    steps: [
      {
        display: "Create your x402 wallet and funding handoff",
        command: "dvm wallet x402-connect",
        description: `Creates or reuses an EVM wallet and returns the exact address for standalone copy plus a separate QR. The private key is written to your dvm config and never printed. The default is ${X402_NETWORK_LABEL} (${X402_DEFAULT_NETWORK}); the local facts name the chain actually configured.`,
      },
      {
        display: "Choose a funding route from your starting point",
        url: FUNDING_DOCS_URL,
        description:
          "Use the maintained funding guide for provider and regional availability. Before moving money, verify that the source can withdraw the exact token directly to the network named in the local facts.",
      },
      {
        display: "Fund the configured address",
        description: `Send the exact token named in the local facts to the printed address on the resolved network. ${X402_ASSET_LABEL}${X402_CONTRACT_NOTE} is the default on ${X402_NETWORK_LABEL}; the emitted contract and network are authoritative for this machine.`,
      },
      {
        display: "Confirm your balance",
        command: "dvm wallet balance",
        description:
          "Run after the transfer confirms. A zero balance can mean the wallet holds a different token or the right token on another chain; the balance output names what this wallet reads.",
      },
    ],
  },
  cashu: {
    rail: "cashu",
    title: "Cashu — Bitcoin / Lightning",
    summary: "Privacy-focused ecash funded over Lightning.",
    bestFor:
      "Best when payment privacy matters enough to accept third-party mint custody and availability risk.",
    warning:
      "Third-party mints are custodial and may be unavailable. Run mint-health before funding, keep only pocket money, and use this route only if you accept that trade-off.",
    noBitcoinNeeded: false,
    setupCommand: "dvm wallet init",
    verifyCommand: "dvm wallet mint-health && dvm wallet balance",
    docsUrl: FUNDING_DOCS_URL,
    steps: [
      {
        display: "Create your dvmkit ecash wallet",
        command: "dvm wallet init",
        description:
          "Generates a 12-word recovery phrase and the local wallet. Write the words down; they are the root for recovering wallet keys.",
      },
      {
        display: "Add a mint and check it before funding",
        command: "dvm wallet mint-add <url> && dvm wallet mint-health",
        description:
          "Choose a mint from the maintained funding guide, add it, and require a healthy preflight before sending money. A mint holds the underlying Bitcoin and can become unavailable.",
      },
      {
        display: "Fund with a small Lightning payment",
        command: "dvm wallet fund '$10'",
        description:
          "Creates a Lightning invoice and mints matching ecash after it is paid. Keep the mint-trust window and balance small.",
      },
      {
        display: "Confirm mint health and balance",
        command: "dvm wallet mint-health && dvm wallet balance",
        description:
          "Verify the mint still answers and the minted balance arrived before relying on the wallet.",
      },
    ],
  },
};

/**
 * Onramp guidance for every per-call rail, in display order.
 *
 * Rendered from {@link ONRAMPS_BY_RAIL}, whose insertion order is the display
 * order — so there is no second list to keep in step with the first.
 */
export const RAIL_ONRAMPS: RailOnramp[] = Object.values(ONRAMPS_BY_RAIL);

export function getRailOnramp(rail: string): RailOnramp | undefined {
  return RAIL_ONRAMPS.find((r) => r.rail === rail);
}
