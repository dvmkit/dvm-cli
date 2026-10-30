import { CREDIT_DRAIN_RAILS, CREDIT_FUND_RAILS, CREDIT_FUNDING_MODES } from "@dvmkit/sdk/internal";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Command } from "commander";

import type { BrowseOptions } from "../commands/browse";
import { browse } from "../commands/browse";
import type { BudgetSetOptions, BudgetStatusOptions } from "../commands/budget";
import { budgetSet, budgetStatus } from "../commands/budget";
import type { CancelOptions } from "../commands/cancel";
import { cancel } from "../commands/cancel";
import type { ConfigResetOptions, ConfigRollbackOptions } from "../commands/config";
import { configReset, configRollback } from "../commands/config";
import type { ConvertOptions } from "../commands/convert";
import { convert } from "../commands/convert";
import type {
  CreditBalanceOptions,
  CreditDeselectOptions,
  CreditDrainOptions,
  CreditFundOptions,
  CreditListOptions,
  CreditPostureOptions,
  CreditRailOptions,
  CreditReceiptsOptions,
} from "../commands/credit";
import {
  creditBalance,
  creditDeselect,
  creditDrain,
  creditFund,
  creditList,
  creditPosture,
  creditRail,
  creditReceipts,
} from "../commands/credit";
import type { CreditTrustOptions } from "../commands/credit-trust";
import { creditTrust } from "../commands/credit-trust";
import type { DescribeOptions } from "../commands/describe";
import { describe } from "../commands/describe";
import type { DoctorOptions } from "../commands/doctor";
import { doctor } from "../commands/doctor";
import type { FavAddOptions, FavListOptions, FavRmOptions } from "../commands/fav";
import { favAdd, favList, favRm } from "../commands/fav";
import type { FeedbackOptions } from "../commands/feedback";
import { feedback } from "../commands/feedback";
import type {
  IdentityCreateOptions,
  IdentityDeleteOptions,
  IdentityImportOptions,
  IdentityListOptions,
  IdentityShowOptions,
  IdentityUseOptions,
} from "../commands/identity";
import {
  identityCreate,
  identityDelete,
  identityImport,
  identityList,
  identityShow,
  identityUse,
} from "../commands/identity";
import type { InitOptions } from "../commands/init";
import { init } from "../commands/init";
import type { MessageOptions } from "../commands/message";
import { message } from "../commands/message";
import type { MessagesOptions } from "../commands/messages";
import { messages } from "../commands/messages";
import type { PayOptions } from "../commands/pay";
import { pay } from "../commands/pay";
import type { QuoteOptions } from "../commands/quote";
import { quote } from "../commands/quote";
import type {
  ReceiptsExportOptions,
  ReceiptsListOptions,
  ReceiptsShowOptions,
  ReceiptsVerifyOptions,
} from "../commands/receipts";
import { receiptsExport, receiptsList, receiptsShow, receiptsVerify } from "../commands/receipts";
import type { RequestOptions } from "../commands/request";
import { request } from "../commands/request";
import type { RequestResultOptions } from "../commands/request-result";
import { requestResult } from "../commands/request-result";
import type { RequestResumeOptions } from "../commands/request-resume";
import { requestResume } from "../commands/request-resume";
import type { SearchOptions } from "../commands/search";
import { search } from "../commands/search";
import type { StatusOptions } from "../commands/status";
import { status } from "../commands/status";
import type { UploadOptions } from "../commands/upload";
import { upload } from "../commands/upload";
import {
  walletBalance,
  type WalletBalanceOptions,
  walletConnect,
  type WalletConnectOptions,
  walletDisconnect,
  walletSetup,
  type WalletSetupOptions,
} from "../commands/wallet";
import type { WalletAgentRecoverOptions, WalletInitOptions } from "../commands/wallet-agent";
import { walletInit, walletRecover } from "../commands/wallet-agent";
import type {
  WalletFundOptions,
  WalletReceiveTokenOptions,
  WalletShowOptions,
} from "../commands/wallet-agent-fund";
import { walletFund, walletReceiveToken, walletShow } from "../commands/wallet-agent-fund";
import type { WalletReleaseOptions, WalletReserveOptions } from "../commands/wallet-agent-reserve";
import { walletRelease, walletReserve } from "../commands/wallet-agent-reserve";
import type { WalletRestoreOptions } from "../commands/wallet-agent-restore";
import { walletRestore } from "../commands/wallet-agent-restore";
import type { WalletCashOutOptions } from "../commands/wallet-cash-out";
import { walletCashOut } from "../commands/wallet-cash-out";
import type {
  WalletMintAddOptions,
  WalletMintHealthOptions,
  WalletMintListOptions,
} from "../commands/wallet-cashu";
import { walletMintAdd, walletMintHealth, walletMintList } from "../commands/wallet-cashu";
import type { WalletHistoryOptions } from "../commands/wallet-history";
import { walletHistory } from "../commands/wallet-history";
import { walletMppConnect, walletMppDisconnect, walletMppExit } from "../commands/wallet-mpp";
import {
  walletPair,
  walletPairComplete,
  type WalletPairCompleteOptions,
  type WalletPairOptions,
} from "../commands/wallet-pair";
import type { WalletRecoverSubmissionOptions } from "../commands/wallet-recover-submission";
import { walletRecoverSubmission } from "../commands/wallet-recover-submission";
import { walletSetDefaultRail } from "../commands/wallet-set-default-rail";
import type { WalletSubmissionsOptions } from "../commands/wallet-submissions";
import { walletSubmissions } from "../commands/wallet-submissions";
import {
  walletX402ClearPending,
  type WalletX402ClearPendingOptions,
  walletX402Connect,
  walletX402Disconnect,
  walletX402Network,
  type WalletX402WithdrawalOptions,
  walletX402WithdrawFinalize,
  walletX402WithdrawInitiate,
} from "../commands/wallet-x402";
import { CALLER_VERSION } from "../lib/caller-version";
import { catchErrors } from "../lib/error-handler";
import { installGlobalAcceptEncoding } from "../lib/http";
import { BLOCKED_SECRET_PATHS_LIST } from "../lib/secret-input";

