import { z } from "zod";

import {
  formatFiat,
  type SignedRequestDomain,
} from "@dvmkit/sdk";
import {
  asProviderTextOpt,
  type AttestedDvmIdentity,
  clearPendingDrain,
  createTempoCloseCredential,
  type CreditOpResult,
  type CompletedRefundHistoryRecord,
  type DrainReceipt,
  type DrainReceiptVerifyResult,
  type DrainWire,
  DvmError,
  dvmLocationIdentity,
  ensureAddress,
  ensureProvisionalCredit,
  forgetCredit,
  formatUsd,
  isDrainReceipt,
  loadAgentWallet,
  loadCredit,
  loadTempoChannelAssociation,
  markCredit,
  type PendingDrain,
  pendingDrainById,
  pendingDrainFor,
  type PendingX402Funding,
  type ProviderInfo,
  type ReceiptTrustAnchor,
  type ReceiptVerification,
  receiveToAgentWallet,
  reconcileTempoChannelOnChain,
  recordDrainReceipts,
  recordFundResponse,
  recordPendingDrain,
  refundX402BatchChannel,
  settleDrainEvidence,
  signDvmRequestData,
  signedRequestDomain,
  type StoredCredit,
  type TempoChannelAssociation,
  type TempoChannelReconcileResult,
  tempoSessionChallenge,
  tempoSessionChallengeMicro,
  type TrustAnchorRead,
  verifyDrainReceiptChain,
  weakestReceiptVerdict,
  withTempoChannelLock,
  x402PendingFundingJson,
  x402RequiredFromError,
  x402ReservationRelease,
} from "@dvmkit/sdk/internal";
import {
  connectedTempoAccount,
} from "../payment-rails/tempo-wallet";
import {
  drainReceiptsDisplay,
  drainReceiptsHint,
  epochMsToIso,
  receiptFailureDetail,
} from "../receipt-verify";
import {
  fetchTrustAnchor,
} from "../receipt-capture";
import {
  info,
  json,
  raw,
} from "../output";
import {
  loadConfig,
} from "../identity";
import {
  loadX402Wallet,
} from "../x402/wallet";
import {
  resolveSigningIdentity,
} from "../cli-identity-resolve";
import {
  randomUUID,
} from "crypto";
import {
  reclaimCommand,
} from "../credit-reclaim";
import {
  createDvmTransport,
} from "../transport";
import {
  dvmLabelFromEndpoint,
} from "../../commands/wallet-history";
import { renderCreditDrain, renderCreditReceipts } from "../../commands/credit/render";
import { providerCopyHint, describeCreditProvider, discoverCreditDvmIdentity, resolveCreditEndpoint, creditOp, otherCreditDrains, pendingDrainJson } from "./shared";
import { completedCreditHistory, completedDrainMatches, completedServiceMatches, completedOriginsOverlap } from "../completed-credit-history";
import type { CreditDrainOptions, CreditReceiptsOptions } from "./options";

/**
 * Request, poll, or pick up a drain of the credit held at one DVM. Re-running
 * the verb polls the same drain id (the op is idempotent server-side); a
 * parked Cashu token is redeemed into the agent wallet on sight.
 */
