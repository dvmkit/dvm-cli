import {
  DvmError,
  parseNwcUri,
  signRequestData,
} from "@dvmkit/sdk/internal";
import {
  type Config,
  loadConfig,
  updateConfig,
} from "../lib/identity";
import {
  info,
  json,
} from "../lib/output";
import {
  resolveSigningIdentity,
} from "../lib/cli-identity-resolve";
import { createHash, randomBytes } from "node:crypto";
import { hostname } from "node:os";

import { generateSecretKey, getPublicKey } from "nostr-tools/pure";

import { dvmFetch } from "../lib/http";
import {
  decryptWalletPairingEvent,
  encodeWalletPairingFragment,
  pairingFingerprint,
  pairingSessionCode,
  WALLET_PAIRING_POLL_JITTER_MS,
  WALLET_PAIRING_RETRY_AFTER_MS,
  WALLET_PAIRING_TTL_SECONDS,
  WALLET_PAIRING_VERSION,
  type WalletPairingEvent,
  type WalletPairingManifest,
} from "../lib/wallet-pairing";
import {
  cleanupExpiredWalletPairingStates,
  createWalletPairingState,
  deleteWalletPairingState,
  loadWalletPairingState,
  saveWalletPairingState,
  type WalletPairingState,
  withWalletPairingLock,
} from "../lib/wallet-pairing-store";
import {
  type ProbedWalletConnection,
  probeWalletConnection,
  walletConnectionFields,
} from "./wallet";

export interface WalletPairOptions {
  as?: string;
  human?: boolean;
}

export interface WalletPairCompleteOptions {
  wait?: boolean;
  confirmReplace?: string;
  human?: boolean;
}

/** Create a short-lived encrypted wallet pairing and return its private link immediately. */
export async function walletPair(options: WalletPairOptions): Promise<void> {
  cleanupExpiredWalletPairingStates();
  const config = loadConfig();
  if (!config) throw new DvmError("no_config", "No config found.", "Run: dvm init");
  const identity = resolveSigningIdentity({ as: options.as, config });
  const now = Math.floor(Date.now() / 1_000);
  const sessionId = randomBytes(32).toString("hex");
  const pollingVerifier = randomBytes(32).toString("hex");
  const recipientPrivateKey = generateSecretKey();
  const senderPrivateKey = generateSecretKey();
  const body = {
    purpose: "wallet_pairing",
    version: WALLET_PAIRING_VERSION,
    session_id: sessionId,
    recipient_pubkey: getPublicKey(recipientPrivateKey),
    sender_pubkey: getPublicKey(senderPrivateKey),
    polling_verifier_hash: sha256(pollingVerifier),
    claimed_hostname: safeHostname(hostname()),
    created_at: now,
    expires_at: now + WALLET_PAIRING_TTL_SECONDS,
    caller_pubkey: identity.pubkey,
  } as const;
  const manifest = signRequestData(identity.privkey, body, {
    timestamp: now,
  }) as WalletPairingManifest;
  const state: WalletPairingState = {
    version: 1,
    pairing_id: sessionId,
    recipient_private_key: bytesToHex(recipientPrivateKey),
    polling_verifier: pollingVerifier,
    manifest,
  };
  createWalletPairingState(state);
  try {
    await createRemoteSession(manifest);
  } catch (err) {
    deleteWalletPairingState(sessionId);
    throw err;
  }

  const url = `${webUrl()}/wallet-pair${encodeWalletPairingFragment({
    sessionId,
    senderPrivateKey: bytesToHex(senderPrivateKey),
  })}`;
  const command = `dvm wallet pair complete ${sessionId} --wait`;
  const sessionCode = pairingSessionCode(sessionId);
  const nextAction = {
    type: "open_wallet_pairing",
    url,
    pairing_id: sessionId,
    expires_at: new Date(manifest.expires_at * 1_000).toISOString(),
    session_code: sessionCode,
    identity_fingerprint: pairingFingerprint(identity.pubkey),
    display: `Open this short-lived private link on the device where you manage your wallet. Confirm that the page shows session code ${sessionCode} before entering anything. It contains a one-time upload capability, but no wallet credential.`,
    command,
    requires_user_approval: true,
  } as const;
  if (options.human) {
    info("Private wallet-pairing link (expires in 10 minutes):");
    info(url);
    info(`Session code: ${nextAction.session_code}`);
    info(`Then run: ${command}`);
  } else {
    json({
      status: "wallet_pairing_created",
      pairing_id: sessionId,
      expires_at: nextAction.expires_at,
      session_code: nextAction.session_code,
      identity_fingerprint: nextAction.identity_fingerprint,
      display: nextAction.display,
      next_action: nextAction,
    });
  }
}

