import {
  DvmError,
  type ProviderInfo,
  type ProviderRef,
  type Transport,
} from "@dvmkit/sdk/internal";

import { buildStructuredInputHint } from "./structured-input-hint";

export interface InputSchemaHintOpts {
  /**
   * Canonical capability name (e.g. `synthesise`) so the helper can locate
   * the nested schema under `info.capabilities[capability]`.
   */
  capability?: string;
  identifier: string;
  command: "quote" | "request";
  /**
   * True when the caller passed `-i <text>` and **no** `--data`/`--param`.
   * When true the rewrite drops the original Zod message entirely (the
   * primitive-vs-structured mismatch is the real failure). When false the
   * helper falls back to the conservative hint so we don't mask a
   * genuine schema rejection of a structured payload the caller actually built.
   */
  usedPrimitiveInput: boolean;
  /** The `-i` value, used as the body of the `--data` example. Ignored when `usedPrimitiveInput` is false. */
  primitiveInput?: string;
  /**
   * The literal string the caller typed (`@scrape`, `https://scrape.dvmkit.ai`,
   * `scrape/extract`, …). Used everywhere the hint or example surfaces an
   * endpoint so the resolved upstream URL never appears in caller-facing
   * surfaces. Also written verbatim to `err.data.caller_endpoint`
   * for JSON consumers; the resolved URL is intentionally not surfaced.
   */
  callerRef: string;
  /**
   * Which addressing flag the caller used — `"dvm"` for `-d <id>`, `"endpoint"`
   * for `--endpoint <url-or-alias>`. Drives the rewritten retry command so it
   * matches the caller's original invocation form: a bare DVM id like
   * `scrape` is only runnable via `-d`, not `--endpoint`.
   */
  callerFlag: "dvm" | "endpoint";
}

/**
 * Wrap a quote/submit call so that an `invalid_input` rejection from a
 * structured-input DVM gets a CLI-side hint pointing at `--param` / `-d`.
 *
 * On `DvmError("invalid_input", ...)`, makes a best-effort `/v1/info` GET to
 * confirm the DVM actually declares an input schema before adding the hint —
 * agents shouldn't be told to use `--param` against a primitive-input DVM.
 * Detects both the legacy top-level (`info.inputSchema`, `info.quote.schema`)
 * and the nested (`info.capabilities[cap].input_schema`,
 * `…pricing.quote.schema`) shapes.
 *
 * When the caller used the primitive `-i` form against a schema DVM, the
 * rewrite replaces the misleading Zod refinement message with a structured
 * next-step hint (expected fields + a working `--data` example using the
 * caller's actual input string). When the caller used `--data` / `--param`,
 * the helper keeps the original message and appends the follow-up hint.
 *
 * Both branches use `opts.callerRef` (the literal user-typed endpoint string)
 * everywhere the hint or example surfaces an endpoint, and write
 * `caller_endpoint` to the error's JSON `data`. The resolved upstream URL is
 * intentionally not surfaced — callers who need it should run
 * `dvm describe <caller-ref>` or `dvm fav list`.
 *
 * Any other error type, or a `describe` failure, passes the original error
 * through unchanged.
 */
export async function withInputSchemaHint<T>(
  transport: Transport,
  ref: ProviderRef,
  opts: InputSchemaHintOpts,
  fn: () => Promise<T>
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!(err instanceof DvmError) || err.code !== "invalid_input") throw err;
    let info: ProviderInfo;
    try {
      info = await transport.describe(ref);
    } catch {
      throw err;
    }
    const schema = findInputSchema(info, opts.capability);
    if (!schema) throw err;

    if (opts.usedPrimitiveInput) {
      const rewritten = buildStructuredInputHint({
        identifier: opts.identifier,
        endpoint: opts.callerRef,
        callerFlag: opts.callerFlag,
        schema,
        primitiveInput: opts.primitiveInput ?? "",
        command: opts.command,
      });
      throw new DvmError(
        err.code,
        rewritten.message,
        rewritten.hint,
        {
          ...(err.data ?? {}),
          caller_endpoint: opts.callerRef,
          details: rewritten.data,
        },
        undefined,
        err.proseSources?.display ? { display: "provider" } : undefined
      );
    }

    // Non-primitive caller — keep the original message (it likely points at a
    // real schema rejection of their structured payload) and append the
    // schema follow-up hint so they still get a pointer at the schema.
    const baseHint = err.hint ? `${err.hint.replace(/\s+$/, "")} ` : "";
    throw new DvmError(
      err.code,
      err.message,
      `${baseHint}This DVM expects structured input — check your --param k=v / -d <json> payload against \`dvm describe ${opts.callerRef}\`.`,
      {
        ...(err.data ?? {}),
        caller_endpoint: opts.callerRef,
      },
      err.display,
      err.proseSources
    );
  }
}

/**
 * Locate a JSON Schema declaration on a `/v1/info` payload. Walks both the
 * legacy top-level shape and the per-capability nested shape,
 * preferring the capability-scoped version when a capability is supplied.
 * Returns `undefined` when neither shape carries a schema.
 */
function findInputSchema(
  info: ProviderInfo,
  capability: string | undefined
): Record<string, unknown> | undefined {
  if (capability) {
    const cap = info.capabilities?.[capability];
    if (cap) {
      if (isPlainObject(cap.input_schema)) return cap.input_schema;
      const quote = isPlainObject(cap.pricing) ? cap.pricing.quote : undefined;
      if (isPlainObject(quote) && isPlainObject(quote.schema)) return quote.schema;
    }
  }
  if (isPlainObject(info.inputSchema)) return info.inputSchema;
  if (info.quote && isPlainObject(info.quote.schema)) return info.quote.schema;
  return undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