export async function runCreditDrain(dvm: string, opts: CreditDrainOptions): Promise<void> {
  const endpoint = resolveCreditEndpoint(dvm);
  const signer = resolveSigningIdentity({ as: opts.as, config: loadConfig() });
  // Best-effort because a known drain must remain pollable during a transient
  // `/v1/info` failure. When identity is available, it lets a never-before-seen
  // alias find the existing record before the drain id is persisted.
  const identity = await discoverCreditDvmIdentity(endpoint);
  const identityArg: [] | [identity: AttestedDvmIdentity] = identity ? [identity] : [];
  const stored = loadCredit(endpoint, signer.pubkey, identity);
  const creditId = opts.creditId ?? stored?.creditId;
  if (!creditId) {
    throw new DvmError(
      "credit_not_found",
      `No prepaid credit tracked at ${endpoint}.`,
      "Run 'dvm credit balance <dvm>' to check the server, or pass --credit-id explicitly."
    );
  }
  // Keyed by credit id, so it is the one signal that proves *this* credit has a
  // live session channel — read up here because the method default needs it as
  // well as `channelBacked` below.
  const tempoSession = !!loadTempoChannelAssociation(endpoint, signer.pubkey, creditId);
  // An x402 instrument stands in for a missing `rail`: the two are written and
  // cleared together (`adoptCreditId`), so an instrument with no rail beside it
  // is a credit whose binding was healed from a refusal rather than learned from
  // a funding we drove — including the record `dvm credit fund` leaves behind
  // when a wedged channel refuses a top-up. Without that clause the
  // default falls to `cashu`, and `drainPayout` refuses for a missing agent
  // wallet before the reuse lookup below ever restores the recorded x402 method.
  // The record's rail and instrument are credit-scoped like the `channelBacked`
  // read below, and for the same reason: both are facts about the credit the
  // record names, so a `--credit-id` drain of a sibling must take neither from
  // it. A sibling still defaults to `tempo` on a session channel of
  // its own, which is credit-scoped and so describes the right credit; with no
  // scoped signal at all the default falls through to `cashu` as before.
  const method = (
    opts.method ??
    ((stored?.creditId === creditId && stored.rail === "tempo") || tempoSession
      ? "tempo"
      : stored?.creditId === creditId &&
          (stored.rail === "x402" || stored.x402Instrument !== undefined)
        ? "x402"
        : "cashu")
  ).toLowerCase();
  if (
    opts.recoverFromReceipts &&
    (method !== "x402" || !opts.creditId || !opts.drainId || opts.address !== undefined)
  ) {
    throw new DvmError(
      "invalid_argument",
      "--recover-from-receipts requires exact --credit-id and --drain-id bindings with --method x402 and no payout override.",
      "This local-only correction is intentionally narrower than an ordinary drain: it may retire only the exact marker whose saved signed receipts are being verified."
    );
  }

  // Which instrument backs this credit within its rail, and so how it reclaims
  // A channel is closed cooperatively and pays its own payer; a
  // one-payment credit — an x402 `exact` authorization, a Tempo charge — is an
  // ordinary push refund to an address the caller names. Both signals are
  // credit-scoped: the Tempo association above is keyed by credit id, and the
  // x402 instrument pin is only read when the record names this credit. An
  // unpinned x402 credit (opened before the pin existed, or adopted from a balance read)
  // reads as one-payment and the DVM corrects it below — the server's word is
  // always the authority here, this record is a copy of it.
  const channelBacked =
    method === "tempo"
      ? tempoSession
      : stored?.creditId === creditId && stored.x402Instrument === "x402_channel";
  if (tempoSession && method !== "tempo") {
    throw new DvmError(
      "invalid_argument",
      "A Tempo-backed credit must be drained through its session channel.",
      `Run '${reclaimCommand(endpoint, stored, creditId)} --method tempo' to close the channel cooperatively and reclaim its unspent deposit. If the DVM says it has no channel for this credit, 'dvm wallet tempo-exit ${dvm}' settles it on-chain or retires the local record when the chain shows nothing left in it, and the other rails open up once it is gone.`
    );
  }

  // The final draw can leave an active server credit at exactly zero. Asking
  // the DVM to drain it is not a reclaim — it answers `nothing_to_drain` — but
  // the caller still needs to retire the local binding before a fresh credit
  // can choose another rail. No pending drain may be skipped: it can represent
  // a real refund already being prepared even when the projection now reads 0.
  // A provisional or discrepant zero still needs the server's word too.
  if (
    stored?.creditId === creditId &&
    stored.status === "active" &&
    stored.remainingMicro <= 0 &&
    !stored.provisional &&
    !stored.discrepancy &&
    !opts.drainId &&
    !pendingDrainFor(stored, creditId) &&
    method !== "tempo"
  ) {
    markCredit(endpoint, signer.pubkey, "drained", {
      ifCreditId: creditId,
      ...(identity ? { identity } : {}),
    });
    const display = `The prepaid credit at ${endpoint} is empty, so there was nothing to reclaim; it has been retired locally.`;
    const hint = "A fresh credit can now open on the funding rail selected for its amount.";
    if (opts.human) {
      info(display);
      info(hint);
      return;
    }
    json({
      op: "drain",
      endpoint,
      credit_id: creditId,
      retired: true,
      balance_micro: 0,
      display,
      hint,
    });
    return;
  }

  // The *projection* writes only apply when the drained credit IS the tracked
  // one (or nothing is tracked yet) — adopting another credit's balances and
  // ledger sequence into this record would corrupt it. Drain bookkeeping is
  // not gated the same way: entries carry the credit they belong to, so
  // recording one can't disturb the tracked credit's figures.
  const canPersist = !stored || stored.creditId === creditId;

  // Reuse an in-flight drain's id so a re-invoke polls rather than conflicts;
  // the recorded payout is immutable server-side, so it is re-stated verbatim.
  // Strictly the drain recorded for THIS credit: server-side a drain is keyed
  // `(credit_id, drain_id)`, so re-posting another credit's id here would open
  // a second drain rather than poll the one that is owed. `--drain-id` is the
  // caller saying they know a pairing this store doesn't.
  const named = opts.drainId ? pendingDrainById(stored, opts.drainId) : undefined;
  if (named?.creditId !== undefined && named.creditId !== creditId) {
    // `--drain-id` names a drain this store *can* attribute, and it belongs to
    // another credit. Re-posting it here would open a second drain rather than
    // poll that one, which is the whole failure this flag exists downstream of.
    throw new DvmError(
      "invalid_argument",
      `Drain ${named.drainId} was requested against credit ${named.creditId}, not ${creditId}.`,
      `Reclaim it with 'dvm credit drain ${endpoint} --credit-id ${named.creditId}' — no --drain-id needed, that credit's drain is already on record.`
    );
  }
  const trackedDrain = pendingDrainFor(stored, creditId);
  if (opts.drainId && !opts.creditId && named?.creditId === undefined) {
    // The store cannot say which credit this id belongs to, and neither did
    // the caller — so posting it would pair it with whatever credit happens to
    // be tracked now. That guess IS the failure, and it is worse
    // here: the pairing is stamped afterwards, so a wrong one looks settled.
    throw new DvmError(
      "invalid_argument",
      named
        ? `Drain ${opts.drainId} was recorded before drains carried a credit id, so which credit it belongs to is unknown here.`
        : `No drain ${opts.drainId} is on record at ${endpoint}, so which credit it belongs to is unknown here.`,
      `Re-run with '--credit-id <the credit it was requested on>' — posting it against the wrong credit opens a second drain instead of paying the one you are owed. 'dvm credit list' shows what this record still holds.`
    );
  }
  if (opts.drainId && trackedDrain && trackedDrain.drainId !== opts.drainId) {
    // Two drains on one credit is a shape nothing here reads: the reuse
    // lookup takes the credit's drain, so the loser would sit unpollable while
    // its payout may be parked. Refuse rather than pick.
    throw new DvmError(
      "invalid_argument",
      `Credit ${creditId} already has drain ${trackedDrain.drainId} on record, so --drain-id ${opts.drainId} would open a second drain against it.`,
      `Poll the recorded one first with 'dvm credit drain ${endpoint} --credit-id ${creditId}'; it is retired once the refund lands, and ${opts.drainId} can be posted after that.`
    );
  }

  const pending = opts.drainId ? named : trackedDrain;
  const settledRecovery =
    pending && !opts.address
      ? settledPushDrainRecovery(stored, pending, creditId, method, {
          allowX402: opts.recoverFromReceipts === true,
        })
      : undefined;
  if (pending && settledRecovery) {
    clearPendingDrain(endpoint, signer.pubkey, pending, ...identityArg);
    const display = `Verified stored receipts prove drain ${pending.drainId} already sent its refund, so its stale local poll marker was retired without re-posting the drain.`;
    const hint =
      "No payment or refund request was sent. The signed reclaim receipts remain stored as durable evidence.";
    if (opts.human) {
      info(display);
      info(settledRecovery.bundle.display);
      info(hint);
      return;
    }
    json({
      op: "drain",
      endpoint,
      drain: {
        drain_id: pending.drainId,
        credit_id: creditId,
        method: settledRecovery.receipt.method,
        status: "sent",
        amount_micro: settledRecovery.receipt.amount_micro,
        currency: stored?.currency ?? "usd",
        ledger_seq: settledRecovery.receipt.ledger_seq,
        created_at: settledRecovery.receipt.issued_at,
        receipts: settledRecovery.evidence.receipts,
      },
      local_drain_retired: true,
      same_operation_recovered: true,
      network_replay: false,
      recovery_evidence: "verified-terminal-receipts",
      transaction_reference_recovered: false,
      receipts_verified: settledRecovery.bundle.verdict,
      receipts_total: settledRecovery.bundle.total,
      receipts_checked: settledRecovery.bundle.checkedJson,
      receipts_display: settledRecovery.bundle.display,
      display,
      hint,
    });
    return;
  }
  if (opts.recoverFromReceipts) {
    throw new DvmError(
      "invalid_argument",
      `Verified terminal receipts do not prove that drain ${opts.drainId ?? "(unrecorded)"} was sent.`,
      "Keep the local marker and reconcile the exact drain through the DVM. This recovery option never posts a request and cannot replace missing signed evidence."
    );
  }

  const payout = await drainPayout(method, opts, channelBacked, dvm);
  const mintedThisRun = !pending;
  let drain: PendingDrain = pending
    ? reusableDrain(pending, method, payout)
    : {
        drainId: opts.drainId ?? randomUUID(),
        creditId,
        method,
        payout,
        requestedAt: Date.now(),
      };
  // A drain the record holds but can't attribute to this credit. Left alone
  // rather than reused — its payout may still be unredeemed, and dropping the
  // only pointer to it is the dangerous direction.
  const unclaimedBefore = otherCreditDrains(stored, creditId);
  if (mintedThisRun && unclaimedBefore.length > 0) {
    info(
      `Not reusing ${unclaimedBefore.length === 1 ? "an earlier drain" : `${String(unclaimedBefore.length)} earlier drains`} recorded here — ${unclaimedBefore.length === 1 ? "it is not" : "they are not"} recorded against ${creditId}, so this is a fresh drain on it. ${unclaimedDrainsHint(endpoint)}`
    );
  }
  // Persist the drain id BEFORE the POST: if the response is lost, a re-run
  // must poll this id — minting a fresh one would strand the parked payout
  // under an id the caller never learned. That rule holds whichever credit is
  // being drained, which is why it is outside `canPersist`. The untracked
  // `--credit-id` case first needs a record to hang it on; zeros stay
  // provisional until the response (or a later balance read) adopts the
  // server's figures.
  if (mintedThisRun) {
    if (!stored) {
      ensureProvisionalCredit({
        endpoint,
        ...(identity ? { identity } : {}),
        callerPubkey: signer.pubkey,
        creditId,
        currency: "usd",
        targetMicro: 0,
      });
    }
    recordPendingDrain(endpoint, signer.pubkey, drain, ...identityArg);
  } else if (
    drain.method === "cashu" &&
    typeof drain.payout.refund_pubkey === "string" &&
    drain.payout.refund_pubkey !== payout.refund_pubkey
  ) {
    // The recorded payout is what the DVM signed and what it will pay to; it
    // cannot be re-pointed. Say so, or a wallet that has been re-initialised
    // since loops forever on the generic "couldn't redeem right now" below.
    // Only worth saying when the record actually names a key — an entry with
    // none is being re-stated with the current one, and the server's answer is
    // the honest word on whether that matches what it signed.
    info(
      `This drain was requested against a different wallet key (${drain.payout.refund_pubkey}), and the refund is locked to it — the payout destination is fixed once signed. Restore that wallet to redeem, or reclaim what is left with a fresh drain.`
    );
  }

  const transport = createDvmTransport();
  let authDomain: SignedRequestDomain;
  let providerInfo: ProviderInfo | undefined;
  try {
    providerInfo = await describeCreditProvider(endpoint);
  } catch (error) {
    const persistedAudience = stored ? dvmLocationIdentity(stored) : undefined;
    if (!persistedAudience) throw error;
    authDomain = {
      audience: {
        dvm_id: persistedAudience.dvmId,
        builder_pubkey: persistedAudience.builderPubkey,
      },
      method: "POST",
      path: new URL("v1/credit", `${endpoint.replace(/\/$/, "")}/`).pathname,
      capability: null,
    };
  }
  if (providerInfo) {
    authDomain = signedRequestDomain({
      provider: providerInfo,
      endpoint,
      method: "POST",
      path: "v1/credit",
      capability: null,
    });
  }
  const signCredit = (body: Record<string, unknown>) =>
    signDvmRequestData(signer.privkey, body, authDomain);
  let result: CreditOpResult;
  // The trust anchor the drain receipts below chain to, read off the same live
  // endpoint that just answered the drain. Sits inside this `try` because
  // `fetchTrustAnchor` swallows its own failures — it cannot reach the catch
  // below, so a `/v1/info` that is down costs a verdict, never the reclaim.
  // Defaults to "never asked", which is the answer that touches nothing.
  let anchorRead: TrustAnchorRead = { reachable: false };
  // Channel value exposed to an unacknowledged signed voucher when an x402
  // refund starts. It is information rather than a gate: the authority is
  // already signed, while draining closes the channel and forecloses retrying
  // that funding into credit.
  let x402AtRisk: { micro: bigint; pending: PendingX402Funding[] } | undefined;
  // The Tempo twin, and it is read off the local channel rather than the wire:
  // the cumulative this wallet has signed away is capture authority the DVM
  // keeps whatever this drain decides. Only a released drain reports it — a
  // cooperative close that answered `sent` was confirmed on-chain before the
  // DVM said so — which the reconcile after the response goes and checks — and
  // one still in flight comes back as a 402.
  let mppAtRiskMicro: bigint | undefined;
  // The channel this drain is closing, kept for the chain read that follows the
  // response: the DVM's `sent` is a claim about the escrow, and the record it
  // would retire is the caller's only way back to the collateral if it is wrong
  let mppAssociation: TempoChannelAssociation | undefined;
  try {
    // Re-derived per post rather than captured once: the x402 fallback below
    // rewrites the payout mid-flight, and the body it signs must follow.
    const unsignedBody = (): Record<string, unknown> => ({
      op: "drain",
      credit_id: creditId,
      drain: {
        drain_id: drain.drainId,
        method: drain.method,
        // A cooperative Tempo close names no destination, and the server reads
        // an mpp `payout` that is merely *present* as a promise to carry an
        // address — so an empty one is omitted rather than sent as `{}`. A
        // charge-funded credit does carry its address here.
        ...(drain.method === "tempo" && Object.keys(drain.payout).length === 0
          ? {}
          : { payout: drain.payout }),
      },
    });
    if (drain.method === "tempo" && channelBacked) {
      result = await withTempoChannelLock(async () => {
        const body = signCredit(unsignedBody());
        const association = loadTempoChannelAssociation(endpoint, signer.pubkey, creditId);
        mppAssociation = association;
        const account = await connectedTempoAccount();
        if (!association || !account) {
          throw new DvmError(
            "tempo_channel_not_found",
            `The Tempo channel for prepaid credit ${creditId} is not available to this caller.`,
            "Reconnect the original Tempo wallet if it was removed. If the DVM is unavailable, use 'dvm wallet tempo-exit <dvm>' to recover on-chain."
          );
        }
        const authorized = BigInt(association.cumulativeAmount);
        const deposit = BigInt(association.deposit);
        mppAtRiskMicro = authorized < deposit ? authorized : deposit;
        if (!drain.mppCredential) {
          try {
            return await creditOp(transport, endpoint, body);
          } catch (err) {
            const challenge = tempoSessionChallenge(err);
            if (!challenge) throw err;
            const credential = await createTempoCloseCredential({
              account,
              association,
              challenge,
              cumulativeAmountMicro: tempoSessionChallengeMicro(challenge),
            });
            drain = { ...drain, mppCredential: credential };
            // Persist the exact close authorization before it can be consumed.
            recordPendingDrain(endpoint, signer.pubkey, drain, ...identityArg);
            return creditOp(transport, endpoint, body, { mppCredentialRaw: credential });
          }
        }
        try {
          return await creditOp(transport, endpoint, body, {
            mppCredentialRaw: drain.mppCredential,
          });
        } catch (err) {
          const challenge = tempoSessionChallenge(err);
          if (
            !(err instanceof DvmError) ||
            err.data?.credential_refresh_required !== true ||
            !challenge
          ) {
            throw err;
          }
          const credential = await createTempoCloseCredential({
            account,
            association,
            challenge,
            cumulativeAmountMicro: tempoSessionChallengeMicro(challenge),
          });
          drain = { ...drain, mppCredential: credential };
          // Replace only the obsolete authorization. The drain and channel
          // identities remain unchanged, so an interrupted refresh resumes
          // the one reclaim the server already holds.
          recordPendingDrain(endpoint, signer.pubkey, drain, ...identityArg);
          // The stale-credential POST consumed its ordinary signed-request
          // nonce before mppx rejected the close approval. Re-sign the same
          // drain body so the fresh credential is not paired with a replayed
          // request envelope.
          const refreshedBody = signCredit(unsignedBody());
          return creditOp(transport, endpoint, refreshedBody, {
            mppCredentialRaw: credential,
          });
        }
      });
    } else if (drain.method === "x402") {
      const closeChannel = async (): Promise<CreditOpResult> => {
        const wallet = loadX402Wallet();
        if (!wallet) {
          throw new DvmError(
            "x402_wallet_missing",
            "This credit is backed by an x402 channel, but its signing wallet is not connected.",
            "Reconnect that exact key: 'dvm wallet x402-connect --key-file <path>', or DVM_X402_KEY=<key> dvm wallet x402-connect. A bare 'dvm wallet x402-connect' generates a new wallet, and a different key cannot refund this channel."
          );
        }
        const refunded = await refundX402BatchChannel({
          wallet,
          endpoint,
          callerPubkey: signer.pubkey,
          creditId,
          depositMicro: Math.max(stored?.targetMicro ?? 0, 1),
          post: (paymentHeader) =>
            creditOp(
              transport,
              endpoint,
              signCredit(unsignedBody()),
              paymentHeader ? { x402Payment: paymentHeader, x402Version: 2 } : undefined
            ),
        });
        x402AtRisk = { micro: refunded.atRiskMicro, pending: refunded.pendingFundings };
        return refunded.result;
      };
      if (channelBacked) {
        result = await closeChannel();
      } else {
        // A one-payment credit is a plain push refund: nothing to sign, no
        // channel to read. If this DVM answers with a refund challenge it is
        // telling us the credit *is* channel-backed after all — the pin was
        // missing, not wrong — so close it cooperatively instead. The recorded
        // payout has to follow, because the server will record the channel id
        // where we wrote an address, and a later poll re-stating the address
        // would earn `drain_conflict`. Nothing is stranded either way: the
        // challenge is issued before any drain row exists.
        try {
          result = await creditOp(transport, endpoint, signCredit(unsignedBody()));
        } catch (err) {
          if (!(err instanceof DvmError) || !x402RequiredFromError(err)) throw err;
          drain = { ...drain, payout: {} };
          recordPendingDrain(endpoint, signer.pubkey, drain, ...identityArg);
          result = await closeChannel();
        }
      }
    } else {
      result = await creditOp(transport, endpoint, signCredit(unsignedBody()));
    }
    // Only worth a GET when the response actually carried evidence to chain.
    if (result.drain?.receipts.length) {
      anchorRead = await fetchTrustAnchor(transport, { endpoint });
    }
  } catch (err) {
    // The server has retired this drain id: the refund behind it was written
    // off, so re-posting it lands on the same terminal refusal forever while
    // the balance it was for stays right where it is, reclaimable under a
    // fresh id. Dropping the entry is what mints that id on the
    // next run, so this clears whatever `mintedThisRun` says — reuse is
    // precisely how the jam is reached, and that guard is the thing keeping it
    // shut. Never `forgetCredit`: the credit is still there and still holds
    // money, and `clearPendingDrain` leaves `drainEvidence` alone, so any
    // signed receipt this drain earned survives its id.
    if (err instanceof DvmError && err.data?.drain_id_retired === true) {
      clearPendingDrain(endpoint, signer.pubkey, drain, ...identityArg);
    } else if (
      // The mirror image, and the reason the two are separate fields: this
      // channel's reclaim is held by an earlier refund that reached the chain
      // and never booked, and the gate holding it admits exactly one drain id —
      // the one that settlement is recorded under, which the refusal now names
      // Adopting it is what makes that exemption reachable from
      // here: without it a caller who lost the id, or raced a sibling drain,
      // posts a fresh one into the same gate on every run and waits on an
      // operator repair that re-presenting the named id would have finished.
      //
      // Dropping the posted id is safe in a way it is not elsewhere: this
      // refusal lands above the challenge (or rolls its ledger leg back), so
      // nothing server-side holds that id, and x402 parks no payout for it to
      // point at. `clearPendingDrain` leaves `drainEvidence` alone.
      err instanceof DvmError &&
      err.code === "settlement_pending" &&
      typeof err.data?.settlement_drain_id === "string" &&
      err.data.settlement_drain_id !== drain.drainId
    ) {
      clearPendingDrain(endpoint, signer.pubkey, drain, ...identityArg);
      recordPendingDrain(
        endpoint,
        signer.pubkey,
        { ...drain, drainId: err.data.settlement_drain_id, creditId },
        ...identityArg
      );
      info(
        `Drain ${err.data.settlement_drain_id} is now this credit's recorded reclaim — the id the provider's unfinished refund is under. Re-run '${reclaimCommand(endpoint, stored, creditId)}' to post it; no --drain-id needed.`
      );
    } else if (err instanceof DvmError && err.data?.drain_registered === false) {
      // Unlike `credit_not_found`, this is a statement about the exact drain
      // this signed request posted: the DVM found the credit, rejected before
      // recording a refund, and says there is no payout parked under this id.
      // It is therefore safe to retire a drain this run only re-posted — that
      // is how a stale local orphan leaves the store without a hand edit
      // Match the drain's full identity so sibling reclaims and all
      // signed evidence remain untouched.
      clearPendingDrain(endpoint, signer.pubkey, drain, ...identityArg);
      const retirement = `The DVM confirmed drain ${drain.drainId} was never registered, so its stale local record was retired. No refund was created or paid.`;
      // Both places a display can live. `buildStructuredError` parks the DVM's
      // own copy on `data.display`, and the CLI error boundary spreads `data`
      // *after* `err.display` — so writing only the latter left this sentence
      // out of the JSON on every refusal that carried server copy, which every
      // `paymentErrorBody` does.
      const serverDisplay = typeof err.data.display === "string" ? err.data.display : err.display;
      const displayWasProvider = err.proseSources?.display === "provider";
      err.display = serverDisplay ? `${serverDisplay} ${retirement}` : retirement;
      err.data = {
        ...err.data,
        display: err.display,
        drain_id: drain.drainId,
        credit_id: creditId,
        local_drain_retired: true,
      };
      if (serverDisplay && displayWasProvider) {
        err.proseSources = { ...err.proseSources, display: "provider" };
      }
    } else if (err instanceof DvmError && err.code === "credit_not_found") {
      // `credit_not_found` can instead mean the caller used the wrong endpoint
      // or identity. Unwind only state this invocation created; a drain it
      // merely re-posted may still be the sole pointer to a parked payout.
      if (!stored) forgetCredit(endpoint, signer.pubkey, ...identityArg);
      else if (mintedThisRun) clearPendingDrain(endpoint, signer.pubkey, drain, ...identityArg);
    }
    throw err;
  } finally {
    transport.close();
  }

  const wireDrain = result.drain;
  if (!wireDrain) {
    throw new DvmError("provider_error", "Drain response carried no drain record.");
  }

  // A `--drain-id` reuse of an entry too old to name its credit: the server has
  // now answered for it under this one, so the pairing the caller supplied is
  // established. Stamping it means ordinary polling finds this drain from here
  // on, and the caller never has to supply the pairing again.
  const attributed: PendingDrain = drain.creditId === creditId ? drain : { ...drain, creditId };
  if (attributed !== drain) {
    // Clear then record: the store keys on `(drainId, creditId)`, so the
    // unstamped entry and its stamped copy are two identities, and recording
    // alone would leave the record holding both. Nothing is dropped in
    // between — the same drain id is written back within the same call.
    clearPendingDrain(endpoint, signer.pubkey, drain, ...identityArg);
    recordPendingDrain(endpoint, signer.pubkey, attributed, ...identityArg);
  }

  // Reconcile the store from the echoed credit — the provisional zeros from
  // the pre-op write (untracked `--credit-id` mode) adopt the server's
  // figures here.
  if (canPersist && result.credit) {
    recordFundResponse({
      endpoint,
      ...(identity ? { identity } : {}),
      callerPubkey: signer.pubkey,
      credit: result.credit,
      targetMicro: stored?.targetMicro ?? result.credit.remaining_micro,
    });
  }

  // Verify + persist the DVM-signed reclaim evidence. `requested` with no
  // later `parked`/`sent` is a signed IOU — worth keeping either way, and worth
  // chaining all the way to the builder identity, because the DVM that could
  // disown the signing key is the one that still owes the money.
  // An unreachable `/v1/info` falls back to the anchor an earlier poll of this
  // same drain pinned: that pinned identity is what a later dispute re-checks
  // against anyway, so a blip mid-poll shouldn't downgrade a verdict that held.
  const builderAnchor = anchorRead.reachable
    ? anchorRead.anchor
    : stored?.drainEvidence?.find((e) => e.drainId === drain.drainId)?.anchor;
  const bundle = verifyDrainBundle(wireDrain.receipts, builderAnchor, {
    drainId: drain.drainId,
    creditId,
  });
  // Outside `canPersist` for the same reason the drain id itself is: a bundle
  // carries the credit it reclaimed, so filing one disturbs no other credit's
  // figures — and a reclaim of a drain stranded on a previous credit is exactly
  // the case where the caller most needs the signed IOU kept.
  if (wireDrain.receipts.length > 0) {
    recordDrainReceipts({
      endpoint,
      ...(identity ? { identity } : {}),
      callerPubkey: signer.pubkey,
      drainId: drain.drainId,
      creditId,
      receipts: wireDrain.receipts,
      read: anchorRead,
    });
  }
  const firstBroken = bundle.checked.find((c) => c.status === "invalid");
  if (firstBroken) {
    // A warning, never a failure — the refund is owed whatever the proof says.
    // Same rule a job receipt follows, for the same reason.
    info(
      `Warning: a drain receipt did not verify. ${receiptFailureDetail(firstBroken.reason ?? "signature_invalid")}`
    );
  }

  // A parked token is locked to the wallet's own key — redeem on sight.
  let claimedSats: number | undefined;
  if (wireDrain.token && drain.method === "cashu") {
    try {
      claimedSats = (await receiveToAgentWallet(wireDrain.token)).claimedSats;
    } catch (err) {
      info(
        `The refund token is ready but could not be redeemed right now (${err instanceof Error ? err.message : String(err)}). Re-run 'dvm credit drain' to retry — the token stays locked to your key.`
      );
    }
  }

  const released = wireDrain.status === "released";
  const finished =
    wireDrain.status === "picked_up" || wireDrain.status === "sent" || claimedSats !== undefined;
  if (released) {
    clearPendingDrain(endpoint, signer.pubkey, attributed, ...identityArg);
  } else if (finished) {
    // `ifCreditId` because the reconcile above can have re-pointed the record
    // at whatever credit the DVM echoed; zeroing the wrong credit's balance is
    // not a recoverable mistake. Retiring the drain is matched on the drain
    // itself, so it holds even when this was a reclaim of one stranded on a
    // credit the record no longer tracks.
    if (canPersist) {
      markCredit(endpoint, signer.pubkey, "drained", {
        ifCreditId: creditId,
        ...(identity ? { identity } : {}),
      });
    }
    clearPendingDrain(endpoint, signer.pubkey, attributed, ...identityArg);
    // Outside `canPersist` for the same reason the receipts themselves are: the
    // bundle stays either way, and the stamp only says this reclaim is closed —
    // which is what lets the archive be trimmed without ever dropping an
    // unredeemed IOU.
    //
    // Cashu is the one rail whose payout lands here rather than at the DVM:
    // `picked_up` says the ledger handed the token over, not that the mint let
    // us redeem it, so a mint outage would otherwise stamp a reclaim whose sats
    // never arrived. Every other rail is pushed by the DVM, and only ever
    // reaches `sent` once it has (`markDrainSent` is `method <> 'cashu'`). A
    // cashu drain redeemed on some other machine simply stays unstamped —
    // pinned in the archive is the safe direction. Either method reading cashu
    // is enough: the stored one can be a hand-edit, and the wire one is what
    // the ledger actually holds.
    const cashuPayout = wireDrain.method === "cashu" || drain.method === "cashu";
    if (!cashuPayout || claimedSats !== undefined) {
      settleDrainEvidence({
        endpoint,
        ...(identity ? { identity } : {}),
        callerPubkey: signer.pubkey,
        drainId: drain.drainId,
      });
    }
  }

  // A cooperative close is the DVM's transaction to broadcast, so `sent` is the
  // caller's first news of it — and the record it would retire is the only copy
  // of the descriptor an exit needs, which no service gets to erase on its own
  // word. Confirm it against the escrow instead and retire on what the chain
  // says. A read that fails, or a close still confirming, keeps the record; a
  // drain that moved real money never becomes an error over a chain read
  const channelReconcile =
    finished && drain.method === "tempo" && mppAssociation
      ? await reconcileTempoChannelOnChain({ association: mppAssociation })
      : undefined;
  const channelNote = tempoChannelReconcileNote(channelReconcile);
  const channelHint = tempoChannelReconcileHint(channelReconcile, dvm);

  // The exposure rides on the success copy because proceeding is the only
  // posture. A retry can preserve a live unfinished funding as credit only
  // before the drain closes the channel, so the relay copy says that plainly.
  // Present-and-zero rather than absent when a released drain leaves nothing
  // outstanding, matching what the x402 branch emits: an agent reading either
  // rail generically can otherwise not tell "nothing at risk" from "unknown".
  // The prose below still keys off the value, so zero says nothing out loud.
  const mppAtRisk = released ? mppAtRiskMicro : undefined;
  const atRiskNote = x402AtRisk?.micro
    ? ` $${formatUsd(Number(x402AtRisk.micro) / 1_000_000)} was at risk in ${String(x402AtRisk.pending.length)} unfinished ${x402AtRisk.pending.length === 1 ? "funding" : "fundings"} when this x402 drain began.`
    : mppAtRisk
      ? ` The DVM can still capture up to $${formatUsd(Number(mppAtRisk) / 1_000_000)} of this Tempo channel's collateral under the vouchers this wallet has already signed.`
      : "";
  const atRiskHint = x402AtRisk?.micro
    ? ` ${x402AtRiskInstruction(x402AtRisk.micro, x402AtRisk.pending)}`
    : mppAtRisk
      ? ` That authority outlives this released drain: the credit balance is spendable again, and the channel's collateral is only settled once the channel closes on-chain. 'dvm wallet tempo-exit ${dvm}' reads the chain and reports what the exit is guaranteed to return against what it likely returns.`
      : "";
  // The DVM's own words about the refund, kept but marked: `display`/`hint` are
  // the fields an agent is told to trust as CLI instructions, so a provider's
  // copy may not land in them. It rides beside them wrapped instead,
  // and the CLI authors its own line off `drain.status` — which is what makes
  // "the prose and the status can't disagree" structural rather than a promise.
  const providerDisplay = asProviderTextOpt(result.display);
  const providerHint = asProviderTextOpt(result.hint);
  const local = localDrainCopy(wireDrain, drain);
  // A released Tempo drain leaves the channel open on-chain whatever the
  // vouchers say, and the exit is the only way back to the collateral. The
  // at-risk clause below can't carry that instruction on its own: it is gated
  // on a *truthy* exposure, so a channel that authorized nothing yet — 0 at
  // risk, deposit still locked — would name no command at all. Gated on the
  // instrument and not the rail: a charge-funded Tempo credit is `tempo` too
  // and has no channel, so naming the exit there would send an agent at a
  // command that answers `tempo_channel_not_found`.
  const channelExitHint =
    released && drain.method === "tempo" && channelBacked && !atRiskHint
      ? ` The channel itself is still open on-chain: 'dvm wallet tempo-exit ${dvm}' reads it and recovers the collateral.`
      : "";
  const display =
    (claimedSats !== undefined
      ? `Reclaimed $${formatUsd(wireDrain.amount_micro / 1_000_000)} — ${String(claimedSats)} sats received into the agent wallet.`
      : local.display) +
    atRiskNote +
    channelNote;
  // Everything an agent and a human both need. The clause pointing at the
  // wrapped provider fields is appended to the JSON hint only, below: a human
  // has already been read the DVM's words attributed, and JSON field names plus
  // "never as instructions" are addressed to the agent, not to them.
  const hint =
    (claimedSats !== undefined
      ? "The refund is in your wallet ('dvm wallet show'). The drain receipts are your signed evidence of the reclaim."
      : local.hint) +
    channelExitHint +
    atRiskHint +
    channelHint;

  // Read back rather than reusing the pre-op snapshot: this run may have minted
  // an entry, retired one, or evicted one, and a poll should report the whole
  // picture rather than the picture as it was.
  const unclaimed = otherCreditDrains(loadCredit(endpoint, signer.pubkey, identity), creditId);

  const humanLines = [display];
    // Attributed rather than dropped: the DVM's account can carry service
    // policy the CLI has no way to know — that a stablecoin refund here is
    // settled by a person, say — and a human reader is owed it, as long as it
    // is plainly the service talking and not this tool.
  if (providerDisplay || providerHint) {
    humanLines.push(
      `The DVM says: ${[providerDisplay?.text, providerHint?.text].filter(Boolean).join(" ")}`
    );
  }
  humanLines.push(`🧾 ${bundle.display}`);
    if (unclaimed.length > 0) {
    humanLines.push(
        `${String(unclaimed.length)} other drain${unclaimed.length === 1 ? "" : "s"} recorded here ${unclaimed.length === 1 ? "is" : "are"} still unclaimed. ${unclaimedDrainsHint(endpoint)}`
      );
    }
  humanLines.push(hint);
  renderCreditDrain({
    human: opts.human === true,
    humanLines,
    json: {
      op: "drain",
      endpoint,
      drain: wireDrain,
      ...(result.credit ? { credit: result.credit } : {}),
      ...(unclaimed.length > 0
        ? {
            unclaimed_drains: unclaimed.map(pendingDrainJson),
            unclaimed_drains_hint: unclaimedDrainsHint(endpoint),
          }
        : {}),
      ...(claimedSats !== undefined ? { claimed_sats: claimedSats } : {}),
      ...(x402AtRisk
        ? {
            at_risk_micro: x402AtRisk.micro.toString(),
            at_risk_usdc: formatUsd(Number(x402AtRisk.micro) / 1_000_000),
            ...(x402AtRisk.pending.length > 0
              ? { pending_fundings: x402AtRisk.pending.map(x402PendingFundingJson) }
              : {}),
          }
        : {}),
    // Same fields on either rail: a drain settles one channel, so only one of
    // the two exposures can exist.
      ...(mppAtRisk !== undefined
        ? {
            at_risk_micro: mppAtRisk.toString(),
            at_risk_usdc: formatUsd(Number(mppAtRisk) / 1_000_000),
          }
        : {}),
      ...(channelReconcile
        ? {
            channel_chain_status: channelReconcile.status,
            channel_retired: channelReconcile.retired,
            ...(channelReconcile.error
              ? { channel_chain_error: channelReconcile.error.code }
              : {}),
          }
        : {}),
      receipts_verified: bundle.verdict,
      receipts_total: bundle.total,
      receipts_checked: bundle.checkedJson,
      receipts_display: bundle.display,
      receipts_hint: drainReceiptsHint(bundle.verdict),
      ...(providerDisplay ? { provider_display: providerDisplay } : {}),
      ...(providerHint ? { provider_hint: providerHint } : {}),
      display,
      hint: hint + providerCopyHint("refund", Boolean(providerDisplay ?? providerHint)),
    },
  });
}