/** Poll, decrypt, probe, and safely commit a submitted wallet credential. */
export async function walletPairComplete(
  pairingId: string,
  options: WalletPairCompleteOptions
): Promise<void> {
  await withWalletPairingLock(pairingId, async () => {
    const state = loadWalletPairingState(pairingId);
    if (state.commit) {
      const current = loadConfig();
      if (walletFingerprint(current?.nwcUri) === state.commit.candidate_wallet_fingerprint) {
        await acknowledgeRemote(state, state.commit.event_id);
        deleteWalletPairingState(pairingId);
        emitConnected(state.commit.candidate_facts, options.human);
        return;
      }
    }
    if (state.manifest.expires_at <= Math.floor(Date.now() / 1_000)) {
      deleteWalletPairingState(pairingId);
      emitExpired(pairingId, options.human);
      return;
    }

    const event = await pollForSubmission(state, Boolean(options.wait));
    if (event === "expired") {
      emitExpired(pairingId, options.human);
      return;
    }
    if (!event) {
      emitPending(pairingId, options.human);
      return;
    }
    if (options.confirmReplace && options.confirmReplace !== event.id) {
      throw new DvmError(
        "wallet_replacement_submission_changed",
        "The submitted credential no longer matches the event approved for replacement.",
        "Do not replace the wallet. Create a fresh pairing and review its facts again."
      );
    }

    let plaintext;
    try {
      plaintext = decryptWalletPairingEvent(event, state.manifest, state.recipient_private_key);
    } catch {
      throw new DvmError(
        "wallet_pairing_payload_invalid",
        "The encrypted wallet submission failed signature, binding, or decryption checks.",
        "Nothing was saved. Create a fresh pairing link and try again."
      );
    }
    let candidate: ProbedWalletConnection;
    try {
      candidate = await probeWalletConnection(
        plaintext.nwc_uri,
        plaintext.stated_cap,
        options.human
      );
    } catch (err) {
      throw withPairingProbeContext(err, state.pairing_id);
    }
    const candidateFacts = safeCandidateFacts(candidate);
    const currentConfig = loadConfig();
    if (!currentConfig) throw new DvmError("no_config", "No config found.", "Run: dvm init");

    if (currentConfig.nwcUri && !options.confirmReplace) {
      const replacement = {
        event_id: event.id,
        current_wallet_fingerprint: sha256(currentConfig.nwcUri),
        candidate_facts: candidateFacts,
      };
      saveWalletPairingState({ ...state, replacement });
      emitReplacementRequired(state, event.id, currentConfig, candidateFacts, options.human);
      return;
    }

    if (options.confirmReplace) {
      if (state.replacement?.event_id !== options.confirmReplace) {
        throw new DvmError(
          "wallet_replacement_not_reviewed",
          "This wallet replacement was not reviewed by a prior completion call.",
          "Run the completion command without --confirm-replace first and relay the wallet facts to the human."
        );
      }
    }

    const candidateFingerprint = sha256(candidate.nwcUri);
    const commit = {
      event_id: event.id,
      candidate_wallet_fingerprint: candidateFingerprint,
      candidate_facts: candidateFacts,
    };
    saveWalletPairingState({ ...state, commit });
    await updateConfig({
      reason: "wallet_pair_connect",
      patch: (latest) => {
        if (!latest) throw new DvmError("no_config", "No config found.", "Run: dvm init");
        const latestFingerprint = walletFingerprint(latest.nwcUri);
        const expected = state.replacement?.current_wallet_fingerprint ?? null;
        if (latestFingerprint !== candidateFingerprint && latestFingerprint !== expected) {
          throw new DvmError(
            "wallet_replacement_raced",
            "The configured wallet changed after the candidate was reviewed.",
            "Nothing was replaced. Start a fresh pairing and review the current and candidate wallet facts again."
          );
        }
        return latestFingerprint === candidateFingerprint
          ? {}
          : { set: walletConnectionFields(candidate) };
      },
    });
    await acknowledgeRemote(state, event.id);
    deleteWalletPairingState(pairingId);
    emitConnected(candidateFacts, options.human);
  });
}