/** Build the fully-configured `dvm` commander program without parsing argv. Importing this module has no side effects; the CLI parse happens only when the file is executed directly (see entrypoint guard at the bottom). */
export function buildProgram(): Command {
  const program = new Command();
  const creditFundRails = CREDIT_FUND_RAILS.join(", ");
  // Deliberately not `creditFundRails`: Lightning funds a credit but never
  // pays one back out, so the reclaim list is the funding list
  // minus that rail.
  const creditDrainRails = CREDIT_DRAIN_RAILS.join(", ");
  const creditFundingModes = CREDIT_FUNDING_MODES.join(", ");

  program
    .name("dvm")
    .description("One wallet, every service — pay per call in bitcoin, no accounts, no API keys.")
    .version(CALLER_VERSION);

  program
    .command("init")
    .description(
      "Create any missing caller setup (~/.dvm/config.json and a default signing identity). Idempotent: re-running it never changes anything already configured"
    )
    .option(
      "--no-identity",
      "Skip provisioning a default signing identity (~/.dvm/identities.json)"
    )
    .option("--human", "Human-readable output instead of JSON")
    // The one place `--force` still gets an answer. A stale recipe or
    // an agent working from an older doc reaches this string, and a bare
    // "unknown option" would leave it guessing at the door that replaced it.
    .showHelpAfterError(
      "`dvm init` only adds what is missing, and has no flag that replaces a config already on disk. To clear your caller settings, run 'dvm config reset'. To remove a wallet credential, run that rail's disconnect: 'dvm wallet disconnect', 'dvm wallet tempo-disconnect' or 'dvm wallet x402-disconnect'. To change or clear the signing identity, run 'dvm identity use'."
    )
    .action((opts: InitOptions) => {
      return catchErrors(async () => {
        await init(opts);
      }, opts.human);
    });

  const configCmd = program
    .command("config")
    .description("Clear or restore the caller settings in ~/.dvm/config.json");

  configCmd
    .command("reset")
    .description(
      "Clear caller settings (budgets, rail preference, credit and feedback posture) back to their defaults. Refuses while any wallet is connected, and never touches a credential or the identity selection"
    )
    .option(
      "--yes",
      "Carry out the clear (without it, the exact fields are reported and nothing is written)"
    )
    .option("--human", "Human-readable output instead of JSON")
    .action((opts: ConfigResetOptions) => {
      return catchErrors(async () => {
        await configReset(opts);
      }, opts.human);
    });

  configCmd
    .command("rollback")
    .description(
      "Report a stored copy of the configuration — when it was taken, how big, whether it is owner-only — and with --yes restore it. Contents are never printed"
    )
    .option(
      "--slot <slot>",
      "Which stored copy: backup (the rolling one, written before each change) or pinned (the snapshot 'dvm config reset' takes). Default: backup"
    )
    .option(
      "--yes",
      "Restore it (without it, only its metadata is reported and nothing is written)"
    )
    .option("--human", "Human-readable output instead of JSON")
    .action((opts: ConfigRollbackOptions) => {
      return catchErrors(async () => {
        await configRollback(opts);
      }, opts.human);
    });

  program
    .command("doctor [target]")
    .description("Diagnose caller-side state (files, config, wallet rails, network)")
    .option(
      "--no-network",
      "Skip live rail probes, mint health checks, and BTC rate fetch; cannot be used with [target]"
    )
    .option("--human", "Human-readable output instead of JSON")
    .action((target: string | undefined, opts: DoctorOptions) => {
      return catchErrors(async () => {
        await doctor({ ...opts, target });
      }, opts.human);
    });

  program
    .command("describe <endpoint>")
    .description("Describe a DVM provider's capabilities")
    .option("--human", "Human-readable output instead of JSON")
    .action((endpoint: string, opts: DescribeOptions) => {
      return catchErrors(() => describe(endpoint, opts), opts.human);
    });

  program
    .command("search [query]")
    .description("Search for DVM providers by capability or tag")
    .option("--tag <tag>", "Filter by tag (repeatable)", collectOption, [] as string[])
    .option("--credit", "Filter to DVMs offering prepaid credit")
    .option("--mode <mode>", "Search mode: keyword (default) or natural_language")
    .option("--limit <n>", "Maximum number of results (default: 10)")
    .option("--endpoint <url>", "Discovery DVM endpoint URL")
    .option("--human", "Human-readable output instead of JSON")
    .option("--timeout <sec>", "Override default timeout")
    .action((query: string | undefined, opts: SearchOptions) => {
      opts.query = query;
      return catchErrors(() => search(opts), opts.human);
    });

  program
    .command("browse")
    .description("Paginate the DVM catalog with optional tag, builder, and source filters")
    .option("--tag <tag>", "Filter by tag (repeatable)", collectOption, [] as string[])
    .option("--builder <handle>", "Filter to DVMs owned by a builder/org handle")
    .option("--source <source>", "all (default) | platform — `platform` hides external DVMs")
    .option("--sort <sort>", "reputation (default) | name | recency")
    .option("--limit <n>", "Page size (default: 10, max: 50)")
    .option("--offset <n>", "Pagination offset (default: 0)")
    .option("--endpoint <url>", "Discovery DVM endpoint URL")
    .option("--human", "Human-readable output instead of JSON")
    .option("--timeout <sec>", "Override default timeout")
    .action((opts: BrowseOptions) => {
      return catchErrors(() => browse(opts), opts.human);
    });

  program
    .command("quote")
    .description("Get a price quote from a DVM provider")
    .option(
      "-d, --dvm <identifier>",
      "Qualified DVM or DVM/capability identifier (e.g. `dvmkit--narrate`, `dvmkit--cast/add-episode`). Alternative to --endpoint."
    )
    .option("--endpoint <url>", "Provider HTTPS base URL or URL/capability (alternative to -d)")
    .option("-i, --input <text>", "Input text (primitive-input DVMs)")
    .option(
      "--data <json>",
      "Structured data for inputSchema DVMs (JSON object, or @path/to/file.json, or @- for stdin)"
    )
    .option(
      "--param <key=value>",
      "Job parameter (repeatable). Agent-friendly form for DVMs with an inputSchema (bool/number/string + repeats → array). Use --data for nested values.",
      collectOption,
      [] as string[]
    )
    .option("--budget <amount>", "Preview the request budget (millisats or $USD); authorizes no payment")
    .option("--auto-pay-below <amount>", "Preview the per-charge auto-pay bound; authorizes no payment")
    .option("--output-type <mime>", "Desired output MIME type")
    .option(
      "--as <identity>",
      "Caller signing identity (for descriptor-auth DVMs). Defaults to the lone configured identity or `defaultIdentity` in config."
    )
    .option("--human", "Human-readable output instead of JSON")
    .action((opts: QuoteOptions) => {
      return catchErrors(() => quote(opts), opts.human);
    });

  program
    .command("convert <amount>")
    .description("Convert between msats and USD (e.g. '$0.50' or '5000')")
    .option("--sats", "Treat numeric input as sats instead of millisats")
    .option("--human", "Human-readable output instead of JSON")
    .action((amount: string, opts: ConvertOptions) => {
      return catchErrors(() => convert(amount, opts), opts.human);
    });

  program
    .command("request")
    .description("Submit a job request to a DVM provider")
    .option(
      "-d, --dvm <identifier>",
      "Qualified DVM or DVM/capability identifier (e.g. `dvmkit--narrate`, `dvmkit--cast/add-episode`). Alternative to --endpoint."
    )
    .option("--endpoint <url>", "Provider HTTPS base URL or URL/capability (alternative to -d)")
    .option("-i, --input <text>", "Input text (primitive-input DVMs)")
    .option(
      "--param <key=value>",
      "Job parameter (repeatable). Agent-friendly form for DVMs with an inputSchema (bool/number/string + repeats → array). Use --data for nested values.",
      collectOption,
      [] as string[]
    )
    .option(
      "--data <json>",
      "Structured data for inputSchema DVMs (JSON object, or @path/to/file.json, or @- for stdin)"
    )
    .option("--budget <amount>", "Max spend per request (millisats or $USD)")
    .option(
      "--credit-only <id>",
      "Draw only from this exact already-selected prepaid credit; requires --budget and --request-id, permits no fresh payment fallback"
    )
    .option(
      "--auto-pay-below <amount>",
      "Auto-pay any single charge at or below this — upfront quote or mid-job (millisats or $USD). Bounded consent: implies --auto-pay, except with --credit-only where only that prepaid credit may be spent."
    )
    .option("--max-increment <amount>", "Max single payment (millisats or $USD)")
    .option(
      "--max-payments <n>",
      "Max payments to honour per job (default: 5); 0 = free, 1 = typical, 3+ = multi-turn"
    )
    .option("--output-type <mime>", "Desired output MIME type")
    .option("--no-stream", "Submit and return immediately without streaming")
    .option(
      "--auto-pay",
      "Pay without prompting, bounded by --auto-pay-below (else config autoPayThreshold, else 20% of --budget). Unnecessary when --auto-pay-below is set."
    )
    .option(
      "--rail <rail>",
      "Force a rail for upfront payment (cashu, tempo, x402). Default: pick from issue-spec order, or `defaultRail` config if set."
    )
    .option(
      "--mint <url>",
      "Pin the Cashu spend mint for this job (must be one the DVM accepts). Spends only from this mint — no fallback to another mint."
    )
    .option(
      "--max-cashu-fee-sats <sats>",
      "Job-wide Cashu swap-fee ceiling. The initial swap and any exact-request reclaim share it; every swap is checked before proofs are spent."
    )
    .option(
      "--cashu-binding-fingerprint <sha256>",
      "Approved SHA-256 over the exact strict Cashu DVM, capability, request body, mint, signer, and policy"
    )
    .option(
      "--strict-per-call",
      "Fail-closed direct Cashu mode: one pinned payment, no pending-state sweep, credit use/funding, rail fallback, deferred NWC, or reserve-direct proofs"
    )
    .option(
      "--as <identity>",
      "Caller signing identity (for descriptor-auth DVMs). Defaults to the lone configured identity or `defaultIdentity` in config."
    )
    .option("--request-id <id>", "Caller-generated id for authenticated lost-response recovery")
    .option(
      "--local-correlation-id <uuid>",
      "Attach a UUID only to the local saved job so lost command output can be correlated without changing the wire request"
    )
    .option("--human", "Human-readable output instead of JSON")
    .option("--timeout <sec>", "Override default timeout")
    .action((opts: RequestOptions) => {
      return catchErrors(() => request(opts), opts.human);
    });

  program
    .command("request-result <request-id>")
    .description("Read the exact accepted job for a caller-generated request id without mutation")
    .option("--human", "Human-readable output instead of JSON")
    .action((requestId: string, opts: RequestResultOptions) => {
      return catchErrors(() => requestResult(requestId, opts), opts.human);
    });

  program
    .command("request-resume <request-id>")
    .description("Explicitly finish a durably accepted request without sending payment")
    .option("--human", "Human-readable output instead of JSON")
    .option("--timeout <sec>", "Override default timeout")
    .action((requestId: string, opts: RequestResumeOptions) => {
      return catchErrors(() => requestResume(requestId, opts), opts.human);
    });

  program
    .command("upload <identifier>")
    .description(
      "Stage a local file against a DVM's bytes-ingest endpoint and get an upload_handle"
    )
    .option("--file <path>", "Local file to upload")
    .option("--kind <kind>", "Upload kind: audio (default) or image (cast only)")
    .option(
      "--as <identity>",
      "Caller signing identity for the upload claim. Defaults to the lone configured identity or `defaultIdentity`."
    )
    .option("--endpoint <url>", "Override the DVM base URL (local stack / staging)")
    .option("--human", "Human-readable output instead of JSON")
    .action((dvm: string, opts: UploadOptions) => {
      return catchErrors(() => upload(dvm, opts), opts.human);
    });

  program
    .command("status <job-id>")
    .description("Check on a previously submitted async job")
    .option("--endpoint <url>", "Provider URL override (env: DVM_JOB_ENDPOINT)")
    .option("--job-token <hex>", "Job bearer token override (env: DVM_JOB_TOKEN)")
    .option("--messages", "Also fetch recent messages")
    .option("--human", "Human-readable output instead of JSON")
    .option("--timeout <sec>", "Override default timeout")
    .action((jobId: string, opts: StatusOptions) => {
      return catchErrors(() => status(jobId, opts), opts.human);
    });

  const receipts = program
    .command("receipts")
    .description("Signed proof-of-purchase for finished jobs");

  receipts
    .command("list")
    .description("List collected job receipts, newest first")
    .option("--dvm <name>", "Only receipts with this DVM display name")
    .option("--dvm-id <id>", "Only receipts issued by this immutable DVM ID")
    .option("--limit <n>", "Max rows to show (default: 50)")
    .option("--human", "Human-readable output instead of JSON")
    .action((opts: ReceiptsListOptions) => {
      return catchErrors(() => {
        receiptsList(opts);
      }, opts.human);
    });

  receipts
    .command("show <job-id>")
    .description("Show one stored receipt in full")
    .option("--human", "Human-readable output instead of JSON")
    .action((jobId: string, opts: ReceiptsShowOptions) => {
      return catchErrors(() => {
        receiptsShow(jobId, opts);
      }, opts.human);
    });

  receipts
    .command("verify <job-id>")
    .description("Re-verify a stored receipt offline (signature, attestation, result hash)")
    .option("--file <path>", "Check a downloaded file against signed URL artifact fingerprints (repeatable)", collectOption, [] as string[])
    .option("--artifact <name-or-index>", "Select an artifact by exact name or 1-based index for --file")
    .option("--endpoint <url>", "Re-fetch the DVM's /v1/info instead of using the stored anchor")
    .option("--human", "Human-readable output instead of JSON")
    .action((jobId: string, opts: ReceiptsVerifyOptions) => {
      return catchErrors(() => receiptsVerify(jobId, opts), opts.human);
    });

  receipts
    .command("export")
    .description("Write the raw receipt collection to stdout as JSONL")
    .option("--dvm <name>", "Only receipts with this DVM display name")
    .option("--dvm-id <id>", "Only receipts issued by this immutable DVM ID")
    .action((opts: ReceiptsExportOptions) => {
      return catchErrors(() => {
        receiptsExport(opts);
      });
    });

  const credit = program
    .command("credit")
    .description(
      "Prepaid credit — the repeat-use alternative to per-call payment. One funding covers a run of jobs and reduces per-job fees. Nothing is bought without your say-so: 'posture' sets that, 'fund' buys one now, and the rest see and reclaim balances"
    );

  credit
    .command("list")
    .description("List locally-tracked credits (this caller's projection; no network)")
    .option("--human", "Human-readable output instead of JSON")
    .action((opts: CreditListOptions) => {
      return catchErrors(() => {
        creditList(opts);
      }, opts.human);
    });

  credit
    .command("posture [mode]")
    .description(
      "Set how much authority the CLI has to buy credit for you: suggest (default — offer, never buy), auto (buy within the trust-tier caps and report each purchase), or off (never use multi-job credit); --clear --dvm removes one override. See what's in force with 'dvm credit list'"
    )
    .option("--dvm <dvm>", "Scope the posture to one DVM instead of every DVM")
    .option("--clear", "Remove this DVM's override and inherit the global or default posture")
    .option("--human", "Human-readable output instead of JSON")
    .action((mode: string | undefined, opts: CreditPostureOptions) => {
      return catchErrors(() => creditPosture(mode, opts), opts.human);
    });

  credit
    .command("rail [rail]")
    .description(
      `Pin prepaid-credit funding to ${creditFundRails}, globally or at one DVM; --clear returns that scope to the next pin or the automatic amount rule. See what's in force with 'dvm credit list'`
    )
    .option("--dvm <dvm>", "Scope the funding-rail pin to one DVM instead of every DVM")
    .option("--clear", "Remove the pin at this scope and return to the next layer or amount rule")
    .option("--human", "Human-readable output instead of JSON")
    .action((rail: string | undefined, opts: CreditRailOptions) => {
      return catchErrors(() => creditRail(rail, opts), opts.human);
    });

  credit
    .command("trust [provider] [cap]")
    .description(
      "Pre-grant every DVM signed by one builder a larger prepaid-credit cap, list every pre-grant, or remove one"
    )
    .option("--list", "List configured trust pre-grants (no network)")
    .option("--remove <provider>", "Remove the pre-grant for this provider or builder pubkey")
    .option("--human", "Human-readable output instead of JSON")
    .action((provider: string | undefined, cap: string | undefined, opts: CreditTrustOptions) => {
      return catchErrors(() => creditTrust(provider, cap, opts), opts.human);
    });

  credit
    .command("balance [dvm]")
    .description(
      "Query live credit balances, signed, against one DVM (qualified identifier, @favorite, or URL) or every tracked one; includes expired credits — expiry ends spending, never ownership"
    )
    .option("--as <name>", "Caller signing identity to query as")
    .option(
      "--credit-id <id>",
      "Query this exact caller-owned credit and select it for future draws; requires a DVM"
    )
    .option(
      "--observe-only",
      "Read signed server state without polling pending funding or changing local state"
    )
    .option("--selection-only", "Select the exact signed credit without polling pending funding")
    .option("--human", "Human-readable output instead of JSON")
    .action((dvm: string | undefined, opts: CreditBalanceOptions) => {
      return catchErrors(() => creditBalance(dvm, opts), opts.human);
    });

  credit
    .command("deselect <dvm>")
    .description("Clear one exact local credit selection without deleting its evidence")
    .requiredOption("--credit-id <id>", "Exact currently selected credit to clear")
    .option("--as <name>", "Caller signing identity whose local selection is changed")
    .option("--human", "Human-readable output instead of JSON")
    .action((dvm: string, opts: CreditDeselectOptions) => {
      return catchErrors(() => {
        creditDeselect(dvm, opts);
      }, opts.human);
    });

  credit
    .command("fund <dvm>")
    .description(
      `Load a prepaid balance at one DVM over one of its eligible funding rails (${creditFundRails})`
    )
    .option("--amount <amount>", "How much to load, e.g. '$2' (defaults to the tracked refill gap)")
    .option(
      "--target-jobs <n>",
      "Size the funding to a workload instead of a figure: N jobs' worth at this DVM's price"
    )
    .option(
      "--over-trust",
      "Fund past the trust-tier cap deliberately — required for an amount above what receipts here have earned"
    )
    .option("--rail <rail>", `Force a funding rail: ${creditFundRails}`)
    .option("--cashu-mint <mint>", "Pin Cashu funding to one DVM-accepted mint")
    .option(
      "--max-cashu-principal-sats <sats>",
      "Refuse Cashu funding above this token-principal ceiling"
    )
    .option("--max-cashu-fee-sats <sats>", "Refuse Cashu funding above this swap-fee ceiling")
    .option(
      "--funding-mode <mode>",
      `Choose reusable channel collateral or, only when the DVM explicitly allows its manual refund obligation, a one-shot stablecoin payment: ${creditFundingModes}. Stablecoin rails only`
    )
    .option("--credit-id <id>", "Fund a specific credit id instead of the tracked one")
    .option("--as <name>", "Caller signing identity to sign the funding as")
    .option("--human", "Human-readable output instead of JSON")
    .action((dvm: string, opts: CreditFundOptions) => {
      return catchErrors(() => creditFund(dvm, opts), opts.human);
    });

  credit
    .command("drain <dvm>")
    .description(
      "Reclaim a credit's whole available balance. Re-running polls the same drain until fulfilled; a parked Cashu refund is redeemed straight into the agent wallet"
    )
    .option("--credit-id <id>", "Drain a specific credit id instead of the tracked one")
    .option(
      "--drain-id <id>",
      "Re-post a specific drain id — for an unclaimed drain 'credit list' shows without a credit_id. Requires --credit-id naming the credit it was requested on"
    )
    .option(
      "--method <rail>",
      `Payout rail: ${creditDrainRails} (cashu by default; x402- and Tempo-backed credits automatically force their own rail)`
    )
    .option(
      "--address <address>",
      "EVM address to refund to for --method x402 or --method tempo, when the credit was funded by a one-off stablecoin payment rather than a channel. Defaults to the wallet connected on that rail"
    )
    .option(
      "--recover-from-receipts",
      "Retire an exact stale local x402 drain marker from verified terminal receipts without posting the drain. Requires --credit-id, --drain-id, and --method x402; proof-backed recovery tooling must retain the independently verified chain transaction"
    )
    .option("--as <name>", "Caller signing identity to sign the drain as")
    .option("--human", "Human-readable output instead of JSON")
    .action((dvm: string, opts: CreditDrainOptions) => {
      return catchErrors(() => creditDrain(dvm, opts), opts.human);
    });

  credit
    .command("receipts <dvm>")
    .description(
      "Re-verify the stored reclaim receipts for one DVM, offline, against the builder identity pinned when the refund was recorded"
    )
    .option("--drain-id <id>", "Only the evidence for this drain")
    .option("--export", "Write the raw bundles to stdout as JSONL, un-enveloped")
    .option("--refetch", "Grade against the DVM's live /v1/info instead of the pinned anchor")
    .option("--as <name>", "Caller signing identity whose evidence to read")
    .option("--human", "Human-readable output instead of JSON")
    .action((dvm: string, opts: CreditReceiptsOptions) => {
      return catchErrors(() => creditReceipts(dvm, opts), opts.human);
    });

  program
    .command("messages <job-id>")
    .description("Fetch messages from a job conversation")
    .option("--endpoint <url>", "Provider URL override (env: DVM_JOB_ENDPOINT)")
    .option("--job-token <hex>", "Job bearer token override (env: DVM_JOB_TOKEN)")
    .option("--after <seq>", "Only show messages with seq > N")
    .option("--no-stream", "Non-blocking snapshot instead of streaming until yield")
    .option("--human", "Human-readable output instead of JSON")
    .option("--wait", "Stay attached until the job needs input or ends")
    .option("--until <duration>", "Wait limit with --wait (default: 12h; e.g. 30s, 5m, 12h)")
    .option("--timeout <sec>", "Read timeout (default: 5s, or 60s with --wait)")
    .action((jobId: string, opts: MessagesOptions) => {
      return catchErrors(() => messages(jobId, opts), opts.human);
    });

  program
    .command("message <job-id> [text]")
    .description("Send a message in a job conversation")
    .option("--endpoint <url>", "Provider URL override (env: DVM_JOB_ENDPOINT)")
    .option("--job-token <hex>", "Job bearer token override (env: DVM_JOB_TOKEN)")
    .option(
      "--type <type>",
      "Message type: text, response, approval, cancel, payment (default: text)"
    )
    .option("--prompt-id <id>", "Prompt ID (required for --type response)")
    .option("--json <data>", "Structured JSON response (for prompts with schema)")
    .option("--ref <seq>", "Reference sequence number (for --type approval)")
    .option("--token <cashu-token>", "Cashu token to send (for --type payment)")
    .option("--human", "Human-readable output instead of JSON")
    .option("--timeout <sec>", "Override default timeout for streaming")
    .action((jobId: string, text: string | undefined, opts: MessageOptions) => {
      return catchErrors(() => message(jobId, text ?? "", opts), opts.human);
    });

  program
    .command("pay <job-id>")
    .description(
      "Approve a pending payment request. The job's stored --max-increment still applies — a payment that exceeds it returns an over-budget error even when explicitly approved here."
    )
    .option("--endpoint <url>", "Provider URL override (env: DVM_JOB_ENDPOINT)")
    .option("--job-token <hex>", "Job bearer token override (env: DVM_JOB_TOKEN)")
    .option("--human", "Human-readable output instead of JSON")
    .option("--timeout <sec>", "Override default timeout for streaming")
    .option(
      "--mint <url>",
      "Pin the Cashu spend mint for this payment (must be one the DVM accepts). Overrides any mint pinned at request time."
    )
    .option("--rail <rail>", "Force this payment onto cashu, tempo, or x402 without fallback")
    .option(
      "--max-cashu-principal-sats <sats>",
      "Refuse Cashu proof selection above this exact principal ceiling (requires --rail cashu)"
    )
    .action((jobId: string, opts: PayOptions) => {
      return catchErrors(() => pay(jobId, opts), opts.human);
    });

  program
    .command("cancel <job-id>")
    .description("Cancel a running job")
    .option("--endpoint <url>", "Provider URL override (env: DVM_JOB_ENDPOINT)")
    .option("--job-token <hex>", "Job bearer token override (env: DVM_JOB_TOKEN)")
    .option("--reason <text>", "Reason for cancellation")
    .option("--human", "Human-readable output instead of JSON")
    .action((jobId: string, opts: CancelOptions) => {
      return catchErrors(() => cancel(jobId, opts), opts.human);
    });

  program
    .command("feedback [body...]")
    .description(
      "Submit signed-envelope feedback to the dvmkit platform. " +
        "No flags: platform-level. `--dvm <dvm-id>`: about a specific DVM. " +
        "`--job <jobId>`: about a stored job; add `--verdict up|down` to rate it using its receipt. " +
        "Prefer `--body @-` or `--body @file` over positional text for multiline or programmatic feedback."
    )
    .option("--dvm <dvm-id>", "Target a specific DVM by immutable ID")
    .option("--job <job-id>", "Target a previously-submitted job (mutually exclusive with --dvm)")
    .option("--verdict <up|down>", "Rate a job; requires --job, with an optional feedback note")
    .option(
      "--body <text>",
      "Feedback text, or @path/to/file, or @- for stdin. Mutually exclusive with positional body text."
    )
    .option(
      "--posture [value]",
      "Set the global feedback-nudge posture (ask|auto|off), or print the effective one when passed bare. Mutually exclusive with submitting feedback."
    )
    .option("--as <identity>", "Override the signing identity")
    .option("--human", "Human-readable output instead of JSON")
    .action((bodyParts: string[], opts: FeedbackOptions) => {
      return catchErrors(() => feedback(bodyParts, opts), opts.human);
    });

  const budget = program
    .command("budget")
    .description("Manage global spending caps (daily/weekly/monthly fiat ceilings)");

  budget
    .command("set")
    .description(
      "Set or update fiat spending caps. Pass 'off' for a window to clear it individually, or --clear to remove every cap at once."
    )
    .option("--daily <amount>", "Daily cap (e.g. '$5'). Pass 'off' to clear just this window.")
    .option("--weekly <amount>", "Weekly cap (e.g. '$25'). Pass 'off' to clear just this window.")
    .option(
      "--monthly <amount>",
      "Monthly cap (e.g. '$100'). Pass 'off' to clear just this window."
    )
    .option("--clear", "Remove ALL caps (mutually exclusive with --daily/--weekly/--monthly)")
    .option("--human", "Human-readable output instead of JSON")
    .action((opts: BudgetSetOptions) => {
      return catchErrors(() => {
        budgetSet(opts);
      }, opts.human);
    });

  budget
    .command("status")
    .description("Show current spend per window vs the configured caps")
    .option("--human", "Human-readable output instead of JSON")
    .action((opts: BudgetStatusOptions) => {
      return catchErrors(() => {
        budgetStatus(opts);
      }, opts.human);
    });

  const fav = program.command("fav").description("Manage favorite DVM providers");

  fav
    .command("add <endpoint>")
    .description("Save a DVM endpoint as a favorite")
    .option("--name <alias>", "Alias for this favorite (default: derived from endpoint)")
    .option("--human", "Human-readable output instead of JSON")
    .action((endpoint: string, opts: FavAddOptions) => {
      return catchErrors(() => favAdd(endpoint, opts), opts.human);
    });

  fav
    .command("list")
    .description("List saved favorites")
    .option("--human", "Human-readable output instead of JSON")
    .action((opts: FavListOptions) => {
      return catchErrors(() => {
        favList(opts);
      }, opts.human);
    });

  fav
    .command("rm <name>")
    .description("Remove a favorite")
    .option("--human", "Human-readable output instead of JSON")
    .action((name: string, opts: FavRmOptions) => {
      return catchErrors(() => favRm(name, opts), opts.human);
    });

  const wallet = program
    .command("wallet")
    .description("Manage agent funding (NWC, Cashu, Tempo, x402)");

  wallet.addHelpText(
    "after",
    `
Docs:
  Payment stack:  https://dvmkit.ai/docs/payments
  Privacy stance: https://dvmkit.ai/privacy`
  );

  wallet
    .command("setup")
    .description("Guided wallet onboarding")
    .option(
      "--rail <rail>",
      "Show funding instructions: nwc (Lightning float), cashu, tempo, or x402"
    )
    .option("--type <type>", "Wallet type: nwc")
    .option(
      "--nwc-uri <uri>",
      "NWC connection string (for nwc wallet). Emits a warning — it leaks to shell history + ps; pipe the string in or use --file instead"
    )
    .option(
      "--file <path>",
      `Read the NWC connection string from a file (avoids shell history; paths under ${BLOCKED_SECRET_PATHS_LIST} are rejected)`
    )
    .option(
      "--budget <amount>",
      "The spending cap you set on the wallet side, e.g. '$20/month'. Recorded for display — wallets never report their cap back"
    )
    .option("--default-budget <amount>", "Default max budget per request (e.g. '$1.00')")
    .option("--human", "Human-readable output instead of JSON")
    .action((opts: WalletSetupOptions) => {
      return catchErrors(() => walletSetup(opts), opts.human);
    });

  wallet
    .command("connect [nwc-uri]")
    .description(
      "Connect the agent's Lightning float via an NWC connection string. Reads from piped stdin or prompts interactively when no positional arg is given; pass --file <path> to read from a file. Passing the connection string on the command line is supported but emits a warning (leaks to shell history + ps)."
    )
    .option(
      "--budget <amount>",
      "The spending cap you set on the wallet side, e.g. '$20/month'. Recorded for display — wallets never report their cap back"
    )
    .option(
      "--file <path>",
      `Read the NWC connection string from a file (avoids shell history; paths under ${BLOCKED_SECRET_PATHS_LIST} are rejected)`
    )
    .option("--human", "Human-readable output instead of JSON")
    .action((nwcUri: string | undefined, opts: WalletConnectOptions) => {
      return catchErrors(() => walletConnect(nwcUri, opts), opts.human);
    });

  const pair = wallet
    .command("pair")
    .description("Create a private encrypted link for remote NWC wallet connection")
    .option("--as <identity>", "Caller identity that signs the pairing manifest")
    .option("--human", "Human-readable output instead of JSON")
    .action((opts: WalletPairOptions) => {
      return catchErrors(() => walletPair(opts), opts.human);
    });

  pair
    .command("complete <pairing-id>")
    .description("Poll, decrypt, probe, and save a remote wallet pairing")
    .option("--wait", "Poll with jitter until the pairing is submitted or expires")
    .option(
      "--confirm-replace <submission-event-id>",
      "Replace an existing float after reviewing the pinned candidate"
    )
    .option("--human", "Human-readable output instead of JSON")
    .action((pairingId: string, opts: WalletPairCompleteOptions) => {
      return catchErrors(() => walletPairComplete(pairingId, opts), opts.human);
    });

  wallet
    .command("balance")
    .description("Show wallet balance")
    .option(
      "--observe-only",
      "Read chain state without retiring closed local Tempo channel associations"
    )
    .option("--human", "Human-readable output instead of JSON")
    .action((opts: WalletBalanceOptions) => {
      return catchErrors(() => walletBalance(opts), opts.human);
    });

  wallet
    .command("history")
    .description(
      "Local budget charges, credit draws, completed refunds/losses, and active recovery, newest first. Confirmed spend history has no automatic expiry; budget limits still use rolling windows."
    )
    .option("--today", "Only spends since UTC start of today")
    .option(
      "--since <iso-or-duration>",
      "Only spends since an ISO date (2026-07-01) or a duration (7d, 24h, 30m)"
    )
    .option("--limit <n>", "Max rows to show, newest first (default 50)")
    .option("--offset <n>", "Skip rows in unchanged newest-first history (default 0)")
    .option("--cursor <token>", "Continue history with the same filters; refuses changed local records")
    .option("--endpoint <url>", "Only history at this endpoint origin")
    .option("--kind <kind>", "Only job, float_fund, credit_fund, credit_draw, completed_refund, expired_credit_loss, or active_recovery rows")
    .option("--human", "Human-readable table instead of JSON")
    .action((opts: WalletHistoryOptions) => {
      return catchErrors(() => {
        walletHistory(opts);
      }, opts.human);
    });

  wallet
    .command("disconnect")
    .description("Remove wallet connection")
    .option("--human", "Human-readable output instead of JSON")
    .action((opts: { human?: boolean }) => {
      return catchErrors(() => walletDisconnect(opts), opts.human);
    });

  wallet
    .command("mint-add <url>")
    .description("Add a Cashu mint")
    .option("--human", "Human-readable output instead of JSON")
    .action((url: string, opts: WalletMintAddOptions) => {
      return catchErrors(() => walletMintAdd(url, opts), opts.human);
    });

  wallet
    .command("mint-list")
    .description("List configured Cashu mints with balances")
    .option("--human", "Human-readable output instead of JSON")
    .action((opts: WalletMintListOptions) => {
      return catchErrors(() => walletMintList(opts), opts.human);
    });

  wallet
    .command("mint-health")
    .description("Check health of configured Cashu mints before funding")
    .option("--mint <url>", "Check one mint URL instead of all configured mints")
    .option("--human", "Human-readable output instead of JSON")
    .action((opts: WalletMintHealthOptions) => {
      return catchErrors(() => walletMintHealth(opts), opts.human);
    });

  wallet
    .command("init")
    .description(
      "Generate a fresh 12-word BIP-39 mnemonic and persist the derived wallet to ~/.dvm/wallet.json"
    )
    .option("--force", "Overwrite an existing wallet (destroys the current mnemonic/privkey)")
    .option("--yes", "Skip the human-mode backup confirmation prompt (still requires --human)")
    .option(
      "--show-secret",
      "Include the raw mnemonic + lock_privkey under a `secrets` block in default JSON (off by default so an agent relaying stdout never leaks the seed)"
    )
    .option("--human", "Human-readable output instead of JSON")
    .action((opts: WalletInitOptions) => {
      return catchErrors(() => walletInit(opts), opts.human);
    });

  wallet
    .command("recover [mnemonic-or-privkey]")
    .description(
      "Restore the agent wallet from a 12-word BIP-39 mnemonic (preferred) or a 64-char hex privkey. Reads from piped stdin or prompts interactively when no positional arg is given; pass --file <path> to read from a file. Passing the secret on the command line is supported but emits a warning (leaks to shell history + ps)."
    )
    .option("--force", "Overwrite an existing wallet (destroys the current mnemonic/privkey)")
    .option(
      "--file <path>",
      `Read mnemonic/privkey from a file (avoids shell history; paths under ${BLOCKED_SECRET_PATHS_LIST} are rejected)`
    )
    .option("--human", "Human-readable output instead of JSON")
    .action((arg: string | undefined, opts: WalletAgentRecoverOptions) => {
      return catchErrors(() => walletRecover(arg, opts), opts.human);
    });

  wallet
    .command("restore [mnemonic]")
    .description(
      "Rebuild the agent wallet's proof set from a 12-word BIP-39 mnemonic by walking NUT-13 counters + NUT-09 restore + NUT-7 checkstate. Reads from piped stdin or prompts interactively when no positional arg is given; pass --file <path> to read from a file. Passing the secret on the command line is supported but emits a warning (leaks to shell history + ps)."
    )
    .option(
      "--mint <url>",
      "Mint URL to restore against (repeatable). Defaults to the wallet's configured mints, else Coinos.",
      collectOption,
      [] as string[]
    )
    .option("--force", "Overwrite an existing wallet (destroys local proof state)")
    .option(
      "--file <path>",
      `Read mnemonic from a file (avoids shell history; paths under ${BLOCKED_SECRET_PATHS_LIST} are rejected)`
    )
    .option("--human", "Human-readable output instead of JSON")
    .action((mnemonic: string | undefined, opts: WalletRestoreOptions) => {
      return catchErrors(() => walletRestore(mnemonic, opts), opts.human);
    });

  wallet
    .command("fund <amount>")
    .description(
      "Fund the agent wallet — Lightning→Cashu (default), or create a Tempo/x402 stablecoin address handoff. Amount accepts sats (1000), USD ($5), GBP (£5 / 5gbp), EUR (€5 / 5eur), or JPY"
    )
    .option("--rail <rail>", "Which rail to fund: cashu (default), tempo, or x402")
    .option(
      "--sats",
      "Treat numeric input as sats (Cashu only; default: fiat if a currency symbol/code is present — $5, £5, 5eur — else sats)"
    )
    .option("--mint <url>", "Cashu mint URL (default: configured mint, or Coinos)")
    .option("--timeout <sec>", "Override DVM_FUND_TIMEOUT_SEC (default 600s)")
    .option(
      "--test-skip-lightning",
      "Skip Lightning — for test mints that auto-pay invoices (FakeWallet). Cashu rail only."
    )
    .option(
      "--no-float",
      "Don't pay from the connected Lightning float — print the invoice for a human to pay instead. Cashu rail only."
    )
    .option(
      "--qr-image <path>",
      "Write the funding QR PNG to <path> (default in JSON mode: OS tmpdir)"
    )
    .option("--human", "Human-readable output instead of JSON")
    .action((amount: string, opts: WalletFundOptions) => {
      return catchErrors(() => walletFund(amount, opts), opts.human);
    });

  wallet
    .command("cash-out <ln-address>")
    .description(
      "Move value out of the agent wallet to a Lightning address (or lnurl1… string). Fees are drawn from the wallet on top of --amount, so the stated amount is what arrives"
    )
    .option(
      "--amount <amount>",
      "How much should arrive. Accepts sats (1000), USD ($5), GBP (£5 / 5gbp), EUR (€5 / 5eur), or JPY"
    )
    .option(
      "--sats",
      "Treat numeric input as sats (default: fiat if a currency symbol/code is present — $5, £5, 5eur — else sats)"
    )
    .option("--all", "Empty the wallet (or the --mint mint) — fees come out of the balance")
    .option("--mint <url>", "Cash out from this mint only (default: every mint, richest first)")
    .option("--max-fee <sats>", "Refuse a mint whose routing reserve + input fee exceeds this")
    .option("--dry-run", "Quote the melt and report the fee without paying anything")
    .option("--human", "Human-readable output instead of JSON")
    .action((lnAddress: string, opts: WalletCashOutOptions) => {
      return catchErrors(() => walletCashOut(lnAddress, opts), opts.human);
    });

  wallet
    .command("receive-token <token>")
    .description("Claim an external Cashu token into the agent wallet as spendable balance")
    .option("--human", "Human-readable output instead of JSON")
    .action((token: string, opts: WalletReceiveTokenOptions) => {
      return catchErrors(() => walletReceiveToken(token, opts), opts.human);
    });

  wallet
    .command("set-default-rail [rail]")
    .description("Set the preferred rail for `dvm request` upfront payments (cashu, tempo, x402)")
    .option("--clear", "Clear the persisted default rail")
    .option("--human", "Human-readable output instead of JSON")
    .action((rail: string | undefined, opts: { clear?: boolean; human?: boolean }) => {
      return catchErrors(() => walletSetDefaultRail(rail, opts), opts.human);
    });

  wallet
    .command("show")
    .description(
      "Show agent wallet balance, recent spends, per-mint distribution, and per-mint input_fee_ppk. Also reconciles unconfirmed payments: a paid call whose result never came back is re-sent to its DVM, so this can start the job you already paid for"
    )
    .option("--human", "Human-readable output instead of JSON")
    .action((opts: WalletShowOptions) => {
      return catchErrors(() => walletShow(opts), opts.human);
    });

  wallet
    .command("submissions")
    .description(
      "Inspect the unconfirmed-payment journal (paid calls a provider never confirmed). Pure read — lists each entry's state (resumable / reclaimable / reclaim_failed / unreclaimable / stale / unresumable / awaiting_swap) and reason. Use --forget <request_id> to deliberately close out one entry the wallet can no longer act on (abandons its sats)"
    )
    .option(
      "--forget <request_id>",
      "Permanently forget one entry, named by its request id (abandons its sats — the proofs are locked to the provider with no refund)"
    )
    .option("--yes", "Skip the confirmation prompt (required to --forget non-interactively)")
    .option(
      "--force",
      "Allow --forget on a reclaimable / reclaim_failed entry — those sats are still coming back to your wallet, so this throws away recoverable money"
    )
    .option("--human", "Human-readable output instead of JSON")
    .action((opts: WalletSubmissionsOptions) => {
      return catchErrors(() => walletSubmissions(opts), opts.human);
    });

  wallet
    .command("recover-submission <request-id>")
    .description(
      "Recover one strict Cashu request by exact UUID and request-binding fingerprint. Holds the wallet lock and never sweeps unrelated pending state"
    )
    .requiredOption(
      "--binding-fingerprint <sha256>",
      "SHA-256 fingerprint binding the exact DVM, capability, body, mint, signer, and policy"
    )
    .option("--human", "Human-readable output instead of JSON")
    .action((requestId: string, opts: WalletRecoverSubmissionOptions) => {
      return catchErrors(() => walletRecoverSubmission(requestId, opts), opts.human);
    });

  wallet
    .command("reserve <amount>")
    .description(
      "Pre-fund a builder DVM: mint NUT-11 P2PK-locked Cashu proofs with a refund tag so the agent can reclaim unshipped reserve post-locktime"
    )
    .option("--builder <endpoint>", "Builder DVM endpoint URL (or `@alias` favorite). Required.")
    .option("--locktime <duration>", "Locktime — Nd/Nh/Nm/Ns. Default 30d.")
    .option("--mint <url>", "Cashu mint URL (must be in the builder's allowlist)")
    .option(
      "--sats",
      "Treat numeric input as sats (default: fiat if a currency symbol/code is present — $5, £5, 5eur — else sats)"
    )
    .option("--timeout <sec>", "Override the reserve timeout, in seconds")
    .option("--human", "Human-readable output instead of JSON")
    .action((amount: string, opts: WalletReserveOptions) => {
      return catchErrors(() => walletReserve(amount, opts), opts.human);
    });

  wallet
    .command("release")
    .description(
      "Reclaim unshipped reserve proofs at a builder whose locktime has expired (via NUT-11 refund swap)"
    )
    .option("--builder <endpoint>", "Builder DVM endpoint URL (or `@alias` favorite). Required.")
    .option("--output <mode>", "`locked` (default — re-lock to agent master pubkey) or `unlocked`")
    .option("--human", "Human-readable output instead of JSON")
    .action((opts: WalletReleaseOptions) => {
      return catchErrors(() => walletRelease(opts), opts.human);
    });

  wallet
    // The slot is a catcher, not an input: commander ignores an unexpected
    // excess argument, so deleting it would let a caller who types their key
    // leak it to shell history and `ps` while the command silently generated a
    // different wallet. It is named for what it refuses.
    .command("x402-connect [unsupported-key]")
    .description(
      "Connect an EVM wallet for x402 stablecoin payments. With no key supplied it generates a fresh wallet on Base and prints the address to fund — the private key is stored in the dvm config (mode 0600) and never printed. To import an existing key instead, use --key-file, the DVM_X402_KEY env var, or piped stdin. A key passed as a positional argument is refused, not imported: it would land in shell history and ps."
    )
    .option(
      "--key-file <path>",
      `Read private key from a file (avoids shell history; paths under ${BLOCKED_SECRET_PATHS_LIST} are rejected)`
    )
    .option(
      "--network <network>",
      "CAIP-2 chain id to settle on: eip155:8453 (Base, default), eip155:84532 (Base Sepolia), eip155:43114 (Avalanche), eip155:43113 (Avalanche Fuji), eip155:137 (Polygon), eip155:80002 (Polygon Amoy). Anything else is rejected. Omitting it keeps the chain already connected, and only falls back to Base on a first connect"
    )
    .option(
      "--force",
      "Replace the wallet already connected. Refused while that wallet still controls x402 channel funds — only its key can withdraw them"
    )
    .option("--qr-image <path>", "Write the funding-address QR PNG to <path>")
    .option("--human", "Human-readable output instead of JSON")
    .action(
      (
        unsupportedKey: string | undefined,
        opts: {
          keyFile?: string;
          network?: string;
          force?: boolean;
          qrImage?: string;
          human?: boolean;
        }
      ) => {
        return catchErrors(() => walletX402Connect(unsupportedKey, opts), opts.human);
      }
    );

  wallet
    .command("x402-network <network>")
    .description(
      "Change the chain a connected x402 wallet uses for new payments without replacing or re-supplying its private key. Existing channels stay on their recorded chains and remain withdrawable there"
    )
    .option("--human", "Human-readable output instead of JSON")
    .action((network: string, opts: { human?: boolean }) => {
      return catchErrors(() => walletX402Network(network, opts), opts.human);
    });

  wallet
    .command("x402-disconnect")
    .description(
      "Remove x402 wallet configuration. Refuses while signed channel vouchers are unacknowledged, and always while the wallet still controls x402 channel funds — only this key can settle, exit or withdraw them"
    )
    .option(
      "--with-pending",
      "Disconnect even though signed vouchers are unacknowledged (they can only be settled by reconnecting this same key). Never overrides the channel-funds check"
    )
    .option("--human", "Human-readable output instead of JSON")
    .action((opts: { withPending?: boolean; human?: boolean }) => {
      return catchErrors(() => walletX402Disconnect(opts), opts.human);
    });

  wallet
    .command("x402-clear-pending [dvm]")
    .description(
      "List the signed x402 channel vouchers still awaiting acknowledgement, and retire ones no DVM will ever answer. With no --credit-id or --all it only lists"
    )
    .option("--credit-id <id>", "Retire the journalled funding for exactly this credit")
    .option("--all", "Retire every journalled funding in scope")
    .option(
      "--force",
      "Retire an entry signed in the last day; retrying its funding is usually the cheaper repair, and retirement raises the timed exit's guaranteed floor"
    )
    .option("--human", "Human-readable output instead of JSON")
    .action((dvm: string | undefined, opts: WalletX402ClearPendingOptions) => {
      return catchErrors(() => walletX402ClearPending({ ...opts, ...(dvm ? { dvm } : {}) }), opts.human);
    });

  wallet
    .command("x402-withdraw-initiate [dvm]")
    .description(
      "Start the full-position timed exit for a persisted x402 batch channel; the caller pays network gas and finalizes after the DVM's safety delay"
    )
    .option("--channel-id <id>", "Use an exact channel instead of the latest one for this DVM")
    .option("--human", "Human-readable output instead of JSON")
    .action((dvm: string | undefined, opts: WalletX402WithdrawalOptions) => {
      return catchErrors(() => walletX402WithdrawInitiate({ ...opts, dvm }), opts.human);
    });

  wallet
    .command("x402-withdraw-finalize [dvm]")
    .description("Finalize a matured raw x402 channel withdrawal; the caller pays network gas")
    .option("--channel-id <id>", "Use an exact channel instead of the latest one for this DVM")
    .option("--human", "Human-readable output instead of JSON")
    .action((dvm: string | undefined, opts: WalletX402WithdrawalOptions) => {
      return catchErrors(() => walletX402WithdrawFinalize({ ...opts, dvm }), opts.human);
    });

  wallet
    .command("tempo-connect [method]")
    .description(
      "Connect a Tempo wallet for stablecoin payments. With no key supplied it generates a fresh wallet and prints the address to fund — the private key is stored in the dvm config (mode 0600) and never printed. To import an existing key instead, use --key-file, the DVM_TEMPO_KEY env var, or piped stdin. --api-key still imports but warns: its value is in shell history and ps. A key passed as a positional argument is refused, not imported."
    )
    .option(
      "--key-file <path>",
      `Read the Tempo private key from a file (avoids shell history; paths under ${BLOCKED_SECRET_PATHS_LIST} are rejected)`
    )
    .option(
      "--api-key <key>",
      "Import a 0x-prefixed 32-byte Tempo private key. Emits a warning — it leaks to shell history + ps; use --key-file, DVM_TEMPO_KEY, or piped stdin instead. Refused alongside either of those two, which would silently win"
    )
    .option(
      "--network <network>",
      "Tempo network to persist: mainnet (default) or moderato. DVM_TEMPO_NETWORK is the environment equivalent"
    )
    .option("--force", "Overwrite existing Tempo wallet")
    .option("--qr-image <path>", "Write the funding-address QR PNG to <path>")
    .option("--human", "Human-readable output instead of JSON")
    .action(
      (
        method: string | undefined,
        opts: {
          apiKey?: string;
          keyFile?: string;
          network?: string;
          force?: boolean;
          qrImage?: string;
          human?: boolean;
        }
      ) => {
        return catchErrors(async () => {
          await walletMppConnect(method ?? "tempo", opts);
        }, opts.human);
      }
    );

  wallet
    .command("tempo-disconnect")
    .description("Remove Tempo wallet configuration")
    .option("--human", "Human-readable output instead of JSON")
    .action((opts: { human?: boolean }) => {
      return catchErrors(async () => {
        await walletMppDisconnect(opts);
      }, opts.human);
    });

  wallet
    .command("tempo-exit <dvm>")
    .description("Request or finish an on-chain exit from a Tempo prepaid-credit channel")
    .option("--as <name>", "Caller signing identity that owns the credit")
    .option("--credit-id <id>", "Exit the channel for exactly this prepaid credit")
    .option(
      "--abandon",
      "Retire a descriptor-less local record, or one the escrow has no record of, releasing the guard on disconnecting or replacing the Tempo key. Descriptor-backed records are refused while the chain knows the channel"
    )
    .option("--human", "Human-readable output instead of JSON")
    .action(
      (
        dvm: string,
        opts: { as?: string; creditId?: string; abandon?: boolean; human?: boolean }
      ) => {
        return catchErrors(() => walletMppExit(dvm, opts), opts.human);
      }
    );

  const identityCmd = program
    .command("identity")
    .description("Manage caller signing identities (~/.dvm/identities.json)");

  identityCmd
    .command("create <name>")
    .description("Generate a fresh secp256k1 identity under <name>")
    .option("--force", "Overwrite an existing identity of the same name")
    .option("--human", "Human-readable output instead of JSON")
    .action((name: string, opts: IdentityCreateOptions) => {
      return catchErrors(async () => {
        await identityCreate(name, opts);
      }, opts.human);
    });

  identityCmd
    .command("show <name>")
    .description("Print a stored identity's pubkey (use --reveal to also print the privkey)")
    .option("--reveal", "Also print the private key")
    .option("--human", "Human-readable output instead of JSON")
    .action((name: string, opts: IdentityShowOptions) => {
      return catchErrors(() => {
        identityShow(name, opts);
      }, opts.human);
    });

  identityCmd
    .command("list")
    .description("List configured identities")
    .option("--human", "Human-readable output instead of JSON")
    .action((opts: IdentityListOptions) => {
      return catchErrors(() => {
        identityList(opts);
      }, opts.human);
    });

  identityCmd
    .command("delete <name>")
    .description("Remove a stored identity")
    .option("--force", "Required to delete the currently-configured default identity")
    .option("--human", "Human-readable output instead of JSON")
    .action((name: string, opts: IdentityDeleteOptions) => {
      return catchErrors(async () => {
        await identityDelete(name, opts);
      }, opts.human);
    });

  identityCmd
    .command("import <name>")
    .description("Import an existing secp256k1 secret as <name>")
    .requiredOption("--privkey <hex>", "64-char lowercase hex secp256k1 secret")
    .option("--human", "Human-readable output instead of JSON")
    .action((name: string, opts: IdentityImportOptions) => {
      return catchErrors(async () => {
        await identityImport(name, opts);
      }, opts.human);
    });

  identityCmd
    .command("use [name]")
    .description(
      "Set the default identity used by `dvm request` / `dvm quote`, or pass --clear to select none"
    )
    .option("--clear", "Select no identity at all, leaving every stored key in place")
    .option("--human", "Human-readable output instead of JSON")
    .action((name: string | undefined, opts: IdentityUseOptions) => {
      return catchErrors(async () => {
        await identityUse(name, opts);
      }, opts.human);
    });

  return program;
}

function collectOption(val: string, acc: string[]) {
  acc.push(val);
  return acc;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  installGlobalAcceptEncoding();
  await buildProgram().parseAsync();
}