const exportInteger = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const exportPubkey = z.string().regex(/^[0-9a-f]{64}$/i);
const exportSignature = z.string().regex(/^[0-9a-f]{128}$/i);
const drainExportReceiptSchema = z
  .object({
    v: z.literal(1),
    kind: z.literal("credit_drain"),
    credit_id: z.string(),
    drain_id: z.string(),
    event: z.enum(["requested", "parked", "picked_up", "sent", "released"]),
    method: z.string(),
    amount_micro: exportInteger,
    balance_after_micro: exportInteger.optional(),
    ledger_seq: exportInteger.optional(),
    issued_at: exportInteger,
    caller_pubkey: exportPubkey,
    dvm_id: z.string(),
    dvm: z.string(),
    receipt_pubkey: exportPubkey,
    signature: exportSignature,
  })
  .strict();
const drainExportAnchorSchema = z
  .object({
    pubkey: exportPubkey,
    signature: exportSignature,
    attestation: z
      .object({
        dvm_id: z.string(),
        slug: z.string(),
        capabilities_hash: exportPubkey,
        builder_pubkey: exportPubkey,
        receipt_pubkey: exportPubkey.optional(),
        deployed_at: exportInteger,
      })
      .strict(),
  })
  .strict();

function receiptHistoryFacts(evidence: {
  history?: CompletedRefundHistoryRecord;
}): Record<string, unknown> {
  const record = evidence.history;
  return {
    outcome: record ? "refunded" : "pending",
    rail: record?.rail ?? null,
    currency: record?.currency ?? null,
    amount_micro: record?.amountMicro ?? null,
    fee_micro: record?.feeMicro ?? null,
    ...(record ? { history_id: record.id, provenance: record.provenance } : {}),
  };
}