async function createRemoteSession(manifest: WalletPairingManifest): Promise<void> {
  let response: Response;
  try {
    response = await dvmFetch(`${platformUrl()}/api/v1/wallet-pairings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(manifest),
    });
  } catch (err) {
    if (err instanceof DvmError) throw err;
    throw new DvmError(
      "wallet_pairing_relay_unreachable",
      "The wallet-pairing relay could not be reached.",
      "Check connectivity and run 'dvm wallet pair' again."
    );
  }
  if (!response.ok) {
    const code = response.status === 429 ? "wallet_pairing_quota" : "wallet_pairing_create_failed";
    throw new DvmError(
      code,
      response.status === 429
        ? "Five active pairings already exist for this identity."
        : "The wallet-pairing relay rejected the signed session.",
      "Wait for old links to expire, then run 'dvm wallet pair' again."
    );
  }
}

async function pollForSubmission(
  state: WalletPairingState,
  wait: boolean
): Promise<WalletPairingEvent | "expired" | null> {
  for (;;) {
    if (state.manifest.expires_at <= Math.floor(Date.now() / 1_000)) {
      deleteWalletPairingState(state.pairing_id);
      return "expired";
    }
    let response: Response;
    try {
      response = await dvmFetch(`${platformUrl()}/api/v1/wallet-pairings/${state.pairing_id}`, {
        headers: { Authorization: `Bearer ${state.polling_verifier}` },
      });
    } catch (err) {
      if (err instanceof DvmError) throw err;
      if (!wait) return null;
      await sleepWithJitter();
      continue;
    }
    if (response.status === 410) {
      deleteWalletPairingState(state.pairing_id);
      return "expired";
    }
    if (response.status === 404) {
      throw new DvmError(
        "wallet_pairing_not_found",
        "The pairing relay no longer has this session.",
        "Create a fresh wallet pairing link."
      );
    }
    if (!response.ok) {
      if (!wait) return null;
      await sleepWithJitter();
      continue;
    }
    const body = (await response.json()) as { status?: string; event?: WalletPairingEvent };
    if (body.status === "submitted" && body.event) return body.event;
    if (!wait) return null;
    if (state.manifest.expires_at <= Math.floor(Date.now() / 1_000)) {
      deleteWalletPairingState(state.pairing_id);
      return "expired";
    }
    await sleepWithJitter();
  }
}

async function acknowledgeRemote(state: WalletPairingState, eventId: string): Promise<void> {
  let response: Response;
  try {
    response = await dvmFetch(
      `${platformUrl()}/api/v1/wallet-pairings/${state.pairing_id}/submission/${eventId}`,
      { method: "DELETE", headers: { Authorization: `Bearer ${state.polling_verifier}` } }
    );
  } catch (err) {
    if (err instanceof DvmError) throw err;
    throw new DvmError(
      "wallet_pairing_ack_pending",
      "The wallet was saved, but relay deletion could not be confirmed.",
      `Re-run 'dvm wallet pair complete ${state.pairing_id}' to finish cleanup.`
    );
  }
  if (!response.ok && response.status !== 404 && response.status !== 410) {
    throw new DvmError(
      "wallet_pairing_ack_pending",
      "The wallet was saved, but relay deletion could not be confirmed.",
      `Re-run 'dvm wallet pair complete ${state.pairing_id}' to finish cleanup.`
    );
  }
}

function withPairingProbeContext(err: unknown, pairingId: string): DvmError {
  if (!(err instanceof DvmError)) throw err;
  const command = `dvm wallet pair complete ${pairingId}`;
  return new DvmError(
    err.code,
    err.message,
    `${err.hint ? `${err.hint} ` : ""}The pairing is still saved locally and no wallet was saved. After fixing the wallet issue, re-run '${command}'.`,
    {
      ...(err.data ?? {}),
      pairing_id: pairingId,
      next_action: {
        type: "complete_wallet_pairing",
        command,
        requires_user_approval: false,
        display:
          "The pairing is still saved locally and no wallet was saved. After fixing the wallet issue, re-run this exact command.",
      },
    },
    err.display
  );
}

function safeCandidateFacts(candidate: ProbedWalletConnection): Record<string, unknown> {
  return {
    alias: candidate.probe.alias ?? null,
    host: relayHost(candidate.conn.relays[0]),
    wallet_pubkey_fingerprint: pairingFingerprint(candidate.conn.walletPubkey),
    advertised_methods: candidate.probe.methods,
    balance:
      candidate.balance === undefined
        ? null
        : { msats: candidate.balance, sats: Math.round(candidate.balance / 1_000) },
    stated_cap: {
      value: candidate.statedBudget,
      authoritative: false,
      enforced_by_dvmkit: false,
      display:
        "This is the cap you reported setting in the wallet. dvmkit cannot query or enforce it.",
    },
    warnings: [
      ...candidate.warnings,
      {
        code: "wallet_cap_recurs",
        display:
          "A weekly or monthly cap resets. Anyone who steals this credential can spend the renewed allowance until you revoke the connection.",
      },
      {
        code: "verify_wallet_facts",
        display:
          "Revoke this wallet connection immediately if the alias, host, key fingerprint, methods, or balance look wrong.",
      },
    ],
  };
}

function safeCurrentFacts(config: Config): Record<string, unknown> {
  if (!config.nwcUri) return { configured: false };
  try {
    const conn = parseNwcUri(config.nwcUri);
    return {
      configured: true,
      alias: config.float?.alias ?? null,
      host: relayHost(conn.relays[0]),
      wallet_pubkey_fingerprint: pairingFingerprint(conn.walletPubkey),
      advertised_methods: config.float?.methods ?? [],
      stated_cap: config.float?.statedBudget ?? null,
    };
  } catch {
    return { configured: true, alias: config.float?.alias ?? null, facts_unavailable: true };
  }
}

function emitPending(pairingId: string, human?: boolean): void {
  const command = `dvm wallet pair complete ${pairingId} --wait`;
  if (human) {
    info(`Wallet pairing is still waiting for the browser submission. Retry with: ${command}`);
  } else {
    json({
      status: "wallet_pairing_pending",
      pairing_id: pairingId,
      next_action: {
        type: "complete_wallet_pairing",
        command,
        retry_after_ms: WALLET_PAIRING_RETRY_AFTER_MS,
        requires_user_approval: false,
      },
    });
  }
}

function emitExpired(pairingId: string, human?: boolean): void {
  if (human) info("Wallet pairing expired. Run 'dvm wallet pair' for a fresh private link.");
  else
    json({
      status: "wallet_pairing_expired",
      pairing_id: pairingId,
      display: "The private wallet-pairing link expired and its local state was removed.",
      next_action: {
        type: "create_wallet_pairing",
        command: "dvm wallet pair",
        requires_user_approval: true,
      },
    });
}

function emitReplacementRequired(
  state: WalletPairingState,
  eventId: string,
  currentConfig: Config,
  candidateFacts: Record<string, unknown>,
  human?: boolean
): void {
  const command = `dvm wallet pair complete ${state.pairing_id} --confirm-replace ${eventId}`;
  if (human) {
    info(
      "A Lightning float is already configured. Review the current and candidate facts before replacing it."
    );
    emitHumanWalletFacts("Current", safeCurrentFacts(currentConfig));
    emitHumanWalletFacts("Candidate", candidateFacts);
    info(`Confirmation command: ${command}`);
  } else {
    json({
      status: "wallet_replacement_confirmation_required",
      pairing_id: state.pairing_id,
      submission_event_id: eventId,
      current_wallet: safeCurrentFacts(currentConfig),
      candidate_wallet: candidateFacts,
      next_action: {
        type: "confirm_wallet_replacement",
        command,
        requires_user_approval: true,
        display: "Only run this exact command after the human confirms the candidate wallet facts.",
      },
    });
  }
}

function emitConnected(facts: Record<string, unknown>, human?: boolean): void {
  if (human) {
    info(`Lightning float connected: ${safeFactText(facts.alias, "unknown wallet")}`);
    emitHumanWalletFacts("Connected wallet", facts);
    info(
      "Keep dvmkit's local budget limits enabled and revoke the wallet connection if any fact looks wrong."
    );
  } else {
    json({
      status: "wallet_connected",
      wallet: facts,
      display:
        "Encrypted wallet pairing completed. The credential was probed locally, saved with mode 0600, and deleted from the relay.",
      hint: "Keep dvmkit's local budget limits enabled. The wallet-enforced recurring cap remains the outer safety boundary.",
    });
  }
}

function emitHumanWalletFacts(label: string, facts: Record<string, unknown>): void {
  const cap = facts.stated_cap;
  const capValue =
    cap && typeof cap === "object" && "value" in cap
      ? safeFactText((cap as { value?: unknown }).value, "not stated")
      : safeFactText(cap, "not stated");
  const balance = facts.balance;
  const balanceValue =
    balance && typeof balance === "object" && "sats" in balance
      ? `${safeFactText((balance as { sats?: unknown }).sats, "unknown")} sats`
      : "not reported";
  info(
    `${label}: alias ${safeFactText(facts.alias)}; host ${safeFactText(facts.host)}; wallet key ${safeFactText(facts.wallet_pubkey_fingerprint)}; methods ${Array.isArray(facts.advertised_methods) ? facts.advertised_methods.filter((value): value is string => typeof value === "string").join(", ") || "unreported" : "unreported"}; balance ${balanceValue}; stated cap ${capValue}.`
  );
}

function safeFactText(value: unknown, fallback = "unknown"): string {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : fallback;
}

function walletFingerprint(uri: string | undefined): string | null {
  return uri ? sha256(uri) : null;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function relayHost(relay: string | undefined): string | null {
  try {
    return relay ? new URL(relay).hostname : null;
  } catch {
    return null;
  }
}

function safeHostname(value: string): string {
  return /^[A-Za-z0-9.-]{1,64}$/.test(value) ? value : "unknown-host";
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function platformUrl(): string {
  return (process.env.DVMKIT_PLATFORM_URL ?? "https://api.dvmkit.dev").replace(/\/$/, "");
}

function webUrl(): string {
  return (process.env.DVMKIT_WEB_URL ?? "https://dvmkit.com").replace(/\/$/, "");
}

async function sleepWithJitter(): Promise<void> {
  const jitter = Math.floor(Math.random() * WALLET_PAIRING_POLL_JITTER_MS);
  await new Promise((resolve) => setTimeout(resolve, WALLET_PAIRING_RETRY_AFTER_MS + jitter));
}