/**
 * Read the stored reclaim evidence for one DVM back — offline, re-verified.
 *
 * The mirror of `dvm receipts verify` / `export` for drain receipts.
 * Every read re-walks the chain from the bytes on disk rather than replaying
 * the verdict `dvm credit drain` reported, so a hand-edited `credits.json`
 * changes the answer; and it judges against the anchor pinned beside the
 * receipts at reclaim time, because that advertisement — not whatever the DVM
 * serves today — is what a dispute is about.
 */
export async function runCreditReceipts(
  dvm: string,
  opts: CreditReceiptsOptions,
): Promise<void> {
  const endpoint = resolveCreditEndpoint(dvm);
  const signer = resolveSigningIdentity({ as: opts.as, config: loadConfig() });
  const stored = loadCredit(endpoint, signer.pubkey);
  const archived = completedCreditHistory({
    ...(stored ? {} : { endpoint }),
    callerPubkey: signer.pubkey,
  }).filter(
    (record): record is CompletedRefundHistoryRecord =>
      record.kind === "completed_refund" &&
      (!stored ||
        completedServiceMatches(record, stored) ||
        completedOriginsOverlap(record, stored)),
  );
  if (!stored && archived.length === 0) {
    throw new DvmError(
      "credit_not_found",
      `No reclaim evidence tracked at ${endpoint}.`,
      "Use the original endpoint and caller identity for stored reclaim evidence.",
    );
  }
  type Evidence = NonNullable<StoredCredit["drainEvidence"]>[number] & {
    history?: CompletedRefundHistoryRecord;
  };
  // Completed bundles come only from the durable reader; the working store is
  // still authoritative for unresolved evidence and recovery descriptors.
  let evidence: Evidence[] = [
    ...(stored?.drainEvidence ?? []).filter(
      (entry) =>
        entry.settledAt === undefined &&
        !archived.some(
          (record) => stored && completedDrainMatches(record, stored, entry),
        ),
    ),
    ...archived.map(
      (record): Evidence => ({
        drainId: record.drainId,
        creditId: record.creditId,
        receipts: record.receipts,
        anchor: record.anchor,
        collectedAt: record.collectedAt ?? 0,
        settledAt: record.settledAt,
        history: record,
      }),
    ),
  ].sort(
    (a, b) =>
      (b.settledAt ?? b.collectedAt) - (a.settledAt ?? a.collectedAt) ||
      (a.creditId + ":" + a.drainId).localeCompare(
        b.creditId + ":" + b.drainId,
      ),
  );
  if (opts.drainId) {
    evidence = evidence.filter((e) => e.drainId === opts.drainId);
    if (evidence.length === 0) {
      throw new DvmError(
        "drain_not_found",
        `No stored reclaim evidence for drain ${opts.drainId} at ${endpoint}.`,
        "Run without --drain-id to list every drain this caller holds evidence for here.",
      );
    }
  }

  // Export before any network: the bundle is the artifact as collected, and
  // handing it on must work with the machine offline.
  //
  // Both ids come off the bundle, never off the record: `drainEvidence`
  // survives an `adoptCreditId` swap, so `stored.creditId` here would stamp a
  // *later* credit onto an older reclaim's line — an envelope disagreeing with
  // the `credit_id` inside the receipts it wraps, in the one artifact whose job
  // is to prove nothing was altered.
  if (opts.export) {
    // Do not strip unknown signed fields: doing so would alter the artifact.
    // Refuse unsupported observations before writing any JSONL bundle.
    for (const e of evidence) {
      if (e.anchor && !drainExportAnchorSchema.safeParse(e.anchor).success) {
        throw new DvmError(
          "unsafe_receipt_export",
          "Stored reclaim evidence contains unsupported identity fields.",
          "Select a supported bundle with --drain-id; identity artifacts are exported without stripping signed fields.",
        );
      }
      if (
        e.receipts.some(
          (receipt) => !drainExportReceiptSchema.safeParse(receipt).success,
        )
      ) {
        throw new DvmError(
          "unsafe_receipt_export",
          "Stored reclaim evidence contains unsupported receipt fields.",
          "Select a supported bundle with --drain-id; unresolved recovery credentials cannot be exported.",
        );
      }
    }
    for (const e of evidence) {
      const checked = verifyDrainBundle(e.receipts, e.anchor, {
        drainId: e.drainId,
        creditId: e.creditId,
      });
      raw(
        JSON.stringify({
          drain_id: e.drainId,
          credit_id: e.creditId,
          endpoint: e.history?.endpoint ?? stored?.endpoint ?? endpoint,
          caller_pubkey:
            e.history?.callerPubkey ?? stored?.callerPubkey ?? signer.pubkey,
          collected_at: e.history
            ? e.history.collectedAt
            : e.collectedAt || null,
          ...(e.settledAt !== undefined ? { settled_at: e.settledAt } : {}),
          ...receiptHistoryFacts(e),
          verification: {
            provenance: "offline_recheck",
            anchor_source: anchorSource(e.anchor, false),
            verdict: checked.verdict,
            checked: checked.checkedJson,
          },
          receipts: e.receipts,
          ...(e.anchor ? { builder: e.anchor } : {}),
        }),
      );
    }
    return;
  }

  // `--refetch` deliberately grades against the identity this DVM advertises
  // *now*: not the dispute question, but the one that answers "did the key
  // that signed my refund get rotated away?".
  let refetched: ReceiptTrustAnchor | undefined;
  if (opts.refetch) {
    const transport = createDvmTransport();
    let read: TrustAnchorRead;
    try {
      read = await fetchTrustAnchor(transport, { endpoint });
    } finally {
      transport.close();
    }
    if (!read.reachable) {
      throw new DvmError(
        "endpoint_unreachable",
        `Could not read /v1/info at ${endpoint} to re-fetch the builder identity.`,
        "Drop --refetch to re-check against the anchor pinned when the receipts were collected — that check needs no network.",
      );
    }
    refetched = read.anchor;
  }

  // The store's `drainId`/`creditId` are unsigned labels a hand-edit can move,
  // so each bundle is graded against the ones it is filed under: a relabelled
  // bundle reads `invalid`, not `verified` under someone else's heading.
  const rows = evidence.map((e) => {
    const anchor = opts.refetch ? refetched : e.anchor;
    const filedUnder = {
      drainId: e.drainId,
      ...(e.creditId ? { creditId: e.creditId } : {}),
    };
    return {
      evidence: e,
      anchor,
      bundle: verifyDrainBundle(e.receipts, anchor, filedUnder),
    };
  });
  const verdict = weakestReceiptVerdict(rows.map((r) => r.bundle.verdict));
  const total = rows.reduce((sum, r) => sum + r.bundle.total, 0);
  const sound = rows.reduce((sum, r) => sum + r.bundle.sound, 0);
  const label = dvmLabelFromEndpoint(endpoint);
  // `drainReceiptsDisplay("absent", …)` says the DVM *returned* nothing, which
  // is a claim about a drain that ran. Nothing stored means none ever did.
  const display =
    rows.length === 0
      ? `No reclaim evidence stored for ${label}: no drain has been run from this caller's identity here.`
      : drainReceiptsDisplay(verdict, sound, total);
  const hint =
    rows.length === 0
      ? `No reclaim has been requested at ${label} yet — 'dvm credit drain ${dvm}' reclaims the balance and collects the evidence.`
      : `${drainReceiptsHint(verdict)} This re-check ran offline against the identity pinned at reclaim time; hand the raw bundle to a third party with 'dvm credit receipts ${dvm} --export'.`;

  const humanLines: string[] = [];
  if (rows.length === 0) {
    humanLines.push(display, hint);
  } else {
    humanLines.push(`Reclaim evidence at ${label}:`);
    for (const r of rows) {
      humanLines.push("");
      humanLines.push(
        `  drain ${r.evidence.drainId} · credit ${r.evidence.creditId} · ${String(r.bundle.total)} receipt(s) · collected ${epochMsToIso(r.evidence.collectedAt) ?? "unknown"} · ${r.evidence.settledAt === undefined ? "still owed" : `paid ${epochMsToIso(r.evidence.settledAt) ?? "unknown"}`}`,
      );
      humanLines.push(`  ${r.bundle.display}`);
      for (const [i, check] of r.bundle.checked.entries()) {
        const event =
          drainReceiptEvent(r.evidence.receipts[i]) ?? "unrecognised";
        const detail = check.reason
          ? ` — ${receiptFailureDetail(check.reason)}`
          : "";
        humanLines.push(`    ${event.padEnd(11)} ${check.status}${detail}`);
      }
      humanLines.push(
        `    anchor: ${anchorSourceHuman(anchorSource(r.anchor, opts.refetch === true))}`,
      );
    }
    humanLines.push("", hint);
  }
  renderCreditReceipts({
    human: opts.human === true,
    humanLines,
    json: {
      op: "receipts",
      endpoint,
      dvm: label,
      // The credit currently tracked here, which is not necessarily the one any
      // given drain reclaimed — each row carries its own.
      credit_id: stored?.creditId ?? null,
      drains: rows.map((r) => ({
        drain_id: r.evidence.drainId,
        ...receiptHistoryFacts(r.evidence),
        credit_id: r.evidence.creditId,
        collected_at: epochMsToIso(r.evidence.collectedAt),
        // Whether the refund this evidence is about actually arrived. Absent
        // means still owed — the bundle is an open IOU, and the one kind this
        // record never trims away.
        ...(r.evidence.settledAt !== undefined
          ? { settled_at: epochMsToIso(r.evidence.settledAt) }
          : {}),
        anchor_source: anchorSource(r.anchor, opts.refetch === true),
        receipts_verified: r.bundle.verdict,
        receipts_total: r.bundle.total,
        receipts_checked: r.bundle.checkedJson,
        receipts: r.evidence.receipts,
        ...(r.anchor ? { builder: r.anchor } : {}),
        display: r.bundle.display,
      })),
      drains_total: rows.length,
      receipts_verified: verdict,
      receipts_total: total,
      display,
      hint,
    },
  });
}

/**
 * The CLI's own account of a drain, keyed on the state the server reported.
 *
 * Written here rather than relayed from the DVM: `display` and
 * `hint` are the fields the output contract declares CLI-authored and an agent
 * is told to act on, so provider prose may not reach them. Every sentence below
 * is derived from `drain.status`, the rail, and the payout this caller signed,
 * which is why the copy and the status cannot drift apart. Nothing here asserts
 * *how* a given service fulfils a refund — that is the provider's own claim, and
 * it rides in `provider_display` / `provider_hint`.
 *
 * `status` is a bare string on the wire, so an unrecognised state falls through
 * to naming it rather than guessing at a meaning.
 */
function localDrainCopy(
  wire: DrainWire,
  requested: PendingDrain
): { display: string; hint: string } {
  const amount = formatFiat(wire.amount_micro / 1_000_000, wire.currency);
  const poll = "Re-run this command to poll; the same drain id is request, poll, and pickup.";
  switch (wire.status) {
    case "pending":
      if (wire.method === "cashu") {
        return {
          // The in-kind figure leads when the DVM published one: a
          // Bitcoin refund owes the unspent share of the *sats* deposited,
          // fixed at the rates each funding landed at, and leading with the
          // fiat figure would read as a promise of that amount when the sats
          // are what actually arrive.
          display:
            wire.owed_sats === undefined
              ? `${amount} of refund is approved and being prepared. Nothing has been paid out yet.`
              : `${String(wire.owed_sats)} sats of refund is approved and being prepared — the figure was fixed when the reclaim was requested, and was worth ${amount} then. Nothing has been paid out yet.`,
          hint: poll,
        };
      }
      // No payout address means the reclaim is a cooperative close of the
      // channel that funded the credit: the destination is fixed by the channel
      // rather than named by this caller.
      if (!requested.payout.address) {
        return {
          display: `${amount} of refund is approved against the payment channel. The on-chain settlement has not completed yet.`,
          hint: poll,
        };
      }
      return {
        display: `${amount} of refund is approved and recorded as a debt owed to ${requested.payout.address}. Nothing has been paid out yet — a status of 'sent', carrying a settlement reference, is what says it has.`,
        hint: `${poll} The signed 'requested' receipt in this response is your evidence of the debt until then.`,
      };
    case "parked":
    case "picked_up":
      return {
        display: `${amount} of refund is ready to collect: the DVM has parked a token locked to your wallet's refund key.`,
        hint: "Re-run this command to redeem the parked token into the agent wallet; only your key can claim it.",
      };
    case "sent":
      return {
        display: `The DVM reports ${amount} of refund was paid out to the destination this drain named.`,
        hint: "The settlement reference is in drain.sent. The drain receipts are your signed evidence of the reclaim.",
      };
    case "released":
      return {
        display: `The refund could not complete, so the DVM restored ${amount} to the prepaid balance.`,
        hint: "This released drain is terminal — do not poll it again. The balance is spendable, or reclaimable on a fresh drain.",
      };
    default:
      return { display: `Drain ${wire.status}.`, hint: poll };
  }
}

/**
 * The lifecycle event a returned drain receipt claims, so a per-receipt verdict
 * row says *which* event it is about. `null` when the entry isn't structurally
 * a receipt — which is also why the verdict beside it is `invalid`.
 */
function drainReceiptEvent(receipt: unknown): string | null {
  return isDrainReceipt(receipt) ? receipt.event : null;
}

/**
 * Verify one drain's receipt bundle and shape every surface that quotes it.
 *
 * Shared by the drain itself and the read-back verb so both grade the same
 * bytes the same way — a read-back that reported in a different vocabulary
 * than the drain did would be a second implementation of the same trust
 * claim, which is the one thing this must not be.
 *
 * `filedUnder` is the reclaim the caller believes these receipts are evidence
 * of — on the wire, the drain just requested; on a read-back, the unsigned
 * labels the store filed the bundle under. Binding them is what stops a
 * relabelled bundle from reading `verified`.
 */
function verifyDrainBundle(
  receipts: unknown[],
  anchor?: ReceiptTrustAnchor,
  filedUnder?: { drainId: string; creditId?: string }
): DrainBundle {
  const checked = receipts.map((receipt) =>
    verifyDrainReceiptChain({
      receipt,
      ...(anchor ? { builder: anchor } : {}),
      ...(filedUnder ? { expectedDrainId: filedUnder.drainId } : {}),
      ...(filedUnder?.creditId ? { expectedCreditId: filedUnder.creditId } : {}),
    })
  );
  const verdict = weakestReceiptVerdict(checked.map((c) => c.status));
  // The tally the copy quotes: how many of the receipts held up at all. Under
  // a `verified` verdict every one of them did, by construction.
  const sound = checked.filter((c) => c.status !== "invalid").length;
  return {
    verdict,
    total: receipts.length,
    sound,
    checked,
    checkedJson: checked.map((c, i) => ({
      event: drainReceiptEvent(receipts[i]),
      receipt_verified: c.status,
      receipt_checks: c.checks,
      ...(c.reason
        ? { receipt_error: c.reason, receipt_error_detail: receiptFailureDetail(c.reason) }
        : {}),
    })),
    display: drainReceiptsDisplay(verdict, sound, receipts.length),
  };
}

interface DrainBundle {
  verdict: ReceiptVerification;
  total: number;
  sound: number;
  checked: DrainReceiptVerifyResult[];
  checkedJson: Record<string, unknown>[];
  display: string;
}

function anchorSource(
  anchor: ReceiptTrustAnchor | undefined,
  refetched: boolean
): "refetched" | "stored" | "absent" {
  if (!anchor) return "absent";
  return refetched ? "refetched" : "stored";
}

function anchorSourceHuman(source: "refetched" | "stored" | "absent"): string {
  if (source === "refetched") return "re-fetched from the DVM just now";
  if (source === "stored") return "as this DVM published it when the refund was recorded";
  return "none — this DVM publishes no builder identity";
}

function unclaimedDrainsHint(endpoint: string): string {
  return `Reclaim one with 'dvm credit drain ${endpoint} --credit-id <its credit_id>'; a drain recorded without a credit_id predates that field and needs both — '--drain-id <its drain_id> --credit-id <the credit it was requested on>'.`;
}

/**
 * Explain the choice an outstanding voucher presented before this drain.
 *
 * Names the concrete credit id rather than a `<id>` placeholder because
 * `--human` output never prints `pending_fundings`. A refused funding has no
 * retry path, so its copy does not pretend clearing local bookkeeping can turn
 * it back into credit.
 */
function x402AtRiskInstruction(micro: bigint, pending: PendingX402Funding[]): string {
  const { entry, retriable } = x402ReservationRelease(pending);
  const amount = `$${formatUsd(Number(micro) / 1_000_000)}`;
  return retriable
    ? `${amount} was in an unfinished funding. To keep it as credit, retry that funding first ('dvm credit fund ${entry.endpoint} --credit-id ${entry.creditId}'); this drain abandoned the retry and returned what the DVM confirmed.`
    : `${amount} belonged to funding the DVM refused, so it could not be retried into credit. This drain returned what the DVM confirmed; retiring the journal entry would only change local reporting, not revoke its signed claim.`;
}

/**
 * What the chain said about the channel a cooperative close claimed to settle.
 *
 * Reads as an addition to the drain's own success sentence, so it is worded as
 * a clause about the channel rather than about the reclaim: the money question
 * is already answered above it, and the collateral is a separate one.
 */
function tempoChannelReconcileNote(result: TempoChannelReconcileResult | undefined): string {
  if (!result) return "";
  if (result.retired) {
    return " The channel's close is confirmed on-chain, so its local recovery record has been retired.";
  }
  if (result.status === "unreadable") {
    return " The chain could not be read from here to confirm the channel's close, so its local recovery record was kept.";
  }
  if (result.status === "unconfirmed") {
    return " The escrow has no record of this channel, so its local recovery record was kept.";
  }
  if (result.status === "closed") {
    // Confirmed closed, record kept: either a newer channel has taken over this
    // payment scope — its record now, not this channel's — or the retire itself
    // could not run. Nothing is at risk either way; `wallet balance` re-reads.
    return result.error
      ? " The channel's close is confirmed on-chain, but its local recovery record could not be retired this run and was kept."
      : " The channel's close is confirmed on-chain; its local record was kept because a newer channel now occupies its payment scope.";
  }
  return ` The escrow still shows $${formatUsd(result.depositMicro / 1_000_000)} of collateral in this channel, so its local recovery record was kept.`;
}

/**
 * What to do about a channel record the close did not retire.
 *
 * Points at `wallet balance` rather than `wallet tempo-exit` for the two
 * still-confirming cases: balance re-reads the escrow and retires the record on
 * the same evidence, while `tempo-exit` against a channel the chain still shows
 * open *starts a unilateral close* — a fee and a 15-minute grace period the
 * caller did not ask for, on a channel the DVM has probably already closed.
 */
function tempoChannelReconcileHint(
  result: TempoChannelReconcileResult | undefined,
  dvm: string
): string {
  if (!result || result.retired) return "";
  const reread =
    " Re-run 'dvm wallet balance' later: it re-reads the escrow and retires the record once the close is visible there, and broadcasts nothing.";
  if (result.status === "unreadable") {
    return `${result.error?.hint ? ` ${result.error.hint}` : ""}${reread}`;
  }
  if (result.status === "unconfirmed") {
    return ` That record is this wallet's only route to the collateral if the open does land, which is why it is kept. 'dvm wallet tempo-exit ${dvm}' reads the chain and reports where the channel actually is.`;
  }
  if (result.status === "closed") {
    return " Nothing is at risk: the escrow has already paid this collateral back. Re-run 'dvm wallet balance' to clear the leftover record.";
  }
  return `${reread} If the close never appears there, 'dvm wallet tempo-exit ${dvm}' recovers the collateral unilaterally.`;
}

/**
 * A recorded drain, re-stated for a re-post.
 *
 * Verbatim where it can be — the payout the DVM signed is immutable server-side
 * — but `credits.json` is hand-editable and read without a schema, so an entry
 * can carry nothing but its id whatever the type says. The current values stand
 * in for what is missing rather than posting `undefined`: a payout that turns
 * out not to match what was signed earns a `drain_conflict` the caller can act
 * on, where a schema rejection just loses the poll.
 */
function reusableDrain(
  pending: PendingDrain,
  method: string,
  payout: Record<string, string>
): PendingDrain {
  const onDisk = pending as Partial<PendingDrain>;
  return {
    ...pending,
    method: onDisk.method ?? method,
    payout: onDisk.payout ?? payout,
    requestedAt: onDisk.requestedAt ?? Date.now(),
  };
}

/**
 * Exact terminal push evidence that makes a stale local poll marker removable.
 *
 * Tempo `sent` receipts attest that the DVM completed the push refund. Replaying
 * a marker recreated after its channel association retired can only change the
 * saved payout binding and earn `drain_conflict`; it cannot add evidence. x402
 * normally keeps its marker so an exact replay can recover the chain reference;
 * the explicit recovery option admits the same signed terminal proof only for
 * a caller that already retained that reference independently. Cashu stays
 * excluded because `picked_up` says the token left the DVM, not that this wallet
 * redeemed it.
 */
function settledPushDrainRecovery(
  stored: StoredCredit | undefined,
  pending: PendingDrain,
  creditId: string,
  method: string,
  options: { allowX402: boolean }
):
  | {
      evidence: NonNullable<StoredCredit["drainEvidence"]>[number];
      bundle: DrainBundle;
      receipt: DrainReceipt;
    }
  | undefined {
  if (
    !stored ||
    pending.creditId !== creditId ||
    pending.method !== method ||
    (method !== "tempo" && !(method === "x402" && options.allowX402)) ||
    (method === "tempo" &&
      (stored.creditId !== creditId || stored.status !== "drained" || stored.remainingMicro !== 0))
  )
    return undefined;
  const evidence = stored.drainEvidence?.find(
    (candidate) =>
      candidate.drainId === pending.drainId &&
      candidate.creditId === creditId &&
      candidate.settledAt !== undefined
  );
  if (!evidence?.anchor || !evidence.receipts.every(isDrainReceipt)) return undefined;
  const receipts = evidence.receipts;
  const sent = receipts.findLast((receipt) => receipt.event === "sent");
  if (
    !sent ||
    receipts[0]?.event !== "requested" ||
    receipts.at(-1)?.event !== "sent" ||
    receipts.some(
      (receipt) =>
        receipt.credit_id !== creditId ||
        receipt.drain_id !== pending.drainId ||
        receipt.method !== method ||
        receipt.caller_pubkey !== stored.callerPubkey ||
        receipt.amount_micro !== sent.amount_micro ||
        receipt.balance_after_micro !== 0
    )
  )
    return undefined;
  const bundle = verifyDrainBundle(evidence.receipts, evidence.anchor, {
    drainId: pending.drainId,
    creditId,
  });
  return bundle.verdict === "verified" ? { evidence, bundle, receipt: sent } : undefined;
}

/**
 * Validate + shape the payout target for a fresh drain.
 *
 * The stablecoin rails carry two instruments each, and they reclaim
 * differently. A **channel** fixes its payer in the channel config,
 * so the payout is empty and the server records the channel id in its place —
 * keeping it empty is also what makes a lost-response poll match that
 * immutable record. A **one-payment** credit (an x402 `exact` authorization, a
 * Tempo charge) has no channel and no payer on file, so the caller names the
 * address the refund should land at; without one the DVM has nowhere to send
 * it and refuses.
 */
async function drainPayout(
  method: string,
  opts: CreditDrainOptions,
  channelBacked: boolean,
  dvm: string
): Promise<Record<string, string>> {
  if (opts.address && method !== "x402" && method !== "tempo") {
    throw new DvmError(
      "invalid_argument",
      `--address is an EVM refund destination and does not apply to --method ${method}.`,
      "A cashu refund is locked to your agent wallet's key, which the CLI supplies. Drop --address."
    );
  }
  if (method === "cashu") {
    const wallet = loadAgentWallet();
    if (!wallet) {
      throw new DvmError(
        "no_agent_wallet",
        "A cashu drain parks the refund locked to your agent wallet's key, but no wallet exists.",
        "Run 'dvm wallet init' to create one — the refund is locked to its key, so the wallet has to exist before the reclaim can be requested. The balance stays yours in the meantime."
      );
    }
    // The wallet's 33-byte compressed lock pubkey — never the x-only signing
    // key: parked notes must be witness-spendable by the wallet.
    return { refund_pubkey: wallet.lock_pubkey };
  }
  if (method === "x402") {
    if (channelBacked) {
      if (opts.address) throw channelAddressRefusal("x402", dvm);
      const wallet = loadX402Wallet();
      if (!wallet) {
        throw new DvmError(
          "x402_wallet_missing",
          "An x402 channel drain needs the wallet that signed its vouchers.",
          "Reconnect that exact key: 'dvm wallet x402-connect --key-file <path>', or DVM_X402_KEY=<key> dvm wallet x402-connect. A bare 'dvm wallet x402-connect' generates a new wallet, which cannot sign for an existing channel."
        );
      }
      return {};
    }
    // A one-payment refund lands wherever the caller says, so a named address
    // stands in for the connected wallet entirely — which is the point of the
    // flag on a machine that has none, or after a key rotation.
    if (opts.address) return { address: refundAddress(opts.address) };
    const wallet = loadX402Wallet();
    if (!wallet) {
      throw new DvmError(
        "x402_wallet_missing",
        "An x402 drain refunds to your connected x402 wallet, and no wallet is connected.",
        "Connect one with 'dvm wallet x402-connect', or name the destination yourself with --address 0x…."
      );
    }
    return { address: refundAddress((await ensureAddress(wallet)).address) };
  }
  if (method === "tempo") {
    if (channelBacked) {
      if (opts.address) throw channelAddressRefusal("tempo", dvm);
      return {};
    }
    if (opts.address) return { address: refundAddress(opts.address) };
    const account = await connectedTempoAccount();
    if (!account) {
      throw new DvmError(
        "tempo_wallet_missing",
        "This credit was funded by a one-off Tempo charge, so its refund needs an address, and no Tempo wallet is connected to supply one.",
        "Connect one with 'dvm wallet tempo-connect', or name the destination yourself with --address 0x…."
      );
    }
    return { address: refundAddress(account.address) };
  }
  throw new DvmError(
    "invalid_argument",
    `Unsupported drain method "${method}".`,
    "Use --method cashu to be paid as ecash, --method x402 for an x402-funded credit, or --method tempo for a Tempo-funded credit."
  );
}

/**
 * A channel refund goes back to the payer the channel was opened from, which
 * the caller does not get to redirect — so say so rather than dropping the
 * flag, and name the way out if the DVM disagrees about the channel.
 *
 * That way out differs by rail, because the CLI's own guards do. An x402
 * credit is free to be drained over another rail, so the escape is that rail.
 * A Tempo credit is not: while the local session association exists, every
 * non-`tempo` method is refused here before it can post, so pointing at cashu
 * would dead-end. `wallet tempo-exit` is the one command that resolves the
 * disagreement — it reads the channel's on-chain state and retires the local
 * record when nothing is left in it, after which the other rails open up.
 */
function channelAddressRefusal(method: "x402" | "tempo", dvm: string): DvmError {
  const channel =
    method === "x402" ? "an x402 batch-settlement channel" : "a Tempo session channel";
  const escape =
    method === "x402"
      ? `If the DVM says it has no channel for this credit, reclaim the balance as ecash instead — '--method cashu'.`
      : `If the DVM says it has no channel for this credit, run 'dvm wallet tempo-exit ${dvm}': it settles the channel on-chain, or retires the local record when the chain shows nothing left in it — and the ecash reclaim ('--method cashu') becomes available once it is gone.`;
  return new DvmError(
    "invalid_argument",
    `This credit is backed by ${channel}, so its refund settles back to the wallet that opened the channel and --address cannot redirect it.`,
    `Drop --address to close the channel. ${escape}`
  );
}

/** An EVM refund destination, checked here so a typo costs no signature. */
function refundAddress(address: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new DvmError(
      "invalid_argument",
      `"${address}" is not an EVM address (0x + 40 hex characters).`,
      "Pass --address 0x… with the address the refund should land at, or drop the flag to use the wallet connected on this rail."
    );
  }
  return address;
}
